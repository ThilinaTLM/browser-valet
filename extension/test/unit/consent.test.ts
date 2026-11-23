import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChromeMock, installChromeMock } from '../helpers/chrome-mock';

let mock: ChromeMock;
let stateMod: typeof import('../../src/background/state');
let tabs: typeof import('../../src/background/tabs');

beforeEach(async () => {
  vi.resetModules();
  mock = installChromeMock();
  mock.chrome.tabs.get = vi.fn(() =>
    Promise.resolve({ id: 5, windowId: 1, title: 'Page' }),
  ) as unknown as typeof chrome.tabs.get;
  stateMod = await import('../../src/background/state');
  tabs = await import('../../src/background/tabs');
  await stateMod.loadState();
  stateMod.meta(5);
});

const ask = () => tabs.requestControl(5, 'default', new AbortController().signal, () => undefined);

describe('requestControl', () => {
  it('grants on allow and clears the approval', async () => {
    const p = ask();
    await mock.flush();
    const id = stateMod.state.approvals[0]?.id ?? '';
    expect(id).not.toBe('');
    tabs.decide(id, true);
    await p;
    expect(stateMod.state.tabs[5]?.control).toBe('user');
    expect(stateMod.state.approvals).toEqual([]);
  });

  it('rejects with a clear error when the tab is closed while the approval is pending', async () => {
    const p = ask();
    const result = p.then(
      () => 'resolved',
      (e: unknown) => (e as Error).message,
    );
    await mock.flush();
    expect(stateMod.state.approvals).toHaveLength(1);
    mock.events.tabsOnRemoved.fire(5);
    expect(await result).toMatch(/tab was closed while waiting/);
    expect(stateMod.state.approvals).toEqual([]);
    expect(stateMod.state.tabs[5]).toBeUndefined();
  });

  it('leaves approvals for other tabs alone when a tab closes', async () => {
    const p = ask();
    await mock.flush();
    mock.events.tabsOnRemoved.fire(99);
    expect(stateMod.state.approvals).toHaveLength(1);
    tabs.decide(stateMod.state.approvals[0]?.id ?? '', false);
    await expect(p).rejects.toThrow(/denied/);
  });
});

describe('focusTab', () => {
  it('activates the tab and focuses its window', async () => {
    const update = vi.fn(() => Promise.resolve({}));
    mock.chrome.tabs.update = update as unknown as typeof chrome.tabs.update;
    expect(await tabs.focusTab(5)).toBe(true);
    expect(update).toHaveBeenCalledWith(5, { active: true });
    expect(mock.chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
  });

  it('flags the window when focusing is refused', async () => {
    mock.chrome.tabs.update = vi.fn(() => Promise.reject(new Error('no'))).mockName('update');
    expect(await tabs.focusTab(5)).toBe(false);
    expect(mock.chrome.windows.update).toHaveBeenCalledWith(1, { drawAttention: true });
  });
});

describe('revoke (fail closed)', () => {
  interface Stored {
    state?: { tabs: Record<number, { control?: string }> };
  }
  const hang = () => {
    let release: () => void = () => undefined;
    const detach = vi.fn(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    (mock.chrome.debugger as unknown as { detach: unknown }).detach = detach;
    return {
      detach,
      release: () => {
        release();
      },
    };
  };
  const persisted = (id: number) => (mock.session.data as Stored).state?.tabs[id]?.control;

  it('drops the grant and saves it before the debugger is released', async () => {
    const h = hang();
    await tabs.grant(5, 'user');
    const done = tabs.revoke(5);
    await mock.flush();
    expect(h.detach).toHaveBeenCalled();
    expect(tabs.isControlled(5)).toBe(false);
    expect(persisted(5)).toBeUndefined(); // a handoff or restart now keeps it revoked
    h.release();
    await done;
  });

  it('a restart in the middle of a revoke restores the tab uncontrolled', async () => {
    hang();
    await tabs.grant(5, 'user');
    void tabs.revoke(5);
    await mock.flush();
    vi.resetModules();
    const again = await import('../../src/background/state');
    await again.loadState();
    expect(again.state.tabs[5]?.control).toBeUndefined();
  });

  it('a throwing detach listener does not keep the grant', async () => {
    const cdp = await import('../../src/background/cdp');
    cdp.onDetached(() => {
      throw new Error('listener broke');
    });
    await tabs.grant(5, 'user');
    await tabs.revoke(5);
    expect(tabs.isControlled(5)).toBe(false);
    expect(persisted(5)).toBeUndefined();
  });

  it('waits at most the detach timeout for a hanging detach', async () => {
    vi.useFakeTimers();
    try {
      hang();
      await tabs.grant(5, 'user');
      let finished = false;
      void tabs.revoke(5).then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(2000);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1500);
      expect(finished).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('overlapping revokes share one detach and both resolve', async () => {
    const h = hang();
    await tabs.grant(5, 'user');
    const a = tabs.revoke(5);
    const b = tabs.revoke(5);
    await mock.flush();
    expect(h.detach).toHaveBeenCalledTimes(1);
    h.release();
    await Promise.all([a, b]);
    expect(h.detach).toHaveBeenCalledTimes(1);
  });

  it('switching off strips every grant at once and is not held up by a hanging detach', async () => {
    vi.useFakeTimers();
    try {
      stateMod.meta(6);
      hang();
      await tabs.grant(5, 'user');
      await tabs.grant(6, 'agent');
      const sw = await import('../../src/background/switch');
      let finished = false;
      void sw.revokeAll().then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(tabs.isControlled(5) || tabs.isControlled(6)).toBe(false);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(3500);
      expect(finished).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cdp.attach refuses a tab that is not controlled, and says how to ask again', async () => {
    const cdp = await import('../../src/background/cdp');
    await tabs.grant(5, 'user');
    await tabs.revoke(5);
    const err = await cdp.attach(5).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'revoked' });
    expect((err as Error).message).toMatch(/bvl tab t\d+/);
    expect(mock.chrome.debugger.attach).not.toHaveBeenCalled();
  });

  it('releaseUncontrolled detaches sessions left over from a cut-short revoke', async () => {
    const cdp = await import('../../src/background/cdp');
    await tabs.grant(5, 'user');
    stateMod.meta(6);
    Object.assign(mock.chrome.debugger, {
      getTargets: vi.fn(() =>
        Promise.resolve([
          { tabId: 5, attached: true },
          { tabId: 6, attached: true },
          { tabId: 7, attached: false },
        ]),
      ),
    });
    await cdp.releaseUncontrolled();
    const calls = vi.mocked(mock.chrome.debugger.detach).mock.calls as unknown as {
      tabId: number;
    }[][];
    expect(calls.map((c) => c[0]?.tabId)).toEqual([6]);
  });
});
