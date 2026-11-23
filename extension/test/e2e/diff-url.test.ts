// diff url: two fixtures with a known difference (diff-a.html / diff-b.html), agent tab only.

import { afterAll, describe, expect, it } from 'vitest';
import {
  approveNextConsent,
  bvl,
  bvlJson,
  fixture,
  openUserTab,
  setGuardrails,
  tidForTitle,
  useBrowser,
} from './harness';

useBrowser();

afterAll(async () => {
  await setGuardrails({});
  await bvl('close');
});

interface UrlDiff {
  diff: Record<string, unknown> & { diff: string };
  url1: string;
  url2: string;
  snapshot1: string;
  snapshot2: string;
  screenshot?: Record<string, unknown>;
}

describe('diff url', () => {
  it('diffs the snapshots of two pages and leaves the tab on the second', async () => {
    await bvl('close');
    const r = await bvl('diff', 'url', fixture('/diff-a.html'), fixture('/diff-b.html'));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^Snapshot diff:\n--- before\n\+\+\+ after\n/);
    expect(r.stdout).toContain('-- heading "Release notes" [');
    expect(r.stdout).toContain('+- heading "Release notes v2" [');
    expect(r.stdout).toContain('Changelog');
    expect(r.stdout).toMatch(/\d+ additions, \d+ removals, \d+ unchanged/);
    expect(r.stdout).not.toContain('Screenshot diff');
    expect((await bvl('get', 'title')).stdout).toBe('Diff B\n');

    const j = (await bvlJson('diff', 'url', fixture('/diff-a.html'), fixture('/diff-b.html')))
      .data as UrlDiff;
    expect(Object.keys(j).sort()).toEqual(['diff', 'snapshot1', 'snapshot2', 'url1', 'url2']);
    expect(j.url1).toBe(fixture('/diff-a.html'));
    expect(j.diff).toMatchObject({ changed: true, identical: false });
    expect(j.diff.removals).toBe(j.diff.deletions);
    expect(j.snapshot1).toMatch(/ref=e\d+/);

    // the same page twice: refs differ between loads but nothing else does
    const same = (await bvl('diff', 'url', fixture('/diff-a.html'), fixture('/diff-a.html')))
      .stdout;
    expect(same).toBe('Snapshot diff:\n✓ No changes detected\n');
  });

  it('with --screenshot adds the pixel diff and writes a diff image', async () => {
    const r = await bvl(
      'diff',
      'url',
      fixture('/diff-a.html'),
      fixture('/diff-b.html'),
      '--screenshot',
      '--wait-until',
      'networkidle',
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(
      /\n\nScreenshot diff:\n✗ [\d.]+% pixels differ\n {2}Diff image: .*\.png\n/,
    );
    const j = (
      await bvlJson(
        'diff',
        'url',
        fixture('/diff-a.html'),
        fixture('/diff-b.html'),
        '--screenshot',
        '--full',
      )
    ).data as UrlDiff;
    expect(j.screenshot).toMatchObject({ match: false });
    expect(j.screenshot?.differentPixels).toBeGreaterThan(0);
    // identical pages match
    const m = (
      await bvlJson('diff', 'url', fixture('/diff-a.html'), fixture('/diff-a.html'), '--screenshot')
    ).data as UrlDiff;
    expect(m.screenshot).toMatchObject({ match: true, differentPixels: 0, diffPath: null });
  });

  it('rejects bad arguments', async () => {
    const a = fixture('/diff-a.html');
    for (const args of [[a], [a, a, a], [a, a, '--wait-until', 'soon'], [a, a, '-d', 'x']]) {
      const r = await bvl('diff', 'url', ...args, '--json');
      expect(JSON.parse(r.stdout), args.join(' ')).toMatchObject({
        success: false,
        code: 'bad_args',
      });
    }
  });

  it('checks both URLs against --allowed-domains before navigating', async () => {
    await bvl('close');
    await bvl('open', fixture('/prose.html'));
    const other = fixture('/diff-b.html').replace('127.0.0.1', 'localhost');
    for (const args of [
      [fixture('/diff-a.html'), other],
      [other, fixture('/diff-a.html')],
    ]) {
      const r = await bvl('diff', 'url', ...args, '--allowed-domains', '127.0.0.1', '--json');
      expect(JSON.parse(r.stdout)).toMatchObject({ success: false, code: 'domain_blocked' });
    }
    // not even the allowed first URL was loaded
    expect((await bvl('get', 'title')).stdout).toBe('Prose\n');
    await setGuardrails({ allowedDomains: ['127.0.0.1'] });
    const r = await bvl('diff', 'url', fixture('/diff-a.html'), other, '--json');
    expect(JSON.parse(r.stdout)).toMatchObject({ success: false, code: 'domain_blocked' });
    expect((await bvl('get', 'title')).stdout).toBe('Prose\n');
  });

  it('never navigates a tab the user shared', async () => {
    await bvl('close');
    const page = await openUserTab(fixture('/prose.html'));
    try {
      const tid = await tidForTitle('Prose');
      const pending = bvl('tab', tid);
      await approveNextConsent('allow');
      expect((await pending).code).toBe(0);

      const r = await bvl('diff', 'url', fixture('/diff-a.html'), fixture('/diff-b.html'));
      expect(r.code).toBe(0);
      expect(page.url()).toBe(fixture('/prose.html'));
      expect((await bvl('get', 'title')).stdout).toBe('Diff B\n');
      expect((await bvl('tab', 'list')).stdout).toContain('Prose');
    } finally {
      await page.close();
      await bvl('close');
    }
  });
});
