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
  card: CardId;
  cardName: string;
  desc: string;
  /** 顶部标题（「使用卡片」「被动卡生效」「没有效果」） */
  title: string;
  targetText: string | null;
  variant: 'cast' | 'passive' | 'fizzle';
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

export interface PopupState {
  current: OpenPopup | null;
  auction: AuctionBannerState | null;
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
  open: (spec, ms, minMs = Math.min(ms, 1200), speed = 1) => {
    const id = ++seq;
    const k = speed > 0 ? speed : 1;
    set({ current: { ...spec, popupId: id, ms, realMs: ms / k, minMs: minMs / k } as OpenPopup });
    return id;
  },
  close: (id) => {
    if (get().current?.popupId === id) set({ current: null });
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
    set({ current: null, auction: null });
  },
}));
