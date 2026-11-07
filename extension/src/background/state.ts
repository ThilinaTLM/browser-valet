// The extension is the single source of truth. State lives in memory and is mirrored to
// chrome.storage.session so it survives service-worker restarts (and the popup can render it).

import { DEFAULT_PORT, type LogEntry, type Settings, type State, type TabMeta } from '../shared';

const initial = (): State => ({
  nextTid: 1,
  tabs: {},
  sessions: {},
  refs: {},
  approvals: [],
  log: [],
  conn: { status: 'waiting', paired: false },
});

export let state: State = initial();
export let settings: Settings = { secret: '', port: DEFAULT_PORT, enabled: true };

let saveQueued = false;

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

export async function loadState(): Promise<void> {
  const stored = await chrome.storage.session.get<{ state?: State }>('state');
  state = { ...initial(), ...stored.state };
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
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set(settings);
}

export async function regenerateSecret(): Promise<void> {
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
  for (const s of Object.values(state.sessions)) if (s.tab === tabId) delete s.tab;
  state.approvals = state.approvals.filter((a) => a.tabId !== tabId);
  save();
}

export function session(name: string): { tab?: number } {
  return (state.sessions[name] ??= {});
}

export function log(entry: LogEntry): void {
  state.log = [entry, ...state.log].slice(0, 50);
  save();
}
