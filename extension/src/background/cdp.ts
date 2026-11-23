// Thin wrapper over chrome.debugger: lazy attach, typed-ish send, and per-tab event buffers
// (JavaScript dialogs, console messages, page errors), plus child sessions for
// out-of-process iframes.

import type { ChildSession } from '../shared';
import { UserError } from './errors';
import { save, state } from './state';

export interface Dialog {
  type: string;
  message: string;
  defaultPrompt?: string;
}

/** One console message; shaped like agent-browser's: `args` are CDP RemoteObjects. */
export interface ConsoleEntry {
  type: string;
  text: string;
  args: RemoteObject[];
}

/** One uncaught page error (`line` and `column` are 0-based, as CDP reports them). */
export interface PageError {
  text: string;
  line: number | null;
  column: number | null;
  url: string | null;
}

interface TabEvents {
  dialog?: Dialog;
  console: ConsoleEntry[];
  errors: PageError[];
}

const attached = new Set<number>();
/** Tabs whose debugger we found already attached (a previous worker's): their child sessions are only known from `state`. */
const resumed = new Set<number>();
/** Tabs for which the debugger was re-attached to rediscover child sessions (once per attach). */
const rediscovered = new Set<number>();
const events = new Map<number, TabEvents>();
const listeners = new Set<(tabId: number, method: string, params: unknown) => void>();
const MAX_BUFFER = 500;
/** CDP exception id of each buffered page error, so a revoked one can be dropped. */
const exceptionIds = new WeakMap<PageError, number>();
const detachListeners = new Set<(tabId: number) => void>();
const attachListeners = new Set<(tabId: number) => void>();

/** Called after a tab's debugger session is ready (Page and Runtime enabled). */
export function onAttached(fn: (tabId: number) => void): void {
  attachListeners.add(fn);
}

/** Called whenever a tab's debugger session ends (revoke, user detach, navigation swap). */
export function onDetached(fn: (tabId: number) => void): void {
  detachListeners.add(fn);
}

/** Called when the user dismisses Chrome's "is debugging this browser" bar. */
let onUserDetach: (tabId: number) => void = () => undefined;
export function setOnUserDetach(fn: (tabId: number) => void): void {
  onUserDetach = fn;
}

export function tabEvents(tabId: number): TabEvents {
  let e = events.get(tabId);
  if (!e) {
    e = { console: [], errors: [] };
    events.set(tabId, e);
  }
  return e;
}

function push<T>(buf: T[], entry: T): void {
  buf.push(entry);
  if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - MAX_BUFFER);
}

/** Why the debugger last left a tab (Chrome's `onDetach` reason) and when; cleared by a successful attach. */
const lastDetach = new Map<number, { reason: string; at: number }>();

/** Schemes Chrome never lets extensions debug. */
const RESTRICTED_URL =
  /^(chrome|edge|brave|devtools|chrome-extension|chrome-search|chrome-untrusted|chrome-error|view-source|about):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)\//i;
const CONTROLLABLE_URL = /^(https?|file|ftp):/i;
/** Attach retries for ordinary pages (transient overlays of other extensions). */
const ATTACH_RETRIES = 5;
const ATTACH_RETRY_MS = 400;

async function tabUrl(tabId: number): Promise<string | undefined> {
  try {
    const t = await chrome.tabs.get(tabId);
    const url = t.url !== undefined && t.url !== '' ? t.url : t.pendingUrl;
    return url !== undefined && url !== '' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Origins of other extensions' targets in this tab, as far as `chrome.debugger.getTargets` shows them. */
async function foreignExtensions(tabId: number, msg: string): Promise<string[]> {
  const found = new Set<string>();
  try {
    const targets = await chrome.debugger.getTargets(); // throws in the unit-test mock
    for (const t of targets) {
      if (t.tabId !== tabId) continue;
      const m = /^chrome-extension:\/\/([a-p]{32})/.exec(t.url);
      if (m && m[1] !== chrome.runtime.id) found.add(`chrome-extension://${m[1]}`);
    }
  } catch {
    // best effort
  }
  const m = /chrome-extension:\/\/([a-p]{32})/.exec(msg);
  if (m && m[1] !== chrome.runtime.id) found.add(`chrome-extension://${m[1]}`);
  return [...found];
}

async function refusedError(tabId: number, cause: unknown, url: string | undefined) {
  const msg = (cause as Error).message;
  const last = lastDetach.get(tabId);
  const detached = last
    ? `The debugger was detached (reason: ${last.reason}, ${Math.max(0, Math.round((Date.now() - last.at) / 1000))} s ago) and Chrome refused to re-attach: `
    : 'Chrome refused to attach the debugger: ';
  if (url !== undefined && CONTROLLABLE_URL.test(url)) {
    const who = await foreignExtensions(tabId, msg);
    return new UserError(
      `${detached}${msg}. This page is normally controllable, so another extension has probably put its own frame into it` +
        ' (password manager or autofill overlay, PDF viewer, wallet, translate)' +
        (who.length ? `; found ${who.join(', ')}` : '') +
        '. Chrome blocks control while that frame is present: close its popup or overlay, or disable that extension on this site, then retry.' +
        ' `bvl reload` also clears it but loses unsaved form data.',
      'not_controllable',
      { cause },
    );
  }
  if (
    url === undefined ||
    RESTRICTED_URL.test(url) ||
    /chrome:\/\/|chrome-extension:\/\//i.test(msg)
  ) {
    return new UserError(
      `Chrome does not allow extensions to control this page (e.g. chrome:// pages)${url ? `: ${url}` : ''}. ${detached}${msg}`,
      'not_controllable',
      { cause },
    );
  }
  return new UserError(`${detached}${msg}`, 'not_controllable', { cause });
}

/** Tabs whose revoke is waiting for Chrome to release the debugger: no command may use them. */
const barred = new Set<number>();
export function bar(tabId: number, on: boolean): void {
  if (on) barred.add(tabId);
  else barred.delete(tabId);
}

export async function attach(tabId: number): Promise<void> {
  if (barred.has(tabId)) throw new UserError('Control of this tab was revoked', 'revoked');
  if (attached.has(tabId)) return;
  let alreadyAttached = false;
  try {
    for (let tries = 0; ; tries++) {
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
        break;
      } catch (e) {
        if (!/cannot access|cannot attach/i.test((e as Error).message)) throw e;
        const url = await tabUrl(tabId);
        if (url !== undefined && CONTROLLABLE_URL.test(url) && tries < ATTACH_RETRIES) {
          await sleep(ATTACH_RETRY_MS);
          continue;
        }
        throw await refusedError(tabId, e, url);
      }
    }
  } catch (e) {
    if (e instanceof UserError) throw e;
    const msg = (e as Error).message;
    if (!/already attached/i.test(msg)) throw e;
    alreadyAttached = true;
    // Chrome words "already attached" the same way for our own attachment (kept across a
    // service-worker restart) and for another debugger. Only our own session accepts commands.
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '0' });
    } catch (probe) {
      throw new Error(
        'Another debugger is attached to this tab (DevTools or another extension). Close DevTools on this tab, or disable the other extension, then retry.',
        { cause: probe },
      );
    }
  }
  lastDetach.delete(tabId);
  attached.add(tabId);
  if (alreadyAttached) resumed.add(tabId);
  else {
    resumed.delete(tabId);
    dropChildren(tabId); // a fresh attachment knows no child sessions yet
  }
  await Promise.all([
    chrome.debugger.sendCommand({ tabId }, 'Page.enable'),
    chrome.debugger.sendCommand({ tabId }, 'Runtime.enable'),
  ]);
  await autoAttach(tabId);
  for (const fn of attachListeners) fn(tabId);
}

// ---------------------------------------------------------------------------
// Child sessions (out-of-process iframes)
// ---------------------------------------------------------------------------

/** Report out-of-process iframes as child sessions (flat mode). Best effort. */
async function autoAttach(tabId: number, sessionId?: string): Promise<void> {
  const target = sessionId ? { tabId, sessionId } : { tabId };
  const params = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };
  try {
    // Workers and the like are not wanted: the filter keeps them from being attached at all.
    await chrome.debugger.sendCommand(target, 'Target.setAutoAttach', {
      ...params,
      filter: [{ type: 'iframe' }, { exclude: true }],
    });
  } catch {
    await chrome.debugger.sendCommand(target, 'Target.setAutoAttach', params).catch(() => 0);
  }
}

function dropChildren(tabId: number): void {
  if (state.childSessions[tabId]) {
    delete state.childSessions[tabId];
    save();
  }
}

/** Out-of-process iframe sessions of a tab, as far as we know. */
export function childSessions(tabId: number): ChildSession[] {
  return state.childSessions[tabId] ?? [];
}

export function childSession(tabId: number, sessionId: string): ChildSession | undefined {
  return childSessions(tabId).find((c) => c.sessionId === sessionId);
}

function forgetChild(tabId: number, sessionId: string): void {
  const list = childSessions(tabId).filter((c) => c.sessionId !== sessionId);
  if (list.length === childSessions(tabId).length) return;
  if (list.length) state.childSessions[tabId] = list;
  else delete state.childSessions[tabId];
  save();
}

function onTargetEvent(tabId: number, source: string | undefined, method: string, p: unknown) {
  if (method === 'Target.attachedToTarget') {
    const a = p as {
      sessionId: string;
      targetInfo: { type: string; targetId: string; url: string };
    };
    if (a.targetInfo.type !== 'iframe') {
      // Not needed, and a lingering session only costs the browser memory.
      void chrome.debugger
        .sendCommand(source ? { tabId, sessionId: source } : { tabId }, 'Target.detachFromTarget', {
          sessionId: a.sessionId,
        })
        .catch(() => 0);
      return;
    }
    const rest = childSessions(tabId).filter((c) => c.sessionId !== a.sessionId);
    const child: ChildSession = {
      sessionId: a.sessionId,
      targetId: a.targetInfo.targetId,
      url: a.targetInfo.url,
    };
    if (source) child.parent = source;
    state.childSessions[tabId] = [...rest, child];
    save();
    void autoAttach(tabId, a.sessionId); // iframes inside it may be out of process again
  } else if (method === 'Target.detachedFromTarget') {
    const sid = (p as { sessionId?: string }).sessionId;
    if (sid) forgetChild(tabId, sid);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The session serving the out-of-process iframe `frameId`. A just-created iframe may need a
 * moment to be reported; after a service-worker restart the tab is re-attached once when nothing
 * is known (Chrome only reports child targets to a new attachment).
 */
export async function sessionForFrame(
  tabId: number,
  frameId: string,
  waitMs = 1000,
): Promise<ChildSession | undefined> {
  const find = () => childSessions(tabId).find((c) => c.targetId === frameId);
  const deadline = Date.now() + waitMs;
  let hit = find();
  while (!hit && Date.now() < deadline) {
    await sleep(50);
    hit = find();
  }
  if (!hit && resumed.has(tabId) && !rediscovered.has(tabId)) {
    rediscovered.add(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // already gone
    }
    attached.delete(tabId);
    resumed.delete(tabId);
    await attach(tabId);
    const until = Date.now() + waitMs;
    while (!(hit = find()) && Date.now() < until) await sleep(50);
  }
  return hit;
}

/** CDP error text for a session that no longer exists. */
const GONE = /session with given id not found/i;

export async function detach(tabId: number): Promise<void> {
  attached.delete(tabId);
  resumed.delete(tabId);
  rediscovered.delete(tabId);
  dropChildren(tabId);
  delete state.frames[tabId];
  events.delete(tabId);
  for (const fn of detachListeners) fn(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // not attached
  }
}

export function isAttached(tabId: number): boolean {
  return attached.has(tabId);
}

export async function send<T = Record<string, unknown>>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string,
): Promise<T> {
  await attach(tabId);
  if (sessionId === undefined) {
    return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
  }
  try {
    return (await chrome.debugger.sendCommand({ tabId, sessionId }, method, params)) as T;
  } catch (e) {
    // The iframe went away or navigated to another process: forget the dead session.
    if (GONE.test((e as Error).message)) {
      forgetChild(tabId, sessionId);
      throw new UserError(
        'The iframe is gone (it navigated or was removed). Run `bvl snapshot` again.',
        'stale_ref',
        { cause: e },
      );
    }
    throw e;
  }
}

/** Subscribe to CDP events from all tabs. Returns an unsubscribe function. */
export function onEvent(fn: (tabId: number, method: string, params: unknown) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export interface RemoteObject {
  type: string;
  value?: unknown;
  description?: string;
}

function formatArg(a: RemoteObject): string {
  if (a.type === 'string') return String(a.value);
  if (a.value !== undefined) return JSON.stringify(a.value);
  return a.description ?? a.type;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  if (method === 'Target.attachedToTarget' || method === 'Target.detachedFromTarget') {
    onTargetEvent(tabId, (source as { sessionId?: string }).sessionId, method, params);
    return;
  }
  // Events of child sessions are not enabled and not mixed into the tab's buffers.
  if ((source as { sessionId?: string }).sessionId) return;
  const p = (params ?? {}) as Record<string, unknown>;
  const ev = tabEvents(tabId);

  if (method === 'Page.javascriptDialogOpening') {
    const type = String(p.type);
    // alert and beforeunload never need a decision; accept them so they don't block the agent.
    if (type === 'alert' || type === 'beforeunload') {
      void chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept: true });
    } else {
      ev.dialog = { type, message: String(p.message), defaultPrompt: p.defaultPrompt as string };
    }
  } else if (method === 'Page.javascriptDialogClosed') {
    delete ev.dialog;
  } else if (method === 'Runtime.consoleAPICalled') {
    const args = (p.args as RemoteObject[] | undefined) ?? [];
    push(ev.console, {
      type: String(p.type),
      text: args.map(formatArg).join(' '),
      args,
    });
  } else if (method === 'Runtime.exceptionThrown') {
    const d = p.exceptionDetails as
      | {
          exceptionId?: number;
          text?: string;
          exception?: RemoteObject;
          lineNumber?: number;
          columnNumber?: number;
          url?: string;
        }
      | undefined;
    const entry: PageError = {
      text: d?.exception?.description ?? d?.text ?? 'Uncaught error',
      line: d?.lineNumber ?? null,
      column: d?.columnNumber ?? null,
      url: d?.url ?? null,
    };
    if (d?.exceptionId !== undefined) exceptionIds.set(entry, d.exceptionId);
    push(ev.errors, entry);
  } else if (method === 'Runtime.exceptionRevoked') {
    // A promise rejection that got a handler later is not uncaught after all (DevTools drops it
    // too). `eval` of a rejected promise causes this: the rejection is seen before bvl awaits it.
    const i = ev.errors.findIndex((e) => exceptionIds.get(e) === p.exceptionId);
    if (i >= 0) ev.errors.splice(i, 1);
  }
  for (const fn of listeners) fn(tabId, method, params);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  lastDetach.set(source.tabId, { reason, at: Date.now() });
  attached.delete(source.tabId);
  resumed.delete(source.tabId);
  rediscovered.delete(source.tabId);
  dropChildren(source.tabId);
  delete state.frames[source.tabId];
  events.delete(source.tabId);
  for (const fn of detachListeners) fn(source.tabId);
  if (reason === 'canceled_by_user') onUserDetach(source.tabId);
});
