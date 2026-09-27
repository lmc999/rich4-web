import { describe, expect, it } from 'vitest';
import { GfxError, type RgbaImage } from '../../src/gfx/errors';
import { blitRgba, composePages, type PackItem, type PackResult, packRects, sortPackItems } from '../../src/gfx/pack';

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GfxError);
    return (e as GfxError).code;
  }
  throw new Error('应抛 GfxError');
};

function items(n: number, seed = 1): PackItem[] {
  const out: PackItem[] = [];
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out.push({ key: `f${String(i).padStart(3, '0')}`, w: 8 + (x % 90), h: 8 + ((x >>> 8) % 70) });
  }
  return out;
}

function assertValid(res: PackResult, input: readonly PackItem[], pad: number, maxW = 2048, maxH = 2048): void {
  expect(res.placements.map((p) => p.key)).toEqual(input.map((i) => i.key).sort());
  for (const page of res.pages) {
    expect(page.w).toBeLessThanOrEqual(maxW);
    expect(page.h).toBeLessThanOrEqual(maxH);
    const its = page.items.filter((p) => p.w > 0 && p.h > 0);
    for (const p of its) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x + p.w).toBeLessThanOrEqual(page.w);
      expect(p.y + p.h).toBeLessThanOrEqual(page.h);
    }
    // 任意两个矩形之间至少 pad 像素空隙
    for (let i = 0; i < its.length; i++) {
      for (let j = i + 1; j < its.length; j++) {
        const a = its[i]!;
        const b = its[j]!;
        const apart =
          a.x + a.w + pad <= b.x || b.x + b.w + pad <= a.x || a.y + a.h + pad <= b.y || b.y + b.h + pad <= a.y;
        expect(apart, `${a.key} 与 ${b.key} 间隔不足`).toBe(true);
      }
    }
  }
  const byKey = new Map(input.map((i) => [i.key, i]));
  for (const p of res.placements) expect([p.w, p.h]).toEqual([byKey.get(p.key)!.w, byKey.get(p.key)!.h]);
}

describe('MaxRects 装箱', () => {
  it('单页：不重叠、留 1px 空隙、裁到包围盒，利用率合理', () => {
    const input = items(60);
    const res = packRects(input);
    expect(res.pages).toHaveLength(1);
    assertValid(res, input, 1);
    const page = res.pages[0]!;
    expect(page.w).toBe(Math.max(...page.items.map((p) => p.x + p.w)));
    expect(page.h).toBe(Math.max(...page.items.map((p) => p.y + p.h)));
    const area = input.reduce((s, i) => s + i.w * i.h, 0);
    expect(area / (page.w * page.h)).toBeGreaterThan(0.6);
  });

  it('确定性：与输入顺序无关，重复运行结果相同', () => {
    const input = items(40, 7);
    const a = packRects(input);
    const b = packRects([...input].reverse());
    const c = packRects(input);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(sortPackItems(input).map((i) => i.key)).toEqual(sortPackItems([...input].reverse()).map((i) => i.key));
  });

  it('超过页面上限时分页，每页不超过上限', () => {
    const input = items(80, 3);
    const res = packRects(input, { maxWidth: 256, maxHeight: 256 });
    expect(res.pages.length).toBeGreaterThan(1);
    assertValid(res, input, 1, 256, 256);
    expect(res.pages.map((p) => p.index)).toEqual([...res.pages.keys()]);
    for (const p of res.pages) for (const it of p.items) expect(it.page).toBe(p.index);
  });

  it('padding=0 可以紧贴；恰好填满', () => {
    const input: PackItem[] = [
      { key: 'a', w: 32, h: 32 },
      { key: 'b', w: 32, h: 32 },
      { key: 'c', w: 32, h: 32 },
      { key: 'd', w: 32, h: 32 },
    ];
    const res = packRects(input, { padding: 0, maxWidth: 64, maxHeight: 64 });
    expect(res.pages).toHaveLength(1);
    expect([res.pages[0]!.w, res.pages[0]!.h]).toEqual([64, 64]);
    assertValid(res, input, 0, 64, 64);
  });

  it('0 尺寸矩形放在第 0 页 (0,0)；空输入没有页', () => {
    const res = packRects([
      { key: 'z', w: 0, h: 5 },
      { key: 'a', w: 3, h: 3 },
    ]);
    expect(res.placements).toEqual([
      { key: 'a', page: 0, x: 0, y: 0, w: 3, h: 3 },
      { key: 'z', page: 0, x: 0, y: 0, w: 0, h: 5 },
    ]);
    expect(packRects([]).pages).toEqual([]);
    expect(packRects([{ key: 'e', w: 0, h: 0 }]).pages).toEqual([
      { index: 0, w: 1, h: 1, items: [{ key: 'e', page: 0, x: 0, y: 0, w: 0, h: 0 }] },
    ]);
  });

  it('错误：重复 key、过大、非法尺寸', () => {
    expect(
      code(() =>
        packRects([
          { key: 'a', w: 1, h: 1 },
          { key: 'a', w: 2, h: 2 },
        ]),
      ),
    ).toBe('E_PACK_DUP');
    expect(code(() => packRects([{ key: 'a', w: 2049, h: 1 }]))).toBe('E_PACK_TOO_LARGE');
    expect(code(() => packRects([{ key: 'a', w: 1.5, h: 1 }]))).toBe('E_PACK_SIZE');
  });

  it('composePages / blitRgba', () => {
    const img = (w: number, h: number, v: number): RgbaImage => ({ w, h, rgba: new Uint8Array(w * h * 4).fill(v) });
    const images = new Map([
      ['a', img(2, 2, 10)],
      ['b', img(3, 1, 20)],
    ]);
    const res = packRects([...images].map(([key, i]) => ({ key, w: i.w, h: i.h })));
    const [page] = composePages(res, images);
    for (const p of res.placements) {
      const v = images.get(p.key)!.rgba[0];
      expect(page!.rgba[(p.y * page!.w + p.x) * 4]).toBe(v);
    }
    expect(code(() => composePages(res, new Map()))).toBe('E_PACK_IMAGE');
    expect(code(() => blitRgba(img(2, 2, 0), img(3, 1, 0), 0, 0))).toBe('E_PACK_BLIT');
  });
});
