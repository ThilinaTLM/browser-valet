// Trusted mouse and keyboard input via CDP Input.* events.

import * as cdp from './cdp';
import { UserError } from './errors';
import type { Point } from './human-path';
import { pointer, setPointer } from './pointer';

/**
 * Background tabs don't render, and Chrome drops input aimed at a hidden document that has no
 * fresh frame (no hit-test data). Capturing a 1x1 screenshot forces one frame, after which trusted
 * clicks and key presses are delivered without bringing the tab to the front.
 * Returns whether the page is hidden.
 */
export async function prime(tabId: number): Promise<boolean> {
  const r = await cdp.send<{ result: { value?: unknown } }>(tabId, 'Runtime.evaluate', {
    expression: 'document.visibilityState',
    returnByValue: true,
  });
  if (r.result.value !== 'hidden') return false;
  const capture = cdp.send(tabId, 'Page.captureScreenshot', {
    format: 'jpeg',
    quality: 1,
    clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
  });
  // The capture occasionally never resolves for hidden tabs, but the frame is produced anyway.
  await Promise.race([capture.catch(() => undefined), sleep(500)]);
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Hidden pages never acknowledge some events (mouse moves wait for a frame); don't hang on them. */
export async function sendInput(
  tabId: number,
  hidden: boolean,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
): Promise<void> {
  const sent = cdp.send(tabId, method, params, sessionId);
  if (!hidden) {
    await sent;
    return;
  }
  await Promise.race([sent.catch(() => undefined), sleep(300)]);
}

// ---------------------------------------------------------------------------
// Mouse
// ---------------------------------------------------------------------------

export type Button = 'left' | 'right' | 'middle';

/** A path to move along before the real action: events spaced `delayMs` apart. */
export interface Travel {
  points: Point[];
  delayMs: number;
}

/**
 * Dispatch `mouseMoved` along a path, reporting the tab's held buttons. A hidden page acknowledges
 * moves only when it draws a frame, so there all but the last are sent without waiting (the order
 * is kept; the renderer coalesces them to about one per frame). The last one is awaited like any
 * input, so what it triggers (a drag interception) has happened when this returns. Returns the
 * time spent in ms.
 */
export async function travel(
  tabId: number,
  hidden: boolean,
  t: Travel,
  sessionId?: string,
): Promise<number> {
  const start = Date.now();
  const last = t.points.length - 1;
  for (let i = 0; i <= last; i++) {
    const pt = t.points[i];
    if (!pt) continue;
    const buttons = pointer(tabId).buttons;
    const params = {
      type: 'mouseMoved',
      x: pt.x,
      y: pt.y,
      button: buttons & 1 ? 'left' : buttons & 2 ? 'right' : buttons & 4 ? 'middle' : 'none',
      buttons,
      modifiers,
    };
    if (hidden && i < last) {
      cdp.send(tabId, 'Input.dispatchMouseEvent', params, sessionId).catch(() => undefined);
    } else {
      await sendInput(tabId, hidden, 'Input.dispatchMouseEvent', params, sessionId);
    }
    setPointer(tabId, pt.x, pt.y);
    if (i < last && t.delayMs > 0) await sleep(t.delayMs);
  }
  return Date.now() - start;
}

/** Move the pointer to (x, y), along `path` when given. */
export async function move(
  tabId: number,
  x: number,
  y: number,
  sessionId?: string,
  path?: Travel,
): Promise<{ hidden: boolean; elapsedMs: number }> {
  const hidden = await prime(tabId);
  if (path) return { hidden, elapsedMs: await travel(tabId, hidden, path, sessionId) };
  setPointer(tabId, x, y);
  await sendInput(
    tabId,
    hidden,
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x, y, modifiers },
    sessionId,
  );
  return { hidden, elapsedMs: 0 };
}

export async function click(
  tabId: number,
  x: number,
  y: number,
  {
    button = 'left',
    count = 1,
    sessionId,
    hover = true,
    hidden: knownHidden,
  }: {
    button?: Button;
    count?: number;
    sessionId?: string;
    /** Move onto the point first (false when the pointer is already there). */
    hover?: boolean;
    /** The result of a `prime` just done by the caller. */
    hidden?: boolean;
  } = {},
): Promise<void> {
  const hidden = knownHidden ?? (await prime(tabId));
  setPointer(tabId, x, y);
  // Hover first like a real user, except on hidden pages where moves are never acknowledged.
  if (hover && !hidden) {
    await cdp.send(
      tabId,
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x, y, modifiers },
      sessionId,
    );
  }
  for (let i = 1; i <= count; i++) {
    const base = { x, y, button, clickCount: i, modifiers };
    const press = { type: 'mousePressed', ...base };
    await sendInput(tabId, hidden, 'Input.dispatchMouseEvent', press, sessionId);
    const release = { type: 'mouseReleased', ...base };
    await sendInput(tabId, hidden, 'Input.dispatchMouseEvent', release, sessionId);
  }
}

export async function wheel(tabId: number, x: number, y: number, dx: number, dy: number) {
  await cdp.send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x,
    y,
    deltaX: dx,
    deltaY: dy,
    modifiers,
  });
}

/** Drag with the mouse; uses CDP drag interception so native HTML5 drag-and-drop works too. */
export async function drag(
  tabId: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
  path?: Travel,
): Promise<void> {
  let dragData: unknown;
  let held = false;
  const off = cdp.onEvent((id, method, params) => {
    if (id === tabId && method === 'Input.dragIntercepted') {
      dragData = (params as { data: unknown }).data;
    }
  });
  try {
    const hidden = await prime(tabId);
    await cdp.send(tabId, 'Input.setInterceptDrags', { enabled: true });
    held = true;
    pointer(tabId).buttons |= 1;
    await sendInput(tabId, hidden, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
    await sendInput(tabId, hidden, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...from,
      button: 'left',
      clickCount: 1,
    });
    if (path) {
      await travel(tabId, hidden, path);
    } else {
      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        const x = from.x + ((to.x - from.x) * i) / steps;
        const y = from.y + ((to.y - from.y) * i) / steps;
        await sendInput(tabId, hidden, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x,
          y,
          button: 'left',
        });
      }
    }
    if (dragData !== undefined) {
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await sendInput(tabId, hidden, 'Input.dispatchDragEvent', { type, ...to, data: dragData });
      }
    }
    await sendInput(tabId, hidden, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...to,
      button: 'left',
      clickCount: 1,
    });
    setPointer(tabId, to.x, to.y);
  } finally {
    off();
    if (held) pointer(tabId).buttons &= ~1;
    await cdp.send(tabId, 'Input.setInterceptDrags', { enabled: false }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED: Record<string, Omit<KeyDef, 'key'>> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Insert: { code: 'Insert', keyCode: 45 },
  Shift: { code: 'ShiftLeft', keyCode: 16 },
  Control: { code: 'ControlLeft', keyCode: 17 },
  Alt: { code: 'AltLeft', keyCode: 18 },
  Meta: { code: 'MetaLeft', keyCode: 91 },
};
for (let i = 1; i <= 12; i++) NAMED[`F${i}`] = { code: `F${i}`, keyCode: 111 + i };

const ALIASES: Record<string, string> = {
  esc: 'Escape',
  return: 'Enter',
  del: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  space: ' ',
  ctrl: 'Control',
  cmd: 'Meta',
  command: 'Meta',
  option: 'Alt',
};

const MOD_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

let isMac = false;
void chrome.runtime.getPlatformInfo().then((p) => (isMac = p.os === 'mac'));

/** Modifiers currently held via `keydown`. */
let modifiers = 0;
/** Currently held modifier bits (for other input helpers). */
export const heldModifiers = (): number => modifiers;

function canonical(name: string): string {
  if (name === 'ControlOrMeta') return isMac ? 'Meta' : 'Control';
  const alias = ALIASES[name.toLowerCase()];
  if (alias) return alias;
  return Object.keys(NAMED).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
}

function keyDef(name: string): KeyDef {
  const key = canonical(name);
  const named = NAMED[key];
  if (named) return { key, ...named };
  if ([...key].length !== 1) throw new UserError(`Unknown key: ${name}`);
  const upper = key.toUpperCase();
  if (/[a-z]/i.test(key))
    return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key };
  if (/[0-9]/.test(key)) return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
  if (key === ' ') return { key, code: 'Space', keyCode: 32, text: ' ' };
  return { key, code: '', keyCode: 0, text: key };
}

// macOS has no default key bindings for editing shortcuts in CDP; name the commands explicitly.
const MAC_COMMANDS: Record<string, string> = {
  a: 'selectAll',
  c: 'copy',
  x: 'cut',
  v: 'paste',
  z: 'undo',
};

async function keyEvent(tabId: number, type: 'down' | 'up', def: KeyDef, mods: number) {
  const shortcut = (mods & (MOD_BITS.Control ?? 0)) !== 0 || (mods & (MOD_BITS.Meta ?? 0)) !== 0;
  let text = shortcut ? undefined : def.text;
  if (text && mods & (MOD_BITS.Shift ?? 0)) text = text.toUpperCase();
  const base = {
    key: text?.length === 1 ? text : def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    modifiers: mods,
  };
  if (type === 'up') {
    await cdp.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    return;
  }
  const commands =
    isMac && mods === MOD_BITS.Meta && MAC_COMMANDS[def.key.toLowerCase()]
      ? [MAC_COMMANDS[def.key.toLowerCase()]]
      : undefined;
  await cdp.send(tabId, 'Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown',
    ...base,
    text,
    unmodifiedText: text,
    commands,
  });
}

/** Press a key or chord such as `Enter`, `Control+a`, `Shift+Tab`, `ControlOrMeta+c`. */
export async function press(tabId: number, combo: string): Promise<void> {
  const parts = combo === '+' ? ['+'] : combo.split('+').filter(Boolean);
  const keyName = parts.pop();
  if (!keyName) throw new UserError('Missing key');
  await prime(tabId);
  let mods = modifiers;
  const modDefs: KeyDef[] = [];
  for (const p of parts) {
    const name = canonical(p);
    const bit = MOD_BITS[name];
    if (!bit) throw new UserError(`Unknown modifier: ${p}`);
    mods |= bit;
    modDefs.push(keyDef(name));
  }
  for (const m of modDefs) await keyEvent(tabId, 'down', m, mods);
  const def = keyDef(keyName);
  await keyEvent(tabId, 'down', def, mods);
  await keyEvent(tabId, 'up', def, mods);
  for (const m of modDefs.reverse()) await keyEvent(tabId, 'up', m, mods);
}

export async function keyDown(tabId: number, name: string): Promise<void> {
  await prime(tabId);
  const def = keyDef(name);
  modifiers |= MOD_BITS[def.key] ?? 0;
  await keyEvent(tabId, 'down', def, modifiers);
}

export async function keyUp(tabId: number, name: string): Promise<void> {
  const def = keyDef(name);
  await keyEvent(tabId, 'up', def, modifiers);
  modifiers &= ~(MOD_BITS[def.key] ?? 0);
}

/** Type text as individual key presses. */
export async function type(tabId: number, text: string): Promise<void> {
  await prime(tabId);
  for (const ch of text) {
    if (ch === '\n') {
      await press(tabId, 'Enter');
      continue;
    }
    const def = /^[\x20-\x7e]$/.test(ch) ? keyDef(ch) : { key: ch, code: '', keyCode: 0, text: ch };
    await keyEvent(tabId, 'down', def, modifiers);
    await keyEvent(tabId, 'up', def, modifiers);
  }
}

/** Insert text in one go (like an IME commit); bypasses key handlers. */
export async function insertText(tabId: number, text: string): Promise<void> {
  await cdp.send(tabId, 'Input.insertText', { text });
}
