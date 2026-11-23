// diff screenshot: in-memory baseline, red changes on a grey baseline. Fixture: form.html.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { bvl, bvlJson, fixture, useBrowser, workDir } from './harness';

const browser = useBrowser();

// A new tab per test: baselines are per tab.
beforeEach(async () => {
  await bvl('close');
});

async function pixels(file: string) {
  const b64 = (await readFile(join(workDir(), file))).toString('base64');
  const page = await browser.current.newPage();
  try {
    return await page.evaluate(async (data) => {
      const bin = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bin], { type: 'image/png' }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      if (!g) throw new Error('no canvas');
      g.drawImage(bmp, 0, 0);
      const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
      let red = 0;
      let grey = 0;
      for (let i = 0; i < px.length; i += 4) {
        const [r, gg, b] = [px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0];
        if (r > 200 && gg < 40 && b < 40) red++;
        else if (r === gg && gg === b) grey++;
      }
      return { red, grey, total: bmp.width * bmp.height };
    }, b64);
  } finally {
    await page.close();
  }
}

describe('diff screenshot', () => {
  it('records a baseline first, then paints changes red', async () => {
    await bvl('open', fixture('/form.html'));
    const first = await bvlJson('diff', 'screenshot', '-o', 'd0.png');
    expect(first.data).toMatchObject({ baselineRecorded: true, diffPath: null });

    const same = await bvl('diff', 'screenshot', '-o', 'd1.png');
    expect(same.code).toBe(0);
    expect(same.stdout).toMatch(/^✓ Images match \(0% difference\)\n {2}Diff image: .*d1\.png\n/);

    await bvl('eval', `document.body.style.background = '#f90'`);
    const r = await bvl('diff', 'screenshot', '-o', 'd2.png');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(
      /^✗ [\d.]+% pixels differ\n {2}Diff image: .*d2\.png\n {2}\d+ different \/ \d+ total pixels/,
    );
    const img = await pixels('d2.png');
    expect(img.red).toBeGreaterThan(img.total / 4);

    // the last diff is the new baseline
    const j = (await bvlJson('diff', 'screenshot', '-t', '0.1', '-o', 'd3.png')).data as Record<
      string,
      unknown
    >;
    expect(j).toMatchObject({ match: true, differentPixels: 0, dimensionMismatch: null });
    expect(Object.keys(j).sort()).toEqual(
      [
        'diffPath',
        'differentPixels',
        'dimensionMismatch',
        'match',
        'mismatchPercentage',
        'totalPixels',
      ].sort(),
    );
    const grey = await pixels('d3.png');
    expect(grey.red).toBe(0);
    expect(grey.grey).toBe(grey.total);
  });

  it('uses the last `screenshot` as baseline, also on a hidden agent tab', async () => {
    await bvl('open', fixture('/form.html'));
    await bvl('screenshot', 'base.png');
    await bvl(
      'eval',
      `document.body.insertAdjacentHTML('afterbegin', '<div style="height:80px;background:#d00"></div>')`,
    );
    const j = (await bvlJson('diff', 'screenshot', '-o', 'd.png')).data as {
      match: boolean;
      differentPixels: number;
    };
    expect(j.match).toBe(false);
    expect(j.differentPixels).toBeGreaterThan(0);
  });

  it('reports a size change without an image', async () => {
    await bvl('open', fixture('/form.html'));
    await bvl(
      'eval',
      `document.body.insertAdjacentHTML('beforeend', '<div style="height:3000px"></div>')`,
    );
    const full1 = await bvlJson('diff', 'screenshot', '--full');
    expect(full1.data).toMatchObject({ baselineRecorded: true });
    await bvl(
      'eval',
      `document.body.insertAdjacentHTML('beforeend', '<div style="height:500px"></div>')`,
    );
    const j = (await bvlJson('diff', 'screenshot', '--full', '-o', 'big.png')).data as {
      diffPath: string | null;
      mismatchPercentage: number;
      dimensionMismatch: { expected: { height: number }; actual: { height: number } } | null;
    };
    expect(j.diffPath).toBeNull();
    expect(j.mismatchPercentage).toBe(100);
    expect(j.dimensionMismatch?.actual.height).toBeGreaterThan(
      j.dimensionMismatch?.expected.height ?? 0,
    );
  });

  it('rejects --baseline files and a bad threshold', async () => {
    await bvl('open', fixture('/form.html'));
    const err = async (...args: string[]) =>
      JSON.parse((await bvl(...args, '--json')).stdout) as {
        success: boolean;
        code?: string;
        error: string;
      };
    const b = await err('diff', 'screenshot', '--baseline', 'x.png');
    expect(b.success).toBe(false);
    expect(b.code).toBe('bad_args');
    expect(b.error).toContain('Omit --baseline');
    const t = await bvl('diff', 'screenshot', '-t', '2');
    expect(t.code).not.toBe(0);
    expect(t.stderr + t.stdout).toContain('Threshold must be between 0 and 1, got 2');
    expect((await err('diff', 'nope')).code).toBe('bad_args');
  });
});
