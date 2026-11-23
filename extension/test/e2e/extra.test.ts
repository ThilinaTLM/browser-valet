// Small parity commands: mouse, highlight, get styles, XPath, pushstate, session.

import { describe, expect, it } from 'vitest';
import { humanPath } from '../../src/background/human-path';
import { bvl, bvlJson, bvlWith, fixture, useBrowser } from './harness';

useBrowser();

describe('mouse', () => {
  it('move, down, up and wheel reach the page with position and buttons', async () => {
    expect((await bvl('open', fixture('/mouse.html'))).code).toBe(0);
    const mv = await bvlJson('mouse', 'move', '100', '200');
    expect(mv).toMatchObject({ success: true, data: { moved: true, x: 100, y: 200 } });
    expect((await bvl('mouse', 'down')).stdout).toContain('✓ Done');
    expect((await bvl('mouse', 'move', '140', '200', '--steps', '4')).code).toBe(0);
    expect((await bvl('mouse', 'up')).code).toBe(0);
    expect((await bvl('mouse', 'down', 'right')).code).toBe(0);
    expect((await bvl('mouse', 'up', 'right')).code).toBe(0);
    expect((await bvl('mouse', 'wheel', '120', '5')).code).toBe(0);

    const ev = (await bvl('eval', 'window.events.join("|")')).stdout;
    expect(ev).toContain('mousemove 100,200 b0 bs0');
    expect(ev).toContain('mousedown 100,200 b0 bs1');
    // moves while the button is held report it (hidden tabs may coalesce the intermediate ones)
    expect(ev).toContain('mousemove 140,200');
    expect(ev).toContain('mouseup 140,200 b0 bs0');
    expect(ev).toContain('mousedown 140,200 b2 bs2');
  });

  it('--duration spreads a move over several events', async () => {
    await bvl('eval', 'window.events.length = 0');
    const t = Date.now();
    expect((await bvl('mouse', 'move', '10', '10', '--duration', '300', '--steps', '5')).code).toBe(
      0,
    );
    expect(Date.now() - t).toBeGreaterThanOrEqual(240);
    const n = (await bvl('eval', 'window.events.filter(e=>e.startsWith("mousemove")).length'))
      .stdout;
    // Hidden agent tabs coalesce moves to one per frame, so only a lower bound is stable.
    expect(Number(n.trim())).toBeGreaterThanOrEqual(1);
  });

  it('wheel on a hidden agent tab scrolls the page by script', async () => {
    await bvl('open', fixture('/mouse.html'));
    await bvl('mouse', 'move', '50', '50');
    expect((await bvl('mouse', 'wheel', '300')).code).toBe(0);
    expect(Number((await bvl('eval', 'window.scrollY')).stdout.trim())).toBe(300);
  });

  it('rejects bad input', async () => {
    expect((await bvl('mouse', 'move', '1')).stderr).toContain('Missing y');
    expect((await bvl('mouse', 'down', 'nope')).stderr).toContain('left, right or middle');
    expect((await bvl('mouse', 'spin')).stderr).toContain('Unknown: mouse spin');
  });
});

describe('highlight', () => {
  it('highlights an element, errors on a missing one', async () => {
    await bvl('open', fixture('/mouse.html'));
    expect(await bvlJson('highlight', '#target')).toMatchObject({
      success: true,
      data: { highlighted: '#target' },
    });
    const bad = await bvl('highlight', '#nosuch');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('Element not found');
  });
});

describe('get styles', () => {
  it('prints a curated set by default, named props, or everything', async () => {
    await bvl('open', fixture('/styled.html'));
    const def = (await bvl('get', 'styles', '#box')).stdout;
    expect(def).toContain('color: rgb(255, 0, 0)');
    expect(def).toContain('font-size: 20px');
    expect(def).toContain('background-color: rgb(0, 0, 255)');
    expect(def).toContain('cursor: pointer');
    expect(def.split('\n').filter(Boolean).length).toBeLessThan(40);

    const named = await bvl('get', 'styles', '#box', 'width', 'color');
    expect(named.stdout).toBe('width: 100px\ncolor: rgb(255, 0, 0)\n');

    const all = await bvl('get', 'styles', '#box', '--all');
    expect(all.stdout.split('\n').length).toBeGreaterThan(300);
    expect(all.stdout).toContain('font-size: 20px');

    const json = await bvlJson('get', 'styles', '#box', 'height');
    expect(json).toMatchObject({ success: true, data: { styles: { height: '50px' } } });

    expect((await bvl('get', 'styles', '#box', 'nonsense')).stderr).toContain(
      'Unknown CSS property: nonsense',
    );
  });
});

describe('XPath selectors', () => {
  it('work in click, get text, get count and wait', async () => {
    await bvl('open', fixture('/styled.html'));
    expect((await bvl('get', 'count', '//li')).stdout.trim()).toBe('3');
    expect((await bvl('get', 'count', '(//li)[2]')).stdout.trim()).toBe('1');
    expect((await bvl('get', 'count', '//nothing')).stdout.trim()).toBe('0');
    expect((await bvl('get', 'text', '//li[2]')).stdout).toContain('two');
    expect((await bvl('wait', "//button[@type='submit']")).code).toBe(0);
    expect((await bvl('click', "//button[@type='submit']")).code).toBe(0);
    expect((await bvl('get', 'text', '#out')).stdout).toContain('clicked');
    expect((await bvl('get', 'text', '//nothing', '--timeout', '300')).stderr).toContain(
      'Element not found',
    );
    expect((await bvl('get', 'text', '//[')).stderr).toContain('Invalid selector');
  });
});

describe('agent mistakes', () => {
  it('points Playwright-style locators at find', async () => {
    await bvl('open', fixture('/styled.html'));
    const r = await bvl('click', 'text=Apply now');
    expect(r.stderr).toContain('Invalid selector: text=Apply now');
    expect(r.stderr).toContain('bvl find text "Apply now" <action>');
    expect((await bvl('click', 'button:has-text("Go")')).stderr).toContain('bvl find text');
  });

  it('eval awaits a promise that is the completion value', async () => {
    await bvl('open', fixture('/styled.html'));
    const r = await bvl('eval', 'Promise.resolve({ a: 1 }).then((o) => ({ ...o, b: 2 }))');
    expect(JSON.parse(r.stdout)).toEqual({ a: 1, b: 2 });
    expect((await bvl('eval', 'await Promise.resolve(3)')).stdout.trim()).toBe('3');
    expect((await bvl('eval', '({ x: [1, 2] })')).stdout).toContain('"x"');
    expect((await bvl('eval', 'undefined')).stdout.trim()).toBe('undefined');
    const rej = await bvl('eval', 'Promise.reject(new Error("nope"))');
    expect(rej.code).not.toBe(0);
    expect(rej.stderr).toContain('nope');
    // The rejection reaches bvl; it is not an uncaught page error.
    await bvl('wait', '200');
    expect((await bvl('errors')).stdout).not.toContain('nope');
  });
});

describe('pushstate', () => {
  it('navigates client-side and fires popstate; rejects other origins', async () => {
    await bvl('open', fixture('/spa.html'));
    const r = await bvl('pushstate', '/app/settings?x=1#top');
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(fixture('/app/settings?x=1#top'));
    expect((await bvl('get', 'text', '#route')).stdout).toContain('route /app/settings');
    expect((await bvl('get', 'url')).stdout.trim()).toBe(fixture('/app/settings?x=1#top'));
    // same document: no reload happened
    expect((await bvl('eval', 'window.routes.length')).stdout.trim()).toBe('2');

    const json = await bvlJson('pushstate', '/other');
    expect(json).toMatchObject({ success: true, data: { url: fixture('/other') } });

    const bad = await bvl('pushstate', 'https://example.com/x');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('same-origin only');
  });
});

describe('session', () => {
  it('list and info are read-only views of the sessions', async () => {
    const env = { BVL_SESSION: 'e2e-sessions' };
    await bvlWith(env, 'open', fixture('/styled.html'));

    const info = await bvlWith(env, 'session', 'info');
    expect(info.code).toBe(0);
    expect(info.stdout).toContain('Session: e2e-sessions');
    expect(info.stdout).toMatch(/Tab: t\d+/);
    expect(info.stdout).toContain(`URL: ${fixture('/styled.html')}`);
    expect(info.stdout).toContain('Frame: main');

    const list = await bvlWith(env, 'session', 'list');
    expect(list.stdout).toContain('Active sessions:');
    expect(list.stdout).toMatch(/→ e2e-sessions {2}tab t\d+/);

    const json = JSON.parse((await bvlWith(env, 'session', 'list', '--json')).stdout) as {
      data: { sessions: { name: string; current: boolean; tab: string; owned: string[] }[] };
    };
    const mine = json.data.sessions.find((s) => s.name === 'e2e-sessions');
    expect(mine).toMatchObject({ current: true });
    expect(mine?.owned).toContain(mine?.tab);

    // a fresh session has no tab
    const none = await bvlWith({ BVL_SESSION: 'e2e-empty' }, 'session', 'info');
    expect(none.stdout).toContain('Tab: -');
    expect((await bvl('session', 'nope')).stderr).toContain('Unknown: session nope');
  });
});

describe('--human pointer paths', () => {
  const moves = async () => {
    const out = (await bvl('eval', 'JSON.stringify(events.filter(e => e.startsWith("mousemove")))'))
      .stdout;
    // `eval` prints the JSON string; parse twice if it came back quoted.
    let v: unknown = JSON.parse(out);
    if (typeof v === 'string') v = JSON.parse(v);
    return (v as string[]).map(
      (e) => (e.split(' ')[1] ?? '').split(',').map(Number) as [number, number],
    );
  };

  it('mouse move --human --seed gives a curved path ending on the target, same every run', async () => {
    await bvl('open', fixture('/human.html'));
    const run = async () => {
      await bvl('mouse', 'move', '10', '10');
      await bvl('eval', 'events.length = 0');
      const r = await bvlJson(
        'mouse',
        'move',
        '400',
        '300',
        '--human',
        '--seed',
        '42',
        '--steps',
        '30',
        '--duration',
        '0',
      );
      expect(r).toMatchObject({
        success: true,
        data: { moved: true, x: 400, y: 300, human: true, seed: 42 },
      });
      return moves();
    };
    const expected = humanPath(
      { x: 10, y: 10 },
      { x: 400, y: 300 },
      { seed: 42, steps: 30, durationMs: 0 },
    ).points;
    // Hidden agent tabs coalesce moves to about one per frame, so each run receives a subsequence
    // of the path (exact equality is unit-tested); it must end on the target and be curved.
    for (const raw of [await run(), await run()]) {
      // Chrome truncates to whole pixels; a stale event at the start point may land late.
      const got = raw.filter(
        ([x, y], i) =>
          !(x === 10 && y === 10) && (i === 0 || x !== raw[i - 1]?.[0] || y !== raw[i - 1]?.[1]),
      );
      expect(got.length).toBeGreaterThan(1);
      expect(got.at(-1)).toEqual([400, 300]);
      let at = 0;
      for (const [x, y] of got) {
        while (
          at < expected.length &&
          Math.hypot((expected[at]?.x ?? 0) - x, (expected[at]?.y ?? 0) - y) > 1.5
        ) {
          at++;
        }
        expect(at, `unexpected point ${String(x)},${String(y)}`).toBeLessThan(expected.length);
        at++;
      }
      const dev = Math.max(...got.map(([x, y]) => Math.abs(y - 10 - ((x - 10) * 290) / 390)));
      expect(dev).toBeGreaterThan(2);
    }
  });

  it('a long human move on a hidden tab does not wait for every event', async () => {
    await bvl('open', fixture('/human.html'));
    const t = Date.now();
    const r = await bvl(
      'mouse',
      'move',
      '700',
      '500',
      '--human',
      '--seed',
      '1',
      '--steps',
      '240',
      '--duration',
      '0',
    );
    expect(r.code).toBe(0);
    expect(Date.now() - t).toBeLessThan(15000);
  });

  it('rejects --steps outside 1-240', async () => {
    for (const s of ['0', '241']) {
      const r = await bvl('mouse', 'move', '1', '1', '--steps', s);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('--steps must be an integer from 1 to 240');
    }
  });

  it('click, dblclick and hover --human approach from the last pointer and land on the target', async () => {
    await bvl('open', fixture('/human.html'));
    await bvl('mouse', 'move', '5', '5');
    await bvl('eval', 'events.length = 0');
    expect((await bvl('click', '#btn', '--human')).code).toBe(0);
    let ev = (await bvl('eval', 'events.join("|")')).stdout;
    expect(ev).toContain('mousedown 460,220');
    expect(ev).toContain('click 460,220');
    expect((await moves()).length).toBeGreaterThan(1);
    // the pointer state follows the click: the next human move starts there
    await bvl('eval', 'events.length = 0');
    expect((await bvl('hover', '#menu', '--human')).code).toBe(0);
    const m = await moves();
    expect(m.at(-1)).toEqual([160, 320]);
    expect(Math.hypot((m[0]?.[0] ?? 0) - 460, (m[0]?.[1] ?? 0) - 220)).toBeLessThan(160);
    await bvl('eval', 'events.length = 0');
    expect((await bvl('dblclick', '#btn', '--human')).code).toBe(0);
    ev = (await bvl('eval', 'events.join("|")')).stdout;
    expect(ev).toContain('dblclick 460,220');
  });

  it('drag --human moves along a curve with the button held', async () => {
    await bvl('open', fixture('/human.html'));
    await bvl('eval', 'events.length = 0');
    expect((await bvl('drag', '#knob', '#zone', '--human')).code).toBe(0);
    expect((await bvl('eval', 'window.dropped')).stdout.trim()).toBe('true');
    expect((await moves()).length).toBeGreaterThan(1);
  });

  it.each([[[]], [['--human']]])(
    'drag %j drops a native HTML5 draggable on its target',
    async (flags: string[]) => {
      await bvl('open', fixture('/human.html'));
      await bvl('eval', 'window.htmlDropped = 0');
      expect((await bvl('drag', '#card', '#bin', ...flags)).code).toBe(0);
      expect((await bvl('eval', 'window.htmlDropped')).stdout.trim()).toBe('1');
    },
  );
});
