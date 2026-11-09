import { describe, expect, it } from 'vitest';
import {
  captureKey,
  changedRatio,
  comparisonSize,
  formatPercent,
  forgetCaptures,
  getCapture,
  type Pixels,
  setCapture,
} from '../../src/background/capture-compare';

const px = (w: number, h: number, v = 255): Pixels => ({
  width: w,
  height: h,
  data: new Uint8ClampedArray(w * h * 4).fill(v),
});

describe('changedRatio', () => {
  it('is 0 for identical images and 1 for a size change', () => {
    expect(changedRatio(px(4, 4), px(4, 4))).toBe(0);
    expect(changedRatio(px(4, 4), px(4, 5))).toBe(1);
  });

  it('counts pixels over the tolerance only', () => {
    const a = px(10, 10);
    const b = px(10, 10);
    b.data[0] = 250; // within tolerance
    b.data[4] = 100; // one pixel changed
    b.data[8 + 2] = 0; // another one
    expect(changedRatio(a, b)).toBe(0.02);
  });
});

describe('helpers', () => {
  it('downscales to at most 640 wide, keeping the aspect ratio', () => {
    expect(comparisonSize(300, 200)).toEqual({ width: 300, height: 200 });
    expect(comparisonSize(1280, 800)).toEqual({ width: 640, height: 400 });
  });

  it('formats percentages with four decimals', () => {
    expect(formatPercent(0)).toBe('0.0000%');
    expect(formatPercent(0.0012443)).toBe('0.1244%');
  });

  it('keeps history per tab and scope and forgets a closed tab', () => {
    setCapture(captureKey(7, 'view'), { pixels: px(1, 1), revision: 2 });
    setCapture(captureKey(7, 'full'), { pixels: px(1, 1), revision: 1 });
    setCapture(captureKey(70, 'view'), { pixels: px(1, 1), revision: 1 });
    expect(getCapture(captureKey(7, 'view'))?.revision).toBe(2);
    forgetCaptures(7);
    expect(getCapture(captureKey(7, 'view'))).toBeUndefined();
    expect(getCapture(captureKey(7, 'full'))).toBeUndefined();
    expect(getCapture(captureKey(70, 'view'))).toBeDefined();
  });
});
