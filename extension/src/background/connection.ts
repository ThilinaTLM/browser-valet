// WebSocket client to the local `bvl` proxy (see docs/architecture/protocol.md), with mutual HMAC authentication.
// When an authenticated connection ends for any reason other than an announced proxy restart, the
// extension switches itself off (see runtime.md, "The on/off switch").

import type { CliRequest, ConnStatus, OffReason } from '../shared';
import { execute } from './dispatch';
import { log, refreshPairing, save, setPaired, settings, state } from './state';
import { setEnabled } from './switch';

const VERSION = chrome.runtime.getManifest().version;
const RETRY_MS = 1000;
const UPDATE_RETRY_MS = 10 * 60_000;
const OFF_LOG: Record<OffReason, string> = {
  idle: 'bvl was idle',
  stopped: 'bvl was stopped',
  lost: 'connection to bvl lost',
};

let ws: WebSocket | undefined;
let connecting = false;
let updating = false;
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
  if (ws || connecting) return;
  connecting = true;
  // Re-read pairing.json first so re-pairing (`bvl setup`) needs no extension reload.
  void refreshPairing()
    .catch(() => undefined)
    .then(() => {
      connecting = false;
      if (!ws && settings.enabled) open();
    });
}

/** Wait for in-flight requests, hand the state over, and reload into the new version. */
async function selfUpdate(version: string): Promise<void> {
  const { updateTried } = await chrome.storage.local.get<{
    updateTried?: { version: string; ts: number };
  }>('updateTried');
  // Loop guard: a reload that didn't pick up the new version is retried at most every 10 minutes.
  if (updateTried?.version === version && Date.now() - updateTried.ts < UPDATE_RETRY_MS) {
    console.warn(`bvl: already tried updating to ${version} and it did not take; ignoring`);
    return;
  }
  if (updating || VERSION === version) return;
  updating = true;
  await chrome.storage.local.set({ updateTried: { version, ts: Date.now() } });
  const deadline = Date.now() + 120_000;
  while (inflight.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  console.info(`bvl: updating extension ${VERSION} -> ${version}`);
  log({
    ts: Date.now(),
    session: 'bvl',
    command: `update ${VERSION} → ${version}`,
    ok: true,
  });
  await chrome.storage.local.set({ handoff: { state, ts: Date.now() } });
  chrome.runtime.reload();
}

function open(): void {
  const sock = new WebSocket(`ws://127.0.0.1:${settings.port}/`);
  ws = sock;
  let nonce = '';
  let challenge = '';
  let authed = false;
  let rejected = false;
  /** The proxy's `bye` reason, if it said goodbye before closing. */
  let bye: string | undefined;

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
          info: {
            browser: browserName(),
            extVersion: VERSION,
            managed: state.conn.managed === true,
          },
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
      case 'update':
        if (authed && typeof msg.version === 'string') void selfUpdate(msg.version);
        break;
      case 'cancel':
        inflight.get(Number(msg.id))?.abort();
        break;
      case 'bye':
        if (authed) bye = String(msg.reason);
        break;
    }
  };

  sock.onclose = () => {
    // `disconnect()` clears `ws` before closing: then the extension itself ended the connection.
    const ours = ws !== sock;
    if (ws === sock) ws = undefined;
    for (const c of inflight.values()) c.abort();
    inflight.clear();
    // bvl went away (idle exit, `bvl stop`, crash): switch off until the user switches on again.
    // Only an announced restart (new version, re-pairing) and our own self-update reload keep it on.
    if (authed && !ours && !updating && bye !== 'restart' && settings.enabled) {
      const reason: OffReason = bye === 'idle' ? 'idle' : bye === 'stop' ? 'stopped' : 'lost';
      log({
        ts: Date.now(),
        session: 'bvl',
        command: `switched off: ${OFF_LOG[reason]}`,
        ok: true,
      });
      setStatus('off');
      void setEnabled(false, reason);
      return;
    }
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
