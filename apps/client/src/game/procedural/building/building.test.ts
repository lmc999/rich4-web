import { describe, expect, it } from 'vitest';
import { type BuildingSpec, buildingKey, clampLevel } from './generate';
import { boxFaces, facePoint, iso3, leftFaceFrame, rightFaceFrame, shade } from './geometry';
import { FACILITY_FLOORS, FACILITY_MAX_LEVEL, FACILITY_STYLES, HOUSE_LEVELS, MAX_HOUSE_LEVEL, PALETTE } from './styles';

describe('几何', () => {
  it('iso3：z 向上（屏幕 y 减小）', () => {
    expect(iso3(0, 0, 10)).toEqual({ x: 0, y: -10 });
    expect(iso3(1, 0)).toEqual({ x: 64, y: 32 });
  });

  it('盒子三面：顶面整体高出地面 h，左面朝 +y、右面朝 +x', () => {
    const f = boxFaces(1, 1, 40);
    for (const p of f.top) expect(p.y).toBeLessThan(40);
    // 左面底边 = W→S 地面角，右面底边 = S→E
    expect(f.left[0]).toEqual(iso3(-0.5, 0.5));
    expect(f.left[1]).toEqual(iso3(0.5, 0.5));
    expect(f.right[0]).toEqual(iso3(0.5, 0.5));
    expect(f.right[1]).toEqual(iso3(0.5, -0.5));
    expect(f.top[0]!.y).toBe(iso3(-0.5, -0.5).y - 40);
  });

  it('面坐标：u 沿底边、v 向上', () => {
    const lf = leftFaceFrame(1, 1, 0, 30);
    expect(facePoint(lf, 0, 0)).toEqual(iso3(-0.5, 0.5));
    expect(facePoint(lf, 1, 1)).toEqual(iso3(0.5, 0.5, 30));
    const rf = rightFaceFrame(2, 1, 10, 20);
    expect(facePoint(rf, 0.5, 0.5).y).toBeCloseTo((iso3(1, 0.5).y + iso3(1, -0.5).y) / 2 - 15, 9);
  });

  it('shade 夹在 0..255', () => {
    expect(shade(0xffffff, 2)).toBe(0xffffff);
    expect(shade(0x808080, 0.5)).toBe(0x404040);
    expect(shade(PALETTE.red, 0)).toBe(0);
  });
});

describe('外观表与键', () => {
  it('住宅等级楼层单调递增，0 级为空地', () => {
    expect(HOUSE_LEVELS[0]!.floors).toBe(0);
    for (let i = 1; i <= MAX_HOUSE_LEVEL; i++)
      expect(HOUSE_LEVELS[i]!.floors).toBeGreaterThan(HOUSE_LEVELS[i - 1]!.floors);
    expect(HOUSE_LEVELS.map((l) => l.floors)).toEqual([0, 1, 2, 3, 5, 8]);
  });

  it('设施楼层表覆盖到最高等级；商场/旅馆 1–5 级为 2/3/4/6/8 层', () => {
    for (const s of FACILITY_STYLES) expect(FACILITY_FLOORS[s].length).toBeGreaterThan(FACILITY_MAX_LEVEL[s]);
    expect(FACILITY_FLOORS.mall.slice(1)).toEqual([2, 3, 4, 6, 8]);
    expect(FACILITY_FLOORS.hotel.slice(1)).toEqual([2, 3, 4, 6, 8]);
  });

  it('clampLevel', () => {
    expect(clampLevel('house', 9)).toBe(5);
    expect(clampLevel('house', -1)).toBe(0);
    expect(clampLevel('facility:gas', 3)).toBe(1);
    expect(clampLevel('landmark:bank', 3)).toBe(0);
  });

  it('buildingKey 区分每个影响外观的字段', () => {
    const base: BuildingSpec = { kind: 'house', level: 2, w: 1, d: 1, owner: 0, variant: 1, door: 'left' };
    const variants: BuildingSpec[] = [
      base,
      { ...base, level: 3 },
      { ...base, w: 2 },
      { ...base, owner: 1 },
      { ...base, owner: null },
      { ...base, variant: 2 },
      { ...base, door: 'right' },
      { ...base, sign: 'x' },
      { ...base, accent: 0xff0000 },
      { ...base, kind: 'facility:hotel' },
    ];
    expect(new Set(variants.map(buildingKey)).size).toBe(variants.length);
    expect(buildingKey({ ...base })).toBe(buildingKey(base));
  });
});
