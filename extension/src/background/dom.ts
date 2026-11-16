// Resolving targets (@refs, CSS selectors) to remote objects, running functions on them, and
// computing safe click points.

import { UserError } from './errors';
import * as cdp from './cdp';
import { evalInFrame, scopeLoc } from './frames';
import { prime } from './input';
import { refFate, syncDocument } from './refs';
import { state } from './state';

export interface Handle {
  tabId: number;
  objectId: string;
  /** Child session (out-of-process iframe) the object lives in; undefined = the tab's session. */
  sessionId?: string;
  /** How many elements the CSS/XPath target matched (the handle is the first). Absent for refs. */
  matches?: number;
}

interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  className?: string;
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
  // By reference first: REPL mode awaits a top-level `await`, but a promise that is the
  // completion value (`fetch(u).then(r => r.status)`) comes back unresolved, and by value it
  // would print as `{}`. Settle it here, then fetch the value.
  const r = loc
    ? await evalInFrame(tabId, loc, expression, { byValue: false, repl: true })
    : await cdp.send<EvalResult>(tabId, 'Runtime.evaluate', {
        expression,
        awaitPromise: true,
        userGesture: true,
        replMode: true,
      });
  if (r.exceptionDetails) throw new UserError(exceptionText(r.exceptionDetails));
  return byValue(tabId, r.result, loc?.sessionId);
}

/** The value of a by-reference result, awaiting it first when it is a promise. */
async function byValue(
  tabId: number,
  obj: RemoteObject,
  sessionId: string | undefined,
): Promise<RemoteObject> {
  const objectId = obj.objectId;
  if (!objectId) return obj; // primitives, null and undefined already carry their value
  try {
    const r =
      obj.subtype === 'promise'
        ? await cdp.send<EvalResult>(
            tabId,
            'Runtime.awaitPromise',
            { promiseObjectId: objectId, returnByValue: true },
            sessionId,
          )
        : await cdp.send<EvalResult>(
            tabId,
            'Runtime.callFunctionOn',
            { objectId, functionDeclaration: 'function () { return this; }', returnByValue: true },
            sessionId,
          );
    if (r.exceptionDetails) throw new UserError(exceptionText(r.exceptionDetails));
    return r.result;
  } finally {
    void cdp.send(tabId, 'Runtime.releaseObject', { objectId }, sessionId).catch(() => undefined);
  }
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

/** The error for a ref that is not in the tab's table, by why it is missing. */
function missingRef(tabId: number, ref: string): UserError {
  switch (refFate(tabId, ref)) {
    case 'previous_page':
      return new UserError(
        `Ref @${ref} is from a previous page (the tab navigated since that snapshot). Run \`bvl snapshot\` to get fresh refs.`,
        'stale_ref',
      );
    case 'removed':
      return new UserError(
        `@${ref} is no longer on the page (it was removed or replaced). Run \`bvl snapshot\` to get fresh refs.`,
        'stale_ref',
      );
    default:
      return new UserError(
        `Unknown ref: ${ref}. Run \`bvl snapshot\` to get fresh refs.`,
        'unknown_ref',
      );
  }
}

async function resolveRef(tabId: number, target: string): Promise<Handle> {
  const ref = REF.exec(target)?.[1] ?? target;
  await syncDocument(tabId); // refs of an earlier document are gone
  const info = state.refs[tabId]?.[ref];
  if (!info) throw missingRef(tabId, ref);
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

/** Playwright-style locators (`text=…`, `role=…`, `:has-text()`) are not CSS: point to `find`. */
function selectorHint(target: string): string {
  const m = /^(text|role|label|placeholder|alt|title|data-testid)\s*=\s*(.*)$/i.exec(target);
  if (m) {
    const kind =
      (m[1] ?? '').toLowerCase() === 'data-testid' ? 'testid' : (m[1] ?? '').toLowerCase();
    const value = (m[2] ?? '').replace(/^(["'])(.*)\1$/, '$2');
    return `. Playwright-style locators are not supported; use refs from \`bvl snapshot\` or \`bvl find ${kind} ${JSON.stringify(value)} <action>\``;
  }
  if (/:(has-text|text|text-is|visible)\(/.test(target)) {
    return '. Playwright pseudo-classes are not supported; use refs from `bvl snapshot` or `bvl find text "…" <action>`';
  }
  return '';
}

/** Resolve a ref (`@e3`), CSS selector or XPath to an element handle. */
export async function resolve(tabId: number, target: string): Promise<Handle> {
  if (isRef(target)) return resolveRef(tabId, target);
  // CSS and XPath follow the frame the tab is scoped to (`frame`); refs carry their own.
  await syncDocument(tabId);
  const loc = await scopeLoc(tabId);
  const r = loc
    ? await evalInFrame(tabId, loc, queryExpression(target), {
        byValue: false,
        gesture: false,
        isolatedOk: true,
      })
    : await cdp.send<EvalResult>(tabId, 'Runtime.evaluate', {
        expression: queryExpression(target),
      });
  if (r.exceptionDetails) {
    // Only a malformed selector/XPath is the user's mistake; anything else is the real problem.
    const d = r.exceptionDetails;
    const cls = d.exception?.className;
    if (cls === 'SyntaxError' || cls === 'DOMException') {
      throw new UserError(`Invalid selector: ${target}${selectorHint(target)}`, 'bad_args');
    }
    throw new UserError(exceptionText(d));
  }
  if (!r.result.objectId) throw new UserError(`Element not found: ${target}`, 'not_found');
  const handle: Handle = {
    tabId,
    objectId: r.result.objectId,
    ...(loc?.sessionId ? { sessionId: loc.sessionId } : {}),
  };
  // How many elements matched, so actions can warn that they used the first of several.
  try {
    const c = loc
      ? await evalInFrame(tabId, loc, countExpression(target), {
          byValue: true,
          gesture: false,
          isolatedOk: true,
        })
      : await cdp.send<EvalResult>(tabId, 'Runtime.evaluate', {
          expression: countExpression(target),
          returnByValue: true,
        });
    if (typeof c.result.value === 'number') handle.matches = c.result.value;
  } catch {
    // the count is advisory
  }
  return handle;
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
      // Refs are snapshot-bound: no point waiting for them to appear. An invalid selector never
      // becomes valid either.
      const badArgs = e instanceof UserError && e.code === 'bad_args';
      if (isRef(target) || badArgs || Date.now() > deadline || signal.aborted) throw e;
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
 * Points tried by the covered check, as fractions of the element's box: the center first, then
 * points spread over the box, so an element partly covered (a clear button over a cell, a label
 * over part of a row) is clicked where it is visible, as a person would.
 */
const SAMPLES: [number, number][] = [
  [0.5, 0.5],
  [0.25, 0.5],
  [0.75, 0.5],
  [0.5, 0.25],
  [0.5, 0.75],
  [0.1, 0.5],
  [0.9, 0.5],
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
];

interface Check {
  hidden?: true;
  disabled?: true;
  covered?: string;
  self?: string;
  at?: [number, number];
}

const CHECK = `function (samples) {
  ${DESCRIBE}
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el || !el.isConnected) return { hidden: true };
  const r = el.getBoundingClientRect();
  const st = getComputedStyle(el);
  if (r.width === 0 || r.height === 0 || st.visibility === 'hidden') return { hidden: true };
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { disabled: true };
  const doc = el.ownerDocument;
  const ok = (hit) => {
    // The hit is el or inside it in the flat tree: light-DOM content slotted into el's shadow
    // tree (a web-component button's label) and nodes of el's own shadow root count as el.
    for (let n = hit; n; n = n.assignedSlot || n.parentNode || n.host) if (n === el) return true;
    // Shadow DOM retargets hits to the host, which is an ancestor of el.
    for (let n = el; n; n = n.parentNode || n.host) if (n === hit) return true;
    return hit.tagName === 'LABEL' && hit.control === el;
  };
  // A text node is measured by its own quads, which only match the parent's box at the center.
  const pts = this.nodeType === 1 ? samples : samples.slice(0, 1);
  let covered = null;
  for (const [fx, fy] of pts) {
    const hit = doc.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
    // Outside the viewport (e.g. scrolling failed): nothing to compare, keep the old behaviour.
    if (!hit) { if (fx === 0.5 && fy === 0.5) return { at: [fx, fy] }; continue; }
    if (ok(hit)) return { at: [fx, fy] };
    if (!covered) covered = hit;
  }
  return { covered: describe(covered), self: describe(el) };
}`;

/**
 * Scroll the element into view and return the viewport point to click, after checking that it is
 * visible, enabled and not covered by another element. For a node in an out-of-process iframe the
 * point is relative to that iframe and `sessionId` names the session to send the input to: a
 * hidden tab hit-tests nothing inside an iframe, so input addressed to the tab would land on the
 * parent page.
 *
 * A hidden (background) tab renders no frames by itself, so an overlay the page removes on its
 * next animation frame (a loading spinner) still sits there for `elementFromPoint`. When the
 * element looks covered, a frame is forced (`prime`) and the check repeated before failing.
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
  let check = await call<Check>(h, CHECK, [SAMPLES]);
  // Covered: give the page frames (hidden tab) and a moment (transient overlay), then look again.
  for (const pause of [0, 250]) {
    if (!check.covered) break;
    if (pause) await new Promise((r) => setTimeout(r, pause));
    await prime(h.tabId);
    check = await call<Check>(h, CHECK, [SAMPLES]);
  }
  if (check.hidden) throw new UserError('Element is not visible', 'not_visible');
  if (check.disabled && !opts.allowDisabled) throw new UserError('Element is disabled', 'disabled');
  if (check.covered) {
    throw new UserError(
      `Element ${check.self ?? ''} is covered by ${check.covered}. Dismiss it, re-snapshot, retry. If the element only appears on hover, \`hover\` its container first, or \`focus\` it and \`press Enter\`.`,
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
  // Quad corners: top-left, top-right, bottom-right, bottom-left. Interpolate the checked point,
  // so the click lands where the hit test passed (also for transformed elements).
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0, x4 = 0, y4 = 0] = q;
  const [fx, fy] = check.at ?? [0.5, 0.5];
  const w = [(1 - fx) * (1 - fy), fx * (1 - fy), fx * fy, (1 - fx) * fy] as const;
  const x = w[0] * x1 + w[1] * x2 + w[2] * x3 + w[3] * x4;
  const y = w[0] * y1 + w[1] * y2 + w[2] * y3 + w[3] * y4;
  // Quads of a node in an out-of-process iframe are relative to that iframe.
  return h.sessionId ? { x, y, sessionId: h.sessionId } : { x, y };
}
