import { describe, expect, it } from 'vitest';
import { type LandItem, placeLands, wantCellOf } from '../../src/map/geometry/placeLands';
import { type Cell, ck, GeoIssues, manhattan, Occupancy } from '../../src/map/geometry/types';

/**
 * 住宅地放宽只针对拥挤的地块（data-pipeline.md §8.2 第 6 步）：
 * 严格候选 = 前沿格 4-邻里空闲且距期望格 ≤ 2 的格；指派不可行时逐轮只放宽没分到格的地块，
 * I_LAND_FAR 只列最终距期望格超过 2 的地块。坐标全部是合成的。
 */

function ctxOf(tiles: Record<number, [number, number]>, blocked: [number, number][] = []) {
  const cells = new Map(Object.entries(tiles).map(([k, v]) => [Number(k), { x: v[0], y: v[1] }]));
  const occ = new Occupancy();
  for (const [id, c] of cells) occ.claim(c, { kind: 'tile', id: String(id) });
  for (const [x, y] of blocked) occ.claim({ x, y }, { kind: 'road', id: `${x},${y}` });
  return { cells, occ, avoid: new Set<string>(), issues: new GeoIssues() };
}

/** 横街 1..4（y=0），住宅地都在北侧 */
const street = (): LandItem[] =>
  [1, 2, 3, 4].map((id) => ({ id: `L${id}`, fronts: [id], want: { x: id - 1, y: -1 }, facing: 0 }));
const TILES: Record<number, [number, number]> = { 1: [0, 0], 2: [1, 0], 3: [2, 0], 4: [3, 0] };

const info = (ctx: ReturnType<typeof ctxOf>, code: string) => ctx.issues.list.filter((i) => i.code === code);
const far = (lands: readonly LandItem[], rects: Map<string, { x: number; y: number }>) =>
  lands.filter((l) => manhattan(rects.get(l.id)!, wantCellOf(l.want)) > 2).map((l) => l.id);

describe('placeLands 放宽只针对拥挤地块', () => {
  it('没有拥挤：严格指派可行，不放宽、没有 I_LANDS_RELAXED / I_LAND_FAR', () => {
    const ctx = ctxOf(TILES);
    const r = placeLands(street(), {}, ctx, 'identity');
    expect(r.relaxed).toEqual([]);
    expect(info(ctx, 'I_LANDS_RELAXED')).toEqual([]);
    expect(info(ctx, 'I_LAND_FAR')).toEqual([]);
    for (const id of [1, 2, 3, 4]) expect(r.rects.get(`L${id}`)).toEqual({ x: id - 1, y: -1, w: 1, h: 1 });
  });

  it('两块地争前沿格 1 唯一的严格候选：只放宽其中一块，I_LAND_FAR 只列它；其余地块不受影响', () => {
    // L1 与 L5 的期望格都在 (0,-2)，前沿格 1 周围只有 (0,-1) 距期望 ≤ 2，(-1,0)、(0,1) 距 3
    const lands = street();
    lands[0] = { ...lands[0]!, want: { x: 0, y: -2 } };
    lands.push({ id: 'L5', fronts: [1], want: { x: 0, y: -2 }, facing: 0 });
    const ctx = ctxOf(TILES);
    const r = placeLands(lands, {}, ctx, 'identity');
    expect(info(ctx, 'E_LOT_NO_CELL')).toEqual([]);
    expect(info(ctx, 'I_LANDS_RELAXED')).toHaveLength(1);
    expect(r.relaxed).toHaveLength(1);
    expect(['L1', 'L5']).toContain(r.relaxed[0]);
    for (const id of ['L2', 'L3', 'L4']) expect(r.relaxed).not.toContain(id);
    const farIds = far(lands, r.rects);
    expect(farIds).toEqual(r.relaxed);
    expect(info(ctx, 'I_LAND_FAR').map((i) => i.msg)).toEqual([`住宅地 ${farIds[0]} 距期望格超过 2 格（候选已放宽）`]);
    // 被放宽的地块仍与前沿格 4-相邻，且各地块不重叠
    const cells = [...r.rects.values()].map((c) => ck(c));
    expect(new Set(cells).size).toBe(cells.length);
    const got = r.rects.get(r.relaxed[0]!)!;
    expect(manhattan(got, { x: 0, y: 0 })).toBe(1);
  });

  it('没分到格的地块已放宽仍无解时，再放宽与它争格的地块；放宽了但落在 2 格内的不进 I_LAND_FAR', () => {
    // 前沿 1 (0,0) 周围只剩 (0,-1)；前沿 5 (0,-2) 周围剩 (0,-1) 与 (-1,-2)。
    // L1 期望 (0,-3)：(0,-1) 距 2（严格候选，代价高）；L5 期望 (1,-1)：(0,-1) 距 1，(-1,-2) 距 3（不是严格候选）。
    // 第 1 轮 L1 没分到格 → 放宽 L1（没有新格）；第 2 轮仍是 L1 → 再放宽与它争 (0,-1) 的 L5 → L5 退到 (-1,-2)。
    const tiles: Record<number, [number, number]> = { ...TILES, 5: [0, -2] };
    const lands: LandItem[] = [
      { id: 'L1', fronts: [1], want: { x: 0, y: -3 }, facing: 0 },
      { id: 'L5', fronts: [5], want: { x: 1, y: -1 }, facing: 0 },
    ];
    const ctx = ctxOf(tiles, [
      [-1, 0],
      [0, 1],
      [1, -2],
      [0, -3],
    ]);
    const r = placeLands(lands, {}, ctx, 'identity');
    expect(info(ctx, 'E_LOT_NO_CELL')).toEqual([]);
    expect(info(ctx, 'I_LANDS_RELAXED')).toHaveLength(1);
    expect(r.rects.get('L1')).toEqual({ x: 0, y: -1, w: 1, h: 1 });
    expect(r.rects.get('L5')).toEqual({ x: -1, y: -2, w: 1, h: 1 });
    expect(r.relaxed).toEqual(['L1', 'L5']);
    expect(far(lands, r.rects)).toEqual(['L5']);
    expect(info(ctx, 'I_LAND_FAR').map((i) => i.msg)).toEqual(['住宅地 L5 距期望格超过 2 格（候选已放宽）']);
  });

  it('严格候选为空的地块直接放宽（不触发 I_LANDS_RELAXED），落点距期望超过 2 才进 I_LAND_FAR', () => {
    const lands = street();
    lands.push({ id: 'L9', fronts: [4], want: { x: 9, y: 9 }, facing: 0 });
    const ctx = ctxOf(TILES);
    const r = placeLands(lands, {}, ctx, 'identity');
    expect(info(ctx, 'I_LANDS_RELAXED')).toEqual([]);
    expect(r.relaxed).toEqual(['L9']);
    expect(far(lands, r.rects)).toEqual(['L9']);
    expect(info(ctx, 'I_LAND_FAR')).toHaveLength(1);
    const c: Cell = r.rects.get('L9')!;
    expect(manhattan(c, { x: 3, y: 0 })).toBe(1);
  });
});
