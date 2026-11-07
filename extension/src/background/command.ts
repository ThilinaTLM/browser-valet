// Command definitions, argument parsing, and the per-request context.

import type { CliRequest } from '../shared';
import * as cdp from './cdp';
import { UserError } from './dom';
import { meta, session as sessionState } from './state';
import { isControlled } from './tabs';

export interface Flag {
  name: string;
  short?: string;
  /** `bool` flags take no value. */
  type: 'bool' | 'string';
  desc: string;
}

export interface Command {
  name: string;
  aliases?: string[];
  group: string;
  usage: string;
  summary: string;
  flags?: Flag[];
  run(ctx: Ctx, args: Args): Promise<Result | undefined>;
}

/** `text` is the human output (default "✓ Done"); `data` is the --json payload. */
export interface Result {
  text?: string;
  data?: unknown;
}

export const GLOBAL_FLAGS: Flag[] = [
  { name: 'json', type: 'bool', desc: 'Machine-readable output: {success, data, error}' },
  { name: 'session', type: 'string', desc: 'Session name (default: $BCTL_SESSION or "default")' },
  {
    name: 'timeout',
    type: 'string',
    desc: 'Timeout in ms for waits and navigation (default 25000)',
  },
  { name: 'help', short: 'h', type: 'bool', desc: 'Show help' },
];

export class Args {
  constructor(
    readonly pos: string[],
    private readonly flags: Map<string, string | true>,
  ) {}

  has(name: string): boolean {
    return this.flags.has(name);
  }

  str(name: string): string | undefined {
    const v = this.flags.get(name);
    return typeof v === 'string' ? v : undefined;
  }

  num(name: string): number | undefined {
    const v = this.str(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new UserError(`--${name} must be a number`);
    return n;
  }

  /** Positional argument `i`, or a usage error naming it. */
  need(i: number, what: string): string {
    const v = this.pos[i];
    if (v === undefined) throw new UserError(`Missing ${what}`);
    return v;
  }
}

export function parseArgs(argv: string[], flags: Flag[]): Args {
  const all = [...flags, ...GLOBAL_FLAGS];
  const pos: string[] = [];
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? '';
    if (tok === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    // Negative numbers and lone "-" are values, not flags.
    if (!tok.startsWith('-') || tok === '-' || /^-\d/.test(tok)) {
      pos.push(tok);
      continue;
    }
    let name: string;
    let inline: string | undefined;
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
      if (eq !== -1) inline = tok.slice(eq + 1);
    } else {
      const shorts = tok.slice(1);
      // Combined boolean shorts: -ic
      if (
        shorts.length > 1 &&
        [...shorts].every((c) => all.find((f) => f.short === c)?.type === 'bool')
      ) {
        for (const c of shorts) out.set(all.find((f) => f.short === c)?.name ?? c, true);
        continue;
      }
      name = all.find((f) => f.short === shorts)?.name ?? '';
      if (!name) throw new UserError(`Unknown flag: ${tok}`);
    }
    const spec = all.find((f) => f.name === name);
    if (!spec) throw new UserError(`Unknown flag: --${name}`);
    if (spec.type === 'bool') {
      out.set(name, true);
    } else {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new UserError(`--${name} needs a value`);
      out.set(name, value);
    }
  }
  return new Args(pos, out);
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export class Ctx {
  readonly files: { path: string; base64: string }[] = [];
  /** Tab touched by this command, for the activity log. */
  tabId: number | undefined;

  constructor(
    readonly req: CliRequest,
    readonly session: string,
    readonly json: boolean,
    readonly timeout: number,
    readonly signal: AbortSignal,
    readonly progress: (text: string) => void,
  ) {}

  /** The session's current tab. Fails if there is none, it was revoked, or a dialog blocks it. */
  async tab(): Promise<number> {
    const id = sessionState(this.session).tab;
    if (id === undefined) {
      throw new UserError(
        'No tab yet. Run `bctl open <url>` to open one, or `bctl tab` to list tabs.',
      );
    }
    const tid = meta(id).tid;
    const exists = await chrome.tabs.get(id).then(
      () => true,
      () => false,
    );
    if (!exists)
      throw new UserError(`Tab ${tid} was closed. Run \`bctl open <url>\` or \`bctl tab\`.`);
    if (!isControlled(id)) {
      throw new UserError(
        `Tab ${tid} is not shared with the agent (the user revoked control). Run \`bctl tab ${tid}\` to ask again, or \`bctl open <url>\`.`,
      );
    }
    const dialog = cdp.tabEvents(id).dialog;
    if (dialog) {
      throw new UserError(
        `A ${dialog.type} dialog is open: "${dialog.message}". Run \`bctl dialog accept\` or \`bctl dialog dismiss\`.`,
      );
    }
    this.tabId = id;
    return id;
  }

  setTab(tabId: number): void {
    sessionState(this.session).tab = tabId;
    this.tabId = tabId;
  }

  private isAbsolute(p: string): boolean {
    return p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(p);
  }

  /** Resolve a user path against the CLI's working directory. */
  path(p: string): string {
    if (p.startsWith('~')) return p; // left for the shell; we don't know $HOME reliably
    if (this.isAbsolute(p)) return p;
    const { cwd, sep } = this.req;
    return cwd.endsWith(sep) ? cwd + p : cwd + sep + p;
  }

  tmpPath(...parts: string[]): string {
    const { tmp, sep } = this.req;
    return [tmp.endsWith(sep) ? tmp.slice(0, -1) : tmp, ...parts].join(sep);
  }
}
