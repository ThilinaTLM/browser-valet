// fill on date/time inputs, several-match warnings, navigation reports, stale refs.

import { describe, expect, it } from 'vitest';
import { bvl, fixture, useBrowser } from './harness';

useBrowser();

interface Json {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
  code?: string;
}
const json = async (...args: string[]) => {
  const r = await bvl(...args, '--json');
  return { ...(JSON.parse(r.stdout) as Json), stderr: r.stderr };
};

describe('fill', () => {
  it('sets time/date inputs and reads the value back', async () => {
    await bvl('open', fixture('/ergonomics.html'));
    expect((await bvl('fill', '#alarm', '10:30')).code).toBe(0);
    expect((await bvl('get', 'value', '#alarm')).stdout.trim()).toBe('10:30');
    expect((await bvl('fill', '#day', '2026-03-04')).code).toBe(0);
    expect((await bvl('get', 'value', '#day')).stdout.trim()).toBe('2026-03-04');
  });

  it('fails when the value did not stick, with a format hint', async () => {
    const r = await json('fill', '#alarm', 'half past ten');
    expect(r).toMatchObject({ success: false });
    expect(r.error).toContain('fill did not stick: value is ""');
    expect(r.error).toContain('HH:MM');
  });

  it('plain text still works', async () => {
    expect((await bvl('fill', '#plain', 'hello')).stdout).toBe('✓ Done\n');
  });
});

describe('several matches', () => {
  it('warns when a selector matches more than one element', async () => {
    const r = await bvl('click', '.item');
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('3 elements match ".item"; used the first.');
    expect((await bvl('click', 'a[href="#two"]')).stderr).toBe('');
    expect((await bvl('get', 'count', '.item')).stderr).toBe('');
  });

  it('warns for find text with several matches', async () => {
    const r = await bvl('find', 'role', 'link', 'click');
    expect(r.stderr).toContain('elements match role "link"; used the first.');
  });
});

describe('navigation report and stale refs', () => {
  it('reports the navigation a click causes and flags old refs as stale', async () => {
    await bvl('open', fixture('/ergonomics.html'));
    const snap = await bvl('snapshot', '-i');
    const ref = /link "Go elsewhere" \[ref=(e\d+)\]/.exec(snap.stdout)?.[1];
    expect(ref).toBeDefined();
    const r = await bvl('click', `@${ref ?? ''}`);
    expect(r.stdout).toMatch(/^✓ Done → .*\/other\.html/);
    expect(r.stdout).toContain('refs reset');
    const stale = await json('click', `@${ref ?? ''}`);
    expect(stale).toMatchObject({ success: false, code: 'stale_ref' });
    expect(stale.error).toContain('from a previous page');
    expect(await json('click', '@e9999')).toMatchObject({ code: 'unknown_ref' });
  });

  it('adds navigated to --json, and select reports navigation too', async () => {
    await bvl('open', fixture('/ergonomics.html'));
    const r = await json('click', '#go');
    expect(r.data).toMatchObject({
      clicked: '#go',
      navigated: { url: expect.any(String) as string },
    });
    await bvl('open', fixture('/ergonomics.html'));
    expect((await bvl('select', '#pick', 'away')).stdout).toContain('→');
  });

  it('does not report when nothing navigated', async () => {
    await bvl('open', fixture('/ergonomics.html'));
    expect((await bvl('click', 'h1')).stdout).toBe('✓ Done\n');
  });
});
