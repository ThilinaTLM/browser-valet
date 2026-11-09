import { type Args, type Command, type Ctx, REDACTED, type Result } from '../command';
import * as cdp from '../cdp';
import {
  call,
  clickPoint,
  evaluateHandle,
  fromBackend,
  type Handle,
  resolveWait,
  UserError,
} from '../dom';
import * as input from '../input';
import { settle } from '../tabs';
import { openInNewTab } from './navigation';

const DONE: Result = { text: '✓ Done' };

/** `✓ Done` with the upstream-style JSON payload (`{ clicked: '@e3' }`, …). */
const done = (data: unknown): Result => ({ text: '✓ Done', data });

async function element(ctx: Ctx, target: string): Promise<Handle> {
  return resolveWait(await ctx.tab(), target, ctx.timeout, ctx.signal);
}

// ---------------------------------------------------------------------------
// Actions on a resolved element (shared by direct commands and `find`)
// ---------------------------------------------------------------------------

async function clickEl(h: Handle, count = 1, button: input.Button = 'left'): Promise<Result> {
  const { x, y } = await clickPoint(h);
  await input.click(h.tabId, x, y, { count, button });
  await settle(h.tabId);
  return DONE;
}

async function focusEl(h: Handle): Promise<void> {
  await cdp.send(h.tabId, 'DOM.scrollIntoViewIfNeeded', { objectId: h.objectId }).catch(() => 0);
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
  await cdp.send(h.tabId, 'DOM.scrollIntoViewIfNeeded', { objectId: h.objectId }).catch(() => 0);
  await call(
    h,
    `function () {
      if (this.disabled || this.readOnly) throw new Error('Element is not editable');
      this.focus();
      if (typeof this.select === 'function') this.select();
      else if (this.isContentEditable) {
        const r = document.createRange();
        r.selectNodeContents(this);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
      } else throw new Error('Element is not an input, textarea or contenteditable');
    }`,
  );
  if (text) await input.insertText(h.tabId, text);
  else await input.press(h.tabId, 'Delete');
  return DONE;
}

async function typeEl(h: Handle, text: string): Promise<Result> {
  await focusEl(h);
  await input.type(h.tabId, text);
  return DONE;
}

async function hoverEl(h: Handle): Promise<Result> {
  const { x, y } = await clickPoint(h, { allowDisabled: true });
  await input.move(h.tabId, x, y);
  return DONE;
}

async function setChecked(h: Handle, want: boolean): Promise<Result> {
  const isChecked = () =>
    call<boolean>(
      h,
      `function () { return this.checked ?? this.getAttribute('aria-checked') === 'true'; }`,
    );
  if ((await isChecked()) !== want) await clickEl(h);
  if ((await isChecked()) !== want) throw new UserError(`Could not ${want ? 'check' : 'uncheck'}`);
  return DONE;
}

async function selectEl(h: Handle, values: string[]): Promise<Result> {
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

async function byAx(
  tabId: number,
  pred: (role: string, name: string) => boolean,
): Promise<Handle | null> {
  await cdp.send(tabId, 'Accessibility.enable');
  const { nodes } = await cdp.send<{ nodes: AXNode[] }>(tabId, 'Accessibility.getFullAXTree');
  const hit = nodes.find(
    (n) =>
      !n.ignored &&
      n.backendDOMNodeId !== undefined &&
      pred(asString(n.role?.value), asString(n.name?.value)),
  );
  return hit?.backendDOMNodeId !== undefined ? fromBackend(tabId, hit.backendDOMNodeId) : null;
}

async function byAttr(tabId: number, attr: string, value: string, exact: boolean) {
  return evaluateHandle(
    tabId,
    `(() => {
      const norm = (s) => s.replace(/\\s+/g, ' ').trim();
      const want = norm(${JSON.stringify(value)});
      const exact = ${String(exact)};
      return [...document.querySelectorAll('[${attr}]')].find((el) => {
        const v = norm(el.getAttribute('${attr}'));
        return exact ? v === want : v.toLowerCase().includes(want.toLowerCase());
      }) ?? null;
    })()`,
  );
}

async function byText(tabId: number, value: string, exact: boolean) {
  // The deepest visible element whose text matches.
  return evaluateHandle(
    tabId,
    `(() => {
      const norm = (s) => s.replace(/\\s+/g, ' ').trim();
      const want = norm(${JSON.stringify(value)});
      const exact = ${String(exact)};
      const match = (el) => {
        const t = norm(el.innerText ?? '');
        return exact ? t === want : t.toLowerCase().includes(want.toLowerCase());
      };
      let best = null;
      for (const el of document.body.querySelectorAll('*')) {
        if (!el.checkVisibility?.() || !match(el)) continue;
        if (!best || best.contains(el)) best = el;
      }
      return best;
    })()`,
  );
}

const FIND_HELP =
  'find <role|text|label|placeholder|alt|title|testid> <value> <action> [value]\n' +
  '     find <first|last> <selector> <action> [value] | find nth <n> <selector> <action> [value]\n' +
  '     actions: click dblclick hover focus fill type check uncheck select text';

async function locate(ctx: Ctx, a: Args): Promise<{ h: Handle; rest: string[] }> {
  const tabId = await ctx.tab();
  const [kind, value, ...rest] = a.pos;
  if (!kind || value === undefined) throw new UserError(`Usage: ${FIND_HELP}`, 'bad_args');
  const exact = a.has('exact');
  const name = a.str('name');
  let h: Handle | null;
  let rest2 = rest;
  switch (kind) {
    case 'role': {
      const nameOk = name === undefined ? () => true : matcher(name, exact);
      h = await byAx(tabId, (role, n) => role === value && nameOk(n));
      break;
    }
    case 'label': {
      const ok = matcher(value, exact);
      h = await byAx(tabId, (role, n) => FORM_ROLES.has(role) && ok(n));
      break;
    }
    case 'text':
      h = await byText(tabId, value, exact);
      break;
    case 'placeholder':
    case 'alt':
    case 'title':
      h = await byAttr(tabId, kind, value, exact);
      break;
    case 'testid':
      h = await byAttr(tabId, 'data-testid', value, true);
      break;
    case 'first':
    case 'last': {
      const all = `document.querySelectorAll(${JSON.stringify(value)})`;
      h = await evaluateHandle(
        tabId,
        kind === 'first' ? `${all}[0] ?? null` : `[...${all}].at(-1) ?? null`,
      );
      break;
    }
    case 'nth': {
      const selector = rest[0];
      if (!selector) throw new UserError(`Usage: ${FIND_HELP}`, 'bad_args');
      rest2 = rest.slice(1);
      h = await evaluateHandle(
        tabId,
        `document.querySelectorAll(${JSON.stringify(selector)})[${Number(value)}] ?? null`,
      );
      break;
    }
    default:
      throw new UserError(`Unknown locator "${kind}". Usage: ${FIND_HELP}`, 'bad_args');
  }
  if (!h) {
    const desc = kind === 'role' && name ? `role ${value} named "${name}"` : `${kind} "${value}"`;
    throw new UserError(`No element found by ${desc}`, 'not_found');
  }
  ctx.tabId = tabId;
  return { h, rest: rest2 };
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
      'bctl click @e3',
      'bctl click "button[type=submit]"',
      'bctl click "//button[@type=\'submit\']"',
    ],
    show: Infinity,
    group: 'Interaction',
    usage: 'click <target> [--new-tab] [--right]',
    summary: 'Click an element (@ref or CSS selector)',
    flags: [
      { name: 'new-tab', type: 'bool', desc: "Open the link's URL in a new agent tab" },
      { name: 'right', type: 'bool', desc: 'Right-click' },
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
      const r = await clickEl(h, 1, a.has('right') ? 'right' : 'left');
      return { ...r, data: { clicked: target(a) } };
    },
  },
  {
    name: 'dblclick',
    show: Infinity,
    group: 'Interaction',
    usage: 'dblclick <target>',
    summary: 'Double-click an element',
    async run(ctx, a) {
      await clickEl(await element(ctx, target(a)), 2);
      return done({ clicked: target(a) });
    },
  },
  {
    name: 'focus',
    group: 'Interaction',
    usage: 'focus <target>',
    summary: 'Focus an element',
    async run(ctx, a) {
      await focusEl(await element(ctx, target(a)));
      return done({ focused: target(a) });
    },
  },
  {
    name: 'hover',
    group: 'Interaction',
    usage: 'hover <target>',
    summary: 'Move the mouse over an element',
    async run(ctx, a) {
      await hoverEl(await element(ctx, target(a)));
      return done({ hovered: target(a) });
    },
  },
  {
    name: 'fill',
    details:
      'Clears the field and types the text. Use `type` to append without clearing. Fails if the element is not editable.',
    examples: ['bctl fill @e5 "user@example.com"', 'bctl fill "#search" "bridge"'],
    group: 'Interaction',
    usage: 'fill <target> <text>',
    summary: 'Clear an input and fill it with text',
    async run(ctx, a) {
      await fillEl(await element(ctx, target(a)), a.need(1, 'text'));
      return done({ filled: target(a) });
    },
  },
  {
    name: 'type',
    group: 'Interaction',
    usage: 'type <target> <text>',
    summary: 'Type text into an element without clearing it (real key events)',
    async run(ctx, a) {
      const text = a.need(1, 'text');
      await typeEl(await element(ctx, target(a)), text);
      return done({ typed: text });
    },
  },
  {
    name: 'press',
    details: 'Presses a key at the current focus; combine modifiers with +.',
    examples: ['bctl press Enter', 'bctl press Control+a', 'bctl press ControlOrMeta+c'],
    show: Infinity,
    aliases: ['key'],
    group: 'Interaction',
    usage: 'press <key>',
    summary: 'Press a key at the current focus: Enter, Tab, Control+a, ControlOrMeta+c, …',
    async run(ctx, a) {
      const id = await ctx.tab();
      const key = a.need(0, 'key');
      await input.press(id, key);
      await settle(id);
      return done({ pressed: key });
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
      await setChecked(await element(ctx, target(a)), true);
      return done({ checked: target(a) });
    },
  },
  {
    name: 'uncheck',
    show: Infinity,
    group: 'Interaction',
    usage: 'uncheck <target>',
    summary: 'Uncheck a checkbox / switch',
    async run(ctx, a) {
      await setChecked(await element(ctx, target(a)), false);
      return done({ unchecked: target(a) });
    },
  },
  {
    name: 'select',
    group: 'Interaction',
    usage: 'select <target> <value|label> [more…]',
    summary: 'Choose <select> option(s) by value or visible label',
    async run(ctx, a) {
      a.need(1, 'value');
      return selectEl(await element(ctx, target(a)), a.pos.slice(1));
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
      await cdp.send(h.tabId, 'DOM.scrollIntoViewIfNeeded', { objectId: h.objectId });
      return done({ scrolled: target(a) });
    },
  },
  {
    name: 'drag',
    show: Infinity,
    group: 'Interaction',
    usage: 'drag <source> <target>',
    summary: 'Drag one element onto another',
    async run(ctx, a) {
      const from = await clickPoint(await element(ctx, target(a)));
      const to = await clickPoint(await element(ctx, a.need(1, 'drop target')), {
        allowDisabled: true,
      });
      await input.drag(await ctx.tab(), from, to);
      return done({ dragged: true, source: target(a), target: a.need(1, 'drop target') });
    },
  },
  {
    name: 'upload',
    show: Infinity,
    group: 'Interaction',
    usage: 'upload <target> <file> [more…]',
    summary: 'Set files on an <input type=file>',
    async run(ctx, a) {
      a.need(1, 'file');
      const h = await element(ctx, target(a));
      const files = a.pos.slice(1).map((f) => ctx.path(f));
      await cdp.send(h.tabId, 'DOM.setFileInputFiles', { objectId: h.objectId, files });
      return { text: '✓ Done', data: { files } };
    },
  },
  {
    name: 'find',
    details:
      'Finds an element by role, text, label, placeholder, alt, title or test id and optionally acts on it, so you do not need a snapshot first.',
    examples: [
      'bctl find role button click --name Submit',
      'bctl find text "Sign in" click',
      'bctl find label Email fill "me@example.com"',
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
      const { h, rest } = await locate(ctx, a);
      const [action = '', value] = rest;
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
          throw new UserError(
            `Unknown or missing action "${action}". Usage: ${FIND_HELP}`,
            'bad_args',
          );
      }
    },
  },
];
