// 小游戏原版视图的帧号与摆放（纯函数；依据见 frames.ts 注释里的 exe 地址）
import { penguin, xicong } from '@rich4/shared/minigames';
import { describe, expect, it } from 'vitest';
import {
  BIG_SCORE_Y,
  balloonFrame,
  bigScoreLayout,
  CATCHER_POSE_FRAMES,
  catcherFrame,
  catcherPerDir,
  GOD_FRAMES,
  godFrame,
  lcdFrame,
  padDigits,
  penguinBuriedFrame,
  penguinDigFrame,
  penguinDirGroup,
  penguinPoseKey,
  penguinRevealKey,
  penguinWalkFrame,
  timeDigits,
  xicongItemKey,
  xicongItemScale,
  xicongTimeTenths,
} from './frames';
import { MG_SFX_SETS, origRequiredKeys, PENGUIN_REVEAL_SFX, resolveSfx, SFX_FALLBACK, sfxKey } from './keys';

describe('HUD 与大号分数', () => {
  it('时间框：十分之一秒按 %03d 再补 0；计数与得分补零、超位数夹到全 9', () => {
    expect(timeDigits(150)).toBe('1500');
    expect(timeDigits(7)).toBe('0070');
    expect(timeDigits(-3)).toBe('0000');
    // 回归：喜从天降 HUD 显示 timeLeft / 2 按整除向下取（原先向上取，奇数 tick 多显示 0.1 秒）
    expect([360, 359, 358, 1, 0, -2].map(xicongTimeTenths)).toEqual([180, 179, 179, 0, 0, 0]);
    expect(timeDigits(xicongTimeTenths(359))).toBe('1790');
    expect(padDigits(5, 2)).toBe('05');
    expect(padDigits(188, 3)).toBe('188');
    expect(padDigits(12345, 4)).toBe('9999');
    expect([...'0123456789'].map(lcdFrame)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('大号分数：以 320 为中心、间距 66、y = 150，帧 = 10 + 数字（0x4140a7）', () => {
    expect(bigScoreLayout(7)).toEqual([{ frame: 17, x: 320, y: BIG_SCORE_Y }]);
    const two = bigScoreLayout(42);
    expect(two.map((d) => d.frame)).toEqual([14, 12]);
    expect(two.map((d) => d.x)).toEqual([287, 353]);
    const three = bigScoreLayout(188);
    expect((three[0]!.x + three[2]!.x) / 2).toBe(320);
  });
});

describe('企鹅挖宝', () => {
  it('方向组：精灵方向序为下、右下、右、右上、上、左上、左、左下（sim 朝向 0 = 右）', () => {
    expect([2, 1, 0, 7, 6, 5, 4, 3].map(penguinDirGroup)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(penguinWalkFrame(2, 0)).toBe(0);
    expect(penguinWalkFrame(0, 3)).toBe(11);
    expect(penguinWalkFrame(3, 9)).toBe(31);
    expect(penguinDigFrame(2, penguin.DIG_TICKS)).toBe(0);
    expect(penguinDigFrame(4, 1)).toBe(6 * 4 + 3);
  });

  it('埋藏物露头 = 类型 + 3；揭晓动画 = 85 + 类型；姿势按 <40 / >55 分档', () => {
    expect([1, 2, 3, 4, 5].map(penguinBuriedFrame)).toEqual([4, 5, 6, 7, 8]);
    expect(penguinRevealKey(1)).toBe('mg.penguin.86');
    expect(penguinRevealKey(5)).toBe('mg.penguin.90');
    expect(penguinPoseKey(39)).toBe('mg.penguin.85');
    expect(penguinPoseKey(40)).toBeNull();
    expect(penguinPoseKey(55)).toBeNull();
    expect(penguinPoseKey(56)).toBe('mg.penguin.84');
  });

  it('揭晓音效（0x472ee1 表）：炸弹 15、金币 16、红蓝宝石 17、钻石 18', () => {
    expect(PENGUIN_REVEAL_SFX).toEqual([0, 15, 16, 17, 17, 18]);
  });
});

describe('七彩气球', () => {
  it('类型 0..11 → 图 1..12，爆开图 13', () => {
    expect(balloonFrame(0, false)).toBe(1);
    expect(balloonFrame(8, false)).toBe(9);
    expect(balloonFrame(11, false)).toBe(12);
    expect(balloonFrame(5, true)).toBe(13);
  });
});

describe('喜从天降', () => {
  it('财神帧表（0x472ea5）：初始（左端转身第 4 帧）面向右、结算停在正面图 9', () => {
    expect(GOD_FRAMES).toHaveLength(5);
    expect(godFrame(xicong.GOD_INIT_STATE, xicong.GOD_INIT_FRAME)).toBe(7);
    expect(godFrame(xicong.GOD_IDLE_STATE, xicong.GOD_IDLE_FRAME)).toBe(9);
    expect(godFrame(xicong.GOD_WALK_RIGHT, 5)).toBe(6);
    expect(godFrame(xicong.GOD_WALK_LEFT, 0)).toBe(12);
    // 行走段 frame 0..5，转身段 0..4 都在表内
    for (let st = 0; st <= 4; st++) for (let f = 0; f < 6; f++) expect(godFrame(st, f)).toBeLessThan(19);
  });

  it('接物者（0x4150b5 / 0x414a10）：每向 (帧数 − 5)/2 帧，被炸图4，结算表情 1/2/0/3', () => {
    expect(catcherPerDir(25)).toBe(10);
    expect(catcherPerDir(33)).toBe(14);
    expect(catcherPerDir(27)).toBe(11);
    const s = (catcherDir: number, hitBomb = false) => ({ catcherDir, hitBomb });
    expect(catcherFrame(25, s(0), 7, null)).toBe(0);
    expect(catcherFrame(25, s(1), 0, null)).toBe(5);
    expect(catcherFrame(25, s(1), 13, null)).toBe(5 + 3);
    expect(catcherFrame(25, s(2), 0, null)).toBe(15);
    expect(catcherFrame(33, s(2), 13, null)).toBe(5 + 14 + 13);
    expect(catcherFrame(25, s(2, true), 3, 1)).toBe(4);
    expect([0, 1, 2, 3].map((p) => catcherFrame(25, s(0), 0, p))).toEqual([...CATCHER_POSE_FRAMES]);
    expect(CATCHER_POSE_FRAMES).toEqual([1, 2, 0, 3]);
  });

  it('掉落物精灵与透视缩放', () => {
    expect([0, 1, 2, 3, 4].map(xicongItemKey)).toEqual([
      'mg.xicong.95',
      'mg.xicong.96',
      'mg.xicong.97',
      'mg.xicong.98',
      'mg.xicong.99',
    ]);
    expect(xicongItemScale(100)).toBe(0.5);
    expect(xicongItemScale(380)).toBe(1.5);
  });
});

describe('条目与音效', () => {
  it('必需条目：共用 HUD 与 READY；喜从天降要玩家角色的接物姿态', () => {
    expect(origRequiredKeys('penguin', null)).toContain('mg.penguin.83');
    expect(origRequiredKeys('balloon', null)).toEqual(['mg.common.hud', 'mg.ready', 'mg.balloon.screen']);
    expect(origRequiredKeys('xicong', null)).toBeNull();
    expect(origRequiredKeys('xicong', 11)).toContain('mg.xicong.char.11');
  });

  it('音效：素材包有 sfx.NNN 时用原版，否则 ZzFX 回退；各音效集都有回退', () => {
    expect(sfxKey(11)).toBe('sfx.011');
    expect(resolveSfx(null, 15)).toBe('zzfx.boom');
    const manifest = { entries: { 'sfx.015': { type: 'audio' } } } as never;
    expect(resolveSfx(manifest, 15)).toBe('sfx.015');
    for (const set of Object.values(MG_SFX_SETS)) for (const n of set) expect(SFX_FALLBACK[n]).toBeDefined();
  });
});
