// 原版小地图（A6）：登记表、布局换算（棋盘坐标 ↔ 小地图像素往返、随视角变化）、MiniMapPainter 命中登记时改用原版画法。
import { buildTestMap } from '@rich4/shared/data';
import { afterEach, describe, expect, it } from 'vitest';
import { OrigProjection } from '../orig/OrigProjection';
import { trigViews } from '../orig/testing/views';
import { MiniMapPainter, miniToWorld, worldToMini } from './MiniMapPainter';
import { type OrigMiniMapSource, origMiniLayout, origMiniMapFor, registerOrigMiniMap } from './OrigMiniMap';

function fakeCtx() {
  const calls: string[] = [];
  const ctx = {
    clearRect: () => calls.push('clear'),
    beginPath: () => calls.push('begin'),
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    fill: () => calls.push('fill'),
    stroke: () => calls.push('stroke'),
    arc: () => calls.push('arc'),
    fillRect: () => calls.push('fillRect'),
    save: () => {},
    restore: () => {},
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter' as CanvasLineJoin,
  };
  return { ctx, calls };
}

const def = buildTestMap();
const world = { w: def.grid.w * 32, h: def.grid.h * 32 };

function source(proj: OrigProjection): OrigMiniMapSource {
  return {
    def,
    world,
    image: null,
    view: () => proj.view,
    toWorld: (p) => proj.unproject(p),
    toBoard: (p) => proj.project(p),
    tileWorld: (id) => def.tiles.find((t) => t.id === id)?.world ?? null,
    lotWorld: (id) => [...def.lots, ...def.companies].find((l) => l.id === id)?.world ?? null,
    seatColor: (s) => [0xff0000, 0x00ff00, 0x0000ff, 0xffff00][s] ?? 0xffffff,
  };
}

let off: (() => void) | null = null;
afterEach(() => {
  off?.();
  off = null;
});

describe('原版小地图', () => {
  it('布局：棋盘坐标 → 小地图 → 棋盘坐标 往返（8 视角），世界等比放进画布', () => {
    const proj = new OrigProjection(trigViews(), world);
    const src = source(proj);
    for (let v = 0; v < 8; v++) {
      proj.view = v;
      const L = origMiniLayout(src, 200, 160);
      expect(L.scale).toBeCloseTo(Math.min(196 / world.w, 156 / world.h));
      const board = proj.project({ x: 100, y: 80 });
      const mini = L.toMini(board);
      expect(mini.x).toBeCloseTo(100 * L.scale + L.padX);
      expect(mini.y).toBeCloseTo(80 * L.scale + L.padY);
      const back = L.toWorld(mini);
      expect(back.x).toBeCloseTo(board.x, 6);
      expect(back.y).toBeCloseTo(board.y, 6);
      // MiniMapPainter 的 worldToMini / miniToWorld 走自定义换算
      expect(worldToMini(L, board)).toEqual(mini);
      expect(miniToWorld(L, mini).x).toBeCloseTo(board.x, 6);
    }
  });

  it('登记后 MiniMapPainter 改用原版画法与换算；撤销后回到程序化', () => {
    const proj = new OrigProjection(trigViews(), world);
    const { ctx, calls } = fakeCtx();
    const painter = new MiniMapPainter(ctx as never, def, 0, { w: 240, h: 160 });
    const proceduralLayout = painter.layout;
    expect(proceduralLayout.toMini).toBeUndefined();
    expect(origMiniMapFor(def)).toBeNull();
    off = registerOrigMiniMap(source(proj));
    expect(origMiniMapFor(structuredClone(def))).not.toBeNull();
    expect(painter.layout.toMini).toBeTypeOf('function');
    const vp = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 40 },
    ];
    painter.paint({ owners: { L1: 0, L2: null }, players: [{ seat: 1, tile: 1 }], viewport: vp });
    // 示意图（没有缩略图）：底色 + 连线 + 地块方块 + 玩家圆点 + 视口框
    expect(calls).toContain('fillRect');
    expect(calls).toContain('arc');
    expect(calls.filter((c) => c === 'stroke').length).toBeGreaterThan(1);
    off();
    off = null;
    expect(painter.layout).toBe(proceduralLayout);
  });
});
