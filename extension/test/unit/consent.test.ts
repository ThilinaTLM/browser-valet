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

describe('revoke', () => {
  it('publishes the revoke only after the debugger is released, and bars the tab meanwhile', async () => {
    let release: () => void = () => undefined;
    const detach = vi.fn(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    (mock.chrome.debugger as unknown as { detach: unknown }).detach = detach;
    await tabs.grant(5, 'user');
    const cdp = await import('../../src/background/cdp');
    const done = tabs.revoke(5);
    await mock.flush();
    expect(detach).toHaveBeenCalled();
    // still listed (the popup shows it, a test or user cannot close it "after" the revoke yet)
    expect(stateMod.state.tabs[5]?.control).toBe('user');
    await expect(cdp.attach(5)).rejects.toThrow(/revoked/);
    release();
    await done;
    expect(stateMod.state.tabs[5]?.control).toBeUndefined();
    expect(detach).toHaveBeenCalledTimes(1);
  });
});
