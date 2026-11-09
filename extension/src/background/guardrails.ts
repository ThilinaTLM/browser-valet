// Agent guardrails: the user's binding policy (popup) merged with what the agent asks for on the
// command line, and the output shaping that policy drives. See security.md ("Guardrails").
//
// The merge rule everywhere: an agent flag may only *narrow* the user's policy, except
// `--max-output`, which is a context-size default the agent may change.

import type { Guardrails } from '../shared';
import { UserError } from './errors';
import type { Args, Result } from './command';
import { truncate } from './read-format';

export const DEFAULT_GUARDRAILS: Guardrails = { maxOutput: 0, contentBoundaries: false };

/** The current user policy (in memory; mirrored to `chrome.storage.local` key `guardrails`). */
export let guardrails: Guardrails = { ...DEFAULT_GUARDRAILS };

/** Coerce stored or popup-supplied values into a valid policy (unknown or bad values → default). */
export function sanitize(raw: unknown): Guardrails {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const max = Number(r.maxOutput);
  return {
    maxOutput: Number.isInteger(max) && max > 0 ? max : DEFAULT_GUARDRAILS.maxOutput,
    contentBoundaries: r.contentBoundaries === true,
  };
}

export async function loadGuardrails(): Promise<void> {
  const { guardrails: stored } = await chrome.storage.local.get<{ guardrails?: unknown }>(
    'guardrails',
  );
  guardrails = sanitize(stored);
}

export async function updateGuardrails(patch: Partial<Guardrails>): Promise<void> {
  guardrails = sanitize({ ...guardrails, ...patch });
  await chrome.storage.local.set({ guardrails });
}

// ---------------------------------------------------------------------------
// Output limit
// ---------------------------------------------------------------------------

/** The limit in force for a command: `--max-output` if given, else the user's default. 0 = none. */
export function effectiveMaxOutput(a: Args, user: Guardrails = guardrails): number {
  const flag = a.num('max-output');
  if (flag === undefined) return user.maxOutput;
  if (!Number.isInteger(flag) || flag < 1) {
    throw new UserError('--max-output must be a positive integer', 'bad_args');
  }
  return flag;
}

// Strings that identify the page rather than carry its content are never cut.
const KEEP_WHOLE = new Set(['origin', 'url', 'title', 'selector']);

function limitValue(v: unknown, max: number, key: string | undefined, hit: { n: number }): unknown {
  if (typeof v === 'string') {
    if (key && KEEP_WHOLE.has(key) && v.length <= 2048) return v;
    if (v.length <= max) return v;
    hit.n++;
    return truncate(v, max);
  }
  if (Array.isArray(v)) return v.map((x) => limitValue(x, max, undefined, hit));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, limitValue(x, max, k, hit)]));
  }
  return v;
}

/**
 * Cap the result at `max` characters per text: the printed text gets the upstream marker; in
 * `--json` every long string of `data` is cut the same way and `data.truncated` is `true`.
 */
export function limitOutput(result: Result, max: number): Result {
  if (max <= 0) return result;
  const out: Result = { ...result };
  const hit = { n: 0 };
  if (typeof result.text === 'string') {
    out.text = truncate(result.text, max);
    if (result.text.length > max) hit.n++;
  }
  if (result.data !== undefined && result.data !== null) {
    out.data = limitValue(result.data, max, undefined, hit);
    if (hit.n > 0 && typeof out.data === 'object' && !Array.isArray(out.data)) {
      (out.data as Record<string, unknown>).truncated = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Content boundaries
// ---------------------------------------------------------------------------

/** Boundaries are on when the user set "always" or the agent passed `--content-boundaries`. */
export function boundariesOn(a: Args, user: Guardrails = guardrails): boolean {
  return user.contentBoundaries || a.has('content-boundaries');
}

/**
 * Does this command print text that came from the page (as opposed to bctl's own status lines,
 * tab ids, counts or URLs)? Only that output is wrapped. Keep in step with the table in
 * automation.md.
 */
export function isPageContent(command: string, a: Args, result: Result): boolean {
  const sub = a.pos[0];
  switch (command) {
    case 'snapshot':
    case 'read':
    case 'console':
    case 'errors':
    case 'eval':
      return true;
    case 'get':
      return sub === 'text' || sub === 'html' || sub === 'value' || sub === 'attr';
    case 'dialog':
      return (
        sub !== 'accept' &&
        sub !== 'dismiss' &&
        (result.data as { hasDialog?: boolean } | undefined)?.hasDialog === true
      );
    case 'network':
      return sub === 'request';
    default:
      return false;
  }
}

export interface Boundary {
  nonce: string;
  origin: string;
}

export function newNonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Wrap `text` in agent-browser 0.41.2's markers. The nonce is fresh per response, so page text
 * can print the marker but not the nonce.
 */
export function wrapContent(text: string, b: Boundary): string {
  return [
    `--- AGENT_BROWSER_PAGE_CONTENT nonce=${b.nonce} origin=${b.origin} ---`,
    text,
    `--- END_AGENT_BROWSER_PAGE_CONTENT nonce=${b.nonce} ---`,
  ].join('\n');
}

/**
 * Apply boundaries to a finished result. Text mode wraps the printed text; `--json` leaves `data`
 * alone and reports `{nonce, origin}` for the envelope's `_boundary`, as agent-browser does.
 */
export async function applyBoundaries(
  command: string,
  a: Args,
  result: Result,
  json: boolean,
  tabId: number | undefined,
): Promise<{ result: Result; boundary?: Boundary }> {
  if (!boundariesOn(a) || !isPageContent(command, a, result)) return { result };
  if (typeof result.text !== 'string' || result.text === '') return { result };
  let origin = (result.data as { origin?: unknown } | undefined)?.origin;
  if (typeof origin !== 'string' && tabId !== undefined) {
    origin = await chrome.tabs.get(tabId).then(
      (t) => t.url,
      () => undefined,
    );
  }
  const boundary: Boundary = {
    nonce: newNonce(),
    origin: typeof origin === 'string' && origin ? origin : 'unknown',
  };
  return json
    ? { result, boundary }
    : { result: { ...result, text: wrapContent(result.text, boundary) }, boundary };
}
