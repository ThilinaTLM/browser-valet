// Accessibility-tree snapshot in agent-browser's format:
//   - button "Submit" [ref=e3]
//   - textbox "Email" [ref=e4]: me@example.com

import * as cdp from './cdp';
import { type ClickableInfo, clickableScript, clickableSuffix } from './clickable';
import { resolve, UserError } from './dom';
import { hostedFrameId, scopeLoc } from './frames';
import { nodeKey, type NodeKey, RefTable } from './ref-table';
import { syncDocument } from './refs';
import { save, session, state } from './state';

interface AXValue {
  value?: unknown;
}

interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value: AXValue }[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

interface Tree {
  byId: Map<string, AXNode>;
  root: AXNode | undefined;
  /** Child session (out-of-process iframe) and its frame id; absent for the tab's own session. */
  sessionId?: string;
  frameId?: string;
}

export interface SnapshotOptions {
  interactive: boolean;
  compact: boolean;
  depth?: number;
  scope?: string;
  urls: boolean;
  /** Session whose ref counter numbers new refs. */
  session: string;
}

interface Out {
  line: string;
  content: boolean;
  children: Out[];
}

const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'treeitem',
]);
const NAMED_REF_ROLES = new Set([
  'heading',
  'img',
  'image',
  'cell',
  'columnheader',
  'rowheader',
  'dialog',
  'alertdialog',
  'alert',
  'Iframe',
]);
const SKIP = new Set(['InlineTextBox', 'LineBreak']);
const FLATTEN_UNNAMED = new Set([
  'generic',
  'none',
  'presentation',
  'GenericContainer',
  'LayoutTable',
  'LayoutTableRow',
  'LayoutTableCell',
  'LabelText',
  'MenuListPopup',
  'group',
  'Section',
]);
const FIELDS = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const str = (v: AXValue | undefined) =>
  typeof v?.value === 'string' || typeof v?.value === 'number' ? String(v.value) : '';

/** AX property values are strings, numbers or booleans. */
function prop(n: AXNode, name: string): string | number | boolean | undefined {
  const v = n.properties?.find((p) => p.name === name)?.value.value;
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : undefined;
}

async function axTree(
  tabId: number,
  where: { frameId?: string; sessionId?: string; ofFrame?: string } = {},
): Promise<Tree> {
  if (where.sessionId) await cdp.send(tabId, 'Accessibility.enable', {}, where.sessionId);
  const { nodes } = await cdp.send<{ nodes: AXNode[] }>(
    tabId,
    'Accessibility.getFullAXTree',
    where.frameId ? { frameId: where.frameId } : {},
    where.sessionId,
  );
  const tree: Tree = { byId: new Map(nodes.map((n) => [n.nodeId, n])), root: nodes[0] };
  if (where.sessionId) tree.sessionId = where.sessionId;
  if (where.ofFrame) tree.frameId = where.ofFrame;
  return tree;
}

/**
 * The content of an `Iframe` node, so it is inlined under it: a frame in the same process is read
 * from the session of its parent; an out-of-process one from its own child session.
 * `unreadable` collects frames that exist but could not be read.
 */
async function iframeTree(
  tabId: number,
  parent: Tree,
  node: AXNode,
  unreadable: Set<string>,
): Promise<Tree | undefined> {
  if (node.backendDOMNodeId === undefined) return undefined;
  const frameId = await hostedFrameId(tabId, parent.sessionId, {
    backendNodeId: node.backendDOMNodeId,
  });
  if (!frameId) return undefined;
  const inherit = { sessionId: parent.sessionId, ofFrame: parent.frameId };
  let child = cdp.childSessions(tabId).find((c) => c.targetId === frameId);
  if (!child) {
    try {
      return await axTree(tabId, { frameId, ...inherit });
    } catch {
      // not in this process: wait a moment for its session
    }
    child = await cdp.sessionForFrame(tabId, frameId, 800);
  }
  if (!child) {
    unreadable.add(frameId);
    return undefined;
  }
  try {
    return await axTree(tabId, { sessionId: child.sessionId, ofFrame: frameId });
  } catch {
    unreadable.add(frameId);
    return undefined;
  }
}

/**
 * Elements that behave like buttons without an interactive role, by backend node id. Best effort:
 * pages that refuse script (or any CDP failure) just yield none.
 */
async function clickables(tabId: number, withText: boolean): Promise<Map<number, ClickableInfo>> {
  const found = new Map<number, ClickableInfo>();
  const group = 'bvl-clickable';
  try {
    const holder = await cdp.send<{ result: { objectId?: string }; exceptionDetails?: unknown }>(
      tabId,
      'Runtime.evaluate',
      { expression: clickableScript(withText), objectGroup: group },
    );
    const objectId = holder.result.objectId;
    if (!objectId || holder.exceptionDetails) return found;
    const [infoRes, elsRes] = await Promise.all([
      cdp.send<{ result: { value?: [string[], string][] } }>(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function () { return this.info; }',
        returnByValue: true,
      }),
      cdp.send<{ result: { objectId?: string } }>(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function () { return this.els; }',
      }),
    ]);
    const info = infoRes.result.value ?? [];
    const elsId = elsRes.result.objectId;
    if (!elsId || info.length === 0) return found;
    const { result: props } = await cdp.send<{
      result: { name: string; value?: { objectId?: string } }[];
    }>(tabId, 'Runtime.getProperties', { objectId: elsId, ownProperties: true });
    const items = props.filter((p) => /^\d+$/.test(p.name) && p.value?.objectId);
    const nodes = await Promise.all(
      items.map((p) =>
        cdp
          .send<{ node: { backendNodeId: number } }>(tabId, 'DOM.describeNode', {
            objectId: p.value?.objectId,
          })
          .then((r) => r.node.backendNodeId)
          .catch(() => undefined),
      ),
    );
    items.forEach((p, i) => {
      const id = nodes[i];
      const entry = info[Number(p.name)];
      if (id !== undefined && entry) found.set(id, { reasons: entry[0], text: entry[1] });
    });
  } catch {
    // keep what we have
  } finally {
    await cdp
      .send(tabId, 'Runtime.releaseObjectGroup', { objectGroup: group })
      .catch(() => undefined);
  }
  return found;
}

export async function snapshot(
  tabId: number,
  opts: SnapshotOptions,
): Promise<{
  text: string;
  refs: Record<string, { role: string; name: string }>;
  removedRefs: string[];
}> {
  await cdp.send(tabId, 'Accessibility.enable');
  await syncDocument(tabId);
  const sess = session(opts.session);
  // `frame` scoped the tab to an iframe: the snapshot starts at its document.
  const scopedFrame = await scopeLoc(tabId);
  let main: Tree;
  if (scopedFrame) {
    const sid = scopedFrame.sessionId;
    const top = sid ? cdp.childSession(tabId, sid)?.targetId : undefined;
    main = await axTree(
      tabId,
      scopedFrame.top
        ? { sessionId: sid, ofFrame: scopedFrame.frameId }
        : { frameId: scopedFrame.frameId, sessionId: sid, ofFrame: top },
    );
  } else {
    main = await axTree(tabId);
  }
  const unreadable = new Set<string>();
  const table = new RefTable(state.refs[tabId], sess.nextRef ?? 1);
  const present = new Set<NodeKey>();
  const note = (t: Tree) => {
    for (const n of t.byId.values())
      if (n.backendDOMNodeId !== undefined) present.add(nodeKey(n.backendDOMNodeId, t.frameId));
  };
  note(main);
  // Clickable detection runs in the main frame only.
  const clickable = scopedFrame
    ? new Map<number, ClickableInfo>()
    : await clickables(tabId, opts.interactive);

  let start: { node: AXNode; tree: Tree } | undefined = main.root && {
    node: main.root,
    tree: main,
  };
  if (opts.scope) {
    const h = await resolve(tabId, opts.scope);
    const { node } = await cdp.send<{ node: { backendNodeId: number } }>(
      tabId,
      'DOM.describeNode',
      { objectId: h.objectId },
      h.sessionId,
    );
    // A target inside an out-of-process iframe is found in that iframe's tree.
    let tree = main;
    if (h.sessionId !== main.sessionId) {
      const c = h.sessionId ? cdp.childSession(tabId, h.sessionId) : undefined;
      tree = await axTree(tabId, { sessionId: h.sessionId, ofFrame: c?.targetId });
      note(tree);
    }
    const found = [...tree.byId.values()].find((n) => n.backendDOMNodeId === node.backendNodeId);
    if (!found) throw new UserError(`${opts.scope} is not in the accessibility tree`, 'not_found');
    start = { node: found, tree };
  }

  async function walk(
    node: AXNode,
    tree: Tree,
    level: number,
    parentName: string,
    inField: boolean,
  ): Promise<Out[]> {
    const role = str(node.role);
    let name = str(node.name).replace(/\s+/g, ' ').trim();
    const isText = role === 'StaticText';
    const focusable = prop(node, 'focusable') === true;
    // Looks clickable but has no interactive role (natively interactive nodes need no hint).
    const hint =
      node.backendDOMNodeId !== undefined && !tree.frameId && !INTERACTIVE.has(role) && !isText
        ? clickable.get(node.backendDOMNodeId)
        : undefined;
    const interactive =
      INTERACTIVE.has(role) ||
      hint !== undefined ||
      (focusable && !isText && role !== 'RootWebArea');
    if (hint && !name && opts.interactive) name = hint.text;

    let show = !node.ignored && !SKIP.has(role) && role !== 'RootWebArea';
    if (show && FLATTEN_UNNAMED.has(role) && !name && !hint) show = false;
    if (show && isText && (!name || name === parentName || inField)) show = false;
    // Iframes stay in -i: `frame @ref` needs them.
    if (show && opts.interactive && !interactive && role !== 'Iframe') show = false;
    if (opts.depth !== undefined && level > opts.depth) return [];

    let out: Out | undefined;
    if (show) {
      let line = `- ${role}`;
      if (name) line += ` ${JSON.stringify(trunc(name, isText ? 300 : 150))}`;
      const attrs: string[] = [];
      const lvl = prop(node, 'level');
      if (lvl !== undefined) attrs.push(`level=${String(lvl)}`);
      for (const p of ['checked', 'expanded', 'pressed']) {
        const v = prop(node, p);
        if (v !== undefined) attrs.push(`${p}=${String(v)}`);
      }
      for (const p of ['selected', 'disabled', 'required'])
        if (prop(node, p) === true) attrs.push(p);
      if (opts.urls && role === 'link') {
        const url = prop(node, 'url');
        if (typeof url === 'string') attrs.push(`url=${url}`);
      }
      const refable = interactive || (NAMED_REF_ROLES.has(role) && name);
      if (node.backendDOMNodeId !== undefined && refable) {
        const ref = table.assign(
          node.backendDOMNodeId,
          role,
          name,
          tree.sessionId && tree.frameId
            ? { sessionId: tree.sessionId, frameId: tree.frameId }
            : undefined,
        );
        attrs.push(`ref=${ref}`);
      }
      if (attrs.length) line += ` [${attrs.join(', ')}]`;
      if (hint) line += ` ${clickableSuffix(hint.reasons)}`;
      const value = str(node.value);
      if (value && value !== name) line += `: ${trunc(value, 150)}`;
      out = { line, content: Boolean(name || value || refable), children: [] };
    }

    const kids: Out[] = [];
    const childLevel = show ? level + 1 : level;
    const childName = show ? name : parentName;
    const childInField = inField || FIELDS.has(role);
    for (const id of node.childIds ?? []) {
      const child = tree.byId.get(id);
      if (child) kids.push(...(await walk(child, tree, childLevel, childName, childInField)));
    }
    if (role === 'Iframe') {
      const sub = await iframeTree(tabId, tree, node, unreadable);
      if (sub) note(sub);
      if (sub?.root) kids.push(...(await walk(sub.root, sub, childLevel, childName, false)));
    }

    if (!out) return kids;
    out.children = kids;
    return [out];
  }

  const roots = start ? await walk(start.node, start.tree, 0, '', false) : [];

  const prune = (nodes: Out[]): Out[] =>
    nodes.flatMap((n) => {
      n.children = prune(n.children);
      return n.content || n.children.length ? [n] : [];
    });
  const lines: string[] = [];
  const render = (nodes: Out[], indent: string) => {
    for (const n of nodes) {
      lines.push(indent + n.line);
      render(n.children, `${indent}  `);
    }
  };
  render(opts.compact ? prune(roots) : roots, '');

  // A scoped or depth-limited snapshot doesn't see the whole page, so it removes nothing.
  const removedRefs =
    opts.scope || opts.depth !== undefined || scopedFrame ? [] : table.prune(present, unreadable);
  state.refs[tabId] = table.refs;
  sess.nextRef = table.counter;
  save();
  return { text: lines.join('\n') || '(no elements)', refs: table.seen, removedRefs };
}
