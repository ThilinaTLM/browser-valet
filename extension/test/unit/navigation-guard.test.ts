import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChromeMock, installChromeMock } from '../helpers/chrome-mock';

let mock: ChromeMock;
let guard: typeof import('../../src/background/navigation-guard');
let g: typeof import('../../src/background/guardrails');
let stateMod: typeof import('../../src/background/state');
let cdp: typeof import('../../src/background/cdp');

const sent = () =>
  (vi.mocked(mock.chrome.debugger.sendCommand).mock.calls as unknown[][]).map((c) => ({
    method: c[1] as string,
    params: c[2] as Record<string, unknown> | undefined,
  }));
const fireEvent = (tabId: number, method: string, params: unknown) => {
  (mock.events.debuggerOnEvent as unknown as { fire(...a: unknown[]): void }).fire(
    { tabId },
    method,
    params,
  );
};
const paused = async (tabId: number, url: string, requestId = 'r1', frameId?: string) => {
  vi.mocked(mock.chrome.debugger.sendCommand).mockClear();
  fireEvent(tabId, 'Fetch.requestPaused', {
    requestId,
    frameId,
    request: { url },
    resourceType: 'Document',
  });
  await mock.flush();
  await mock.flush();
  return sent()
    .map((s) => s.method)
    .filter((m) => m.startsWith('Fetch.'));
};

beforeEach(async () => {
  vi.resetModules();
  mock = installChromeMock();
  cdp = await import('../../src/background/cdp');
  stateMod = await import('../../src/background/state');
  g = await import('../../src/background/guardrails');
  guard = await import('../../src/background/navigation-guard');
  await stateMod.loadState();
  stateMod.state.tabs[5] = { tid: 't1', control: 'agent', owner: 's' };
  stateMod.state.tabs[6] = { tid: 't2', control: 'user' };
});

describe('refusedOn', () => {
  it('judges network and disk URLs only', async () => {
    await g.updateGuardrails({ allowedDomains: ['example.com'] });
    expect(guard.refusedOn(5, 'https://evil.test/')).toBe('user');
    expect(guard.refusedOn(5, 'https://example.com/')).toBeUndefined();
    expect(guard.refusedOn(5, 'file:///etc/passwd')).toBe('user');
    for (const u of [
      'about:blank',
      'data:text/html,x',
      'blob:https://evil.test/1',
      'chrome-error://chromewebdata/',
      'nonsense',
    ]) {
      expect(guard.refusedOn(5, u), u).toBeUndefined();
    }
  });
});

describe('Fetch interception', () => {
  it('enables Document-only patterns on an agent tab when a policy is active', async () => {
    await cdp.attach(5);
    await g.updateGuardrails({ allowedDomains: ['example.com'] });
    await guard.syncAll();
    const fetchEnable = sent().find((s) => s.method === 'Fetch.enable');
    expect(fetchEnable?.params).toEqual({
      patterns: [{ resourceType: 'Document', requestStage: 'Request' }],
    });
  });

  it('is not enabled without a policy, on shared tabs, or on unattached tabs; and turns off again', async () => {
    await cdp.attach(5);
    await cdp.attach(6);
    await guard.syncAll();
    expect(sent().some((s) => s.method === 'Fetch.enable')).toBe(false);
    await g.updateGuardrails({ allowedDomains: ['example.com'] });
    await guard.syncAll();
    const enabled = (vi.mocked(mock.chrome.debugger.sendCommand).mock.calls as unknown[][]).filter(
      (c) => c[1] === 'Fetch.enable',
    );
    expect(enabled.map((c) => (c[0] as { tabId: number }).tabId)).toEqual([5]); // not the shared tab
    await g.updateGuardrails({ allowedDomains: [] });
    await guard.syncAll();
    expect(sent().some((s) => s.method === 'Fetch.disable')).toBe(true);
  });

  it('enables on attach (lazy attach after the policy was set)', async () => {
    await g.updateGuardrails({ allowedDomains: ['example.com'] });
    await cdp.attach(5);
    await mock.flush();
    expect(sent().some((s) => s.method === 'Fetch.enable')).toBe(true);
  });

  it('fails a refused document request and continues an allowed one', async () => {
    await g.updateGuardrails({ allowedDomains: ['example.com'] });
    expect(await paused(5, 'https://evil.test/x')).toEqual(['Fetch.failRequest']);
    const fail = sent()[0];
    expect(fail?.params).toEqual({ requestId: 'r1', errorReason: 'BlockedByClient' });
    expect(await paused(5, 'https://www.example.com/ok', 'r2')).toEqual(['Fetch.continueRequest']);
  });

  it('blocks main-frame documents only; iframe documents continue', async () => {
    await g.updateGuardrails({ allowedDomains: ['example.com'] });
    const send = mock.chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>;
    send.mockImplementation(((_t: unknown, method: string): unknown =>
      Promise.resolve(
        method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'MAIN' } } } : {},
      )) as never);
    await cdp.attach(5); // learns the main frame id when Fetch is enabled
    await mock.flush();
    expect(await paused(5, 'https://evil.test/', 'r1', 'MAIN')).toEqual(['Fetch.failRequest']);
    expect(await paused(5, 'https://evil.test/pay', 'r2', 'CHILD')).toEqual([
      'Fetch.continueRequest',
    ]);
    // frameNavigated keeps the id current; an unknown main frame fails closed
    fireEvent(5, 'Page.frameNavigated', { frame: { id: 'MAIN2' } });
    expect(await paused(5, 'https://evil.test/', 'r3', 'MAIN2')).toEqual(['Fetch.failRequest']);
    fireEvent(5, 'Page.frameNavigated', { frame: { id: 'SUB', parentId: 'MAIN2' } });
    expect(await paused(5, 'https://evil.test/', 'r4', 'SUB')).toEqual(['Fetch.continueRequest']);
    expect(await paused(5, 'https://evil.test/', 'r5')).toEqual(['Fetch.failRequest']);
  });

  it('continues everything when the policy is off or the tab is shared (never hang a request)', async () => {
    expect(await paused(5, 'https://evil.test/')).toEqual(['Fetch.continueRequest']);
    await g.updateGuardrails({ allowedDomains: ['example.com'] });
    expect(await paused(6, 'https://evil.test/')).toEqual(['Fetch.continueRequest']);
    expect(await paused(99, 'https://evil.test/')).toEqual(['Fetch.continueRequest']);
  });

  it('reports a refused navigation once, as a notice for the next command', async () => {
    await g.updateGuardrails({ allowedDomains: ['example.com'] });
    await paused(5, 'https://evil.test:8443/x');
    expect(guard.hasBlocked(5)).toBe(true);
    const hosts = guard.takeBlocked(5);
    expect(hosts).toEqual(['evil.test:8443']);
    expect(guard.blockedMessage(hosts)).toContain('evil.test:8443');
    expect(guard.takeBlocked(5)).toEqual([]);
  });
});

describe('agent narrowing during a command', () => {
  it('applies the agent list to its session tab only while the command runs', async () => {
    await cdp.attach(5);
    stateMod.session('s').tab = 5;
    const ctx = {
      session: 's',
      agentAllowedDomains: ['a.test'],
    } as unknown as import('../../src/background/command').Ctx;
    const release = await guard.narrowFor(ctx);
    expect(sent().some((s) => s.method === 'Fetch.enable')).toBe(true);
    expect(await paused(5, 'https://b.test/')).toEqual(['Fetch.failRequest']);
    expect(await paused(5, 'https://a.test/', 'r2')).toEqual(['Fetch.continueRequest']);
    release();
    await mock.flush();
    expect(await paused(5, 'https://b.test/', 'r3')).toEqual(['Fetch.continueRequest']);
  });
});

describe('safety net', () => {
  it('sends an agent tab that committed a refused URL to about:blank', async () => {
    mock.chrome.tabs.update = vi.fn(() =>
      Promise.resolve({}),
    ) as unknown as typeof chrome.tabs.update;
    await g.updateGuardrails({ allowedDomains: ['example.com'] });
    (mock.events.tabsOnUpdated as unknown as { fire(...a: unknown[]): void }).fire(5, {
      url: 'https://evil.test/',
    });
    await mock.flush();
    await mock.flush();
    expect(mock.chrome.tabs.update).toHaveBeenCalledWith(5, { url: 'about:blank' });
    expect(guard.hasBlocked(5)).toBe(true);
    // shared tabs are the user's
    (mock.chrome.tabs.update as unknown as ReturnType<typeof vi.fn>).mockClear();
    (mock.events.tabsOnUpdated as unknown as { fire(...a: unknown[]): void }).fire(6, {
      url: 'https://evil.test/',
    });
    await mock.flush();
    expect(mock.chrome.tabs.update).not.toHaveBeenCalled();
  });
});
