// 原版棋子的帧与方向（A7）：8 方向 × 8 视角 64 种组合的帧槽与画面朝向一致；姿态库选择与回退；确定性默认朝向。
import { actorFrame, buildingFrame, directionFromDelta, roadObjectFrame } from '@rich4/shared/assets';
import { describe, expect, it } from 'vitest';
import { OrigProjection } from './OrigProjection';
import {
  characterPose,
  defaultFacing,
  dirOfWorldStep,
  needsOverlay,
  PLAIN_POSE,
  sheetFrame,
  villainPose,
} from './poses';
import { trigViews } from './testing/views';

/** 方向槽 d 的世界单位向量（0 南 +y、2 东 +x、4 北、6 西；y 向下） */
function dirVec(d: number): { x: number; y: number } {
  const phi = ((d - 2) * 45 * Math.PI) / 180;
  return { x: Math.cos(phi), y: -Math.sin(phi) };
}

function angDiff(a: number, b: number): number {
  return Math.abs(((((a - b) % 360) + 540) % 360) - 180);
}

describe('帧槽与方向（64 种组合）', () => {
  const proj = new OrigProjection(trigViews(), { w: 2304, h: 2304 });
  const squash = 0.7086;

  it('方向槽与世界位移互逆（directionFromDelta）', () => {
    for (let d = 0; d < 8; d++) {
      const v = dirVec(d);
      expect(directionFromDelta(Math.round(v.x * 10), Math.round(v.y * 10))).toBe(d);
      expect(dirOfWorldStep({ x: 0, y: 0 }, { x: v.x * 32, y: v.y * 32 })).toBe(d);
    }
    expect(dirOfWorldStep({ x: 5, y: 5 }, { x: 5, y: 5 })).toBeNull();
  });

  it('帧槽 s = (8 − view + dir) & 7 画的都是同一个画面朝向：67.5° − 45°·s（压缩前精确，压缩后 < 22.5°）', () => {
    const seen = new Set<string>();
    for (let dir = 0; dir < 8; dir++) {
      for (let view = 0; view < 8; view++) {
        const s = actorFrame(dir, view, 1, 0);
        seen.add(`${dir},${view}`);
        expect(s).toBe((8 - view + dir) & 7);
        const w = dirVec(dir);
        const p = proj.projectDelta(w.x, w.y, view);
        const want = 67.5 - 45 * s;
        const unsquashed = (Math.atan2(p.y / squash, p.x) * 180) / Math.PI;
        const squashed = (Math.atan2(p.y, p.x) * 180) / Math.PI;
        expect(angDiff(unsquashed, want)).toBeLessThan(1e-6);
        expect(angDiff(squashed, want)).toBeLessThan(22.5);
        // 走姿库（每方向 9 帧）：帧号 = 槽 × 9 + anim
        expect(actorFrame(dir, view, 9, 4)).toBe(s * 9 + 4);
        expect(actorFrame(dir, view, 9, 13)).toBe(s * 9 + 4);
        // 路面物件与棋子同一规则；建筑用 (8 − (facing + view)) & 7
        expect(roadObjectFrame(dir, view)).toBe(s);
        expect(buildingFrame(dir, view)).toBe((8 - dir - view) & 7);
      }
    }
    expect(seen.size).toBe(64);
  });

  it('旋转视角：同一世界朝向的帧槽每档减 1（画面顺时针转 45°）', () => {
    for (let dir = 0; dir < 8; dir++) {
      for (let view = 0; view < 8; view++) {
        expect(actorFrame(dir, (view + 1) & 7, 1, 0)).toBe((actorFrame(dir, view, 1, 0) + 7) & 7);
      }
    }
  });

  it('sheetFrame：dirs=8 方向主序、dirs=1 按 anim 取模', () => {
    expect(sheetFrame({ dirs: 8, count: 72 }, 2, 0, 3)).toBe(2 * 9 + 3);
    expect(sheetFrame({ dirs: 8, count: 8 }, 5, 3, 7)).toBe(2);
    expect(sheetFrame({ dirs: 1, count: 6 }, 5, 3, 7)).toBe(1);
    expect(sheetFrame({ dirs: 1, count: 6 }, 0, 0, -1)).toBe(5);
  });
});

describe('姿态库选择', () => {
  it('步行：站 / 走 / 持骰', () => {
    expect(characterPose(3, 'stand', PLAIN_POSE).keys).toEqual(['char.3.stand']);
    expect(characterPose(3, 'walk', PLAIN_POSE).keys).toEqual(['char.3.walk', 'char.3.stand']);
    expect(characterPose(3, 'dice', PLAIN_POSE).keys).toEqual(['char.3.dice', 'char.3.stand']);
  });

  it('关押、乞丐、快艇、梦游优先于载具', () => {
    const s = { ...PLAIN_POSE, vehicle: 'car' as const };
    expect(characterPose(0, 'stand', { ...s, confined: 'jail' }).keys[0]).toBe('char.0.jail');
    expect(characterPose(0, 'stand', { ...s, confined: 'hospital' }).keys[0]).toBe('char.0.hospital');
    expect(characterPose(0, 'stand', { ...s, beggar: true }).keys[0]).toBe('char.0.beggar');
    expect(characterPose(0, 'walk', { ...s, boat: true }).keys[0]).toBe('char.0.boat.walk');
    expect(characterPose(0, 'walk', { ...s, sleepwalk: true }).keys[0]).toBe('char.0.sleepwalk.walk');
    expect(characterPose(0, 'dice', { ...s, sleepwalk: true }).keys[0]).toBe('char.0.sleepwalk.stand');
    expect(characterPose(0, 'walk', s).keys).toEqual([
      'char.0.car.walk',
      'char.0.car.stand',
      'char.0.walk',
      'char.0.stand',
    ]);
  });

  it('工程车（guess）回退到步行姿态并叠加程序化载具；机车条目可用时不叠加', () => {
    const eng = characterPose(7, 'walk', { ...PLAIN_POSE, vehicle: 'engineer' });
    expect(eng.keys[0]).toBe('char.7.engineer.walk');
    expect(needsOverlay(eng, 'char.7.walk')).toBe('engineer');
    expect(needsOverlay(eng, 'char.7.engineer.walk')).toBeNull();
    const moto = characterPose(7, 'stand', { ...PLAIN_POSE, vehicle: 'moto' });
    expect(needsOverlay(moto, 'char.7.moto.stand')).toBeNull();
    expect(needsOverlay(moto, null)).toBe('moto');
    expect(needsOverlay(characterPose(7, 'walk', PLAIN_POSE), 'char.7.walk')).toBeNull();
  });

  it('恶人：站 / 走 / 快艇', () => {
    expect(villainPose('thief', 'walk', false).keys).toEqual(['npc.villain.thief.walk', 'npc.villain.thief.stand']);
    expect(villainPose('spy', 'stand', true).keys[0]).toBe('npc.villain.spy.boat');
  });
});

describe('确定性默认朝向（reset / 快照之后）', () => {
  it('有来路时按来路的世界位移', () => {
    expect(defaultFacing(2, { x: 0, y: 0 }, { x: 32, y: 0 })).toBe(2);
    expect(defaultFacing(2, { x: 0, y: 0 }, { x: 0, y: -32 })).toBe(4);
  });

  it('没有来路时按座位哈希取偶数槽，所有客户端一致', () => {
    for (let seat = 0; seat < 8; seat++) {
      const f = defaultFacing(seat, null, null);
      expect(f % 2).toBe(0);
      expect(f).toBe(defaultFacing(seat, null, { x: 1, y: 1 }));
    }
  });
});
