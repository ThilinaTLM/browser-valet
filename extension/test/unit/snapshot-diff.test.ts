import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Baseline,
  baselineKey,
  computeDelta,
  diffLines,
  diffRefs,
  forgetBaselines,
  formatDelta,
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
    const small = many(3);
    expect(
      computeDelta(base(small), next([...small, '- button "N" [ref=e50]']), 5),
    ).toBeUndefined();
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
