import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliRequest, CliResponse } from '../../src/shared';
import { installChromeMock } from '../helpers/chrome-mock';

let execute: typeof import('../../src/background/dispatch').execute;
let batch: typeof import('../../src/background/commands/batch');
let stateMod: typeof import('../../src/background/state');

const req = (argv: string[], stdin?: string): CliRequest => ({
  argv,
  cwd: '/work',
  tmp: '/tmp',
  sep: '/',
  platform: 'linux',
  session: 'default',
  stdin,
});
const run = (argv: string[], stdin?: string, signal = new AbortController().signal) =>
  execute(req(argv, stdin), signal, () => undefined);

beforeEach(async () => {
  vi.resetModules();
  installChromeMock();
  stateMod = await import('../../src/background/state');
  batch = await import('../../src/background/commands/batch');
  ({ execute } = await import('../../src/background/dispatch'));
});

describe('tokenize', () => {
  it('splits on whitespace and handles quotes and escapes', () => {
    const t = batch.tokenize;
    expect(t('  fill   @e1  hello ')).toEqual(['fill', '@e1', 'hello']);
    expect(t(`fill @e1 "hello world"`)).toEqual(['fill', '@e1', 'hello world']);
    expect(t(`fill @e1 'a "b" \\c'`)).toEqual(['fill', '@e1', 'a "b" \\c']);
    expect(t(`fill @e1 "say \\"hi\\" \\\\ \\n"`)).toEqual(['fill', '@e1', 'say "hi" \\ \\n']);
    expect(t('fill @e1 hello\\ world')).toEqual(['fill', '@e1', 'hello world']);
    expect(t('a""b c')).toEqual(['ab', 'c']);
    expect(t('fill @e1 ""')).toEqual(['fill', '@e1', '']);
    expect(t("it's".replace("'", "\\'"))).toEqual(["it's"]);
  });

  it('does no expansion', () => {
    expect(batch.tokenize('echo $HOME ~ *.ts `x` $(y)')).toEqual([
      'echo',
      '$HOME',
      '~',
      '*.ts',
      '`x`',
      '$(y)',
    ]);
  });

  it('rejects unterminated quotes and yields nothing for blank lines', () => {
    expect(() => batch.tokenize('fill "abc')).toThrow(/Unterminated/);
    expect(batch.tokenize('   ')).toEqual([]);
  });
});

describe('formatting', () => {
  const items = [
    { command: ['get', 'url'], success: true, result: { url: 'x' }, error: null },
    { command: ['click', '#n'], success: false, result: null, error: 'nope' },
  ];
  it('JSON is a top-level array with upstream keys', () => {
    expect(JSON.parse(batch.formatBatchJson(items, false))).toEqual(items);
    expect(JSON.parse(batch.formatBatchJson(items, true))).toEqual([
      { index: 0, success: true, result: { url: 'x' }, error: null },
      { index: 1, success: false, result: null, error: 'nope' },
    ]);
  });
  it('text joins item outputs like upstream (blank line between)', () => {
    expect(batch.formatBatchText(['\n', 'about:blank\n', '', '\n'])).toBe(
      '\n\nabout:blank\n\n\n\n',
    );
  });
});

describe('rejectItem', () => {
  it('rejects per-item session, stdin, nesting and empties', () => {
    expect(batch.rejectItem(['click', '@e1', '--session', 'x'])).toMatch(/--session/);
    expect(batch.rejectItem(['click', '--session=x'])).toMatch(/--session/);
    expect(batch.rejectItem(['eval', '--stdin'])).toMatch(/--stdin/);
    expect(batch.rejectItem(['batch', 'help'])).toMatch(/nested/);
    expect(batch.rejectItem([])).toBe('Empty command');
    const set = new Set(['allowed-domains', 'confirm-actions']);
    expect(batch.rejectItem(['open', 'x', '--allowed-domains', 'a.com'], set)).toMatch(
      /cannot be repeated/,
    );
    expect(batch.rejectItem(['eval', '1', '--confirm-actions=eval'], set)).toMatch(
      /--confirm-actions/,
    );
    // not set on the batch: an item may narrow its own run
    expect(batch.rejectItem(['open', 'x', '--allowed-domains', 'a.com'])).toBeUndefined();
    // --max-output and --content-boundaries are not policy: an item may set its own
    expect(
      batch.rejectItem(['get', 'text', '--max-output', '5'], new Set(['max-output'])),
    ).toBeUndefined();
    expect(batch.rejectItem(['eval', '-b', 'MQ=='])).toBeUndefined();
  });
});

describe('batch through execute', () => {
  it('runs items in order and joins their stdout', async () => {
    const r = await run(['batch', 'help click', 'help eval']);
    expect(r.exitCode).toBe(0);
    const [a, b] = r.stdout.split('\n\nUsage: bvl ').map((s) => s);
    expect(a).toMatch(/^Usage: bvl click /);
    expect(b).toContain('eval');
  });

  it('continues after a failure, reports it on stderr and exits 1', async () => {
    const r = await run(['batch', 'help click', 'frobnicate', 'help eval']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe('✗ Unknown command: frobnicate. Run `bvl help`.\n');
    expect(r.stdout).toContain('Usage: bvl eval');
  });

  it('--bail stops at the first failure', async () => {
    const r = await run(['batch', '--bail', 'help click', 'frobnicate', 'help eval']);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).not.toContain('Usage: bvl eval');
  });

  it('--json is a top-level array; --omit-command uses index', async () => {
    const r = await run(['batch', '--json', 'help click', 'frobnicate']);
    const out = JSON.parse(r.stdout) as Record<string, unknown>[];
    expect(Array.isArray(out)).toBe(true);
    expect(out[0]).toMatchObject({ command: ['help', 'click'], success: true, error: null });
    expect(out[1]).toMatchObject({
      command: ['frobnicate'],
      success: false,
      result: null,
      error: expect.stringContaining('Unknown command') as unknown,
    });
    const o: unknown = JSON.parse(
      (await run(['batch', '--json', '--omit-command', 'help'])).stdout,
    );
    expect(o).toEqual([{ index: 0, success: true, result: null, error: null }]);
  });

  it('--stdin reads one command per line, skipping blanks', async () => {
    const r = await run(['batch', '--stdin', '--json'], 'help click\n\nhelp "eval"\r\n');
    expect(JSON.parse(r.stdout)).toHaveLength(2);
  });

  it('rejects nested batch, per-item --session and an empty batch', async () => {
    const r = await run(['batch', '--json', 'batch "help"', 'help --session x']);
    const out = JSON.parse(r.stdout) as { success: boolean; error: string }[];
    expect(out.map((i) => i.success)).toEqual([false, false]);
    expect(out[0]?.error).toMatch(/nested/);
    expect(out[1]?.error).toMatch(/--session/);
    const e = await run(['batch']);
    expect(e.exitCode).toBe(1);
    expect(e.stderr).toMatch(/Missing commands/);
  });

  it('an item failing on its own (no tab) is logged per item, never the raw line', async () => {
    await run(['batch', 'get title', 'fill #x "secret words"', 'wait 1']);
    const cmds = stateMod.state.log.map((e) => e.command);
    expect(cmds.some((c) => c.startsWith('get title'))).toBe(true);
    expect(cmds.every((c) => !c.startsWith('batch'))).toBe(true);
    expect(cmds.join('\n')).not.toContain('secret words');
  });

  it('a cancelled signal skips the rest', async () => {
    const ac = new AbortController();
    ac.abort();
    const r: CliResponse = await run(['batch', '--json', 'help click'], undefined, ac.signal);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });

  it('shows help', async () => {
    const r = await run(['batch', '--help']);
    expect(r.stdout).toMatch(/^Usage: bvl batch /);
    expect(r.stdout).toContain('--bail');
  });
});
