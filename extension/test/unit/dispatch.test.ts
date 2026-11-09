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

describe('activity log (describe) — current behaviour', () => {
  const lastCommand = () => stateMod.state.log[0]?.command;

  it('logs the command line without global flags', async () => {
    await run('--session', 'a', 'open', 'https://example.com', '--json', '--timeout=5');
    expect(lastCommand()).toBe('open https://example.com');
  });

  it('redacts text typed by fill, type and keyboard (everything after the first argument)', async () => {
    await run('fill', '@e2', 'hunter2');
    expect(lastCommand()).toBe('fill @e2 •••');
    await run('type', '@e2', 'hunter2');
    expect(lastCommand()).toBe('type @e2 •••');
    await run('keyboard', 'type', 'hunter2');
    expect(lastCommand()).toBe('keyboard type •••');
  });

  it('does not redact other commands (known debt: activity-log-redaction proposal)', async () => {
    await run('find', 'label', 'Password', 'fill', 'hunter2');
    expect(lastCommand()).toBe('find label Password fill hunter2');
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
