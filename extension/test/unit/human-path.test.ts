import { describe, expect, it } from 'vitest';
import { humanPath, MAX_STEPS, mulberry32 } from '../../src/background/human-path';

const from = { x: 10, y: 10 };

describe('humanPath', () => {
  it('is reproducible for the same seed and differs between seeds', () => {
    const a = humanPath(from, { x: 500, y: 300 }, { seed: 42 });
    expect(humanPath(from, { x: 500, y: 300 }, { seed: 42 })).toEqual(a);
    expect(humanPath(from, { x: 500, y: 300 }, { seed: 43 }).points).not.toEqual(a.points);
  });

  it('ends exactly on the target and curves away from the straight line', () => {
    const to = { x: 300, y: 10 };
    const { points } = humanPath(from, to, { seed: 7, steps: 30 });
    expect(points).toHaveLength(30);
    expect(points.at(-1)).toEqual(to);
    expect(Math.max(...points.map((p) => Math.abs(p.y - 10)))).toBeGreaterThan(3);
  });

  it('eases: steps near the ends are shorter than in the middle', () => {
    const { points } = humanPath(from, { x: 300, y: 10 }, { seed: 1, steps: 40 });
    const d = (i: number) => {
      const a = points[i] ?? from;
      const b = points[i + 1] ?? from;
      return Math.hypot(b.x - a.x, b.y - a.y);
    };
    expect(d(0)).toBeLessThan(d(19));
    expect(d(37)).toBeLessThan(d(19));
  });

  it('overshoots long moves and comes back', () => {
    const to = { x: 1000, y: 10 };
    const { points } = humanPath(from, to, { seed: 3, steps: 40 });
    expect(Math.max(...points.map((p) => p.x))).toBeGreaterThan(1000);
    expect(points.at(-1)).toEqual(to);
    const short = humanPath(from, { x: 200, y: 10 }, { seed: 3, steps: 40 });
    expect(Math.max(...short.points.map((p) => p.x))).toBeLessThan(215);
  });

  it('derives duration and steps from the distance, and honours overrides', () => {
    const near = humanPath(from, { x: 20, y: 10 }, { seed: 1 });
    const far = humanPath(from, { x: 2000, y: 10 }, { seed: 1 });
    expect(near.durationMs).toBe(250);
    expect(far.durationMs).toBe(700);
    expect(far.points.length).toBeGreaterThan(near.points.length - 1);
    expect(far.points.length).toBeLessThanOrEqual(MAX_STEPS);
    expect(humanPath(from, { x: 500, y: 10 }, { seed: 1, steps: 5, durationMs: 90 })).toMatchObject(
      {
        durationMs: 90,
      },
    );
  });

  it('handles a zero-length move and a single step', () => {
    expect(humanPath(from, from, { seed: 1 }).points).toEqual([from]);
    expect(humanPath(from, { x: 50, y: 50 }, { seed: 1, steps: 1 }).points).toEqual([
      { x: 50, y: 50 },
    ]);
  });

  it('mulberry32 is deterministic and in [0, 1)', () => {
    const a = mulberry32(5);
    const b = mulberry32(5);
    for (let i = 0; i < 20; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
