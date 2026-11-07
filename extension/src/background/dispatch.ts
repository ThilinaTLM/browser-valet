// Turns a CLI request (raw argv) into a response: parse, run, format, log.

import type { CliRequest, CliResponse } from '../shared';
import * as cdp from './cdp';
import { type Command, Ctx, GLOBAL_FLAGS, parseArgs, type Result } from './command';
import { inspectionCommands } from './commands/inspection';
import { interactionCommands } from './commands/interaction';
import { navigationCommands } from './commands/navigation';
import { UserError } from './dom';
import { log, meta } from './state';

const DEFAULT_TIMEOUT = 25_000;

const COMMANDS: Command[] = [...navigationCommands, ...interactionCommands, ...inspectionCommands];
const GROUPS = ['Navigation', 'Tabs', 'Reading', 'Interaction', 'Waiting', 'Debugging'];

function lookup(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

function generalHelp(): string {
  const lines = [
    'bctl — control your real browser from the command line (Browser Bridge)',
    '',
    'Usage: bctl <command> [args] [--json] [--session <name>] [--timeout <ms>]',
  ];
  for (const g of GROUPS) {
    lines.push('', g);
    for (const c of COMMANDS.filter((c) => c.group === g)) {
      const usage = c.usage.split('\n')[0] ?? c.usage;
      lines.push(`  ${usage.padEnd(44)} ${c.summary}`);
    }
  }
  lines.push(
    '',
    'Handled by the CLI itself: pair, unpair, status, stop, proxy, version',
    '',
    'Core loop:',
    '  bctl open https://example.com    # agent tab, opened in the background',
    '  bctl snapshot -i                 # interactive elements with @refs',
    '  bctl click @e3                   # act on refs; re-snapshot after page changes',
    '',
    'Tabs the agent did not open are off-limits until the user approves:',
    '  bctl tab                         # [not shared] marks tabs the agent cannot use',
    '  bctl tab t3                      # asks the user in the browser, waits for the answer',
    '',
    'Run `bctl <command> --help` for details.',
  );
  return lines.join('\n');
}

function commandHelp(c: Command): string {
  const lines = [`Usage: bctl ${c.usage}`, '', c.summary];
  if (c.aliases?.length) lines.push(`Aliases: ${c.aliases.join(', ')}`);
  const flags = [...(c.flags ?? []), ...GLOBAL_FLAGS];
  lines.push('', 'Flags:');
  for (const f of flags) {
    const name = `${f.short ? `-${f.short}, ` : '    '}--${f.name}${f.type === 'string' ? ' <value>' : ''}`;
    lines.push(`  ${name.padEnd(28)} ${f.desc}`);
  }
  return lines.join('\n');
}

/** Split argv into the command name and the rest (global flags may precede the command). */
function splitCommand(argv: string[]): { name: string | undefined; rest: string[] } {
  const withValue = new Set(['--session', '--timeout']);
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? '';
    if (withValue.has(tok)) {
      i++;
      continue;
    }
    if (tok.startsWith('-')) continue;
    return { name: tok, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
  }
  return { name: undefined, rest: argv };
}

function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // CDP errors arrive as JSON: {"code":-32000,"message":"..."}
  try {
    const parsed = JSON.parse(msg) as { message?: string };
    if (parsed.message) return parsed.message;
  } catch {
    // not JSON
  }
  return msg;
}

const SECRET_ARGS: Record<string, number> = { fill: 1, type: 1, keyboard: 1 };

function describe(argv: string[]): string {
  const { name, rest } = splitCommand(argv);
  if (!name) return 'help';
  const redactFrom = SECRET_ARGS[name];
  // Drop global flags (and their values) from the log line.
  const shown: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i] ?? '';
    if (t === '--session' || t === '--timeout') i++;
    else if (!t.startsWith('--session=') && !t.startsWith('--timeout=') && t !== '--json') {
      shown.push(redactFrom !== undefined && shown.length >= redactFrom ? '•••' : t);
    }
  }
  const s = [name, ...shown].join(' ');
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}

/**
 * A confirm/prompt dialog blocks the page, so an action that opens one never completes on its own
 * (Chrome doesn't acknowledge the input until the dialog closes). Return as soon as one opens.
 */
async function raceDialog(ctx: Ctx, run: Promise<Result | undefined>): Promise<Result | undefined> {
  let off = () => undefined as unknown;
  const opened = new Promise<Result>((resolve) => {
    off = cdp.onEvent((tabId, method, params) => {
      if (method !== 'Page.javascriptDialogOpening' || tabId !== ctx.tabId) return;
      const { type, message } = params as { type: string; message: string };
      if (type === 'alert' || type === 'beforeunload') return; // auto-accepted
      resolve({
        text: `✓ Done\n  A ${type} dialog opened: "${message}". Run \`bctl dialog accept\` or \`bctl dialog dismiss\`.`,
        data: { dialog: { type, message } },
      });
    });
  });
  run.catch(() => undefined); // if the dialog wins, the action settles later; ignore it
  try {
    return await Promise.race([run, opened]);
  } finally {
    off();
  }
}

export async function execute(
  req: CliRequest,
  signal: AbortSignal,
  progress: (text: string) => void,
): Promise<CliResponse> {
  const json = req.argv.includes('--json');
  const { name, rest } = splitCommand(req.argv);
  const ok = (text: string, data: unknown): CliResponse => ({
    exitCode: 0,
    stdout: json
      ? `${JSON.stringify({ success: true, data: data ?? null, error: null })}\n`
      : text
        ? `${text}\n`
        : '',
    stderr: '',
  });
  let lastError: string | undefined;
  const fail = (error: string): CliResponse => {
    lastError = error;
    return {
      exitCode: 1,
      stdout: json ? `${JSON.stringify({ success: false, data: null, error })}\n` : '',
      stderr: json ? '' : `✗ ${error}\n`,
    };
  };

  if (name === undefined || name === 'help') {
    const c = rest[0] ? lookup(rest[0]) : undefined;
    return ok(c ? commandHelp(c) : generalHelp(), null);
  }
  const cmd = lookup(name);
  if (!cmd) return fail(`Unknown command: ${name}. Run \`bctl help\`.`);

  let ctx: Ctx | undefined;
  let response: CliResponse;
  try {
    const args = parseArgs(rest, cmd.flags ?? []);
    if (args.has('help')) return ok(commandHelp(cmd), null);
    const session = args.str('session') ?? req.session;
    ctx = new Ctx(req, session, json, args.num('timeout') ?? DEFAULT_TIMEOUT, signal, progress);
    const result = (await raceDialog(ctx, cmd.run(ctx, args))) ?? {};
    response = { ...ok(result.text ?? '✓ Done', result.data), files: ctx.files };
  } catch (e) {
    response = fail(e instanceof UserError ? e.message : errorMessage(e));
  }

  log({
    ts: Date.now(),
    session: ctx?.session ?? req.session,
    command: describe(req.argv),
    tid: ctx?.tabId !== undefined ? meta(ctx.tabId).tid : undefined,
    ok: response.exitCode === 0,
    error: lastError,
  });
  return response;
}
