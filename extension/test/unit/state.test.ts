import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { State } from '../../src/shared';
import { type ChromeMock, installChromeMock } from '../helpers/chrome-mock';

let mock: ChromeMock;
let s: typeof import('../../src/background/state');

beforeEach(async () => {
  vi.resetModules();
  mock = installChromeMock();
  mock.manifest.version = '2.0.0';
  s = await import('../../src/background/state');
});

const handedOff = (): State => ({
  nextTid: 7,
  tabs: { 11: { tid: 't6', control: 'user', label: 'docs' } },
  sessions: { default: { tab: 11, nextRef: 9 } },
  refs: { 11: { e1: { backendNodeId: 5, role: 'button', name: 'Go' } } },
  refDocs: { 11: 'L1' },
  approvals: [{ id: 'a1', tabId: 11, session: 'default', ts: 1 }],
  log: [],
  conn: { status: 'connected', paired: true, managed: true, port: 1 },
});

describe('loadState', () => {
  it('starts from defaults and generates a secret on first run', async () => {
    await s.loadState();
    expect(s.state.nextTid).toBe(1);
    expect(s.settings.secret).toMatch(/^[\w-]{43}$/);
    expect(s.settings).toMatchObject({ port: 47823, enabled: true });
    expect(mock.local.data).toMatchObject({ secret: s.settings.secret, paired: false });
  });

  it('spreads stored session state over the defaults (older state lacks new fields)', async () => {
    mock.session.data.state = { nextTid: 4, tabs: { 1: { tid: 't3' } } };
    await s.loadState();
    expect(s.state.nextTid).toBe(4);
    expect(s.state.approvals).toEqual([]);
    expect(s.state.refs).toEqual({});
  });

  it('drops stored approvals: their waiters died with the previous service worker', async () => {
    mock.session.data.state = {
      nextTid: 4,
      tabs: { 1: { tid: 't3' } },
      approvals: [{ id: 'a1', tabId: 1, session: 'default', ts: 1 }],
    };
    await s.loadState();
    expect(s.state.approvals).toEqual([]);
    expect(s.state.tabs[1]?.tid).toBe('t3');
  });

  it('prefers a stored secret and port', async () => {
    mock.local.data = { secret: 'abc', port: 5000, enabled: false, paired: true };
    await s.loadState();
    expect(s.settings).toEqual({ secret: 'abc', port: 5000, enabled: false });
    expect(s.state.conn.paired).toBe(true);
  });
});

describe('restoreHandoff (via loadState)', () => {
  it('restores handed-off state, drops approvals, resets conn and removes the handoff', async () => {
    mock.local.data = { handoff: { state: handedOff(), ts: Date.now() }, secret: 's' };
    await s.loadState();
    expect(s.state.nextTid).toBe(7);
    expect(s.state.tabs[11]).toEqual({ tid: 't6', control: 'user', label: 'docs' });
    expect(s.state.sessions.default).toEqual({ tab: 11, nextRef: 9 });
    expect(s.state.refDocs[11]).toBe('L1');
    expect(s.state.refs[11]?.e1?.name).toBe('Go');
    expect(s.state.approvals).toEqual([]);
    expect(s.state.conn.status).toBe('waiting');
    expect(mock.local.data.handoff).toBeUndefined();
    expect(s.handoffGraceUntil).toBeGreaterThan(Date.now());
  });

  it('merges handed-off state over the new defaults (fields the old version lacked)', async () => {
    const old: Partial<State> = { nextTid: 3, tabs: {} };
    mock.local.data = { handoff: { state: old, ts: Date.now() }, secret: 's' };
    await s.loadState();
    expect(s.state.nextTid).toBe(3);
    expect(s.state.log).toEqual([]);
    expect(s.state.sessions).toEqual({});
    expect(s.state.refDocs).toEqual({});
  });

  it('accepts a handoff from before stable refs (no refDocs, no session nextRef)', async () => {
    const old = {
      nextTid: 3,
      tabs: {},
      sessions: { default: { tab: 4 } },
      refs: { 4: { e1: { backendNodeId: 5, role: 'button', name: 'Go' } } },
    };
    mock.local.data = { handoff: { state: old, ts: Date.now() }, secret: 's' };
    await s.loadState();
    expect(s.state.refDocs).toEqual({});
    expect(s.session('default').nextRef).toBeUndefined(); // snapshot starts at e1 (+ max ref)
    expect(s.state.refs[4]?.e1?.name).toBe('Go');
  });

  it('ignores a stale handoff (older than 60 s) but still removes it', async () => {
    mock.local.data = { handoff: { state: handedOff(), ts: Date.now() - 61_000 }, secret: 's' };
    await s.loadState();
    expect(s.state.nextTid).toBe(1);
    expect(mock.local.data.handoff).toBeUndefined();
    expect(s.handoffGraceUntil).toBe(0);
  });

  it('ignores a handoff without state or timestamp', async () => {
    mock.local.data = { handoff: { state: handedOff() }, secret: 's' };
    await s.loadState();
    expect(s.state.nextTid).toBe(1);
  });

  it('clears updateTried once the new version is running', async () => {
    mock.local.data = { updateTried: { version: '2.0.0', ts: 1 }, secret: 's' };
    await s.loadState();
    expect(mock.local.data.updateTried).toBeUndefined();
    mock.local.data = { updateTried: { version: '3.0.0', ts: 1 }, secret: 's' };
    await s.loadState();
    expect(mock.local.data.updateTried).toBeDefined();
  });
});

describe('persistence and tab ids', () => {
  it('coalesces save() calls into one storage write', async () => {
    mock.session.set.mockClear();
    s.save();
    s.save();
    s.save();
    await mock.flush();
    expect(mock.session.set).toHaveBeenCalledTimes(1);
  });

  it('meta() hands out stable t<N> ids, forgetTab() cleans up', () => {
    expect(s.meta(10).tid).toBe('t1');
    expect(s.meta(20).tid).toBe('t2');
    expect(s.meta(10).tid).toBe('t1');
    s.session('default').tab = 10;
    s.state.refs[10] = {};
    s.state.refDocs[10] = 'L';
    s.state.approvals.push({ id: 'x', tabId: 10, session: 'default', ts: 0 });
    s.forgetTab(10);
    expect(s.state.tabs[10]).toBeUndefined();
    expect(s.state.refs[10]).toBeUndefined();
    expect(s.state.refDocs[10]).toBeUndefined();
    expect(s.session('default').tab).toBeUndefined();
    expect(s.state.approvals).toEqual([]);
    expect(s.meta(30).tid).toBe('t3'); // never reused
  });

  it('log() keeps newest first, max 50', () => {
    for (let i = 0; i < 55; i++) s.log({ ts: i, session: 's', command: `c${i}`, ok: true });
    expect(s.state.log).toHaveLength(50);
    expect(s.state.log[0]?.command).toBe('c54');
  });
});

describe('pairing', () => {
  it('pairing.json wins over stored settings and marks the extension managed', async () => {
    mock.local.data = { secret: 'local', port: 1111 };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ secret: 'file', port: 4444 }))),
    );
    await s.refreshPairing();
    expect(s.settings).toMatchObject({ secret: 'file', port: 4444 });
    expect(s.state.conn).toMatchObject({ managed: true, port: 4444 });
  });

  it.each([
    ['empty secret', { secret: '', port: 4444 }],
    ['bad port', { secret: 'x', port: 70000 }],
    ['non-integer port', { secret: 'x', port: 1.5 }],
  ])('ignores an invalid pairing.json (%s)', async (_n, body) => {
    mock.local.data = { secret: 'local', port: 1111 };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(body))),
    );
    await s.refreshPairing();
    expect(s.settings).toMatchObject({ secret: 'local', port: 1111 });
    expect(s.state.conn.managed).toBe(false);
  });

  it('a managed extension only accepts the enabled setting', async () => {
    s.state.conn.managed = true;
    await s.updateSettings({ secret: 'evil', port: 9, enabled: false });
    expect(s.settings.secret).toBe('');
    expect(s.settings.enabled).toBe(false);
  });
});
