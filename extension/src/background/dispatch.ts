// Turns a CLI request (raw argv) into a response: parse, run, format, log.

import type { CliRequest, CliResponse } from '../shared';
import * as cdp from './cdp';
import {
  type Args,
  type Command,
  Ctx,
  GLOBAL_FLAGS,
  logArgs,
  parseArgs,
  type Result,
} from './command';
import { batchCommands, type Outcome, runBatch } from './commands/batch';
import { extraCommands } from './commands/extra';
import { frameCommands } from './commands/frame';
import { emulationCommands } from './commands/emulation';
import { inspectionCommands } from './commands/inspection';
import { interactionCommands } from './commands/interaction';
import { navigationCommands } from './commands/navigation';
import { readCommands } from './commands/read';
import { networkCommands } from './commands/network';
import { type ErrorCode, UserError } from './errors';
import { applyBoundaries, effectiveMaxOutput, limitOutput, parseDomainList } from './guardrails';
import { log, meta } from './state';

const DEFAULT_TIMEOUT = 25_000;

const COMMANDS: Command[] = [
  ...navigationCommands,
  ...interactionCommands,
  ...inspectionCommands,
  ...readCommands,
  ...extraCommands,
  ...frameCommands,
  ...networkCommands,
  ...emulationCommands,
  ...batchCommands,
];
const GROUPS = ['Navigation', 'Tabs', 'Reading', 'Interaction', 'Waiting', 'Debugging'];

function lookup(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

function generalHelp(): string {
  const lines = [
    'bctl — control your real browser from the command line (Browser Bridge)',
    '',
    'Usage: bctl <command> [args] [--json] [--session <name>] [--timeout <ms>] [--max-output <chars>]',
    '',
    'Start here (for AI agents): `bctl skills get core`',
    'It explains the snapshot-and-ref workflow, tab consent and the JSON error codes.',
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
  if (c.details) lines.push('', c.details);
  const flags = [...(c.flags ?? []), ...GLOBAL_FLAGS];
  lines.push('', 'Flags:');
  for (const f of flags) {
    const name = `${f.short ? `-${f.short}, ` : '    '}--${f.name}${f.type === 'string' ? ' <value>' : ''}`;
    lines.push(`  ${name.padEnd(28)} ${f.desc}`);
  }
  if (c.examples?.length) lines.push('', 'Examples:', ...c.examples.map((e) => `  ${e}`));
  return lines.join('\n');
}

/** `⚠ …` lines for stderr (empty when there is nothing to warn about). */
export function formatWarnings(warning: string | string[] | undefined): string {
  return [warning ?? []]
    .flat()
    .map((w) => `⚠ ${w}\n`)
    .join('');
}

/** The `--json` error envelope; `code` is omitted when the failure has no stable code. */
export function formatJsonError(
  error: string,
  code?: ErrorCode,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    success: false,
    data: null,
    error,
    ...(code ? { code } : {}),
    ...extra,
  });
}

/** Argument errors end with the command's usage line, unless the message already carries one. */
export function withUsage(cmd: Command, e: UserError): string {
  if (e.code !== 'bad_args' || /usage:/i.test(e.message)) return e.message;
  return `${e.message}\nUsage: bctl ${cmd.usage}`;
}

/** Split argv into the command name and the rest (global flags may precede the command). */
function splitCommand(argv: string[]): { name: string | undefined; rest: string[] } {
  const withValue = new Set(['--session', '--timeout', '--max-output', '--allowed-domains']);
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

/** The activity-log line: the command name plus its redacted arguments (`logArgs`). */
export function describe(cmd: Command, req: CliRequest, args: Args | undefined): string {
  const tail = args ? logArgs(cmd, args, req) : [];
  const s = [cmd.name, ...tail].join(' ');
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
        text: '✓ Done',
        data: { dialog: { type, message } },
        warning: `A JavaScript ${type} dialog is blocking the page: "${message}" — use \`bctl dialog accept\` or \`bctl dialog dismiss\``,
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
  outcome?: Outcome,
): Promise<CliResponse> {
  const json = req.argv.includes('--json');
  const { name, rest } = splitCommand(req.argv);
  const ok = (
    text: string,
    data: unknown,
    warning?: string | string[],
    envelope: Record<string, unknown> = {},
  ): CliResponse => {
    if (outcome) outcome.data = data ?? null;
    return okResponse(text, data, warning, envelope);
  };
  const okResponse = (
    text: string,
    data: unknown,
    warning?: string | string[],
    envelope: Record<string, unknown> = {},
  ): CliResponse => ({
    exitCode: 0,
    stdout: json
      ? `${JSON.stringify({ success: true, data: data ?? null, error: null, ...envelope })}\n`
      : text
        ? `${text}\n`
        : '',
    stderr: formatWarnings(warning),
  });
  let lastError: string | undefined;
  const fail = (error: string, code?: ErrorCode, extra?: Record<string, unknown>): CliResponse => {
    lastError = error;
    if (outcome) outcome.error = error;
    return {
      exitCode: 1,
      stdout: json ? `${formatJsonError(error, code, extra)}\n` : '',
      stderr: json ? '' : `✗ ${error}\n`,
    };
  };

  if (name === undefined || name === 'help') {
    const c = rest[0] ? lookup(rest[0]) : undefined;
    return ok(c ? commandHelp(c) : generalHelp(), null);
  }
  const cmd = lookup(name);
  if (!cmd) {
    return fail(`Unknown command: ${name}. Run \`bctl help\`.`, 'unknown_command', {
      type: 'unknown_command',
    });
  }

  if (cmd.name === 'batch') {
    try {
      const a = parseArgs(rest, cmd.flags ?? []);
      if (a.has('help')) return ok(commandHelp(cmd), null);
      return await runBatch(a, req, json, signal, progress, execute);
    } catch (e) {
      return e instanceof UserError ? fail(withUsage(cmd, e), e.code) : fail(errorMessage(e));
    }
  }

  let ctx: Ctx | undefined;
  let args: Args | undefined;
  let response: CliResponse;
  try {
    args = parseArgs(rest, cmd.flags ?? []);
    if (args.has('help')) return ok(commandHelp(cmd), null);
    const session = args.str('session') ?? req.session;
    ctx = new Ctx(req, session, json, args.num('timeout') ?? DEFAULT_TIMEOUT, signal, progress);
    const max = effectiveMaxOutput(args);
    ctx.agentAllowedDomains = parseDomainList(args.str('allowed-domains'));
    const limited = limitOutput((await raceDialog(ctx, cmd.run(ctx, args))) ?? {}, max);
    const { result, boundary } = await applyBoundaries(cmd.name, args, limited, json, ctx.tabId);
    response = {
      ...ok(
        result.text ?? '✓ Done',
        result.data,
        result.warning,
        boundary && { _boundary: boundary },
      ),
      files: ctx.files,
    };
  } catch (e) {
    if (e instanceof UserError) response = fail(withUsage(cmd, e), e.code);
    else response = fail(errorMessage(e));
  }

  log({
    ts: Date.now(),
    session: ctx?.session ?? req.session,
    command: describe(cmd, req, args),
    tid: ctx?.tabId !== undefined ? meta(ctx.tabId).tid : undefined,
    ok: response.exitCode === 0,
    error: lastError,
  });
  return response;
}
