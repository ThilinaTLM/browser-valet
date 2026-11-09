// `screenshot --if-changed` / `--threshold`: compare a capture with the last one taken for the same
// tab and scope. Pure pixel logic plus an in-memory store (images are too big for session storage).

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, `width * height * 4` bytes. */
  data: Uint8ClampedArray;
}

/** Largest per-channel difference that still counts as "the same" (anti-aliasing, JPEG noise). */
const CHANNEL_TOLERANCE = 8;

/** Fraction (0–1) of pixels that differ; 1 when the sizes differ. */
export function changedRatio(a: Pixels, b: Pixels): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  const n = a.width * a.height;
  if (n === 0) return 0;
  let changed = 0;
  for (let i = 0; i < n * 4; i += 4) {
    if (
      Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)) > CHANNEL_TOLERANCE ||
      Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0)) > CHANNEL_TOLERANCE ||
      Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0)) > CHANNEL_TOLERANCE
    ) {
      changed++;
    }
  }
  return changed / n;
}

/** Size to compare at: at most `max` px wide, same aspect ratio. */
export function comparisonSize(
  width: number,
  height: number,
  max = 640,
): { width: number; height: number } {
  if (width <= max) return { width, height };
  return { width: max, height: Math.max(1, Math.round((height * max) / width)) };
}

/** `0.0012` → `0.1200%` (upstream prints four decimals). */
export const formatPercent = (ratio: number): string => `${(ratio * 100).toFixed(4)}%`;

interface Entry {
  pixels: Pixels;
  revision: number;
}

const last = new Map<string, Entry>();

/** History key: tab plus capture scope (viewport/full, annotated or not). */
export const captureKey = (tabId: number, scope: string): string => `${String(tabId)}:${scope}`;
export const getCapture = (key: string): Entry | undefined => last.get(key);
export const setCapture = (key: string, e: Entry): void => void last.set(key, e);

export function forgetCaptures(tabId: number): void {
  for (const k of [...last.keys()]) if (k.startsWith(`${String(tabId)}:`)) last.delete(k);
}
