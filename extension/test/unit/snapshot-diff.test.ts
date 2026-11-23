import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Baseline,
  baselineKey,
  computeDelta,
  diffLines,
  diffRefs,
  forgetBaselines,
  formatDelta,
  formatDeltaText,
  spliceHunks,
  unifiedDiff,
  stripRef,
  stripBoundaryLines,
  snapshotKey,
  formatUnifiedDiff,
  getLastSnapshot,
  setLastSnapshot,
  formatUnchanged,
  getBaseline,
  nextRevision,
  setBaseline,
} from '../../src/background/snapshot-diff';

const many = (n: number) =>
  Array.from({ length: n }, (_, i) => `- button "B${String(i)}" [ref=e${String(i + 1)}]`);
const refsOf = (lines: string[]) =>
  Object.fromEntries(
    lines.map((l) => {
      const m = /"(B\d+)" \[ref=(e\d+)\]/.exec(l);
      return [m?.[2] ?? '', { role: 'button', name: m?.[1] ?? '' }];
    }),
  );
const base = (lines: string[], extra: Partial<Baseline> = {}): Baseline => ({
  lines,
  refs: refsOf(lines),
  url: 'http://x/',
  doc: 'L1',
  revision: 4,
  ...extra,
});
const next = (lines: string[], extra: object = {}) => ({
  lines,
  refs: refsOf(lines),
  url: 'http://x/',
  doc: 'L1',
  ...extra,
});

describe('diffLines', () => {
  it('returns undefined for equal input', () => {
    expect(diffLines(['a', 'b'], ['a', 'b'])).toBeUndefined();
  });

  it('describes an insertion, a deletion and a replacement as one splice', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'b', 'c'])).toEqual({
      startLine: 1,
      deleteCount: 0,
      lines: ['x'],
    });
    expect(diffLines(['a', 'b', 'c'], ['a', 'c'])).toEqual({
      startLine: 1,
      deleteCount: 1,
      lines: [],
    });
    expect(diffLines(['a', 'b', 'c', 'd'], ['a', 'X', 'Y', 'd'])).toEqual({
      startLine: 1,
      deleteCount: 2,
      lines: ['X', 'Y'],
    });
  });

  it('handles empty sides and repeated lines without overlapping prefix and suffix', () => {
    expect(diffLines([], ['a'])).toEqual({ startLine: 0, deleteCount: 0, lines: ['a'] });
    expect(diffLines(['a'], [])).toEqual({ startLine: 0, deleteCount: 1, lines: [] });
    expect(diffLines(['a', 'a'], ['a', 'a', 'a'])).toEqual({
      startLine: 2,
      deleteCount: 0,
      lines: ['a'],
    });
  });

  it('applying the splice reproduces the new lines', () => {
    const a = ['1', '2', '3', '4', '5'];
    const b = ['1', '2', 'x', 'y', '5', '6'];
    const s = diffLines(a, b);
    if (!s) throw new Error('expected a splice');
    const out = [...a];
    out.splice(s.startLine, s.deleteCount, ...s.lines);
    expect(out).toEqual(b);
  });
});

describe('diffRefs', () => {
  it('reports add, remove and name/role replacements ordered by ref number', () => {
    const a = {
      e2: { role: 'button', name: 'A' },
      e10: { role: 'link', name: 'Gone' },
      e3: { role: 'button', name: 'Old' },
    };
    const b = {
      e2: { role: 'button', name: 'A' },
      e3: { role: 'button', name: 'New' },
      e11: { role: 'textbox', name: 'In' },
    };
    expect(diffRefs(a, b)).toEqual([
      { field: 'name', op: 'replace', ref: '@e3', value: 'New' },
      { op: 'remove', ref: '@e10' },
      { node: { name: 'In', role: 'textbox' }, op: 'add', ref: '@e11' },
    ]);
  });

  it('is empty when nothing changed', () => {
    expect(diffRefs({ e1: { role: 'a', name: 'b' } }, { e1: { role: 'a', name: 'b' } })).toEqual(
      [],
    );
  });
});

describe('computeDelta', () => {
  const lines = many(30);

  it('says unchanged with the baseline revision', () => {
    const r = computeDelta(base(lines), next(lines), 5);
    expect(r).toEqual({ baseRevision: 4, kind: 'unchanged', revision: 5 });
    expect(formatUnchanged(r as never)).toBe('unchanged (revision 5)');
  });

  it('returns a delta with the ref changes and an exact splice', () => {
    const changed = [...lines.slice(0, 10), '- button "NEW" [ref=e99]', ...lines.slice(10)];
    const r = computeDelta(
      base(lines),
      next(changed, { refs: { ...refsOf(lines), e99: { role: 'button', name: 'NEW' } } }),
      5,
    );
    expect(r).toEqual({
      baseRevision: 4,
      changes: [{ node: { name: 'NEW', role: 'button' }, op: 'add', ref: '@e99' }],
      kind: 'delta',
      revision: 5,
      treeChange: { deleteCount: 0, lines: ['- button "NEW" [ref=e99]'], startLine: 10 },
    });
    // keys print in upstream's sorted order
    expect(Object.keys(JSON.parse(formatDelta(r as never)) as object)).toEqual([
      'baseRevision',
      'changes',
      'kind',
      'revision',
      'treeChange',
    ]);
  });

  it('sends the full tree (undefined) when the URL or document changed', () => {
    expect(computeDelta(base(lines), next(lines, { url: 'http://x/#a' }), 5)).toBeUndefined();
    expect(computeDelta(base(lines), next(lines, { doc: 'L2' }), 5)).toBeUndefined();
  });

  it('sends the full tree when the delta is not smaller than the tree', () => {
    const small = ['- button "A" [ref=e1]'];
    expect(computeDelta(base(small), next(['- button "B" [ref=e2]']), 5)).toBeUndefined();
  });
});

describe('baselines', () => {
  beforeEach(() => {
    forgetBaselines(1);
    forgetBaselines(2);
  });

  it('keeps one baseline per tab and option key and one revision counter per tab', () => {
    const k1 = baselineKey(1, '{"interactive":true}');
    const k2 = baselineKey(1, '{}');
    setBaseline(k1, base(['a']));
    expect(getBaseline(k1)).toBeDefined();
    expect(getBaseline(k2)).toBeUndefined();
    expect([nextRevision(1), nextRevision(1), nextRevision(2)]).toEqual([1, 2, 1]);
  });

  it('forgetBaselines drops one tab only and restarts its revisions', () => {
    setBaseline(baselineKey(1, 'a'), base(['a']));
    setBaseline(baselineKey(2, 'a'), base(['a']));
    nextRevision(1);
    forgetBaselines(1);
    expect(getBaseline(baselineKey(1, 'a'))).toBeUndefined();
    expect(getBaseline(baselineKey(2, 'a'))).toBeDefined();
    expect(nextRevision(1)).toBe(1);
    // tab 12 must not be mistaken for tab 1
    setBaseline(baselineKey(12, 'a'), base(['a']));
    forgetBaselines(1);
    expect(getBaseline(baselineKey(12, 'a'))).toBeDefined();
    forgetBaselines(12);
  });
});

describe('formatDeltaText', () => {
  const d = (startLine: number, deleteCount: number, lines: string[]) => ({
    baseRevision: 4,
    changes: [],
    kind: 'delta' as const,
    revision: 5,
    treeChange: { deleteCount, lines, startLine },
  });
  const baseLines = ['- a', '  - b [ref=e1]', '    - c', '- d'];

  it('prints removed and added lines with indentation kept', () => {
    expect(formatDeltaText(d(1, 2, ['  - x [ref=e9]']), baseLines)).toBe(
      'delta (revision 4 → 5, lines 2-3)\n-   - b [ref=e1]\n-     - c\n+   - x [ref=e9]',
    );
  });

  it('describes a single line, a pure insertion and a pure removal', () => {
    expect(formatDeltaText(d(0, 1, ['- z']), baseLines).split('\n')[0]).toContain(', line 1)');
    expect(formatDeltaText(d(3, 0, ['- z']), baseLines)).toBe(
      'delta (revision 4 → 5, insert at line 4)\n+ - z',
    );
    expect(formatDeltaText(d(3, 1, []), baseLines)).toBe('delta (revision 4 → 5, line 4)\n- - d');
  });

  it('splits separate edits into hunks and skips the unchanged lines between them', () => {
    const base = ['- s: a', '- l1', '- l2', '- l3', '- end'];
    const next = ['- s: ab', '- l1', '- l2', '- l3', '- end', '- new'];
    const splice = diffLines(base, next);
    expect(splice).toBeDefined();
    if (!splice) return;
    expect(spliceHunks(base, splice)).toEqual([
      { start: 0, deleteCount: 1, lines: ['- s: ab'] },
      { start: 5, deleteCount: 0, lines: ['- new'] },
    ]);
    expect(formatDeltaText(d(splice.startLine, splice.deleteCount, splice.lines), base)).toBe(
      'delta (revision 4 → 5, 2 changes)\n@ line 1\n- - s: a\n+ - s: ab\n@ insert at line 6\n+ - new',
    );
  });

  it('is shorter than the old JSON form for a small change', () => {
    const t = d(1, 1, ['  - x [ref=e9]']);
    expect(formatDeltaText(t, baseLines).length).toBeLessThan(formatDelta(t).length);
  });
});

describe('unifiedDiff (diff snapshot)', () => {
  it('matches upstream for a fully added tree', () => {
    const d = unifiedDiff([], ['- heading "A"', '- button "Go"']);
    expect(d).toEqual({
      additions: 2,
      changed: true,
      diff: '--- before\n+++ after\n@@ -0,0 +1,2 @@\n+- heading "A"\n+- button "Go"\n\\ No newline at end of file\n',
      removals: 0,
      unchanged: 0,
    });
    expect(formatUnifiedDiff(d)).toBe(`${d.diff}\n2 additions, 0 removals, 0 unchanged`);
  });

  it('prints a replaced line with context', () => {
    const d = unifiedDiff(
      ['- heading "A"', '- button "Old"', '- p', '  - T'],
      ['- heading "A"', '- button "Go"', '- p', '  - T'],
    );
    expect(d.diff).toBe(
      '--- before\n+++ after\n@@ -1,4 +1,4 @@\n - heading "A"\n-- button "Old"\n+- button "Go"\n - p\n   - T\n\\ No newline at end of file\n',
    );
    expect([d.additions, d.removals, d.unchanged]).toEqual([1, 1, 3]);
  });

  it('limits context to 3 lines and splits distant changes into hunks', () => {
    const a = many(20);
    const b = [...a];
    b[1] = '- changed1';
    b[17] = '- changed2';
    const d = unifiedDiff(a, b);
    expect(d.diff.match(/^@@/gm)).toHaveLength(2);
    expect(d.diff).toContain('@@ -1,5 +1,5 @@');
    expect(d.diff).toContain('@@ -15,6 +15,6 @@');
  });

  it('merges close changes and tracks the new-side offset', () => {
    const a = many(12);
    const b = [...a.slice(0, 2), '- x', '- y', ...a.slice(2, 4), ...a.slice(6)];
    // +2 lines at 3-4, then 2 lines removed (a[4], a[5]) within 6 lines: one hunk
    const d = unifiedDiff(a, b);
    expect(d.diff.match(/^@@/gm)).toHaveLength(1);
    expect([d.additions, d.removals]).toEqual([2, 2]);
  });

  it('reports no changes', () => {
    const d = unifiedDiff(['a', 'b'], ['a', 'b']);
    expect(d).toEqual({ additions: 0, changed: false, diff: '', removals: 0, unchanged: 2 });
    expect(formatUnifiedDiff(d)).toBe('✓ No changes detected');
  });

  it('stores the last snapshot per key and forgets it with the tab', () => {
    setLastSnapshot(baselineKey(9, 'k'), 'text');
    expect(getLastSnapshot(baselineKey(9, 'k'))).toBe('text');
    forgetBaselines(9);
    expect(getLastSnapshot(baselineKey(9, 'k'))).toBeUndefined();
  });
});

describe('unifiedDiff details', () => {
  const NOEOL = '\\ No newline at end of file';

  it('prints no end-of-file marker for a change in the middle', () => {
    const a = many(20);
    const b = [...a];
    b[10] = '- x';
    expect(unifiedDiff(a, b).diff).not.toContain(NOEOL);
  });

  it('prints the marker after both the removed and the added last line', () => {
    const d = unifiedDiff(['a', 'b', 'c'], ['a', 'b', 'd']).diff;
    expect(d).toBe(`--- before\n+++ after\n@@ -1,3 +1,3 @@\n a\n b\n-c\n${NOEOL}\n+d\n${NOEOL}\n`);
  });

  it('prints the marker once after a trailing context line', () => {
    const d = unifiedDiff(['a', 'b'], ['x', 'b']).diff;
    expect(d.match(/No newline/g)).toHaveLength(1);
    expect(d.endsWith(` b\n${NOEOL}\n`)).toBe(true);
  });

  it('handles everything removed (+0,0)', () => {
    const d = unifiedDiff(['a', 'b'], []);
    expect(d.diff).toBe(`--- before\n+++ after\n@@ -1,2 +0,0 @@\n-a\n-b\n${NOEOL}\n`);
    expect([d.additions, d.removals, d.unchanged]).toEqual([0, 2, 0]);
  });

  it('prints original lines (with refs) while comparing stripped ones', () => {
    const a = ['- button "Go" [ref=e2]', '- link "L" [ref=e3]'];
    const b = ['- button "Go" [ref=e9]', '- link "M" [ref=e10]'];
    const d = unifiedDiff(a.map(stripRef), b.map(stripRef), a, b);
    expect(d.diff).toContain(' - button "Go" [ref=e9]\n');
    expect(d.diff).toContain('-- link "L" [ref=e3]\n');
    expect(d.diff).toContain('+- link "M" [ref=e10]\n');
    expect([d.additions, d.removals, d.unchanged]).toEqual([1, 1, 1]);
  });

  it('finds the real changes in a large tree quickly', () => {
    const a = many(60_000);
    const b = [...a];
    b.splice(100, 1);
    b.splice(30_000, 0, '- new');
    b[59_000] = '- changed';
    const t = Date.now();
    const d = unifiedDiff(a, b);
    expect(Date.now() - t).toBeLessThan(2000);
    expect([d.additions, d.removals]).toEqual([2, 2]);
    expect(d.diff.match(/^@@/gm)).toHaveLength(3);
  });

  it('falls back to one hunk for a rewrite beyond the edit-distance cap', () => {
    const a = Array.from({ length: 4000 }, (_, i) => `a${String(i)}`);
    const b = Array.from({ length: 4000 }, (_, i) => `b${String(i)}`);
    const d = unifiedDiff(a, b);
    expect([d.additions, d.removals]).toEqual([4000, 4000]);
    expect(d.diff.match(/^@@/gm)).toHaveLength(1);
  });
});

describe('stripRef and friends', () => {
  it('drops ref=eN from the attribute group only', () => {
    expect(stripRef('- button "Go" [ref=e2]')).toBe('- button "Go"');
    expect(stripRef('  - heading "A" [level=1, ref=e1]')).toBe('  - heading "A" [level=1]');
    expect(stripRef('- link "x" [ref=e3, url=http://a/] clickable [onclick]: v')).toBe(
      '- link "x" [url=http://a/] clickable [onclick]: v',
    );
    expect(stripRef('- StaticText "see [ref=e5]"')).toBe('- StaticText "see [ref=e5]"');
    expect(stripRef('- button "a \\" [ref=e1]" [ref=e2]')).toBe('- button "a \\" [ref=e1]"');
  });

  it('removes boundary marker lines', () => {
    expect(
      stripBoundaryLines([
        '--- AGENT_BROWSER_PAGE_CONTENT nonce=ab origin=http://x/ ---',
        '- a',
        '--- END_AGENT_BROWSER_PAGE_CONTENT nonce=ab ---',
      ]),
    ).toEqual(['- a']);
  });

  it('snapshotKey keeps the old baselineKey string and adds the frame only when set', () => {
    const o = { interactive: true, compact: false, depth: 2, scope: 'main', urls: false };
    expect(snapshotKey(4, o)).toBe(
      baselineKey(
        4,
        JSON.stringify({ interactive: true, compact: false, depth: 2, scope: 'main', urls: false }),
      ),
    );
    expect(snapshotKey(4, o, 'F1')).not.toBe(snapshotKey(4, o));
  });

  it('keeps at most 8 option sets per tab', () => {
    for (let i = 0; i < 10; i++) setLastSnapshot(baselineKey(7, `k${String(i)}`), 't');
    expect(getLastSnapshot(baselineKey(7, 'k0'))).toBeUndefined();
    expect(getLastSnapshot(baselineKey(7, 'k9'))).toBe('t');
    forgetBaselines(7);
  });
});
