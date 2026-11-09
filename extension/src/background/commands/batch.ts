// `batch`: several commands in one call (see automation.md). Each item runs through `execute`.

import type { CliRequest, CliResponse } from '../../shared';
import type { Args, Command } from '../command';
import { UserError } from '../errors';

/** What `execute` reports about one run, besides the response (filled in when passed). */
export interface Outcome {
  data?: unknown;
  boundary?: unknown;
  error?: string;
}

export type Execute = (
  req: CliRequest,
  signal: AbortSignal,
  progress: (text: string) => void,
  outcome?: Outcome,
) => Promise<CliResponse>;

/**
 * Split one batch line into argv: whitespace separates; single quotes are literal; in double
 * quotes `\"` and `\\` are escapes; outside quotes a backslash escapes the next character.
 * No expansion of any kind (`$VAR`, `~`, globs, backticks stay as written).
 */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false; // a token is in progress (so `""` yields an empty argument)
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) cur += line.charAt(++i);
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line.charAt(++i);
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (quote) throw new UserError(`Unterminated ${quote} quote in: ${line}`, 'bad_args');
  if (has || cur) out.push(cur);
  return out;
}

export interface Item {
  command: string[];
  success: boolean;
  result: unknown;
  error: string | null;
  /** `--content-boundaries`: the nonce and origin of this item's markers (JSON mode). */
  _boundary?: unknown;
}

/** Upstream's `--json` shape: a top-level array; `--omit-command` swaps `command` for `index`. */
export function formatBatchJson(items: Item[], omitCommand: boolean): string {
  return JSON.stringify(
    items.map((it, index) => ({
      ...(omitCommand ? { index } : { command: it.command }),
      success: it.success,
      result: it.result,
      error: it.error,
      ...(it._boundary ? { _boundary: it._boundary } : {}),
    })),
  );
}

/** Text output: each item's stdout one after another, separated by a blank line. */
export function formatBatchText(stdouts: string[]): string {
  return stdouts.join('\n');
}

/** Why an item may not run inside a batch, or undefined. */
export function rejectItem(
  argv: string[],
  batchFlags: ReadonlySet<string> = new Set(),
): string | undefined {
  if (argv.length === 0) return 'Empty command';
  // A flag the batch already carries must not be repeated on an item: for the policy flags the
  // last value would win and could widen what the batch allows.
  for (const f of POLICY_FLAGS) {
    if (batchFlags.has(f) && argv.some((t) => t === `--${f}` || t.startsWith(`--${f}=`))) {
      return `--${f} is set on the batch and applies to every item; it cannot be repeated on an item`;
    }
  }
  if (argv.some((t) => t === '--session' || t.startsWith('--session='))) {
    return '--session is not allowed on a batch item; put it on the batch itself';
  }
  if (argv.includes('--stdin'))
    return '--stdin is not allowed inside a batch (stdin holds the batch)';
  const name = argv.find((t) => !t.startsWith('-'));
  if (name === 'batch') return 'batch cannot be nested';
  return undefined;
}

/** Guardrail flags that restrict the agent; a batch's value must not be overridden by an item. */
const POLICY_FLAGS = ['allowed-domains', 'confirm-actions'];
/** Global flags given to `batch` that every item inherits (output shaping and guardrails). */
const INHERITED = ['max-output', 'allowed-domains', 'confirm-actions'];

export const batchCommands: Command[] = [
  {
    name: 'batch',
    group: 'Interaction',
    usage: 'batch [--bail] [--omit-command] ["<cmd>" …] [--stdin]',
    summary: 'Run several commands in one call',
    details:
      'Each quoted argument (or each line of stdin) is one command, split like a shell would (quotes and backslashes, no expansion). Items run in order through the normal path, so consent, dialogs, errors and the activity log work as for single calls. --max-output, --content-boundaries, --allowed-domains and --confirm-actions on the batch apply to every item (output is truncated and wrapped per item; an item cannot repeat --allowed-domains or --confirm-actions). --session, --timeout (per item) and --json apply to every item; --session on an item is rejected. A confirm/prompt dialog ends the batch. Exit code 1 if any item failed. --json prints a top-level array of {command, success, result, error}; --omit-command replaces command with index. Not allowed inside a batch: batch, --stdin (eval -b still works).',
    examples: [
      'bvl batch "fill @e1 user@example.com" "fill @e2 hunter2" "click @e3" "wait --url **/home"',
      'bvl batch --bail "open https://example.com" "snapshot -i"',
      "printf 'open https://example.com\\nsnapshot -i\\n' | bvl batch --stdin",
    ],
    flags: [
      { name: 'bail', type: 'bool', desc: 'Stop at the first failed item' },
      { name: 'stdin', type: 'bool', desc: 'Read one command per line from stdin' },
      {
        name: 'omit-command',
        type: 'bool',
        desc: 'With --json, give each item an index instead of its command',
      },
    ],
    // Handled by `runBatch` before the generic path; never logged as a whole (items log themselves).
    log: () => [],
    run() {
      throw new UserError('batch is handled by the dispatcher', undefined);
    },
  },
];

/** Run the items of a parsed `batch` call; `execute` is the normal single-command path. */
export async function runBatch(
  args: Args,
  req: CliRequest,
  json: boolean,
  signal: AbortSignal,
  progress: (text: string) => void,
  execute: Execute,
): Promise<CliResponse> {
  const lines = [...args.pos];
  if (args.has('stdin')) lines.push(...(req.stdin ?? '').split(/\r?\n/).filter((l) => l.trim()));
  if (lines.length === 0) {
    throw new UserError('Missing commands: pass quoted commands or use --stdin', 'bad_args');
  }
  const bail = args.has('bail');
  const session = args.str('session') ?? req.session;
  const globals = [...(args.has('timeout') ? ['--timeout', args.str('timeout') ?? ''] : [])];
  if (json) globals.push('--json');
  // Guardrail flags given to the batch apply to every item (see security.md, "Guardrails").
  const batchFlags = new Set<string>();
  for (const f of INHERITED) {
    const v = args.str(f);
    if (v !== undefined) {
      globals.push(`--${f}`, v);
      batchFlags.add(f);
    }
  }
  if (args.has('content-boundaries')) globals.push('--content-boundaries');

  const items: Item[] = [];
  const stdouts: string[] = [];
  const stderrs: string[] = [];
  const files: NonNullable<CliResponse['files']> = [];
  let failed = false;

  for (const line of lines) {
    if (signal.aborted) break; // the CLI went away: skip the rest
    let command: string[] = [];
    let res: CliResponse;
    const outcome: Outcome = {};
    try {
      command = tokenize(line);
      const why = rejectItem(command, batchFlags);
      if (why) throw new UserError(why, 'bad_args');
      res = await execute(
        { ...req, argv: [...globals, ...command], session, stdin: undefined },
        signal,
        progress,
        outcome,
      );
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      outcome.error = error;
      res = { exitCode: 1, stdout: '', stderr: `✗ ${error}\n` };
    }
    const success = res.exitCode === 0;
    items.push({
      command,
      success,
      result: success ? (outcome.data ?? null) : null,
      error: success ? null : (outcome.error ?? 'Failed'),
      ...(outcome.boundary ? { _boundary: outcome.boundary } : {}),
    });
    stdouts.push(json ? '' : res.stdout);
    stderrs.push(res.stderr);
    files.push(...(res.files ?? []));
    if (!success) failed = true;
    if (success && isDialog(outcome.data)) break; // a dialog blocks the page: the batch ends
    if (!success && bail) break;
  }

  return {
    exitCode: failed ? 1 : 0,
    stdout: json
      ? `${formatBatchJson(items, args.has('omit-command'))}\n`
      : formatBatchText(stdouts),
    stderr: stderrs.join(''),
    ...(files.length ? { files } : {}),
  };
}

function isDialog(data: unknown): boolean {
  return typeof data === 'object' && data !== null && 'dialog' in data;
}
