// pdf, set viewport, set media: output, effects in the page, persistence, and the shared-tab rule.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  approveNextConsent,
  bctl,
  bctlJson,
  fixture,
  openUserTab,
  stopTabInPopup,
  tidForTitle,
  useBrowser,
  workDir,
} from './harness';

useBrowser();

const evalNum = async (js: string) => Number((await bctl('eval', js)).stdout.trim());

describe('pdf', () => {
  it('writes a PDF file (relative to the cwd), with --landscape and --background', async () => {
    await bctl('open', fixture('/form.html'));
    const r = await bctl('pdf', 'page.pdf');
    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout).toBe(`✓ PDF saved to ${join(workDir(), 'page.pdf')}\n`);
    const bytes = await readFile(join(workDir(), 'page.pdf'));
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');

    const l = await bctlJson('pdf', 'land.pdf', '--landscape', '--background');
    expect(l).toMatchObject({ success: true, data: { path: join(workDir(), 'land.pdf') } });
    const land = await readFile(join(workDir(), 'land.pdf'));
    expect(land.subarray(0, 5).toString()).toBe('%PDF-');
    // landscape pages have a wider MediaBox than tall
    const box = /MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)/.exec(land.toString('latin1'));
    if (box) expect(Number(box[1])).toBeGreaterThan(Number(box[2]));
  });

  it('requires a path', async () => {
    const r = await bctl('pdf');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Missing path');
  });
});

describe('set viewport / set media on an agent tab', () => {
  it('viewport applies, survives navigation, and resets', async () => {
    await bctl('open', fixture('/form.html'));
    const natural = await evalNum('innerWidth');

    const r = await bctl('set', 'viewport', '500', '400', '2');
    expect(r).toMatchObject({ code: 0, stdout: '✓ Done\n' });
    expect(await evalNum('innerWidth')).toBe(500);
    expect(await evalNum('innerHeight')).toBe(400);
    expect(await evalNum('devicePixelRatio')).toBe(2);

    await bctl('open', fixture('/other.html'));
    expect(await evalNum('innerWidth')).toBe(500);

    const j = await bctlJson('set', 'viewport', 'reset');
    expect(j).toMatchObject({ success: true });
    expect(await evalNum('innerWidth')).toBe(natural);
    expect(await evalNum('devicePixelRatio')).toBe(1);
  });

  it('media applies and resets', async () => {
    await bctl('open', fixture('/form.html'));
    const dark = "matchMedia('(prefers-color-scheme: dark)').matches";
    const reduced = "matchMedia('(prefers-reduced-motion: reduce)').matches";
    const baseDark = (await bctl('eval', dark)).stdout.trim(); // depends on the OS theme
    expect((await bctl('set', 'media', 'light')).code).toBe(0);
    expect((await bctl('eval', dark)).stdout.trim()).toBe('false');

    expect((await bctl('set', 'media', 'dark')).code).toBe(0);
    expect((await bctl('eval', dark)).stdout.trim()).toBe('true');
    expect((await bctl('eval', reduced)).stdout.trim()).toBe('false');

    expect((await bctl('set', 'media', 'light', 'reduced-motion')).code).toBe(0);
    expect((await bctl('eval', dark)).stdout.trim()).toBe('false');
    expect((await bctl('eval', reduced)).stdout.trim()).toBe('true');

    expect((await bctl('set', 'media', 'reset')).code).toBe(0);
    expect((await bctl('eval', dark)).stdout.trim()).toBe(baseDark);
    expect((await bctl('eval', reduced)).stdout.trim()).toBe('false');
  });

  it('validates arguments and refuses unsupported subcommands', async () => {
    await bctl('open', fixture('/form.html'));
    expect((await bctl('set', 'viewport', '800')).stderr).toContain('Missing arguments');
    expect((await bctl('set', 'viewport', 'a', 'b')).stderr).toContain('Width must be');
    expect((await bctl('set', 'media', 'purple')).stderr).toContain('Unknown media option');
    expect((await bctl('set', 'geo', '1', '2')).stderr).toContain('not supported');
    expect((await bctl('set', 'bogus')).stderr).toContain('Unknown subcommand');
  });

  it('viewport is cleared when the agent tab is closed', async () => {
    await bctl('open', fixture('/form.html'));
    await bctl('set', 'viewport', '420', '420');
    expect(await evalNum('innerWidth')).toBe(420);
    await bctl('close');
    await bctl('open', fixture('/form.html'));
    expect(await evalNum('innerWidth')).not.toBe(420);
  });
});

describe('shared tab', () => {
  it('allows pdf but refuses set viewport / set media', async () => {
    const page = await openUserTab(fixture('/other.html'));
    try {
      const tid = await tidForTitle('Fixture Other');
      const pending = bctl('tab', tid);
      await approveNextConsent('allow');
      expect((await pending).code).toBe(0);

      const pdf = await bctl('pdf', 'shared.pdf');
      expect(pdf.code).toBe(0);
      expect((await readFile(join(workDir(), 'shared.pdf'))).subarray(0, 5).toString()).toBe(
        '%PDF-',
      );

      for (const args of [
        ['set', 'viewport', '500', '400'],
        ['set', 'media', 'dark'],
      ]) {
        const r = await bctl(...args);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("user's shared tab");
      }
      expect(await page.evaluate(() => innerWidth)).not.toBe(500);
      await stopTabInPopup(tid);
    } finally {
      await page.close();
    }
  });
});
