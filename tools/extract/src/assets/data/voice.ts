/**
 * 语音映射表源数据（Speaking.mkf，v2.06 编号；v3.11 只有 #361 的音频不同，编号一致）。
 *
 * 分段（docs/research/original-assets/audio_video.md §1.2，已用 exe 里 '#NNNN' 台词表逐项核对）：
 * - 0..148    NPC 与系统播报（道具店、乐透、魔法屋、银行、月结、医院、拍卖……）
 * - 149..184  新闻播报：新闻 n → 149+n（n = 0..35，与 @rich4/shared/data 的 NewsId 同序）
 * - 185..233  命运播报：命运 n → 185+n（n = 0..48：37 条基础 + 12 个地图组变体，同 exe fateHandlers 0x473d14）
 * - 234..425  12 角色 × 16 条道具台词（234+16c+k；k 与道具号的对应见 ITEM_LINE_*，来自 exe 台词表 0x47e03a）
 * - 426..1049 12 角色 × 52 条卡片台词（426+52c+k；k 与卡号的对应见 CARD_LINE_SLOTS，来自 exe 台词表 0x47e51a）
 * - 1050..1373 12 角色 × 27 个事件槽（1050+27c+slot，exe 台词表 0x47db2a 连续排列）
 *
 * 这里只有编号与我们写的用途描述；原版台词文本不入库。
 * @source exe v2.06 台词指针表 0x47db2a（[12][27]）、0x47e03a（[12][26]）、0x47e51a（[12][90]）
 * @source .cache/assets-research/audio/speaking.manifest.json（调研产物，本机对照）
 */
import { CHARACTER_COUNT, type Confidence, span } from './types';

export const SPEAKING_COUNT = 1374;

// ───────────────────────── 事件槽（1050 + 27c + slot） ─────────────────────────

export const EVENT_LINE_BASE = 1050;
export const EVENT_LINE_STRIDE = 27;
export const EVENT_LINE_TABLE_VA = '0x47db2a';

export interface EventSlotDef {
  slot: number;
  key: string;
  desc: string;
  confidence: Confidence;
}

/**
 * 槽语义：与台词文本逐条相符，触发门槛见 docs/research/r_minigames_chars.md §2.4（第三方资料转述，A9 需再核实）。
 * 三档类（0–14）按「高 / 中 / 低」排列。
 */
export const EVENT_SLOTS: readonly EventSlotDef[] = [
  { slot: 0, key: 'points.high', desc: '得点券，高档（>100）', confidence: 'visual' },
  { slot: 1, key: 'points.mid', desc: '得点券，中档（51–100）', confidence: 'visual' },
  { slot: 2, key: 'points.low', desc: '得点券，低档（1–50）', confidence: 'visual' },
  { slot: 3, key: 'loss.high', desc: '损失（小额支出类），高档', confidence: 'guess' },
  { slot: 4, key: 'loss.mid', desc: '损失（小额支出类），中档', confidence: 'guess' },
  { slot: 5, key: 'loss.low', desc: '损失（小额支出类），低档', confidence: 'guess' },
  { slot: 6, key: 'income.high', desc: '进账，高档（≥9000×物价指数）', confidence: 'visual' },
  { slot: 7, key: 'income.mid', desc: '进账，中档（5000–9000×物价指数）', confidence: 'visual' },
  { slot: 8, key: 'income.low', desc: '进账，低档（2000–5000×物价指数）', confidence: 'visual' },
  { slot: 9, key: 'pay.high', desc: '付钱（过路费等），高档', confidence: 'visual' },
  { slot: 10, key: 'pay.mid', desc: '付钱，中档', confidence: 'visual' },
  { slot: 11, key: 'pay.low', desc: '付钱，低档', confidence: 'visual' },
  { slot: 12, key: 'fine.high', desc: '罚款或医药费，高档', confidence: 'visual' },
  { slot: 13, key: 'fine.mid', desc: '罚款或医药费，中档', confidence: 'visual' },
  { slot: 14, key: 'fine.low', desc: '罚款或医药费，低档', confidence: 'visual' },
  { slot: 15, key: 'proud', desc: '得意（例如地产盖到 5 级）', confidence: 'visual' },
  { slot: 16, key: 'monopoly.buy', desc: '买地后同一街区独占 ≥3 块', confidence: 'visual' },
  { slot: 17, key: 'monopoly.build', desc: '在独占街区加盖（1/3 概率）', confidence: 'visual' },
  { slot: 18, key: 'grudge', desc: '被最敌对的玩家拿走大额金钱（1/2 概率）', confidence: 'visual' },
  { slot: 19, key: 'jailed', desc: '坐牢', confidence: 'visual' },
  { slot: 20, key: 'hospitalized', desc: '住院', confidence: 'visual' },
  { slot: 21, key: 'sleepwalk', desc: '梦游 / 睡着', confidence: 'visual' },
  { slot: 22, key: 'badGod.attach', desc: '衰神、穷神、死神附身', confidence: 'visual' },
  { slot: 23, key: 'badGod.leave', desc: '坏神离身', confidence: 'visual' },
  { slot: 24, key: 'victory', desc: '胜利宣言', confidence: 'visual' },
  { slot: 25, key: 'bankrupt', desc: '破产', confidence: 'visual' },
  { slot: 26, key: 'gameStart', desc: '开局宣言', confidence: 'visual' },
];

// ───────────────────────── 道具台词（234 + 16c + k） ─────────────────────────

export const ITEM_LINE_BASE = 234;
export const ITEM_LINE_STRIDE = 16;
/** exe 台词表：每个角色 26 个指针，下标 j；j = 道具号 − 1（0..12），j 14..16 为路面反应，其余为空 */
export const ITEM_LINE_TABLE_VA = '0x47e03a';
export const ITEM_LINE_TABLE_PER_CHAR = 26;
export const ITEM_COUNT = 13;

/** 角色 0..10 共用：exe 表下标 j → 本角色 16 条中的序号 k（语音号 = 234 + 16c + k） */
export const ITEM_LINE_K_DEFAULT: Readonly<Record<number, number>> = {
  0: 2, // 机器娃娃
  1: 3, // 路障
  2: 4, // 地雷
  3: 5, // 定时炸弹
  4: 0, // 机车
  5: 1, // 汽车
  6: 6, // 飞弹
  7: 7, // 遥控骰子
  8: 12, // 机器工人
  9: 8, // 时光机
  10: 9, // 传送机
  11: 10, // 工程车
  12: 11, // 核子飞弹
  14: 13,
  15: 14,
  16: 15,
};

/** 例外：金贝贝（11）的 16 条直接按 j 顺序排列（exe 表逐项核对） */
export const ITEM_LINE_K_OVERRIDES: Readonly<Record<number, Readonly<Record<number, number>>>> = {
  11: { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, 11: 11, 12: 12, 14: 13, 15: 14, 16: 15 },
};

export interface ItemReactionDef {
  /** exe 台词表下标 */
  j: number;
  key: string;
  desc: string;
  confidence: Confidence;
  /** 引用该下标的代码位置（v2.06） */
  evidence: string;
}

export const ITEM_REACTIONS: readonly ItemReactionDef[] = [
  { j: 14, key: 'hitRoadblock', desc: '被路障挡住', confidence: 'visual', evidence: '0x41b5aa' },
  { j: 15, key: 'hitMine', desc: '踩到地雷（紧接小爆炸 FLIC 484）', confidence: 'visual', evidence: '0x41b747' },
  { j: 16, key: 'bombAttached', desc: '定时炸弹转到自己身上（推断）', confidence: 'guess', evidence: '0x41b89c' },
];

/** 道具号（1..13）→ exe 表下标 j */
export function itemLineIndex(itemId: number): number {
  return itemId - 1;
}

/** 语音号：角色 c、exe 表下标 j（道具或反应）；j 无语音时返回 null */
export function itemLineVoice(c: number, j: number): number | null {
  const k = (ITEM_LINE_K_OVERRIDES[c] ?? ITEM_LINE_K_DEFAULT)[j];
  return k === undefined ? null : ITEM_LINE_BASE + ITEM_LINE_STRIDE * c + k;
}

// ───────────────────────── 卡片台词（426 + 52c + k） ─────────────────────────

export const CARD_LINE_BASE = 426;
export const CARD_LINE_STRIDE = 52;
export const CARD_LINE_TABLE_VA = '0x47e51a';
/** exe 台词表每个角色 90 个指针：j = 30 × mode + (卡号 − 1)；mode 0 使用、1 对自己使用、2 被施用者的反应 */
export const CARD_LINE_TABLE_PER_CHAR = 90;
export const CARD_COUNT = 30;

/** 90 个下标中有语音的 52 个；在数组中的位置就是本角色 52 条中的序号 k（12 名角色相同，exe 表逐项核对） */
export const CARD_LINE_SLOTS: readonly number[] = [
  ...span(0, 29),
  35,
  36,
  43,
  59,
  61,
  62,
  63,
  64,
  65,
  66,
  67,
  70,
  71,
  72,
  73,
  76,
  77,
  78,
  79,
  85,
  88,
  89,
];

export type CardLineMode = 'use' | 'self' | 'target';
export const CARD_LINE_MODES: readonly CardLineMode[] = ['use', 'self', 'target'];
/** mode 语义来自台词内容（对自己使用 / 被施用者的反应），结构本身来自 exe */
export const CARD_LINE_MODE_CONFIDENCE: Readonly<Record<CardLineMode, Confidence>> = {
  use: 'exe',
  self: 'visual',
  target: 'visual',
};

export function cardLineVoice(c: number, j: number): number | null {
  const k = CARD_LINE_SLOTS.indexOf(j);
  return k < 0 ? null : CARD_LINE_BASE + CARD_LINE_STRIDE * c + k;
}

// ───────────────────────── NPC、系统播报、新闻、命运 ─────────────────────────

export interface NpcLineDef {
  key: string;
  ids: readonly number[];
  desc: string;
  confidence: Confidence;
}

/**
 * NPC 与系统播报（0..148）。confidence：exe 台词文本能对上用途的记 visual；
 * exe 中没有 '#NNNN' 文本、只凭位置归类的记 guess。
 */
export const NPC_LINES: readonly NpcLineDef[] = [
  { key: 'misc.unlabeled0', ids: [0], desc: '无台词文本，用途待查', confidence: 'guess' },
  { key: 'cardShop.choose', ids: [1], desc: '卡片兑换：提示选择要兑换的卡', confidence: 'visual' },
  { key: 'cardShop.noPoints', ids: [2], desc: '卡片兑换：点数不足', confidence: 'visual' },
  { key: 'cardShop.slotsFull', ids: [3], desc: '卡片兑换：卡片栏已满', confidence: 'visual' },
  { key: 'cardShop.bye', ids: [4], desc: '卡片兑换：欢迎再来', confidence: 'visual' },
  { key: 'itemShop.welcome', ids: [5], desc: '道具店：欢迎', confidence: 'visual' },
  { key: 'itemShop.choose', ids: [6], desc: '道具店：询问兑换什么道具', confidence: 'visual' },
  { key: 'itemShop.noPoints', ids: [7], desc: '道具店：点券不够', confidence: 'visual' },
  { key: 'itemShop.slotsFull', ids: [8], desc: '道具店：道具栏已满', confidence: 'visual' },
  { key: 'itemShop.membersOnly', ids: [9], desc: '道具店：会员专属道具', confidence: 'visual' },
  { key: 'itemShop.thanks', ids: [10], desc: '道具店：谢谢惠顾', confidence: 'visual' },
  { key: 'lottery.bet.greet', ids: [11], desc: '乐透投注：招呼', confidence: 'visual' },
  { key: 'lottery.bet.pitch', ids: [12], desc: '乐透投注：介绍票价与大奖', confidence: 'visual' },
  { key: 'lottery.bet.pick', ids: [13], desc: '乐透投注：请选号码', confidence: 'visual' },
  { key: 'lottery.bet.bye', ids: [14], desc: '乐透投注：祝中奖', confidence: 'visual' },
  { key: 'lottery.bet.noCash', ids: [15], desc: '乐透投注：现金不足', confidence: 'visual' },
  { key: 'lottery.bet.later', ids: [16], desc: '乐透投注：下次再来', confidence: 'visual' },
  { key: 'lottery.draw.intro', ids: [17], desc: '乐透开奖：每月 15 号开奖时间', confidence: 'visual' },
  { key: 'lottery.draw.drawing', ids: [18], desc: '乐透开奖：开出号码', confidence: 'visual' },
  { key: 'lottery.draw.winnerIs', ids: [19], desc: '乐透开奖：本月得主是', confidence: 'visual' },
  { key: 'lottery.draw.soleWinner', ids: [32], desc: '乐透开奖：独得全部奖金', confidence: 'visual' },
  { key: 'lottery.draw.noWinner', ids: [33], desc: '乐透开奖：本月无人得奖', confidence: 'visual' },
  { key: 'lottery.draw.rollover', ids: [34], desc: '乐透开奖：奖金累积到下月', confidence: 'visual' },
  { key: 'lottery.draw.nextTime', ids: [35], desc: '乐透开奖：希望下次得奖', confidence: 'visual' },
  { key: 'magic.hurry', ids: [36], desc: '魔法屋：催促', confidence: 'visual' },
  { key: 'magic.intro', ids: [37], desc: '魔法屋：进门说明', confidence: 'visual' },
  { key: 'magic.select', ids: [38], desc: '魔法屋：选出符合条件的人', confidence: 'visual' },
  { key: 'magic.decide', ids: [39], desc: '魔法屋：由你决定他们的命运', confidence: 'visual' },
  { key: 'magic.yourTurn', ids: [40], desc: '魔法屋：轮到你', confidence: 'visual' },
  { key: 'magic.chant', ids: [41, 44], desc: '魔法屋：念咒（两段）', confidence: 'visual' },
  { key: 'magic.offerDeath', ids: [42], desc: '魔法屋：询问是否召唤死神复仇', confidence: 'visual' },
  { key: 'magic.deathTarget', ids: [43], desc: '魔法屋：死神附在谁身上', confidence: 'visual' },
  { key: 'magic.merciful', ids: [45], desc: '魔法屋：放弃复仇', confidence: 'visual' },
  {
    key: 'magic.condition',
    ids: span(46, 57),
    desc: '魔法屋：12 个条件，下标 = 魔法屋条件号 0..11（总资产、地产、建筑、现金、存款、点券、步行、机车、汽车、附身、男、女）',
    confidence: 'visual',
  },
  {
    key: 'misc.unlabeled58',
    ids: span(58, 74),
    desc: '无台词文本，用途待查（位于魔法屋与银行之间）',
    confidence: 'guess',
  },
  { key: 'bank.welcome', ids: [75], desc: '银行：欢迎', confidence: 'visual' },
  { key: 'bank.service', ids: [76], desc: '银行：询问需要什么服务', confidence: 'visual' },
  { key: 'bank.loanLimit', ids: [77], desc: '银行：告知贷款额度', confidence: 'visual' },
  { key: 'bank.loanAmount', ids: [78], desc: '银行：请输入贷款金额', confidence: 'visual' },
  { key: 'bank.loanDone', ids: [79], desc: '银行：贷款完成', confidence: 'visual' },
  { key: 'bank.loanTerm', ids: [80], desc: '银行：提醒期限内还清', confidence: 'visual' },
  { key: 'bank.overLimit', ids: [81], desc: '银行：超过许可额度', confidence: 'visual' },
  { key: 'bank.repayAmount', ids: [82], desc: '银行：请输入还款金额', confidence: 'visual' },
  { key: 'bank.noCash', ids: [83], desc: '银行：现金不足', confidence: 'visual' },
  { key: 'bank.repayDone', ids: [84], desc: '银行：还款完成', confidence: 'visual' },
  { key: 'bank.thanks', ids: [85], desc: '银行：谢谢惠顾', confidence: 'visual' },
  { key: 'bank.chairman.greet', ids: [86], desc: '银行（董事长）：问候', confidence: 'visual' },
  { key: 'bank.chairman.borrowAmount', ids: [87], desc: '银行（董事长）：请输入周转金额', confidence: 'visual' },
  { key: 'bank.chairman.vaultShort', ids: [88], desc: '银行（董事长）：行里现金不够', confidence: 'visual' },
  { key: 'bank.chairman.repayAmount', ids: [89], desc: '银行（董事长）：请输入还款金额', confidence: 'visual' },
  { key: 'bank.chairman.joke', ids: [90], desc: '银行（董事长）：别开玩笑', confidence: 'visual' },
  { key: 'bank.chairman.bye', ids: [91], desc: '银行（董事长）：送客', confidence: 'visual' },
  { key: 'misc.unlabeled92', ids: [92, 94], desc: '无台词文本，位于月结段（推断为月结播报）', confidence: 'guess' },
  { key: 'month.interest', ids: [93], desc: '月结：按存款加发利息', confidence: 'visual' },
  { key: 'month.loserIs', ids: [95], desc: '月结：本月悲情人物是', confidence: 'visual' },
  { key: 'month.cheerUp', ids: [108], desc: '月结：鼓励悲情人物', confidence: 'visual' },
  { key: 'month.championIs', ids: [109], desc: '月结：本月冠军是', confidence: 'visual' },
  { key: 'month.othersTry', ids: [122], desc: '月结：其他人再努力', confidence: 'visual' },
  {
    key: 'rescue.thanks',
    ids: [123, 124, 125, 126],
    desc: '被保释 / 被救的人道谢（124 无文本，按位置归入）',
    confidence: 'guess',
  },
  { key: 'hospital.whom', ids: [127], desc: '医院：替谁办理出院', confidence: 'visual' },
  { key: 'hospital.wait', ids: [128], desc: '医院：请稍候', confidence: 'visual' },
  { key: 'hospital.done', ids: [129], desc: '医院：已可出院', confidence: 'visual' },
  { key: 'hospital.takeCare', ids: [130], desc: '医院：保重身体', confidence: 'visual' },
  { key: 'misc.unlabeled131', ids: [131], desc: '无台词文本，位于医院与拍卖之间', confidence: 'guess' },
  { key: 'auction.open', ids: [132], desc: '拍卖：报底价、请出价', confidence: 'visual' },
  { key: 'auction.call', ids: [133, 134], desc: '拍卖：短促的喊价（无文本，推断）', confidence: 'guess' },
  { key: 'auction.sold', ids: [135], desc: '拍卖：成交', confidence: 'visual' },
  { key: 'auction.noBid', ids: [148], desc: '拍卖：无人出价、流标', confidence: 'visual' },
];

export interface NameCallDef {
  key: string;
  /** 角色 0 的语音号；角色 c = base + c */
  base: number;
  desc: string;
  confidence: Confidence;
}

/** 按角色点名：语音号 = base + 角色号 */
export const NAME_CALLS: readonly NameCallDef[] = [
  { key: 'lottery.winnerName', base: 20, desc: '乐透开奖：得主角色名', confidence: 'visual' },
  { key: 'month.loserName', base: 96, desc: '月结：悲情人物角色名（96 无文本，按位置归入）', confidence: 'visual' },
  { key: 'month.championName', base: 110, desc: '月结：冠军角色名', confidence: 'visual' },
  { key: 'auction.winnerName', base: 136, desc: '拍卖：恭喜某角色购得此地', confidence: 'visual' },
];

export const NEWS_VOICE_BASE = 149;
export const NEWS_COUNT = 36;
export const FATE_VOICE_BASE = 185;
/** 37 条基础命运 + 12 个地图组变体（exe fateHandlers 49 项） */
export const FATE_COUNT = 49;

/** exe 中没有 '#NNNN' 台词文本的语音号（音频存在；按位置归类，置信度 guess） */
export const VOICE_IDS_WITHOUT_TEXT: readonly number[] = [
  0,
  ...span(58, 74),
  92,
  94,
  96,
  124,
  131,
  133,
  134,
  156,
  161,
  162,
  163,
  164,
  173,
  190,
  194,
];

/** 44.1 kHz 采样的 190 段（忍太郎、宫本宝藏）；其余为 22.05 kHz */
export const VOICE_44K_RANGES: readonly (readonly [number, number])[] = [
  [266, 281],
  [330, 345],
  [530, 581],
  [738, 789],
  [1104, 1130],
  [1212, 1238],
];

export function eventLineVoice(c: number, slot: number): number {
  return EVENT_LINE_BASE + EVENT_LINE_STRIDE * c + slot;
}

export { CHARACTER_COUNT };
