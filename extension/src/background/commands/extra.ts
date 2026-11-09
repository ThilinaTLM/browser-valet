// Small agent-browser parity commands: mouse, highlight, get styles helper, pushstate, session (see automation.md).

import * as cdp from '../cdp';
import { type Command, type Ctx } from '../command';
import { call, evaluate, type Handle, resolve, UserError } from '../dom';
import { heldModifiers, prime, sendInput } from '../input';
import { meta, state } from '../state';
import { isControlled, sleep } from '../tabs';

const DONE = { text: '✓ Done' };

// ---------------------------------------------------------------------------
// mouse
// ---------------------------------------------------------------------------

type Button = 'left' | 'right' | 'middle';
const BUTTON_BIT: Record<Button, number> = { left: 1, right: 2, middle: 4 };

interface Pointer {
  x: number;
  y: number;
  /** Bitmask of held buttons (CDP `buttons`). */
  buttons: number;
}

/** Pointer position and held buttons per tab. In memory only: lost on a service-worker restart. */
const pointers = new Map<number, Pointer>();

function pointer(tabId: number): Pointer {
  let p = pointers.get(tabId);
  if (!p) {
    p = { x: 0, y: 0, buttons: 0 };
    pointers.set(tabId, p);
  }
  return p;
}

function parseButton(s: string | undefined): Button {
  const b = (s ?? 'left').toLowerCase();
  if (b !== 'left' && b !== 'right' && b !== 'middle') {
    throw new UserError('Button must be left, right or middle', 'bad_args');
  }
  return b;
}

function coord(s: string | undefined, what: string): number {
  const n = Number(s);
  if (s === undefined || s === '' || !Number.isFinite(n))
    throw new UserError(`Missing ${what}`, 'bad_args');
  return n;
}

/** The button reported for moves: the lowest held one. */
function heldButton(buttons: number): Button | 'none' {
  if (buttons & 1) return 'left';
  if (buttons & 2) return 'right';
  if (buttons & 4) return 'middle';
  return 'none';
}

async function mouseMove(ctx: Ctx, x: number, y: number, duration: number, steps: number) {
  const id = await ctx.tab();
  const p = pointer(id);
  const hidden = await prime(id);
  const fromX = p.x;
  const fromY = p.y;
  for (let i = 1; i <= steps; i++) {
    const nx = fromX + ((x - fromX) * i) / steps;
    const ny = fromY + ((y - fromY) * i) / steps;
    await sendInput(id, hidden, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: nx,
      y: ny,
      button: heldButton(p.buttons),
      buttons: p.buttons,
      modifiers: heldModifiers(),
    });
    p.x = nx;
    p.y = ny;
    if (i < steps && duration > 0) await sleep(duration / steps);
  }
  return { moved: true, x, y };
}

async function mouseButton(ctx: Ctx, down: boolean, button: Button) {
  const id = await ctx.tab();
  const p = pointer(id);
  const bit = BUTTON_BIT[button];
  const hidden = await prime(id);
  p.buttons = down ? p.buttons | bit : p.buttons & ~bit;
  await sendInput(id, hidden, 'Input.dispatchMouseEvent', {
    type: down ? 'mousePressed' : 'mouseReleased',
    x: p.x,
    y: p.y,
    button,
    buttons: p.buttons,
    clickCount: 1,
    modifiers: heldModifiers(),
  });
}

const mouse: Command = {
  name: 'mouse',
  show: Infinity,
  group: 'Interaction',
  usage: 'mouse <move x y|down [btn]|up [btn]|wheel dy [dx]>',
  summary: 'Low-level pointer: move (--duration/--steps), press, release, wheel',
  flags: [
    { name: 'duration', type: 'string', desc: '`mouse move`: spread the move over this many ms' },
    { name: 'steps', type: 'string', desc: '`mouse move`: number of intermediate events' },
  ],
  async run(ctx, a) {
    const what = a.need(0, 'move|down|up|wheel');
    switch (what) {
      case 'move': {
        const x = coord(a.pos[1], 'x');
        const y = coord(a.pos[2], 'y');
        const duration = Math.max(0, a.num('duration') ?? 0);
        const steps = Math.min(
          500,
          Math.max(1, Math.round(a.num('steps') ?? (duration > 0 ? duration / 16 : 1))),
        );
        return { ...DONE, data: await mouseMove(ctx, x, y, duration, steps) };
      }
      case 'down':
      case 'up': {
        await mouseButton(ctx, what === 'down', parseButton(a.pos[1]));
        return { ...DONE, data: what === 'down' ? { pressed: true } : { released: true } };
      }
      case 'wheel': {
        const dy = coord(a.pos[1], 'dy');
        const dx = a.pos[2] === undefined ? 0 : coord(a.pos[2], 'dx');
        const id = await ctx.tab();
        const p = pointer(id);
        if (await prime(id)) {
          // Chrome never processes wheel input for hidden tabs (see `scroll`): scroll the
          // element under the pointer by script instead. No `wheel` event reaches the page.
          await evaluate(
            id,
            `((x, y, dx, dy) => {
              let el = document.elementFromPoint(x, y);
              while (el && el !== document.scrollingElement) {
                const s = getComputedStyle(el);
                if (/(auto|scroll)/.test(s.overflowY + s.overflowX) &&
                    (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)) break;
                el = el.parentElement;
              }
              (el || document.scrollingElement).scrollBy({ left: dx, top: dy, behavior: 'instant' });
            })(${p.x}, ${p.y}, ${dx}, ${dy})`,
          );
        } else {
          await cdp.send(id, 'Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: p.x,
            y: p.y,
            deltaX: dx,
            deltaY: dy,
            modifiers: heldModifiers(),
          });
          // The page receives the wheel event (and scrolls) slightly after Chrome acknowledges it.
          await sleep(120);
        }
        return { ...DONE, data: { scrolled: true, deltaX: dx, deltaY: dy } };
      }
      default:
        throw new UserError(`Unknown: mouse ${what}`, 'bad_args');
    }
  },
};

// ---------------------------------------------------------------------------
// highlight
// ---------------------------------------------------------------------------

/** How long a highlight stays before it fades out. */
export const HIGHLIGHT_MS = 3000;
const highlightTimers = new Map<number, ReturnType<typeof setTimeout>>();

async function clearHighlight(tabId: number): Promise<void> {
  const t = highlightTimers.get(tabId);
  if (t) clearTimeout(t);
  highlightTimers.delete(tabId);
  await cdp.send(tabId, 'Overlay.hideHighlight').catch(() => undefined);
}

const highlight: Command = {
  name: 'highlight',
  show: Infinity,
  group: 'Interaction',
  usage: 'highlight <target>',
  summary: 'Outline an element in the page for a few seconds',
  async run(ctx, a) {
    const target = a.need(0, 'target');
    const id = await ctx.tab();
    const h = await resolve(id, target);
    await Promise.all([
      cdp.send(id, 'DOM.enable', {}, h.sessionId),
      cdp.send(id, 'Overlay.enable', {}, h.sessionId),
    ]);
    await clearHighlight(id);
    await cdp.send(
      id,
      'Overlay.highlightNode',
      {
        objectId: h.objectId,
        highlightConfig: {
          showInfo: false,
          contentColor: { r: 111, g: 168, b: 220, a: 0.4 },
          paddingColor: { r: 147, g: 196, b: 125, a: 0.4 },
          borderColor: { r: 255, g: 229, b: 153, a: 0.6 },
          marginColor: { r: 246, g: 178, b: 107, a: 0.4 },
        },
      },
      h.sessionId,
    );
    // The overlay stays until hidden. Fade it out so the page isn't left decorated.
    highlightTimers.set(
      id,
      setTimeout(() => void clearHighlight(id), HIGHLIGHT_MS),
    );
    return { ...DONE, data: { highlighted: target } };
  },
};

// ---------------------------------------------------------------------------
// get styles
// ---------------------------------------------------------------------------

/** What `get styles` prints without arguments (upstream prints all ~450 properties). */
export const CURATED_STYLES = [
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'color',
  'background-color',
  'display',
  'visibility',
  'opacity',
  'position',
  'width',
  'height',
  'margin',
  'padding',
  'border',
  'z-index',
  'cursor',
  'pointer-events',
  'overflow',
];

/** Computed style of an element: curated set, the named properties, or everything (sorted). */
export async function computedStyles(
  h: Handle,
  props: string[],
  all: boolean,
): Promise<Record<string, string>> {
  const names = props.map((p) => p.replace(/:$/, '').toLowerCase());
  const pairs = await call<[string, string][]>(
    h,
    `function (names, all) {
      const cs = getComputedStyle(this.nodeType === 1 ? this : this.parentElement);
      const list = all ? [...cs].sort() : names;
      return list.map((n) => [n, cs.getPropertyValue(n)]);
    }`,
    [names.length ? names : CURATED_STYLES, all],
  );
  const out: Record<string, string> = {};
  for (const [n, v] of pairs) {
    if (v === '' && names.length && !all)
      throw new UserError(`Unknown CSS property: ${n}`, 'bad_args');
    out[n] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// pushstate
// ---------------------------------------------------------------------------

const pushstate: Command = {
  name: 'pushstate',
  group: 'Navigation',
  usage: 'pushstate <url>',
  summary: 'Client-side (SPA) navigation to a same-origin URL',
  async run(ctx, a) {
    const input = a.need(0, 'url');
    const id = await ctx.tab();
    const r = await evaluate(
      id,
      `((input) => {
        try {
          const url = new URL(input, location.href);
          if (url.origin !== location.origin) {
            return { error: 'pushstate is same-origin only: ' + url.origin + ' is not ' + location.origin };
          }
          const router = window.next && window.next.router;
          if (router && typeof router.push === 'function') {
            router.push(url.href);
          } else {
            history.pushState(null, '', url.href);
            dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
          }
          return { url: url.href };
        } catch (e) {
          return { error: String(e && e.message || e) };
        }
      })(${JSON.stringify(input)})`,
    );
    const v = r.value as { url?: string; error?: string } | undefined;
    if (!v || v.error !== undefined) throw new UserError(v?.error ?? 'pushstate failed');
    return { text: v.url, data: { url: v.url } };
  },
};

// ---------------------------------------------------------------------------
// session list / info (read-only)
// ---------------------------------------------------------------------------

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function ownedTids(name: string): string[] {
  return Object.values(state.tabs)
    .filter((m) => m.owner === name)
    .map((m) => m.tid);
}

function lastActivity(name: string): number | undefined {
  return state.log.find((e) => e.session === name)?.ts;
}

const sessionCmd: Command = {
  name: 'session',
  show: Infinity,
  group: 'Tabs',
  usage: 'session <list|info>',
  summary: 'Show sessions (list) or the current one (info)',
  async run(ctx, a) {
    const what = a.pos[0] ?? 'info';
    if (what === 'list') {
      const names = [...new Set([ctx.session, ...Object.keys(state.sessions)])].sort();
      const sessions = names.map((name) => {
        const tabId = state.sessions[name]?.tab;
        const m = tabId === undefined ? undefined : state.tabs[tabId];
        return {
          name,
          current: name === ctx.session,
          tab: tabId !== undefined && m && isControlled(tabId) ? m.tid : null,
          owned: ownedTids(name),
          lastActivity: lastActivity(name) ?? null,
        };
      });
      const lines = sessions.map((s) => {
        const parts = [`tab ${s.tab ?? '-'}`];
        if (s.owned.length) parts.push(`owns ${s.owned.join(',')}`);
        if (s.lastActivity !== null) parts.push(`last ${ago(s.lastActivity)}`);
        return `${s.current ? '→' : ' '} ${s.name}  ${parts.join('  ')}`;
      });
      return { text: ['Active sessions:', ...lines].join('\n'), data: { sessions } };
    }
    if (what === 'info') {
      const tabId = state.sessions[ctx.session]?.tab;
      let tab: string | null = null;
      let label: string | null = null;
      let title: string | null = null;
      let url: string | null = null;
      let note = '';
      const frame = (tabId === undefined ? undefined : state.frames[tabId]?.name) ?? 'main';
      if (tabId !== undefined) {
        const m = meta(tabId);
        tab = m.tid;
        label = m.label ?? null;
        const t = await chrome.tabs.get(tabId).catch(() => undefined);
        if (!t) note = ' (closed)';
        else if (!isControlled(tabId)) note = ' (not shared)';
        else {
          title = t.title ?? null;
          url = t.url ?? null;
        }
      }
      const text = [
        `Session: ${ctx.session}`,
        `Tab: ${tab === null ? '-' : tab + note}`,
        ...(label ? [`Label: ${label}`] : []),
        ...(url !== null ? [`Title: ${title ?? ''}`, `URL: ${url}`] : []),
        `Frame: ${frame}`,
      ].join('\n');
      return {
        text,
        data: {
          session: ctx.session,
          tab,
          label,
          title,
          url,
          frame,
          owned: ownedTids(ctx.session),
          lastActivity: lastActivity(ctx.session) ?? null,
        },
      };
    }
    throw new UserError(`Unknown: session ${what}`, 'bad_args');
  },
};

export const extraCommands: Command[] = [mouse, highlight, pushstate, sessionCmd];
