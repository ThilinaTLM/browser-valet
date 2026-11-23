import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChromeMock, installChromeMock } from '../helpers/chrome-mock';

let mock: ChromeMock;
let refs: typeof import('../../src/background/refs');
let s: typeof import('../../src/background/state');

beforeEach(async () => {
  vi.resetModules();
  mock = installChromeMock();
  s = await import('../../src/background/state');
  refs = await import('../../src/background/refs');
  s.meta(5).control = 'agent'; // attach only serves controlled tabs
  s.state.refs[5] = { e1: { backendNodeId: 1, role: 'button', name: 'Go' } };
});

const loader = (id: string) => {
  const reply = (_t: unknown, method: string) =>
    Promise.resolve(
      method === 'Page.getFrameTree' ? { frameTree: { frame: { loaderId: id } } } : {},
    );
  const send = mock.chrome.debugger.sendCommand as unknown as {
    mockImplementation(f: typeof reply): void;
  };
  send.mockImplementation(reply);
};

describe('syncDocument', () => {
  it('adopts the document of refs without a recorded one, clearing them', async () => {
    loader('L1');
    expect(await refs.syncDocument(5)).toBe('L1');
    expect(s.state.refs[5]).toBeUndefined();
    expect(s.state.refDocs[5]).toBe('L1');
  });

  it('keeps refs while the loader id is unchanged and clears them when it changes', async () => {
    loader('L1');
    await refs.syncDocument(5);
    s.state.refs[5] = { e2: { backendNodeId: 2, role: 'link', name: 'X' } };
    await refs.syncDocument(5);
    expect(s.state.refs[5]).toHaveProperty('e2');
    loader('L2');
    await refs.syncDocument(5);
    expect(s.state.refs[5]).toBeUndefined();
  });

  it('leaves refs alone when the frame tree is unavailable', async () => {
    vi.mocked(mock.chrome.debugger.sendCommand).mockRejectedValue(new Error('gone'));
    expect(await refs.syncDocument(5)).toBeUndefined();
    expect(s.state.refs[5]).toBeDefined();
  });
});

describe('Page.frameNavigated', () => {
  const nav = (frame: object) => {
    for (const fn of mock.events.debuggerOnEvent.listeners as Set<(...a: unknown[]) => void>)
      fn({ tabId: 5 }, 'Page.frameNavigated', { frame });
  };

  it('clears the refs on a main-frame navigation but not on a subframe', () => {
    nav({ parentId: 'main', loaderId: 'sub' });
    expect(s.state.refs[5]).toBeDefined();
    nav({ loaderId: 'L9' });
    expect(s.state.refs[5]).toBeUndefined();
    expect(s.state.refDocs[5]).toBe('L9');
  });
});

describe('refFate and missing refs', () => {
  it('tells previous-page, removed and never-issued refs apart', () => {
    s.state.sessions.a = { nextRef: 13 };
    s.state.sessions.b = { nextRef: 4 };
    refs.clearRefs(5, 'L2'); // a new document starts: refs below 13 belong to earlier ones
    expect(refs.refFate(5, 'e12')).toBe('previous_page');
    s.state.refs[5] = { e13: { backendNodeId: 1, role: 'link', name: 'x' } };
    s.state.sessions.a = { nextRef: 15 };
    expect(refs.refFate(5, 'e14')).toBe('removed');
    expect(refs.refFate(5, 'e15')).toBe('unknown');
    expect(refs.refFate(5, 'e999')).toBe('unknown');
  });

  it('resolve reports stale_ref for a ref of an earlier page, unknown_ref for an unissued one', async () => {
    loader('L1');
    s.state.sessions.a = { nextRef: 13 };
    const dom = await import('../../src/background/dom');
    await refs.syncDocument(5);
    await expect(dom.resolve(5, '@e12')).rejects.toMatchObject({
      code: 'stale_ref',
      message: expect.stringContaining('from a previous page') as string,
    });
    await expect(dom.resolve(5, '@e40')).rejects.toMatchObject({ code: 'unknown_ref' });
  });
});
