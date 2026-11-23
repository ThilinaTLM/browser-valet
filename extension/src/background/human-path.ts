// Human-like pointer paths (pure): a seeded cubic Bézier with ease-in-out timing and, for long
// moves, a small overshoot that settles back on the target. Same inputs and seed → same points.

export interface Point {
  x: number;
  y: number;
}

export interface HumanPath {
  /** Points to move through, in order; the last one is exactly the target. */
  points: Point[];
  /** Total time to spend on the path, in ms. */
  durationMs: number;
}

export const MAX_STEPS = 240;
/** Moves longer than this (px) overshoot the target slightly and come back. */
const OVERSHOOT_MIN_DISTANCE = 400;

/** mulberry32: small, fast, deterministic PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth ease-in-out (smootherstep): slow start and end, fast middle. */
export function easeInOut(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Round to 0.01 px and keep inside the viewport's top-left (negative coordinates miss the page). */
const round = (n: number) => Math.max(0, Math.round(n * 100) / 100);

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/** Default duration: 250 ms for short moves up to 700 ms for long ones. */
export function defaultDuration(distance: number): number {
  return Math.round(Math.min(700, Math.max(250, 200 + distance * 0.5)));
}

/** Default number of events: about one per 16 ms, at least 8. */
export function defaultSteps(durationMs: number): number {
  return Math.min(MAX_STEPS, Math.max(8, Math.round(durationMs / 16)));
}

export function humanPath(
  from: Point,
  to: Point,
  opts: { seed: number; steps?: number; durationMs?: number },
): HumanPath {
  const rand = mulberry32(opts.seed);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const durationMs = Math.max(0, opts.durationMs ?? defaultDuration(dist));
  const steps = Math.min(
    MAX_STEPS,
    Math.max(1, Math.round(opts.steps ?? defaultSteps(durationMs))),
  );
  if (dist < 1 || steps === 1) return { points: [{ x: to.x, y: to.y }], durationMs };

  const ux = dx / dist;
  const uy = dy / dist;
  // Perpendicular offsets for the two control points, as a share of the distance.
  const side = rand() < 0.5 ? -1 : 1;
  const off1 = side * dist * (0.04 + rand() * 0.16);
  const off2 = (rand() < 0.7 ? side : -side) * dist * (0.02 + rand() * 0.12);
  const along1 = 0.2 + rand() * 0.15;
  const along2 = 0.6 + rand() * 0.15;
  const c1 = { x: from.x + dx * along1 - uy * off1, y: from.y + dy * along1 + ux * off1 };
  const c2 = { x: from.x + dx * along2 - uy * off2, y: from.y + dy * along2 + ux * off2 };

  // Overshoot: aim a few px past the target, then spend the last events returning to it.
  const overshoot = dist > OVERSHOOT_MIN_DISTANCE && steps >= 6;
  const back = overshoot ? Math.min(3, Math.floor(steps / 4)) : 0;
  const main = steps - back;
  const over = overshoot ? 3 + rand() * Math.min(12, dist * 0.015) : 0;
  const end = { x: to.x + ux * over, y: to.y + uy * over };
  // The control points are shifted with the end point so the curve stays smooth.
  const c2s = { x: c2.x + ux * over, y: c2.y + uy * over };

  const points: Point[] = [];
  for (let i = 1; i <= main; i++) {
    const p = bezier(from, c1, c2s, end, easeInOut(i / main));
    points.push({ x: round(p.x), y: round(p.y) });
  }
  for (let i = 1; i <= back; i++) {
    const t = easeInOut(i / back);
    points.push({ x: round(end.x + (to.x - end.x) * t), y: round(end.y + (to.y - end.y) * t) });
  }
  points[points.length - 1] = { x: to.x, y: to.y };
  return { points, durationMs };
}
