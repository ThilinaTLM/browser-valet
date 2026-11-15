// `snapshot --delta`: compare a snapshot with the last one returned for the same tab and options.
// Pure functions plus an in-memory baseline store, shaped like agent-browser 0.41.2's output.

import { forgetCaptures } from './capture-compare';

export type RefSummary = Record<string, { role: string; name: string }>;

export interface Baseline {
  lines: string[];
  refs: RefSummary;
  /** Tab URL (including the hash) when the baseline was taken. */
  url: string;
  /** Main-frame document (loader id) when the baseline was taken. */
  doc: string | undefined;
  /** Revision handed out with this baseline. */
  revision: number;
}

export interface Splice {
  startLine: number;
  deleteCount: number;
  lines: string[];
}

export type RefChange =
  | { node: { name: string; role: string }; op: 'add'; ref: string }
  | { op: 'remove'; ref: string }
  | { field: 'name' | 'role'; op: 'replace'; ref: string; value: string };

export interface Delta {
  baseRevision: number;
  changes: RefChange[];
  kind: 'delta';
  revision: number;
  treeChange: { deleteCount: number; lines: string[]; startLine: number };
}

export interface Unchanged {
  baseRevision: number;
  kind: 'unchanged';
  revision: number;
}

/** The one contiguous splice turning `a` into `b` (common prefix and suffix kept), or undefined. */
export function diffLines(a: readonly string[], b: readonly string[]): Splice | undefined {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  if (start === a.length && start === b.length) return undefined;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { startLine: start, deleteCount: endA - start, lines: b.slice(start, endB) };
}

const refNum = (ref: string) => Number(ref.slice(1));

/** Added, removed and renamed refs between two snapshots, ordered by ref number. */
export function diffRefs(a: RefSummary, b: RefSummary): RefChange[] {
  const changes: [string, RefChange[]][] = [];
  for (const ref of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const before = a[ref];
    const after = b[ref];
    const out: RefChange[] = [];
    if (before && !after) out.push({ op: 'remove', ref: `@${ref}` });
    else if (!before && after)
      out.push({ node: { name: after.name, role: after.role }, op: 'add', ref: `@${ref}` });
    else if (before && after) {
      for (const field of ['name', 'role'] as const) {
        if (before[field] !== after[field])
          out.push({ field, op: 'replace', ref: `@${ref}`, value: after[field] });
      }
    }
    if (out.length) changes.push([ref, out]);
  }
  return changes.sort((x, y) => refNum(x[0]) - refNum(y[0])).flatMap(([, c]) => c);
}

/** Pretty JSON, the way a delta is printed (keys are already in sorted order). */
export function formatDelta(d: Delta | Unchanged): string {
  return JSON.stringify(d, null, 2);
}

/** One run of changed lines inside a splice: baseline lines `[start, start + deleteCount)` → `lines`. */
export interface Hunk {
  start: number;
  deleteCount: number;
  lines: string[];
}

/** Beyond this many DP cells the splice is printed as one hunk (keeps big trees cheap). */
const MAX_LCS_CELLS = 2_000_000;

/**
 * Split a splice into the runs that really changed, using an LCS of the spliced region, so lines
 * that are equal in both (e.g. between two separate edits) are not printed again.
 */
export function spliceHunks(baseLines: readonly string[], splice: Splice): Hunk[] {
  const a = baseLines.slice(splice.startLine, splice.startLine + splice.deleteCount);
  const b = splice.lines;
  const n = a.length;
  const m = b.length;
  const whole: Hunk[] = [{ start: splice.startLine, deleteCount: n, lines: [...b] }];
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_LCS_CELLS) return whole;
  // lcs[i * (m + 1) + j] = LCS length of a[i..] and b[j..]
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
    }
  }
  const hunks: Hunk[] = [];
  let cur: Hunk | undefined;
  const flush = () => {
    if (cur) hunks.push(cur);
    cur = undefined;
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i === n || (lcs[i * w + j + 1] ?? 0) >= (lcs[(i + 1) * w + j] ?? 0))) {
      cur ??= { start: splice.startLine + i, deleteCount: 0, lines: [] };
      cur.lines.push(b[j] ?? '');
      j++;
    } else {
      cur ??= { start: splice.startLine + i, deleteCount: 0, lines: [] };
      cur.deleteCount++;
      i++;
    }
  }
  flush();
  return hunks.length ? hunks : whole;
}

function hunkWhere(h: Hunk): string {
  if (h.deleteCount === 0) return `insert at line ${String(h.start + 1)}`;
  if (h.deleteCount === 1) return `line ${String(h.start + 1)}`;
  return `lines ${String(h.start + 1)}-${String(h.start + h.deleteCount)}`;
}

function hunkBody(h: Hunk, baseLines: readonly string[]): string[] {
  return [
    ...baseLines.slice(h.start, h.start + h.deleteCount).map((l) => `- ${l}`),
    ...h.lines.map((l) => `+ ${l}`),
  ];
}

/**
 * Compact text form of a delta: a header, then the baseline lines to remove (`- `) and the lines
 * to add (`+ `) in place of them. Line numbers are 1-based baseline lines. Several separate
 * changes print one `@ <where>` header per hunk.
 */
export function formatDeltaText(d: Delta, baseLines: readonly string[]): string {
  const { startLine, deleteCount, lines } = d.treeChange;
  const rev = `revision ${String(d.baseRevision)} → ${String(d.revision)}`;
  if (deleteCount === 0 && lines.length === 0) return `delta (${rev}, no line changes)`;
  const hunks = spliceHunks(baseLines, { startLine, deleteCount, lines });
  const [only] = hunks;
  if (hunks.length === 1 && only) {
    return [`delta (${rev}, ${hunkWhere(only)})`, ...hunkBody(only, baseLines)].join('\n');
  }
  return [
    `delta (${rev}, ${String(hunks.length)} changes)`,
    ...hunks.flatMap((h) => [`@ ${hunkWhere(h)}`, ...hunkBody(h, baseLines)]),
  ].join('\n');
}

/** `unchanged (revision N)` is the plain-text form of an unchanged result. */
export function formatUnchanged(u: Unchanged): string {
  return `unchanged (revision ${String(u.revision)})`;
}

/**
 * What to return for `--delta`: `unchanged`, a `delta`, or undefined when the full tree should
 * be sent (different document or URL, or the delta would not be smaller than the tree).
 */
export function computeDelta(
  base: Baseline,
  next: { lines: string[]; refs: RefSummary; url: string; doc: string | undefined },
  revision: number,
): Delta | Unchanged | undefined {
  if (base.url !== next.url || base.doc !== next.doc) return undefined;
  const splice = diffLines(base.lines, next.lines);
  const changes = diffRefs(base.refs, next.refs);
  if (!splice && changes.length === 0) {
    return { baseRevision: base.revision, kind: 'unchanged', revision };
  }
  const delta: Delta = {
    baseRevision: base.revision,
    changes,
    kind: 'delta',
    revision,
    treeChange: {
      deleteCount: splice?.deleteCount ?? 0,
      lines: splice?.lines ?? [],
      startLine: splice?.startLine ?? 0,
    },
  };
  // A delta that is not shorter than the tree is no help (upstream behaves the same).
  return formatDeltaText(delta, base.lines).length < next.lines.join('\n').length
    ? delta
    : undefined;
}

// ---------------------------------------------------------------------------
// Baselines (in memory only: the session-storage quota rules out persisting them)
// ---------------------------------------------------------------------------

const baselines = new Map<string, Baseline>();
const revisions = new Map<number, number>();

export const baselineKey = (tabId: number, optionKey: string): string =>
  `${String(tabId)}:${optionKey}`;
export const getBaseline = (key: string): Baseline | undefined => baselines.get(key);
export const setBaseline = (key: string, b: Baseline): void => void baselines.set(key, b);

/** Next revision for the tab; shared by all option keys, like upstream. */
export function nextRevision(tabId: number): number {
  const n = (revisions.get(tabId) ?? 0) + 1;
  revisions.set(tabId, n);
  return n;
}

export function forgetBaselines(tabId: number): void {
  forgetCaptures(tabId);
  revisions.delete(tabId);
  for (const k of [...baselines.keys()]) if (k.startsWith(`${String(tabId)}:`)) baselines.delete(k);
}
