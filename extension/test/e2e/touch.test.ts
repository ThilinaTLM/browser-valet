// tap, swipe and set touch: touch events reach the page on a (hidden) agent tab.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveNextConsent,
  bvl,
  bvlJson,
  fixture,
  framesPage,
  openUserTab,
  stopTabInPopup,
  tidForTitle,
  useBrowser,
} from './harness';

useBrowser();

// Another session's tab is the visible one, so the default session's tabs are hidden.
const ANCHOR = ['--session', 'touch-anchor'];
beforeAll(async () => {
  await bvl('open', fixture('/other.html'), ...ANCHOR);
});
afterAll(async () => {
  await bvl('close', ...ANCHOR);
});

const events = async (): Promise<string[]> => {
  const j = await bvlJson('eval', 'events');
  return (j.data as { result: string[] }).result;
};

const hidden = async () => {
  expect(
    ((await bvlJson('eval', 'document.visibilityState')).data as { result: string }).result,
  ).toBe('hidden');
};

describe('tap / swipe / set touch', () => {
  it('tap dispatches touchstart and touchend on the element', async () => {
    await bvl('open', fixture('/touch.html'));
    await hidden();
    const j = await bvlJson('tap', '#target');
    expect(j).toMatchObject({ success: true, data: { tapped: '#target' } });
    const ev = await events();
    expect(ev[0]).toMatch(/^touchstart 120,60 target$/);
    expect(ev[1]).toMatch(/^touchend 120,60 target$/);
  });

  it('swipe sends a move sequence in the right direction', async () => {
    await bvl('open', fixture('/touch.html'));
    await hidden();
    const r = await bvlJson('swipe', 'up', '100', '--duration', '50');
    expect(r).toMatchObject({ success: true, data: { swiped: 'up', distance: 100 } });
    const ev = await events();
    expect(ev[0]).toMatch(/^touchstart /);
    expect(ev.filter((e) => e.startsWith('touchmove')).length).toBeGreaterThanOrEqual(3);
    expect(ev.at(-1)).toMatch(/^touchend /);
    const ys = ev
      .filter((e) => e.startsWith('touchmove'))
      .map((e) => Number(e.split(' ')[1]?.split(',')[1]));
    expect(ys.at(-1)).toBeLessThan(ys[0] ?? 0);
  });

  it('swipe --selector starts at the element; bad arguments are rejected', async () => {
    await bvl('open', fixture('/touch.html'));
    await bvl('swipe', 'right', '50', '--selector', '#target', '--duration', '0');
    expect((await events())[0]).toMatch(/^touchstart 120,60 /);
    expect((await bvl('swipe', 'sideways')).stderr).toContain('Invalid direction');
    expect((await bvl('swipe', 'up', '-5')).stderr).toContain('Distance must be');
  });

  it('tap makes Chrome synthesize the mouse compat events, so links work and navigation is reported', async () => {
    await bvl('open', fixture('/touch.html'));
    await bvl('tap', '#target');
    expect(await events()).toEqual([
      'touchstart 120,60 target',
      'touchend 120,60 target',
      'mouseover 120,60 target',
      'mousedown 120,60 target',
      'click 120,60 target',
    ]);
    const j = await bvlJson('tap', '#link');
    expect(j).toMatchObject({
      success: true,
      data: { tapped: '#link', navigated: { title: 'Fixture Other' } },
    });
    expect((await bvl('tap', '#link')).code).toBe(1); // gone after navigating
  });

  it('swipe reports the real distance and warns when the viewport clamps it', async () => {
    await bvl('open', fixture('/touch.html'));
    const r = await bvl('swipe', 'down', '5000', '--duration', '0', '--json');
    const j = JSON.parse(r.stdout) as { data: { distance: number } };
    expect(j.data.distance).toBeLessThan(5000);
    expect(r.stderr).toContain('Swipe shortened');
  });

  it('set touch on leaves click and hover as mouse input', async () => {
    await bvl('open', fixture('/touch.html'));
    await bvl('set', 'touch', 'on');
    await bvl('open', fixture('/touch.html'));
    await bvl('hover', '#target');
    await bvl('click', '#target');
    const ev = await events();
    expect(ev.some((e) => e.startsWith('mouseover'))).toBe(true);
    expect(ev.some((e) => e.startsWith('click'))).toBe(true);
    expect(ev.some((e) => e.startsWith('touch'))).toBe(false);
    await bvl('set', 'touch', 'off');
  });

  it('tap inside a cross-origin iframe sends touch events (no synthesized click)', async () => {
    await bvl('open', framesPage());
    for (let i = 0; i < 40; i++) {
      if ((await bvl('snapshot', '-i')).stdout.includes('Pay')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const snap = (await bvl('snapshot', '-i')).stdout;
    const line = snap.split('\n').find((l) => l.includes('button "Pay"'));
    const ref = /ref=(e\d+)/.exec(line ?? '')?.[1];
    expect((await bvl('tap', `@${ref}`)).code).toBe(0);
    expect((await bvl('frame', 'payment-frame')).code).toBe(0);
    // Touch events arrive; Chrome does not synthesize a click for input sent to the child session.
    expect((await bvl('get', 'text', '#out')).stdout.trim()).toBe('touched');
  });

  it('set touch on/off toggles touch detection', async () => {
    await bvl('open', fixture('/touch.html'));
    expect(await bvlJson('set', 'touch', 'on')).toMatchObject({
      success: true,
      data: { touch: true },
    });
    expect((await bvl('eval', 'navigator.maxTouchPoints')).stdout.trim()).toBe('5');
    await bvl('open', fixture('/touch.html'));
    expect((await bvl('eval', 'hasTouch')).stdout.trim()).toBe('true');
    await bvl('set', 'touch', 'off');
    expect((await bvl('eval', 'navigator.maxTouchPoints')).stdout.trim()).toBe('0');
    expect((await bvl('set', 'touch', 'maybe')).stderr).toContain('Usage: bvl set touch on|off');
  });

  it('tap and swipe work on a visible shared tab, set touch is refused', async () => {
    await bvl('close'); // the agent tab has the same title
    const page = await openUserTab(fixture('/touch.html'));
    try {
      const tid = await tidForTitle('Fixture Touch');
      const pending = bvl('tab', tid);
      await approveNextConsent('allow');
      expect((await pending).code).toBe(0);
      expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
      expect((await bvl('tap', '#target')).code).toBe(0);
      expect((await bvl('swipe', 'up', '100', '--duration', '50')).code).toBe(0);
      const ev = await page.evaluate(() => (window as unknown as { events: string[] }).events);
      expect(ev).toContain('touchstart 120,60 target');
      expect(ev.some((e) => e.startsWith('touchmove'))).toBe(true);
      const r = await bvl('set', 'touch', 'on');
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("user's shared tab");
      await stopTabInPopup(tid);
    } finally {
      await page.close();
    }
  });
});
