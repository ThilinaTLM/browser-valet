import { describe, expect, it } from 'vitest';
import {
  compute,
  computeCls,
  computeInp,
  format,
  rate,
  type RawVitals,
} from '../../src/background/vitals';

const base: RawVitals = {
  url: 'http://x/',
  visibility: 'visible',
  states: [],
  ttfb: 10,
  fcp: 100,
  lcp: { element: 'h1', size: 5, startTime: 120, url: null },
  shifts: [],
  events: [],
};

describe('vitals', () => {
  it('rates with the web.dev thresholds', () => {
    expect(rate('lcp', 2500)).toBe('good');
    expect(rate('lcp', 3000)).toBe('needs-improvement');
    expect(rate('cls', 0.3)).toBe('poor');
  });

  it('CLS takes the worst session window and skips input-driven shifts', () => {
    const s = (value: number, startTime: number, hadRecentInput = false) => ({
      value,
      startTime,
      hadRecentInput,
    });
    expect(computeCls([s(0.1, 0), s(0.05, 500), s(0.2, 3000), s(0.9, 3100, true)])).toBeCloseTo(
      0.2,
    );
    expect(computeCls([s(0.1, 0), s(0.05, 500)])).toBeCloseTo(0.15);
    expect(computeCls([])).toBe(0);
  });

  it('INP uses the longest duration per interaction', () => {
    expect(computeInp([])).toBeNull();
    expect(
      computeInp([
        { interactionId: 0, duration: 900, startTime: 0 },
        { interactionId: 1, duration: 40, startTime: 1 },
        { interactionId: 1, duration: 80, startTime: 1 },
        { interactionId: 2, duration: 30, startTime: 2 },
      ]),
    ).toBe(80);
  });

  it('missing LCP on a page hidden while loading is not measurable', () => {
    const v = compute({
      ...base,
      lcp: null,
      fcp: null,
      visibility: 'hidden',
      states: [{ name: 'hidden', startTime: 0 }],
    });
    expect(v.lcp).toBeNull();
    expect(v.notMeasurable.lcp).toContain('background tab');
    expect(format(v)).toContain('LCP: not measurable (page loaded in a background tab)');
  });

  it('missing LCP on a visible page is just absent', () => {
    const v = compute({ ...base, lcp: null });
    expect(v.notMeasurable).toEqual({});
  });

  it('formats like upstream with ratings', () => {
    const t = format(compute(base));
    expect(t).toContain(
      'ttfb: 10ms (good)  fcp: 100ms (good)  lcp: 120ms (good)  cls: 0 (good)  inp: -',
    );
    expect(t).toContain('lcp: element: h1');
  });
});
