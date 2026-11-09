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
const detachListeners = new Set<(tabId: number) => void>();

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

export async function attach(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  let alreadyAttached = false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    const msg = (e as Error).message;
    if (/cannot access|cannot attach/i.test(msg)) {
      throw new Error(
        'Chrome does not allow extensions to control this page (e.g. chrome:// pages)',
        {
          cause: e,
        },
      );
    }
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
        'The iframe is gone (it navigated or was removed). Run `bctl snapshot` again.',
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
          text?: string;
          exception?: RemoteObject;
          lineNumber?: number;
          columnNumber?: number;
          url?: string;
        }
      | undefined;
    push(ev.errors, {
      text: d?.exception?.description ?? d?.text ?? 'Uncaught error',
      line: d?.lineNumber ?? null,
      column: d?.columnNumber ?? null,
      url: d?.url ?? null,
    });
  }
  for (const fn of listeners) fn(tabId, method, params);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  attached.delete(source.tabId);
  resumed.delete(source.tabId);
  rediscovered.delete(source.tabId);
  dropChildren(source.tabId);
  delete state.frames[source.tabId];
  events.delete(source.tabId);
  for (const fn of detachListeners) fn(source.tabId);
  if (reason === 'canceled_by_user') onUserDetach(source.tabId);
});
