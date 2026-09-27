/**
 * 原版 v2.06 的编号事实（audio_video.md §1.2、§3.2；已在用户正版文件与 exe 上核对）。
 * 只供 tools/extract 生成映射表与测试对照；客户端一律按逻辑键取用素材，不得依赖这里的编号。
 */
import type { MusicScene } from './media';
import { CHARACTER_COUNT, VOICE_CARD_LINES, VOICE_ITEM_LINES, VOICE_SLOT_COUNT } from './media';

/** Speaking.mkf 的分段：编号 = base + stride·角色 + k（两版相同，v3.11 只有 #361 内容不同） */
export const ORIGINAL_VOICE_LAYOUT = {
  /** 道具台词 234+16c+k（金貝貝 410..425 为 `@NN` 表情图号） */
  item: { base: 234, stride: VOICE_ITEM_LINES, count: VOICE_ITEM_LINES },
  /** 卡片台词 426+52c+k */
  card: { base: 426, stride: VOICE_CARD_LINES, count: VOICE_CARD_LINES },
  /** 事件槽 1050+27c+slot */
  slot: { base: 1050, stride: VOICE_SLOT_COUNT, count: VOICE_SLOT_COUNT },
} as const;

/** Speaking.mkf 资源总数 */
export const ORIGINAL_VOICE_COUNT = 1374;
/** NPC 与新闻播报占 0..233：道具店 0–10、乐透 11–35、魔法屋 36–57、银行 75–91、月结 93–122、医院 123–130、拍卖 132–148、新闻 149–233 */
export const ORIGINAL_NPC_VOICE_END = 234;

export type OriginalVoiceKind = keyof typeof ORIGINAL_VOICE_LAYOUT;

/** 原版语音资源号；越界抛 RangeError */
export function originalVoiceIndex(kind: OriginalVoiceKind, character: number, k: number): number {
  const l = ORIGINAL_VOICE_LAYOUT[kind];
  if (!Number.isInteger(character) || character < 0 || character >= CHARACTER_COUNT) {
    throw new RangeError(`character ${character} 超出 0..${CHARACTER_COUNT - 1}`);
  }
  if (!Number.isInteger(k) || k < 0 || k >= l.count) throw new RangeError(`${kind} 序号 ${k} 超出 0..${l.count - 1}`);
  return l.base + l.stride * character + k;
}

/** 棋盘轮播曲的 CD 轨号（idx + 2，0x4534ef `add eax,2`） */
export const ORIGINAL_BOARD_TRACKS: readonly number[] = Object.freeze([2, 3, 4, 5, 6, 7, 8, 9]);

/** 场景曲的 CD 轨号（arg + 10；Midi.txt 第 k 行对应 track k+2）。track13 在两版中都没有引用 */
export const ORIGINAL_SCENE_TRACKS: { readonly [S in MusicScene]: number } = Object.freeze({
  title: 10,
  setup: 11,
  bankrupt: 12,
  bank: 14,
  auction: 15,
  shop: 16,
  lotteryBet: 16,
  gameOver: 16,
  magic: 17,
  lotteryDraw: 18,
  monthly: 19,
  xicong: 20,
  balloon: 21,
  penguin: 22,
  christmas: 23,
  lunarNewYear: 24,
  jail: 25,
  hospital: 26,
});
