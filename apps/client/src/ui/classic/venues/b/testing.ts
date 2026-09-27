// 第二组场所屏的测试工具（文件名含 testing，check-deps 视为测试代码）：与原版包同帧数、同尺寸、同锚点的假精灵表。
import type { SpriteSheet } from '../../assets';
import { type FakeFrame, fakeSceneSheets, fakeSheet } from '../../common/testing';
import { AUCTION_SHEET, chibiSheet } from './auctionLayout';
import { HOSPITAL_SHEET, JAIL_SHEET, VILLAIN_SHEET } from './bailLayout';
import { BULLETIN_SHEET } from './bulletinLayout';
import { MAGIC_SHEET } from './magicLayout';

const rep = (n: number, f: FakeFrame): FakeFrame[] => Array.from({ length: n }, () => f);

/** 逻辑键 → 各帧 [w, h, ax, ay]（Panel#18/26/73/63/64/65 与 12 个 Q 版小人的待机帧） */
export const VENUE_B_FRAMES: Readonly<Record<string, readonly FakeFrame[]>> = {
  [MAGIC_SHEET]: [
    [640, 480, 0, 0],
    [165, 213, 0, 0],
    [284, 210, 0, 0],
    [60, 35, 0, 0],
    [60, 18, 0, 0],
    [60, 21, 0, 0],
    [142, 120, 69, 56],
    [142, 120, 72, 56],
    [280, 173, 140, 86],
    [142, 120, 70, 64],
    [141, 120, 72, 64],
    ...rep(24, [52, 50, 26, 25]),
  ],
  [AUCTION_SHEET]: [
    [640, 480, 0, 0],
    [142, 113, 74, 59],
    [244, 100, 122, 50],
    ...Array.from({ length: 7 }, (): FakeFrame[] => [
      [87, 39, 43, 19],
      [94, 46, 43, 19],
    ]).flat(),
    [109, 388, 0, 0],
    [16, 14, 0, 0],
    [16, 14, 0, 0],
    [95, 387, 0, 0],
    [199, 349, 0, 0],
    [40, 30, 0, 0],
    [41, 30, 0, 0],
    [199, 349, 0, 0],
    [154, 352, 0, 0],
    ...rep(4, [30, 20, 0, 0]),
    ...rep(48, [64, 50, 32, -8]),
    ...rep(12, [52, 70, 26, 66]),
    ...rep(13, [58, 44, 28, -12]),
    ...rep(13, [108, 50, 50, -10]),
  ],
  [BULLETIN_SHEET]: [
    [596, 348, 0, 0],
    [336, 416, 0, 0],
    [416, 416, 0, 0],
    [360, 128, 0, 0],
    [360, 128, 0, 0],
    [184, 88, 0, 0],
    [192, 224, 0, 0],
    [192, 256, 0, 0],
    [192, 288, 0, 0],
    ...rep(8, [72, 72, 0, 0]),
    [144, 96, 0, 0],
    [21, 21, 0, 0],
    [80, 32, 0, 0],
  ],
  [JAIL_SHEET]: [
    [640, 480, 0, 0],
    [185, 81, 0, 0],
    [100, 95, 0, 0],
    [132, 137, 0, 0],
    [87, 137, 0, 0],
    ...rep(16, [110, 120, -6, -8]),
    [90, 40, 0, 0],
  ],
  [VILLAIN_SHEET]: rep(4, [150, 184, 75, 181]),
  [HOSPITAL_SHEET]: [
    [640, 480, 0, 0],
    [185, 81, 0, 0],
    [280, 100, 0, 0],
    [98, 95, 0, 0],
    [134, 357, 0, 0],
    ...rep(4, [40, 20, 0, 0]),
    [172, 340, 0, 0],
    ...rep(4, [40, 20, 0, 0]),
    ...rep(16, [120, 68, -5, -18]),
    [90, 40, 0, 0],
  ],
  ...Object.fromEntries(Array.from({ length: 12 }, (_, c) => [chibiSheet(c), [[50, 68, 25, 66]] as FakeFrame[]])),
};

/** 场景需要的全部假精灵表：第二组场所 + 公共组件（YES/NO、共享 UI、计算器、讲话头像） */
export function fakeVenueBSheets(): Record<string, SpriteSheet> {
  const out: Record<string, SpriteSheet> = { ...fakeSceneSheets([0, 1, 2, 3, 4, 9]) };
  for (const [key, frames] of Object.entries(VENUE_B_FRAMES)) out[key] = fakeSheet(key, frames);
  return out;
}

/** 可用的逻辑键（fakePackClient 用）：第二组场所 + 公共组件 + 掩膜 */
export function venueBKeys(): string[] {
  return [...Object.keys(fakeVenueBSheets()), 'ui.numpad.mask', 'venue.magic.mask'];
}
