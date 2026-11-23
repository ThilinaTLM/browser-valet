// Pixel diff for `diff screenshot`, ported from agent-browser 0.41.2 (cli/src/native/diff.rs): a pixel
// differs when the Euclidean RGB distance exceeds `threshold * 255 * sqrt(3)` (alpha is ignored).
// Output: the baseline in grey at 30 % brightness, changed pixels red.
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
  const maxDist = threshold * 255 * Math.sqrt(3);
  const out = new Uint8ClampedArray(baseline.data.length);
  let different = 0;
  for (let i = 0; i < baseline.data.length; i += 4) {
    const r = baseline.data[i] ?? 0;
    const g = baseline.data[i + 1] ?? 0;
    const b = baseline.data[i + 2] ?? 0;
    const dr = r - (actual.data[i] ?? 0);
    const dg = g - (actual.data[i + 1] ?? 0);
    const db = b - (actual.data[i + 2] ?? 0);
    if (Math.sqrt(dr * dr + dg * dg + db * db) > maxDist) {
      different++;
      out[i] = 255;
    } else {
      const grey = Math.floor(Math.floor((r + g + b) / 3) * 0.3);
      out[i] = grey;
      out[i + 1] = grey;
      out[i + 2] = grey;
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
