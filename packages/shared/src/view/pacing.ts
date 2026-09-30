/**
 * 动画时长预算（architecture §5.9；design/net.md §5.4；original-skin.md U3、§3 修正 1）。服务器用它计算截止时间
 * （动画不占用思考时间），客户端把 handler 封顶在预算内、开发模式下超预算 10% 告警。两端引用同一份常量。
 *
 * 演出节奏 profile（房间设置 RoomSettings.pacing，默认 original）：
 * - compact：紧凑预算（M2 起的初版，按原版节奏粗估、M3/M10 实测调整）；原版皮肤的 FLIC 在里面加速或截取（playFit）。
 * - original：以原版 FLIC 原长为准——有 FLIC 的事件预算 = max(compact, FLIC 原长 + handler 里 FLIC 之外的等待 + 余量)，
 *   保证原版皮肤能按原速完整播完（playFit 的可用时长 = 预算 − 其他等待 ≥ FLIC 原长）；亮卡的事件（出卡、被动卡生效）
 *   按原版亮卡的 1.5 秒（CARD_SHOW_MS）放宽；其余事件与 compact 完全相同。original 的每一项都 ≥ compact。
 *
 * 调整预算只影响倒计时公平性与演出节奏，不影响规则。
 */
import type { DiceCount, GameEvent, GameEventOf, GameEventType, GodKind, StrikeKind } from '../engine/types/index';

/** 演出节奏（与 net/timing 的 PacingProfile 相同：view 不能依赖 net，两处字面量由测试对齐） */
export type PacingProfile = 'original' | 'compact';
export const PACING_PROFILES: readonly PacingProfile[] = Object.freeze(['original', 'compact'] as const);
/** 新房间的默认节奏（U3：完整播放原版 FLIC 与动画） */
export const DEFAULT_PACING: PacingProfile = 'original';

/** 棋子每走一格的时长（两种节奏相同：原版行走 tick 时长未在 v2.06 核实，见 render.md §2.7） */
export const STEP_MS = 180;

/** 单个事件的预算：常数，或按载荷计算 */
export type EventBudget<T extends GameEventType> = number | ((e: GameEventOf<T>) => number);

// ───────────────────────── 掷骰（原版时序） ─────────────────────────

/**
 * 掷骰演出的原版时序（exe v2.06；v3.11 对应代码 0x419595–0x41967a 结构相同）。按下 GO（fcn.0040d7e5 0x40d84d 置 state=2、
 * 0x40d9b3 帧清零）之后：
 * 1. 持骰动作：状态机 fcn.0040d28a case 2（0x40d43b–0x40d470）每 tick 帧 +1，把持骰库（Data#87+21c+3·vehicle+2）每方向的
 *    帧数播完（步行 7–9、机车 / 汽车 4–8）才调用掷骰函数 fcn.00418d0b，人物停在最后一帧（空手）；
 *    tick = 20 ms × 分频表 0x46a9d0 [6,4,2][速度]（0x40212d timeSetEvent 20 ms，0x401f44–0x401f6b）；
 * 2. 骰子 FLC（Panel#4/5/6 = 1/2/3 颗）36 帧只播一遍，帧间隔 = 表 0x4730ec [5,3,2][速度] × 10 ms（flags bits4–7，
 *    fcn.0044f514 0x44f6fb–0x44f711，覆盖 FLC 头部的 14 ms）；第 30 帧（flags bits24–30 = 0x1e，fcn.0044f72b
 *    0x44fb9d–0x44fbc0）与播完时（0x418dc8）各放一次 Effect#10，就是「咚咚」两声；
 * 3. 画上点数面（Panel#3），忙等 500 ms（0x418e73 fcn.00450f3f）后起步。
 * 游戏速度 = RICH4.CFG 偏移 0（没有 CFG 时默认 1，0x4117fa）。original 节奏取原版默认的速度 1；compact 取速度 2
 * （与原版皮肤的行走帧间隔 40 ms 同档），落定后的停留缩短为 300 ms。停留 / 乌龟不掷骰（fcn.0040d7e5 直接起步），
 * 事件的 dice 为空，没有演出。
 * @source docs/research/original-assets/ui.md §6（FLC 帧间隔的未决项由上述 exe 地址回答）
 */
export interface DiceTiming {
  /** 持骰动作每帧（原版 tick，ms） */
  readonly throwTickMs: number;
  /** 骰子 FLC 每帧（ms） */
  readonly flicFrameMs: number;
  /** 画上点数面之后的停留（ms） */
  readonly holdMs: number;
}

export const DICE_TIMING: Readonly<Record<PacingProfile, DiceTiming>> = Object.freeze({
  original: Object.freeze({ throwTickMs: 80, flicFrameMs: 30, holdMs: 500 }),
  compact: Object.freeze({ throwTickMs: 40, flicFrameMs: 20, holdMs: 300 }),
});

/** 骰子 FLC（Panel#4/5/6）的帧数 */
export const DICE_FLIC_FRAMES = 36;
/** 第一声「咚」在 FLC 第 30 帧（1 起算；flags 0x1e000000）；第二声在播完时 */
export const DICE_KNOCK_FRAME = 30;
/** 持骰动作每方向的帧数上限（12 个角色 × 步行 / 机车 / 汽车里最多 9 帧）：事件不带交通工具，预算按它保守估计 */
export const DICE_THROW_FRAMES_MAX = 9;

/** 掷骰演出时长：持骰动作 throwFrames 帧 + FLC 36 帧 + 落定停留 */
export function diceShowMs(t: DiceTiming, throwFrames: number = DICE_THROW_FRAMES_MAX): number {
  return throwFrames * t.throwTickMs + DICE_FLIC_FRAMES * t.flicFrameMs + t.holdMs;
}

/** 掷骰事件的余量（首帧对齐与载入，约一帧） */
const DICE_SLACK_MS = 100;

// ───────────────────────── 亮卡（原版时序） ─────────────────────────

/**
 * 亮卡的展示时长：出卡（CARD_USED）与被动卡生效（PASSIVE）时，卡片插画（Data#529+k）配消息框停留多久。
 * 原版亮卡函数 fcn.00440bac 画完卡图与消息框后播 Effect#62（0x440cd2），调 fcn.00450f9a(1500)（0x440ce4）停 1.5 秒
 * （鼠标左 / 右键放开或按键放开提前结束），再恢复棋盘；出卡、被动卡（復仇 0x443311、嫁禍 0x443425、免費 0x443713、
 * 免罪 0x4437e1）都走这个函数，时长相同。original 节奏按原版 1.5 秒；compact 沿用初版的 1.2 秒 / 0.95 秒。
 * @source docs/research/original-assets/ui.md §2.2（亮卡）
 */
export interface CardShowTiming {
  /** 出卡（CARD_USED） */
  readonly castMs: number;
  /** 被动卡生效（PASSIVE） */
  readonly passiveMs: number;
}

export const CARD_SHOW_MS: Readonly<Record<PacingProfile, CardShowTiming>> = Object.freeze({
  original: Object.freeze({ castMs: 1500, passiveMs: 1500 }),
  compact: Object.freeze({ castMs: 1200, passiveMs: 950 }),
});

/** 亮卡之后 handler 的收尾等待（同步显示态、金额飘字） */
export const CARD_SHOW_TAIL_MS = 100;

/** 一种节奏的完整预算表：以 GameEvent['type'] 为键穷举 */
export type EventBudgetTable = { readonly [T in GameEventType]: EventBudget<T> };

/** compact 节奏（即原先唯一的一张表） */
export const COMPACT_BUDGET_MS = Object.freeze({
  // turn
  GAME_STARTED: 1500,
  TURN_STARTED: 600,
  PARACHUTE: 1500,
  TURN_BLOCKED: 1200,
  RELEASED: 1000,
  RETURNED: 800,
  TURN_ENDED: 0,
  // move（掷骰：原版时序的速度 2 档，见 DICE_TIMING；停留 / 乌龟不掷骰为 0）
  DICE_ROLLED: (e) => (e.dice.length === 0 ? 0 : diceShowMs(DICE_TIMING.compact) + DICE_SLACK_MS),
  MOVE_SEGMENT: (e) => e.path.length * STEP_MS + 250,
  ROADBLOCK_HIT: 800,
  REVERSED: 500,
  LANDED: 200,
  // money
  MONEY: 600,
  LOAN: 900,
  REPAY: 700,
  LOAN_REMINDER: 1200,
  LOAN_FORCED: 1200,
  ATM: 600,
  FINANCE: 900,
  RESERVE_SHORTFALL: 1000,
  INSURANCE_PAYOUT: 1200,
  POINTS_GAINED: 700,
  // property
  LAND_BOUGHT: 1000,
  LOT_LEVEL: 900,
  FACILITY_BUILT: 1000,
  LOT_MUTATED: 1200,
  TOLL_PAID: 1100,
  TOLL_EXEMPT: 800,
  FEE_PAID: (e) => (e.wheel === null ? 1100 : 2600),
  HOTEL_STAY: 1200,
  COMPANY_FEE: (e) => (e.wheel === null ? 1100 : 2600),
  SUBSCRIBED: 800,
  INVEST_BLOCKED: 900,
  CANNOT_AFFORD: 800,
  MARK_SET: 1000,
  MARK_EXPIRED: 500,
  TENURE_EXPIRED: 900,
  RESEARCH_STARTED: 800,
  RESEARCH_DONE: 1000,
  RESEARCH_CANCELLED: 600,
  // card
  CARD_GAINED: 700,
  CARD_LOST: 500,
  CARD_USED: 1400,
  CARD_NO_EFFECT: 800,
  PASSIVE: 1200,
  SHOP_OPENED: 400,
  SHOP_TRADE: 400,
  CHAIRMAN_GIFT: 1000,
  // item
  ITEM_GAINED: 600,
  ITEM_LOST: 400,
  ITEM_USED: 1200,
  VEHICLE: 900,
  VEHICLE_DESTROYED: 1000,
  OBJECT_PLACED: 600,
  OBJECT_REMOVED: 500,
  DOLL_WALK: (e) => e.path.length * STEP_MS + 400,
  BOMB_ATTACHED: 900,
  BOMB_TRANSFERRED: 900,
  BOMB_EXPLODED: 2000,
  STRIKE: 2400,
  TELEPORTED: 1400,
  TIME_REWOUND: 2000,
  // god
  GOD_ATTACHED: 1500,
  GOD_POWER: (e) => (e.slot === null ? 1600 : 3000),
  GOD_LEFT: 900,
  GOD_SPAWNED: 600,
  GOD_MANIFEST: 1800,
  DOG_BITE: 1500,
  DOG_KNOCKED: 900,
  DEATH_GOD_SUMMONED: 1800,
  // status
  CONFINED: 1500,
  BLESSING: 1200,
  STATUS_SET: 700,
  ALLIANCE_FORMED: 1200,
  ALLIANCE_BROKEN: 1000,
  ALLIANCE_EXPIRED: 700,
  BANK_REJECTED: 900,
  // event
  NEWS: 3800,
  FATE: 2600,
  MAGIC_CONDITION: 1800,
  MAGIC_CAST: 2000,
  LOTTERY_TICKET: 600,
  LOTTERY_DRAW: 4200,
  MINIGAME_STARTED: 800,
  MINIGAME_ENDED: (e) => (e.mode === 'played' ? 1500 : 2500),
  BAIL: 1000,
  VILLAIN_HIRED: 1000,
  VILLAIN_ACTION: 1600,
  VILLAIN_HOME: 600,
  BEGGAR_ALMS: 1200,
  // stock
  STOCK_TRADED: 400,
  CHAIRMAN_CHANGED: 1000,
  STOCK_FLAG: 900,
  SUSPENDED: 900,
  RESUMED: 600,
  MARKET_TICK: 0,
  MARKET_CLOSED: 0,
  LISTING_ADDED: 500,
  LISTING_REMOVED: 400,
  LISTING_SOLD: 800,
  // auction
  AUCTION_STARTED: 1500,
  AUCTION_BID: 500,
  AUCTION_PASS: 300,
  AUCTION_QUIT: 300,
  AUCTION_ENDED: 1500,
  // day
  DAY_ADVANCED: 800,
  PRICE_INDEX: 1200,
  HOLIDAY: 2000,
  DIVIDENDS: 1500,
  MONTHLY_REPORT: 3000,
  OBJECTS_RESPAWNED: 600,
  DAY_END: 0,
  // end
  BANKRUPT: 2500,
  LIQUIDATION: 1500,
  BECAME_BEGGAR: 1200,
  SURRENDERED: 2000,
  GAME_OVER: 3000,
  // system（不演出）
  CONTROLLER_CHANGED: 0,
  AI_TRAITS_CHANGED: 0,
  DEBUG_APPLIED: 0,
  SYNC: 0,
} as const satisfies EventBudgetTable);

// ───────────────────────── 原版 FLIC 时长（事实数据） ─────────────────────────

/**
 * 原版 FLIC 的时长参数：原长 = frames × frameMs（帧间隔取 FLC 头部 +16）。mkf/res 为 v2.06 资源号，
 * use 与素材包 flic-map 的用途键一致（神明降临、按角色的动画在其后另带 GodKind 名 / 角色号）。
 * @source tools/extract/src/assets/data/flic.ts（A3 flic-map 源数据，build 时按源文件头核对）
 * @source docs/research/original-assets/audio_video.md §2.3、§4.2
 */
export interface FlicTiming {
  readonly mkf: 'Data' | 'Panel';
  readonly res: number;
  readonly use: string;
  readonly frames: number;
  readonly frameMs: number;
}

/** 原长（ms） */
export function flicMs(f: FlicTiming): number {
  return f.frames * f.frameMs;
}

const flic = (mkf: FlicTiming['mkf'], res: number, use: string, frames: number, frameMs: number): FlicTiming =>
  Object.freeze({ mkf, res, use, frames, frameMs });

/** 事件演出用到的原版 FLIC（按 design-draft §3.5 的事件 → FLIC 对应；飞弹 / 核弹 / 外星人 / 台风按 A3 exe 核实结果） */
export const ORIGINAL_FLICS = Object.freeze({
  /** 烟火：节日 1/1、台湾图 10/10（节日表 0x47d6ab）；音效 90 */
  fireworks: flic('Data', 482, 'fx.fireworks', 66, 42),
  /** 救护车送医院（fcn.0043d6c0）：62 × 100 = 6.2 s，与音效 92 等长 */
  ambulance: flic('Data', 483, 'fx.ambulance', 62, 100),
  /** 小爆炸：踩到地雷 / 路面炸弹（0x41afc3、0x41b714）；音效 82 */
  explosionSmall: flic('Data', 484, 'fx.explosion.small', 8, 114),
  /** 烟雾 110×110：神明离身（推断，visual）；音效 95 */
  godLeave: flic('Data', 485, 'fx.godLeave', 8, 114),
  /** 碎屑爆炸：大爆炸（身上的定时炸弹）；音效 87 */
  explosionBig: flic('Data', 486, 'fx.gasExplosion', 41, 71),
  /** 飞弹命中（0x445c2d）；音效 81 */
  missile: flic('Data', 487, 'fx.missile', 19, 114),
  /** 核子飞弹蘑菇云（0x446751）；音效 83 */
  nuke: flic('Data', 489, 'fx.nuke', 26, 114),
  /** 天降光束与穹顶爆炸：新闻 4 外星人攻打地球（0x447df6）；音效 86 */
  alienAttack: flic('Data', 490, 'fx.alienAttack', 36, 114),
  /** 超级台风：新闻 20（0x4496cc）；音效 89 */
  typhoon: flic('Data', 493, 'fx.typhoon', 15, 71),
  /** 卡片翻出问号：卡片格得卡（0x41abb2）；音效 99 */
  cardGain: flic('Data', 495, 'fx.cardGain', 14, 71),
  /** 旋转的点券：点券格（0x41aa34、0x41aace、0x41ab52）；音效 98 */
  pointsGain: flic('Data', 496, 'fx.pointsGain', 14, 71),
  /** 警车押送坐牢（fcn.0043c03f）：35 × 71 ≈ 2.49 s；音效 94 */
  policeCar: flic('Data', 497, 'fx.policeCar', 35, 71),
  /** 圣诞（节日表 12/25）；音效 114 */
  christmas: flic('Data', 513, 'holiday.christmas', 90, 85),
  /** 房屋倒塌：破产（fcn.0040c84d）；音效 100 */
  bankrupt: flic('Data', 514, 'fx.bankrupt', 10, 71),
  /**
   * 骰子 1 / 2 / 3 颗：FLC 头部写 14 ms；exe 播放时用 flags 覆盖帧间隔（表 0x4730ec [5,3,2]×10 ms），实际时长见
   * DICE_TIMING / DICE_ROLLED 的预留（这里保留文件头的事实值，与 flic-map 源数据一致）
   */
  dice1: flic('Panel', 4, 'dice.roll1', 36, 14),
  dice2: flic('Panel', 5, 'dice.roll2', 36, 14),
  dice3: flic('Panel', 6, 'dice.roll3', 36, 14),
  /** 乐透摇奖机（不透明） */
  lotteryMachine: flic('Panel', 16, 'lottery.machine', 42, 71),
  /** 魔法屋施法（640×480 不透明） */
  magicCast: flic('Panel', 20, 'magic.cast', 25, 71),
} as const);

/** 神明降临：GodKind → FLIC（exe 神明降临 switch 0x40e6b2 逐项解出）；恶犬（11）不附身，没有降临动画 */
export const GOD_ARRIVAL_FLICS: Readonly<Partial<Record<GodKind, FlicTiming>>> = Object.freeze({
  1: flic('Data', 499, 'god.arrive', 21, 100),
  2: flic('Data', 500, 'god.arrive', 21, 100),
  3: flic('Data', 501, 'god.arrive', 21, 128),
  4: flic('Data', 502, 'god.arrive', 35, 100),
  5: flic('Data', 503, 'god.arrive', 28, 100),
  6: flic('Data', 504, 'god.arrive', 30, 100),
  7: flic('Data', 505, 'god.arrive', 14, 100),
  8: flic('Data', 506, 'god.arrive', 19, 100),
  9: flic('Data', 507, 'god.arrive', 16, 100),
  10: flic('Data', 508, 'god.arrive', 12, 100),
  12: flic('Data', 509, 'god.arrive', 23, 71),
  15: flic('Data', 510, 'god.arrive', 15, 100),
});

/** 棋盘上的开局跳伞：角色号 0..11 → Data 518..529（帧间隔 42 ms） */
export const PARACHUTE_FLICS: readonly FlicTiming[] = Object.freeze(
  [34, 35, 34, 39, 30, 40, 33, 39, 30, 39, 33, 35].map((frames, c) =>
    flic('Data', 518 + c, 'char.parachuteBoard', frames, 42),
  ),
);

const LONGEST_PARACHUTE = PARACHUTE_FLICS.reduce((a, b) => (flicMs(b) > flicMs(a) ? b : a));

/** 骰子 FLC 实际的播放时长：帧间隔按 exe 覆盖后的原版默认速度 1（DICE_TIMING.original），不用文件头的 14 ms */
const playedDice = (f: FlicTiming): FlicTiming =>
  flic(f.mkf, f.res, f.use, DICE_FLIC_FRAMES, DICE_TIMING.original.flicFrameMs);
const DICE_FLICS: Readonly<Record<DiceCount, FlicTiming>> = {
  1: playedDice(ORIGINAL_FLICS.dice1),
  2: playedDice(ORIGINAL_FLICS.dice2),
  3: playedDice(ORIGINAL_FLICS.dice3),
};

const STRIKE_FLICS: Readonly<Record<StrikeKind, FlicTiming | null>> = {
  missile: ORIGINAL_FLICS.missile,
  nuke: ORIGINAL_FLICS.nuke,
  alien: ORIGINAL_FLICS.alienAttack,
  typhoon: ORIGINAL_FLICS.typhoon,
  // 手动引爆的 3×3 炸弹没有独立的原版动画（随后的 BOMB_EXPLODED 另有预算）
  bomb3x3: null,
};

// ───────────────────────── 事件 → FLIC（original 节奏） ─────────────────────────

/** original 节奏为事件预留的 FLIC：选哪段，以及 handler 里 FLIC 之外的等待（镜头、弹窗、收尾） */
interface FlicReserve<T extends GameEventType> {
  /** handler 里 FLIC 之外的等待（1x，ms），按现有 handlers 的非特效等待计 */
  readonly extraMs: number;
  readonly flic: (e: GameEventOf<T>) => FlicTiming | null;
}

/** FLIC 首帧对齐与收尾的余量（约一帧） */
export const FLIC_SLACK_MS = 100;

/**
 * 有原版 FLIC 的事件（design-draft §3.5 的对应表）。表里没有的事件 original = compact。
 * - HOLIDAY：送卡的节日即圣诞（513）；其余按烟火（482）预留——事件不带地图的节日 flags，没有 FLIC 的节日会多等不到 1 秒。
 * - PARACHUTE：事件不带角色号，按 12 个角色里最长的一段预留。
 * - CARD_GAINED / POINTS_GAINED：原版只在落到卡片格 / 点券格时播放（exe 调用点都在落点处理里）。
 * - OBJECT_REMOVED：被踩中的地雷 / 路面炸弹（与 handlers/items.ts 的 removalOf → 'boom' 同一口径）。
 * - DICE_ROLLED：按实际掷出的颗数（遥控骰子只有 1 颗）；FLC 之外是持骰动作（按最多 9 帧）与落定停留（DICE_TIMING.original）；
 *   停留 / 乌龟不掷骰（dice 为空）没有预留。
 * - LOTTERY_DRAW、BANKRUPT：原长本来就在 compact 预算内，列出只为给原版皮肤同一份对应表。
 */
const FLIC_RESERVES = {
  PARACHUTE: { extraMs: 600, flic: () => LONGEST_PARACHUTE },
  DICE_ROLLED: {
    extraMs: diceShowMs(DICE_TIMING.original) - DICE_FLIC_FRAMES * DICE_TIMING.original.flicFrameMs,
    flic: (e) => (e.dice.length === 0 ? null : DICE_FLICS[Math.min(3, e.dice.length) as DiceCount]),
  },
  POINTS_GAINED: { extraMs: 0, flic: (e) => (e.source === 'square' ? ORIGINAL_FLICS.pointsGain : null) },
  CARD_GAINED: { extraMs: 0, flic: (e) => (e.source === 'square' ? ORIGINAL_FLICS.cardGain : null) },
  OBJECT_REMOVED: {
    extraMs: 0,
    flic: (e) =>
      e.cause.k === 'object' && (e.obj.kind === 'mine' || e.obj.kind === 'bomb') ? ORIGINAL_FLICS.explosionSmall : null,
  },
  BOMB_EXPLODED: { extraMs: 700, flic: () => ORIGINAL_FLICS.explosionBig },
  STRIKE: { extraMs: 550, flic: (e) => STRIKE_FLICS[e.kind] },
  GOD_ATTACHED: { extraMs: 100, flic: (e) => GOD_ARRIVAL_FLICS[e.kind] ?? null },
  GOD_LEFT: { extraMs: 100, flic: () => ORIGINAL_FLICS.godLeave },
  CONFINED: {
    extraMs: 350,
    flic: (e) =>
      e.actor.t !== 'seat'
        ? null
        : e.where === 'hospital'
          ? ORIGINAL_FLICS.ambulance
          : e.where === 'jail'
            ? ORIGINAL_FLICS.policeCar
            : null,
  },
  MAGIC_CAST: { extraMs: 200, flic: () => ORIGINAL_FLICS.magicCast },
  LOTTERY_DRAW: { extraMs: 300, flic: () => ORIGINAL_FLICS.lotteryMachine },
  HOLIDAY: { extraMs: 0, flic: (e) => (e.giveCard ? ORIGINAL_FLICS.christmas : ORIGINAL_FLICS.fireworks) },
  BANKRUPT: { extraMs: 0, flic: () => ORIGINAL_FLICS.bankrupt },
} as const satisfies { readonly [T in GameEventType]?: FlicReserve<T> };

type FlicEventType = keyof typeof FLIC_RESERVES;

/** original 节奏里有 FLIC 预留的事件类型 */
export const FLIC_EVENT_TYPES: readonly FlicEventType[] = Object.freeze(Object.keys(FLIC_RESERVES) as FlicEventType[]);

/**
 * original 节奏为这个事件预留的 FLIC 与 FLIC 之外的等待；没有预留时为 null。
 * 原版皮肤按它安排 playFit：可用时长 = eventBudgetMs(e, 'original') − extraMs ≥ FLIC 原长。
 */
export function flicReserveOf(e: GameEvent): { flic: FlicTiming; extraMs: number } | null {
  const r = (FLIC_RESERVES as Partial<Record<GameEventType, FlicReserve<GameEventType>>>)[e.type];
  if (!r) return null;
  const f = r.flic(e as never);
  return f ? { flic: f, extraMs: r.extraMs } : null;
}

function budgetFrom(table: EventBudgetTable, e: GameEvent): number {
  const b = table[e.type] as number | ((x: GameEvent) => number);
  const ms = typeof b === 'number' ? b : b(e);
  return Number.isFinite(ms) && ms > 0 ? Math.trunc(ms) : 0;
}

/** original 预算 = max(compact, FLIC 原长 + FLIC 之外的等待 + 余量)；没有预留时等于 compact */
function originalBudget(e: GameEvent): number {
  const compact = budgetFrom(COMPACT_BUDGET_MS, e);
  const r = flicReserveOf(e);
  return r === null ? compact : Math.max(compact, flicMs(r.flic) + r.extraMs + FLIC_SLACK_MS);
}

function originalOverrides(): { readonly [T in FlicEventType]: (e: GameEventOf<T>) => number } {
  const out: Record<string, (e: GameEvent) => number> = {};
  for (const t of FLIC_EVENT_TYPES) out[t] = originalBudget;
  return out as unknown as { readonly [T in FlicEventType]: (e: GameEventOf<T>) => number };
}

/** 亮卡事件的 original 预算 = max(compact, 原版 1.5 秒 + 收尾 + 余量) */
const cardShowBudget = (type: 'CARD_USED' | 'PASSIVE', showMs: number): number =>
  Math.max(COMPACT_BUDGET_MS[type], showMs + CARD_SHOW_TAIL_MS + FLIC_SLACK_MS);

/** original 节奏里按原版亮卡时长放宽的事件类型 */
export const CARD_SHOW_EVENT_TYPES = Object.freeze(['CARD_USED', 'PASSIVE'] as const);

/** original 节奏：有 FLIC 预留的事件按原长放宽，亮卡的事件按原版 1.5 秒放宽，其余沿用 compact */
export const ORIGINAL_BUDGET_MS: EventBudgetTable = Object.freeze({
  ...COMPACT_BUDGET_MS,
  ...originalOverrides(),
  CARD_USED: cardShowBudget('CARD_USED', CARD_SHOW_MS.original.castMs),
  PASSIVE: cardShowBudget('PASSIVE', CARD_SHOW_MS.original.passiveMs),
} satisfies EventBudgetTable);

/** 按节奏取预算表：EVENT_BUDGET_MS[profile][type] */
export const EVENT_BUDGET_MS: Readonly<Record<PacingProfile, EventBudgetTable>> = Object.freeze({
  original: ORIGINAL_BUDGET_MS,
  compact: COMPACT_BUDGET_MS,
});

/**
 * 单个事件的预算（ms，非负整数）。profile 缺省为 compact（最紧的口径，与旧调用方一致）；
 * 服务器按房间节奏显式传入，客户端经 presentation/handlers/budget 取当前房间的节奏。
 */
export function eventBudgetMs(e: GameEvent, profile: PacingProfile = 'compact'): number {
  return budgetFrom(EVENT_BUDGET_MS[profile] ?? COMPACT_BUDGET_MS, e);
}

/** 一批事件的动画总时长（顺序播放，直接求和）；profile 缺省同 eventBudgetMs */
export function estimateAnimMs(events: readonly GameEvent[], profile: PacingProfile = 'compact'): number {
  let total = 0;
  for (const e of events) total += eventBudgetMs(e, profile);
  return total;
}
