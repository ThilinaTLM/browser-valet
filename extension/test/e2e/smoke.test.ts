// Smoke suite: the commands and the consent flow end to end, with a real Chrome, the real
// extension and the real bvl binary. Add new E2E files next to this one (see harness.ts).

import { describe, expect, it, inject } from 'vitest';
import {
  approveNextConsent,
  bvl,
  bvlJson,
  fixture,
  openUserTab,
  stopTabInPopup,
  tidForTitle,
  useBrowser,
} from './harness';

const browser = useBrowser();

/** The ref of the first snapshot line matching `re`, e.g. `@e2`. */
function refOf(snapshot: string, re: RegExp): string {
  const line = snapshot.split('\n').find((l) => re.test(l));
  const ref = /\[ref=(e\d+)\]/.exec(line ?? '')?.[1];
  if (!ref) throw new Error(`No ref for ${re} in:\n${snapshot}`);
  return `@${ref}`;
}

describe('agent tab (no consent needed)', () => {
  it('open, snapshot -i, fill, click, get text', async () => {
    const open = await bvl('open', fixture('/form.html'));
    expect(open).toMatchObject({ code: 0, stderr: '' });
    expect(open.stdout).toContain('Fixture Form');

    const snap = (await bvl('snapshot', '-i')).stdout;
    expect(snap).toContain('textbox "Name"');
    expect(snap).toContain('button "Increment"');

    expect((await bvl('fill', refOf(snap, /textbox/), 'Ada')).code).toBe(0);
    expect((await bvl('get', 'text', '#echo')).stdout).toContain('Hello, Ada!');

    // Clicking a background tab works without it ever being focused.
    const button = refOf(snap, /button "Increment"/);
    expect((await bvl('click', button)).code).toBe(0);
    expect((await bvl('click', button)).code).toBe(0);
    expect((await bvl('get', 'text', '#count')).stdout).toContain('Count: 2');
  });

  it('--json output and errors', async () => {
    const ok = await bvlJson('get', 'text', 'h1');
    expect(ok).toMatchObject({ success: true, error: null });
    expect(JSON.stringify(ok.data)).toContain('Fixture Form');

    const bad = await bvl('click', '@e99');
    expect(bad.code).toBe(1);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toMatch(/^✗ /);

    const unknown = await bvl('nonsense');
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('Unknown command: nonsense');
  });

  it('help comes from the extension', async () => {
    const r = await bvl('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Core loop:');
  });
});

describe('consent', () => {
  it('a user-opened tab is not shared until the user allows it', async () => {
    const page = await openUserTab(fixture('/'));
    try {
      const tid = await tidForTitle('Fixture Home');
      expect((await bvl('tab')).stdout).toMatch(/Fixture Home.*\[not shared\]/);

      const pending = bvl('tab', tid);
      await approveNextConsent('allow');
      const r = await pending;
      expect(r.code).toBe(0);
      expect(r.stderr).toContain('Waiting for the user to allow control');
      expect(r.stdout).toContain('Fixture Home');

      expect((await bvl('get', 'text', 'h1')).stdout).toContain('Fixture Home');
      expect((await bvl('tab')).stdout).not.toMatch(/Fixture Home.*\[not shared\]/);

      // Revoke through the popup's Stop button: the agent loses the tab immediately.
      await stopTabInPopup(tid);
      const after = await bvl('get', 'text', 'h1');
      expect(after.code).toBe(1);
      expect(after.stderr).toContain('not shared');
      expect((await bvl('tab')).stdout).toMatch(/Fixture Home.*\[not shared\]/);
    } finally {
      await page.close();
    }
  });

  it('denying keeps the tab off-limits', async () => {
    const page = await openUserTab(fixture('/other.html'));
    try {
      const tid = await tidForTitle('Fixture Other');
      const pending = bvl('tab', tid);
      await approveNextConsent('deny');
      const r = await pending;
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('denied');
      expect((await bvl('tab')).stdout).toMatch(/Fixture Other.*\[not shared\]/);
    } finally {
      await page.close();
    }
  });

  it('closing the tab while the consent request is pending fails the command promptly', async () => {
    // Chrome may give a CDP-created tab an opener (an agent tab), which makes it an agent tab
    // too. Retry until we get a plain user tab.
    const unshared = async () =>
      /\[(t\d+)\] Fixture Other.*\[not shared\]/.exec((await bvl('tab')).stdout)?.[1];
    let page = await openUserTab(fixture('/other.html'));
    let tid = await unshared();
    for (let i = 0; i < 5 && !tid; i++) {
      await page.close();
      page = await openUserTab(fixture('/other.html'));
      tid = await unshared();
    }
    if (!tid) throw new Error('could not open a plain user tab');
    const started = Date.now();
    const pending = bvl('tab', tid);
    // Give the extension time to register the approval (its own consent window opens), then
    // close the tab instead of answering.
    await new Promise((r) => setTimeout(r, 1500));
    await page.close();
    const r = await pending;
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('closed while waiting');
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});

describe('debugger', () => {
  it('commands keep working after the service worker is restarted', async () => {
    expect((await bvl('open', fixture('/form.html'))).code).toBe(0);
    const sw = await browser.current.waitForTarget(
      (t) => (t.type() as string) === 'service_worker' && t.url().includes('background'),
    );
    // Kill the worker: its in-memory state (including which tabs it attached) is gone.
    const session = await browser.current.target().createCDPSession();
    const targetId = (sw as unknown as { _targetId: string })._targetId;
    await session.send('Target.closeTarget', { targetId });
    // Opening the popup wakes the worker again.
    const popup = await browser.current.newPage();
    await popup.goto(`${inject('e2e').extensionOrigin}/popup.html`);
    await new Promise((r) => setTimeout(r, 1500));
    await popup.close();
    const r = await bvl('snapshot', '-i');
    expect(r.code).toBe(0);
  });
});

describe('read', () => {
  it('reads the main content as markdown, without the nav sidebar', async () => {
    const open = await bvl('read', fixture('/docs.html'));
    expect(open).toMatchObject({ code: 0, stderr: '' });
    const out = open.stdout;
    expect(out).toContain('# Guide');
    expect(out).toContain('## Auth');
    expect(out).toContain('Intro paragraph with a link and **bold**');
    expect(out).toContain('- First item');
    expect(out).toContain('1. Download\n2. Run');
    expect(out).toContain('```js\nconst a = 1;\nconsole.log(a);\n```');
    expect(out).toContain('| Name | Type |\n| --- | --- |\n| id | int |');
    expect(out).not.toContain('Sidebar A');
    expect(out).not.toContain('Footer text');
    expect(out).not.toContain('/link');
  });

  it('--outline, --filter and --max-output', async () => {
    const outline = (await bvl('read', '--outline')).stdout.trimEnd();
    expect(outline).toBe(
      `# Outline\n\nSource: ${fixture('/docs.html')}\n\n- Guide\n  - Auth\n    - Token details\n  - Install`,
    );

    const filtered = (await bvl('read', '--filter', 'auth')).stdout;
    expect(filtered).toMatch(/^## Auth/);
    expect(filtered).toContain('### Token details');
    expect(filtered).not.toContain('## Install');
    expect((await bvl('read', '--filter', 'zzz')).stdout.trimEnd()).toBe(
      'No matching page sections',
    );

    const cut = (await bvl('read', '--max-output', '20')).stdout;
    expect(cut).toContain('[truncated: showing 20 of ');

    const json = await bvlJson('read', '--outline');
    expect(json).toMatchObject({ success: true });
    expect(JSON.stringify(json.data)).toContain('Guide');
  });

  it('read <url> never navigates a shared tab', async () => {
    const page = await openUserTab(fixture('/'));
    try {
      const tid = await tidForTitle('Fixture Home');
      const pending = bvl('tab', tid);
      await approveNextConsent('allow');
      await pending;
      const r = await bvl('read', fixture('/docs.html'));
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('# Guide');
      expect(await page.title()).toBe('Fixture Home');
    } finally {
      await page.close();
    }
  });

  it('falls back to Readability when there is no main/article', async () => {
    const r = await bvl('read', fixture('/prose.html'));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Readable prose');
    expect(r.stdout).not.toContain('Cookie banner');
  });
});
