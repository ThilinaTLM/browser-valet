// Accessibility-tree snapshot in agent-browser's format:
//   - button "Submit" [ref=e3]
//   - textbox "Email" [ref=e4]: me@example.com

import * as cdp from './cdp';
import { resolve, UserError } from './dom';
import { RefTable } from './ref-table';
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

async function axTree(tabId: number, frameId?: string): Promise<Tree> {
  const { nodes } = await cdp.send<{ nodes: AXNode[] }>(
    tabId,
    'Accessibility.getFullAXTree',
    frameId ? { frameId } : {},
  );
  return { byId: new Map(nodes.map((n) => [n.nodeId, n])), root: nodes[0] };
}

/** Same-process iframes: fetch their AX tree so their content is inlined under the Iframe node. */
async function iframeTree(tabId: number, node: AXNode): Promise<Tree | undefined> {
  if (node.backendDOMNodeId === undefined) return undefined;
  try {
    const { node: dom } = await cdp.send<{ node: { frameId?: string } }>(
      tabId,
      'DOM.describeNode',
      { backendNodeId: node.backendDOMNodeId },
    );
    return dom.frameId ? await axTree(tabId, dom.frameId) : undefined;
  } catch {
    return undefined; // cross-origin (out-of-process) frames are skipped
  }
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
  const main = await axTree(tabId);
  const sess = session(opts.session);
  const table = new RefTable(state.refs[tabId], sess.nextRef ?? 1);
  const present = new Set<number>();
  const note = (t: Tree) => {
    for (const n of t.byId.values())
      if (n.backendDOMNodeId !== undefined) present.add(n.backendDOMNodeId);
  };
  note(main);

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
    );
    const found = [...main.byId.values()].find((n) => n.backendDOMNodeId === node.backendNodeId);
    if (!found) throw new UserError(`${opts.scope} is not in the accessibility tree`);
    start = { node: found, tree: main };
  }

  async function walk(
    node: AXNode,
    tree: Tree,
    level: number,
    parentName: string,
    inField: boolean,
  ): Promise<Out[]> {
    const role = str(node.role);
    const name = str(node.name).replace(/\s+/g, ' ').trim();
    const isText = role === 'StaticText';
    const focusable = prop(node, 'focusable') === true;
    const interactive = INTERACTIVE.has(role) || (focusable && !isText && role !== 'RootWebArea');

    let show = !node.ignored && !SKIP.has(role) && role !== 'RootWebArea';
    if (show && FLATTEN_UNNAMED.has(role) && !name) show = false;
    if (show && isText && (!name || name === parentName || inField)) show = false;
    if (show && opts.interactive && !interactive) show = false;
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
        const ref = table.assign(node.backendDOMNodeId, role, name);
        attrs.push(`ref=${ref}`);
      }
      if (attrs.length) line += ` [${attrs.join(', ')}]`;
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
      const sub = await iframeTree(tabId, node);
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
  const removedRefs = opts.scope || opts.depth !== undefined ? [] : table.prune(present);
  state.refs[tabId] = table.refs;
  sess.nextRef = table.counter;
  save();
  return { text: lines.join('\n') || '(no elements)', refs: table.seen, removedRefs };
}
