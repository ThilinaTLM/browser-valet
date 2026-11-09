// Read-only network observation: a per-tab ring buffer of requests fed by CDP `Network.*` events,
// plus the redaction rules (see security.md "Network observation"). Nothing here changes traffic.
//
// Credentials are redacted when an event is ingested, so they never sit in the buffer: credential
// headers, secret-like URL query values and request-body fields. Response bodies are fetched on
// demand and redacted for output (`redactResponseBody`). Bodies never reach the activity log.

import * as cdp from './cdp';

export const REDACTED = '[redacted]';
export const MAX_ENTRIES = 500;
export const MAX_BODY_CHARS = 32_768;
const MAX_POST_DATA = 8192;

export interface Entry {
  /** CDP requestId; redirect hops get `<requestId>~<n>`. */
  id: string;
  method: string;
  url: string;
  /** CDP resource type: Document, Fetch, XHR, Script, … */
  type: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  postData?: string;
  /** Wall-clock ms at the start of the request. */
  startedAt?: number;
  /** Monotonic CDP seconds at the start (for the duration). */
  startMono?: number;
  durationMs?: number;
  size?: number;
  finished: boolean;
  failed?: string;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const CREDENTIAL_HEADERS = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-csrf-token',
  'x-xsrf-token',
]);

/** Headers that carry credentials: the fixed list plus anything token/secret/key/auth/session-like. */
export function isCredentialHeader(name: string): boolean {
  const n = name.toLowerCase();
  if (CREDENTIAL_HEADERS.has(n)) return true;
  return /token|secret|api-?key|apikey|credential|session|csrf|xsrf|(^|-)auth(-|$)|-auth$|authorization/.test(
    n,
  );
}

export function redactHeaders(h: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    out[k] = isCredentialHeader(k) ? REDACTED : String(v);
  }
  return out;
}

const norm = (k: string): string => k.toLowerCase().replace(/[-_.\s]/g, '');

/** Keys whose values are secrets in a request (form, JSON or query string). */
export function isSecretKey(key: string): boolean {
  return /passw|passcode|token|secret|apikey|credential|authorization|csrf|xsrf|^auth$|^pin$|^otp$|privatekey|sessionid/.test(
    norm(key),
  );
}

const RESPONSE_SECRET_KEYS = new Set([
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'token',
  'secret',
  'password',
  'clientsecret',
]);

function redactJson(value: unknown, isSecret: (k: string) => boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => redactJson(v, isSecret));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSecret(k) ? REDACTED : redactJson(v, isSecret);
    }
    return out;
  }
  return value;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function redactForm(text: string): string {
  return text
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      let key = pair.slice(0, eq);
      try {
        key = decodeURIComponent(key.replace(/\+/g, ' '));
      } catch {
        // keep raw key
      }
      return isSecretKey(key) ? `${pair.slice(0, eq)}=${REDACTED}` : pair;
    })
    .join('&');
}

function redactMultipart(text: string): string {
  return text.replace(
    /(name="([^"]*)"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n)([^\r\n]*)/g,
    (m, head: string, name: string) => (isSecretKey(name) ? `${head}${REDACTED}` : m),
  );
}

/** Redact secret-like fields in a request body (JSON, urlencoded form or multipart). */
export function redactRequestBody(text: string, contentType = ''): string {
  const json = tryJson(text);
  if (json !== undefined && typeof json === 'object' && json !== null) {
    return JSON.stringify(redactJson(json, isSecretKey));
  }
  if (/multipart\/form-data/i.test(contentType) || text.startsWith('--'))
    return redactMultipart(text);
  if (/x-www-form-urlencoded/i.test(contentType) || /^[^\s=&]+=/.test(text)) {
    return redactForm(text);
  }
  return text;
}

/** Redact obvious token fields (access_token, password, …) in a JSON response body. */
export function redactResponseBody(text: string): string {
  const json = tryJson(text);
  if (json !== undefined && typeof json === 'object' && json !== null) {
    return JSON.stringify(
      redactJson(json, (k) => RESPONSE_SECRET_KEYS.has(norm(k))),
      null,
      2,
    );
  }
  return text;
}

/** Redact secret-like query parameter values in a URL. */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash === -1 ? undefined : hash);
  return `${url.slice(0, q + 1)}${redactForm(query)}${hash === -1 ? '' : url.slice(hash)}`;
}

export function isTextMime(mime: string | undefined): boolean {
  if (!mime) return true;
  return /^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|svg|html|yaml|graphql/i.test(
    mime,
  );
}

// ---------------------------------------------------------------------------
// Buffer
// ---------------------------------------------------------------------------

interface TabLog {
  entries: Entry[];
  byId: Map<string, Entry>;
  hops: Map<string, number>;
}

const logs = new Map<number, TabLog>();

export function isRecording(tabId: number): boolean {
  return logs.has(tabId);
}

function newEntry(log: TabLog, id: string): Entry {
  const e: Entry = {
    id,
    method: 'GET',
    url: '',
    type: 'Other',
    requestHeaders: {},
    responseHeaders: {},
    finished: false,
  };
  log.entries.push(e);
  log.byId.set(id, e);
  while (log.entries.length > MAX_ENTRIES) {
    const old = log.entries.shift();
    if (old && log.byId.get(old.id) === old) log.byId.delete(old.id);
  }
  return e;
}

/** Start recording on a tab (idempotent). Returns true if recording was not on before. */
export async function startRecording(tabId: number): Promise<boolean> {
  if (logs.has(tabId)) return false;
  logs.set(tabId, { entries: [], byId: new Map(), hops: new Map() });
  try {
    await cdp.send(tabId, 'Network.enable', {
      maxTotalBufferSize: 10_000_000,
      maxResourceBufferSize: 2_000_000,
    });
  } catch (e) {
    logs.delete(tabId);
    throw e;
  }
  return true;
}

export function clearLog(tabId: number): void {
  const log = logs.get(tabId);
  if (!log) return;
  log.entries.length = 0;
  log.byId.clear();
  log.hops.clear();
}

export function dropLog(tabId: number): void {
  logs.delete(tabId);
}

export function getEntry(tabId: number, id: string): Entry | undefined {
  return logs.get(tabId)?.byId.get(id);
}

export interface Filter {
  filter?: string;
  types?: string[];
  method?: string;
  status?: (s: number) => boolean;
}

export function parseStatus(spec: string): (s: number) => boolean {
  const s = spec.trim();
  let m = /^([1-5])xx$/i.exec(s);
  if (m) {
    const lo = Number(m[1]) * 100;
    return (n) => n >= lo && n < lo + 100;
  }
  m = /^(\d{3})-(\d{3})$/.exec(s);
  if (m) {
    const [lo, hi] = [Number(m[1]), Number(m[2])];
    return (n) => n >= lo && n <= hi;
  }
  if (/^\d{3}$/.test(s)) return (n) => n === Number(s);
  throw new Error(`--status must be like 200, 2xx or 400-499 (got "${spec}")`);
}

export function list(tabId: number, f: Filter = {}): Entry[] {
  const needle = f.filter?.toLowerCase();
  return (logs.get(tabId)?.entries ?? []).filter((e) => {
    if (!e.url) return false;
    if (needle && !e.url.toLowerCase().includes(needle)) return false;
    if (f.types && !f.types.includes(e.type.toLowerCase())) return false;
    if (f.method && e.method.toUpperCase() !== f.method.toUpperCase()) return false;
    if (f.status && (e.status === undefined || !f.status(e.status))) return false;
    return true;
  });
}

export function line(e: Entry): string {
  const status = e.failed ? `failed (${e.failed})` : (e.status ?? 'pending');
  return `[${e.id}] ${e.method} ${e.url} (${e.type}) ${status}`;
}

// ---------------------------------------------------------------------------
// CDP events
// ---------------------------------------------------------------------------

type P = Record<string, unknown>;

const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);

function applyResponse(e: Entry, r: P): void {
  e.status = Number(r.status);
  if (typeof r.statusText === 'string') e.statusText = r.statusText;
  if (typeof r.mimeType === 'string') e.mimeType = r.mimeType;
  e.responseHeaders = { ...e.responseHeaders, ...redactHeaders(r.headers as P) };
}

export function handleEvent(tabId: number, method: string, raw: unknown): void {
  const log = logs.get(tabId);
  if (!log || !method.startsWith('Network.')) return;
  const p = (raw ?? {}) as P;
  const id = typeof p.requestId === 'string' ? p.requestId : undefined;
  if (!id) return;
  let e = log.byId.get(id);

  switch (method) {
    case 'Network.requestWillBeSent': {
      const req = (p.request ?? {}) as P;
      const redirect = p.redirectResponse as P | undefined;
      if (e && redirect) {
        // The previous hop of a redirect chain keeps its own entry; this id moves on.
        applyResponse(e, redirect);
        e.finished = true;
        const n = (log.hops.get(id) ?? 0) + 1;
        log.hops.set(id, n);
        log.byId.delete(id);
        e.id = `${id}~${n}`;
        log.byId.set(e.id, e);
        e = undefined;
      }
      // An ExtraInfo event may have created a placeholder before this one arrived.
      e ??= newEntry(log, id);
      e.method = str(req.method, 'GET');
      e.url = redactUrl(str(req.url, ''));
      e.type = typeof p.type === 'string' ? p.type : 'Other';
      e.requestHeaders = { ...redactHeaders(req.headers as P), ...e.requestHeaders };
      if (typeof req.postData === 'string') {
        const ct = Object.entries((req.headers ?? {}) as P).find(
          ([k]) => k.toLowerCase() === 'content-type',
        )?.[1];
        e.postData = redactRequestBody(req.postData.slice(0, MAX_POST_DATA), str(ct, ''));
      }
      e.startMono = Number(p.timestamp);
      e.startedAt = typeof p.wallTime === 'number' ? p.wallTime * 1000 : Date.now();
      return;
    }
    case 'Network.requestWillBeSentExtraInfo':
      // Carries the headers actually sent (cookies included); keep them redacted.
      e ??= newEntry(log, id);
      e.requestHeaders = { ...e.requestHeaders, ...redactHeaders(p.headers as P) };
      return;
    case 'Network.responseReceived':
      e ??= newEntry(log, id);
      applyResponse(e, (p.response ?? {}) as P);
      if (typeof p.type === 'string') e.type = p.type;
      return;
    case 'Network.responseReceivedExtraInfo':
      e ??= newEntry(log, id);
      e.responseHeaders = { ...e.responseHeaders, ...redactHeaders(p.headers as P) };
      return;
    case 'Network.loadingFinished':
      if (!e) return;
      e.finished = true;
      e.size = Number(p.encodedDataLength);
      if (e.startMono !== undefined) {
        e.durationMs = Math.max(0, Math.round((Number(p.timestamp) - e.startMono) * 1000));
      }
      return;
    case 'Network.loadingFailed':
      if (!e) return;
      e.finished = true;
      e.failed = p.canceled ? 'canceled' : str(p.errorText, 'failed');
      return;
  }
}

cdp.onEvent(handleEvent);
cdp.onDetached(dropLog);

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export interface Body {
  /** Redacted text, or undefined with `note` saying why. */
  text?: string;
  note?: string;
  truncated?: boolean;
}

export async function responseBody(tabId: number, e: Entry): Promise<Body> {
  if (e.failed) return { note: `no body (request failed: ${e.failed})` };
  if (!e.finished) return { note: 'not available yet: the response has not finished loading' };
  if (e.status !== undefined && [204, 304].includes(e.status)) return { note: 'no body' };
  if (!isTextMime(e.mimeType))
    return { note: `binary body not shown (${e.mimeType ?? 'unknown'})` };
  let res: { body: string; base64Encoded: boolean };
  try {
    res = await cdp.send<{ body: string; base64Encoded: boolean }>(
      tabId,
      'Network.getResponseBody',
      {
        requestId: e.id.replace(/~\d+$/, ''),
      },
    );
  } catch {
    return {
      note: 'body not available (evicted from the browser buffer, a redirect, or never stored)',
    };
  }
  if (res.base64Encoded) return { note: `binary body not shown (${e.mimeType ?? 'unknown'})` };
  let text = redactResponseBody(res.body);
  const truncated = text.length > MAX_BODY_CHARS;
  if (truncated) text = text.slice(0, MAX_BODY_CHARS);
  return { text, truncated };
}
