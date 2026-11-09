// Snapshot refs: stable within a document, monotonic across navigations; clickable elements;
// --delta. Fixtures: form.html, other.html, clickable.html.

import { describe, expect, it } from 'vitest';
import { bctl, bctlJson, fixture, useBrowser } from './harness';

useBrowser();

const refOf = (snapshot: string, re: RegExp): string => {
  const line = snapshot.split('\n').find((l) => re.test(l));
  const ref = /ref=(e\d+)/.exec(line ?? '')?.[1];
  if (!ref) throw new Error(`No ref for ${re} in:\n${snapshot}`);
  return ref;
};
const num = (ref: string) => Number(ref.slice(1));

describe('stable refs', () => {
  it('keeps a ref for the same element across snapshots, -i and full', async () => {
    await bctl('open', fixture('/form.html'));
    const first = (await bctl('snapshot', '-i')).stdout;
    const inc = refOf(first, /button "Increment"/);
    const name = refOf(first, /textbox "Name"/);

    // New element before the others must not shift the existing refs.
    await bctl(
      'eval',
      `document.body.insertAdjacentHTML('afterbegin', '<button id="late">Late</button>')`,
    );
    const second = (await bctl('snapshot', '-i')).stdout;
    expect(refOf(second, /button "Increment"/)).toBe(inc);
    expect(refOf(second, /textbox "Name"/)).toBe(name);
    expect(num(refOf(second, /button "Late"/))).toBeGreaterThan(num(inc));

    const full = (await bctl('snapshot')).stdout;
    expect(refOf(full, /button "Increment"/)).toBe(inc);
    expect(refOf(full, /button "Late"/)).toBe(refOf(second, /button "Late"/));
  });

  it('old refs fail after navigation and new refs continue upwards', async () => {
    await bctl('open', fixture('/form.html'));
    const before = (await bctl('snapshot', '-i')).stdout;
    const inc = refOf(before, /button "Increment"/);
    const highest = Math.max(...[...before.matchAll(/ref=e(\d+)/g)].map((m) => Number(m[1])));

    await bctl('open', fixture('/other.html'));
    const stale = await bctl('click', `@${inc}`);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain(`Unknown ref: ${inc}`);

    const after = (await bctl('snapshot', '-i')).stdout;
    expect(num(refOf(after, /button "Do nothing"/))).toBeGreaterThan(highest);
  });

  it('a reload also invalidates refs', async () => {
    await bctl('open', fixture('/form.html'));
    const snap = (await bctl('snapshot', '-i')).stdout;
    const inc = refOf(snap, /button "Increment"/);
    await bctl('reload');
    expect((await bctl('click', `@${inc}`)).stderr).toContain('Unknown ref');
    const again = (await bctl('snapshot', '-i')).stdout;
    expect(num(refOf(again, /button "Increment"/))).toBeGreaterThan(num(inc));
  });
});

describe('clickable elements', () => {
  it('gives div/span clickables a ref and a clickable suffix; -i lifts the text', async () => {
    await bctl('open', fixture('/clickable.html'));
    const snap = (await bctl('snapshot', '-i')).stdout;
    expect(snap).toContain('generic "Clickable div" [ref=');
    expect(snap).toMatch(/"Clickable div" \[ref=e\d+\] clickable \[cursor:pointer, onclick\]/);
    expect(snap).toMatch(/"Pointer only inner span" \[ref=e\d+\] clickable \[cursor:pointer\]/);
    expect(snap).toMatch(/"Tab zero" \[ref=e\d+\] focusable \[tabindex\]/);
    expect(snap).toMatch(
      /"all three" \[ref=e\d+\] clickable \[cursor:pointer, onclick, tabindex\]/,
    );
    expect(snap).toMatch(/"btn onclick span" \[ref=e\d+\] clickable \[onclick\]/);
    // inherited pointer, tabindex=-1, hidden and empty elements are not listed
    expect(snap).not.toContain('"inner span"');
    expect(snap).not.toContain('Tab minus');
    expect(snap).not.toContain('hidden clickable');
    expect(snap).not.toMatch(/generic \[ref=e\d+\] clickable/);
    // natively interactive elements get no suffix
    expect(snap).toMatch(/button "Btn[^\n]*\[ref=e\d+\]\n/);
    expect(snap).toMatch(/link "Link in link" \[ref=e\d+\]\n/);

    // the full snapshot keeps the text as children and shares the refs
    const full = (await bctl('snapshot')).stdout;
    const div = refOf(snap, /"Clickable div"/);
    expect(full).toContain(
      `generic [ref=${div}] clickable [cursor:pointer, onclick]\n  - StaticText "Clickable div"`,
    );
  });

  it('a clickable div can be clicked through its ref', async () => {
    await bctl('open', fixture('/clickable.html'));
    const div = refOf((await bctl('snapshot', '-i')).stdout, /"Clickable div"/);
    expect((await bctl('click', `@${div}`)).code).toBe(0);
    expect((await bctl('eval', 'window.hits.join(",")')).stdout).toContain('a');
  });
});

describe('snapshot --json', () => {
  it('returns origin, title, refs, removedRefs and snapshot', async () => {
    await bctl('open', fixture('/form.html'));
    await bctl('snapshot', '-i');
    const r = await bctlJson('snapshot', '-i');
    const d = r.data as Record<string, unknown>;
    expect(Object.keys(d).sort()).toEqual(['origin', 'refs', 'removedRefs', 'snapshot', 'title']);
    expect(d.origin).toBe(fixture('/form.html'));
    expect(d.title).toBe('Fixture Form');
    expect(d.removedRefs).toEqual([]);
    expect(Object.values(d.refs as object)).toContainEqual({ role: 'button', name: 'Increment' });
    expect(typeof d.snapshot).toBe('string');
  });

  it('reports refs that left the page in removedRefs', async () => {
    await bctl('open', fixture('/form.html'));
    const snap = (await bctl('snapshot')).stdout;
    const inc = refOf(snap, /button "Increment"/);
    await bctl('eval', `document.getElementById('inc').remove()`);
    const d = (await bctlJson('snapshot')).data as { removedRefs: string[]; refs: object };
    expect(d.removedRefs).toContain(inc);
    expect(d.refs).not.toHaveProperty(inc);
    expect((await bctl('snapshot')).stdout).not.toContain(`ref=${inc}`);
    expect((await bctlJson('snapshot')).data).toMatchObject({ removedRefs: [] });
  });
});

describe('snapshot --delta', () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => `<button>Row ${String(i)}</button>`).join('');

  async function openList(): Promise<void> {
    await bctl('open', fixture('/form.html'));
    await bctl(
      'eval',
      `document.body.insertAdjacentHTML('beforeend', '<div id="list">${rows(30)}</div>')`,
    );
  }
  const delta = async (...a: string[]) => bctl('snapshot', '-i', '--delta', ...a);

  it('first call prints the tree, then unchanged, then a delta with ref changes', async () => {
    await openList();
    const first = await delta();
    expect(first.stdout).toContain('button "Row 29"');
    expect(first.stdout.trimStart().startsWith('{')).toBe(false);

    const same = await delta();
    expect(same.stdout.trim()).toMatch(/^unchanged \(revision \d+\)$/);

    await bctl(
      'eval',
      `document.querySelectorAll('#list button')[10].insertAdjacentHTML('afterend','<button>Added</button>')`,
    );
    const d = JSON.parse((await delta()).stdout) as {
      kind: string;
      baseRevision: number;
      revision: number;
      changes: { op: string; ref: string; node?: { name: string; role: string } }[];
      treeChange: { startLine: number; deleteCount: number; lines: string[] };
    };
    expect(d.kind).toBe('delta');
    expect(d.revision).toBe(d.baseRevision + 1);
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0]).toMatchObject({ op: 'add', node: { name: 'Added', role: 'button' } });
    expect(d.treeChange.deleteCount).toBe(0);
    expect(d.treeChange.lines).toEqual([`- button "Added" [ref=${d.changes[0]?.ref.slice(1)}]`]);
    expect(d.treeChange.startLine).toBeGreaterThan(10);

    await bctl('eval', `document.querySelectorAll('#list button')[3].remove()`);
    const rm = JSON.parse((await delta()).stdout) as { changes: { op: string }[] };
    expect(rm.changes).toMatchObject([{ op: 'remove' }]);
  });

  it('--json shapes: unchanged and delta carry origin and a snapshot object', async () => {
    await openList();
    await delta();
    const un = (await bctlJson('snapshot', '-i', '--delta')).data as {
      origin: string;
      snapshot: { kind: string; baseRevision: number; revision: number };
    };
    expect(un.origin).toBe(fixture('/form.html'));
    expect(un.snapshot).toMatchObject({ kind: 'unchanged' });
    expect(un.snapshot.revision).toBe(un.snapshot.baseRevision + 1);

    await bctl('eval', `document.querySelectorAll('#list button')[0].textContent = 'Renamed'`);
    const d = (await bctlJson('snapshot', '-i', '--delta')).data as {
      snapshot: { kind: string; changes: object[] };
    };
    expect(d.snapshot.kind).toBe('delta');
    expect(d.snapshot.changes).toMatchObject([{ field: 'name', op: 'replace', value: 'Renamed' }]);
  });

  it('--full returns the tree and resets the baseline; option sets have separate baselines', async () => {
    await openList();
    await delta();
    const full = await bctl('snapshot', '-i', '--delta', '--full');
    expect(full.stdout).toContain('button "Row 0"');
    expect(full.stdout).not.toContain('unchanged');
    const j = (await bctlJson('snapshot', '-i', '--full')).data as {
      snapshot: { kind: string; revision: number; tree: string; refs: object };
    };
    expect(j.snapshot.kind).toBe('full');
    expect(j.snapshot.tree).toContain('Row 0');
    expect(Object.keys(j.snapshot.refs).length).toBeGreaterThan(30);
    // a different option set has no baseline yet
    expect((await bctl('snapshot', '--delta')).stdout).toContain('heading "Fixture Form"');
    expect((await bctl('snapshot', '--delta')).stdout).toContain('unchanged');
  });

  it('a URL or document change returns the full tree', async () => {
    await openList();
    await delta();
    await bctl('eval', `location.hash = '#moved'`);
    expect((await delta()).stdout).toContain('button "Row 29"');
    await bctl('open', fixture('/other.html'));
    const after = (await delta()).stdout;
    expect(after).toContain('button "Do nothing"');
    expect(after).not.toContain('"kind"');
  });

  it('plain snapshots do not disturb the baseline', async () => {
    await openList();
    await delta();
    await bctl('snapshot', '-i');
    expect((await delta()).stdout).toMatch(/^unchanged/);
  });
});
