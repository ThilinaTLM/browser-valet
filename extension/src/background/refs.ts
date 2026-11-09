// Which document a tab's refs belong to. Refs live as long as the main-frame document: a
// cross-document navigation (link, reload, `open`) clears them, but the session's counter keeps
// rising so an old `@e7` can never match a different element ("Unknown ref" instead).

import * as cdp from './cdp';
import { save, state } from './state';

/** Loader id of the tab's main-frame document (changes on every cross-document navigation). */
async function loaderId(tabId: number): Promise<string | undefined> {
  try {
    const { frameTree } = await cdp.send<{ frameTree: { frame: { loaderId?: string } } }>(
      tabId,
      'Page.getFrameTree',
    );
    return frameTree.frame.loaderId;
  } catch {
    return undefined;
  }
}

/** Forget the tab's refs (the counter lives in the session and is kept). */
export function clearRefs(tabId: number, docId?: string): void {
  delete state.refs[tabId];
  delete state.frames[tabId]; // a new document leaves the scoped frame behind
  if (docId === undefined) delete state.refDocs[tabId];
  else state.refDocs[tabId] = docId;
  save();
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
