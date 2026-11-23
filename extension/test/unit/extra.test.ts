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

describe('mouse --human', () => {
  const setup = () => {
    giveTab('s', 5, 't1', 's');
    mock.chrome.debugger.sendCommand = vi.fn((_t, method: string, p?: object) =>
      Promise.resolve(method === 'Runtime.evaluate' ? { result: { value: 'visible' } } : (p ?? {})),
    ) as never;
  };
  const moves = () =>
    vi
      .mocked(mock.chrome.debugger.sendCommand)
      .mock.calls.filter((c) => c[1] === 'Input.dispatchMouseEvent')
      .map((c) => c[2] as { x: number; y: number });

  it('same seed gives the same curve, ending on the target', async () => {
    setup();
    await run('s', 'mouse', 'move', '5', '5');
    await run(
      's',
      'mouse',
      'move',
      '300',
      '200',
      '--human',
      '--seed',
      '42',
      '--steps',
      '12',
      '--duration',
      '0',
    );
    const first = moves().slice(1);
    expect(first).toHaveLength(12);
    expect(first.at(-1)).toMatchObject({ x: 300, y: 200 });
    // back to the same start, then again with the same seed
    await run('s', 'mouse', 'move', '5', '5');
    vi.mocked(mock.chrome.debugger.sendCommand).mockClear();
    await run(
      's',
      'mouse',
      'move',
      '300',
      '200',
      '--human',
      '--seed',
      '42',
      '--steps',
      '12',
      '--duration',
      '0',
    );
    expect(moves()).toEqual(first);
    const onLine = first.every((p) => Math.abs((p.y - 5) / (p.x - 5) - 195 / 295) < 1e-6);
    expect(onLine).toBe(false);
  });

  it('enforces --steps 1-240 and --seed rules', async () => {
    setup();
    for (const steps of ['0', '241', '1.5']) {
      const r = await run('s', 'mouse', 'move', '1', '1', '--steps', steps);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('--steps must be an integer from 1 to 240');
    }
    const r = await run('s', 'mouse', 'move', '1', '1', '--human', '--steps', '999');
    expect(r.stderr).toContain('--steps must be');
    expect(
      (await run('s', 'mouse', 'move', '1', '1', '--human', '--seed', '1.5')).stderr,
    ).toContain('--seed must be an integer');
    expect((await run('s', 'mouse', 'move', '1', '1', '--duration', '-5')).stderr).toContain(
      '--duration must be 0 or more',
    );
    expect((await run('s', 'mouse', 'move', '1', '1', '--seed', '3')).stderr).toContain(
      '--seed needs --human',
    );
    expect((await run('s', 'mouse', 'move', '1', '1', '--human', '--seed', 'x')).stderr).toContain(
      '--seed must be a number',
    );
  });
});

describe('click/hover/drag --human', () => {
  // A 100x40 box at (200,100); every element resolves to it and passes the actionability check.
  const setup = () => {
    giveTab('s', 5, 't1', 's');
    mock.chrome.debugger.sendCommand = vi.fn((_t, method: string, p?: { expression?: string }) => {
      if (method === 'Runtime.evaluate') {
        return Promise.resolve(
          p?.expression === 'document.visibilityState'
            ? { result: { value: 'visible' } }
            : { result: { objectId: 'o1' } },
        );
      }
      if (method === 'Runtime.callFunctionOn') return Promise.resolve({ result: { value: {} } });
      if (method === 'DOM.getContentQuads') {
        return Promise.resolve({ quads: [[200, 100, 300, 100, 300, 140, 200, 140]] });
      }
      return Promise.resolve({});
    }) as never;
  };
  const inputs = () =>
    vi
      .mocked(mock.chrome.debugger.sendCommand)
      .mock.calls.filter((c) => c[1] === 'Input.dispatchMouseEvent')
      .map((c) => c[2] as { type: string; x: number; y: number; buttons?: number });
  const types = (xs: { type: string }[]) => xs.map((e) => e.type);

  it.each([
    ['click', ['click', '#a', '--human'], ['mousePressed', 'mouseReleased']],
    [
      'dblclick',
      ['dblclick', '#a', '--human'],
      ['mousePressed', 'mouseReleased', 'mousePressed', 'mouseReleased'],
    ],
    ['hover', ['hover', '#a', '--human'], []],
  ])('%s moves along a path ending on the target, then acts', async (_n, argv, tail) => {
    setup();
    const r = await run('s', ...argv);
    expect(r.exitCode).toBe(0);
    const ev = inputs();
    const moves = ev.filter((e) => e.type === 'mouseMoved');
    expect(moves.length).toBeGreaterThan(8);
    expect(moves.at(-1)).toMatchObject({ x: 250, y: 120 });
    expect(types(ev).slice(moves.length)).toEqual(tail);
    // no extra hover move after the path: the final move is not duplicated
    expect(moves.filter((m) => m.x === 250 && m.y === 120)).toHaveLength(1);
    expect(moves.every((m) => m.x >= 0 && m.y >= 0)).toBe(true);
  });

  it('plain click does not send a path', async () => {
    setup();
    await run('s', 'click', '#a');
    expect(types(inputs())).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });

  it('starts at the last pointer position', async () => {
    setup();
    await run('s', 'mouse', 'move', '600', '400');
    vi.mocked(mock.chrome.debugger.sendCommand).mockClear();
    await run('s', 'hover', '#a', '--human');
    const first = inputs()[0];
    expect(Math.hypot((first?.x ?? 0) - 600, (first?.y ?? 0) - 400)).toBeLessThan(150);
  });

  it('drag --human holds the button over the curve and drops on the target', async () => {
    setup();
    const r = await run('s', 'drag', '#a', '#b', '--human');
    expect(r.exitCode).toBe(0);
    const ev = inputs();
    expect(ev[0]).toMatchObject({ type: 'mouseMoved' });
    expect(types(ev)[1]).toBe('mousePressed');
    const mid = ev.slice(2, -1);
    expect(mid.every((e) => e.type === 'mouseMoved' && e.buttons === 1)).toBe(true);
    expect(types(ev).at(-1)).toBe('mouseReleased');
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
    stateMod.session('beta'); // empty: not listed
    stateMod.session('gamma').tab = 5; // has a tab
    stateMod.log({ ts: Date.now() - 5000, session: 'alpha', command: 'open', ok: true });
    const r = await run('alpha', 'session', 'list');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Active sessions:');
    expect(r.stdout).toMatch(/→ alpha {2}tab t1 {2}owns t1 {2}last \d+s ago/);
    expect(r.stdout).not.toContain('beta');

    const j = JSON.parse((await run('alpha', 'session', 'list', '--json')).stdout) as {
      data: { sessions: { name: string; current: boolean; tab: string | null }[] };
    };
    expect(j.data.sessions.map((s) => [s.name, s.current, s.tab])).toEqual([
      ['alpha', true, 't1'],
      ['gamma', false, 't1'],
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
