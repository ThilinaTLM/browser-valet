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
    expect(calls.map((c) => c[1])).toEqual([
      'Page.enable',
      'Runtime.enable',
      'Target.setAutoAttach',
    ]);
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

// The mock's listeners are typed `never`-argument; tests fire them with loose arguments.
const fire = (ev: { fire: unknown }, ...args: unknown[]) => {
  (ev.fire as (...a: unknown[]) => void)(...args);
};

describe('child sessions (out-of-process iframes)', () => {
  const attachedEvent = (type: string, sessionId: string, targetId: string, source = {}) => {
    fire(mock.events.debuggerOnEvent, { tabId: 7, ...source }, 'Target.attachedToTarget', {
      sessionId,
      targetInfo: { type, targetId, url: `http://x/${targetId}` },
      waitingForDebugger: false,
    });
  };
  const calls = () =>
    vi.mocked(mock.chrome.debugger.sendCommand).mock.calls as unknown as [
      { tabId: number; sessionId?: string },
      string,
      unknown,
    ][];

  it('turns on flat auto-attach for iframes when attaching', async () => {
    await cdp.attach(7);
    const call = calls().find((c) => c[1] === 'Target.setAutoAttach');
    expect(call?.[0]).toEqual({ tabId: 7 });
    expect(call?.[2]).toMatchObject({
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: false,
    });
  });

  it('records iframe targets only and detaches the others', async () => {
    const { state } = await import('../../src/background/state');
    await cdp.attach(7);
    attachedEvent('iframe', 'S1', 'F1');
    attachedEvent('service_worker', 'S2', 'W1');
    attachedEvent('worker', 'S3', 'W2');
    expect(cdp.childSessions(7)).toEqual([{ sessionId: 'S1', targetId: 'F1', url: 'http://x/F1' }]);
    expect(state.childSessions[7]).toHaveLength(1);
    const detached = calls().filter((c) => c[1] === 'Target.detachFromTarget');
    expect(detached.map((c) => (c[2] as { sessionId: string }).sessionId)).toEqual(['S2', 'S3']);
  });

  it('enables auto-attach inside the child (nested out-of-process iframes) and records the parent', async () => {
    await cdp.attach(7);
    attachedEvent('iframe', 'S1', 'F1');
    attachedEvent('iframe', 'S2', 'F2', { sessionId: 'S1' });
    expect(cdp.childSession(7, 'S2')).toMatchObject({ parent: 'S1', targetId: 'F2' });
    const nested = calls().find((c) => c[0].sessionId === 'S1' && c[1] === 'Target.setAutoAttach');
    expect(nested).toBeDefined();
  });

  it('forgets a child when Chrome detaches it', async () => {
    await cdp.attach(7);
    attachedEvent('iframe', 'S1', 'F1');
    fire(mock.events.debuggerOnEvent, { tabId: 7 }, 'Target.detachedFromTarget', {
      sessionId: 'S1',
    });
    expect(cdp.childSessions(7)).toEqual([]);
  });

  it('send(…, sessionId) addresses the child session', async () => {
    await cdp.attach(7);
    await cdp.send(7, 'Runtime.evaluate', { expression: '1' }, 'S1');
    expect(calls().at(-1)?.[0]).toEqual({ tabId: 7, sessionId: 'S1' });
  });

  it('a dead session is forgotten and reported as a gone iframe, not as an attach conflict', async () => {
    await cdp.attach(7);
    attachedEvent('iframe', 'S1', 'F1');
    vi.mocked(mock.chrome.debugger.sendCommand).mockRejectedValueOnce(
      new Error('{"code":-32001,"message":"Session with given id not found."}'),
    );
    const err = await cdp.send(7, 'Runtime.evaluate', {}, 'S1').catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/iframe is gone/);
    expect((err as Error).message).not.toMatch(/Another debugger/);
    expect(cdp.childSessions(7)).toEqual([]);
  });

  it('events from child sessions do not leak into the tab buffers', async () => {
    await cdp.attach(7);
    fire(mock.events.debuggerOnEvent, { tabId: 7, sessionId: 'S1' }, 'Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: 'from child' }],
    });
    expect(cdp.tabEvents(7).console).toEqual([]);
  });

  it('drops the children and the frame scope when the debugger detaches', async () => {
    const { state } = await import('../../src/background/state');
    await cdp.attach(7);
    attachedEvent('iframe', 'S1', 'F1');
    state.frames[7] = { frameId: 'F1', name: 'f' };
    fire(mock.events.debuggerOnDetach, { tabId: 7 }, 'target_closed');
    expect(cdp.childSessions(7)).toEqual([]);
    expect(state.frames[7]).toBeUndefined();
    attachedEvent('iframe', 'S1', 'F1');
    await cdp.detach(7);
    expect(cdp.childSessions(7)).toEqual([]);
  });

  it('keeps the known children when resuming our attachment after a restart', async () => {
    const { state } = await import('../../src/background/state');
    state.childSessions[7] = [{ sessionId: 'S1', targetId: 'F1', url: '' }];
    vi.mocked(mock.chrome.debugger.attach).mockRejectedValueOnce(ALREADY);
    await cdp.attach(7);
    expect(cdp.childSessions(7)).toHaveLength(1);
  });

  it('a fresh attachment forgets stale children', async () => {
    const { state } = await import('../../src/background/state');
    state.childSessions[7] = [{ sessionId: 'S1', targetId: 'F1', url: '' }];
    await cdp.attach(7);
    expect(cdp.childSessions(7)).toEqual([]);
  });

  it('re-attaches once to rediscover children after a restart', async () => {
    vi.mocked(mock.chrome.debugger.attach).mockRejectedValueOnce(ALREADY);
    await cdp.attach(7);
    // the re-attach makes Chrome report the iframe again
    vi.mocked(mock.chrome.debugger.attach).mockImplementationOnce(() => {
      setTimeout(() => {
        attachedEvent('iframe', 'S9', 'F1');
      }, 10);
    });
    const hit = await cdp.sessionForFrame(7, 'F1', 200);
    expect(hit?.sessionId).toBe('S9');
    expect(mock.chrome.debugger.detach).toHaveBeenCalledTimes(1);
    // not again for another missing frame
    expect(await cdp.sessionForFrame(7, 'nope', 100)).toBeUndefined();
    expect(mock.chrome.debugger.detach).toHaveBeenCalledTimes(1);
  });
});
