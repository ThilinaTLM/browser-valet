// Small agent-browser parity commands: mouse, highlight, get styles helper (see automation.md).

import * as cdp from '../cdp';
import { type Command, type Ctx } from '../command';
import { call, evaluate, type Handle, resolve, UserError } from '../dom';
import { heldModifiers, prime, sendInput } from '../input';
import { sleep } from '../tabs';

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
    throw new UserError('Button must be left, right or middle');
  }
  return b;
}

function coord(s: string | undefined, what: string): number {
  const n = Number(s);
  if (s === undefined || s === '' || !Number.isFinite(n)) throw new UserError(`Missing ${what}`);
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
        throw new UserError(`Unknown: mouse ${what}`);
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
    await Promise.all([cdp.send(id, 'DOM.enable'), cdp.send(id, 'Overlay.enable')]);
    await clearHighlight(id);
    await cdp.send(id, 'Overlay.highlightNode', {
      objectId: h.objectId,
      highlightConfig: {
        showInfo: false,
        contentColor: { r: 111, g: 168, b: 220, a: 0.4 },
        paddingColor: { r: 147, g: 196, b: 125, a: 0.4 },
        borderColor: { r: 255, g: 229, b: 153, a: 0.6 },
        marginColor: { r: 246, g: 178, b: 107, a: 0.4 },
      },
    });
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
    if (v === '' && names.length && !all) throw new UserError(`Unknown CSS property: ${n}`);
    out[n] = v;
  }
  return out;
}

export const extraCommands: Command[] = [mouse, highlight];
