// Output conventions: warnings on stderr, stable JSON error codes, usage on missing arguments.

import { describe, expect, it } from 'vitest';
import { bvl, bvlWith, fixture, useBrowser } from './harness';

useBrowser();

interface Err {
  success: boolean;
  data: unknown;
  error: string;
  code?: string;
  type?: string;
}
const errOf = async (...args: string[]): Promise<Err & { stderr: string; code_: number }> => {
  const r = await bvl(...args, '--json');
  return { ...(JSON.parse(r.stdout) as Err), stderr: r.stderr, code_: r.code };
};

describe('warnings go to stderr', () => {
  it('a confirm dialog opened by click is reported on stderr, stdout stays clean', async () => {
    expect((await bvl('open', fixture('/dialog.html'))).code).toBe(0);
    const r = await bvl('click', '#ask');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('✓ Done\n');
    expect(r.stderr).toMatch(
      /^⚠ A JavaScript confirm dialog is blocking the page: "Really\?" — use `bvl dialog accept` or `bvl dialog dismiss`\n$/,
    );
    const json = await bvl('dialog', 'status', '--json');
    expect(JSON.parse(json.stdout)).toMatchObject({ success: true });
    // Commands on the blocked tab fail with a stable code.
    const blocked = await errOf('get', 'title');
    expect(blocked).toMatchObject({ success: false, code: 'dialog_open', code_: 1 });
    expect((await bvl('dialog', 'dismiss')).code).toBe(0);
  });

  it('--json keeps the dialog in data and the notice on stderr', async () => {
    const r = await bvl('click', '#ask', '--json');
    expect(JSON.parse(r.stdout)).toMatchObject({
      success: true,
      data: { dialog: { type: 'confirm', message: 'Really?' } },
    });
    expect(r.stderr).toContain('⚠ A JavaScript confirm dialog');
    await bvl('dialog', 'accept');
  });
});

describe('JSON error codes', () => {
  it('maps targeting failures', async () => {
    await bvl('open', fixture('/form.html'));
    expect(await errOf('click', '#nope')).toMatchObject({ code: 'not_found' });
    expect(await errOf('click', '@e999')).toMatchObject({ code: 'unknown_ref' });
    expect(await errOf('wait', '#never', '--timeout', '600')).toMatchObject({ code: 'timeout' });
  });

  it('maps argument errors and appends the usage line', async () => {
    const e = await errOf('click');
    expect(e).toMatchObject({ success: false, code: 'bad_args' });
    expect(e.error).toMatch(/^Missing .*\nUsage: bvl click /);
    const text = await bvl('click');
    expect(text.stderr).toMatch(/^✗ Missing .*\nUsage: bvl click /);
    expect(await errOf('wait', '--bogus')).toMatchObject({ code: 'bad_args' });
  });

  it('unknown commands carry type and code', async () => {
    expect(await errOf('frobnicate')).toMatchObject({
      code: 'unknown_command',
      type: 'unknown_command',
    });
  });

  it('a session without a tab reports no_tab', async () => {
    const r = await bvlWith({ BVL_SESSION: 'fresh-no-tab' }, 'get', 'title', '--json');
    expect(JSON.parse(r.stdout)).toMatchObject({ success: false, code: 'no_tab' });
  });

  it('errors without a stable code have no code key', async () => {
    const e = await errOf('eval', 'throw new Error("x")');
    expect(e.success).toBe(false);
    expect(e).not.toHaveProperty('code');
  });
});

describe('wait prints what it matched', () => {
  it('--text prints the text, --url prints the final URL, others stay ✓ Done', async () => {
    await bvl('open', fixture('/form.html'));
    await bvl('eval', 'setTimeout(() => document.body.append("Zebra marker"), 200)');
    expect((await bvl('wait', '--text', 'Zebra marker')).stdout).toBe('Zebra marker\n');

    await bvl('eval', 'setTimeout(() => history.pushState({}, "", "/dashboard"), 200)');
    const url = await bvl('wait', '--url', '**/dashboard');
    expect(url.stdout).toBe(`${fixture('/dashboard')}\n`);

    expect((await bvl('wait', '--url', 'dashboard', '--json')).stdout).toContain(
      JSON.stringify({ url: fixture('/dashboard') }),
    );
    expect(JSON.parse((await bvl('wait', '--text', 'Zebra marker', '--json')).stdout)).toEqual({
      success: true,
      data: { text: 'Zebra marker' },
      error: null,
    });

    expect((await bvl('wait', 'h1')).stdout).toBe('✓ Done\n');
    expect((await bvl('wait', '--fn', 'true')).stdout).toBe('✓ Done\n');
    expect((await bvl('wait', '50')).stdout).toBe('✓ Done\n');
    expect((await bvl('wait', '--load', 'load')).stdout).toBe('✓ Done\n');
  });
});

describe('JSON fields line up with agent-browser', () => {
  const json = async (...args: string[]) =>
    (JSON.parse((await bvl(...args, '--json')).stdout) as { data: Record<string, unknown> }).data;

  it('actions echo their target', async () => {
    await bvl('open', fixture('/form.html'));
    const snap = (await bvl('snapshot', '-i')).stdout;
    const ref = `@${/\[ref=(e\d+)\]/.exec(snap.split('\n').find((l) => l.includes('textbox')) ?? '')?.[1]}`;
    expect(await json('fill', ref, 'hello')).toEqual({ filled: ref });
    expect(await json('type', ref, '!')).toEqual({ typed: '!' });
    expect(await json('focus', ref)).toEqual({ focused: ref });
    expect(await json('hover', ref)).toEqual({ hovered: ref });
    expect(await json('press', 'Tab')).toEqual({ pressed: 'Tab' });
    expect(await json('scroll', 'down', '10')).toEqual({ scrolled: true });
    expect(await json('wait', '20')).toEqual({ ms: 20, waited: 'timeout' });
    expect(await json('click', 'h1')).toEqual({ clicked: 'h1' });
  });

  it('page reads carry origin; get attr uses value', async () => {
    const origin = fixture('/form.html');
    expect(await json('get', 'text', 'h1')).toMatchObject({ text: 'Fixture Form', origin });
    expect(await json('get', 'attr', 'h1', 'id')).toMatchObject({ value: null, origin });
    expect(await json('get', 'count', 'h1')).toMatchObject({ count: 1, selector: 'h1' });
    const box = await json('get', 'box', 'h1');
    expect(typeof box.width).toBe('number');
    expect(box).toHaveProperty('x');
    expect(await json('eval', '1+1')).toEqual({ result: 2, origin });
    expect(await json('is', 'visible', 'h1')).toEqual({ visible: true, origin });
    expect(await json('dialog', 'status')).toMatchObject({ hasDialog: false, open: false });
  });

  it('console and errors are lists of objects', async () => {
    await bvl('eval', 'console.log("hi", 1); setTimeout(() => { throw new Error("boom") }, 10)');
    await bvl('wait', '300');
    const c = await json('console');
    expect(c.messages).toEqual([
      expect.objectContaining({
        type: 'log',
        text: 'hi 1',
        args: [expect.anything(), expect.anything()],
      }),
    ]);
    const e = await json('errors');
    const errs = e.errors as { text: string }[];
    expect(errs).toHaveLength(1);
    expect(errs[0]?.text).toMatch(/Error: boom/);
    expect((await bvl('console')).stdout).toBe('[log] hi 1\n');
  });

  it('tab list is { tabs: [...] } with the upstream fields plus controlled/pending', async () => {
    const r = await bvl('tab', '--json');
    const d = (JSON.parse(r.stdout) as { data: { tabs: Record<string, unknown>[] } }).data;
    expect(d.tabs.length).toBeGreaterThan(0);
    expect(d.tabs[0]).toHaveProperty('tabId');
    for (const k of ['label', 'title', 'url', 'active', 'controlled', 'pending']) {
      expect(d.tabs[0]).toHaveProperty(k);
    }
  });
});
