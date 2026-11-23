// Pixel diff for `diff screenshot`: pixelmatch's YIQ colour distance (without its anti-aliasing
// detection), output as upstream draws it: the baseline in grey at 30 % brightness, changed pixels red.
// Pure functions over RGBA buffers; decoding and encoding live in the command.

import type { Pixels } from './capture-compare';

export interface Size {
  width: number;
  height: number;
}

export interface ImageDiff {
  /** The diff image; absent when the sizes differ. */
  image?: Pixels;
  differentPixels: number;
  /** Pixels of the baseline. */
  totalPixels: number;
  /** Percent (0–100). */
  mismatchPercentage: number;
  match: boolean;
  dimensionMismatch: { expected: Size; actual: Size } | null;
}

/** Largest possible YIQ distance (black against white), used to scale `threshold`. */
const MAX_YIQ = 35215;

/** Alpha-blend a channel onto white. */
const blend = (c: number, a: number): number => 255 + (c - 255) * a;

/** Squared-ish YIQ distance between pixel `i` of `a` and of `b` (byte offsets), signed by brightness. */
function colorDelta(a: Uint8ClampedArray, b: Uint8ClampedArray, i: number): number {
  const alpha1 = (a[i + 3] ?? 255) / 255;
  const alpha2 = (b[i + 3] ?? 255) / 255;
  const r1 = blend(a[i] ?? 0, alpha1);
  const g1 = blend(a[i + 1] ?? 0, alpha1);
  const b1 = blend(a[i + 2] ?? 0, alpha1);
  const r2 = blend(b[i] ?? 0, alpha2);
  const g2 = blend(b[i + 1] ?? 0, alpha2);
  const b2 = blend(b[i + 2] ?? 0, alpha2);
  const y = (r1 - r2) * 0.29889531 + (g1 - g2) * 0.58662247 + (b1 - b2) * 0.11448223;
  const iq1 = (r1 - r2) * 0.59597799 - (g1 - g2) * 0.2741761 - (b1 - b2) * 0.32180189;
  const iq2 = (r1 - r2) * 0.21147017 - (g1 - g2) * 0.52261711 + (b1 - b2) * 0.31114694;
  return 0.5053 * y * y + 0.299 * iq1 * iq1 + 0.1957 * iq2 * iq2;
}

/**
 * Compare `actual` with `baseline`. `threshold` (0–1) is the colour distance tolerated per pixel
 * (upstream default 0.1; 0 flags any change, 1 flags nothing). Different sizes are not compared
 * pixel by pixel: every pixel counts as different, as upstream does.
 */
export function diffImages(baseline: Pixels, actual: Pixels, threshold: number): ImageDiff {
  const total = baseline.width * baseline.height;
  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    return {
      differentPixels: total,
      totalPixels: total,
      mismatchPercentage: 100,
      match: false,
      dimensionMismatch: {
        expected: { width: baseline.width, height: baseline.height },
        actual: { width: actual.width, height: actual.height },
      },
    };
  }
  const maxDelta = MAX_YIQ * threshold * threshold;
  const out = new Uint8ClampedArray(baseline.data.length);
  let different = 0;
  for (let i = 0; i < baseline.data.length; i += 4) {
    if (colorDelta(baseline.data, actual.data, i) > maxDelta) {
      different++;
      out[i] = 255;
      out[i + 1] = 0;
      out[i + 2] = 0;
    } else {
      const a = (baseline.data[i + 3] ?? 255) / 255;
      const luma =
        blend(baseline.data[i] ?? 0, a) * 0.299 +
        blend(baseline.data[i + 1] ?? 0, a) * 0.587 +
        blend(baseline.data[i + 2] ?? 0, a) * 0.114;
      const g = Math.floor(luma * 0.3);
      out[i] = g;
      out[i + 1] = g;
      out[i + 2] = g;
    }
    out[i + 3] = 255;
  }
  return {
    image: { width: baseline.width, height: baseline.height, data: out },
    differentPixels: different,
    totalPixels: total,
    mismatchPercentage: total === 0 ? 0 : (different / total) * 100,
    match: different === 0,
    dimensionMismatch: null,
  };
}
