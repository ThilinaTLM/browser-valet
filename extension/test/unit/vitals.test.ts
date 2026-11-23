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

  const hiddenAt0 = [{ name: 'hidden', startTime: 0 }];

  it('missing LCP and FCP on a page hidden while loading are not measurable', () => {
    const v = compute({ ...base, lcp: null, fcp: null, visibility: 'hidden', states: hiddenAt0 });
    expect(v.lcp).toBeNull();
    expect(v.fcp).toBeNull();
    expect(v.notMeasurable.lcp).toContain('background tab');
    expect(v.notMeasurable.fcp).toContain('background tab');
    expect(format(v)).toContain('LCP: not measurable (page loaded in a background tab)');
    expect(format(v)).toContain('fcp: n/a');
  });

  it('FCP present, hidden at 0: not measurable', () => {
    const v = compute({ ...base, visibility: 'hidden', states: hiddenAt0 });
    expect(v.fcp).toBeNull();
    expect(v.lcp).toBeNull();
    expect(v.ratings.fcp).toBeUndefined();
    expect(v.notMeasurable.fcp).toContain('background tab');
  });

  it('LCP present, hidden before it: not measurable; FCP before the hide is kept', () => {
    const v = compute({
      ...base,
      fcp: 100,
      lcp: { element: 'h1', size: 5, startTime: 300, url: null },
      states: [
        { name: 'visible', startTime: 0 },
        { name: 'hidden', startTime: 200 },
      ],
    });
    expect(v.lcp).toBeNull();
    expect(v.notMeasurable.lcp).toContain('hidden before');
    expect(v.fcp).toBe(100);
    expect(v.notMeasurable.fcp).toBeUndefined();
  });

  it('a hide after the metric keeps it', () => {
    const v = compute({
      ...base,
      states: [
        { name: 'visible', startTime: 0 },
        { name: 'hidden', startTime: 5000 },
      ],
    });
    expect(v.lcp?.startTime).toBe(120);
    expect(v.notMeasurable).toEqual({});
  });

  it('without visibility entries (Chrome < 115) only a missing metric on a hidden page is flagged', () => {
    expect(compute({ ...base, lcp: null, visibility: 'hidden' }).notMeasurable.lcp).toContain(
      'background tab',
    );
    expect(compute({ ...base, visibility: 'hidden' }).notMeasurable).toEqual({});
    expect(compute({ ...base, lcp: null }).notMeasurable).toEqual({});
  });

  it('TTFB 0 is null', () => {
    expect(compute({ ...base, ttfb: 0 }).ttfb).toBeNull();
  });

  it('INP with 50+ interactions skips the worst one (p98)', () => {
    const events = Array.from({ length: 50 }, (_, i) => ({
      interactionId: i + 1,
      duration: 100 + i,
      startTime: i,
    }));
    expect(computeInp(events)).toBe(148);
    expect(computeInp(events.slice(0, 49))).toBe(148);
  });

  it('rating thresholds: the upper bound of a band belongs to it', () => {
    expect(rate('lcp', 4000)).toBe('needs-improvement');
    expect(rate('lcp', 4001)).toBe('poor');
    expect(rate('cls', 0.1)).toBe('good');
    expect(rate('cls', 0.25)).toBe('needs-improvement');
    expect(rate('inp', 200)).toBe('good');
    expect(rate('inp', 500.5)).toBe('poor');
    expect(rate('ttfb', 800)).toBe('good');
    expect(rate('fcp', 3000)).toBe('needs-improvement');
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
