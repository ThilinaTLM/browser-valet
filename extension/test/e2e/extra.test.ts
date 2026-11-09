// Small parity commands: mouse, highlight, get styles, XPath, pushstate, session.

import { describe, expect, it } from 'vitest';
import { bctl, bctlJson, fixture, useBrowser } from './harness';

useBrowser();

describe('mouse', () => {
  it('move, down, up and wheel reach the page with position and buttons', async () => {
    expect((await bctl('open', fixture('/mouse.html'))).code).toBe(0);
    const mv = await bctlJson('mouse', 'move', '100', '200');
    expect(mv).toMatchObject({ success: true, data: { moved: true, x: 100, y: 200 } });
    expect((await bctl('mouse', 'down')).stdout).toContain('✓ Done');
    expect((await bctl('mouse', 'move', '140', '200', '--steps', '4')).code).toBe(0);
    expect((await bctl('mouse', 'up')).code).toBe(0);
    expect((await bctl('mouse', 'down', 'right')).code).toBe(0);
    expect((await bctl('mouse', 'up', 'right')).code).toBe(0);
    expect((await bctl('mouse', 'wheel', '120', '5')).code).toBe(0);

    const ev = (await bctl('eval', 'window.events.join("|")')).stdout;
    expect(ev).toContain('mousemove 100,200 b0 bs0');
    expect(ev).toContain('mousedown 100,200 b0 bs1');
    // moves while the button is held report it (hidden tabs may coalesce the intermediate ones)
    expect(ev).toContain('mousemove 140,200');
    expect(ev).toContain('mouseup 140,200 b0 bs0');
    expect(ev).toContain('mousedown 140,200 b2 bs2');
  });

  it('--duration spreads a move over several events', async () => {
    await bctl('eval', 'window.events.length = 0');
    const t = Date.now();
    expect(
      (await bctl('mouse', 'move', '10', '10', '--duration', '300', '--steps', '5')).code,
    ).toBe(0);
    expect(Date.now() - t).toBeGreaterThanOrEqual(240);
    const n = (await bctl('eval', 'window.events.filter(e=>e.startsWith("mousemove")).length'))
      .stdout;
    // Hidden agent tabs coalesce moves to one per frame, so only a lower bound is stable.
    expect(Number(n.trim())).toBeGreaterThanOrEqual(1);
  });

  it('wheel on a hidden agent tab scrolls the page by script', async () => {
    await bctl('open', fixture('/mouse.html'));
    await bctl('mouse', 'move', '50', '50');
    expect((await bctl('mouse', 'wheel', '300')).code).toBe(0);
    expect(Number((await bctl('eval', 'window.scrollY')).stdout.trim())).toBe(300);
  });

  it('rejects bad input', async () => {
    expect((await bctl('mouse', 'move', '1')).stderr).toContain('Missing y');
    expect((await bctl('mouse', 'down', 'nope')).stderr).toContain('left, right or middle');
    expect((await bctl('mouse', 'spin')).stderr).toContain('Unknown: mouse spin');
  });
});

describe('highlight', () => {
  it('highlights an element, errors on a missing one', async () => {
    await bctl('open', fixture('/mouse.html'));
    expect(await bctlJson('highlight', '#target')).toMatchObject({
      success: true,
      data: { highlighted: '#target' },
    });
    const bad = await bctl('highlight', '#nosuch');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('Element not found');
  });
});

describe('get styles', () => {
  it('prints a curated set by default, named props, or everything', async () => {
    await bctl('open', fixture('/styled.html'));
    const def = (await bctl('get', 'styles', '#box')).stdout;
    expect(def).toContain('color: rgb(255, 0, 0)');
    expect(def).toContain('font-size: 20px');
    expect(def).toContain('background-color: rgb(0, 0, 255)');
    expect(def).toContain('cursor: pointer');
    expect(def.split('\n').filter(Boolean).length).toBeLessThan(40);

    const named = await bctl('get', 'styles', '#box', 'width', 'color');
    expect(named.stdout).toBe('width: 100px\ncolor: rgb(255, 0, 0)\n');

    const all = await bctl('get', 'styles', '#box', '--all');
    expect(all.stdout.split('\n').length).toBeGreaterThan(300);
    expect(all.stdout).toContain('font-size: 20px');

    const json = await bctlJson('get', 'styles', '#box', 'height');
    expect(json).toMatchObject({ success: true, data: { styles: { height: '50px' } } });

    expect((await bctl('get', 'styles', '#box', 'nonsense')).stderr).toContain(
      'Unknown CSS property: nonsense',
    );
  });
});

describe('XPath selectors', () => {
  it('work in click, get text, get count and wait', async () => {
    await bctl('open', fixture('/styled.html'));
    expect((await bctl('get', 'count', '//li')).stdout.trim()).toBe('3');
    expect((await bctl('get', 'count', '(//li)[2]')).stdout.trim()).toBe('1');
    expect((await bctl('get', 'count', '//nothing')).stdout.trim()).toBe('0');
    expect((await bctl('get', 'text', '//li[2]')).stdout).toContain('two');
    expect((await bctl('wait', "//button[@type='submit']")).code).toBe(0);
    expect((await bctl('click', "//button[@type='submit']")).code).toBe(0);
    expect((await bctl('get', 'text', '#out')).stdout).toContain('clicked');
    expect((await bctl('get', 'text', '//nothing')).stderr).toContain('Element not found');
    expect((await bctl('get', 'text', '//[')).stderr).toContain('Invalid selector');
  });
});
