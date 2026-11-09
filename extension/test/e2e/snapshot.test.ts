// Snapshot refs: stable within a document, monotonic across navigations; clickable elements;
// --delta. Fixtures: form.html, other.html, clickable.html.

import { describe, expect, it } from 'vitest';
import { bctl, fixture, useBrowser } from './harness';

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
