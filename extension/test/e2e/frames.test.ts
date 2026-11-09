// Cross-origin (out-of-process) iframes and the `frame` command.
// Fixtures: frames.html on 127.0.0.1 embeds frame-inner.html from localhost (another site, so
// another renderer process), which embeds frame-deep.html (same process as its parent).

import { afterEach, describe, expect, it } from 'vitest';
import {
  bvl,
  bvlJson,
  fixture,
  framesPage,
  restartExtensionWorker,
  setGuardrails,
  useBrowser,
} from './harness';

const browser = useBrowser();

const refOf = (snapshot: string, re: RegExp): string => {
  const line = snapshot.split('\n').find((l) => re.test(l));
  const ref = /ref=(e\d+)/.exec(line ?? '')?.[1];
  if (!ref) throw new Error(`No ref for ${re} in:\n${snapshot}`);
  return ref;
};

async function openFrames(query = '', innerQuery = ''): Promise<void> {
  const r = await bvl('open', framesPage(query, innerQuery));
  expect(r.code).toBe(0);
  // The iframe loads after the page: wait until its content is reachable.
  for (let i = 0; i < 40; i++) {
    if ((await bvl('snapshot', '-i')).stdout.includes('Pay')) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('iframe content never showed up');
}

describe('out-of-process iframes', () => {
  it('snapshot inlines the iframe content with refs', async () => {
    await openFrames();
    const snap = (await bvl('snapshot', '-i')).stdout;
    expect(snap).toMatch(/- button "Host button" \[ref=e\d+\]/);
    expect(snap).toMatch(/- Iframe "payment-frame" \[ref=e\d+\]\n {2}- textbox/);
    expect(snap).toMatch(/ {2}- textbox "Card number" \[ref=e\d+\]/);
    expect(snap).toMatch(/ {2}- button "Pay" \[ref=e\d+\]/);
    // a same-process iframe inside the out-of-process one is inlined too
    expect(snap).toMatch(/ {4}- button "Deep button" \[ref=e\d+\]/);
    const full = (await bvl('snapshot')).stdout;
    expect(full).toMatch(/- Iframe "payment-frame" \[ref=e\d+\]\n {2}- heading "Payment"/);
  });

  it('keeps refs stable and unique across the process boundary', async () => {
    await openFrames();
    const a = (await bvl('snapshot', '-i')).stdout;
    const b = (await bvl('snapshot')).stdout;
    for (const re of [/button "Host button"/, /textbox "Card number"/, /button "Pay"/]) {
      expect(refOf(b, re)).toBe(refOf(a, re));
    }
    const refs = [...a.matchAll(/ref=(e\d+)/g)].map((m) => m[1]);
    expect(new Set(refs).size).toBe(refs.length);
    // a full, unscoped snapshot did not drop the iframe refs
    const json = (await bvlJson('snapshot', '-i')).data as { removedRefs: string[] };
    expect(json.removedRefs).toEqual([]);
  });

  it('fill and click inside the iframe work through refs', async () => {
    await openFrames();
    const snap = (await bvl('snapshot', '-i')).stdout;
    const card = refOf(snap, /textbox "Card number"/);
    const pay = refOf(snap, /button "Pay"/);
    expect((await bvl('fill', `@${card}`, '4242')).code).toBe(0);
    expect((await bvl('click', `@${pay}`)).code).toBe(0);
    expect((await bvl('frame', 'payment-frame')).code).toBe(0);
    expect((await bvl('get', 'text', '#out')).stdout.trim()).toBe('paid:4242');
    expect((await bvl('get', 'value', `@${card}`)).stdout.trim()).toBe('4242');
    await bvl('frame', 'main');
  });

  it('type and press reach the focused field of the iframe', async () => {
    await openFrames();
    const card = refOf((await bvl('snapshot', '-i')).stdout, /textbox "Card number"/);
    expect((await bvl('type', `@${card}`, 'ab')).code).toBe(0);
    expect((await bvl('press', 'c')).code).toBe(0);
    expect((await bvl('get', 'value', `@${card}`)).stdout.trim()).toBe('abc');
  });

  it('clicks a button in a nested frame (offsets add up)', async () => {
    await openFrames();
    const deep = refOf((await bvl('snapshot', '-i')).stdout, /button "Deep button"/);
    expect((await bvl('click', `@${deep}`)).code).toBe(0);
    await bvl('frame', 'deep-frame');
    expect((await bvl('get', 'text', '#deep-out')).stdout.trim()).toBe('deep clicked');
    await bvl('frame', 'main');
  });

  it('reaches an out-of-process iframe inside an out-of-process iframe', async () => {
    // host (127.0.0.1) > inner (localhost) > deep (127.0.0.1 again: a third document, own target)
    await openFrames('', `?deep=${encodeURIComponent(fixture('/frame-deep.html'))}`);
    const deep = refOf((await bvl('snapshot', '-i')).stdout, /button "Deep button"/);
    expect((await bvl('click', `@${deep}`)).code).toBe(0);
    await bvl('frame', 'deep-frame');
    expect((await bvl('get', 'text', '#deep-out')).stdout.trim()).toBe('deep clicked');
    await bvl('frame', 'main');
  });

  it('scrolls an iframe far down the page into view before clicking', async () => {
    await openFrames('&pad=2500');
    const snap = (await bvl('snapshot', '-i')).stdout;
    const pay = refOf(snap, /button "Pay"/);
    await bvl('eval', `document.querySelector('#out')?.remove()`); // main frame: no-op
    expect((await bvl('click', `@${pay}`)).code).toBe(0);
    await bvl('frame', 'payment-frame');
    expect((await bvl('get', 'text', '#out')).stdout.trim()).toBe('paid:');
    await bvl('frame', 'main');
  });

  it('hover on a ref inside the iframe is accepted', async () => {
    await openFrames();
    const pay = refOf((await bvl('snapshot', '-i')).stdout, /button "Pay"/);
    expect((await bvl('hover', `@${pay}`)).code).toBe(0);
  });
});

describe('screenshot --annotate', () => {
  it('boxes refs inside a cross-origin iframe at their place on the page', async () => {
    await openFrames('&pad=400');
    await bvl('set', 'viewport', '1000', '700'); // earlier files may have left a small one
    await bvl('eval', 'window.scrollTo(0, 380)');
    const pay = refOf((await bvl('snapshot', '-i')).stdout, /button "Pay"/);
    const j = (await bvlJson('screenshot', '--annotate', 'frames-ann.png')).data as {
      annotations: {
        ref: string;
        role: string;
        box: { x: number; y: number; width: number; height: number };
      }[];
    };
    const mine = j.annotations.find((a) => a.ref === pay);
    expect(mine, JSON.stringify(j.annotations)).toBeDefined();
    const page = (await browser.current.pages()).find((p) => p.url().includes('pad=400'));
    // The main frame's URL has `frame-inner.html` in its query: skip it (frame order varies).
    const frame = page
      ?.frames()
      .find((f) => f !== page.mainFrame() && f.url().includes('/frame-inner.html'));
    const el = await frame?.$('#pay');
    const want = await el?.boundingBox();
    expect(want).toBeDefined();
    expect(Math.abs((mine?.box.x ?? 0) - (want?.x ?? 999))).toBeLessThanOrEqual(2);
    expect(Math.abs((mine?.box.y ?? 0) - (want?.y ?? 999))).toBeLessThanOrEqual(2);
    expect(Math.abs((mine?.box.width ?? 0) - (want?.width ?? 999))).toBeLessThanOrEqual(2);
    await bvl('set', 'viewport', 'reset');
  });
});

describe('frame command', () => {
  it('scopes snapshot, selectors, get, eval and wait --fn; main resets', async () => {
    await openFrames();
    const snap = (await bvl('snapshot', '-i')).stdout;
    const iframe = refOf(snap, /Iframe "payment-frame"/);

    const r = await bvlJson('frame', `@${iframe}`);
    expect(r).toMatchObject({ success: true, data: { frame: 'payment-frame' } });

    const scoped = (await bvl('snapshot', '-i')).stdout;
    expect(scoped).toContain('button "Pay"');
    expect(scoped).not.toContain('Host button');
    expect(scoped).not.toContain('Frames Host');

    expect((await bvl('eval', 'document.title')).stdout.trim()).toBe('"Frame Inner"');
    expect((await bvl('eval', 'location.hostname')).stdout.trim()).toBe('"localhost"');
    expect((await bvl('get', 'text', 'h2')).stdout.trim()).toBe('Payment');
    expect((await bvl('get', 'count', 'button')).stdout.trim()).toBe('1');
    expect((await bvl('wait', '--fn', "document.title === 'Frame Inner'")).code).toBe(0);
    expect((await bvl('is', 'visible', '#pay')).stdout.trim()).toBe('true');
    // the tab itself still reports the main page
    expect((await bvl('get', 'title')).stdout.trim()).toBe('Frames Host');
    expect((await bvl('session', 'info')).stdout).toContain('Frame: payment-frame');

    expect((await bvl('frame', 'main')).code).toBe(0);
    expect((await bvl('eval', 'document.title')).stdout.trim()).toBe('"Frames Host"');
    expect((await bvl('get', 'count', 'button')).stdout.trim()).toBe('1');
    expect((await bvl('snapshot', '-i')).stdout).toContain('Host button');
    expect((await bvl('session', 'info')).stdout).toContain('Frame: main');
  });

  it('selects by CSS selector, name and URL', async () => {
    await openFrames();
    for (const what of [
      '#inner',
      'iframe[name=payment-frame]',
      'payment-frame',
      'frame-inner.html',
    ]) {
      expect((await bvl('frame', what)).code, what).toBe(0);
      expect((await bvl('eval', 'document.title')).stdout.trim(), what).toBe('"Frame Inner"');
      await bvl('frame', 'main');
    }
  });

  it('can scope to a same-process frame inside the iframe', async () => {
    await openFrames();
    expect((await bvl('frame', 'deep-frame')).code).toBe(0);
    expect((await bvl('eval', 'document.title')).stdout.trim()).toBe('"Frame Deep"');
    expect((await bvl('snapshot', '-i')).stdout).toContain('Deep button');
    expect((await bvl('get', 'text', '#deep-btn')).stdout.trim()).toBe('Deep button');
    await bvl('frame', 'main');
  });

  it('fails clearly on unknown frames and non-iframe elements, keeping the old scope', async () => {
    await openFrames();
    const missing = await bvl('frame', 'nope');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('Frame not found: nope');
    const notFrame = await bvl('frame', '#host-btn');
    expect(notFrame.code).toBe(1);
    expect(notFrame.stderr).toContain('not an iframe');
    const ref = refOf((await bvl('snapshot', '-i')).stdout, /button "Host button"/);
    expect((await bvl('frame', `@${ref}`)).stderr).toContain('not an iframe');
    expect((await bvl('frame', '@e999')).stderr).toContain('Unknown ref');
    expect((await bvl('frame')).code).toBe(1);

    await bvl('frame', 'payment-frame');
    expect((await bvl('frame', 'nope')).code).toBe(1);
    expect((await bvl('eval', 'document.title')).stdout.trim()).toBe('"Frame Inner"');
    await bvl('frame', 'main');
  });

  it('is reset by navigation', async () => {
    await openFrames();
    await bvl('frame', 'payment-frame');
    await bvl('open', fixture('/form.html'));
    expect((await bvl('session', 'info')).stdout).toContain('Frame: main');
    expect((await bvl('eval', 'document.title')).stdout.trim()).not.toBe('"Frame Inner"');
  });

  it('refs of a frame that went away fail clearly', async () => {
    await openFrames();
    const pay = refOf((await bvl('snapshot', '-i')).stdout, /button "Pay"/);
    await bvl('eval', `document.getElementById('inner').remove()`);
    const r = await bvl('click', `@${pay}`);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/iframe .*gone|Stale ref/);
  });
});

describe('service-worker restart', () => {
  it('keeps working with old refs and the frame scope', async () => {
    await openFrames();
    const snap = (await bvl('snapshot', '-i')).stdout;
    const card = refOf(snap, /textbox "Card number"/);
    const pay = refOf(snap, /button "Pay"/);
    await bvl('frame', 'main');
    await restartExtensionWorker();

    expect((await bvl('fill', `@${card}`, '77')).code).toBe(0);
    expect((await bvl('click', `@${pay}`)).code).toBe(0);
    // a new snapshot reads the iframe again and keeps the refs
    const again = (await bvl('snapshot', '-i')).stdout;
    expect(refOf(again, /button "Pay"/)).toBe(pay);
    await bvl('frame', 'payment-frame');
    expect((await bvl('get', 'text', '#out')).stdout.trim()).toBe('paid:77');

    await restartExtensionWorker();
    expect((await bvl('eval', 'document.title')).stdout.trim()).toBe('"Frame Inner"');
    await bvl('frame', 'main');
  });
});

describe('with an allowed-domains policy', () => {
  afterEach(async () => {
    await setGuardrails({});
  });

  it('cross-site iframes still load and work; only top-level navigations are guarded', async () => {
    // frames.html is on 127.0.0.1 and embeds a frame from localhost, which the policy does not list.
    await setGuardrails({ allowedDomains: ['127.0.0.1'] });
    await openFrames(); // fails if the iframe never shows up
    const snap = (await bvl('snapshot', '-i')).stdout;
    const pay = refOf(snap, /button "Pay"/);
    expect((await bvl('click', `@${pay}`)).code).toBe(0);
    // Top-level navigation to the same unlisted site is still refused.
    const out = fixture('/form.html').replace('127.0.0.1', 'localhost');
    const r = await bvlJson('open', out);
    expect(r).toMatchObject({ success: false, code: 'domain_blocked' });
  });
});
