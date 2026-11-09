// Thin wrapper over chrome.debugger: lazy attach, typed-ish send, and per-tab event buffers
// (JavaScript dialogs, console messages, page errors).

export interface Dialog {
  type: string;
  message: string;
  defaultPrompt?: string;
}

interface TabEvents {
  dialog?: Dialog;
  console: string[];
  errors: string[];
}

const attached = new Set<number>();
const events = new Map<number, TabEvents>();
const listeners = new Set<(tabId: number, method: string, params: unknown) => void>();
const MAX_BUFFER = 500;

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

function push(buf: string[], line: string): void {
  buf.push(line);
  if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - MAX_BUFFER);
}

export async function attach(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
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
  await Promise.all([
    chrome.debugger.sendCommand({ tabId }, 'Page.enable'),
    chrome.debugger.sendCommand({ tabId }, 'Runtime.enable'),
  ]);
}

export async function detach(tabId: number): Promise<void> {
  attached.delete(tabId);
  events.delete(tabId);
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
): Promise<T> {
  await attach(tabId);
  return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
}

/** Subscribe to CDP events from all tabs. Returns an unsubscribe function. */
export function onEvent(fn: (tabId: number, method: string, params: unknown) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

interface RemoteObject {
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
    push(ev.console, `[${String(p.type)}] ${args.map(formatArg).join(' ')}`);
  } else if (method === 'Runtime.exceptionThrown') {
    const d = p.exceptionDetails as { text?: string; exception?: RemoteObject } | undefined;
    push(ev.errors, d?.exception?.description ?? d?.text ?? 'Uncaught error');
  }
  for (const fn of listeners) fn(tabId, method, params);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  attached.delete(source.tabId);
  events.delete(source.tabId);
  if (reason === 'canceled_by_user') onUserDetach(source.tabId);
});
