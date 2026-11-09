// A small in-memory `chrome.*` mock for unit tests of the background worker.
//
// Usage (the worker modules touch `chrome` at import time, so install first, import after):
//
//   const mock = installChromeMock();
//   const { state, loadState } = await import('../../src/background/state');
//
// Call `vi.resetModules()` in `beforeEach` to get fresh module state, and `installChromeMock()`
// again for fresh storage. Extend `chrome` in a test with `Object.assign(mock.chrome.tabs, {...})`
// or `vi.spyOn`.

import { vi } from 'vitest';

type Listener = (...args: never[]) => unknown;

/** An event like `chrome.tabs.onRemoved`; `fire` invokes the registered listeners. */
export class MockEvent<F extends Listener = Listener> {
  readonly listeners = new Set<F>();
  addListener = (fn: F): void => {
    this.listeners.add(fn);
  };
  removeListener = (fn: F): void => {
    this.listeners.delete(fn);
  };
  hasListener = (fn: F): boolean => this.listeners.has(fn);
  fire(...args: Parameters<F>): void {
    for (const fn of [...this.listeners]) fn(...args);
  }
}

/** `chrome.storage.<area>` backed by a plain object; values are structured-cloned like Chrome. */
export class MockStorageArea {
  data: Record<string, unknown> = {};

  get = vi.fn((keys?: string | string[] | Record<string, unknown> | null) => {
    if (keys === undefined || keys === null) return Promise.resolve(structuredClone(this.data));
    const out: Record<string, unknown> = {};
    if (typeof keys === 'string' || Array.isArray(keys)) {
      for (const k of typeof keys === 'string' ? [keys] : keys) {
        if (k in this.data) out[k] = structuredClone(this.data[k]);
      }
    } else {
      for (const [k, dflt] of Object.entries(keys)) {
        out[k] = structuredClone(k in this.data ? this.data[k] : dflt);
      }
    }
    return Promise.resolve(out);
  });

  set = vi.fn((items: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(items)) this.data[k] = structuredClone(v);
    return Promise.resolve();
  });

  remove = vi.fn((keys: string | string[]) => {
    for (const k of typeof keys === 'string' ? [keys] : keys) delete this.data[k];
    return Promise.resolve();
  });

  clear = vi.fn(() => {
    this.data = {};
    return Promise.resolve();
  });
}

export interface ChromeMock {
  /** The object installed as `globalThis.chrome`. */
  chrome: typeof chrome;
  session: MockStorageArea;
  local: MockStorageArea;
  /** Manifest returned by `chrome.runtime.getManifest()`. */
  manifest: { version: string };
  events: {
    tabsOnRemoved: MockEvent;
    tabsOnCreated: MockEvent;
    tabsOnUpdated: MockEvent;
    debuggerOnEvent: MockEvent;
    debuggerOnDetach: MockEvent;
  };
  /** Let queued microtasks (such as the coalesced `save()`) run. */
  flush(): Promise<void>;
}

export function installChromeMock(): ChromeMock {
  const session = new MockStorageArea();
  const local = new MockStorageArea();
  const manifest = { version: '0.0.0-test' };
  const events = {
    tabsOnRemoved: new MockEvent(),
    tabsOnCreated: new MockEvent(),
    tabsOnUpdated: new MockEvent(),
    debuggerOnEvent: new MockEvent(),
    debuggerOnDetach: new MockEvent(),
  };
  const noop = () => Promise.resolve();
  const mock = {
    storage: { session, local },
    runtime: {
      getManifest: () => manifest,
      getURL: (p: string) => `chrome-extension://test/${p}`,
      getPlatformInfo: () => Promise.resolve({ os: 'linux' }),
      reload: vi.fn(),
      onStartup: new MockEvent(),
      onInstalled: new MockEvent(),
      onMessage: new MockEvent(),
    },
    tabs: {
      onRemoved: events.tabsOnRemoved,
      onCreated: events.tabsOnCreated,
      onUpdated: events.tabsOnUpdated,
      get: vi.fn((id: number) => Promise.reject(new Error(`No tab with id: ${id}`))),
      query: vi.fn(() => Promise.resolve([])),
      create: vi.fn(),
      remove: vi.fn(noop),
      reload: vi.fn(noop),
    },
    windows: { update: vi.fn(noop), create: vi.fn(noop) },
    action: {
      openPopup: vi.fn(noop),
      setBadgeText: vi.fn(noop),
      setBadgeBackgroundColor: vi.fn(noop),
    },
    alarms: { create: vi.fn(noop), onAlarm: new MockEvent() },
    debugger: {
      onEvent: events.debuggerOnEvent,
      onDetach: events.debuggerOnDetach,
      attach: vi.fn(noop),
      detach: vi.fn(noop),
      sendCommand: vi.fn(() => Promise.resolve({})),
    },
  };
  vi.stubGlobal('chrome', mock);
  return {
    chrome: mock as unknown as typeof chrome,
    session,
    local,
    manifest,
    events,
    flush: () => new Promise((r) => setTimeout(r, 0)),
  };
}
