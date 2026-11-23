// Per-tab pointer state: position and held buttons. In memory only: lost on a service-worker
// restart. `mouse` commands and every click/hover/drag keep it current so a later `--human`
// move starts where the pointer last was.

import { humanPath, type Point } from './human-path';
import type { Travel } from './input';

export interface Pointer {
  x: number;
  y: number;
  /** Bitmask of held buttons (CDP `buttons`). */
  buttons: number;
}

const pointers = new Map<number, Pointer>();

export function pointer(tabId: number): Pointer {
  let p = pointers.get(tabId);
  if (!p) {
    p = { x: 0, y: 0, buttons: 0 };
    pointers.set(tabId, p);
  }
  return p;
}

export function setPointer(tabId: number, x: number, y: number): void {
  const p = pointer(tabId);
  p.x = x;
  p.y = y;
}

/** Fresh random seed for `--human` without `--seed`. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x100000000);
}

/** A human path from the tab's last pointer position (or `from`) to `to`, ready for `input`. */
export function planHuman(
  tabId: number,
  to: Point,
  opts: { from?: Point; seed?: number } = {},
): Travel & { durationMs: number } {
  const from = opts.from ?? pointer(tabId);
  const hp = humanPath({ x: from.x, y: from.y }, to, { seed: opts.seed ?? randomSeed() });
  return {
    points: hp.points,
    delayMs: hp.durationMs / Math.max(1, hp.points.length),
    durationMs: hp.durationMs,
  };
}
