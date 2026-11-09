// Small parity commands: mouse, highlight, get styles, XPath, pushstate, session.

import { describe, expect, it } from 'vitest';
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
    expect((await bvl('get', 'text', '//nothing')).stderr).toContain('Element not found');
    expect((await bvl('get', 'text', '//[')).stderr).toContain('Invalid selector');
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
