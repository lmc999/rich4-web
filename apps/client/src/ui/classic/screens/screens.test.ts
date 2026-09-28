// 原版标题 / 开局 / 选人画面的纯函数（client-unit）：皮肤判定矩阵、条目检查、几何（按钮热区、下拉框、头像格、手机横屏
// 触控目标）、走动预览、设置草稿的字段转换、片头地址、工具列紧凑排法的阈值。
import type { AssetEntry } from '@rich4/shared/assets';
import { describe, expect, it } from 'vitest';
import { defaultDraft } from '../../lobby/settingsDraft';
import { hitMinLogical } from '../common/stage';
import type { Rect } from '../layout';
import { COMPACT_TOOLS, COMPACT_W, compactToolbar, MORE_ROW_H, MORE_TOOLS, TOOLS } from '../Toolbar';
import { introUrl } from './IntroVideo';
import {
  COLUMN,
  COLUMN_EXIT,
  COLUMN_OK,
  fieldLabelRect,
  fieldRect,
  GRID,
  gridCell,
  PREVIEW,
  SCREEN_KEYS,
  SETUP_FIELDS,
  sidewalkKey,
  stageRow,
  TITLE_BAND,
  TITLE_BUTTONS,
  WALK_X0,
  WALK_X1,
  WIDE_PANEL,
  WIDE_ROW_H,
  walkerAt,
} from './layout';
import {
  FIELD_TEST_IDS,
  fieldSpec,
  mapOptions,
  ONLINE_FIELDS,
  SETUP_FIELD_KEYS,
  WIDE_FIELDS,
  withField,
} from './settingsFields';
import { decideScreens, type ScreensInput, screenKeysUsable } from './useClassicScreens';

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Rect, b: Rect): boolean =>
  a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

/** 手机横屏 844×390 的舞台倍率 */
const PHONE_SCALE = 0.8125;
const PHONE_HIT = 44 / PHONE_SCALE;

describe('皮肤判定', () => {
  const base: ScreensInput = {
    pref: 'auto',
    access: { mode: 'passcode', granted: true },
    pack: 'ready',
    resolution: { skin: 'original' },
    keysOk: true,
    timedOut: false,
  };

  it('素材包就绪、判定原版、条目齐全 → 原版画面', () => {
    expect(decideScreens(base)).toBe('classic');
    expect(decideScreens({ ...base, pref: 'original' })).toBe('classic');
    expect(decideScreens({ ...base, access: { mode: 'off', granted: false } })).toBe('classic');
  });

  it('设置为程序化、门禁未通过、条目缺失、判定程序化、没有素材包 → 程序化', () => {
    expect(decideScreens({ ...base, pref: 'procedural' })).toBe('procedural');
    expect(decideScreens({ ...base, access: { mode: 'passcode', granted: false } })).toBe('procedural');
    expect(decideScreens({ ...base, keysOk: false })).toBe('procedural');
    expect(decideScreens({ ...base, resolution: { skin: 'procedural' } })).toBe('procedural');
    expect(decideScreens({ ...base, pack: 'absent' })).toBe('procedural');
    expect(decideScreens({ ...base, pack: 'access-required' })).toBe('procedural');
  });

  it('发现中：pending；超时 → 程序化；门禁状态未知也先等', () => {
    expect(decideScreens({ ...base, pack: 'idle' })).toBe('pending');
    expect(decideScreens({ ...base, pack: 'loading' })).toBe('pending');
    expect(decideScreens({ ...base, pack: 'loading', access: null })).toBe('pending');
    expect(decideScreens({ ...base, pack: 'loading', timedOut: true })).toBe('procedural');
    // 设置为程序化时不等素材包
    expect(decideScreens({ ...base, pref: 'procedural', pack: 'idle' })).toBe('procedural');
  });

  it('条目检查：标题、开局部件、背景、头像与 36 段侧视走动，任一不可用即 false', () => {
    expect(SCREEN_KEYS).toContain('title.screen');
    expect(SCREEN_KEYS).toContain('title.setup.ui');
    expect(SCREEN_KEYS).toContain('title.setup.bg');
    expect(SCREEN_KEYS).toContain('portrait.face72');
    expect(SCREEN_KEYS.filter((k) => k.startsWith('title.sidewalk.'))).toHaveLength(36);
    expect(sidewalkKey(9, 'moto')).toBe('title.sidewalk.9.moto');
    const all = new Set(SCREEN_KEYS);
    const client = (keys: Set<string>) => ({
      usableEntry: (k: string) => (keys.has(k) ? ({ type: 'sprite' } as AssetEntry) : null),
    });
    expect(screenKeysUsable(client(all))).toBe(true);
    const missing = new Set(all);
    missing.delete('title.sidewalk.11.car');
    expect(screenKeysUsable(client(missing))).toBe(false);
    expect(screenKeysUsable(null)).toBe(false);
  });
});

describe('几何', () => {
  it('标题三钮：热区互不重叠、在按钮带之上、画点在热区内；按钮带四格互不重叠、高 ≥ 手机 44px', () => {
    const rects = TITLE_BUTTONS.map((b) => b.hit);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
      const b = TITLE_BUTTONS[i]!;
      expect(b.hit.y + b.hit.h).toBeLessThanOrEqual(TITLE_BAND.nickname.y);
      expect(b.x).toBeGreaterThan(b.hit.x);
      expect(b.x).toBeLessThan(b.hit.x + b.hit.w);
      expect(b.hit.h).toBeGreaterThanOrEqual(PHONE_HIT);
    }
    const band = Object.values(TITLE_BAND);
    for (let i = 0; i < band.length; i++) {
      expect(band[i]!.h).toBeGreaterThanOrEqual(PHONE_HIT);
      expect(band[i]!.w).toBeGreaterThanOrEqual(PHONE_HIT);
      expect(band[i]!.y + band[i]!.h).toBeLessThanOrEqual(480);
      for (let j = i + 1; j < band.length; j++) expect(overlaps(band[i]!, band[j]!)).toBe(false);
    }
  });

  it('竖栏：贴在右侧；关卡行、OK / EXIT、6 个下拉框都在竖栏内且互不重叠；OK / EXIT 热区高 ≥ 手机 44px', () => {
    expect(COLUMN.x + COLUMN.w).toBe(640);
    const col: Rect = { x: COLUMN.x, y: COLUMN.y, w: COLUMN.w, h: COLUMN.h };
    const rects: Rect[] = [
      ...[0, 1, 2, 3].map(stageRow),
      COLUMN_OK,
      COLUMN_EXIT,
      ...SETUP_FIELDS.map((f) => fieldRect(f.box)),
    ];
    for (const r of rects) expect(inside(r, col), JSON.stringify(r)).toBe(true);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(overlaps(rects[i]!, rects[j]!), `${JSON.stringify(rects[i])} × ${JSON.stringify(rects[j])}`).toBe(false);
      }
    }
    expect(COLUMN_OK.h).toBeGreaterThanOrEqual(PHONE_HIT);
    expect(COLUMN_EXIT.h).toBeGreaterThanOrEqual(PHONE_HIT);
    // 标签在白框左侧
    for (const f of SETUP_FIELDS) {
      const l = fieldLabelRect(f.box);
      expect(l.x + l.w).toBeLessThanOrEqual(fieldRect(f.box).x);
      expect(l.w).toBeGreaterThan(40);
    }
    expect(SETUP_FIELDS.map((f) => f.field)).toEqual([
      'aiCount',
      'initialFund',
      'vehicle',
      'tenure',
      'timeLimitDays',
      'winMultiple',
    ]);
  });

  it('头像格：12 格 6×2、间距 72、在头像格帧与画面之内、不与竖栏重叠；每格 ≥ 手机 44px', () => {
    const grid: Rect = { x: GRID.x, y: GRID.y, w: GRID.w, h: GRID.h };
    for (let id = 0; id < 12; id++) {
      const c = gridCell(id);
      expect(inside(c, grid)).toBe(true);
      expect(c.w * PHONE_SCALE).toBeGreaterThanOrEqual(44);
      expect(overlaps(c, { x: COLUMN.x, y: COLUMN.y, w: COLUMN.w, h: COLUMN.h })).toBe(false);
    }
    expect(gridCell(1).x - gridCell(0).x).toBe(72);
    expect(gridCell(6).y - gridCell(0).y).toBe(72);
    expect(gridCell(6).x).toBe(gridCell(0).x);
  });

  it('选人预览行：四个控件互不重叠、高 ≥ 手机 44px、在头像格之上', () => {
    const r = Object.values(PREVIEW);
    for (let i = 0; i < r.length; i++) {
      expect(r[i]!.h).toBeGreaterThanOrEqual(PHONE_HIT);
      expect(r[i]!.w).toBeGreaterThanOrEqual(PHONE_HIT);
      expect(r[i]!.y + r[i]!.h).toBeLessThan(GRID.y);
      for (let j = i + 1; j < r.length; j++) expect(overlaps(r[i]!, r[j]!)).toBe(false);
    }
  });

  it('手机横屏的设置面板：14 项 + 快速局按两列排下（计时档位带说明占满整行），行高 56（≥44px），在竖栏左侧', () => {
    expect(WIDE_ROW_H * PHONE_SCALE).toBeGreaterThanOrEqual(44);
    // 字段齐全、不重复：竖栏 6 项 + 联机设置
    const all = [...SETUP_FIELDS.map((f) => SETUP_FIELD_KEYS[f.field]), ...ONLINE_FIELDS];
    expect([...WIDE_FIELDS].sort()).toEqual([...all].sort());
    expect(new Set(WIDE_FIELDS).size).toBe(WIDE_FIELDS.length);
    // 占满整行的计时档位落在左列（前面偶数项），右列不留空格
    expect(WIDE_FIELDS.indexOf('timerPreset') % 2).toBe(0);
    const slots = WIDE_FIELDS.length + 1 + 1;
    const rows = Math.ceil(slots / 2);
    expect(rows).toBe(8);
    expect(rows * WIDE_ROW_H + 8).toBeLessThanOrEqual(WIDE_PANEL.h);
    expect(WIDE_PANEL.x + WIDE_PANEL.w).toBeLessThanOrEqual(COLUMN.x);
    expect(WIDE_PANEL.y + WIDE_PANEL.h).toBeLessThanOrEqual(480);
  });

  it('走动预览：从 WALK_X0 走到 WALK_X1 再折返（向左时翻转），帧号按时间循环', () => {
    expect(walkerAt(0, 20, 'walk')).toEqual({ x: WALK_X0, frame: 0, facingLeft: false });
    const span = WALK_X1 - WALK_X0;
    const toEnd = (span / 40) * 1000;
    expect(walkerAt(toEnd, 20, 'walk').x).toBe(WALK_X1);
    const back = walkerAt(toEnd + 1000, 20, 'walk');
    expect(back.facingLeft).toBe(true);
    expect(back.x).toBe(WALK_X1 - 40);
    expect(walkerAt(90 * 21, 20, 'walk').frame).toBe(1);
    expect(walkerAt(500, 0, 'car').frame).toBe(0);
    // 汽车比步行快
    expect(walkerAt(1000, 8, 'car').x).toBeGreaterThan(walkerAt(1000, 20, 'walk').x);
  });
});

describe('设置字段', () => {
  const t = (k: string, p?: Record<string, unknown>) => (p ? `${k}${JSON.stringify(p)}` : k);

  it('testid 与程序化 RoomSettingsFields 相同', () => {
    expect(FIELD_TEST_IDS).toMatchObject({
      mapId: 'set-map',
      aiCount: 'set-ai-count',
      initialFund: 'set-fund',
      timerPreset: 'set-timer',
      pacing: 'set-pacing',
      allowSpectators: 'set-spectators',
      visibility: 'set-visibility',
    });
    expect(new Set(Object.values(FIELD_TEST_IDS)).size).toBe(Object.keys(FIELD_TEST_IDS).length);
  });

  it('按选项的原始类型写回草稿：数字选项写数字、勾选框写布尔；非法值不改', () => {
    const d = defaultDraft('test');
    const fund = fieldSpec('initialFund', t, d.mapId, []);
    expect(withField(d, 'initialFund', '50000', fund).initialFund).toBe(50000);
    const ai = fieldSpec('aiCount', t, d.mapId, []);
    expect(withField(d, 'aiCount', '3', ai).aiCount).toBe(3);
    expect(withField(d, 'aiCount', '9', ai)).toBe(d);
    const pacing = fieldSpec('pacing', t, d.mapId, []);
    expect(withField(d, 'pacing', 'compact', pacing).pacing).toBe('compact');
    expect(withField(d, 'allowSpectators', false).allowSpectators).toBe(false);
    expect(withField({ ...d, allowSpectators: false }, 'allowSpectators', true).allowSpectators).toBe(true);
  });

  it('地图选项：目录里的地图；草稿的地图不在目录里时补在最前', () => {
    const maps = [
      { id: 'taiwan', mapHash: 'a' },
      { id: 'test', mapHash: 'b' },
    ];
    expect(mapOptions('test', maps)).toEqual(['taiwan', 'test']);
    expect(mapOptions('old', maps)).toEqual(['old', 'taiwan', 'test']);
  });
});

describe('片头', () => {
  const entry = (files: { mp4?: string; webm?: string }) =>
    ({
      type: 'video',
      group: 'video',
      confidence: 'exe',
      src: [],
      files,
      w: 640,
      h: 480,
      durationMs: 1000,
    }) as AssetEntry;
  const client = (e: AssetEntry | null) => ({
    usableEntry: (k: string) => (k === 'video.start' ? e : null),
    fileUrl: (lp: string) => `/pack/${lp}`,
  });

  it('按浏览器能力挑 mp4 / webm；条目不可用时没有片头', () => {
    const both = entry({ mp4: 'video/start.mp4', webm: 'video/start.webm' });
    expect(introUrl(client(both), (m) => (m === 'video/mp4' ? 'probably' : ''))).toBe('/pack/video/start.mp4');
    expect(introUrl(client(both), (m) => (m === 'video/webm' ? 'maybe' : ''))).toBe('/pack/video/start.webm');
    expect(introUrl(client(entry({ webm: 'video/start.webm' })), () => '')).toBe('/pack/video/start.webm');
    expect(introUrl(client(null))).toBeNull();
    expect(introUrl(null)).toBeNull();
  });
});

describe('工具列紧凑排法（手机横屏触控目标）', () => {
  it('40 宽的钮不足 44 CSS 像素时改用紧凑排法：7 钮 + 更多，每格 ≥44px；其余 4 钮收进菜单，菜单行高 ≥44px', () => {
    expect(compactToolbar(PHONE_SCALE)).toBe(true);
    expect(compactToolbar(1)).toBe(true);
    expect(compactToolbar(1.1)).toBe(false);
    expect(compactToolbar(2.25)).toBe(false);
    expect(COMPACT_TOOLS).toHaveLength(7);
    expect(COMPACT_W * PHONE_SCALE).toBeGreaterThanOrEqual(44);
    expect(MORE_ROW_H * PHONE_SCALE).toBeGreaterThanOrEqual(44);
    expect([...COMPACT_TOOLS, ...MORE_TOOLS].sort()).toEqual([...TOOLS].sort());
    expect(MORE_TOOLS).toEqual(['settings', 'load', 'save', 'board']);
    // 热区高度按 --hit 向下补（46 CSS 像素折成逻辑像素）
    expect(hitMinLogical(PHONE_SCALE) * PHONE_SCALE).toBeGreaterThanOrEqual(44);
  });
});
