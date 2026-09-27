// 经典画面（路线 A）的纯函数：舞台缩放与区域、日历网格与季节、资料栏四页数值、素材帧解析与掩膜、快捷键映射、GO 钮帧。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AtlasV1 } from '@rich4/shared/assets';
import { buildMapIndex, buildTestMap } from '@rich4/shared/data';
import { netWorth } from '@rich4/shared/engine';
import { afterEach, describe, expect, it } from 'vitest';
import type { PackClient } from '../../skin/pack/PackClient';
import { selfPlay } from '../../test/selfPlay';
import {
  bindClassicAssets,
  CLASSIC_SPRITES,
  diceFlicKey,
  ensureClassicImage,
  holidayArtKey,
  maskRegion,
  resetClassicAssetsForTest,
  sheetFromAtlases,
  useClassicAssets,
} from './assets';
import { diceFaceFrame } from './ClassicDice';
import { dayFrame, daysInMonth, monthFrame, monthGrid, seasonOf } from './calendar';
import { goFrame } from './GoButton';
import { hotkeyOf } from './keyboard';
import {
  computeClassicLayout,
  GUTTER_MIN,
  isIntegerScale,
  RAIL_FULL_MIN,
  REGION,
  stageToScreen,
  toolPoint,
} from './layout';
import { PROFILE_PAGES, profileNumbers, profileRows } from './profileStats';

describe('舞台缩放与区域', () => {
  it('1920×1080：scale 2.25 平滑，舞台 1440×1080 居中，两侧各 240 的整栏侧栏', () => {
    const b = computeClassicLayout(1920, 1080);
    expect(b.scale).toBeCloseTo(2.25);
    expect(b.pixelated).toBe(false);
    expect(b.stage).toEqual({ x: 240, y: 0, w: 1440, h: 1080 });
    expect(b.rails).toBe('full');
    expect(b.left).toEqual({ x: 0, y: 0, w: 240, h: 1080 });
    expect(b.right).toEqual({ x: 1680, y: 0, w: 240, h: 1080 });
    // 棋盘视窗 (0,40) 440×440 → 真实像素
    expect(b.board).toEqual({ x: 240, y: 90, w: 990, h: 990 });
  });

  it('2560×1440：整数倍 3 → 最近邻；侧栏 320', () => {
    const b = computeClassicLayout(2560, 1440);
    expect(b.scale).toBe(3);
    expect(b.pixelated).toBe(true);
    expect(b.rails).toBe('full');
    expect(b.left.w).toBe(320);
  });

  it('手机横屏 844×390：舞台 520×390，两侧 162 不够整栏 → 抽屉', () => {
    const b = computeClassicLayout(844, 390);
    expect(b.scale).toBeCloseTo(0.8125);
    expect(b.stage).toEqual({ x: 162, y: 0, w: 520, h: 390 });
    expect(b.rails).toBe('drawer');
    expect(b.left.w).toBe(162);
    expect(b.left.w).toBeLessThan(RAIL_FULL_MIN);
    expect(b.pixelated).toBe(false);
  });

  it('4:3 或更窄：两侧至少留抽屉按钮的边距（舞台随之缩小），letterbox 垂直居中', () => {
    const b = computeClassicLayout(1024, 768);
    expect(b.rails).toBe('drawer');
    expect(b.left.w).toBeGreaterThanOrEqual(GUTTER_MIN);
    expect(b.scale).toBeCloseTo((1024 - 2 * GUTTER_MIN) / 640);
    expect(b.stage.y).toBe(Math.round((768 - 480 * b.scale) / 2));
  });

  it('超宽屏：侧栏封顶，整体居中', () => {
    const b = computeClassicLayout(3440, 1080);
    expect(b.left.w).toBe(380);
    expect(b.left.x).toBe(Math.round((3440 - 1440 - 760) / 2));
    expect(b.right.x).toBe(b.stage.x + b.stage.w);
  });

  it('区域与工具列画点', () => {
    expect(REGION.toolbar).toEqual({ x: 0, y: 0, w: 440, h: 40 });
    expect(REGION.board).toEqual({ x: 0, y: 40, w: 440, h: 440 });
    expect(REGION.profile).toEqual({ x: 440, y: 0, w: 200, h: 280 });
    expect(REGION.calendar).toEqual({ x: 440, y: 280, w: 200, h: 200 });
    expect(toolPoint(0)).toEqual({ x: 20, y: 20 });
    expect(toolPoint(10)).toEqual({ x: 420, y: 20 });
    expect(stageToScreen({ stage: { x: 10, y: 20, w: 1280, h: 960 }, scale: 2 }, REGION.calendar)).toEqual({
      x: 890,
      y: 580,
      w: 400,
      h: 400,
    });
    expect(isIntegerScale(2)).toBe(true);
    expect(isIntegerScale(0.5)).toBe(false);
    expect(isIntegerScale(2.25)).toBe(false);
  });
});

describe('日历', () => {
  it('季节与底图帧', () => {
    expect([1, 3, 6, 9, 12].map(seasonOf)).toEqual([3, 0, 1, 2, 3]);
    expect(dayFrame(7)).toBe(1);
    expect(monthFrame(7)).toBe(5);
  });

  it('月历网格：1998-01-01 是星期四', () => {
    const g = monthGrid(19980101, 4);
    expect(g.firstWeekday).toBe(4);
    expect(g.days).toBe(31);
    expect(g.weeks[0]).toEqual([0, 0, 0, 0, 1, 2, 3]);
    expect(g.weeks.at(-1)).toEqual([25, 26, 27, 28, 29, 30, 31]);
    // 1998-02-14 星期六 → 2 月 1 日是星期日
    const f = monthGrid(19980214, 6);
    expect(f.firstWeekday).toBe(0);
    expect(f.days).toBe(28);
    expect(f.weeks.length).toBe(4);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
  });

  it('节日插画：只有台湾图，slot → illustration.holiday.<slot>', () => {
    expect(holidayArtKey('taiwan', 'h0')).toBe('illustration.holiday.0');
    expect(holidayArtKey('taiwan', 'h23')).toBe('illustration.holiday.23');
    expect(holidayArtKey('test', 'h0')).toBeNull();
    expect(holidayArtKey('taiwan', null)).toBeNull();
    expect(holidayArtKey('taiwan', 'x')).toBeNull();
  });
});

describe('资料栏四页', () => {
  const sp = selfPlay({ seed: 21, steps: 80 });
  const map = buildMapIndex(buildTestMap());

  it('每页三行，数值由 view 与地图算出（与引擎 netWorth 同口径）', () => {
    const view = sp.batches.at(-1)!.view;
    for (const p of view.players) {
      const n = profileNumbers(view, map, p.seat)!;
      expect(n.cash).toBe(p.cash);
      expect(n.deposit).toBe(p.deposit);
      expect(n.points).toBe(p.points);
      expect(n.loan).toBe(p.loan);
      expect(n.netWorth).toBe(netWorth(view, map, p.seat));
      expect(n.lots).toBe(
        view.lands.filter((l) => l.owner === p.seat).length + view.facilities.filter((f) => f.owner === p.seat).length,
      );
      // 总资产 = 现金 + 存款 − 贷款 + 股票 + 地产
      expect(n.cash + n.deposit - n.loan + n.stockValue + n.estateValue).toBe(n.netWorth);
      for (const page of PROFILE_PAGES) expect(profileRows(page, n)).toHaveLength(3);
      expect(profileRows('funds', n).map((r) => r.value)).toEqual([p.cash, p.deposit, n.netWorth]);
      expect(profileRows('other', n)[2]!.value).toBe(`${p.cardCount}/${p.items.reduce((a, b) => a + b, 0)}`);
    }
    expect(profileNumbers(view, map, 9 as never)).toBeNull();
  });
});

describe('素材帧与掩膜', () => {
  afterEach(() => resetClassicAssetsForTest());

  const atlas = {
    schema: 'rich4.atlas/1',
    frames: {
      'Panel#1/0': {
        frame: { x: 0, y: 42, w: 439, h: 40 },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: 439, h: 40 },
        sourceSize: { w: 439, h: 40 },
        anchor: { x: 0, y: 0 },
      },
      'Panel#1/1': {
        frame: { x: 110, y: 83, w: 19, h: 34 },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: 19, h: 34 },
        sourceSize: { w: 19, h: 34 },
        anchor: { x: 0.47, y: 0.5 },
      },
    },
    meta: {
      app: 'test',
      version: '1',
      image: 'p.png',
      format: 'RGBA8888',
      size: { w: 512, h: 256 },
      scale: '1',
      r4: { anchorsPx: { 'Panel#1/0': [0, 0], 'Panel#1/1': [9, 17] } },
    },
  } as unknown as AtlasV1;

  it('按条目帧序取图集帧，锚点用整数锚点；缺帧为 null；center 锚点取帧中心', () => {
    const s = sheetFromAtlases('ui.toolbar', { frames: { base: 'Panel#1', start: 0, count: 3 }, anchor: 'frame' }, [
      { atlas, url: '/pack/p.png' },
    ]);
    expect(s.frames[0]).toEqual({
      url: '/pack/p.png',
      x: 0,
      y: 42,
      w: 439,
      h: 40,
      ax: 0,
      ay: 0,
      sheetW: 512,
      sheetH: 256,
    });
    expect(s.frames[1]).toMatchObject({ ax: 9, ay: 17, w: 19, h: 34 });
    expect(s.frames[2]).toBeNull();
    const cs = sheetFromAtlases('x', { frames: { base: 'Panel#1', start: 1, count: 1 }, anchor: 'center' }, [
      { atlas, url: '/u' },
    ]);
    expect(cs.frames[0]).toMatchObject({ ax: 10, ay: 17 });
  });

  it('绑定素材包：预取 UI 精灵（条目缺失 → null 回退），整图按需取 URL，换包清空，解绑回退', async () => {
    const entries: Record<string, unknown> = {
      'ui.toolbar': {
        type: 'sprite',
        atlas: ['sprites/panel/1.json'],
        frames: { base: 'Panel#1', start: 0, count: 2 },
        anchor: 'frame',
      },
      'illustration.holiday.0': { type: 'image', file: 'images/data/4.png', w: 200, h: 200 },
    };
    const fake = {
      usableEntry: (k: string) => entries[k] ?? null,
      loadAtlas: async () => atlas,
      atlasImageUrl: () => '/pack/sprites/panel/1.abc.png',
      fileUrl: (lp: string) => `/pack/${lp.replace('.png', '.h8.png')}`,
    } as unknown as PackClient;
    bindClassicAssets(fake, 'p1');
    await expect.poll(() => Object.keys(useClassicAssets.getState().sprites).length).toBe(CLASSIC_SPRITES.length);
    const st = useClassicAssets.getState();
    expect(st.packId).toBe('p1');
    expect(st.sprites['ui.toolbar']!.frames[1]).toMatchObject({ url: '/pack/sprites/panel/1.abc.png', ax: 9, ay: 17 });
    expect(st.sprites['ui.sidebar']).toBeNull();
    expect(st.loadFlic).not.toBeNull();
    ensureClassicImage('illustration.holiday.0');
    ensureClassicImage('illustration.holiday.5');
    expect(useClassicAssets.getState().images).toEqual({
      'illustration.holiday.0': { url: '/pack/images/data/4.h8.png', w: 200, h: 200 },
      'illustration.holiday.5': null,
    });
    bindClassicAssets(fake, 'p2');
    expect(useClassicAssets.getState()).toMatchObject({ packId: 'p2', images: {}, masks: {} });
    bindClassicAssets(null, null);
    expect(useClassicAssets.getState()).toMatchObject({ packId: null, sprites: {}, loadFlic: null });
  });

  it('掩膜区号：越界为 0；滚骰 FLC 键按颗数夹到 1..3', () => {
    const m = { w: 2, h: 2, data: Uint8Array.from([0, 1, 2, 3]) };
    expect(maskRegion(m, 1.5, 0.2)).toBe(1);
    expect(maskRegion(m, 1, 1)).toBe(3);
    expect(maskRegion(m, -1, 0)).toBe(0);
    expect(maskRegion(m, 2, 0)).toBe(0);
    expect([0, 1, 2, 3, 4].map(diceFlicKey)).toEqual([
      'ui.dice.roll1',
      'ui.dice.roll1',
      'ui.dice.roll2',
      'ui.dice.roll3',
      'ui.dice.roll3',
    ]);
  });

  it('骰子定格面：第 i 颗用第 i 套角度；GO 钮帧：乌龟 4/5、禁止 2/3、常态 0/1', () => {
    expect(diceFaceFrame(0, 1)).toBe(0);
    expect(diceFaceFrame(1, 6)).toBe(11);
    expect(diceFaceFrame(2, 3)).toBe(14);
    expect(goFrame(true, null, false)).toBe(0);
    expect(goFrame(true, null, true)).toBe(1);
    expect(goFrame(false, null, false)).toBe(2);
    expect(goFrame(false, 'tortoise', true)).toBe(3);
    expect(goFrame(true, 'tortoise', false)).toBe(4);
    expect(goFrame(true, 'stay', true)).toBe(1);
  });
});

describe('快捷键', () => {
  it('空格前进、D 骰子数、< > 旋转、M 大地图', () => {
    expect(hotkeyOf(' ')).toBe('roll');
    expect(hotkeyOf('d')).toBe('dice');
    expect(hotkeyOf('D')).toBe('dice');
    expect(hotkeyOf('<')).toBe('rotateLeft');
    expect(hotkeyOf(',')).toBe('rotateLeft');
    expect(hotkeyOf('>')).toBe('rotateRight');
    expect(hotkeyOf('.')).toBe('rotateRight');
    expect(hotkeyOf('m')).toBe('bigMap');
    expect(hotkeyOf('x')).toBeNull();
  });
});

describe('样式守卫', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'classic.module.css'), 'utf8');
  const block = (sel: string): string => new RegExp(`\\${sel} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';

  it('安全区：.frame 用 inset 让出 env(safe-area-inset-*)（绝对定位按包含块的 padding box 解析，不理会 .root 的 padding）', () => {
    expect(block('.frame')).toMatch(/inset:\s*env\(safe-area-inset-top[^)]*\)\s*env\(safe-area-inset-right/);
    expect(block('.root')).not.toMatch(/safe-area/);
  });

  it('字体栈不用大陆字形的宋体（SimSun / STSong）', () => {
    expect(css).not.toMatch(/SimSun|STSong/);
  });

  it('触控热区：data-hit="wide" 时舞台钮补到 44px 以上（--hit 按舞台缩放折算）', () => {
    expect(css).toMatch(/--hit: calc\(46px \/ var\(--classic-scale, 1\)\)/);
    for (const sel of ['toolBtn', 'diceCount', 'calToggle', 'tabBtn']) {
      expect(css, sel).toMatch(new RegExp(`\\.frame\\[data-hit="wide"\\] \\.${sel}::before`));
    }
  });
});
