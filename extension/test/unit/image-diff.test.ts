import { describe, expect, it } from 'vitest';
import type { Pixels } from '../../src/background/capture-compare';
import { diffImages } from '../../src/background/image-diff';

const solid = (w: number, h: number, rgb: [number, number, number]): Pixels => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return { width: w, height: h, data };
};
const setPx = (p: Pixels, x: number, y: number, rgb: [number, number, number]) => {
  p.data.set([...rgb, 255], (y * p.width + x) * 4);
};
const at = (p: Pixels, x: number, y: number) => [
  ...p.data.slice((y * p.width + x) * 4, (y * p.width + x) * 4 + 4),
];

const img = (d: ReturnType<typeof diffImages>): Pixels => {
  if (!d.image) throw new Error('no diff image');
  return d.image;
};

describe('diffImages', () => {
  it('matches identical images and paints the baseline grey at 30 %', () => {
    const d = diffImages(solid(4, 4, [255, 255, 255]), solid(4, 4, [255, 255, 255]), 0.1);
    expect(d).toMatchObject({
      match: true,
      differentPixels: 0,
      totalPixels: 16,
      mismatchPercentage: 0,
      dimensionMismatch: null,
    });
    expect(at(img(d), 1, 1)).toEqual([76, 76, 76, 255]);
  });

  it('paints a single changed pixel red', () => {
    const a = solid(4, 4, [255, 255, 255]);
    const b = solid(4, 4, [255, 255, 255]);
    setPx(b, 2, 3, [0, 0, 0]);
    const d = diffImages(a, b, 0.1);
    expect(d.differentPixels).toBe(1);
    expect(d.match).toBe(false);
    expect(d.mismatchPercentage).toBeCloseTo(6.25);
    expect(at(img(d), 2, 3)).toEqual([255, 0, 0, 255]);
    expect(at(img(d), 0, 0)).toEqual([76, 76, 76, 255]);
  });

  it('counts everything as different when the sizes differ', () => {
    const d = diffImages(solid(4, 3, [0, 0, 0]), solid(2, 2, [0, 0, 0]), 0.1);
    expect(d.image).toBeUndefined();
    expect(d).toMatchObject({
      match: false,
      differentPixels: 12,
      totalPixels: 12,
      mismatchPercentage: 100,
    });
    expect(d.dimensionMismatch).toEqual({
      expected: { width: 4, height: 3 },
      actual: { width: 2, height: 2 },
    });
  });

  it('honours the threshold', () => {
    const a = solid(2, 2, [100, 100, 100]);
    const b = solid(2, 2, [110, 110, 110]);
    expect(diffImages(a, b, 0.1).match).toBe(true);
    expect(diffImages(a, b, 0).differentPixels).toBe(4);
    expect(diffImages(solid(2, 2, [0, 0, 0]), solid(2, 2, [255, 255, 255]), 1).match).toBe(true);
  });
});
