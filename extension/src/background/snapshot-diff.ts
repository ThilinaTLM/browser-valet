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
// `diff snapshot`: unified diff in agent-browser's format
// ---------------------------------------------------------------------------

export interface UnifiedDiff {
  additions: number;
  changed: boolean;
  /** Unified diff text (empty when nothing changed). */
  diff: string;
  removals: number;
  unchanged: number;
}

function range(start0: number, count: number): string {
  if (count === 0) return `${String(start0)},0`;
  return count === 1 ? String(start0 + 1) : `${String(start0 + 1)},${String(count)}`;
}

const CONTEXT = 3;
/** Edit distance above which Myers is not run (memory is O(D²)); the middle becomes one hunk. */
const MAX_EDIT_DISTANCE = 3000;

const REF_ATTR = /^ref=e\d+$/;
// `- role`, an optional JSON-quoted name, then an optional `[attr, attr]` group (see snapshot.ts).
const LINE_ATTRS = /^(\s*- \S+(?: "(?:[^"\\]|\\.)*")?) \[([^\]]*)\]/;

/**
 * A snapshot line without its `ref=eN` attribute, so trees can be compared across reloads and
 * navigation (refs keep counting up). Same idea as agent-browser's `snapshot_comparison_text`.
 */
export function stripRef(line: string): string {
  const m = LINE_ATTRS.exec(line);
  if (!m) return line;
  const kept = (m[2] ?? '').split(', ').filter((x) => !REF_ATTR.test(x));
  const attrs = kept.length ? ` [${kept.join(', ')}]` : '';
  return `${m[1] ?? ''}${attrs}${line.slice(m[0].length)}`;
}

/** Remove bvl's content-boundary marker lines (a baseline saved with --content-boundaries). */
export function stripBoundaryLines(lines: string[]): string[] {
  return lines.filter(
    (l) =>
      !l.startsWith('--- AGENT_BROWSER_PAGE_CONTENT ') &&
      !l.startsWith('--- END_AGENT_BROWSER_PAGE_CONTENT '),
  );
}

/** Myers O(ND) diff of two line lists as hunks; undefined if the edit distance is too large. */
function myersHunks(a: readonly string[], b: readonly string[]): Hunk[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const off = max + 1;
  const v = new Int32Array(2 * off + 1);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2)); // index = k + d + 1
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[off + k - 1] ?? 0) < (v[off + k + 1] ?? 0))
          ? (v[off + k + 1] ?? 0)
          : (v[off + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return undefined;
  // Walk back, collecting single-line edits (x/y are positions in a/b before each edit).
  const edits: { del: boolean; x: number; y: number }[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const pv = trace[d] ?? v;
    const at = (k: number) => pv[k + d + 1] ?? 0;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    while (x > (down ? px : px + 1) && y > (down ? py + 1 : py)) {
      x--;
      y--;
    }
    edits.push(down ? { del: false, x: px, y: py } : { del: true, x: px, y: py });
    x = px;
    y = py;
  }
  edits.reverse();
  const hunks: Hunk[] = [];
  let cur: Hunk | undefined;
  let curEnd = -1;
  for (const e of edits) {
    // An edit continues the hunk when it starts where the previous one ended in `a`.
    if (!cur || e.x !== curEnd) {
      cur = { start: e.x, deleteCount: 0, lines: [] };
      hunks.push(cur);
    }
    if (e.del) {
      cur.deleteCount++;
      curEnd = e.x + 1;
    } else {
      cur.lines.push(b[e.y] ?? '');
      curEnd = e.x;
    }
  }
  return hunks;
}

/**
 * Unified diff of two line lists (`--- before` / `+++ after`, 3 lines of context) with the counts
 * agent-browser prints. `a` and `b` are what is compared (refs stripped); `shownA` and `shownB`
 * (same lengths, default `a` and `b`) are what is printed. A `\ No newline at end of file` line
 * follows a printed line that ends the old or new text, as `similar` prints it.
 */
export function unifiedDiff(
  a: readonly string[],
  b: readonly string[],
  shownA: readonly string[] = a,
  shownB: readonly string[] = b,
): UnifiedDiff {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  if (start === a.length && start === b.length) {
    return { additions: 0, changed: false, diff: '', removals: 0, unchanged: a.length };
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const inner = myersHunks(a.slice(start, endA), b.slice(start, endB));
  const hunks: Hunk[] = inner
    ? inner.map((h) => ({ ...h, start: h.start + start }))
    : [{ start, deleteCount: endA - start, lines: b.slice(start, endB) }];
  const removals = hunks.reduce((n, h) => n + h.deleteCount, 0);
  const additions = hunks.reduce((n, h) => n + h.lines.length, 0);
  // `lines` holds stripped text; printing uses the shown arrays by index.
  const bIndexAt = (h: Hunk, shift: number) => h.start + shift;
  // Group hunks whose gap is small enough for their context to meet.
  const groups: Hunk[][] = [];
  for (const h of hunks) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (last && prev && h.start - (prev.start + prev.deleteCount) <= 2 * CONTEXT) last.push(h);
    else groups.push([h]);
  }
  const out = ['--- before', '+++ after'];
  const NO_EOL = '\\ No newline at end of file';
  let shift = 0; // new line index - old line index before the current hunk
  for (const g of groups) {
    const first = g[0];
    const end = g[g.length - 1];
    if (!first || !end) continue;
    const from = Math.max(0, first.start - CONTEXT);
    const to = Math.min(a.length, end.start + end.deleteCount + CONTEXT);
    const groupShift = shift;
    const body: string[] = [];
    const context = (i: number) => {
      const bi = i + shift;
      body.push(` ${shownB[bi] ?? shownA[i] ?? ''}`);
      if (i === a.length - 1 && bi === b.length - 1) body.push(NO_EOL);
    };
    let at = from;
    let oldCount = 0;
    let newCount = 0;
    for (const h of g) {
      for (; at < h.start; at++) {
        context(at);
        oldCount++;
        newCount++;
      }
      for (let i = 0; i < h.deleteCount; i++) {
        body.push(`-${shownA[h.start + i] ?? ''}`);
        if (h.start + i === a.length - 1) body.push(NO_EOL);
      }
      h.lines.forEach((l, i) => {
        const bi = bIndexAt(h, shift) + i;
        body.push(`+${shownB[bi] ?? l}`);
        if (bi === b.length - 1) body.push(NO_EOL);
      });
      at = h.start + h.deleteCount;
      oldCount += h.deleteCount;
      newCount += h.lines.length;
      shift += h.lines.length - h.deleteCount;
    }
    for (; at < to; at++) {
      context(at);
      oldCount++;
      newCount++;
    }
    out.push(`@@ -${range(from, oldCount)} +${range(from + groupShift, newCount)} @@`, ...body);
  }
  return {
    additions,
    changed: true,
    diff: `${out.join('\n')}\n`,
    removals,
    unchanged: a.length - removals,
  };
}

/** The text printed for a diff: the diff, a blank line, then the counts. */
export function formatUnifiedDiff(d: UnifiedDiff): string {
  if (!d.changed) return '✓ No changes detected';
  return `${d.diff}\n${String(d.additions)} additions, ${String(d.removals)} removals, ${String(d.unchanged)} unchanged`;
}

// ---------------------------------------------------------------------------
// Baselines (in memory only: the session-storage quota rules out persisting them)
// ---------------------------------------------------------------------------

const baselines = new Map<string, Baseline>();
const revisions = new Map<number, number>();
/** Last snapshot text per tab and option set, for `diff snapshot` (any snapshot updates it). */
const lastSnapshots = new Map<string, string>();

export const getLastSnapshot = (key: string): string | undefined => lastSnapshots.get(key);
/** Option sets remembered per tab; the least recently written one is dropped beyond this. */
const MAX_LAST_PER_TAB = 8;
export function setLastSnapshot(key: string, text: string): void {
  lastSnapshots.delete(key);
  lastSnapshots.set(key, text);
  const prefix = key.slice(0, key.indexOf(':') + 1);
  const mine = [...lastSnapshots.keys()].filter((k) => k.startsWith(prefix));
  for (const k of mine.slice(0, Math.max(0, mine.length - MAX_LAST_PER_TAB))) {
    lastSnapshots.delete(k);
  }
}

export const baselineKey = (tabId: number, optionKey: string): string =>
  `${String(tabId)}:${optionKey}`;
/**
 * Baseline key for a snapshot's option set; the same for `snapshot` and `diff snapshot`. The
 * frame scope is part of the key only when one is set, so keys without a frame are unchanged.
 */
export const snapshotKey = (
  tabId: number,
  o: {
    interactive: boolean;
    compact: boolean;
    depth: number | undefined;
    scope: string | undefined;
    urls: boolean;
  },
  frameId?: string,
): string =>
  baselineKey(
    tabId,
    JSON.stringify({
      interactive: o.interactive,
      compact: o.compact,
      depth: o.depth,
      scope: o.scope,
      urls: o.urls,
      ...(frameId ? { frame: frameId } : {}),
    }),
  );
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
  const prefix = `${String(tabId)}:`;
  for (const k of [...baselines.keys()]) if (k.startsWith(prefix)) baselines.delete(k);
  for (const k of [...lastSnapshots.keys()]) if (k.startsWith(prefix)) lastSnapshots.delete(k);
}
