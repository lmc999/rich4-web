/**
 * 解释器帧（design/engine.md §6.1）。帧里只放可序列化的原始数据；可能被决策打断的帧必须把游标
 * （stage、cursor、idx）写在帧里，从任意中断点读档都能继续。FRAME_HANDLERS 用 satisfies 对 FrameKind 穷举。
 *
 * 这里的辅助结构（TollQuote、FeeQuote、FrameData 等）是 M1 的起步定义，规则实现时可以按需细化。
 */
import type { DecisionKind, ShopTradeRecord } from './decision';
import type {
  ActorRef,
  CardId,
  Cause,
  CompanyLotId,
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

/**
 * FEE 帧的阶段：compute（报价、免收、转盘）→ free（免费卡）→ scapegoat（嫁祸卡）→ pay（死神代付）→ after
 * （住旅馆、航空出国、保险投保）→ subscribe（企业：现场认购）→ done
 */
export type FeeStage = 'compute' | 'free' | 'scapegoat' | 'pay' | 'after' | 'subscribe' | 'done';

export interface FeeQuote {
  /** 企业格时为董事长；无董事长不收费 */
  owner: SeatIndex | null;
  /** 实际付款人（嫁祸、死神代付后改写；住宿、出国、投保仍落在落点者身上 ⚑） */
  payer: SeatIndex;
  amount: number;
  /** 转盘结果（旅馆天数、购物中心倍数、航空出国天数、保险投保天数）；没有转盘为 null */
  wheel: number | null;
  mods: TollMod[];
  /** 企业格的行业码；设施为 null */
  industry: number | null;
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
    | {
        k: 'FEE';
        payer: SeatIndex;
        lot: LotId;
        feeKind: FeeKind;
        /** 本次掷骰总步数（加油站、汽车 / 石油、门派按步数收费） */
        steps: number;
        stage: FeeStage;
        q: FeeQuote | null;
      }
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
        /**
         * 带被动卡的关押（陷害卡、新闻 29、魔法屋、命运坐牢；design/engine.md §10.3）：
         * hostility → bless（命运：福运加持）→ exempt（免罪）→ scapegoat（嫁祸，SCAPEGOAT）→ apply → revenge（复仇）→ done
         */
        k: 'CONFINE';
        actor: ActorRef;
        where: ConfineWhere;
        days: number;
        cause: Cause;
        /** 走免罪 / 嫁祸 */
        passive: boolean;
        /** 命运：先做福运加持判定（high 逃过此劫，low 天数 ×2） */
        blessing: boolean;
        /** 被害者对 cause.by 的敌意增量（0 不记） */
        hate: number;
        /** 原目标（复仇判定：最终目标 == 原目标）；恶人或不适用时为 null */
        orig: SeatIndex | null;
        /** 被嫁祸回 cause.by 时改写的天数（陷害卡 4）；null 不改 */
        selfDays: number | null;
        /** 复仇卡适用（只有陷害卡） */
        revenge: boolean;
        /** 已改嫁（新目标不再检查被动卡） */
        scapegoated: boolean;
        /** 施加前先毁掉最终目标的座驾（命运 12/13「先毁座驾再住院」）；旧存档缺字段按 false */
        wreck: boolean;
        stage: 'hostility' | 'bless' | 'exempt' | 'scapegoat' | 'apply' | 'revenge' | 'done';
      }
    | { k: 'CARD'; seat: SeatIndex; card: CardId; target: UseTarget; stage: string; data: FrameData }
    | { k: 'ITEM'; seat: SeatIndex; item: ItemId; target: UseTarget; stage: string; data: FrameData }
    | {
        /** 附身：displace（挤走旧神）→ attach → power（发威）→ done；cursor 记被挤走的神的种类（0 表示没有） */
        k: 'GOD';
        seat: SeatIndex;
        slot: number;
        stage: 'displace' | 'attach' | 'power' | 'done';
        cursor: number;
      }
    | {
        /**
         * 新闻（effects/news）：apply（抽定目标、公布、结算，可能压子帧）→ done；
         * 新闻 11/12/13 的税：apply 公布后转入 tax，按座位逐人收（data.seats 名单、data.idx 游标），有人付不起时
         * 先返回、等他的 BANKRUPT 帧处理完再收下一人 → done
         */
        k: 'NEWS';
        id: NewsId;
        stage: 'apply' | 'tax' | 'done';
        data: FrameData;
      }
    | {
        /**
         * 命运（effects/fate）：draw（魔法屋「连抽三张」时现抽）→ bless（加持判定）→ apply → 罚金类：free（免费卡，
         * rules.freeCardOnFines）→ scapegoat → pay → insure（保险赔付）→ done；生日：pick（真人 BIRTHDAY_PICK）→ done
         */
        k: 'FATE';
        seat: SeatIndex;
        id: FateId;
        stage: 'draw' | 'bless' | 'apply' | 'pick' | 'free' | 'scapegoat' | 'pay' | 'insure' | 'done';
        data: FrameData;
      }
    | {
        /** 魔法屋（effects/magic）：cond（抽条件）→ cast（MAGIC_CAST 决策）→ apply（名单逐人，idx 为游标）→ done */
        k: 'MAGIC';
        caster: SeatIndex;
        cond: MagicConditionId;
        targets: SeatIndex[];
        effect: MagicEffectId | null;
        idx: number;
        stage: 'cond' | 'cast' | 'apply' | 'done';
      }
    | { k: 'BANK'; seat: SeatIndex; mode: 'pass' | 'stop'; stage: 'atm' | 'counter' | 'done' }
    | {
        k: 'SHOP';
        seat: SeatIndex;
        /** 百货公司（落点格的 ref.lot）；董事长进店先得赠品 */
        company: CompanyLotId | null;
        /** 真人座位的货架（进店时抽定）；电脑座位面对整副牌堆，货架为空 */
        shelf: CardId[];
        /**
         * 本次进店是否面对整副牌堆（进店 'gift' 阶段按当时的 controller 定下，之后不随 SYS_SET_CONTROLLER 改变，
         * 保证已发出的 SHOP options 与 shelfIdx 的解释一致）；进店前为 null
         */
        fullDeck: boolean | null;
        /** 进店时的点券（AI 推算预算用） */
        entryPoints: number;
        /** 本次进店已完成的交易（按顺序） */
        trades: ShopTradeRecord[];
        stage: 'gift' | 'open' | 'done';
      }
    | {
        /**
         * 并发拍卖（flow/auction.ts；design/engine.md §9.5）：start（AUCTION_STARTED）→ ask（给每个可出价、手上没有待答决策的
         * 竞拍者各发一个 AUCTION_BID）→ wait（等回答；BID 清掉其余待答、PASS 只清自己）→ ask … → settle → done
         */
        k: 'AUCTION';
        lot: LotId;
        /** 成交款的收款人（拍卖卡：出卡者；魔法屋：目标玩家）；null 表示进公库（破产、投降、新闻） */
        seller: SeatIndex | null;
        source: AuctionSource;
        start: number;
        price: number;
        leader: SeatIndex | null;
        bidders: AuctionBidder[];
        unsold: 'ownerless' | 'keep';
        stage: 'start' | 'ask' | 'wait' | 'settle' | 'done';
      }
    | {
        k: 'BANKRUPT';
        seat: SeatIndex;
        cause: Cause;
        creditor: Party | null;
        stage: 'detach' | 'endcheck' | 'liquidate' | 'auctions' | 'beggar' | 'done';
        auctionLots: LotId[];
      }
    | {
        /**
         * 投降（flow/surrender.ts）：announce（SURRENDERED）→ target（DEATH_GOD_TARGET：召唤死神附身一名对手）→ detach
         * → endcheck → liquidate → auctions（> 3 处随机拍 3 处，成交款进公库）→ beggar → done
         */
        k: 'SURRENDER';
        seat: SeatIndex;
        stage: 'announce' | 'target' | 'detach' | 'endcheck' | 'liquidate' | 'auctions' | 'beggar' | 'done';
        auctionLots: LotId[];
      }
    | { k: 'DAY'; stage: DayStage; cursor: number }
    | {
        /** 四大恶人的回合（flow/villain.ts）：start（计数器倒数、步数）→ 压 MOVE(villain) → done（TURN_ENDED） */
        k: 'VILLAIN';
        v: VillainKind;
        stage: 'start' | 'moving' | 'act' | 'done';
      }
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
