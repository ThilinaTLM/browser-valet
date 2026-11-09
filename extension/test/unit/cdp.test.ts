import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChromeMock, installChromeMock } from '../helpers/chrome-mock';

let mock: ChromeMock;
let cdp: typeof import('../../src/background/cdp');
const ALREADY = new Error('Another debugger is already attached to the tab with id: 7.');

beforeEach(async () => {
  vi.resetModules();
  mock = installChromeMock();
  cdp = await import('../../src/background/cdp');
});

describe('attach', () => {
  it('enables the domains after a normal attach', async () => {
    await cdp.attach(7);
    expect(cdp.isAttached(7)).toBe(true);
    const calls = vi.mocked(mock.chrome.debugger.sendCommand).mock.calls as unknown[][];
    expect(calls.map((c) => c[1])).toEqual(['Page.enable', 'Runtime.enable']);
  });

  it('survives our own attachment from before a service-worker restart (probe succeeds)', async () => {
    vi.mocked(mock.chrome.debugger.attach).mockRejectedValueOnce(ALREADY);
    await cdp.attach(7);
    expect(cdp.isAttached(7)).toBe(true);
  });

  it('reports a clear error when another debugger holds the tab (probe fails)', async () => {
    vi.mocked(mock.chrome.debugger.attach).mockRejectedValueOnce(ALREADY);
    vi.mocked(mock.chrome.debugger.sendCommand).mockRejectedValueOnce(
      new Error('Debugger is not attached to the tab with id: 7.'),
    );
    await expect(cdp.attach(7)).rejects.toThrow(/Close DevTools on this tab/);
    expect(cdp.isAttached(7)).toBe(false);
  });

  it('keeps the friendly message for pages Chrome does not allow', async () => {
    vi.mocked(mock.chrome.debugger.attach).mockRejectedValueOnce(
      new Error('Cannot access a chrome:// URL'),
    );
    await expect(cdp.attach(7)).rejects.toThrow(/does not allow extensions/);
  });
});

describe('console and error buffers', () => {
  it('store entries shaped like agent-browser (type/text/args, text/line/column/url)', () => {
    const fire = (method: string, params: unknown) => {
      (mock.events.debuggerOnEvent as unknown as { fire(...a: unknown[]): void }).fire(
        { tabId: 7 },
        method,
        params,
      );
    };
    fire('Runtime.consoleAPICalled', {
      type: 'warning',
      args: [
        { type: 'string', value: 'hi' },
        { type: 'number', value: 1 },
      ],
    });
    fire('Runtime.exceptionThrown', {
      exceptionDetails: {
        text: 'Uncaught',
        exception: { type: 'object', description: 'Error: boom' },
        lineNumber: 3,
        columnNumber: 9,
        url: 'http://x/y.js',
      },
    });
    fire('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught' } });
    const ev = cdp.tabEvents(7);
    expect(ev.console).toEqual([
      {
        type: 'warning',
        text: 'hi 1',
        args: [
          { type: 'string', value: 'hi' },
          { type: 'number', value: 1 },
        ],
      },
    ]);
    expect(ev.errors[0]).toEqual({
      text: 'Error: boom',
      line: 3,
      column: 9,
      url: 'http://x/y.js',
    });
    expect(ev.errors[1]).toEqual({ text: 'Uncaught', line: null, column: null, url: null });
  });
});
