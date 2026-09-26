import { describe, expect, it } from 'vitest';
import { inViewWindow, VIEW_WINDOW_HALF } from './viewWindow';

describe('inViewWindow', () => {
  const c = { x: 1000, y: 500 };
  it('默认半宽 220，半开区间 -half ≤ d < half', () => {
    expect(VIEW_WINDOW_HALF).toBe(220);
    expect(inViewWindow(c, c)).toBe(true);
    expect(inViewWindow(c, { x: 1000 - 220, y: 500 })).toBe(true);
    expect(inViewWindow(c, { x: 1000 + 219, y: 500 })).toBe(true);
    expect(inViewWindow(c, { x: 1000 + 220, y: 500 })).toBe(false);
    expect(inViewWindow(c, { x: 1000 - 221, y: 500 })).toBe(false);
    expect(inViewWindow(c, { x: 1000, y: 500 - 220 })).toBe(true);
    expect(inViewWindow(c, { x: 1000, y: 500 + 220 })).toBe(false);
    expect(inViewWindow(c, { x: 1000 + 219, y: 500 - 220 })).toBe(true);
  });
  it('自定义半宽', () => {
    expect(inViewWindow(c, { x: 1099, y: 401 }, 100)).toBe(true);
    expect(inViewWindow(c, { x: 1100, y: 500 }, 100)).toBe(false);
    expect(inViewWindow(c, { x: 900, y: 400 }, 100)).toBe(true);
  });
});
