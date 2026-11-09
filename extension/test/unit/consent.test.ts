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
