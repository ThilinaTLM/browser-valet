// screenshot [target] [path]. Fixture: element-shot.html (plus frames.html for the iframe).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  approveNextConsent,
  bvl,
  bvlJson,
  fixture,
  framesPage,
  openUserTab,
  stopTabInPopup,
  tidForTitle,
  useBrowser,
  workDir,
} from './harness';

const browser = useBrowser();

beforeEach(async () => {
  await bvl('close');
});

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Size and a pixel reader of a PNG, decoded in a scratch browser page. */
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
      return {
        width: bmp.width,
        height: bmp.height,
        data: Array.from(g.getImageData(0, 0, bmp.width, bmp.height).data),
      };
    }, b64);
  } finally {
    await page.close();
  }
}

const px = (img: { width: number; data: number[] }, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return img.data.slice(i, i + 3);
};

describe('screenshot <target>', () => {
  it('captures only the element on an agent tab, below the fold too', async () => {
    await bvl('open', fixture('/element-shot.html'));
    // agent tabs are background tabs: this exercises the hidden-tab capture path
    expect((await bvlJson('eval', 'document.visibilityState')).data).toMatchObject({
      result: 'hidden',
    });
    const r = await bvlJson('screenshot', '#card', 'card.png');
    const d = r.data as { path: string; selector: string; box: Box };
    expect(d.path).toBe(join(workDir(), 'card.png'));
    expect(d.selector).toBe('#card');
    expect(d.box).toEqual({ x: 60, y: 90, width: 200, height: 120 });
    const img = await decode('card.png');
    expect([img.width, img.height]).toEqual([200, 120]);
    expect(px(img, 100, 100)).toEqual([0, 0, 255]);
    expect(px(img, 0, 0)).toEqual([0, 0, 255]);

    // far below the fold: scrolled into view first
    const far = (await bvlJson('screenshot', '#far', 'far.png')).data as { box: Box };
    expect(far.box).toEqual({ x: 30, y: 1500, width: 150, height: 70 });
    const f = await decode('far.png');
    expect([f.width, f.height]).toEqual([150, 70]);
    expect(px(f, 75, 35)).toEqual([0, 160, 0]);
  });

  it('works with a ref, with text output and with a lone target (temp file)', async () => {
    await bvl('open', fixture('/element-shot.html'));
    const snap = (await bvl('snapshot', '-i')).stdout;
    const ref = /button "Inside card" \[ref=(e\d+)\]/.exec(snap)?.[1];
    expect(ref).toBeDefined();
    const r = await bvl('screenshot', `@${ref ?? ''}`, 'btn.png');
    expect(r.stdout.trim()).toBe(`✓ Screenshot saved to ${join(workDir(), 'btn.png')}`);
    const img = await decode('btn.png');
    expect([img.width, img.height]).toEqual([80, 30]);
    expect(px(img, 40, 15)).toEqual([255, 0, 0]);

    const lone = await bvl('screenshot', '#card');
    expect(lone.stdout).toMatch(/Screenshot saved to .*screenshot-\d+\.png/);
  });

  it('keeps `screenshot out.png` as a viewport capture', async () => {
    await bvl('open', fixture('/element-shot.html'));
    await bvl('screenshot', 'view.png');
    const img = await decode('view.png');
    const vp = (await bvlJson('eval', '[innerWidth, innerHeight, devicePixelRatio]')).data as {
      result: number[];
    };
    const [w = 0, h = 0, dpr = 1] = vp.result;
    expect([img.width, img.height]).toEqual([Math.round(w * dpr), Math.round(h * dpr)]);
  });

  it('caps a very tall element and warns', async () => {
    await bvl('open', fixture('/element-shot.html'));
    const r = await bvl('screenshot', '#tall', 'tall.png', '--json');
    const d = (JSON.parse(r.stdout) as { data: { truncated: boolean; box: Box } }).data;
    expect(d.truncated).toBe(true);
    expect(d.box.height).toBe(8000);
    expect(r.stderr).toContain('Very large element');
    expect((await decode('tall.png')).height).toBe(8000);
  });

  it('fails with the usual codes', async () => {
    await bvl('open', fixture('/element-shot.html'));
    const code = async (...args: string[]) => {
      const r = await bvl('screenshot', ...args, '--json');
      expect(r.code).toBe(1);
      return JSON.parse(r.stdout) as { success: boolean; code?: string };
    };
    expect(await code('#nope', 'x.png')).toMatchObject({ success: false, code: 'not_found' });
    expect(await code('#gone', 'x.png')).toMatchObject({ success: false, code: 'not_visible' });
    expect(await code('@e99', 'x.png')).toMatchObject({ success: false, code: 'unknown_ref' });
    expect(await code('--full', '#card', 'x.png')).toMatchObject({
      success: false,
      code: 'bad_args',
    });
  });

  it('draws only the refs inside the element, relative to the clip', async () => {
    await bvl('open', fixture('/element-shot.html'));
    const j = (await bvlJson('screenshot', '--annotate', '#card', 'cardann.png')).data as {
      annotations: { name: string; box: Box }[];
    };
    expect(j.annotations.map((a) => a.name)).toEqual(['Inside card']);
    expect(j.annotations[0]?.box).toMatchObject({ x: 10, y: 10, width: 80, height: 30 });
  });

  it('--if-changed keeps element and page captures apart', async () => {
    await bvl('open', fixture('/element-shot.html'));
    const first = (await bvlJson('screenshot', '--if-changed', '#card', 'a.png')).data as {
      changed: boolean;
      revision: number;
    };
    expect([first.changed, first.revision]).toEqual([true, 1]);
    const again = (await bvlJson('screenshot', '--if-changed', '#card', 'a.png')).data as {
      changed: boolean;
      revision: number;
    };
    expect([again.changed, again.revision]).toEqual([false, 2]);
    const page = (await bvlJson('screenshot', '--if-changed', 'p.png')).data as {
      revision: number;
    };
    expect(page.revision).toBe(1);
  });

  it('captures an element in a same-process iframe', async () => {
    await bvl('open', fixture('/element-shot.html'));
    const snap = (await bvl('snapshot', '-i')).stdout;
    const ref = /button "Inside frame" \[ref=(e\d+)\]/.exec(snap)?.[1];
    expect(ref, snap).toBeDefined();
    const d = (await bvlJson('screenshot', `@${ref ?? ''}`, 'inframe.png')).data as { box: Box };
    expect(d.box).toEqual({ x: 320, y: 110, width: 100, height: 40 });
    const img = await decode('inframe.png');
    expect([img.width, img.height]).toEqual([100, 40]);
  });

  it('captures an element in an out-of-process iframe', async () => {
    await bvl('open', framesPage('&pad=400'));
    let ref: string | undefined;
    for (let i = 0; i < 40 && !ref; i++) {
      ref = /button "Pay" \[ref=(e\d+)\]/.exec((await bvl('snapshot', '-i')).stdout)?.[1];
      if (!ref) await new Promise((r) => setTimeout(r, 250));
    }
    expect(ref).toBeDefined();
    const d = (await bvlJson('screenshot', `@${ref ?? ''}`, 'oopif.png')).data as { box: Box };
    const page = (await browser.current.pages()).find((p) => p.url().includes('pad=400'));
    const frame = page
      ?.frames()
      .find((f) => f !== page.mainFrame() && f.url().includes('/frame-inner.html'));
    const want = await (await frame?.$('#pay'))?.boundingBox();
    const scrolled = (await page?.evaluate(() => window.scrollY)) ?? 0;
    expect(want).toBeDefined();
    expect(Math.abs(d.box.x - (want?.x ?? 999))).toBeLessThanOrEqual(2);
    expect(Math.abs(d.box.y - ((want?.y ?? 999) + scrolled))).toBeLessThanOrEqual(2);
    const img = await decode('oopif.png');
    expect(Math.abs(img.width - (want?.width ?? 0))).toBeLessThanOrEqual(2);
    expect(Math.abs(img.height - (want?.height ?? 0))).toBeLessThanOrEqual(2);
    // the button is not white all over: the clip really holds the iframe's pixels
    expect(img.data.some((v, i) => i % 4 < 3 && v < 250)).toBe(true);
  });

  it('reports a ref from before a navigation as stale_ref', async () => {
    await bvl('open', fixture('/element-shot.html'));
    const snap = (await bvl('snapshot', '-i')).stdout;
    const ref = /button "Inside card" \[ref=(e\d+)\]/.exec(snap)?.[1];
    expect(ref).toBeDefined();
    await bvl('open', fixture('/other.html'));
    const r = await bvl('screenshot', `@${ref ?? ''}`, 'stale.png', '--json');
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ success: false, code: 'stale_ref' });
  });

  it('warns when a selector matches several elements', async () => {
    await bvl('open', fixture('/element-shot.html'));
    const r = await bvl('screenshot', 'div', 'many.png');
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/elements match "div"; used the first/);
  });

  it('scales with the device pixel ratio but reports CSS px', async () => {
    await bvl('open', fixture('/element-shot.html'));
    await bvl('set', 'viewport', '800', '600', '2');
    try {
      const d = (await bvlJson('screenshot', '#card', 'dpr.png')).data as { box: Box };
      expect(d.box).toEqual({ x: 60, y: 90, width: 200, height: 120 });
      const img = await decode('dpr.png');
      expect([img.width, img.height]).toEqual([400, 240]);
      expect(px(img, 200, 120)).toEqual([0, 0, 255]);
    } finally {
      await bvl('set', 'viewport', 'reset');
    }
  });

  it('captures fixed elements, elements below a 100vh hero and inside scroll containers', async () => {
    await bvl('open', fixture('/element-layout.html'));
    const fixed = (await bvlJson('screenshot', '#fixed', 'fixed.png')).data as { box: Box };
    expect(fixed.box).toMatchObject({ width: 120, height: 60 });
    const f = await decode('fixed.png');
    expect(px(f, 60, 30)).toEqual([128, 0, 128]);

    const below = (await bvlJson('screenshot', '#below', 'below.png')).data as { box: Box };
    expect(below.box.width).toBe(160);
    expect(below.box.height).toBe(80);
    expect(below.box.y).toBeGreaterThan(300);
    expect(px(await decode('below.png'), 80, 40)).toEqual([0, 160, 0]);

    const inner = (await bvlJson('screenshot', '#inner', 'inner.png')).data as { box: Box };
    expect(inner.box).toMatchObject({ width: 200, height: 40 });
    expect(px(await decode('inner.png'), 100, 20)).toEqual([0, 0, 255]);
  });

  it('honours --screenshot-format/-quality and --annotate with a target', async () => {
    await bvl('open', fixture('/element-shot.html'));
    const r = await bvl(
      'screenshot',
      '#card',
      '--screenshot-format',
      'jpeg',
      '--screenshot-quality',
      '60',
      '--annotate',
      'card.jpg',
    );
    expect(r.code).toBe(0);
    const bytes = await readFile(join(workDir(), 'card.jpg'));
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    expect(r.stdout).toContain('Inside card');
  });

  it('does not replace the diff screenshot baseline', async () => {
    await bvl('open', fixture('/element-shot.html'));
    expect((await bvl('screenshot', 'base.png')).code).toBe(0);
    expect((await bvl('screenshot', '#card', 'el.png')).code).toBe(0);
    const d = (await bvlJson('diff', 'screenshot', '-o', 'dd.png')).data as {
      baselineRecorded?: boolean;
      match: boolean;
    };
    expect(d.baselineRecorded).toBeUndefined();
    expect(d.match).toBe(true);
  });

  it('works on a visible shared tab', async () => {
    const page = await openUserTab(fixture('/element-shot.html'));
    try {
      const tid = await tidForTitle('Element Shot');
      const pending = bvl('tab', tid);
      await approveNextConsent('allow');
      expect((await pending).code).toBe(0);
      const r = await bvlJson('screenshot', '#card', 'shared.png');
      expect((r.data as { box: Box }).box).toEqual({ x: 60, y: 90, width: 200, height: 120 });
      const img = await decode('shared.png');
      expect([img.width, img.height]).toEqual([200, 120]);
      expect(px(img, 100, 100)).toEqual([0, 0, 255]);
      await stopTabInPopup(tid);
    } finally {
      await page.close();
    }
  });

  it('on a visible shared tab leaves scroll and viewport alone when the element is in view', async () => {
    const page = await openUserTab(fixture('/element-layout.html'));
    try {
      expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
      await page.evaluate(() => {
        window.scrollTo(0, 300);
      });
      const tid = await tidForTitle('Element Layout');
      const pending = bvl('tab', tid);
      await approveNextConsent('allow');
      expect((await pending).code).toBe(0);

      const resizes = () => page.evaluate(() => (window as unknown as { resizes: number }).resizes);
      // Attaching shows Chrome's debugging bar, which shrinks the viewport (a resize): let that
      // happen before counting.
      await bvl('get', 'title');
      await page.bringToFront();
      // Wait until the count is stable (CI windows resize a few times after attaching).
      for (let i = 0, last = -1; i < 20; i++) {
        const n = await resizes();
        if (n === last) break;
        last = n;
        await new Promise((r) => setTimeout(r, 800));
      }
      // Control: how many resizes does a command without a capture cause here (a debugging bar
      // appearing, window sizing)? The element capture must not add any.
      const c0 = await resizes();
      await bvl('get', 'title');
      await new Promise((r) => setTimeout(r, 500));
      const c1 = await resizes();
      const d = (await bvlJson('screenshot', '#fixed', 'sfixed.png')).data as { box: Box };
      await new Promise((r) => setTimeout(r, 500));
      const c2 = await resizes();
      expect(d.box).toMatchObject({ width: 120, height: 60 });
      expect(px(await decode('sfixed.png'), 60, 30)).toEqual([128, 0, 128]);
      // no scroll, no resize from the capture
      expect(await page.evaluate(() => window.scrollY)).toBe(300);
      expect(c2 - c1).toBeLessThanOrEqual(c1 - c0);

      // below a 100vh hero: the page scrolls to it
      await page.evaluate(() => {
        window.scrollTo(0, 0);
      });
      const below = (await bvlJson('screenshot', '#below', 'sbelow.png')).data as { box: Box };
      expect([below.box.width, below.box.height]).toEqual([160, 80]);
      expect(px(await decode('sbelow.png'), 80, 40)).toEqual([0, 160, 0]);
      await stopTabInPopup(tid);
    } finally {
      await page.close();
    }
  });
});
