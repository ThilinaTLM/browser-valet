// Pure helpers for navigation results: error wording, warnings and title lines.

import { UserError } from './errors';

/** `✓ <title>`, or `✓ (no title)` when the page has none. */
export function titleLine(title: string): string {
  return `✓ ${title.trim() ? title : '(no title)'}`;
}

/** What we learned while navigating. */
export interface NavInfo {
  /** The main frame's load event fired before the timeout. */
  loaded: boolean;
  /** HTTP status of the main document, when known. */
  status?: number;
}

/** Warnings for a finished navigation (stderr in text mode). */
export function navWarnings(info: NavInfo, url: string, timeoutMs: number): string[] {
  const out: string[] = [];
  if (!info.loaded)
    out.push(
      `Page still loading after ${timeoutMs} ms; continuing (use wait --load or wait --text)`,
    );
  if (info.status !== undefined && info.status >= 400) out.push(`HTTP ${info.status} from ${url}`);
  return out;
}

/** Extra `--json` fields: `loaded: false` only when the timeout hit; `status` when known. */
export function navData(info: NavInfo): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  if (!info.loaded) d.loaded = false;
  if (info.status !== undefined && info.status > 0) d.status = info.status;
  return d;
}

/** A navigation that never committed within the timeout. */
export function navTimeout(url: string, timeoutMs: number): UserError {
  return new UserError(`Navigation to ${url} timed out after ${timeoutMs} ms`, 'timeout');
}

/** Turn Chrome's `errorText` into a short, coded error. */
export function navFailure(url: string, errorText: string, status?: number): UserError {
  if (errorText === 'net::ERR_NAME_NOT_RESOLVED') {
    let host = url;
    try {
      host = new URL(url).hostname || url;
    } catch {
      // keep the raw text
    }
    return new UserError(`Could not resolve host "${host}"`, 'navigation_failed');
  }
  const http = status && status > 0 ? ` (HTTP ${status})` : '';
  return new UserError(`Navigation to ${url} failed: ${errorText}${http}`, 'navigation_failed');
}
