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
  return formatDelta(delta).length < next.lines.join('\n').length ? delta : undefined;
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
