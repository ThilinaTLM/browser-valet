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
    'Frame not found (it navigated or was removed). Run `bctl frame main`.',
    'not_found',
  );
}

/** The frame the tab is scoped to by `frame`, or undefined for the main frame. */
export async function scopeLoc(tabId: number): Promise<FrameLoc | undefined> {
  const scope = state.frames[tabId];
  return scope ? locateFrame(tabId, scope.frameId) : undefined;
}

/**
 * Evaluate an expression in a frame. An out-of-process frame has its own session; a frame in the
 * same process is reached through its element's `contentWindow` (same-origin only).
 */
export async function evalInFrame(
  tabId: number,
  loc: FrameLoc,
  expression: string,
  opts: { byValue: boolean; gesture?: boolean },
): Promise<EvalResult> {
  if (loc.top) {
    return cdp.send<EvalResult>(
      tabId,
      'Runtime.evaluate',
      {
        expression,
        returnByValue: opts.byValue,
        awaitPromise: opts.byValue,
        userGesture: opts.gesture ?? true,
        replMode: opts.byValue,
      },
      loc.sessionId,
    );
  }
  const { backendNodeId } = await cdp.send<{ backendNodeId: number }>(
    tabId,
    'DOM.getFrameOwner',
    { frameId: loc.frameId },
    loc.sessionId,
  );
  const { object } = await cdp.send<{ object: { objectId?: string } }>(
    tabId,
    'DOM.resolveNode',
    { backendNodeId },
    loc.sessionId,
  );
  return cdp.send<EvalResult>(
    tabId,
    'Runtime.callFunctionOn',
    {
      objectId: object.objectId,
      functionDeclaration: `function (e) {
        const w = this.contentWindow;
        if (!w) throw new Error('The frame has no window');
        try { w.document; } catch { throw new Error('This frame is on another origin and cannot be scripted from here'); }
        return w.eval(e);
      }`,
      arguments: [{ value: expression }],
      returnByValue: opts.byValue,
      awaitPromise: opts.byValue,
      userGesture: opts.gesture ?? true,
    },
    loc.sessionId,
  );
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
