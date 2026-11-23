import { type Args, type Command, type Ctx, REDACTED, type Result } from '../command';
import * as cdp from '../cdp';
import {
  call,
  clickPoint,
  evaluate,
  evaluateHandle,
  type EvalResult,
  fromBackend,
  type Handle,
  resolveWait,
  UserError,
} from '../dom';
import * as input from '../input';
import { planHuman } from '../pointer';
import { mainFrame } from '../refs';
import { settle } from '../tabs';
import { FILL_FORMATS, fillProblem, SPECIAL_INPUT_TYPES } from './fill-rules';
import { openInNewTab } from './navigation';

const pt = ({ x, y }: { x: number; y: number }) => ({ x, y });

/** How long `upload` waits for the file chooser a click should open (capped by --timeout). */
const CHOOSER_TIMEOUT_MS = 5000;

const DONE: Result = { text: '✓ Done' };

/** `✓ Done` with the upstream-style JSON payload (`{ clicked: '@e3' }`, …). */
const done = (data: unknown): Result => ({ text: '✓ Done', data });

async function element(ctx: Ctx, target: string): Promise<Handle> {
  return resolveWait(await ctx.tab(), target, ctx.timeout, ctx.signal);
}

/** Add a warning to a result (kept alongside any it already has). */
function warn(r: Result, ...w: (string | undefined)[]): Result {
  const all = [...(r.warning === undefined ? [] : [r.warning].flat()), ...w].filter(
    (x): x is string => x !== undefined,
  );
  return all.length ? { ...r, warning: all } : r;
}

/** Merge extra fields into a result's `--json` data. */
const withData = (r: Result, data: Record<string, unknown>): Result => ({
  ...r,
  data: { ...(typeof r.data === 'object' && r.data !== null ? r.data : {}), ...data },
});

/** Warning for a CSS/XPath target that matched several elements (the first was used). */
function multi(h: Handle, target: string): string | undefined {
  return h.matches !== undefined && h.matches > 1
    ? `${String(h.matches)} elements match "${target}"; used the first. Use a @ref or a more specific selector.`
    : undefined;
}

/** Run `act` on a tab and report a navigation it caused (`✓ Done → url "title"`, `navigated`). */
async function observeNav(tabId: number, act: () => Promise<Result | undefined>): Promise<Result> {
  const before = await mainFrame(tabId);
  const r = (await act()) ?? DONE;
  await settle(tabId);
  const after = await mainFrame(tabId);
  if (!before || !after || (before.loaderId === after.loaderId && before.url === after.url)) {
    return r;
  }
  let title = '';
  try {
    title = (await chrome.tabs.get(tabId)).title ?? '';
  } catch {
    // tab closed
  }
  title = title.trim();
  const newDoc = before.loaderId !== after.loaderId;
  const text =
    `${r.text ?? '✓ Done'} → ${after.url}${title ? ` "${title}"` : ' (no title)'}` +
    (newDoc ? ' (refs reset: snapshot again)' : '');
  return withData({ ...r, text }, { navigated: { url: after.url, title } });
}

// ---------------------------------------------------------------------------
// Actions on a resolved element (shared by direct commands and `find`)
// ---------------------------------------------------------------------------

interface Pt {
  x: number;
  y: number;
  sessionId?: string;
}

/**
 * Move along a human path to `pt`. When the path took over 200 ms the page may have changed under
 * it, so actionability is checked again; a changed point is then moved to directly.
 */
async function approach(
  h: Handle,
  pt: Pt,
  opts: { allowDisabled?: boolean },
): Promise<{ pt: Pt; hidden: boolean }> {
  const plan = planHuman(h.tabId, pt);
  const { hidden, elapsedMs } = await input.move(h.tabId, pt.x, pt.y, pt.sessionId, plan);
  if (elapsedMs <= 200) return { pt, hidden };
  const again = await clickPoint(h, opts);
  if (Math.hypot(again.x - pt.x, again.y - pt.y) >= 0.5) {
    await input.move(h.tabId, again.x, again.y, again.sessionId);
  }
  return { pt: again, hidden };
}

async function clickEl(
  h: Handle,
  count = 1,
  button: input.Button = 'left',
  human = false,
): Promise<Result> {
  let pt = await clickPoint(h);
  let hidden: boolean | undefined;
  if (human) ({ pt, hidden } = await approach(h, pt, {}));
  const { x, y, sessionId } = pt;
  return observeNav(h.tabId, async () => {
    await input.click(h.tabId, x, y, {
      count,
      button,
      ...(sessionId ? { sessionId } : {}),
      ...(hidden !== undefined ? { hidden, hover: false } : {}),
    });
    return DONE;
  });
}

/**
 * Fail before touching the page when a file does not exist. Chrome accepts any path in
 * `DOM.setFileInputFiles` and gives the page an empty file, so the site fails later with its own
 * vague error. The files are set on a detached scratch `<input type=file>` (no page listener sees
 * it), and every 0-byte file is read: an empty file reads fine, a missing one throws.
 */
async function checkFiles(h: Handle, files: string[]): Promise<void> {
  const made = await cdp.send<EvalResult>(
    h.tabId,
    'Runtime.callFunctionOn',
    {
      objectId: h.objectId,
      functionDeclaration: `function () {
        const doc = this.ownerDocument || document;
        const i = doc.createElement('input');
        i.type = 'file';
        i.multiple = true;
        return i;
      }`,
    },
    h.sessionId,
  );
  const objectId = made.result.objectId;
  if (!objectId) return; // could not make a scratch input; skip the check
  const scratch: Handle = {
    tabId: h.tabId,
    objectId,
    ...(h.sessionId ? { sessionId: h.sessionId } : {}),
  };
  await cdp.send(h.tabId, 'DOM.setFileInputFiles', { objectId, files }, h.sessionId);
  const missing = await call<number[]>(
    scratch,
    `async function () {
      const bad = [];
      const list = [...this.files];
      for (let i = 0; i < list.length; i++) {
        if (list[i].size > 0) continue;
        try { await list[i].arrayBuffer(); } catch { bad.push(i); }
      }
      return bad;
    }`,
  );
  if (missing.length) {
    const names = missing.map((i) => files[i] ?? '').join(', ');
    throw new UserError(
      `File not found or not readable: ${names}. Relative paths are resolved against the directory bvl runs in.`,
      'bad_args',
    );
  }
}

/** Click a non-input target while intercepting the file chooser, then fulfil it with `files`. */
async function uploadViaChooser(ctx: Ctx, h: Handle, files: string[]): Promise<void> {
  if (h.sessionId) {
    throw new UserError(
      'upload through a file chooser does not work inside a cross-origin iframe; target the <input type=file> itself',
      'bad_args',
    );
  }
  const wait = Math.min(ctx.timeout, CHOOSER_TIMEOUT_MS);
  let opened!: (p: { backendNodeId?: number; mode?: string }) => void;
  const chooser = new Promise<{ backendNodeId?: number; mode?: string }>((r) => (opened = r));
  const off = cdp.onEvent((tabId, method, params) => {
    if (tabId === h.tabId && method === 'Page.fileChooserOpened') {
      opened(params ?? {});
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await cdp.send(h.tabId, 'Page.setInterceptFileChooserDialog', { enabled: true }, h.sessionId);
    await clickEl(h);
    const timedOut = new Promise<undefined>((r) => {
      timer = setTimeout(() => {
        r(undefined);
      }, wait);
    });
    const aborted = new Promise<undefined>((_, rej) => {
      ctx.signal.addEventListener(
        'abort',
        () => {
          rej(new UserError('Cancelled'));
        },
        { once: true },
      );
    });
    const ev = await Promise.race([chooser, timedOut, aborted]);
    if (!ev) {
      throw new UserError(
        `No file chooser opened within ${String(wait)} ms after clicking the target. Check that it is the upload button (re-snapshot). Sites that use window.showOpenFilePicker cannot be fulfilled through CDP.`,
        'timeout',
      );
    }
    if (ev.mode === 'selectSingle' && files.length > 1) {
      throw new UserError(
        `The file chooser accepts a single file but ${String(files.length)} were given`,
        'bad_args',
      );
    }
    if (ev.backendNodeId === undefined) {
      throw new UserError('The file chooser did not report its input element');
    }
    await cdp.send(
      h.tabId,
      'DOM.setFileInputFiles',
      { backendNodeId: ev.backendNodeId, files },
      h.sessionId,
    );
  } finally {
    clearTimeout(timer);
    off();
    await cdp
      .send(h.tabId, 'Page.setInterceptFileChooserDialog', { enabled: false }, h.sessionId)
      .catch(() => 0);
  }
}

async function focusEl(h: Handle): Promise<void> {
  await cdp
    .send(h.tabId, 'DOM.scrollIntoViewIfNeeded', { objectId: h.objectId }, h.sessionId)
    .catch(() => 0);
  await call(
    h,
    `function () {
      this.focus();
      if (typeof this.setSelectionRange === 'function' && typeof this.value === 'string') {
        try { this.setSelectionRange(this.value.length, this.value.length); } catch {}
      }
    }`,
  );
}

async function fillEl(h: Handle, text: string): Promise<Result> {
  await cdp
    .send(h.tabId, 'DOM.scrollIntoViewIfNeeded', { objectId: h.objectId }, h.sessionId)
    .catch(() => 0);
  // Date/time-like inputs ignore inserted text: their value is set through the native setter.
  const prep = await call<{ field: boolean; type: string; special: boolean; combo?: boolean }>(
    h,
    `function (text, special, formats) {
      const types = new Set(special);
      const inner = (this.getAttribute && this.getAttribute('pseudo')) || '';
      const host = this.getRootNode && this.getRootNode().host;
      const outer = host && host.tagName === 'INPUT' ? host : null;
      if (outer || inner.startsWith('-webkit-datetime-edit')) {
        const t = outer ? outer.type : 'date';
        const hint = formats[t];
        throw new Error('Element is a part of an <input type=' + t + '>; fill the <input type=' + t + '> itself' + (hint ? ' ("' + hint + '")' : ''));
      }
      if (this.disabled || this.readOnly) throw new Error('Element is not editable');
      const field = this.tagName === 'INPUT' || this.tagName === 'TEXTAREA';
      const type = this.tagName === 'INPUT' ? this.type : this.tagName === 'TEXTAREA' ? 'textarea' : '';
      this.focus();
      if (field && types.has(type)) {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(this, text);
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return { field, type, special: true };
      }
      const combo = this.getAttribute('role') === 'combobox';
      if (typeof this.select === 'function') this.select();
      else if (this.isContentEditable) {
        const r = document.createRange();
        r.selectNodeContents(this);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
      } else throw new Error('Element is not an input, textarea or contenteditable');
      return { field, type, special: false, combo };
    }`,
    [text, [...SPECIAL_INPUT_TYPES], FILL_FORMATS],
  );
  if (!prep.special) {
    if (text) await input.insertText(h.tabId, text);
    else await input.press(h.tabId, 'Delete');
  }
  // Many comboboxes only commit a choice made from their popup and revert typed text on blur.
  const comboHint =
    prep.combo && text
      ? 'combobox: the text was typed, but many comboboxes revert it on blur unless an option is chosen. Open its list (click it or its open button, or `press ArrowDown` while it has focus), snapshot, then click the option.'
      : undefined;
  if (!prep.field) return warn(DONE, comboHint);
  const value = await call<string>(h, 'function () { return this.value; }');
  const problem = fillProblem(prep.type, text, value);
  if (problem?.fail) throw new UserError(problem.message);
  return warn(DONE, problem?.message, comboHint);
}

async function typeEl(h: Handle, text: string): Promise<Result> {
  await focusEl(h);
  await input.type(h.tabId, text);
  return DONE;
}

async function hoverEl(h: Handle, human = false): Promise<Result> {
  const pt = await clickPoint(h, { allowDisabled: true });
  if (human) {
    await approach(h, pt, { allowDisabled: true });
    return DONE;
  }
  const { x, y, sessionId } = pt;
  await input.move(h.tabId, x, y, sessionId);
  return DONE;
}

async function setChecked(h: Handle, want: boolean): Promise<Result> {
  const isChecked = () =>
    call<boolean>(
      h,
      `function () { return this.checked ?? this.getAttribute('aria-checked') === 'true'; }`,
    );
  if ((await isChecked()) !== want) {
    try {
      await clickEl(h);
    } catch (e) {
      if (e instanceof UserError && e.code === 'not_visible') {
        throw new UserError(
          `${e.message}. Custom checkbox: try \`click\` on its label or wrapper`,
          'not_visible',
        );
      }
      throw e;
    }
  }
  if ((await isChecked()) !== want) throw new UserError(`Could not ${want ? 'check' : 'uncheck'}`);
  return DONE;
}

async function selectEl(h: Handle, values: string[]): Promise<Result> {
  return observeNav(h.tabId, () => selectNow(h, values));
}

async function selectNow(h: Handle, values: string[]): Promise<Result> {
  const picked = await call<string[]>(
    h,
    `function (values) {
      if (this.tagName !== 'SELECT') throw new Error('Element is not a <select>');
      const norm = (s) => s.replace(/\\s+/g, ' ').trim();
      const opts = [...this.options];
      const chosen = values.map((v) => {
        const o = opts.find((o) => o.value === v) || opts.find((o) => norm(o.label) === norm(v));
        if (!o) throw new Error('No option ' + JSON.stringify(v));
        return o;
      });
      for (const o of opts) o.selected = chosen.includes(o);
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return chosen.map((o) => o.value);
    }`,
    [values],
  );
  return { text: '✓ Done', data: { selected: picked } };
}

async function textOf(h: Handle): Promise<Result> {
  const text = await call<string>(h, 'function () { return this.innerText ?? this.textContent; }');
  return { text, data: { text } };
}

// ---------------------------------------------------------------------------
// Semantic locators for `find`
// ---------------------------------------------------------------------------

interface AXNode {
  ignored: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  backendDOMNodeId?: number;
}

const FORM_ROLES = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'listbox',
]);

function matcher(value: string, exact: boolean): (s: string) => boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return exact
    ? (s) => norm(s) === norm(value)
    : (s) => norm(s).toLowerCase().includes(norm(value).toLowerCase());
}

const asString = (v: unknown) => (typeof v === 'string' ? v : '');

async function byAx(tabId: number, pred: (role: string, name: string) => boolean): Promise<Found> {
  await cdp.send(tabId, 'Accessibility.enable');
  const { nodes } = await cdp.send<{ nodes: AXNode[] }>(tabId, 'Accessibility.getFullAXTree');
  const hits = nodes.filter(
    (n) =>
      !n.ignored &&
      n.backendDOMNodeId !== undefined &&
      pred(asString(n.role?.value), asString(n.name?.value)),
  );
  const first = hits[0]?.backendDOMNodeId;
  return {
    h: first !== undefined ? await fromBackend(tabId, first) : null,
    matches: hits.length,
  };
}

/** A located element (or none) and how many elements the locator matched. */
interface Found {
  h: Handle | null;
  matches: number;
}

/** Evaluate `expr` (an element) and `count` (a number) and return both. */
async function found(tabId: number, expr: string, count: string): Promise<Found> {
  const h = await evaluateHandle(tabId, expr);
  if (!h) return { h, matches: 0 };
  const n = await evaluate(tabId, count).then(
    (r) => (typeof r.value === 'number' ? r.value : 1),
    () => 1,
  );
  return { h, matches: n };
}

async function byAttr(tabId: number, attr: string, value: string, exact: boolean) {
  const all = `(() => {
      const norm = (s) => s.replace(/\\s+/g, ' ').trim();
      const want = norm(${JSON.stringify(value)});
      const exact = ${String(exact)};
      return [...document.querySelectorAll('[${attr}]')].filter((el) => {
        const v = norm(el.getAttribute('${attr}'));
        return exact ? v === want : v.toLowerCase().includes(want.toLowerCase());
      });
    })()`;
  return found(tabId, `${all}[0] ?? null`, `${all}.length`);
}

async function byText(tabId: number, value: string, exact: boolean) {
  // The deepest visible element whose text matches; elements that only contain a match count once.
  const all = `(() => {
      const norm = (s) => s.replace(/\\s+/g, ' ').trim();
      const want = norm(${JSON.stringify(value)});
      const exact = ${String(exact)};
      const match = (el) => {
        const t = norm(el.innerText ?? '');
        return exact ? t === want : t.toLowerCase().includes(want.toLowerCase());
      };
      const hits = [...document.body.querySelectorAll('*')].filter(
        (el) => el.checkVisibility?.() && match(el),
      );
      const leaves = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
      return { hits, leaves };
    })()`;
  const best = `(() => {
      const { hits } = ${all};
      let best = null;
      for (const el of hits) if (!best || best.contains(el)) best = el;
      return best;
    })()`;
  return found(tabId, best, `${all}.leaves.length`);
}

const FIND_HELP =
  'find <role|text|label|placeholder|alt|title|testid> <value> <action> [value]\n' +
  '     find <first|last> <selector> <action> [value] | find nth <n> <selector> <action> [value]\n' +
  '     actions: click dblclick hover focus fill type check uncheck select text';

async function locate(ctx: Ctx, a: Args): Promise<{ h: Handle; rest: string[]; warning?: string }> {
  const tabId = await ctx.tab();
  const [kind, value, ...rest] = a.pos;
  if (!kind || value === undefined) throw new UserError(`Usage: ${FIND_HELP}`, 'bad_args');
  const exact = a.has('exact');
  const name = a.str('name');
  let f: Found;
  let rest2 = rest;
  let chosen = false; // first/last/nth: the agent picked among several on purpose
  switch (kind) {
    case 'role': {
      const nameOk = name === undefined ? () => true : matcher(name, exact);
      f = await byAx(tabId, (role, n) => role === value && nameOk(n));
      break;
    }
    case 'label': {
      const ok = matcher(value, exact);
      f = await byAx(tabId, (role, n) => FORM_ROLES.has(role) && ok(n));
      break;
    }
    case 'text':
      f = await byText(tabId, value, exact);
      break;
    case 'placeholder':
    case 'alt':
    case 'title':
      f = await byAttr(tabId, kind, value, exact);
      break;
    case 'testid':
      f = await byAttr(tabId, 'data-testid', value, true);
      break;
    case 'first':
    case 'last': {
      const all = `document.querySelectorAll(${JSON.stringify(value)})`;
      f = {
        h: await evaluateHandle(
          tabId,
          kind === 'first' ? `${all}[0] ?? null` : `[...${all}].at(-1) ?? null`,
        ),
        matches: 1,
      };
      chosen = true;
      break;
    }
    case 'nth': {
      const selector = rest[0];
      if (!selector) throw new UserError(`Usage: ${FIND_HELP}`, 'bad_args');
      rest2 = rest.slice(1);
      f = {
        h: await evaluateHandle(
          tabId,
          `document.querySelectorAll(${JSON.stringify(selector)})[${Number(value)}] ?? null`,
        ),
        matches: 1,
      };
      chosen = true;
      break;
    }
    default:
      throw new UserError(`Unknown locator "${kind}". Usage: ${FIND_HELP}`, 'bad_args');
  }
  const h = f.h;
  if (!h) {
    const desc = kind === 'role' && name ? `role ${value} named "${name}"` : `${kind} "${value}"`;
    throw new UserError(`No element found by ${desc}`, 'not_found');
  }
  ctx.tabId = tabId;
  const many = !chosen && f.matches > 1;
  return {
    h,
    rest: rest2,
    ...(many
      ? {
          warning: `${String(f.matches)} elements match ${kind} "${value}"; used the first. Use \`find nth <n> <selector>\`, --exact${kind === 'role' ? ' or --name' : ''}, or a @ref.`,
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const target = (a: Args) => a.need(0, 'target (@ref or CSS selector)');

export const interactionCommands: Command[] = [
  {
    name: 'click',
    details:
      "Clicks the element's center with trusted mouse input. Fails, instead of reporting success, when the element is hidden, disabled, covered by another element or outside the viewport. If the click opens a confirm or prompt dialog, a warning is printed on stderr; answer it with `dialog accept` or `dialog dismiss`.",
    examples: [
      'bvl click @e3',
      'bvl click "button[type=submit]"',
      'bvl click "//button[@type=\'submit\']"',
    ],
    show: Infinity,
    group: 'Interaction',
    usage: 'click <target> [--new-tab] [--right] [--human]',
    summary: 'Click an element (@ref or CSS selector)',
    flags: [
      { name: 'new-tab', type: 'bool', desc: "Open the link's URL in a new agent tab" },
      { name: 'right', type: 'bool', desc: 'Right-click' },
      {
        name: 'human',
        type: 'bool',
        desc: 'Approach along a reproducible eased curve from the last pointer position',
      },
    ],
    async run(ctx, a) {
      const h = await element(ctx, target(a));
      if (a.has('new-tab')) {
        const href = await call<string | null>(
          h,
          'function () { const a = this.closest("a[href]"); return a ? a.href : null; }',
        );
        if (!href) throw new UserError('Element is not a link');
        return openInNewTab(ctx, href);
      }
      const r = await clickEl(h, 1, a.has('right') ? 'right' : 'left', a.has('human'));
      return warn(withData(r, { clicked: target(a) }), multi(h, target(a)));
    },
  },
  {
    name: 'dblclick',
    show: Infinity,
    group: 'Interaction',
    usage: 'dblclick <target> [--human]',
    summary: 'Double-click an element',
    flags: [
      {
        name: 'human',
        type: 'bool',
        desc: 'Approach along a reproducible eased curve from the last pointer position',
      },
    ],
    async run(ctx, a) {
      const h = await element(ctx, target(a));
      const r = await clickEl(h, 2, 'left', a.has('human'));
      return warn(withData(r, { clicked: target(a) }), multi(h, target(a)));
    },
  },
  {
    name: 'focus',
    group: 'Interaction',
    usage: 'focus <target>',
    summary: 'Focus an element',
    async run(ctx, a) {
      const h = await element(ctx, target(a));
      await focusEl(h);
      return warn(done({ focused: target(a) }), multi(h, target(a)));
    },
  },
  {
    name: 'hover',
    group: 'Interaction',
    usage: 'hover <target> [--human]',
    summary: 'Move the mouse over an element',
    flags: [
      {
        name: 'human',
        type: 'bool',
        desc: 'Approach along a reproducible eased curve from the last pointer position',
      },
    ],
    async run(ctx, a) {
      const h = await element(ctx, target(a));
      await hoverEl(h, a.has('human'));
      return warn(done({ hovered: target(a) }), multi(h, target(a)));
    },
  },
  {
    name: 'fill',
    details:
      'Clears the field and types the text. Use `type` to append without clearing. Fails if the element is not editable.',
    examples: ['bvl fill @e5 "user@example.com"', 'bvl fill "#search" "bridge"'],
    group: 'Interaction',
    usage: 'fill <target> <text>',
    summary: 'Clear an input and fill it with text',
    async run(ctx, a) {
      const text = a.need(1, 'text');
      const h = await element(ctx, target(a));
      const r = await fillEl(h, text);
      return warn(withData(r, { filled: target(a) }), multi(h, target(a)));
    },
  },
  {
    name: 'type',
    group: 'Interaction',
    usage: 'type <target> <text>',
    summary: 'Type text into an element without clearing it (real key events)',
    async run(ctx, a) {
      const text = a.need(1, 'text');
      const h = await element(ctx, target(a));
      await typeEl(h, text);
      return warn(done({ typed: text }), multi(h, target(a)));
    },
  },
  {
    name: 'press',
    details: 'Presses a key at the current focus; combine modifiers with +.',
    examples: ['bvl press Enter', 'bvl press Control+a', 'bvl press ControlOrMeta+c'],
    show: Infinity,
    aliases: ['key'],
    group: 'Interaction',
    usage: 'press <key>',
    summary: 'Press a key at the current focus: Enter, Tab, Control+a, ControlOrMeta+c, …',
    async run(ctx, a) {
      const id = await ctx.tab();
      const key = a.need(0, 'key');
      const r = await observeNav(id, async () => {
        await input.press(id, key);
        return DONE;
      });
      return withData(r, { pressed: key });
    },
  },
  {
    name: 'keydown',
    show: Infinity,
    group: 'Interaction',
    usage: 'keydown <key>',
    summary: 'Hold a key down (e.g. Shift)',
    async run(ctx, a) {
      const key = a.need(0, 'key');
      await input.keyDown(await ctx.tab(), key);
      return done({ keydown: key });
    },
  },
  {
    name: 'keyup',
    show: Infinity,
    group: 'Interaction',
    usage: 'keyup <key>',
    summary: 'Release a held key',
    async run(ctx, a) {
      const key = a.need(0, 'key');
      await input.keyUp(await ctx.tab(), key);
      return done({ keyup: key });
    },
  },
  {
    name: 'keyboard',
    group: 'Interaction',
    usage: 'keyboard <type|inserttext> <text>',
    summary: 'Type keystrokes, or insert text, at the current focus',
    async run(ctx, a) {
      const id = await ctx.tab();
      const mode = a.need(0, 'type|inserttext');
      const text = a.need(1, 'text');
      if (mode === 'type') {
        await input.type(id, text);
        return done({ typed: text });
      }
      if (mode === 'inserttext') {
        await input.insertText(id, text);
        return done({ inserted: true });
      }
      throw new UserError('Usage: keyboard <type|inserttext> <text>', 'bad_args');
    },
  },
  {
    name: 'check',
    show: Infinity,
    group: 'Interaction',
    usage: 'check <target>',
    summary: 'Check a checkbox / radio / switch',
    async run(ctx, a) {
      const h = await element(ctx, target(a));
      await setChecked(h, true);
      return warn(done({ checked: target(a) }), multi(h, target(a)));
    },
  },
  {
    name: 'uncheck',
    show: Infinity,
    group: 'Interaction',
    usage: 'uncheck <target>',
    summary: 'Uncheck a checkbox / switch',
    async run(ctx, a) {
      const h = await element(ctx, target(a));
      await setChecked(h, false);
      return warn(done({ unchecked: target(a) }), multi(h, target(a)));
    },
  },
  {
    name: 'select',
    group: 'Interaction',
    usage: 'select <target> <value|label> [more…]',
    summary: 'Choose <select> option(s) by value or visible label',
    async run(ctx, a) {
      a.need(1, 'value');
      const h = await element(ctx, target(a));
      return warn(await selectEl(h, a.pos.slice(1)), multi(h, target(a)));
    },
  },
  {
    name: 'scroll',
    show: Infinity,
    showFlags: ['selector'],
    group: 'Interaction',
    usage: 'scroll [up|down|left|right] [px] [--selector <target>]',
    summary: 'Scroll the page or an element (default: down 300)',
    flags: [{ name: 'selector', type: 'string', desc: 'Scroll inside this element' }],
    async run(ctx, a) {
      const id = await ctx.tab();
      const dir = (a.pos[0] ?? 'down').toLowerCase();
      const px = Number(a.pos[1] ?? 300);
      const delta = { up: [0, -px], down: [0, px], left: [-px, 0], right: [px, 0] }[dir];
      if (!delta || !Number.isFinite(px))
        throw new UserError('Usage: scroll [up|down|left|right] [px]', 'bad_args');
      // Scrolled via script rather than wheel events: Chrome doesn't process wheel input for
      // background tabs, which is where agent tabs usually live.
      const sel = a.str('selector');
      const h = sel
        ? await element(ctx, sel)
        : await evaluateHandle(id, 'document.scrollingElement || document.documentElement');
      if (!h) throw new UserError('Nothing to scroll');
      await call(
        h,
        'function (dx, dy) { this.scrollBy({ left: dx, top: dy, behavior: "instant" }); }',
        [delta[0] ?? 0, delta[1] ?? 0],
      );
      return done({ scrolled: true });
    },
  },
  {
    name: 'scrollintoview',
    show: Infinity,
    aliases: ['scrollinto'],
    group: 'Interaction',
    usage: 'scrollintoview <target>',
    summary: 'Scroll an element into view',
    async run(ctx, a) {
      const h = await element(ctx, target(a));
      await cdp.send(h.tabId, 'DOM.scrollIntoViewIfNeeded', { objectId: h.objectId }, h.sessionId);
      return warn(done({ scrolled: target(a) }), multi(h, target(a)));
    },
  },
  {
    name: 'drag',
    show: Infinity,
    group: 'Interaction',
    usage: 'drag <source> <target> [--human]',
    summary: 'Drag one element onto another',
    flags: [{ name: 'human', type: 'bool', desc: 'Drag along a reproducible eased curve' }],
    async run(ctx, a) {
      const from = await clickPoint(await element(ctx, target(a)));
      const to = await clickPoint(await element(ctx, a.need(1, 'drop target')), {
        allowDisabled: true,
      });
      if (from.sessionId !== undefined || to.sessionId !== undefined) {
        throw new UserError('drag does not work inside a cross-origin iframe', 'bad_args');
      }
      const tab = await ctx.tab();
      const path = a.has('human') ? planHuman(tab, pt(to), { from: pt(from) }) : undefined;
      await input.drag(tab, pt(from), pt(to), path);
      return done({ dragged: true, source: target(a), target: a.need(1, 'drop target') });
    },
  },
  {
    name: 'upload',
    show: Infinity,
    group: 'Interaction',
    usage: 'upload <target> <file> [more…]',
    summary: 'Upload files to an <input type=file>, or to the chooser a button opens',
    details:
      'If the target is an <input type=file> the files are set on it. Any other target (a button such as "Upload resume") is clicked while the native file chooser is intercepted, so no dialog opens in the browser, and the files are given to the chooser the click opens. Fails after 5 s (or --timeout if shorter) when no chooser opens; sites using window.showOpenFilePicker cannot be fulfilled.',
    examples: ['bvl upload "input[type=file]" resume.pdf', 'bvl upload @e594 resume.pdf'],
    async run(ctx, a) {
      a.need(1, 'file');
      const h = await element(ctx, target(a));
      const files = a.pos.slice(1).map((f) => ctx.path(f));
      await checkFiles(h, files);
      const isInput = await call<boolean>(
        h,
        `function () { return this.tagName === 'INPUT' && this.type === 'file'; }`,
      );
      if (isInput) {
        await cdp.send(
          h.tabId,
          'DOM.setFileInputFiles',
          { objectId: h.objectId, files },
          h.sessionId,
        );
        return warn({ text: '✓ Done', data: { files } }, multi(h, target(a)));
      }
      await uploadViaChooser(ctx, h, files);
      return warn({ text: '✓ Done', data: { files, viaChooser: true } }, multi(h, target(a)));
    },
  },
  {
    name: 'find',
    details:
      'Finds an element by role, text, label, placeholder, alt, title or test id and optionally acts on it, so you do not need a snapshot first.',
    examples: [
      'bvl find role button click --name Submit',
      'bvl find text "Sign in" click',
      'bvl find label Email fill "me@example.com"',
    ],
    showFlags: ['name'],
    // Show the locator and the action; redact the action's value (typed text) after it.
    log(a) {
      const [kind = '', ...rest] = a.pos;
      const actionAt = kind === 'nth' ? 3 : 2; // find nth <n> <selector> <action>
      const pos = [kind, ...rest].map((p, i) => (i <= actionAt ? p : REDACTED));
      const flags = a
        .given()
        .flatMap(([n, v]) => [`--${n}`, ...(v === true ? [] : [n === 'name' ? v : REDACTED])]);
      return [...pos, ...flags];
    },
    group: 'Interaction',
    usage: FIND_HELP,
    summary: 'Find an element semantically (no snapshot needed) and act on it',
    flags: [
      { name: 'name', type: 'string', desc: 'Accessible name filter for `find role`' },
      { name: 'exact', type: 'bool', desc: 'Exact (not substring) text matching' },
    ],
    async run(ctx, a) {
      const { h, rest, warning } = await locate(ctx, a);
      const [action = '', value] = rest;
      return warn(await act(h, action, value), warning);
    },
  },
];

async function act(h: Handle, action: string, value: string | undefined): Promise<Result> {
  const needValue = () => {
    if (value === undefined) throw new UserError(`${action} needs a value`, 'bad_args');
    return value;
  };
  switch (action) {
    case 'click':
      return clickEl(h);
    case 'dblclick':
      return clickEl(h, 2);
    case 'hover':
      return hoverEl(h);
    case 'focus':
      await focusEl(h);
      return DONE;
    case 'fill':
      return fillEl(h, needValue());
    case 'type':
      return typeEl(h, needValue());
    case 'check':
      return setChecked(h, true);
    case 'uncheck':
      return setChecked(h, false);
    case 'select':
      return selectEl(h, [needValue()]);
    case 'text':
      return textOf(h);
    default:
      throw new UserError(`Unknown or missing action "${action}". Usage: ${FIND_HELP}`, 'bad_args');
  }
}
