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
