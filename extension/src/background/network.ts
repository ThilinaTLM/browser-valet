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
export const MAX_POST_DATA = 8192;
/** Larger request bodies are not kept at all: redacting them is not worth the time. */
export const MAX_REDACT_INPUT = 1_000_000;

/** Copy a slice so the (possibly large) parent string is not retained. */
const flat = (s: string): string => new TextDecoder().decode(new TextEncoder().encode(s));

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
  /** The request body was longer than MAX_POST_DATA and cut after redaction. */
  postDataTruncated?: boolean;
  /** Why there is no `postData` (too large to redact). */
  postDataNote?: string;
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

/** Headers whose value is a URL (or holds one): its query and fragment are redacted. */
const URL_HEADERS = new Set(['location', 'referer', 'content-location', 'refresh', ':path']);

export function redactHeaders(h: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    const name = k.toLowerCase();
    out[k] = isCredentialHeader(k)
      ? REDACTED
      : URL_HEADERS.has(name)
        ? redactUrl(String(v))
        : String(v);
  }
  return out;
}

const norm = (k: string): string => k.toLowerCase().replace(/[-_.\s]/g, '');

/**
 * Keys whose values are secrets in a request (form, JSON, multipart or URL query). Matching is
 * case- and separator-insensitive (`norm`). A bare `code` is deliberately not matched (too many
 * harmless `code=US` / `code=404` fields); OAuth callback `code` values are single-use.
 */
export function isSecretKey(key: string): boolean {
  return /passw|passcode|token|secret|apikey|credential|authorization|csrf|xsrf|^auth$|^pin$|^otp$|privatekey|sessionid|sessionkey|accesskey|encryptionkey|signingkey|cookie|jwt|assertion|devicecode|authcode|authorizationcode|codeverifier|signature/.test(
    norm(key),
  );
}

/** `*token` keys that are cursors, not credentials. */
const HARMLESS_TOKEN = /^((next|prev|previous)?(page|continuation|sync|resume|cursor))token$/;

/**
 * Keys whose values are secrets in a response body (after `norm`): any key ending in `token`
 * (except pagination/cursor tokens) or containing a secret-like word. `tokens_used`,
 * `token_count`, `token_type`, `expires_in`, a bare `code` and `refresh` stay visible.
 */
export function isResponseSecretKey(key: string): boolean {
  const n = norm(key);
  if (HARMLESS_TOKEN.test(n)) return false;
  return (
    n.endsWith('token') ||
    /secret|passw|apikey|accesskey|secretkey|privatekey|sessionkey|sessionid|encryptionkey|signingkey|credential|cookie|csrf|xsrf|jwt|assertion|devicecode|authcode|authorizationcode|codeverifier|signature|authorization/.test(
      n,
    )
  );
}

const JWT_VALUE = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;
const URL_VALUE = /^https?:\/\//i;

/** Redact a string value regardless of its key: JWT-shaped values and secret query/fragment in URLs. */
function redactValue(v: string): string {
  if (v.length < 2000 && JWT_VALUE.test(v)) return REDACTED;
  if (URL_VALUE.test(v)) return redactUrl(v);
  return v;
}

function redactJson(value: unknown, isSecret: (k: string) => boolean): unknown {
  if (typeof value === 'string') return redactValue(value);
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

function redactForm(text: string, isSecret: (k: string) => boolean = isSecretKey): string {
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
      return isSecret(key) ? `${pair.slice(0, eq)}=${REDACTED}` : pair;
    })
    .join('&');
}

/** Linear multipart redaction: split on the boundary, then look at each part's own headers. */
function redactMultipart(text: string, contentType: string): string {
  let boundary = /boundary=("?)([^";\s]+)\1/i.exec(contentType)?.[2];
  if (!boundary && text.startsWith('--')) {
    const eol = text.search(/\r?\n/);
    boundary = text.slice(2, eol === -1 ? undefined : eol).trim();
  }
  if (!boundary) return REDACTED;
  const delim = `--${boundary}`;
  const pieces = text.split(delim);
  // Boundary mismatch (nothing to split): fail closed.
  if (pieces.length < 3) return REDACTED;
  return pieces
    .map((part, i) => {
      if (i === 0 || part.startsWith('--')) return part;
      const crlf = part.indexOf('\r\n\r\n');
      const lf = part.indexOf('\n\n');
      const useCrlf = crlf !== -1 && (lf === -1 || crlf < lf);
      const at = useCrlf ? crlf : lf;
      if (at === -1) return part;
      const sep = useCrlf ? '\r\n\r\n' : '\n\n';
      const m = /(?:^|[\s;])name=(?:"([^"]*)"|([^\s;]+))/i.exec(part.slice(0, at));
      const name = m?.[1] ?? m?.[2];
      if (name === undefined || !isSecretKey(name)) return part;
      const value = part.slice(at + sep.length);
      const tail = value.endsWith('\r\n') ? '\r\n' : value.endsWith('\n') ? '\n' : '';
      return `${part.slice(0, at + sep.length)}${REDACTED}${tail}`;
    })
    .join(delim);
}

/** Redact secret-like fields in a request body (JSON, urlencoded form or multipart). */
export function redactRequestBody(text: string, contentType = ''): string {
  const json = tryJson(text);
  if (json !== undefined && typeof json === 'object' && json !== null) {
    return JSON.stringify(redactJson(json, isSecretKey));
  }
  if (/multipart\/form-data/i.test(contentType) || text.startsWith('--'))
    return redactMultipart(text, contentType);
  if (/x-www-form-urlencoded/i.test(contentType)) return redactForm(text);
  if (JSONISH_MIME.test(contentType) || /^\s*[{[]/.test(text)) {
    return redactJsonText(text, isSecretKey);
  }
  if (/^[^\s=&]+=/.test(text)) return redactForm(text);
  return text;
}

const XSSI_PREFIX = /^(\)\]\}',?|while\s*\(1\);|for\s*\(;;\);|\{\}&&)[ \t]*\r?\n?/;
const JSONISH_MIME = /json|event-stream|javascript|ecmascript/i;
const WITHHELD = '[body withheld: could not be parsed for redaction]';

/**
 * End index (exclusive) of the JSON string starting at `start` (a `"`). A JSON string cannot hold a
 * raw newline, so an unterminated string stops at the newline (or the end of the text) and the
 * result is `-(position) - 1`: the caller resumes scanning at that position and treats it as no
 * key and no value. This keeps one stray quote from shifting the pairing on later lines.
 */
function stringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 92) i++;
    else if (c === 34) return i + 1;
    else if (c === 10 || c === 13) return -i - 1;
  }
  return -text.length - 1;
}

const isWs = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r';

/**
 * Single-pass scanner for JSON-like text that is not one JSON document (NDJSON, SSE, JSONP):
 * redacts the value of every `"key": value` pair whose key is secret, plus JWT-shaped and URL
 * string values. Linear: every character is read a bounded number of times. A secret key holding
 * an object or array cannot be cut out reliably, so the whole body is withheld then. Only double-
 * quoted keys are recognised (single-quoted or unquoted JS keys are not).
 */
function redactJsonText(text: string, isSecret: (k: string) => boolean): string {
  const out: string[] = [];
  let last = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] !== '"') {
      i++;
      continue;
    }
    const end = stringEnd(text, i);
    if (end < 0) {
      i = -end - 1;
      continue;
    }
    let k = end;
    while (isWs(text[k])) k++;
    if (text[k] === ':') {
      let key = text.slice(i + 1, end - 1);
      try {
        key = JSON.parse(text.slice(i, end)) as string;
      } catch {
        // keep raw key
      }
      let v = k + 1;
      while (isWs(text[v])) v++;
      if (isSecret(key)) {
        const c = text[v];
        if (c === '{' || c === '[') return WITHHELD;
        let ve = v;
        if (c === '"') {
          const se = stringEnd(text, v);
          ve = se < 0 ? -se - 1 : se;
        } else while (ve < n && !isWs(text[ve]) && !/[,}\]]/.test(text[ve] ?? '')) ve++;
        out.push(text.slice(last, v), `"${REDACTED}"`);
        last = ve;
        i = ve;
      } else {
        i = v;
      }
      continue;
    }
    // A string value (not a key).
    const head = text.slice(i + 1, i + 9);
    if (head.startsWith('eyJ') || /^https?:/i.test(head)) {
      let val = text.slice(i + 1, end - 1);
      try {
        val = JSON.parse(text.slice(i, end)) as string;
      } catch {
        // keep raw
      }
      const r = redactValue(val);
      if (r !== val) {
        out.push(text.slice(last, i), JSON.stringify(r));
        last = end;
      }
    }
    i = end;
  }
  out.push(text.slice(last));
  return out.join('');
}

/**
 * Redact secret fields (`isResponseSecretKey`) in a response body: JSON (also behind an XSSI
 * prefix), urlencoded (`access_token=...`), and JSON-like text (NDJSON, SSE, JSONP) by key/value
 * pairs. Other content is returned as is.
 */
export function redactResponseBody(text: string, mimeType = ''): string {
  const xssi = XSSI_PREFIX.exec(text)?.[0] ?? '';
  const json = tryJson(text.slice(xssi.length));
  if (json !== undefined && typeof json === 'object' && json !== null) {
    return xssi + JSON.stringify(redactJson(json, isResponseSecretKey), null, 2);
  }
  const trimmed = text.trim();
  if (/x-www-form-urlencoded/i.test(mimeType) || /^[^\s=&<>{}[\]]+=\S*$/.test(trimmed)) {
    const redacted = redactForm(trimmed, isResponseSecretKey);
    return redacted === trimmed ? text : redacted;
  }
  if (JSONISH_MIME.test(mimeType) || /^[{[]/.test(trimmed))
    return redactJsonText(text, isResponseSecretKey);
  return text;
}

/** Redact secret-like query and fragment values in a URL (OAuth implicit flow: `#access_token=`). */
export function redactUrl(url: string): string {
  const hash = url.indexOf('#');
  const main = hash === -1 ? url : url.slice(0, hash);
  const frag = hash === -1 ? '' : `#${redactForm(url.slice(hash + 1))}`;
  const q = main.indexOf('?');
  if (q === -1) return main + frag;
  return `${main.slice(0, q + 1)}${redactForm(main.slice(q + 1))}${frag}`;
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
      maxPostDataSize: MAX_REDACT_INPUT,
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
        // Redact the whole body first: a cut JSON body no longer parses and would leak.
        if (req.postData.length > MAX_REDACT_INPUT) {
          // Fail closed: too large to redact, so keep nothing.
          e.postData = undefined;
          e.postDataTruncated = false;
          e.postDataNote = 'body too large to redact';
        } else {
          const redacted = redactRequestBody(req.postData, str(ct, ''));
          e.postDataNote = undefined;
          e.postDataTruncated = redacted.length > MAX_POST_DATA;
          e.postData = e.postDataTruncated ? flat(redacted.slice(0, MAX_POST_DATA)) : redacted;
        }
      } else if (req.hasPostData === true) {
        // Chrome dropped it (over maxPostDataSize, counted in bytes): nothing to redact.
        e.postData = undefined;
        e.postDataTruncated = false;
        e.postDataNote = 'body too large to redact';
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
  if (res.body.length > MAX_REDACT_INPUT) return { note: 'body too large to redact' };
  let text = redactResponseBody(res.body, e.mimeType);
  const truncated = text.length > MAX_BODY_CHARS;
  if (truncated) text = text.slice(0, MAX_BODY_CHARS);
  return { text, truncated };
}
