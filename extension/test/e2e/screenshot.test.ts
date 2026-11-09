// screenshot --annotate, --if-changed, --threshold. Fixture: form.html.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { bctl, bctlJson, fixture, useBrowser, workDir } from './harness';

const browser = useBrowser();

// A new tab per test: capture history is per tab.
beforeEach(async () => {
  await bctl('close');
});

interface Annotation {
  ref: string;
  number: number;
  role: string;
  name: string;
  box: { x: number; y: number; width: number; height: number };
}

/** Decode a PNG in a scratch browser page and return its size and a pixel/red-pixel reader. */
async function decode(file: string) {
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
      for (let i = 0; i < px.length; i += 4) {
        if ((px[i] ?? 0) > 200 && (px[i + 1] ?? 255) < 40 && (px[i + 2] ?? 255) < 40) red++;
      }
      return { width: bmp.width, height: bmp.height, red, data: Array.from(px) };
    }, b64);
  } finally {
    await page.close();
  }
}

const redAt = (img: { width: number; data: number[] }, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return (img.data[i] ?? 0) > 200 && (img.data[i + 1] ?? 255) < 40 && (img.data[i + 2] ?? 255) < 40;
};

describe('screenshot --annotate', () => {
  it('lists refs after the save line and draws red outlines at their boxes', async () => {
    await bctl('open', fixture('/form.html'));
    await bctl('screenshot', 'plain.png');
    const r = await bctl('screenshot', '--annotate', 'ann.png');
    expect(r.code).toBe(0);
    const [first, ...rest] = r.stdout.trimEnd().split('\n');
    expect(first).toBe(`✓ Screenshot saved to ${join(workDir(), 'ann.png')}`);
    expect(rest).toEqual([
      expect.stringMatching(/^ {3}\[\d+\] @e\d+ heading "Fixture Form"$/),
      expect.stringMatching(/^ {3}\[\d+\] @e\d+ textbox "Name"$/),
      expect.stringMatching(/^ {3}\[\d+\] @e\d+ button "Increment"$/),
    ]);

    const j = (await bctlJson('screenshot', '--annotate', 'ann2.png')).data as {
      path: string;
      annotations: Annotation[];
    };
    expect(j.path).toBe(join(workDir(), 'ann2.png'));
    expect(j.annotations.map((a) => [a.role, a.name])).toEqual([
      ['heading', 'Fixture Form'],
      ['textbox', 'Name'],
      ['button', 'Increment'],
    ]);
    for (const a of j.annotations) {
      expect(a.number).toBe(Number(a.ref.slice(1)));
      expect(a.box.width).toBeGreaterThan(0);
    }
    // numbers match the refs a later snapshot reports
    const snap = (await bctl('snapshot')).stdout;
    for (const a of j.annotations) expect(snap).toContain(`ref=${a.ref}`);

    const plain = await decode('plain.png');
    const ann = await decode('ann.png');
    expect(ann.width).toBe(plain.width);
    expect(ann.height).toBe(plain.height);
    expect(plain.red).toBe(0);
    expect(ann.red).toBeGreaterThan(200);
    const btn = j.annotations.find((a) => a.role === 'button')?.box;
    if (!btn) throw new Error('no button annotation');
    const scale = ann.width / (await innerWidth());
    // left edge and bottom edge of the button's box are red; the page itself had none
    const midY = Math.round((btn.y + btn.height / 2) * scale);
    const botX = Math.round((btn.x + btn.width / 2) * scale);
    expect(redAt(ann, Math.round(btn.x * scale), midY)).toBe(true);
    expect(redAt(ann, botX, Math.round((btn.y + btn.height) * scale) - 1)).toBe(true);
    // the page DOM was not touched
    expect(
      (await bctl('eval', 'document.querySelectorAll("canvas, [data-bctl]").length')).stdout.trim(),
    ).toBe('0');
  });

  it('--full uses page coordinates', async () => {
    await bctl('open', fixture('/form.html'));
    await bctl(
      'eval',
      `document.body.insertAdjacentHTML('beforeend', '<div style="height:2000px"></div><button id="far">Far away</button>')`,
    );
    const j = (await bctlJson('screenshot', '--full', '--annotate', 'full.png')).data as {
      annotations: Annotation[];
    };
    const far = j.annotations.find((a) => a.name === 'Far away');
    if (!far) throw new Error('no annotation for the far button');
    expect(far.box.y).toBeGreaterThan(2000);
    const img = await decode('full.png');
    const scale = img.width / (await innerWidth());
    expect(img.height).toBeGreaterThan(2000 * scale);
    expect(
      redAt(
        img,
        Math.round(far.box.x * scale),
        Math.round((far.box.y + far.box.height / 2) * scale),
      ),
    ).toBe(true);
  });

  it('skips elements outside the viewport without --full', async () => {
    await bctl('open', fixture('/form.html'));
    await bctl(
      'eval',
      `document.body.insertAdjacentHTML('beforeend', '<div style="height:3000px"></div><button>Way below</button>')`,
    );
    const j = (await bctlJson('screenshot', '--annotate', 'vp.png')).data as {
      annotations: Annotation[];
    };
    expect(j.annotations.map((a) => a.name)).not.toContain('Way below');
  });
});

const innerWidth = async () => Number((await bctl('eval', 'innerWidth')).stdout.trim());

describe('screenshot --if-changed / --threshold', () => {
  it('saves the first capture, reports unchanged, then saves after a DOM change', async () => {
    await bctl('open', fixture('/form.html'));
    const first = await bctl('screenshot', '--if-changed', 'c.png');
    expect(first.stdout).toBe(`✓ Screenshot saved to ${join(workDir(), 'c.png')}\n`);

    const second = await bctl('screenshot', '--if-changed', 'c2.png');
    expect(second.stdout).toBe('✓ Screenshot unchanged (revision 2, 0.0000% pixels changed)\n');
    await expect(readFile(join(workDir(), 'c2.png'))).rejects.toThrow();

    const j = await bctlJson('screenshot', '--if-changed', 'c3.png');
    expect(j.data).toEqual({ changed: false, pixelChangeRatio: 0, revision: 3, threshold: 0 });

    await bctl(
      'eval',
      `document.getElementById('echo').textContent = 'something new appeared here'`,
    );
    const changed = (await bctlJson('screenshot', '--if-changed', 'c4.png')).data as Record<
      string,
      unknown
    >;
    expect(changed).toMatchObject({
      changed: true,
      path: join(workDir(), 'c4.png'),
      revision: 4,
      threshold: 0,
    });
    expect(changed.pixelChangeRatio).toBeGreaterThan(0);
    expect(changed.pixelChangeRatio).toBeLessThan(0.05);
    expect((await readFile(join(workDir(), 'c4.png'))).subarray(1, 4).toString()).toBe('PNG');
  });

  it('--threshold ignores small changes and implies --if-changed', async () => {
    await bctl('open', fixture('/form.html'));
    expect((await bctl('screenshot', '--threshold', '0.5', 't.png')).stdout).toContain('saved to');
    await bctl(
      'eval',
      `document.getElementById('echo').textContent = 'a small change in the text'`,
    );
    const small = await bctlJson('screenshot', '--threshold', '0.5', 't2.png');
    expect(small.data).toMatchObject({ changed: false, threshold: 0.5, revision: 2 });
    expect((small.data as { pixelChangeRatio: number }).pixelChangeRatio).toBeGreaterThan(0);
    expect(small.data).not.toHaveProperty('path');
    const text = await bctl('screenshot', '--threshold', '0.5');
    expect(text.stdout).toMatch(
      /^✓ Screenshot unchanged \(revision 3, 0\.\d{4}% pixels changed\)\n$/,
    );

    // A big change exceeds the threshold.
    await bctl('eval', `document.body.style.background = 'black'`);
    const big = (await bctlJson('screenshot', '--threshold', '0.5', 't3.png')).data as Record<
      string,
      unknown
    >;
    expect(big).toMatchObject({ changed: true, threshold: 0.5, path: join(workDir(), 't3.png') });
    expect(big.pixelChangeRatio).toBeGreaterThan(0.5);
  });

  it('rejects an out-of-range threshold', async () => {
    const r = await bctl('screenshot', '--threshold', '2');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--threshold must be from 0 to 1, got '2'");
  });

  it('keeps separate history per scope and works with --annotate', async () => {
    await bctl('open', fixture('/form.html'));
    await bctl('screenshot', '--if-changed', 'v.png');
    const full = await bctl('screenshot', '--full', '--if-changed', 'f.png');
    expect(full.stdout).toContain('saved to'); // first full capture, though a viewport one exists
    const ann = await bctl('screenshot', '--annotate', '--if-changed', 'a.png');
    expect(ann.stdout).toContain('saved to');
    expect(ann.stdout).toContain('button "Increment"');
    const again = await bctl('screenshot', '--annotate', '--if-changed', 'a2.png');
    expect(again.stdout).toBe('✓ Screenshot unchanged (revision 2, 0.0000% pixels changed)\n');
    const json = (await bctlJson('screenshot', '--annotate', '--if-changed', 'a3.png')).data;
    expect(json).not.toHaveProperty('annotations');
    expect(json).toMatchObject({ changed: false, revision: 3 });
  });
});
