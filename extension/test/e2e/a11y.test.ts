// `a11y`: the axe-core audit, with a same-site and an out-of-process iframe, a strict CSP and a
// page that owns `window.axe`. Fixtures: a11y*.html.

import { describe, expect, it } from 'vitest';
import { bvl, bvlJson, crossFixture, fixture, useBrowser } from './harness';

useBrowser();

interface Node {
  target: (string | string[])[];
  html: string;
  ref?: string;
}
interface Rule {
  id: string;
  impact: string;
  nodeCount: number;
  nodes: Node[];
}
interface Data {
  axeVersion: string;
  url: string;
  counts: { violations: number };
  violations: Rule[];
  incomplete: Rule[];
}

const page = (inner = crossFixture('/a11y-inner.html')) =>
  `${fixture('/a11y.html')}?inner=${encodeURIComponent(inner)}`;

async function audit(...args: string[]): Promise<Data> {
  // The iframe loads after the page: retry until its violation shows up when asked to.
  const r = await bvlJson('a11y', ...args);
  expect(r.success, String(r.error)).toBe(true);
  return r.data as Data;
}

const ids = (d: Data) => d.violations.map((v) => v.id);

describe('a11y', () => {
  it('finds the known violations, including the one in a cross-origin iframe', async () => {
    expect((await bvl('open', page())).code).toBe(0);
    let d = await audit();
    for (
      let i = 0;
      i < 20 && !d.violations.some((v) => v.nodes.some((n) => n.target.length > 1));
      i++
    ) {
      await new Promise((r) => setTimeout(r, 250));
      d = await audit();
    }
    const byId = new Map(d.violations.map((v) => [v.id, v]));
    expect(ids(d)).toEqual(expect.arrayContaining(['image-alt', 'label']));
    const contrast = [...d.violations, ...d.incomplete].find((v) => v.id === 'color-contrast');
    expect(contrast?.nodes.map((n) => n.target.flat().join())).toContain('#low');
    expect(byId.get('label')?.nodes.map((n) => n.target.flat().join())).toContain('#unlabelled');
    const imgs = byId.get('image-alt');
    const targets = imgs?.nodes.map((n) => n.target);
    expect(targets).toContainEqual(['#noalt']);
    // the iframe violation keeps its frame selector path
    expect(targets).toContainEqual(['#inner', '#inner-img']);
    expect(d.counts.violations).toBe(d.violations.length);
    expect(d.axeVersion).toMatch(/^\d+\.\d+/);
    // violations come most severe first
    const order = ['critical', 'serious', 'moderate', 'minor'];
    const ranks = d.violations.map((v) => order.indexOf(v.impact));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('prints text grouped by impact, with refs from the last snapshot', async () => {
    await bvl('open', page());
    for (let i = 0; i < 20; i++) {
      if ((await bvl('a11y')).stdout.includes('#inner >> #inner-img')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const snap = (await bvl('snapshot')).stdout;
    expect(snap).toContain('Go');
    const r = await bvl('a11y');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^url: http:\/\/127\.0\.0\.1:\d+\/a11y\.html/);
    expect(r.stdout).toMatch(/axe-core: \d+\.\d+\.\d+ {2}violations: \d+/);
    expect(r.stdout).toMatch(/\[critical\] image-alt: .*\(\d+ nodes?\)/);
    expect(r.stdout).toContain('https://dequeuniversity.com/rules/axe/');
    expect(r.stdout).toContain('#inner >> #inner-img');
    // the unlabelled textbox is in the snapshot, so its node carries the ref
    const refd = (await audit()).violations
      .find((v) => v.id === 'label')
      ?.nodes.find((n) => n.target[0] === '#unlabelled');
    const ref = /textbox.*\[ref=(e\d+)\]/.exec(snap)?.[1];
    expect(ref).toBeTruthy();
    expect(refd?.ref).toBe(ref);
    expect(r.stdout).toContain(`#unlabelled @${ref ?? ''}`);
  });

  it('--tags and --selector narrow the audit', async () => {
    await bvl('open', page());
    const tagged = await audit('--tags', 'wcag2a');
    expect(
      tagged.violations.every((v) => (v as unknown as { tags: string[] }).tags.includes('wcag2a')),
    ).toBe(true);
    const scoped = await audit('--selector', '#other');
    expect(ids(scoped)).toEqual(['image-alt']);
    expect(scoped.violations[0]?.nodes.map((n) => n.target.flat().join())).toEqual(['#other-img']);
    const none = await bvl('a11y', '--selector', '#nope');
    expect(none.code).not.toBe(0);
    expect(none.stderr).toContain('No element matches selector: #nope');
  });

  it('leaves window.axe alone: undefined after the audit, and a page-owned one is kept', async () => {
    await bvl('open', page());
    await audit();
    expect((await bvl('eval', 'typeof window.axe')).stdout).toContain('undefined');

    await bvl('open', fixture('/a11y-own-axe.html'));
    const d = await audit();
    expect(ids(d)).toContain('image-alt');
    const mine = await bvl('eval', 'JSON.stringify([window.axe.mine, window.axe.run()])');
    expect(mine.stdout).toContain('[true,\\"page-owned\\"]');
  });

  it('works on a page with a strict CSP', async () => {
    await bvl('open', fixture('/a11y-csp.html'));
    const d = await audit();
    expect(ids(d)).toContain('image-alt');
  });

  it('a11y <url> opens the page first', async () => {
    const r = await bvlJson('a11y', fixture('/a11y-csp.html'));
    expect(r.success).toBe(true);
    expect((r.data as Data).url).toContain('/a11y-csp.html');
  });
});
