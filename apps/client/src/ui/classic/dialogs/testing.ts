// 原版通用对话框与弹窗的测试工具（文件名含 testing，check-deps 视为测试代码）：与原版包同尺寸同锚点的假精灵表
// （A11 用到的全部 UI 条目）与假素材包客户端（精灵、掩膜与整图条目）。
import type { AssetEntry } from '@rich4/shared/assets';
import type { PackClient } from '../../../skin/pack/PackClient';
import type { SpriteSheet } from '../assets';
import { type FakeFrame, fakePackClient, fakeSceneSheets, fakeSheet } from '../common/testing';
import { VENUE_A_FRAMES } from '../venues/a/testing';

const rep = (n: number, f: FakeFrame): FakeFrame[] => Array.from({ length: n }, () => f);

/** A11 的精灵表：帧尺寸与锚点取原版值（本机素材包实测，见 tools/extract/src/assets/syntheticUi.ts 的 A11 段） */
export function a11FakeSheets(): Record<string, SpriteSheet> {
  const cursor: FakeFrame[] = rep(43, [31, 29, 15, 14]);
  cursor[27] = [30, 31, 10, 2];
  cursor[41] = [23, 23, 1, 1];
  const itemBar: FakeFrame[] = [
    [412, 180, 0, 0],
    [412, 180, 0, 0],
    ...rep(13, [36, 32, 18, 16]),
    ...rep(2, [80, 56, 0, 0]),
  ];
  const slot: FakeFrame[] = [
    [193, 183, 96, 98],
    [156, 183, 78, 98],
    [31, 108, 0, 0],
    [31, 72, 0, -35],
    ...rep(20, [38, 36, 0, 0]),
  ];
  const wheel: FakeFrame[] = [[75, 61, -6, 0], [87, 61, 0, 0], ...rep(12, [165, 165, 82, 82])];
  const monthly: FakeFrame[] = rep(83, [60, 40, 0, 0]);
  monthly[0] = [640, 480, 0, 0];
  monthly[2] = [278, 98, 139, 49];
  monthly[5] = [353, 450, 0, 0];
  monthly[19] = [186, 410, 0, 0];
  for (let f = 47; f < 83; f++) monthly[f] = [48, 66, 24, 33];
  const assets: FakeFrame[] = [
    ...rep(3, [640, 480, 0, 0]),
    [88, 33, 0, 0],
    [88, 32, 0, 0],
    [58, 19, 29, 9],
    [53, 18, 27, 9],
    ...rep(4, [30, 30, 0, 0]),
    [75, 33, 0, 0],
    [97, 40, 0, 0],
    ...rep(12, [42, 54, 21, 27]),
  ];
  const autoplay: FakeFrame[] = [
    [435, 355, 0, 0],
    [116, 86, 0, 0],
    [116, 86, 0, 0],
    [15, 15, 0, 0],
    [9, 20, 0, 0],
    [9, 20, 0, 0],
    ...rep(12, [70, 65, 35, 32]),
  ];
  const out: Record<string, SpriteSheet> = {
    ...fakeSceneSheets([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    'ui.cursor': fakeSheet('ui.cursor', cursor),
    'ui.itemBar': fakeSheet('ui.itemBar', itemBar),
    'ui.itemIcons': fakeSheet('ui.itemIcons', rep(13, [24, 20, 12, 10])),
    'ui.playerPicker': fakeSheet('ui.playerPicker', [
      [177, 97, 88, 48],
      [257, 97, 128, 48],
      [337, 97, 168, 48],
    ]),
    'portrait.face72': fakeSheet('portrait.face72', rep(12, [72, 72, 0, 0])),
    'ui.newsBoard': fakeSheet('ui.newsBoard', rep(2, [440, 480, 0, 0])),
    'ui.godSlot': fakeSheet('ui.godSlot', slot),
    'venue.monthly.screen': fakeSheet('venue.monthly.screen', monthly),
    'venue.assets.screen': fakeSheet('venue.assets.screen', assets),
    'ui.autoplay': fakeSheet('ui.autoplay', autoplay),
    'ui.saveLoad': fakeSheet('ui.saveLoad', [[555, 451, 0, 0], [555, 381, 0, 0], ...rep(5, [72, 72, 0, 0])]),
  };
  for (let i = 0; i < 4; i++) out[`ui.roulette.${i}`] = fakeSheet(`ui.roulette.${i}`, wheel);
  // 回合菜单的两个子页（场所组）：股市 Panel#75、公佈欄 Panel#73
  out['venue.stock.screen'] = fakeSheet('venue.stock.screen', VENUE_A_FRAMES['venue.stock.screen']!);
  out['venue.bulletin.screen'] = fakeSheet('venue.bulletin.screen', [
    [596, 348, 0, 0],
    [336, 416, 0, 0],
    [416, 416, 0, 0],
    ...rep(2, [412, 180, 0, 0]),
    [120, 60, 0, 0],
    [192, 224, 0, 0],
    [192, 256, 0, 0],
    [192, 288, 0, 0],
    ...rep(8, [72, 72, 0, 0]),
    [300, 90, 0, 0],
    [21, 21, 0, 0],
    [80, 32, 0, 0],
  ]);
  return out;
}

/** 假素材包里的整图键（卡片插画、新闻插图、命运插图） */
export function isImageKey(key: string): boolean {
  return /^(card\.\d+|illustration\.(news|fate)\.\d+)$/.test(key);
}

/**
 * 假素材包客户端：sprites 里的键为精灵条目、*.mask 为掩膜条目、卡片插画、新闻插图与命运插图为整图条目；其余返回 null。
 * 缺省可用 = a11FakeSheets 的全部键 + 计算器掩膜 + 全部卡片插画、新闻插图与命运插图。
 */
export function a11PackClient(usable?: Iterable<string>): PackClient & { asked: string[] } {
  const keys = new Set(
    usable ?? [
      ...Object.keys(a11FakeSheets()),
      'ui.numpad.mask',
      ...Array.from({ length: 30 }, (_, k) => `card.${k + 1}`),
      ...Array.from({ length: 36 }, (_, i) => `illustration.news.${i}`),
      ...Array.from({ length: 40 }, (_, i) => `illustration.fate.${i}`),
    ],
  );
  const base = fakePackClient([...keys].filter((k) => !isImageKey(k)));
  const usableEntry = base.usableEntry.bind(base);
  const client = base as PackClient & { asked: string[] };
  client.usableEntry = (key: string): AssetEntry | null => {
    if (isImageKey(key)) {
      base.asked.push(key);
      if (!keys.has(key)) return null;
      const card = key.startsWith('card.');
      const fate = key.startsWith('illustration.fate.');
      return {
        type: 'image',
        group: card ? 'card' : fate ? 'illustration.fate' : 'illustration.news',
        confidence: card || fate ? 'exe' : 'visual',
        src: [],
        file: `images/${key}.png`,
        w: card ? 165 : 388,
        h: card ? 256 : 251,
        transparency: 'opaque',
        anchor: null,
      } as unknown as AssetEntry;
    }
    return usableEntry(key);
  };
  return client;
}

/** A11 场景用到的全部精灵键（登记进假素材包） */
export const A11_SPRITE_KEYS: readonly string[] = Object.keys(a11FakeSheets());
