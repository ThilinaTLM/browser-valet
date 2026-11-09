// Resolving targets (@refs, CSS selectors) to remote objects, running functions on them, and
// computing safe click points.

import { UserError } from './errors';
import * as cdp from './cdp';
import { evalInFrame, scopeLoc } from './frames';
import { syncDocument } from './refs';
import { state } from './state';

export interface Handle {
  tabId: number;
  objectId: string;
  /** Child session (out-of-process iframe) the object lives in; undefined = the tab's session. */
  sessionId?: string;
}

interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
}

export interface EvalResult {
  result: RemoteObject;
  exceptionDetails?: { text?: string; exception?: RemoteObject };
}

export { UserError };

function exceptionText(d: NonNullable<EvalResult['exceptionDetails']>): string {
  return d.exception?.description ?? d.text ?? 'JavaScript exception';
}

/** Convert a by-value RemoteObject into a JS value (undefined/NaN/Infinity/-0/bigint preserved as tokens). */
export function remoteValue(r: RemoteObject): { value: unknown; token?: string } {
  if (r.unserializableValue !== undefined) return { value: null, token: r.unserializableValue };
  if (r.type === 'undefined') return { value: null, token: 'undefined' };
  return { value: r.value ?? null };
}

export async function evaluate(tabId: number, expression: string): Promise<RemoteObject> {
  const r = await cdp.send<EvalResult>(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
    replMode: true,
  });
  if (r.exceptionDetails) throw new UserError(exceptionText(r.exceptionDetails));
  return r.result;
}

/**
 * Like `evaluate`, but in the frame `frame` scoped the tab to (the main frame by default). Used by
 * the commands that follow the scope: `eval`, `get`, `wait --fn`.
 */
export async function evaluateScoped(tabId: number, expression: string): Promise<RemoteObject> {
  const loc = await scopeLoc(tabId);
  if (!loc) return evaluate(tabId, expression);
  const r = await evalInFrame(tabId, loc, expression, { byValue: true });
  if (r.exceptionDetails) throw new UserError(exceptionText(r.exceptionDetails));
  return r.result;
}

/** Run `fn` (a function source string) with `this` bound to the element. Returns by value. */
export async function call<T>(h: Handle, fn: string, args: unknown[] = []): Promise<T> {
  const r = await cdp.send<EvalResult>(
    h.tabId,
    'Runtime.callFunctionOn',
    {
      objectId: h.objectId,
      functionDeclaration: fn,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    },
    h.sessionId,
  );
  if (r.exceptionDetails) {
    // Our own helpers throw short messages; the page-side stack trace is just noise here.
    const msg = exceptionText(r.exceptionDetails).split('\n')[0] ?? '';
    throw new UserError(msg.replace(/^Error: /, ''));
  }
  return r.result.value as T;
}

const REF = /^@?(e\d+)$/;

export function isRef(target: string): boolean {
  return REF.test(target);
}

async function documentBackendId(tabId: number, sessionId?: string): Promise<number> {
  const { root } = await cdp.send<{ root: { backendNodeId: number } }>(
    tabId,
    'DOM.getDocument',
    { depth: 0 },
    sessionId,
  );
  return root.backendNodeId;
}

async function resolveBackend(
  tabId: number,
  backendNodeId: number,
  sessionId?: string,
): Promise<string> {
  const { object } = await cdp.send<{ object: RemoteObject }>(
    tabId,
    'DOM.resolveNode',
    { backendNodeId },
    sessionId,
  );
  if (!object.objectId) throw new Error('unresolvable');
  return object.objectId;
}

export async function fromBackend(
  tabId: number,
  backendNodeId: number,
  sessionId?: string,
): Promise<Handle> {
  return {
    tabId,
    objectId: await resolveBackend(tabId, backendNodeId, sessionId),
    ...(sessionId ? { sessionId } : {}),
  };
}

/** Evaluate an expression that yields an element (or null) and return a handle to it. */
export async function evaluateHandle(tabId: number, expression: string): Promise<Handle | null> {
  const r = await cdp.send<EvalResult>(tabId, 'Runtime.evaluate', { expression });
  if (r.exceptionDetails) throw new UserError(exceptionText(r.exceptionDetails));
  return r.result.objectId ? { tabId, objectId: r.result.objectId } : null;
}

async function resolveRef(tabId: number, target: string): Promise<Handle> {
  const ref = REF.exec(target)?.[1] ?? target;
  await syncDocument(tabId); // refs of an earlier document are gone
  const info = state.refs[tabId]?.[ref];
  if (!info)
    throw new UserError(
      `Unknown ref: ${ref}. Run \`bvl snapshot\` to get fresh refs.`,
      'unknown_ref',
    );
  // A node in an out-of-process iframe is reached through that iframe's session. The session id
  // stored with the ref may be from before a navigation or worker restart: go by the frame.
  let sessionId: string | undefined;
  if (info.frameId !== undefined) {
    sessionId = (await cdp.sessionForFrame(tabId, info.frameId))?.sessionId;
    if (!sessionId) {
      throw new UserError(
        `The iframe of ${ref} is gone (navigated or removed). Run \`bvl snapshot\` again.`,
        'stale_ref',
      );
    }
  }
  try {
    return await fromBackend(tabId, info.backendNodeId, sessionId);
  } catch {
    // The node was replaced: fall back to the single element with the same role and name.
    const { nodes } = await cdp.send<{ nodes: { backendDOMNodeId?: number }[] }>(
      tabId,
      'Accessibility.queryAXTree',
      {
        backendNodeId: await documentBackendId(tabId, sessionId),
        role: info.role,
        accessibleName: info.name,
      },
      sessionId,
    );
    const matches = nodes.filter((n) => n.backendDOMNodeId !== undefined);
    if (matches.length === 1 && matches[0]?.backendDOMNodeId !== undefined) {
      return await fromBackend(tabId, matches[0].backendDOMNodeId, sessionId);
    }
    throw new UserError(
      `Stale ref ${ref} (${info.role} "${info.name}") cannot be recovered. Run \`bvl snapshot\` again.`,
      'stale_ref',
    );
  }
}

/** XPath targets start with `/` or `(` (never valid CSS), e.g. `//button[@type='submit']`. */
export function isXPath(target: string): boolean {
  return target.startsWith('/') || target.startsWith('(');
}

/** Expression yielding the first element matching a CSS or XPath target. */
function queryExpression(target: string): string {
  const t = JSON.stringify(target);
  return isXPath(target)
    ? `document.evaluate(${t}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`
    : `document.querySelector(${t})`;
}

/** Expression yielding how many elements match a CSS or XPath target. */
export function countExpression(target: string): string {
  const t = JSON.stringify(target);
  return isXPath(target)
    ? `document.evaluate(${t}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength`
    : `document.querySelectorAll(${t}).length`;
}

/** Resolve a ref (`@e3`), CSS selector or XPath to an element handle. */
export async function resolve(tabId: number, target: string): Promise<Handle> {
  if (isRef(target)) return resolveRef(tabId, target);
  // CSS and XPath follow the frame the tab is scoped to (`frame`); refs carry their own.
  await syncDocument(tabId);
  const loc = await scopeLoc(tabId);
  const r = loc
    ? await evalInFrame(tabId, loc, queryExpression(target), { byValue: false, gesture: false })
    : await cdp.send<EvalResult>(tabId, 'Runtime.evaluate', {
        expression: queryExpression(target),
      });
  if (r.exceptionDetails) throw new UserError(`Invalid selector: ${target}`, 'bad_args');
  if (!r.result.objectId) throw new UserError(`Element not found: ${target}`, 'not_found');
  return {
    tabId,
    objectId: r.result.objectId,
    ...(loc?.sessionId ? { sessionId: loc.sessionId } : {}),
  };
}

/** Like resolve(), but polls until the element exists (bounded by timeoutMs). */
export async function resolveWait(
  tabId: number,
  target: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Handle> {
  const deadline = Date.now() + Math.min(timeoutMs, 5000);
  for (;;) {
    try {
      return await resolve(tabId, target);
    } catch (e) {
      // Refs are snapshot-bound: no point waiting for them to appear.
      if (isRef(target) || Date.now() > deadline || signal.aborted) throw e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const DESCRIBE = `function describe(el) {
  if (!el || !el.tagName) return 'unknown element';
  let s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
  if (cls.length) s += '.' + cls.join('.');
  return '<' + s + '>';
}`;

/**
 * Scroll the element into view and return the viewport point to click, after checking that it is
 * visible, enabled and not covered by another element. For a node in an out-of-process iframe the
 * point is relative to that iframe and `sessionId` names the session to send the input to: a
 * hidden tab hit-tests nothing inside an iframe, so input addressed to the tab would land on the
 * parent page.
 */
export async function clickPoint(
  h: Handle,
  opts: { allowDisabled?: boolean } = {},
): Promise<{ x: number; y: number; sessionId?: string }> {
  try {
    await cdp.send(h.tabId, 'DOM.scrollIntoViewIfNeeded', { objectId: h.objectId }, h.sessionId);
  } catch {
    // not an element (e.g. text node) or not rendered; checks below report it
  }
  const check = await call<{ hidden?: boolean; disabled?: boolean; covered?: string }>(
    h,
    `function () {
      ${DESCRIBE}
      const el = this.nodeType === 1 ? this : this.parentElement;
      if (!el || !el.isConnected) return { hidden: true };
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || st.visibility === 'hidden') return { hidden: true };
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { disabled: true };
      const hit = el.ownerDocument.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || hit === el || el.contains(hit)) return {};
      // Shadow DOM retargets hits to the host, which is an ancestor of el.
      for (let n = el; n; n = n.parentNode || n.host) if (n === hit) return {};
      if (hit.tagName === 'LABEL' && hit.control === el) return {};
      return { covered: describe(hit) };
    }`,
  );
  if (check.hidden) throw new UserError('Element is not visible', 'not_visible');
  if (check.disabled && !opts.allowDisabled) throw new UserError('Element is disabled', 'disabled');
  if (check.covered) {
    throw new UserError(
      `Element is covered by ${check.covered}. Dismiss it, re-snapshot, retry.`,
      'covered',
    );
  }

  const { quads } = await cdp.send<{ quads: number[][] }>(
    h.tabId,
    'DOM.getContentQuads',
    { objectId: h.objectId },
    h.sessionId,
  );
  const q = quads.find((q) => q.length === 8);
  if (!q) throw new UserError('Element is not visible', 'not_visible');
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0, x4 = 0, y4 = 0] = q;
  const x = (x1 + x2 + x3 + x4) / 4;
  const y = (y1 + y2 + y3 + y4) / 4;
  // Quads of a node in an out-of-process iframe are relative to that iframe.
  return h.sessionId ? { x, y, sessionId: h.sessionId } : { x, y };
}
