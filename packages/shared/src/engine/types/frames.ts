/**
 * 解释器帧（design/engine.md §6.1）。帧里只放可序列化的原始数据；可能被决策打断的帧必须把游标
 * （stage、cursor、idx）写在帧里，从任意中断点读档都能继续。FRAME_HANDLERS 用 satisfies 对 FrameKind 穷举。
 *
 * 这里的辅助结构（TollQuote、FeeQuote、FrameData 等）是 M1 的起步定义，规则实现时可以按需细化。
 */
import type { DecisionKind } from './decision';
import type {
  ActorRef,
  CardId,
  Cause,
  FateId,
  ItemId,
  LotId,
  MagicConditionId,
  MagicEffectId,
  MoneyReason,
  NewsId,
  Party,
  SeatIndex,
  TileId,
  VillainKind,
} from './ids';
import type { UseTarget } from './intent';

/** 帧内的附加数据：只允许 JSON 标量与标量数组 */
export type FrameValue = number | string | boolean | null | number[] | string[];
export type FrameData = Record<string, FrameValue>;

/** 日推进阶段（design/engine.md §7.9） */
export type DayStage = 'date' | 'victory' | 'pi' | 'market' | 'holiday' | 'd15' | 'month' | 'lots' | 'end';

export type ConfineWhere = 'jail' | 'hospital' | 'away' | 'hotel';

/** 由通用 ASK 帧发出的决策；其余由各自的专用帧发出 */
export type SimpleAskKind = Exclude<DecisionKind, 'TURN_MENU' | 'BANK_ATM' | 'BANK_COUNTER' | 'SHOP' | 'AUCTION_BID'>;

/** 过路费修正（TOLL_PAID.mods 与 TollQuote.mods 共用） */
export type TollMod =
  | 'street' // 同名路段累加
  | 'chain' // 连锁店
  | 'raise' // 涨价 ×2（只翻倍地主那一份）
  | 'alliance' // 同盟分账
  | 'smallWealth' // 小财神 ÷2
  | 'bigWealth' // 大财神 免付
  | 'smallPoor' // 小穷神 ×1.5 或 ×2
  | 'bigPoor' // 大穷神 ×2
  | 'deathPays' // 死神附身者代付
  | 'priceIndex'; // 乘物价指数

/** 九种免收过路费的情形（按判定顺序，@source docs/research/r_property.md） */
export type TollExemptReason =
  | 'sealed'
  | 'ally'
  | 'ownerDeathGod'
  | 'ownerHotel'
  | 'ownerAway'
  | 'ownerJail'
  | 'ownerHospital'
  | 'ownerHibernate'
  | 'ownerSleepwalk';

export interface TollQuote {
  owner: SeatIndex;
  /** 参与累加的同名路段地块 */
  lots: LotId[];
  /** 修正前的基数 */
  base: number;
  /** 最终应付总额 */
  amount: number;
  ally: SeatIndex | null;
  allyAmount: number;
  mods: TollMod[];
  /** 实际付款人（死神代付时不是落点者） */
  payer: SeatIndex;
}

export type FeeKind = 'hotel' | 'mall' | 'gas' | 'company';

export interface FeeQuote {
  /** 企业格时为董事长；无董事长不收费 */
  owner: SeatIndex | null;
  amount: number;
  /** 转盘结果（旅馆天数、购物中心倍数、航空、保险）；没有转盘为 null */
  wheel: number | null;
  mods: TollMod[];
}

/** 本次付款允许询问的被动卡 */
export interface PassiveSet {
  free: boolean;
  scapegoat: boolean;
}

export type AuctionSource = 'card' | 'bankrupt' | 'surrender' | 'news' | 'magic';

export interface AuctionBidder {
  seat: SeatIndex;
  st: 'active' | 'passed' | 'quit';
}

interface FrameBase {
  fid: number;
}

export type Frame = FrameBase &
  (
    | { k: 'ROOT'; stage: 'seat' | 'villains' | 'day'; nextSeatFrom: number; villainIdx: number }
    | { k: 'TURN'; seat: SeatIndex; stage: 'start' | 'menu' | 'rolled' | 'landed' | 'end' }
    | {
        k: 'MOVE';
        actor: ActorRef;
        remaining: number;
        total: number;
        seg: TileId[];
        mode: 'normal' | 'sleepwalk' | 'return' | 'villain';
        bankPassed: boolean;
      }
    | {
        k: 'LAND';
        actor: ActorRef;
        node: TileId;
        steps: number;
        stage: 'beggar' | 'object' | 'square' | 'tail' | 'lab' | 'done';
        skipSquare: boolean;
      }
    | { k: 'ASK'; seat: SeatIndex; kind: SimpleAskKind; data: FrameData; stage: 'ask' | 'done' }
    | {
        k: 'TOLL';
        payer: SeatIndex;
        lot: LotId;
        stage: 'compute' | 'free' | 'scapegoat' | 'pay' | 'done';
        q: TollQuote | null;
      }
    | { k: 'FEE'; payer: SeatIndex; lot: LotId; feeKind: FeeKind; stage: string; q: FeeQuote | null }
    | {
        k: 'PAYX';
        payer: SeatIndex;
        to: Party;
        amount: number;
        reason: MoneyReason;
        passive: PassiveSet;
        stage: string;
      }
    | {
        k: 'CONFINE';
        actor: ActorRef;
        where: ConfineWhere;
        days: number;
        cause: Cause;
        passive: boolean;
        blessing: boolean;
        stage: 'hostility' | 'exempt' | 'scapegoat' | 'bless' | 'apply' | 'revenge' | 'done';
      }
    | { k: 'CARD'; seat: SeatIndex; card: CardId; target: UseTarget; stage: string; data: FrameData }
    | { k: 'ITEM'; seat: SeatIndex; item: ItemId; target: UseTarget; stage: string; data: FrameData }
    | { k: 'GOD'; seat: SeatIndex; slot: number; stage: 'displace' | 'attach' | 'power' | 'done'; cursor: number }
    | { k: 'NEWS'; id: NewsId; stage: string; data: FrameData }
    | { k: 'FATE'; seat: SeatIndex; id: FateId; stage: string; data: FrameData }
    | {
        k: 'MAGIC';
        caster: SeatIndex;
        cond: MagicConditionId;
        targets: SeatIndex[];
        effect: MagicEffectId | null;
        idx: number;
        stage: string;
      }
    | { k: 'BANK'; seat: SeatIndex; mode: 'pass' | 'stop'; stage: 'atm' | 'counter' | 'done' }
    | { k: 'SHOP'; seat: SeatIndex; shelf: CardId[]; stage: 'gift' | 'open' | 'done' }
    | {
        k: 'AUCTION';
        lot: LotId;
        seller: SeatIndex | null;
        source: AuctionSource;
        start: number;
        price: number;
        leader: SeatIndex | null;
        bidders: AuctionBidder[];
        unsold: 'ownerless' | 'keep';
        stage: 'ask' | 'wait' | 'settle';
      }
    | {
        k: 'BANKRUPT';
        seat: SeatIndex;
        cause: Cause;
        creditor: Party | null;
        stage: 'detach' | 'endcheck' | 'liquidate' | 'auctions' | 'beggar' | 'done';
        auctionLots: LotId[];
      }
    | { k: 'SURRENDER'; seat: SeatIndex; stage: 'liquidate' | 'auctions' | 'target' | 'done'; auctionLots: LotId[] }
    | { k: 'DAY'; stage: DayStage; cursor: number }
    | { k: 'VILLAIN'; v: VillainKind; stage: 'start' | 'moving' | 'act' | 'done' }
  );

export type FrameKind = Frame['k'];
export type FrameOf<K extends FrameKind> = Extract<Frame, { k: K }>;

export const FRAME_KINDS = Object.freeze([
  'ROOT',
  'TURN',
  'MOVE',
  'LAND',
  'ASK',
  'TOLL',
  'FEE',
  'PAYX',
  'CONFINE',
  'CARD',
  'ITEM',
  'GOD',
  'NEWS',
  'FATE',
  'MAGIC',
  'BANK',
  'SHOP',
  'AUCTION',
  'BANKRUPT',
  'SURRENDER',
  'DAY',
  'VILLAIN',
] as const) satisfies readonly FrameKind[];
