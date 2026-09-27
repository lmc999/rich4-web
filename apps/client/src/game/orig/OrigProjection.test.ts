// 原版投影（A6）：8 视角往返、包围盒、源像素取整；「精灵锚点相对底图」的相对误差 ≤ 2 px（用地图皮肤参数）。
// 本机有真实素材包（rich4-assets，不入库）时，另用台湾图皮肤的仿射与原版精确表核对（CI 没有素材包时跳过这一组）。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MapSkinV1 } from '@rich4/shared/assets';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../skin/testing/synthPack.globalSetup';
import { affineRelativeError, OrigExactModel, OrigProjection, snapPx, type ViewAffine } from './OrigProjection';
import { trigViews } from './testing/views';

/** render.md / projection-fit 公开的视角 0 拟合值（每格 → 每世界像素） */
const FIT_VIEW0: ViewAffine = {
  a: 36.012 / 32,
  b: -10.527 / 32,
  c: 14.864 / 32,
  d: 25.524 / 32,
  tx: -1.608,
  ty: -1.117,
};

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('OrigProjection', () => {
  const proj = new OrigProjection(trigViews(), { w: 2304, h: 2304 });

  it('8 视角 project / unproject 往返（误差 < 1e-9）', () => {
    const rnd = lcg(7);
    for (let v = 0; v < 8; v++) {
      for (let i = 0; i < 50; i++) {
        const w = { x: rnd() * 2304, y: rnd() * 2304 };
        const b = proj.project(w, v);
        const back = proj.unproject(b, v);
        expect(back.x).toBeCloseTo(w.x, 9);
        expect(back.y).toBeCloseTo(w.y, 9);
      }
    }
  });

  it('view+1 画面顺时针转 45°；rotate 取模 8；view setter 归一', () => {
    const p = new OrigProjection(trigViews(), { w: 100, h: 100 });
    // 世界 +x 在视角 0 指向右上（约 −16°），视角 2 指向右下
    const e0 = p.projectDelta(32, 0, 0);
    const e2 = p.projectDelta(32, 0, 2);
    expect(e0.x).toBeGreaterThan(0);
    expect(e0.y).toBeLessThan(0);
    expect(e2.y).toBeGreaterThan(0);
    expect(p.rotate(1)).toBe(1);
    expect(p.rotate(-2)).toBe(7);
    expect(p.rotate(9)).toBe(0);
    p.view = -1;
    expect(p.view).toBe(7);
  });

  it('bounds 包含四角投影，quad 按世界角顺序', () => {
    for (let v = 0; v < 8; v++) {
      const b = proj.bounds(undefined, v);
      for (const q of proj.quad({ x: 0, y: 0, w: 2304, h: 2304 }, v)) {
        expect(q.x).toBeGreaterThanOrEqual(b.x - 1e-9);
        expect(q.x).toBeLessThanOrEqual(b.x + b.w + 1e-9);
        expect(q.y).toBeGreaterThanOrEqual(b.y - 1e-9);
        expect(q.y).toBeLessThanOrEqual(b.y + b.h + 1e-9);
      }
    }
  });

  it('按源像素取整：-0 归一为 0', () => {
    expect(Object.is(snapPx(-0.2), 0)).toBe(true);
    expect(snapPx(1.5)).toBe(2);
    expect(proj.projectPx({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it('不可逆或视角数不对的仿射被拒绝', () => {
    expect(() => new OrigProjection(trigViews().slice(0, 7), { w: 1, h: 1 })).toThrow(RangeError);
    const bad = trigViews();
    bad[3] = { a: 1, b: 2, c: 2, d: 4, tx: 0, ty: 0 };
    expect(() => new OrigProjection(bad, { w: 1, h: 1 })).toThrow(RangeError);
  });

  it('精灵锚点相对底图的误差 ≤ 2 px（地面同一仿射连续变换、精灵按源像素取整：理论上 ≤ 0.71 px）', () => {
    const views = trigViews();
    views[0] = FIT_VIEW0;
    const p = new OrigProjection(views, { w: 2304, h: 2304 });
    const rnd = lcg(11);
    let max = 0;
    for (let v = 0; v < 8; v++) {
      for (let i = 0; i < 400; i++) {
        const w = { x: Math.round(rnd() * 2304), y: Math.round(rnd() * 2304) };
        max = Math.max(max, affineRelativeError(p, w, v));
      }
    }
    expect(max).toBeLessThanOrEqual(Math.SQRT1_2 + 1e-9);
    expect(max).toBeLessThanOrEqual(2);
  });
});

// ───────────────────────── 本机真实素材包（可选） ─────────────────────────

function localSkin(): MapSkinV1 | null {
  const dir = join(REPO_ROOT, 'rich4-assets', 'maps');
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((x) => /^taiwan\.skin\.[0-9a-f]{8}\.json$/.test(x));
  return f ? (JSON.parse(readFileSync(join(dir, f), 'utf8')) as MapSkinV1) : null;
}

const skin = localSkin();

describe.skipIf(skin === null)('台湾图皮肤（本机素材包）', () => {
  it('仿射参数：往返与相对误差 ≤ 2 px；原版精确表自身的锚点 − 底图平均误差 ≤ 2 px', () => {
    const s = skin!;
    const p = OrigProjection.fromSkin(s);
    const exact = s.projection.exact ? new OrigExactModel(s.projection.exact, s.projection.origin) : null;
    const rnd = lcg(3);
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < 300; i++) {
        const w = { x: 64 + Math.round(rnd() * 2176), y: 64 + Math.round(rnd() * 2176) };
        const back = p.unproject(p.project(w, v), v);
        expect(Math.hypot(back.x - w.x, back.y - w.y)).toBeLessThan(1e-6);
        expect(affineRelativeError(p, w, v)).toBeLessThanOrEqual(2);
        if (exact) {
          const cam = { x: w.x + Math.round((rnd() - 0.5) * 300), y: w.y + Math.round((rnd() - 0.5) * 300) };
          const o = exact.objectScreen(v, cam, w);
          const g = exact.groundScreen(v, cam, w);
          if (o && g) {
            sum += Math.hypot(o.x - g.x, o.y - g.y);
            n++;
          }
        }
      }
      if (exact && n > 0) expect(sum / n).toBeLessThanOrEqual(2);
    }
  });

  it('台湾节点 1 (1752,1871) 在各视角下往返一致', () => {
    const p = OrigProjection.fromSkin(skin!);
    for (let v = 0; v < 8; v++) {
      const b = p.projectPx({ x: 1752, y: 1871 }, v);
      const w = p.unproject(b, v);
      expect(Math.hypot(w.x - 1752, w.y - 1871)).toBeLessThan(1.2);
    }
  });
});
