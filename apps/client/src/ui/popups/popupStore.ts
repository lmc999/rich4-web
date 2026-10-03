// 演出弹窗的状态（design/client.md §2 ui/popups、§4.5、§5.4）：新闻、命运、出卡、神明降临、乐透开奖、魔法屋、终局，
// 以及公开竞价横幅。事件 handler 写入（文案已本地化，组件只负责渲染），PopupLayer 读取。
// 弹窗同一时刻只有一个（事件串行播放）；到时由 handler 关闭，最短展示时间过后可以点击提前跳过。
import type { CardId, CharacterId, GodKind, LotId, NewsId, SeatIndex } from '@rich4/shared/engine';
import { create } from 'zustand';

export interface PlayerRef {
  seat: SeatIndex;
  character: CharacterId;
  name: string;
}

export interface StatDelta {
  field: 'cash' | 'deposit' | 'points';
  delta: number;
}

export interface AffectedRow extends PlayerRef {
  deltas: StatDelta[];
}

export interface NewsPopupSpec {
  kind: 'news';
  id: NewsId;
  /** 分类号 0 奇闻、1 政府公告、2 社会、3 路况、4 气象、5 财经 */
  category: number;
  categoryLabel: string;
  headline: string;
  body: string;
  affected: AffectedRow[];
}

export interface FatePopupSpec {
  kind: 'fate';
  player: PlayerRef;
  id: number;
  /**
   * 原版命运处理函数表的下标（第 33–36 条在大陆 / 日本 / 美国图为 k + 4·gm，见 presentation/eventText.fateVariantSlot）：
   * 原版命运板按它取插图（表 0x473dd8）与表情头像；缺省等于 id
   */
  slot?: number;
  /**
   * 原版皮肤的命运分两段：board = 命运板（插图 + 文案）；blessing = 板子之后的加持消息框（原版 fcn.0043f90f 1.5 秒）。
   * 缺省 board；程序化弹窗两段都画整张翻面卡
   */
  phase?: 'board' | 'blessing';
  title: string;
  text: string;
  amountText: string | null;
  /** 金额行的颜色（缺省按 amountText 是否以 '-' 开头） */
  amountTone?: 'gain' | 'loss' | 'neutral';
  tone: 'good' | 'bad' | 'neutral';
  blessingText: string | null;
}

export interface CardCastPopupSpec {
  kind: 'cardCast';
  player: PlayerRef;
  /** 卡号；得卡（gain）时私密手牌模式下别人看不到种类为 null（只画消息框，不贴卡图） */
  card: CardId | null;
  cardName: string;
  desc: string;
  /** 顶部标题（「使用卡片」「被动卡生效」「没有效果」「得到卡片」） */
  title: string;
  targetText: string | null;
  /** cast 出卡、passive 被动卡生效、fizzle 没有效果、gain 得卡（卡片格 / 聖誕節，原版同一个亮卡函数） */
  variant: 'cast' | 'passive' | 'fizzle' | 'gain';
  /** 得卡的来源（variant 为 gain 时）：卡片格「得到%s！」、聖誕節「聖誕節\n\n%s得到%s！」 */
  gainFrom?: 'square' | 'holiday';
}

export interface GodPopupSpec {
  kind: 'god';
  god: GodKind;
  godName: string;
  player: PlayerRef | null;
  title: string;
  line: string;
  good: boolean;
  /** 老虎机：位数与结果（不乘 PI）；null 时不显示老虎机 */
  slot: { digits: number; value: number } | null;
  amountText: string | null;
}

export interface LotteryPopupSpec {
  kind: 'lottery';
  title: string;
  /** 开出的号码（显示值 1..36）；无人购票为 null */
  number: number | null;
  winner: PlayerRef | null;
  subtitle: string;
}

export interface MagicPopupSpec {
  kind: 'magic';
  caster: PlayerRef;
  title: string;
  line: string;
  targets: PlayerRef[];
}

export interface GameOverRow extends PlayerRef {
  rank: number;
  netWorth: number;
  alive: boolean;
  parts: { cash: number; deposit: number; stocks: number; estate: number; loan: number };
}

export interface GameOverPopupSpec {
  kind: 'gameOver';
  title: string;
  subtitle: string;
  winner: PlayerRef | null;
  rows: GameOverRow[];
}

export type PopupSpec =
  | NewsPopupSpec
  | FatePopupSpec
  | CardCastPopupSpec
  | GodPopupSpec
  | LotteryPopupSpec
  | MagicPopupSpec
  | GameOverPopupSpec;

export type PopupKind = PopupSpec['kind'];

export type OpenPopup = PopupSpec & {
  /**
   * 弹窗实例号（open 返回值，close / skip 用它）。不能叫 id：新闻、命运的 spec 自带 id（新闻 / 命运编号），
   * 合并时会被覆盖（曾让 data-news / data-fate 显示成实例号）。
   */
  popupId: number;
  /** 展示时长（1x 时钟毫秒） */
  ms: number;
  /**
   * 实际寿命（真实毫秒）= ms ÷ 打开时的动画倍速。弹窗寿命由动画时钟计时，组件内部的滚号、老虎机、打字机
   * 按真实时间走，所以用它安排节奏（2x / 3x 时按比例缩短，保证在关闭前播完、结果能显示出来）。
   */
  realMs: number;
  /** 最短展示时间（真实毫秒，已按倍速换算）：之后可以点击跳过 */
  minMs: number;
};

export interface AuctionBidder extends PlayerRef {
  state: 'active' | 'passed' | 'quit';
}

export interface AuctionBannerState {
  lot: LotId;
  lotName: string;
  sellerName: string | null;
  start: number;
  price: number;
  leader: PlayerRef | null;
  bidders: AuctionBidder[];
  /** 结束后显示成交 / 流拍一句话，随后收起 */
  result: string | null;
  /** 每次出价 +1（组件用它重放出价动画） */
  tick: number;
  /** 由待决策推出（没有经过演出）：领先者未知，价格为现价 */
  derived?: boolean;
}

/** 正在以原版画面显示的弹窗（原版皮肤的弹窗宿主判定用原版画面时登记） */
export interface ClassicShown {
  popupId: number;
  kind: PopupKind;
}

export interface PopupState {
  current: OpenPopup | null;
  auction: AuctionBannerState | null;
  /**
   * 当前以原版画面显示的弹窗（ui/classic/popups/ClassicPopupHost 登记，程序化弹窗为 null）：原版亮卡期间网页版的
   * toast 在缺省位置（页面上部正中）时暂缓显示（hud/Overlays 的 Toasts），免得盖住棋盘视窗上部的亮卡消息框
   */
  classicShown: ClassicShown | null;
  setClassicShown(v: ClassicShown | null): void;
  /** speed：打开时的动画倍速（缺省 1）；minMs 以 1x 计，按倍速换算成真实毫秒 */
  open(spec: PopupSpec, ms: number, minMs?: number, speed?: number): number;
  close(id: number): void;
  /** 用户点击跳过（最短展示时间之后才有效，由组件判断） */
  skip(id: number): void;
  setAuction(a: AuctionBannerState | null): void;
  patchAuction(patch: Partial<AuctionBannerState>): void;
  clear(): void;
}

let seq = 0;
const skipListeners = new Map<number, () => void>();

/** 某个弹窗现在打开会不会用原版画面 */
export type ClassicPopupProbe = (spec: PopupSpec) => boolean;
let classicProbe: ClassicPopupProbe | null = null;

/** 原版皮肤的弹窗宿主（ui/classic/popups/ClassicPopupHost，懒加载）挂载时登记判定函数；返回注销函数 */
export function registerClassicPopupProbe(fn: ClassicPopupProbe): () => void {
  classicProbe = fn;
  return () => {
    if (classicProbe === fn) classicProbe = null;
  };
}

/**
 * 这个弹窗现在打开会不会用原版画面（没有原版宿主、素材未就绪时 false）：handler 据此省掉原版没有的棋盘演出——
 * 原版亮卡（exe fcn.00440bac）只画消息框与卡图、静止 1.5 秒，棋盘上没有气泡、粒子与光束
 */
export function opensClassic(spec: PopupSpec): boolean {
  try {
    return classicProbe?.(spec) === true;
  } catch {
    return false;
  }
}

/** 原版皮肤的弹窗宿主是否挂着（经典布局）：handler 据此省掉原版没有的棋盘飘字（得卡的 🃏、董事长赠品的 🎁） */
export function classicPopupHostActive(): boolean {
  return classicProbe !== null;
}

/** 登记跳过回调（handler 用来提前结束等待）；返回注销函数 */
export function onPopupSkip(id: number, cb: () => void): () => void {
  skipListeners.set(id, cb);
  return () => {
    if (skipListeners.get(id) === cb) skipListeners.delete(id);
  };
}

export const usePopupStore = create<PopupState>()((set, get) => ({
  current: null,
  auction: null,
  classicShown: null,
  setClassicShown: (classicShown) => set({ classicShown }),
  open: (spec, ms, minMs = Math.min(ms, 1200), speed = 1) => {
    const id = ++seq;
    const k = speed > 0 ? speed : 1;
    set({ current: { ...spec, popupId: id, ms, realMs: ms / k, minMs: minMs / k } as OpenPopup });
    return id;
  },
  close: (id) => {
    if (get().current?.popupId === id) set({ current: null });
    if (get().classicShown?.popupId === id) set({ classicShown: null });
    skipListeners.delete(id);
  },
  skip: (id) => {
    skipListeners.get(id)?.();
  },
  setAuction: (auction) => set({ auction }),
  patchAuction: (patch) => {
    const cur = get().auction;
    if (cur) set({ auction: { ...cur, ...patch } });
  },
  clear: () => {
    skipListeners.clear();
    set({ current: null, auction: null, classicShown: null });
  },
}));
