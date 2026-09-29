/**
 * 音效映射表源数据（Effect.mkf，v2.06）。
 *
 * - Effect.mkf 共 115 项：#64..#79 为 0 字节空占位，其余 99 段为 u8 单声道 22.05 kHz WAV。音效号 = 资源号。
 * - 音效集表在 exe DGROUP：每条 8 字节 {u32 音效号, u32 运行时缓冲指针}，以 0xFFFFFFFF 结尾，不按 4 字节对齐。
 *   16 张被 push 引用（进入对应界面时整组载入），另有一张死表 {8}。
 * - 用途（cues）按 sfx-callsites.v206.json 的 131 个已解析调用点、所在处理函数与附近字符串标注；
 *   只有调用语境明确的记 exe，其余记 guess（A9 应配试听页再核）。
 * - #80..#114 是 FLIC 同步音效（首帧播放），对应关系在 flic.ts 的 sfx 字段。
 * @source exe v2.06 play_sound_effect 0x4529ee（152 处调用）、FLIC 播放 0x44fc76
 * @source docs/research/original-assets/audio_video.md §2；.cache/assets-research/audio/sfx-{tables,callsites}.v206.json
 */
import type { Confidence } from './types';
import { span } from './types';

export const EFFECT_COUNT = 115;
export const EFFECT_EMPTY_IDS: readonly number[] = span(64, 79);

export interface SfxSetDef {
  key: string;
  /** 表在 exe 中的 VA（v2.06） */
  va: string;
  /** 表内顺序（播放调用用下标访问，顺序有意义） */
  ids: readonly number[];
  desc: string;
  /** 载入该表的 push 位置（节选） */
  loadedAt: readonly string[];
}

export const SFX_SETS: readonly SfxSetDef[] = [
  { key: 'ui', va: '0x47f5fa', ids: [0, 1, 2, 4, 3], desc: '全局 UI（启动时载入，常驻）', loadedAt: ['0x401721'] },
  {
    key: 'board',
    va: '0x47f62a',
    ids: [7, 9, 10, 32, 33, 34, 35, 36, 37, 38, 43, 44, 45, 46, 53, 47, 48, 49, 50, 54, 55, 56, 15, 62],
    desc: '棋盘主界面（进入棋盘载入、离开释放）',
    loadedAt: ['0x407d0f', '0x43666c', '0x451471'],
  },
  { key: 'setup', va: '0x46ab7c', ids: [5], desc: '开局设定', loadedAt: ['0x406bb9'] },
  {
    key: 'mg.penguin',
    va: '0x472ee7',
    ids: [11, 12, 13, 14, 16, 17, 18, 15],
    desc: '小游戏：企鹅挖宝',
    loadedAt: ['0x414b7e'],
  },
  { key: 'mg.balloon', va: '0x472f2f', ids: [19, 20, 21], desc: '小游戏：七彩气球', loadedAt: ['0x414e29'] },
  { key: 'mg.fortune', va: '0x472f4f', ids: [22, 23, 24, 15], desc: '小游戏：喜从天降', loadedAt: ['0x414f48'] },
  {
    key: 'mg.common',
    va: '0x472f88',
    ids: [25, 26],
    desc: '小游戏公共部分（入场 / 结算，推断）',
    loadedAt: ['0x415250'],
  },
  { key: 'stock', va: '0x4733c3', ids: [40, 41], desc: '股市行情与买卖', loadedAt: ['0x42acc5'] },
  { key: 'stock.dividend', va: '0x4733db', ids: [61], desc: '上市公司分红', loadedAt: ['0x42b01e'] },
  { key: 'lottery.bet', va: '0x47349f', ids: [31], desc: '乐透投注', loadedAt: ['0x4309ca'] },
  { key: 'lottery.draw', va: '0x4734af', ids: [57, 58], desc: '乐透开奖', loadedAt: ['0x430b1b'] },
  { key: 'magic', va: '0x47361b', ids: [39], desc: '魔法屋', loadedAt: ['0x432bd2'] },
  { key: 'month', va: '0x47394b', ids: [27, 28, 60], desc: '月结颁奖（存款利息 / 月末）', loadedAt: ['0x438bf9'] },
  { key: 'auction', va: '0x4739ee', ids: [29, 63], desc: '拍卖', loadedAt: ['0x43b421'] },
  {
    key: 'numpad.a',
    va: '0x473b60',
    ids: [51],
    desc: '金额输入类界面 A（fcn.0043df4a，推断）',
    loadedAt: ['0x43df9a'],
  },
  {
    key: 'numpad.b',
    va: '0x473b70',
    ids: [52],
    desc: '金额输入类界面 B（fcn.0043e43e，推断）',
    loadedAt: ['0x43e486'],
  },
];

/** 没有任何代码引用的死表 */
export const SFX_DEAD_SET = { va: '0x46ab8c', ids: [8] as readonly number[] };

export interface SfxCueDef {
  key: string;
  ids: readonly number[];
  desc: string;
  confidence: Confidence;
  /** 调用点（v2.06 VA，节选） */
  evidence: readonly string[];
}

export const SFX_CUES: readonly SfxCueDef[] = [
  // 全局 UI
  {
    key: 'ui.click',
    ids: [1],
    desc: '通用点击 / 确认（调用最多，44 处）',
    confidence: 'guess',
    evidence: ['0x4025c1', '0x40ff46', '0x417a0f'],
  },
  {
    key: 'ui.open',
    ids: [0],
    desc: '打开界面 / 进入（10 处）',
    confidence: 'guess',
    evidence: ['0x402819', '0x4328e3', '0x43e852'],
  },
  {
    key: 'ui.move',
    ids: [2],
    desc: '移动选择（常与 4 成对出现）',
    confidence: 'guess',
    evidence: ['0x403840', '0x445212', '0x451ffe'],
  },
  {
    key: 'ui.back',
    ids: [4],
    desc: '返回 / 取消（17 处）',
    confidence: 'guess',
    evidence: ['0x40386d', '0x432b17', '0x43eb47'],
  },
  {
    key: 'ui.use',
    ids: [3],
    desc: '使用卡片或道具时的确认（附近有「使用%s」）',
    confidence: 'guess',
    evidence: ['0x440927', '0x4100c8', '0x44524a'],
  },
  {
    // GO 钮（fcn.00417623）：鼠标点在钮面（掩膜区 3）时先 push 0; push 0x47f602; call fcn.004529ee（0x417ac9–0x417ad0，
    // 全局音效表 0x47f5fa 第 2 项 = Effect#1），再隐去 GO（0x417ae2）、开始掷骰（0x417aec）；点骰子数竖槽（区 1、未停留）
    // 同样先放这一声（0x417a08–0x417a0f）。键盘的 GO（0x40126d–0x401283）与 D 键（0x4012c9–0x401306）不出声
    key: 'ui.go',
    ids: [1],
    desc: '按下 GO 钮 / 点骰子数竖槽（鼠标）',
    confidence: 'exe',
    evidence: ['0x417ac9', '0x417a08'],
  },
  { key: 'setup.click', ids: [5], desc: '开局设定界面的点击', confidence: 'guess', evidence: ['0x406bb9'] },
  // 棋盘
  {
    key: 'board.enter',
    ids: [7],
    desc: '回到棋盘主画面（紧跟载入棋盘音效集）',
    confidence: 'guess',
    evidence: ['0x436671', '0x451476'],
  },
  {
    key: 'board.misc9',
    ids: [9],
    desc: '棋盘：用途待查（银行相关函数内）',
    confidence: 'guess',
    evidence: ['0x4365ec'],
  },
  {
    // 掷骰函数 fcn.00418d0b：0x418d88 以棋盘集下标 2（0x47f63a = Effect#10）登记骰子 FLC 的逐帧同步音效，flags bits24–30 = 0x1e
    // → fcn.0044f72b 在第 30 帧（0x44fb9d–0x44fbc0）播放；FLC 播完后 0x418dc8 再播一次：一次掷骰「咚咚」两声，与颗数无关
    key: 'dice.roll',
    ids: [10],
    desc: '掷骰：骰子 FLC 第 30 帧与播完时各一声「咚」',
    confidence: 'exe',
    evidence: ['0x418d88', '0x44fb9d', '0x418dc8'],
  },
  {
    key: 'item.timeBomb.place',
    ids: [10],
    desc: '放置定时炸弹（道具处理函数内，紧跟炸弹台词；同一个「咚」也用于掷骰，见 dice.roll）',
    confidence: 'guess',
    evidence: ['0x4459be'],
  },
  {
    key: 'money.giveBeggar',
    ids: [32],
    desc: '施舍乞丐 / 付出小钱',
    confidence: 'guess',
    evidence: ['0x41ae5f', '0x40d4ee'],
  },
  {
    key: 'item.roadblock.place',
    ids: [33],
    desc: '放置路障（道具处理函数内，紧跟路障台词）',
    confidence: 'exe',
    evidence: ['0x4457fc'],
  },
  {
    key: 'item.mine.place',
    ids: [34],
    desc: '放置地雷（道具处理函数内，紧跟地雷台词）',
    confidence: 'exe',
    evidence: ['0x4458dd'],
  },
  {
    key: 'gain.item',
    ids: [35],
    desc: '得到卡片或道具（附近有「得到%s」）',
    confidence: 'exe',
    evidence: ['0x41b18f', '0x41b2cc'],
  },
  {
    key: 'gain.points',
    ids: [36],
    desc: '得到点券（附近有「得到500點券」）',
    confidence: 'exe',
    evidence: ['0x41b384', '0x41b420'],
  },
  { key: 'board.misc37', ids: [37], desc: '棋盘集中未见静态调用', confidence: 'guess', evidence: [] },
  {
    key: 'move.loop38',
    ids: [38],
    desc: '行进循环音（集内下标 9，动态播放）',
    confidence: 'guess',
    evidence: ['0x40d9a2'],
  },
  { key: 'board.misc43', ids: [43], desc: '棋盘集中未见静态调用', confidence: 'guess', evidence: [] },
  {
    key: 'move.walk',
    ids: [44],
    desc: '步行行进循环音（集内下标 11 + 座驾）',
    confidence: 'guess',
    evidence: ['0x40b81d', '0x40b9d9'],
  },
  { key: 'move.moto', ids: [45], desc: '机车行进循环音（集内下标 12）', confidence: 'guess', evidence: ['0x40b81d'] },
  { key: 'move.car', ids: [46], desc: '汽车行进循环音（集内下标 13）', confidence: 'guess', evidence: ['0x40b81d'] },
  {
    key: 'move.engineer',
    ids: [53],
    desc: '工程车行进循环音（集内下标 14，推断）',
    confidence: 'guess',
    evidence: ['0x40b81d'],
  },
  { key: 'move.boat', ids: [47], desc: '快艇行进循环音（集内下标 15）', confidence: 'guess', evidence: ['0x40b69d'] },
  { key: 'board.misc48', ids: [48], desc: '棋盘集中未见静态调用', confidence: 'guess', evidence: [] },
  {
    key: 'land.buy',
    ids: [49],
    desc: '买下地产（附近有「是否買下此地」）',
    confidence: 'exe',
    evidence: ['0x41994f', '0x41a1a2'],
  },
  {
    key: 'land.build',
    ids: [50],
    desc: '加盖 / 升级房屋（含神明显灵加盖）',
    confidence: 'exe',
    evidence: ['0x41918d', '0x419aca', '0x40ef4f'],
  },
  { key: 'board.misc54', ids: [54], desc: '棋盘：用途待查', confidence: 'guess', evidence: ['0x40df3c'] },
  {
    key: 'money.payFee',
    ids: [55],
    desc: '支付费用（升级、旅馆等场合）',
    confidence: 'guess',
    evidence: ['0x419218', '0x419c0f'],
  },
  {
    key: 'status.skipTurn',
    ids: [56],
    desc: '因坐牢、住院、冬眠等停留（附近有「還剩%d天」）',
    confidence: 'guess',
    evidence: ['0x40c27e'],
  },
  {
    key: 'shared.cheer15',
    ids: [15],
    desc: '棋盘与两个小游戏共用（推断为欢呼 / 得分）',
    confidence: 'guess',
    evidence: ['0x4122d5', '0x412d0b'],
  },
  { key: 'card.use', ids: [62], desc: '使用卡片（卡片处理函数入口附近）', confidence: 'guess', evidence: ['0x440cd7'] },
  // 场所
  {
    key: 'stock.trade',
    ids: [40, 41],
    desc: '股票买 / 卖（顺序待试听）',
    confidence: 'guess',
    evidence: ['0x42a519', '0x42a601'],
  },
  { key: 'stock.dividend', ids: [61], desc: '分红', confidence: 'exe', evidence: ['0x42aa3c'] },
  { key: 'lottery.bet', ids: [31], desc: '乐透投注', confidence: 'exe', evidence: ['0x42f413'] },
  {
    key: 'lottery.draw',
    ids: [57, 58],
    desc: '乐透开奖（摇奖 / 揭晓，顺序待试听）',
    confidence: 'guess',
    evidence: ['0x42f85b'],
  },
  { key: 'magic.cast', ids: [39], desc: '魔法屋施法', confidence: 'guess', evidence: ['0x4321f4'] },
  {
    key: 'month.award',
    ids: [27, 28, 60],
    desc: '月结颁奖（27 在「本月悲情人物」旁）',
    confidence: 'guess',
    evidence: ['0x43750d'],
  },
  { key: 'auction.sold', ids: [29], desc: '拍卖成交（紧挨「%d元成交」）', confidence: 'exe', evidence: ['0x43a3f2'] },
  { key: 'auction.bid', ids: [63], desc: '拍卖出价', confidence: 'guess', evidence: ['0x4393fe'] },
  {
    key: 'numpad.a',
    ids: [51],
    desc: '金额输入（保释、神明附身支付等）',
    confidence: 'guess',
    evidence: ['0x43df9f', '0x43f525'],
  },
  { key: 'numpad.b', ids: [52], desc: '金额输入（研究所 / 设施类）', confidence: 'guess', evidence: ['0x43e48b'] },
  // 小游戏
  { key: 'mg.penguin.dig', ids: [11], desc: '企鹅挖宝', confidence: 'guess', evidence: ['0x414473'] },
  { key: 'mg.penguin.a', ids: [12], desc: '企鹅挖宝', confidence: 'guess', evidence: ['0x41210f'] },
  { key: 'mg.penguin.b', ids: [14], desc: '企鹅挖宝', confidence: 'guess', evidence: ['0x4142fc'] },
  {
    key: 'mg.penguin.dynamic',
    ids: [13, 16, 17, 18],
    desc: '企鹅挖宝：按宝物类别动态选音（0x412304 查表）',
    confidence: 'guess',
    evidence: ['0x412304'],
  },
  {
    key: 'mg.balloon',
    ids: [19, 20, 21],
    desc: '七彩气球',
    confidence: 'guess',
    evidence: ['0x412999', '0x414832', '0x414731'],
  },
  {
    key: 'mg.fortune',
    ids: [22, 23, 24],
    desc: '喜从天降',
    confidence: 'guess',
    evidence: ['0x41312b', '0x414af1', '0x41313a'],
  },
  {
    key: 'mg.result',
    ids: [25],
    desc: '小游戏结算（附近有「得點券%d點」）',
    confidence: 'guess',
    evidence: ['0x4152e7'],
  },
  { key: 'mg.common26', ids: [26], desc: '小游戏公共集第二项（未见静态调用）', confidence: 'guess', evidence: [] },
];

/** 没有被任何音效集或调用点引用 */
export const SFX_UNUSED: readonly number[] = [6, 8, 30, 42];

/** 由 FLIC 播放函数在运行时传入的音效（FLIC 号也是运行时决定；已追到的写在 flic.ts） */
export const SFX_DYNAMIC_FLIC: readonly number[] = [59, 81, 83, 91, 97];
