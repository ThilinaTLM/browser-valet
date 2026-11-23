// Core Web Vitals from the raw PerformanceObserver entries read by `vitalsScript`.

export type Rating = 'good' | 'needs-improvement' | 'poor';

export interface RawVitals {
  url: string;
  visibility: string;
  /** `visibility-state` entries (Chrome 115+); empty when unsupported. */
  states: { name: string; startTime: number }[];
  ttfb: number | null;
  fcp: number | null;
  lcp: { element: string | null; size: number; startTime: number; url: string | null } | null;
  shifts: { value: number; startTime: number; hadRecentInput: boolean }[];
  events: { interactionId: number; duration: number; startTime: number }[];
}

export interface Vitals {
  url: string;
  ttfb: number | null;
  fcp: number | null;
  lcp: RawVitals['lcp'];
  cls: { score: number; entries: { value: number; startTime: number }[] };
  inp: number | null;
  ratings: Partial<Record<'ttfb' | 'fcp' | 'lcp' | 'cls' | 'inp', Rating>>;
  /** Metrics the browser could not report, with the reason. */
  notMeasurable: Partial<Record<'fcp' | 'lcp', string>>;
}

// Thresholds from web.dev: [good upper bound, poor lower bound].
const THRESHOLDS = {
  ttfb: [800, 1800],
  fcp: [1800, 3000],
  lcp: [2500, 4000],
  cls: [0.1, 0.25],
  inp: [200, 500],
} as const;

export function rate(metric: keyof typeof THRESHOLDS, value: number): Rating {
  const [good, poor] = THRESHOLDS[metric];
  return value <= good ? 'good' : value <= poor ? 'needs-improvement' : 'poor';
}

/** Session-window CLS as web-vitals computes it: gap < 1s, window ≤ 5s, max window wins. */
export function computeCls(shifts: RawVitals['shifts']): number {
  let best = 0;
  let cur = 0;
  let first = 0;
  let last = 0;
  for (const s of shifts) {
    if (s.hadRecentInput) continue;
    if (cur > 0 && s.startTime - last < 1000 && s.startTime - first < 5000) {
      cur += s.value;
    } else {
      cur = s.value;
      first = s.startTime;
    }
    last = s.startTime;
    best = Math.max(best, cur);
  }
  return best;
}

/** INP: the longest interaction, or the 98th percentile estimate with many (one skipped per 50). */
export function computeInp(events: RawVitals['events']): number | null {
  const byId = new Map<number, number>();
  for (const e of events) {
    if (!e.interactionId) continue;
    byId.set(e.interactionId, Math.max(byId.get(e.interactionId) ?? 0, e.duration));
  }
  if (byId.size === 0) return null;
  const sorted = [...byId.values()].sort((a, b) => b - a);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length / 50))] ?? null;
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export const BACKGROUND_REASON = 'page loaded in a background tab';
export const HIDDEN_REASON = 'page was hidden before it was reported';

/**
 * When the page first became hidden, as web-vitals computes it: 0 if it started hidden (the first
 * `visibility-state` entry), else the first later `hidden` entry. `null`: never hidden, or (before
 * Chrome 115, no entries) unknown.
 */
function firstHidden(raw: RawVitals): number | null {
  const first = raw.states[0];
  if (first?.name === 'hidden') return 0;
  return raw.states.find((s) => s.name === 'hidden')?.startTime ?? null;
}

/**
 * Chrome reports FCP/LCP only for the time the page was visible: a metric that is missing, or that
 * is at/after the first hide, is not measurable. Without visibility entries (Chrome < 115) only a
 * missing metric on a page that is hidden now is flagged.
 */
function unmeasurable(raw: RawVitals, value: number | null): string | undefined {
  const hidden = firstHidden(raw);
  if (hidden === null) {
    return value === null && raw.states.length === 0 && raw.visibility === 'hidden'
      ? BACKGROUND_REASON
      : undefined;
  }
  if (value !== null && value < hidden) return undefined;
  return hidden === 0 ? BACKGROUND_REASON : HIDDEN_REASON;
}

export function compute(raw: RawVitals): Vitals {
  const notMeasurable: Vitals['notMeasurable'] = {};
  const ttfb = raw.ttfb && raw.ttfb > 0 ? raw.ttfb : null;
  const lcpReason = unmeasurable(raw, raw.lcp?.startTime ?? null);
  const fcpReason = unmeasurable(raw, raw.fcp);
  if (lcpReason) notMeasurable.lcp = lcpReason;
  if (fcpReason) notMeasurable.fcp = fcpReason;
  const fcp = fcpReason ? null : raw.fcp;
  const lcp = lcpReason ? null : raw.lcp;
  const cls = computeCls(raw.shifts);
  const inp = computeInp(raw.events);
  const ratings: Vitals['ratings'] = { cls: rate('cls', cls) };
  if (ttfb !== null) ratings.ttfb = rate('ttfb', ttfb);
  if (fcp !== null) ratings.fcp = rate('fcp', fcp);
  if (lcp) ratings.lcp = rate('lcp', lcp.startTime);
  if (inp !== null) ratings.inp = rate('inp', inp);
  // Rounding as upstream: times to 0.1 ms (LCP to whole ms), CLS score to 2 decimals, shifts to 4.
  return {
    url: raw.url,
    ttfb: ttfb === null ? null : round(ttfb),
    fcp: fcp === null ? null : round(fcp),
    lcp: lcp && { ...lcp, startTime: Math.round(lcp.startTime) },
    cls: {
      score: round(cls, 2),
      entries: raw.shifts
        .filter((s) => !s.hadRecentInput)
        .map((s) => ({ value: round(s.value, 4), startTime: round(s.startTime) })),
    },
    inp: inp === null ? null : Math.round(inp),
    ratings,
    notMeasurable,
  };
}

const fmt = (ms: number, d = 0) => `${round(ms, d)}ms`;

export function format(v: Vitals): string {
  const r = (m: keyof Vitals['ratings']) => (v.ratings[m] ? ` (${v.ratings[m]})` : '');
  const val = (m: 'fcp' | 'lcp', n: number | null) =>
    v.notMeasurable[m] ? 'n/a' : n === null ? '-' : fmt(n) + r(m);
  const lines = [
    `url: ${v.url}`,
    `ttfb: ${v.ttfb === null ? '-' : fmt(v.ttfb, 1) + r('ttfb')}  fcp: ${val('fcp', v.fcp)}  lcp: ${val('lcp', v.lcp?.startTime ?? null)}  cls: ${v.cls.score}${r('cls')}  inp: ${v.inp === null ? '-' : fmt(v.inp) + r('inp')}`,
  ];
  if (v.lcp?.element) lines.push(`lcp: element: ${v.lcp.element}`);
  for (const m of ['lcp', 'fcp'] as const)
    if (v.notMeasurable[m])
      lines.push(`${m.toUpperCase()}: not measurable (${v.notMeasurable[m]})`);
  if (v.inp === null)
    lines.push('inp: no slow interactions recorded (Chrome buffers only ≥ 104 ms)');
  return lines.join('\n');
}

/** Runs in the page. Reads the buffered entries; returns a `RawVitals` (without `url`). */
export const vitalsScript = `(async () => {
  const collect = (type, extra) => {
    try {
      const po = new PerformanceObserver(() => {});
      po.observe(Object.assign({ type, buffered: true }, extra));
      const out = po.takeRecords();
      po.disconnect();
      return out;
    } catch { return []; }
  };
  const lcps = collect('largest-contentful-paint');
  const shifts = collect('layout-shift');
  const events = collect('event', { durationThreshold: 16 });
  const nav = performance.getEntriesByType('navigation')[0];
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  const l = lcps[lcps.length - 1];
  let states = [];
  try { states = performance.getEntriesByType('visibility-state').map((e) => ({ name: e.name, startTime: e.startTime })); } catch {}
  return {
    url: location.href,
    visibility: document.visibilityState,
    states,
    ttfb: nav && nav.responseStart > 0 ? nav.responseStart : null,
    fcp: fcp ? fcp.startTime : null,
    lcp: l ? { element: l.element ? l.element.tagName.toLowerCase() : null, size: l.size, startTime: l.startTime, url: l.url || null } : null,
    shifts: shifts.map((s) => ({ value: s.value, startTime: s.startTime, hadRecentInput: s.hadRecentInput })),
    events: events.map((e) => ({ interactionId: e.interactionId, duration: e.duration, startTime: e.startTime })),
  };
})()`;
