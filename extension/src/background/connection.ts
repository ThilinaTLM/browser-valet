// WebSocket client to the local `bctl` proxy (see PROTOCOL.md), with mutual HMAC authentication.

import type { CliRequest, ConnStatus } from '../shared';
import { execute } from './dispatch';
import { save, setPaired, settings, state } from './state';

const VERSION = chrome.runtime.getManifest().version;
const RETRY_MS = 1000;

let ws: WebSocket | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
const inflight = new Map<number, AbortController>();

function setStatus(status: ConnStatus): void {
  if (state.conn.status === status) return;
  state.conn.status = status;
  save();
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)).buffer);
}

async function hmac(message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(settings.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

function browserName(): string {
  const data = (navigator as { userAgentData?: { brands: { brand: string; version: string }[] } })
    .userAgentData;
  const brands = (data?.brands ?? []).filter((b) => !/not.?a.?brand/i.test(b.brand));
  // Prefer the product ("Google Chrome", "Brave") over the engine ("Chromium").
  const product = brands.find((b) => !/chromium/i.test(b.brand)) ?? brands[0];
  return product ? `${product.brand} ${product.version}` : navigator.userAgent;
}

function scheduleRetry(delay = RETRY_MS): void {
  if (retryTimer || !settings.enabled) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    connect();
  }, delay);
}

export function disconnect(): void {
  const sock = ws;
  ws = undefined;
  sock?.close();
  for (const c of inflight.values()) c.abort();
  inflight.clear();
}

/** Connect if not already connected/connecting. Safe to call often. */
export function connect(): void {
  if (!settings.enabled) {
    disconnect();
    setStatus('off');
    return;
  }
  if (ws) return;

  const sock = new WebSocket(`ws://127.0.0.1:${settings.port}/`);
  ws = sock;
  let nonce = '';
  let challenge = '';
  let authed = false;
  let rejected = false;

  const send = (msg: unknown) => {
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg));
  };

  sock.onmessage = async (ev: MessageEvent<string>) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'challenge': {
        challenge = String(msg.nonce);
        nonce = randomHex(32);
        send({
          t: 'auth',
          role: 'ext',
          nonce,
          mac: await hmac(`bctl1|client|ext|${challenge}|${nonce}`),
          version: VERSION,
          info: { browser: browserName(), extVersion: VERSION },
        });
        break;
      }
      case 'welcome': {
        // Make sure we're talking to a proxy that knows our secret, not a port squatter.
        if (msg.mac !== (await hmac(`bctl1|server|ext|${nonce}|${challenge}`))) {
          rejected = true;
          sock.close();
          return;
        }
        authed = true;
        setStatus('connected');
        await setPaired(true);
        break;
      }
      case 'error':
        rejected = true;
        break;
      case 'req': {
        if (!authed) return;
        const id = Number(msg.id);
        const controller = new AbortController();
        inflight.set(id, controller);
        const res = await execute(msg.req as CliRequest, controller.signal, (stderr) => {
          send({ t: 'event', id, stderr });
        });
        inflight.delete(id);
        send({ t: 'res', id, res });
        break;
      }
      case 'cancel':
        inflight.get(Number(msg.id))?.abort();
        break;
    }
  };

  sock.onclose = () => {
    if (ws === sock) ws = undefined;
    for (const c of inflight.values()) c.abort();
    inflight.clear();
    if (!settings.enabled) {
      setStatus('off');
      return;
    }
    setStatus(rejected ? 'auth-failed' : 'waiting');
    scheduleRetry(rejected ? 5000 : RETRY_MS);
  };
}

/** Keep the socket and the service worker alive (extension API calls reset the idle timer). */
export function startKeepAlive(): void {
  setInterval(() => {
    void chrome.runtime.getPlatformInfo();
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping' }));
  }, 20_000);
}
