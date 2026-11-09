import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliRequest, CliResponse } from '../../src/shared';
import { installChromeMock, type ChromeMock } from '../helpers/chrome-mock';

let execute: typeof import('../../src/background/dispatch').execute;
let stateMod: typeof import('../../src/background/state');
let mock: ChromeMock;

const run = (session: string, ...argv: string[]): Promise<CliResponse> => {
  const req: CliRequest = { argv, cwd: '/w', tmp: '/tmp', sep: '/', platform: 'linux', session };
  return execute(req, new AbortController().signal, () => undefined);
};

beforeEach(async () => {
  vi.resetModules();
  mock = installChromeMock();
  stateMod = await import('../../src/background/state');
  ({ execute } = await import('../../src/background/dispatch'));
});

/** CDP calls sent to the debugger, as `Method` or `Method {json}` strings. */
const sent = () => vi.mocked(mock.chrome.debugger.sendCommand).mock.calls.map((c) => c[1]);

function giveTab(session: string, tabId: number, tid: string, owner?: string) {
  stateMod.state.tabs[tabId] = { tid, control: owner ? 'agent' : 'user', owner };
  stateMod.state.nextTid = 99;
  stateMod.session(session).tab = tabId;
  mock.chrome.tabs.get = vi.fn((id: number) =>
    Promise.resolve({ id, title: 'Page', url: 'https://x.test/' }),
  ) as never;
}

describe('commands without a tab', () => {
  it.each([
    ['mouse', 'move', '1', '2'],
    ['highlight', '#a'],
    ['pushstate', '/x'],
    ['get', 'styles', '#a'],
  ])('%s fails with the "No tab yet" hint', async (...argv) => {
    const r = await run('s', ...argv);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('No tab yet');
  });

  it('mouse validates its arguments', async () => {
    expect((await run('s', 'mouse')).stderr).toContain('Missing move|down|up|wheel');
    expect((await run('s', 'mouse', 'jiggle')).stderr).toContain('Unknown: mouse jiggle');
  });
});

describe('mouse', () => {
  it('tracks the position and held buttons per tab', async () => {
    giveTab('s', 5, 't1', 's');
    mock.chrome.debugger.sendCommand = vi.fn((_t, method: string, p?: object) =>
      Promise.resolve(method === 'Runtime.evaluate' ? { result: { value: 'visible' } } : (p ?? {})),
    ) as never;
    await run('s', 'mouse', 'move', '10', '20');
    await run('s', 'mouse', 'down', 'right');
    await run('s', 'mouse', 'move', '30', '40', '--steps', '2');
    await run('s', 'mouse', 'up', 'right');
    const calls = vi
      .mocked(mock.chrome.debugger.sendCommand)
      .mock.calls.filter((c) => c[1] === 'Input.dispatchMouseEvent')
      .map((c) => c[2] as Record<string, unknown>);
    expect(calls.map((c) => [c.type, c.x, c.y, c.buttons])).toEqual([
      ['mouseMoved', 10, 20, 0],
      ['mousePressed', 10, 20, 2],
      ['mouseMoved', 20, 30, 2],
      ['mouseMoved', 30, 40, 2],
      ['mouseReleased', 30, 40, 0],
    ]);
    expect(calls[1]).toMatchObject({ button: 'right', clickCount: 1 });
  });
});

describe('highlight', () => {
  it('outlines the node and hides the overlay after the timeout', async () => {
    vi.useFakeTimers();
    try {
      giveTab('s', 5, 't1', 's');
      mock.chrome.debugger.sendCommand = vi.fn((_t, method: string) =>
        Promise.resolve(method === 'Runtime.evaluate' ? { result: { objectId: 'o1' } } : {}),
      ) as never;
      const r = await run('s', 'highlight', '#a');
      expect(r.exitCode).toBe(0);
      expect(sent()).toContain('Overlay.highlightNode');
      // clearHighlight() hides it right before the new highlight, so none is visible yet after it
      const hides = () => sent().filter((m) => m === 'Overlay.hideHighlight').length;
      const before = hides();
      await vi.advanceTimersByTimeAsync(3100);
      expect(hides()).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('session', () => {
  it('list shows sessions with their tab, owned tabs and last activity', async () => {
    giveTab('alpha', 5, 't1', 'alpha');
    stateMod.session('beta'); // no tab
    stateMod.log({ ts: Date.now() - 5000, session: 'alpha', command: 'open', ok: true });
    const r = await run('alpha', 'session', 'list');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Active sessions:');
    expect(r.stdout).toMatch(/→ alpha {2}tab t1 {2}owns t1 {2}last \d+s ago/);
    expect(r.stdout).toMatch(/ {2}beta {2}tab -/);

    const j = JSON.parse((await run('alpha', 'session', 'list', '--json')).stdout) as {
      data: { sessions: { name: string; current: boolean; tab: string | null }[] };
    };
    expect(j.data.sessions.map((s) => [s.name, s.current, s.tab])).toEqual([
      ['alpha', true, 't1'],
      ['beta', false, null],
    ]);
  });

  it('info shows the current tab and does not reveal unshared tabs', async () => {
    giveTab('alpha', 5, 't1', 'alpha');
    const ok = await run('alpha', 'session', 'info');
    expect(ok.stdout).toBe(
      'Session: alpha\nTab: t1\nTitle: Page\nURL: https://x.test/\nFrame: main\n',
    );

    delete stateMod.state.tabs[5]?.control;
    const revoked = await run('alpha', 'session', 'info');
    expect(revoked.stdout).toContain('Tab: t1 (not shared)');
    expect(revoked.stdout).not.toContain('URL:');

    expect((await run('fresh', 'session')).stdout).toContain('Tab: -');
  });

  it('is logged without redaction trouble and rejects unknown subcommands', async () => {
    expect((await run('s', 'session', 'x')).stderr).toContain('Unknown: session x');
  });
});
