// Which document a tab's refs belong to. Refs live as long as the main-frame document: a
// cross-document navigation (link, reload, `open`) clears them, but the session's counter keeps
// rising so an old `@e7` can never match a different element ("Unknown ref" instead).

import * as cdp from './cdp';
import { save, state } from './state';

/** The tab's main-frame document: loader id (changes on cross-document navigation) and URL. */
export async function mainFrame(
  tabId: number,
): Promise<{ loaderId?: string; url: string } | undefined> {
  try {
    const { frameTree } = await cdp.send<{
      frameTree: { frame: { loaderId?: string; url?: string; urlFragment?: string } };
    }>(tabId, 'Page.getFrameTree');
    const f = frameTree.frame;
    return {
      ...(f.loaderId !== undefined ? { loaderId: f.loaderId } : {}),
      url: (f.url ?? '') + (f.urlFragment ?? ''),
    };
  } catch {
    return undefined;
  }
}

const loaderId = async (tabId: number) => (await mainFrame(tabId))?.loaderId;

/** Highest ref counter over all sessions: every ref number below it has been issued. */
export function issuedRefs(): number {
  let max = 1;
  for (const s of Object.values(state.sessions)) max = Math.max(max, s.nextRef ?? 1);
  return max;
}

/** Forget the tab's refs (the counter lives in the session and is kept). */
export function clearRefs(tabId: number, docId?: string): void {
  delete state.refs[tabId];
  delete state.frames[tabId]; // a new document leaves the scoped frame behind
  (state.refDocStart ??= {})[tabId] = issuedRefs();
  if (docId === undefined) delete state.refDocs[tabId];
  else state.refDocs[tabId] = docId;
  save();
}

/**
 * Classify a ref that is not in the tab's current table: from an earlier document, removed from
 * this one, or never issued.
 */
export function refFate(tabId: number, ref: string): 'previous_page' | 'removed' | 'unknown' {
  const n = Number(/^e(\d+)$/.exec(ref)?.[1] ?? NaN);
  if (!Number.isFinite(n) || n >= issuedRefs()) return 'unknown';
  return n < (state.refDocStart?.[tabId] ?? 0) ? 'previous_page' : 'removed';
}

/** Drop the tab's refs if its document changed since they were assigned. Returns the doc id. */
export async function syncDocument(tabId: number): Promise<string | undefined> {
  const id = await loaderId(tabId);
  if (id !== undefined && state.refDocs[tabId] !== id) clearRefs(tabId, id);
  return id;
}

// Fast path: the debugger tells us about navigations as they happen. `syncDocument` is the net
// for navigations we missed (detached debugger, service-worker restart).
cdp.onEvent((tabId, method, params) => {
  if (method !== 'Page.frameNavigated') return;
  const frame = (params as { frame?: { parentId?: string; loaderId?: string } } | undefined)?.frame;
  if (frame && frame.parentId === undefined && state.refDocs[tabId] !== frame.loaderId) {
    clearRefs(tabId, frame.loaderId);
  }
});
