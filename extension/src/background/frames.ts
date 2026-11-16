// Frames: where an iframe lives (the tab's own session or a child session for an out-of-process
// iframe), the `frame` command's scope, and the offset of an iframe inside its parents.
// See automation.md ("Frames").

import * as cdp from './cdp';
import { type EvalResult } from './dom';
import { UserError } from './errors';
import { save, state } from './state';

/** Where a frame's document can be reached. */
export interface FrameLoc {
  frameId: string;
  /** Session holding the frame; undefined = the tab's own session. */
  sessionId?: string;
  /** True when the frame is the top frame of its session (an out-of-process iframe). */
  top: boolean;
}

interface FrameInfo {
  id: string;
  name: string;
  url: string;
  sessionId?: string;
}

/** Frame id an `<iframe>`/`<frame>` element hosts, or undefined for other nodes. */
export async function hostedFrameId(
  tabId: number,
  sessionId: string | undefined,
  node: { backendNodeId: number } | { objectId: string },
): Promise<string | undefined> {
  try {
    const { node: n } = await cdp.send<{ node: { frameId?: string; nodeName?: string } }>(
      tabId,
      'DOM.describeNode',
      node,
      sessionId,
    );
    return /^i?frame$/i.test(n.nodeName ?? '') ? n.frameId : undefined;
  } catch {
    return undefined;
  }
}

/** Locate a frame by id, waiting briefly for a just-created out-of-process iframe. */
export async function locateFrame(tabId: number, frameId: string): Promise<FrameLoc> {
  const direct = () => cdp.childSessions(tabId).find((c) => c.targetId === frameId);
  const top = (sessionId: string): FrameLoc => ({ frameId, sessionId, top: true });
  const known = direct();
  if (known) return top(known.sessionId);
  const sessions: (string | undefined)[] = [
    undefined,
    ...cdp.childSessions(tabId).map((c) => c.sessionId),
  ];
  for (const sessionId of sessions) {
    try {
      await cdp.send(tabId, 'DOM.getFrameOwner', { frameId }, sessionId);
      return { frameId, ...(sessionId ? { sessionId } : {}), top: false };
    } catch {
      // not in this session
    }
  }
  const late = await cdp.sessionForFrame(tabId, frameId);
  if (late) return top(late.sessionId);
  throw new UserError(
    'Frame not found (it navigated or was removed). Run `bvl frame main`.',
    'not_found',
  );
}

/** The frame the tab is scoped to by `frame`, or undefined for the main frame. */
export async function scopeLoc(tabId: number): Promise<FrameLoc | undefined> {
  const scope = state.frames[tabId];
  return scope ? locateFrame(tabId, scope.frameId) : undefined;
}

// Default (main-world) execution context of each same-process frame, per tab and session. The
// tab's own session is enabled by cdp.attach; child sessions are not, so `evalInFrame` enables
// Runtime there on demand. cdp.onEvent only forwards the tab's own session, hence this module
// listens to chrome.debugger directly.
const contexts = new Map<string, Map<string, number>>();
const key = (tabId: number, sessionId?: string) => `${tabId}/${sessionId ?? ''}`;
const dropTab = (tabId: number) => {
  for (const k of contexts.keys()) if (k.startsWith(`${tabId}/`)) contexts.delete(k);
};

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined) return;
  const k = key(source.tabId, (source as { sessionId?: string }).sessionId);
  const p = (params ?? {}) as {
    context?: { id: number; auxData?: { frameId?: string; isDefault?: boolean } };
    executionContextId?: number;
  };
  if (method === 'Runtime.executionContextCreated') {
    const aux = p.context?.auxData;
    if (p.context && aux?.isDefault && aux.frameId) {
      let m = contexts.get(k);
      if (!m) contexts.set(k, (m = new Map<string, number>()));
      m.set(aux.frameId, p.context.id);
    }
  } else if (method === 'Runtime.executionContextDestroyed') {
    const m = contexts.get(k);
    if (m) for (const [f, id] of m) if (id === p.executionContextId) m.delete(f);
  } else if (method === 'Runtime.executionContextsCleared') {
    contexts.delete(k);
  }
});
cdp.onDetached(dropTab);

async function knownContext(
  tabId: number,
  sessionId: string | undefined,
  frameId: string,
  waitMs: number,
): Promise<number | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const id = contexts.get(key(tabId, sessionId))?.get(frameId);
    if (id !== undefined || Date.now() >= deadline) return id;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Evaluate an expression in a frame. An out-of-process frame has its own session. A frame in the
 * same process is evaluated with `Runtime.evaluate { contextId }` in its default (main-world)
 * context, tracked from `Runtime.executionContext*` events: unlike `contentWindow.eval` this is
 * not subject to the page's CSP, and page globals stay visible.
 *
 * When no context is known (the service worker restarted and missed the events):
 *  1. With `isolatedOk` (DOM queries, which need no page globals), use `Page.createIsolatedWorld`.
 *  2. Otherwise (`eval`), `Runtime.disable` + `enable` makes Chrome re-emit the contexts. It also
 *     replays earlier console messages into the tab's console buffer, so it is the last resort.
 * Cross-origin frames in the same process cannot be scripted and report so.
 */
export async function evalInFrame(
  tabId: number,
  loc: FrameLoc,
  expression: string,
  opts: { byValue: boolean; repl?: boolean; gesture?: boolean; isolatedOk?: boolean },
): Promise<EvalResult> {
  // `repl`: REPL mode (top-level await) without returning by value.
  const repl = opts.repl ?? opts.byValue;
  const run = (contextId: number | undefined, sessionId?: string) =>
    cdp.send<EvalResult>(
      tabId,
      'Runtime.evaluate',
      {
        expression,
        ...(contextId !== undefined ? { contextId } : {}),
        returnByValue: opts.byValue,
        awaitPromise: repl,
        userGesture: opts.gesture ?? true,
        replMode: repl,
      },
      sessionId,
    );
  if (loc.top) return run(undefined, loc.sessionId);

  let contextId = await knownContext(tabId, loc.sessionId, loc.frameId, 200);
  if (contextId === undefined && opts.isolatedOk) {
    try {
      const w = await cdp.send<{ executionContextId: number }>(
        tabId,
        'Page.createIsolatedWorld',
        { frameId: loc.frameId, worldName: 'bvl' },
        loc.sessionId,
      );
      contextId = w.executionContextId;
    } catch {
      // reported below
    }
  }
  if (contextId === undefined) {
    try {
      await cdp.send(tabId, 'Runtime.disable', {}, loc.sessionId);
      await cdp.send(tabId, 'Runtime.enable', {}, loc.sessionId);
    } catch {
      // fall through
    }
    contextId = await knownContext(tabId, loc.sessionId, loc.frameId, 1000);
  }
  if (contextId === undefined) {
    throw new UserError('The frame has no scriptable context. Run `bvl frame main`.', 'not_found');
  }
  try {
    return await run(contextId, loc.sessionId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/context/i.test(msg)) {
      throw new UserError(
        'This frame is on another origin or has navigated and cannot be scripted from here',
        'not_found',
      );
    }
    throw e;
  }
}

/**
 * The content box of the iframe, in the tab's viewport, for a node of the child session
 * `sessionId` (sums the offsets of nested out-of-process iframes). Used to place boxes that were
 * measured inside an iframe on the tab's picture.
 */
export async function frameBox(
  tabId: number,
  sessionId: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  let x = 0;
  let y = 0;
  let own: { width: number; height: number } | undefined;
  let sid: string | undefined = sessionId;
  while (sid) {
    const child = cdp.childSession(tabId, sid);
    if (!child) throw new UserError('The iframe is gone. Run `bvl snapshot` again.', 'stale_ref');
    const { backendNodeId } = await cdp.send<{ backendNodeId: number }>(
      tabId,
      'DOM.getFrameOwner',
      { frameId: child.targetId },
      child.parent,
    );
    const { model } = await cdp.send<{
      model: { content: number[]; width: number; height: number };
    }>(tabId, 'DOM.getBoxModel', { backendNodeId }, child.parent);
    x += model.content[0] ?? 0;
    y += model.content[1] ?? 0;
    own ??= { width: model.width, height: model.height };
    sid = child.parent;
  }
  return { x, y, ...(own ?? { width: 0, height: 0 }) };
}

/** Every frame of the tab (all sessions) for `frame <name|url>`. */
async function allFrames(tabId: number): Promise<FrameInfo[]> {
  interface Tree {
    frame: { id: string; name?: string; url: string };
    childFrames?: Tree[];
  }
  const out: FrameInfo[] = [];
  const sessions: (string | undefined)[] = [
    undefined,
    ...cdp.childSessions(tabId).map((c) => c.sessionId),
  ];
  for (const sessionId of sessions) {
    try {
      const { frameTree } = await cdp.send<{ frameTree: Tree }>(
        tabId,
        'Page.getFrameTree',
        {},
        sessionId,
      );
      const walk = (t: Tree, root: boolean) => {
        // The tab's main frame is not a candidate; a child session's top frame is.
        if (!(root && sessionId === undefined)) {
          out.push({
            id: t.frame.id,
            name: t.frame.name ?? '',
            url: t.frame.url,
            ...(sessionId ? { sessionId } : {}),
          });
        }
        for (const c of t.childFrames ?? []) walk(c, false);
      };
      walk(frameTree, true);
    } catch {
      // session went away
    }
  }
  return out;
}

/** Pick a frame by name (exact) or URL (exact, else substring). */
export async function findFrame(
  tabId: number,
  what: string,
): Promise<{ frameId: string; name: string } | undefined> {
  const frames = await allFrames(tabId);
  const hit =
    frames.find((f) => f.name === what) ??
    frames.find((f) => f.url === what) ??
    frames.find((f) => f.url.includes(what));
  return hit && { frameId: hit.id, name: hit.name || hit.url };
}

export function setScope(
  tabId: number,
  scope: { frameId: string; name: string } | undefined,
): void {
  if (scope) state.frames[tabId] = scope;
  else delete state.frames[tabId];
  save();
}
