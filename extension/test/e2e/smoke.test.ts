// Smoke suite: the commands and the consent flow end to end, with a real Chrome, the real
// extension and the real bctl binary. Add new E2E files next to this one (see harness.ts).

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
} from './harness';

useBrowser();

/** The ref of the first snapshot line matching `re`, e.g. `@e2`. */
function refOf(snapshot: string, re: RegExp): string {
  const line = snapshot.split('\n').find((l) => re.test(l));
  const ref = /\[ref=(e\d+)\]/.exec(line ?? '')?.[1];
  if (!ref) throw new Error(`No ref for ${re} in:\n${snapshot}`);
  return `@${ref}`;
}

describe('agent tab (no consent needed)', () => {
  it('open, snapshot -i, fill, click, get text', async () => {
    const open = await bctl('open', fixture('/form.html'));
    expect(open).toMatchObject({ code: 0, stderr: '' });
    expect(open.stdout).toContain('Fixture Form');

    const snap = (await bctl('snapshot', '-i')).stdout;
    expect(snap).toContain('textbox "Name"');
    expect(snap).toContain('button "Increment"');

    expect((await bctl('fill', refOf(snap, /textbox/), 'Ada')).code).toBe(0);
    expect((await bctl('get', 'text', '#echo')).stdout).toContain('Hello, Ada!');

    // Clicking a background tab works without it ever being focused.
    const button = refOf(snap, /button "Increment"/);
    expect((await bctl('click', button)).code).toBe(0);
    expect((await bctl('click', button)).code).toBe(0);
    expect((await bctl('get', 'text', '#count')).stdout).toContain('Count: 2');
  });

  it('--json output and errors', async () => {
    const ok = await bctlJson('get', 'text', 'h1');
    expect(ok).toMatchObject({ success: true, error: null });
    expect(JSON.stringify(ok.data)).toContain('Fixture Form');

    const bad = await bctl('click', '@e99');
    expect(bad.code).toBe(1);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toMatch(/^✗ /);

    const unknown = await bctl('nonsense');
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('Unknown command: nonsense');
  });

  it('help comes from the extension', async () => {
    const r = await bctl('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Core loop:');
  });
});

describe('consent', () => {
  it('a user-opened tab is not shared until the user allows it', async () => {
    const page = await openUserTab(fixture('/'));
    try {
      const tid = await tidForTitle('Fixture Home');
      expect((await bctl('tab')).stdout).toMatch(/Fixture Home.*\[not shared\]/);

      const pending = bctl('tab', tid);
      await approveNextConsent('allow');
      const r = await pending;
      expect(r.code).toBe(0);
      expect(r.stderr).toContain('Waiting for the user to allow control');
      expect(r.stdout).toContain('Fixture Home');

      expect((await bctl('get', 'text', 'h1')).stdout).toContain('Fixture Home');
      expect((await bctl('tab')).stdout).not.toMatch(/Fixture Home.*\[not shared\]/);

      // Revoke through the popup's Stop button: the agent loses the tab immediately.
      await stopTabInPopup(tid);
      const after = await bctl('get', 'text', 'h1');
      expect(after.code).toBe(1);
      expect(after.stderr).toContain('not shared');
      expect((await bctl('tab')).stdout).toMatch(/Fixture Home.*\[not shared\]/);
    } finally {
      await page.close();
    }
  });

  it('denying keeps the tab off-limits', async () => {
    const page = await openUserTab(fixture('/other.html'));
    try {
      const tid = await tidForTitle('Fixture Other');
      const pending = bctl('tab', tid);
      await approveNextConsent('deny');
      const r = await pending;
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('denied');
      expect((await bctl('tab')).stdout).toMatch(/Fixture Other.*\[not shared\]/);
    } finally {
      await page.close();
    }
  });

  it('closing the tab while the consent request is pending fails the command promptly', async () => {
    // Chrome may give a CDP-created tab an opener (an agent tab), which makes it an agent tab
    // too. Retry until we get a plain user tab.
    const unshared = async () =>
      /\[(t\d+)\] Fixture Other.*\[not shared\]/.exec((await bctl('tab')).stdout)?.[1];
    let page = await openUserTab(fixture('/other.html'));
    let tid = await unshared();
    for (let i = 0; i < 5 && !tid; i++) {
      await page.close();
      page = await openUserTab(fixture('/other.html'));
      tid = await unshared();
    }
    if (!tid) throw new Error('could not open a plain user tab');
    const started = Date.now();
    const pending = bctl('tab', tid);
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
