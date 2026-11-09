import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliRequest, CliResponse } from '../../src/shared';
import { installChromeMock } from '../helpers/chrome-mock';

let execute: typeof import('../../src/background/dispatch').execute;
let stateMod: typeof import('../../src/background/state');

const req = (...argv: string[]): CliRequest => ({
  argv,
  cwd: '/work',
  tmp: '/tmp',
  sep: '/',
  platform: 'linux',
  session: 'default',
});
const run = (...argv: string[]): Promise<CliResponse> =>
  execute(req(...argv), new AbortController().signal, () => undefined);

beforeEach(async () => {
  vi.resetModules();
  installChromeMock();
  stateMod = await import('../../src/background/state');
  ({ execute } = await import('../../src/background/dispatch'));
});

describe('help generation', () => {
  it('lists every group and the core loop for `help` and no arguments', async () => {
    for (const argv of [[], ['help']]) {
      const r = await run(...argv);
      expect(r.exitCode).toBe(0);
      for (const g of ['Navigation', 'Tabs', 'Reading', 'Interaction', 'Waiting', 'Debugging']) {
        expect(r.stdout).toContain(`\n${g}\n`);
      }
      expect(r.stdout).toContain('Core loop:');
      expect(r.stdout).toContain('Handled by the CLI itself:');
    }
  });

  it('prints per-command help for `help <cmd>` and `<cmd> --help`', async () => {
    const a = await run('help', 'click');
    const b = await run('click', '--help');
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toMatch(/^Usage: bctl click /);
    expect(a.stdout).toContain('--json');
    expect(a.stdout).toContain('--session <value>');
  });

  it('shows command-specific flags in command help', async () => {
    const r = await run('help', 'tab');
    expect(r.stdout).toContain('--label <value>');
  });

  it('falls back to general help for an unknown `help <x>`', async () => {
    expect((await run('help', 'zzz')).stdout).toContain('Core loop:');
  });

  it('fails on an unknown command (plain and --json)', async () => {
    const plain = await run('zzz');
    expect(plain).toMatchObject({ exitCode: 1, stdout: '' });
    expect(plain.stderr).toBe('✗ Unknown command: zzz. Run `bctl help`.\n');
    const json = await run('zzz', '--json');
    expect(JSON.parse(json.stdout)).toEqual({
      success: false,
      data: null,
      error: 'Unknown command: zzz. Run `bctl help`.',
    });
    expect(json.stderr).toBe('');
  });
});

describe('activity log (describe)', () => {
  const lastCommand = () => stateMod.state.log[0]?.command;

  it('logs the command line without global flags', async () => {
    await run('--session', 'a', 'open', 'https://example.com', '--json', '--timeout=5');
    expect(lastCommand()).toBe('open https://example.com');
  });

  it('redacts text typed by fill, type and keyboard', async () => {
    await run('fill', '@e2', 'hunter2');
    expect(lastCommand()).toBe('fill @e2 •••');
    await run('type', '@e2', 'hunter2');
    expect(lastCommand()).toBe('type @e2 •••');
    await run('keyboard', 'type', 'hunter2');
    expect(lastCommand()).toBe('keyboard type •••');
  });

  it('redacts the value of a nested find action but keeps the locator and action', async () => {
    await run('find', 'label', 'Password', 'fill', 'hunter2');
    expect(lastCommand()).toBe('find label Password fill •••');
    await run('find', 'placeholder', 'Pw', 'type', 'hunter2', '--exact');
    expect(lastCommand()).toBe('find placeholder Pw type ••• --exact');
    await run('find', 'first', 'input', 'fill', 'hunter2');
    expect(lastCommand()).toBe('find first input fill •••');
    await run('find', 'nth', '2', 'input', 'fill', 'hunter2');
    expect(lastCommand()).toBe('find nth 2 input fill •••');
    await run('find', 'role', 'textbox', '--name', 'Email', 'select', 'x');
    expect(lastCommand()).toBe('find role textbox select ••• --name Email');
  });

  it('redacts the text of dialog accept', async () => {
    await run('dialog', 'accept', 'hunter2');
    expect(lastCommand()).toBe('dialog accept •••');
    await run('dialog', 'dismiss');
    expect(lastCommand()).toBe('dialog dismiss');
  });

  it('logs eval only as its size, for inline, base64 and stdin scripts', async () => {
    await run('eval', 'document.cookie');
    expect(lastCommand()).toBe('eval (15 chars)');
    await run('eval', '-b', btoa('1+1'));
    expect(lastCommand()).toBe('eval (3 chars)');
    await run('eval', '--stdin');
    expect(lastCommand()).toBe('eval (0 chars)');
    const r = req('eval', '--stdin');
    await execute({ ...r, stdin: 'secret()' }, new AbortController().signal, () => undefined);
    expect(lastCommand()).toBe('eval (8 chars)');
  });

  it('redacts string flag values and extra arguments unless the command opts in', async () => {
    await run('wait', '--fn', 'document.title === "secret"');
    expect(lastCommand()).toBe('wait --fn •••');
    await run('wait', '--text', 'Welcome');
    expect(lastCommand()).toBe('wait --text Welcome');
    await run('select', '@e1', 'hunter2');
    expect(lastCommand()).toBe('select @e1 •••');
  });

  it('logs only the command name when the arguments do not parse', async () => {
    await run('fill', '--bogus', 'hunter2');
    expect(lastCommand()).toBe('fill');
  });

  it('truncates long lines to 120 characters', async () => {
    await run('open', `https://example.com/${'a'.repeat(300)}`);
    const line = lastCommand() ?? '';
    expect(line).toHaveLength(120);
    expect(line.endsWith('…')).toBe(true);
  });

  it('records failures with the error and ok=false, newest first, capped at 50', async () => {
    await run('zzz'); // unknown commands are not logged (rejected before the try block)
    await run('click');
    const e = stateMod.state.log[0];
    expect(e).toMatchObject({ command: 'click', ok: false, session: 'default' });
    expect(e?.error).toBeTruthy();
    for (let i = 0; i < 60; i++) await run('click');
    expect(stateMod.state.log).toHaveLength(50);
  });
});
