// The extension is the single source of truth. State lives in memory and is mirrored to
// chrome.storage.session so it survives service-worker restarts (and the popup can render it).

import {
  DEFAULT_PORT,
  type LogEntry,
  type Pairing,
  type Settings,
  type State,
  type TabMeta,
} from '../shared';
import { loadGuardrails } from './guardrails';
import { forgetBaselines } from './snapshot-diff';

const initial = (): State => ({
  nextTid: 1,
  tabs: {},
  sessions: {},
  refs: {},
  refDocs: {},
  childSessions: {},
  frames: {},
  approvals: [],
  log: [],
  conn: { status: 'waiting', paired: false },
});

export let state: State = initial();
export let settings: Settings = { secret: '', port: DEFAULT_PORT, enabled: true };

let saveQueued = false;

/** Until this time, Chrome detaches caused by our own reload must not count as the user's. */
export let handoffGraceUntil = 0;
const HANDOFF_MAX_AGE_MS = 60_000;

/** Persist state (coalesced: many mutations in one tick produce one write). */
export function save(): void {
  if (saveQueued) return;
  saveQueued = true;
  queueMicrotask(() => {
    saveQueued = false;
    void chrome.storage.session.set({ state });
  });
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Read `pairing.json` from the managed folder. Missing or invalid → undefined (quietly). */
async function readPairing(): Promise<Pairing | undefined> {
  try {
    const res = await fetch(chrome.runtime.getURL('pairing.json'), { cache: 'no-store' });
    if (!res.ok) return undefined;
    const p = (await res.json()) as Partial<Pairing> | null;
    if (
      typeof p?.secret === 'string' &&
      p.secret !== '' &&
      typeof p.port === 'number' &&
      Number.isInteger(p.port) &&
      p.port > 0 &&
      p.port < 65536
    ) {
      return { secret: p.secret, port: p.port };
    }
  } catch {
    // not installed by bctl (file missing)
  }
  return undefined;
}

/** (Re)compute the effective secret/port: pairing.json wins over chrome.storage.local. */
export async function refreshPairing(): Promise<void> {
  const [pairing, local] = await Promise.all([
    readPairing(),
    chrome.storage.local.get<Partial<Settings>>(['secret', 'port']),
  ]);
  if (pairing) {
    settings.secret = pairing.secret;
    settings.port = pairing.port;
  } else {
    if (local.secret) settings.secret = local.secret;
    settings.port = local.port ?? DEFAULT_PORT;
  }
  const managed = pairing !== undefined;
  if (state.conn.managed !== managed || state.conn.port !== settings.port) {
    state.conn.managed = managed;
    state.conn.port = settings.port;
    save();
  }
}

/** Restore state handed over by a self-update reload (chrome.storage.session is wiped by it). */
async function restoreHandoff(): Promise<void> {
  const { handoff, updateTried } = await chrome.storage.local.get<{
    handoff?: { state?: State; ts?: number };
    updateTried?: { version: string; ts: number };
  }>(['handoff', 'updateTried']);
  if (updateTried?.version === chrome.runtime.getManifest().version) {
    await chrome.storage.local.remove('updateTried');
  }
  if (!handoff) return;
  await chrome.storage.local.remove('handoff');
  if (
    handoff.state &&
    typeof handoff.ts === 'number' &&
    Date.now() - handoff.ts < HANDOFF_MAX_AGE_MS
  ) {
    // Pending approvals are dropped: their CLI waiters are gone. So are child (iframe) sessions:
    // the reload ended every debugger attachment, and with it their sessions.
    state = {
      ...initial(),
      ...handoff.state,
      approvals: [],
      childSessions: {},
      conn: initial().conn,
    };
    handoffGraceUntil = Date.now() + 5000;
  }
}

export async function loadState(): Promise<void> {
  const stored = await chrome.storage.session.get<{ state?: State }>('state');
  // Approvals are never restored: their waiters lived in the previous service worker, so
  // nothing could answer them (the CLI request that asked has already failed).
  state = { ...initial(), ...stored.state, approvals: [] };
  await restoreHandoff();
  const local = await chrome.storage.local.get<Partial<Settings & { paired: boolean }>>([
    'secret',
    'port',
    'enabled',
    'paired',
  ]);
  settings = {
    secret: local.secret ?? '',
    port: local.port ?? DEFAULT_PORT,
    enabled: local.enabled ?? true,
  };
  if (!settings.secret) {
    settings.secret = randomSecret();
    await chrome.storage.local.set({ secret: settings.secret, paired: false });
  }
  state.conn.paired = local.paired ?? false;
  await loadGuardrails();
  await refreshPairing();
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  if (state.conn.managed) {
    // Secret and port belong to pairing.json.
    patch = { enabled: patch.enabled ?? settings.enabled };
  }
  settings = { ...settings, ...patch };
  await chrome.storage.local.set(patch);
  state.conn.port = settings.port;
  save();
}

export async function regenerateSecret(): Promise<void> {
  if (state.conn.managed) return;
  await updateSettings({ secret: randomSecret() });
  await setPaired(false);
}

export async function setPaired(paired: boolean): Promise<void> {
  if (state.conn.paired === paired) return;
  state.conn.paired = paired;
  save();
  await chrome.storage.local.set({ paired });
}

/** Stable short id (t1, t2, …) for a Chrome tab; never reused while the browser runs. */
export function meta(tabId: number): TabMeta {
  let m = state.tabs[tabId];
  if (!m) {
    m = { tid: `t${state.nextTid++}` };
    state.tabs[tabId] = m;
    save();
  }
  return m;
}

/** Resolve `t3` or a label to a Chrome tab id. */
export function findTab(ref: string): number | undefined {
  for (const [id, m] of Object.entries(state.tabs)) {
    if (m.tid === ref || m.label === ref) return Number(id);
  }
  return undefined;
}

export function forgetTab(tabId: number): void {
  delete state.tabs[tabId];
  delete state.refs[tabId];
  delete state.refDocs[tabId];
  delete state.childSessions[tabId];
  delete state.frames[tabId];
  forgetBaselines(tabId);
  for (const s of Object.values(state.sessions)) if (s.tab === tabId) delete s.tab;
  state.approvals = state.approvals.filter((a) => a.tabId !== tabId);
  save();
}

export function session(name: string): { tab?: number; nextRef?: number } {
  return (state.sessions[name] ??= {});
}

export function log(entry: LogEntry): void {
  state.log = [entry, ...state.log].slice(0, 50);
  save();
}
