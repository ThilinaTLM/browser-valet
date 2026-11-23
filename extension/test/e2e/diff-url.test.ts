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

  it('leaves the baselines on <u2>: diff snapshot and diff screenshot compare with it', async () => {
    await bvl('close');
    const j = (
      await bvlJson('diff', 'url', fixture('/diff-a.html'), fixture('/diff-b.html'), '--screenshot')
    ).data as UrlDiff;
    expect((await bvl('diff', 'snapshot')).stdout).toBe('✓ No changes detected\n');
    expect((await bvlJson('diff', 'screenshot')).data).toMatchObject({ match: true });

    // refs of <u2> work, those of <u1> are from a previous page
    const ref = (snap: string) => /button "Save" \[ref=(e\d+)\]/.exec(snap)?.[1] ?? '';
    expect(ref(j.snapshot1)).not.toBe(ref(j.snapshot2));
    expect((await bvl('get', 'text', `@${ref(j.snapshot2)}`)).stdout.trim()).toBe('Save');
    const old = JSON.parse((await bvl('get', 'text', `@${ref(j.snapshot1)}`, '--json')).stdout) as {
      success: boolean;
      code?: string;
      error: string;
    };
    expect(old).toMatchObject({ success: false, code: 'stale_ref' });
    expect(old.error).toContain('previous page');
  });

  it('--content-boundaries wraps the output (origin is the tab, <u2>)', async () => {
    const r = await bvl(
      'diff',
      'url',
      fixture('/diff-a.html'),
      fixture('/diff-b.html'),
      '--content-boundaries',
    );
    expect(r.stdout).toMatch(
      new RegExp(
        `^--- AGENT_BROWSER_PAGE_CONTENT nonce=[0-9a-f]{32} origin=${fixture('/diff-b.html').replace(/[.]/g, '\\.')} ---\\nSnapshot diff:`,
      ),
    );
    expect(r.stdout.trimEnd()).toMatch(
      /--- END_AGENT_BROWSER_PAGE_CONTENT nonce=[0-9a-f]{32} ---$/,
    );
    const j = JSON.parse(
      (
        await bvl(
          'diff',
          'url',
          fixture('/diff-a.html'),
          fixture('/diff-b.html'),
          '--content-boundaries',
          '--json',
        )
      ).stdout,
    ) as { _boundary?: { origin: string } };
    expect(j._boundary?.origin).toBe(fixture('/diff-b.html'));
  });

  it('keeps url1 and url2 whole under --max-output', async () => {
    const r = (
      await bvlJson(
        'diff',
        'url',
        fixture('/diff-a.html'),
        fixture('/diff-b.html'),
        '--max-output',
        '40',
      )
    ).data as UrlDiff;
    expect(r.url1).toBe(fixture('/diff-a.html'));
    expect(r.url2).toBe(fixture('/diff-b.html'));
  });

  it('--wait-until networkidle on a page that never settles fails with timeout', async () => {
    const r = await bvl(
      'diff',
      'url',
      fixture('/diff-a.html'),
      fixture('/diff-busy.html'),
      '--wait-until',
      'networkidle',
      '--timeout',
      '3000',
      '--json',
    );
    expect(JSON.parse(r.stdout)).toMatchObject({ success: false, code: 'timeout' });
    const ok = await bvl(
      'diff',
      'url',
      fixture('/diff-a.html'),
      fixture('/diff-b.html'),
      '--wait-until',
      'networkidle',
    );
    expect(ok.code).toBe(0);
  });

  it('rejects empty URLs and flags of the other subcommands before navigating', async () => {
    await bvl('close');
    await bvl('open', fixture('/prose.html'));
    for (const args of [
      ['', fixture('/diff-b.html')],
      [fixture('/diff-a.html'), ' '],
      [fixture('/diff-a.html'), fixture('/diff-b.html'), '-t', '0.2'],
      [fixture('/diff-a.html'), fixture('/diff-b.html'), '--stdin'],
      [fixture('/diff-a.html'), fixture('/diff-b.html'), '--baseline', 'x.png'],
    ]) {
      const r = await bvl('diff', 'url', ...args, '--json');
      expect(JSON.parse(r.stdout), args.join(' ')).toMatchObject({
        success: false,
        code: 'bad_args',
      });
    }
    expect((await bvl('get', 'title')).stdout).toBe('Prose\n');
    const w = await bvl('diff', 'url', fixture('/diff-a.html'), fixture('/diff-a.html'), '--full');
    expect(w.stderr).toContain('--full has no effect without --screenshot');
  });

  it('a redirect out of the allowed domains during <u2> is domain_blocked', async () => {
    await bvl('close');
    await setGuardrails({ allowedDomains: ['127.0.0.1'] });
    await bvl('open', fixture('/prose.html'));
    const out = fixture('/form.html').replace('127.0.0.1', 'localhost');
    const to = fixture(`/redirect?to=${encodeURIComponent(out)}`);
    const r = await bvl('diff', 'url', fixture('/diff-a.html'), to, '--json');
    expect(JSON.parse(r.stdout)).toMatchObject({ success: false, code: 'domain_blocked' });
    expect((await bvl('get', 'title')).stdout).not.toContain('Fixture Form');
    await setGuardrails({});
  });

  it('navigate-new-site: both cards come up front, a deny on <u2> leaves the tab alone', async () => {
    const S = ['--session', 'diffurl-sites'];
    await bvl('close', ...S);
    await bvl('open', fixture('/prose.html'), ...S);
    await setGuardrails({ confirm: ['navigate-new-site'] });
    const u1 = fixture('/diff-a.html').replace('127.0.0.1', 'localhost');
    const u2 = 'http://127.0.0.2:1/never';
    const run = bvl('diff', 'url', u1, u2, ...S, '--json');
    expect(await approveNextConsent('allow')).toContain('localhost');
    expect(await approveNextConsent('deny')).toContain('127.0.0.2');
    expect(JSON.parse((await run).stdout)).toMatchObject({ success: false, code: 'denied' });
    expect((await bvl('get', 'url', ...S)).stdout.trim()).toBe(fixture('/prose.html'));

    await setGuardrails({});
    await bvl('close', ...S);
  });

  it('networkidle does not touch the page: >250 resources, entries are neither cleared nor resized', async () => {
    await bvl('close');
    await bvl('open', fixture('/diff-many.html'));
    await bvl('wait', '1000');
    const count = async () =>
      Number((await bvl('eval', "performance.getEntriesByType('resource').length")).stdout);
    const before = await count();
    expect(before).toBeGreaterThan(100);
    expect((await bvl('wait', '--load', 'networkidle')).code).toBe(0);
    expect(await count()).toBe(before);
    // a fresh load with the observer racing the burst still settles
    const r = await bvl(
      'diff',
      'url',
      fixture('/diff-a.html'),
      fixture('/diff-many.html'),
      '--wait-until',
      'networkidle',
    );
    expect(r.code).toBe(0);
    const resized = (
      await bvl('eval', "performance.getEntriesByType('resource').length")
    ).stdout.trim();
    expect(Number(resized)).toBeGreaterThan(100);
  });
});
