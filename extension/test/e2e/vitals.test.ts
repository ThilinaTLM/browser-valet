// vitals: all five metrics on a visible shared tab, LCP "not measurable" on a hidden agent tab.

import { describe, expect, it } from 'vitest';
import {
  approveNextConsent,
  bvl,
  bvlJson,
  fixture,
  openUserTab,
  stopTabInPopup,
  tidForTitle,
  useBrowser,
} from './harness';

useBrowser();

interface VitalsData {
  url: string;
  ttfb: number | null;
  fcp: number | null;
  lcp: { element: string; startTime: number } | null;
  cls: { score: number };
  inp: number | null;
  ratings: Record<string, string>;
  notMeasurable: Record<string, string>;
}

describe('vitals', () => {
  it('reports all five metrics on a visible shared tab', async () => {
    const page = await openUserTab(fixture('/vitals.html'));
    try {
      await page.bringToFront();
      await new Promise((r) => setTimeout(r, 600)); // the late layout shift
      await page.click('#busy');
      const tid = await tidForTitle('Fixture Vitals');
      const pending = bvl('tab', tid);
      await approveNextConsent('allow');
      expect((await pending).code).toBe(0);

      const r = await bvlJson('vitals');
      expect(JSON.stringify(r)).toContain('success":true');
      const d = r.data as VitalsData;
      expect(d.url).toContain('/vitals.html');
      expect(d.ttfb).not.toBeNull();
      expect(d.fcp).toBeGreaterThan(0);
      expect(d.lcp?.element).toBeTruthy();
      expect(d.lcp?.startTime).toBeGreaterThan(0);
      expect(d.cls.score).toBeGreaterThan(0);
      expect(d.inp).toBeGreaterThanOrEqual(16);
      expect(d.notMeasurable).toEqual({});
      expect(d.ratings.lcp).toBeTruthy();

      const text = (await bvl('vitals')).stdout;
      expect(text).toMatch(/ttfb: .*fcp: \d.*lcp: \d.*cls: .*inp: \d/);
      await stopTabInPopup(tid);
    } finally {
      await page.close();
    }
  });

  it('reports LCP as not measurable (not 0) on a hidden agent tab', async () => {
    const r = await bvlJson('vitals', fixture('/vitals.html'));
    expect(JSON.stringify(r)).toContain('success":true');
    const d = r.data as VitalsData;
    expect((await bvl('eval', 'document.visibilityState')).stdout.trim()).toBe('"hidden"');
    expect(d.lcp).toBeNull();
    expect(d.notMeasurable.lcp).toContain('background tab');
    const text = (await bvl('vitals')).stdout;
    expect(text).toContain('LCP: not measurable (page loaded in a background tab)');
    expect(text).not.toMatch(/lcp: 0/);
    await bvl('close');
  });
});
