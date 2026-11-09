// Output conventions: warnings on stderr, stable JSON error codes, usage on missing arguments.

import { describe, expect, it } from 'vitest';
import { bctl, bctlWith, fixture, useBrowser } from './harness';

useBrowser();

interface Err {
  success: boolean;
  data: unknown;
  error: string;
  code?: string;
  type?: string;
}
const errOf = async (...args: string[]): Promise<Err & { stderr: string; code_: number }> => {
  const r = await bctl(...args, '--json');
  return { ...(JSON.parse(r.stdout) as Err), stderr: r.stderr, code_: r.code };
};

describe('warnings go to stderr', () => {
  it('a confirm dialog opened by click is reported on stderr, stdout stays clean', async () => {
    expect((await bctl('open', fixture('/dialog.html'))).code).toBe(0);
    const r = await bctl('click', '#ask');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('✓ Done\n');
    expect(r.stderr).toMatch(
      /^⚠ A JavaScript confirm dialog is blocking the page: "Really\?" — use `bctl dialog accept` or `bctl dialog dismiss`\n$/,
    );
    const json = await bctl('dialog', 'status', '--json');
    expect(JSON.parse(json.stdout)).toMatchObject({ success: true });
    // Commands on the blocked tab fail with a stable code.
    const blocked = await errOf('get', 'title');
    expect(blocked).toMatchObject({ success: false, code: 'dialog_open', code_: 1 });
    expect((await bctl('dialog', 'dismiss')).code).toBe(0);
  });

  it('--json keeps the dialog in data and the notice on stderr', async () => {
    const r = await bctl('click', '#ask', '--json');
    expect(JSON.parse(r.stdout)).toMatchObject({
      success: true,
      data: { dialog: { type: 'confirm', message: 'Really?' } },
    });
    expect(r.stderr).toContain('⚠ A JavaScript confirm dialog');
    await bctl('dialog', 'accept');
  });
});

describe('JSON error codes', () => {
  it('maps targeting failures', async () => {
    await bctl('open', fixture('/form.html'));
    expect(await errOf('click', '#nope')).toMatchObject({ code: 'not_found' });
    expect(await errOf('click', '@e999')).toMatchObject({ code: 'unknown_ref' });
    expect(await errOf('wait', '#never', '--timeout', '600')).toMatchObject({ code: 'timeout' });
  });

  it('maps argument errors and appends the usage line', async () => {
    const e = await errOf('click');
    expect(e).toMatchObject({ success: false, code: 'bad_args' });
    expect(e.error).toMatch(/^Missing .*\nUsage: bctl click /);
    const text = await bctl('click');
    expect(text.stderr).toMatch(/^✗ Missing .*\nUsage: bctl click /);
    expect(await errOf('wait', '--bogus')).toMatchObject({ code: 'bad_args' });
  });

  it('unknown commands carry type and code', async () => {
    expect(await errOf('frobnicate')).toMatchObject({
      code: 'unknown_command',
      type: 'unknown_command',
    });
  });

  it('a session without a tab reports no_tab', async () => {
    const r = await bctlWith({ BCTL_SESSION: 'fresh-no-tab' }, 'get', 'title', '--json');
    expect(JSON.parse(r.stdout)).toMatchObject({ success: false, code: 'no_tab' });
  });

  it('errors without a stable code have no code key', async () => {
    const e = await errOf('eval', 'throw new Error("x")');
    expect(e.success).toBe(false);
    expect(e).not.toHaveProperty('code');
  });
});
