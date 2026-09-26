import { describe, expect, it } from 'vitest';
// 与 shared 的角色 / 神明编号表对齐（shared/data 入口尚未导出 tables/ids，测试里直接引用源码）
import {
  GOD_KEYS,
  CHARACTER_KEYS as SHARED_CHARACTER_KEYS,
} from '../../../../../../packages/shared/src/data/tables/ids';
import { atlasLayout, frameKey } from './atlas';
import { CHARACTER_KEYS, CHARACTERS, characterByIndex, GOD_LOOKS } from './defs';
import { FACINGS, limbEnd, POSE_SPECS, POSES, SKELETONS, VIEW_H, VIEW_W } from './rig';
import { characterSvg, godPlaceholderSvg, portraitSvg, svgDataUrl } from './svg';

/** 极简 XML 标签配平检查（足以发现拼接错误） */
function balanced(svg: string): boolean {
  const stack: string[] = [];
  const re = /<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g;
  for (const m of svg.matchAll(re)) {
    const [, close, name, self] = m;
    if (self) continue;
    if (close) {
      if (stack.pop() !== name) return false;
    } else stack.push(name!);
  }
  return stack.length === 0;
}

describe('角色配置', () => {
  it('12 个角色的键与 shared CHARACTER_KEYS 一一对应（按原版角色号）', () => {
    expect(CHARACTERS).toHaveLength(12);
    CHARACTERS.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(c.key).toBe(SHARED_CHARACTER_KEYS[i as keyof typeof SHARED_CHARACTER_KEYS]);
    });
    expect(new Set(CHARACTER_KEYS).size).toBe(12);
    expect(characterByIndex(9).key).toBe('sunXiaomei');
  });

  it('神明占位与 shared GOD_KEYS 一致', () => {
    expect(GOD_LOOKS.map((g) => g.key).sort()).toEqual(Object.values(GOD_KEYS).sort());
  });
});

describe('characterSvg', () => {
  it('12 角色 × 11 姿势 × 2 朝向都生成合法 SVG', () => {
    for (const c of CHARACTERS) {
      for (const pose of POSES) {
        for (const facing of FACINGS) {
          const svg = characterSvg(c, pose, facing);
          expect(svg.startsWith('<svg')).toBe(true);
          expect(svg).toContain(`viewBox="0 0 ${VIEW_W} ${VIEW_H}"`);
          expect(svg, `${c.key}/${pose}/${facing}`).not.toMatch(/NaN|undefined|Infinity/);
          expect(balanced(svg), `${c.key}/${pose}/${facing}`).toBe(true);
          // 统一描边色
          expect(svg).toContain('#3A2A1A');
        }
      }
    }
  });

  it('不同角色、不同姿势、正背面的图各不相同', () => {
    const idle = new Set(CHARACTERS.map((c) => characterSvg(c, 'idle0', 'front')));
    expect(idle.size).toBe(12);
    const c = CHARACTERS[0]!;
    const poses = new Set(POSES.map((p) => characterSvg(c, p, 'front')));
    expect(poses.size).toBe(POSES.length);
    expect(characterSvg(c, 'idle0', 'front')).not.toBe(characterSvg(c, 'idle0', 'back'));
  });

  it('姿势表：欢呼双臂上举、行走左右交替抬腿', () => {
    expect(POSE_SPECS.cheer.armL).toBeGreaterThan(90);
    expect(POSE_SPECS.cheer.armR).toBeLessThan(-90);
    expect(POSE_SPECS.walk0.liftL).toBeGreaterThan(0);
    expect(POSE_SPECS.walk2.liftR).toBeGreaterThan(0);
    expect(POSE_SPECS.sleep.fx).toBe('zzz');
  });

  it('limbEnd：0° 竖直向下，正角向左', () => {
    const d = limbEnd(0, 0, 0, 10);
    expect(d.x).toBeCloseTo(0, 9);
    expect(d.y).toBeCloseTo(10, 9);
    expect(limbEnd(0, 0, 90, 10).x).toBeCloseTo(-10, 9);
  });

  it('骨架：脚底不超出画布，头在身体之上', () => {
    for (const sk of Object.values(SKELETONS)) {
      expect(sk.hipY + sk.legLen).toBeLessThanOrEqual(VIEW_H);
      expect(sk.headCy + sk.headR * 0.95).toBeLessThanOrEqual(sk.torsoTop + 4);
    }
  });
});

describe('头像、神明、图集布局', () => {
  it('头像与神明占位为合法 SVG', () => {
    for (const c of CHARACTERS) {
      for (const e of ['normal', 'happy', 'sad', 'shock'] as const) {
        const s = portraitSvg(c, e);
        expect(s).toContain('viewBox="0 0 256 256"');
        expect(balanced(s)).toBe(true);
        expect(s).not.toMatch(/NaN|undefined/);
      }
    }
    for (const g of GOD_LOOKS) {
      const s = godPlaceholderSvg(g);
      expect(balanced(s)).toBe(true);
      expect(s).toContain(g.symbol);
    }
    expect(svgDataUrl('<svg/>')).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E');
  });

  it('图集布局：22 帧不重叠且落在 2048 宽内', () => {
    for (const scale of [1, 2] as const) {
      const l = atlasLayout(scale);
      expect(l.frames).toHaveLength(POSES.length * FACINGS.length);
      expect(l.cols * VIEW_W * scale).toBeLessThanOrEqual(2048);
      const keys = new Set(l.frames.map((f) => `${f.x},${f.y}`));
      expect(keys.size).toBe(l.frames.length);
      for (const f of l.frames) expect(f.y / VIEW_H < l.rows).toBe(true);
    }
    expect(frameKey('danny', 'walk1', 'back')).toBe('danny/walk1/back');
  });
});
