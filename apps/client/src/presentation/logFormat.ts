// 事件 → 中文日志行（design/client.md §2 logFormat）。对 GameEvent['type'] 穷举；返回 null 表示不记日志。
// 文案模板在 i18n events:log.<TYPE>，参数里的名字、金额已经格式化。
import type { GameEvent, GameEventOf, GameEventType } from '@rich4/shared/engine';
import type { NameKit } from './names';

type Fmt<T extends GameEventType> = (e: GameEventOf<T>, n: NameKit) => string | null;

const L = (n: NameKit, type: GameEventType, params: Record<string, unknown> = {}, variant?: string): string =>
  n.t(`events:log.${type}${variant ? `_${variant}` : ''}`, params);

const m = (n: NameKit, x: number): string => n.money(x);

export const LOG_FORMAT = {
  GAME_STARTED: (e, n) => L(n, 'GAME_STARTED', { date: n.date(e.date), n: e.seats.length }),
  TURN_STARTED: (e, n) => L(n, 'TURN_STARTED', { who: n.actor(e.actor), turnNo: e.turnNo }),
  PARACHUTE: (e, n) => L(n, 'PARACHUTE', { who: n.seat(e.seat), tile: n.tile(e.node) }),
  TURN_BLOCKED: (e, n) =>
    L(n, 'TURN_BLOCKED', {
      who: n.seat(e.seat),
      reason: n.t(`events:blocked.${e.reason}`, { defaultValue: e.reason }),
      n: e.remaining,
    }),
  RELEASED: (e, n) => L(n, 'RELEASED', { who: n.actor(e.actor) }),
  RETURNED: (e, n) => L(n, 'RETURNED', { who: n.seat(e.seat) }),
  TURN_ENDED: () => null,
  DICE_ROLLED: (e, n) =>
    L(
      n,
      'DICE_ROLLED',
      { who: n.seat(e.seat), dice: e.dice.join(' + '), steps: e.steps },
      e.forced ? 'forced' : undefined,
    ),
  MOVE_SEGMENT: () => null,
  ROADBLOCK_HIT: (e, n) => L(n, 'ROADBLOCK_HIT', { who: n.actor(e.actor) }),
  REVERSED: (e, n) => L(n, 'REVERSED', { who: n.actor(e.actor) }),
  LANDED: (e, n) => (e.actor.t === 'seat' ? L(n, 'LANDED', { who: n.actor(e.actor), tile: n.tile(e.node) }) : null),
  MONEY: (e, n) =>
    L(n, 'MONEY', {
      from: n.party(e.from),
      to: n.party(e.to),
      amount: m(n, e.paid),
      reason: n.t(`events:reason.${e.reason}`, { defaultValue: e.reason }),
    }),
  LOAN: (e, n) => L(n, 'LOAN', { who: n.seat(e.seat), amount: m(n, e.amount), due: n.date(e.due) }),
  REPAY: (e, n) => L(n, 'REPAY', { who: n.seat(e.seat), amount: m(n, e.amount) }),
  LOAN_REMINDER: (e, n) => L(n, 'LOAN_REMINDER', { who: n.seat(e.seat), n: e.daysLeft }),
  LOAN_FORCED: (e, n) => L(n, 'LOAN_FORCED', { who: n.seat(e.seat), amount: m(n, e.paid) }),
  ATM: (e, n) => L(n, 'ATM', { who: n.seat(e.seat), amount: m(n, e.amount) }, e.op),
  FINANCE: (e, n) => L(n, 'FINANCE', { who: n.seat(e.seat), amount: m(n, e.amount) }),
  RESERVE_SHORTFALL: (e, n) => L(n, 'RESERVE_SHORTFALL', { who: n.seat(e.chairman), amount: m(n, e.amount) }),
  INSURANCE_PAYOUT: (e, n) => L(n, 'INSURANCE_PAYOUT', { who: n.seat(e.seat), amount: m(n, e.amount) }),
  POINTS_GAINED: (e, n) => L(n, 'POINTS_GAINED', { who: n.seat(e.seat), amount: e.amount }),
  LAND_BOUGHT: (e, n) => L(n, 'LAND_BOUGHT', { who: n.seat(e.seat), lot: n.lot(e.lot), price: m(n, e.price) }),
  LOT_LEVEL: (e, n) => L(n, 'LOT_LEVEL', { lot: n.lot(e.lot), from: e.from, to: e.to }, e.to > e.from ? 'up' : 'down'),
  FACILITY_BUILT: (e, n) =>
    L(n, 'FACILITY_BUILT', {
      lot: n.lot(e.lot),
      facility: n.t(`tiles:facility.${e.facility}`, { defaultValue: e.facility }),
    }),
  LOT_MUTATED: (e, n) => L(n, 'LOT_MUTATED', { lot: n.lot(e.lot) }, String(e.mode)),
  TOLL_PAID: (e, n) =>
    L(n, 'TOLL_PAID', { payer: n.seat(e.payer), owner: n.seat(e.owner), amount: m(n, e.amount + e.allyAmount) }),
  TOLL_EXEMPT: (e, n) => L(n, 'TOLL_EXEMPT', { who: n.seat(e.payer), lot: n.lot(e.lot) }),
  FEE_PAID: (e, n) => L(n, 'FEE_PAID', { who: n.seat(e.payer), lot: n.lot(e.lot), amount: m(n, e.amount) }),
  HOTEL_STAY: (e, n) => L(n, 'HOTEL_STAY', { who: n.seat(e.seat), lot: n.lot(e.lot), n: e.days }),
  COMPANY_FEE: (e, n) => L(n, 'COMPANY_FEE', { who: n.seat(e.seat), lot: n.lot(e.company), amount: m(n, e.amount) }),
  SUBSCRIBED: (e, n) => L(n, 'SUBSCRIBED', { who: n.seat(e.seat), stock: n.stock(e.stock), n: e.shares }),
  INVEST_BLOCKED: (e, n) => L(n, 'INVEST_BLOCKED', { who: n.seat(e.seat), lot: n.lot(e.lot) }),
  CANNOT_AFFORD: (e, n) => L(n, 'CANNOT_AFFORD', { who: n.seat(e.seat), lot: n.lot(e.lot), price: m(n, e.price) }),
  MARK_SET: (e, n) => L(n, 'MARK_SET', { lots: e.lots.map((x) => n.lot(x)).join('、'), n: e.days }, e.kind),
  MARK_EXPIRED: (e, n) => L(n, 'MARK_EXPIRED', { lots: e.lots.map((x) => n.lot(x)).join('、') }),
  TENURE_EXPIRED: (e, n) => L(n, 'TENURE_EXPIRED', { lots: e.lots.map((x) => n.lot(x)).join('、') }),
  RESEARCH_STARTED: (e, n) => L(n, 'RESEARCH_STARTED', { who: n.seat(e.seat), n: e.days }),
  RESEARCH_DONE: (e, n) => L(n, 'RESEARCH_DONE', { who: n.seat(e.seat), item: n.item(e.item) }),
  RESEARCH_CANCELLED: (e, n) => L(n, 'RESEARCH_CANCELLED', { who: n.seat(e.seat) }),
  CARD_GAINED: (e, n) => L(n, 'CARD_GAINED', { who: n.seat(e.seat), card: n.card(e.card) }),
  CARD_LOST: (e, n) => L(n, 'CARD_LOST', { who: n.seat(e.seat), card: n.card(e.card) }),
  CARD_USED: (e, n) => L(n, 'CARD_USED', { who: n.seat(e.seat), card: n.card(e.card) }),
  CARD_NO_EFFECT: (e, n) => L(n, 'CARD_NO_EFFECT', { who: n.seat(e.seat), card: n.card(e.card) }),
  PASSIVE: (e, n) => L(n, 'PASSIVE', { who: n.seat(e.seat), card: n.card(e.card) }),
  SHOP_OPENED: (e, n) => L(n, 'SHOP_OPENED', { who: n.seat(e.seat) }),
  SHOP_TRADE: (e, n) => L(n, 'SHOP_TRADE', { who: n.seat(e.seat), n: e.points }),
  CHAIRMAN_GIFT: (e, n) => L(n, 'CHAIRMAN_GIFT', { who: n.seat(e.seat) }),
  ITEM_GAINED: (e, n) => L(n, 'ITEM_GAINED', { who: n.seat(e.seat), item: n.item(e.item), n: e.qty }),
  ITEM_LOST: (e, n) => L(n, 'ITEM_LOST', { who: n.seat(e.seat), item: n.item(e.item), n: e.qty }),
  ITEM_USED: (e, n) => L(n, 'ITEM_USED', { who: n.seat(e.seat), item: n.item(e.item) }),
  VEHICLE: (e, n) => L(n, 'VEHICLE', { who: n.seat(e.seat), n: e.dice }),
  VEHICLE_DESTROYED: (e, n) => L(n, 'VEHICLE_DESTROYED', { who: n.seat(e.seat) }),
  OBJECT_PLACED: (e, n) => L(n, 'OBJECT_PLACED', { tile: n.tile(e.obj.node) }),
  OBJECT_REMOVED: (e, n) => L(n, 'OBJECT_REMOVED', { tile: n.tile(e.obj.node) }),
  DOLL_WALK: (e, n) => L(n, 'DOLL_WALK', { who: n.seat(e.seat) }),
  BOMB_ATTACHED: (e, n) => L(n, 'BOMB_ATTACHED', { who: n.seat(e.seat), n: e.fuse }),
  BOMB_TRANSFERRED: (e, n) => L(n, 'BOMB_TRANSFERRED', { from: n.seat(e.from), to: n.seat(e.to) }),
  BOMB_EXPLODED: (e, n) => L(n, 'BOMB_EXPLODED', { who: n.seat(e.seat) }),
  STRIKE: (e, n) => L(n, 'STRIKE', { tile: n.tile(e.center) }),
  TELEPORTED: (e, n) => L(n, 'TELEPORTED', { who: n.seat(e.by) }),
  TIME_REWOUND: (e, n) => L(n, 'TIME_REWOUND', { who: n.seat(e.bySeat), turnNo: e.toTurnNo }),
  GOD_ATTACHED: (e, n) => L(n, 'GOD_ATTACHED', { who: n.seat(e.seat), god: n.god(e.kind) }),
  GOD_POWER: (e, n) => L(n, 'GOD_POWER', { who: n.seat(e.seat), god: n.god(e.kind) }),
  GOD_LEFT: (e, n) => L(n, 'GOD_LEFT', { who: n.seat(e.seat), god: n.god(e.kind) }),
  GOD_SPAWNED: (e, n) => L(n, 'GOD_SPAWNED', { god: n.god(e.kind), tile: n.tile(e.node) }),
  GOD_MANIFEST: (e, n) => L(n, 'GOD_MANIFEST', { god: n.god(e.kind), lot: n.lot(e.lot) }),
  DOG_BITE: (e, n) => L(n, 'DOG_BITE', { who: n.seat(e.seat) }),
  DOG_KNOCKED: (e, n) => L(n, 'DOG_KNOCKED', { who: n.seat(e.seat) }),
  DEATH_GOD_SUMMONED: (e, n) => L(n, 'DEATH_GOD_SUMMONED', { who: n.seat(e.by), target: n.seat(e.target) }),
  CONFINED: (e, n) => L(n, 'CONFINED', { who: n.actor(e.actor), n: e.days }, e.where),
  BLESSING: (e, n) => L(n, 'BLESSING', { who: n.seat(e.seat) }),
  STATUS_SET: (e, n) =>
    L(n, 'STATUS_SET', {
      who: n.actor(e.actor),
      status: n.t(`events:status.${e.status}`, { defaultValue: e.status }),
      n: e.value,
      unit: n.t(`events:statusUnit.${e.status}`, { defaultValue: '' }),
    }).trimEnd(),
  ALLIANCE_FORMED: (e, n) => L(n, 'ALLIANCE_FORMED', { a: n.seat(e.a), b: n.seat(e.b), n: e.days }),
  ALLIANCE_BROKEN: (e, n) => L(n, 'ALLIANCE_BROKEN', { a: n.seat(e.a), b: n.seat(e.b) }),
  ALLIANCE_EXPIRED: (e, n) => L(n, 'ALLIANCE_EXPIRED', { a: n.seat(e.a), b: n.seat(e.b) }),
  BANK_REJECTED: (e, n) =>
    L(
      n,
      'BANK_REJECTED',
      { who: n.seat(e.seat), n: e.days },
      (e as { reason?: string }).reason === 'sunday' ? 'sunday' : undefined,
    ),
  NEWS: (e, n) => L(n, 'NEWS', { id: e.id + 1, text: n.t(`news:${e.id}.headline`, { ...e.params, defaultValue: '' }) }),
  FATE: (e, n) => L(n, 'FATE', { who: n.seat(e.seat), id: e.id + 1 }),
  MAGIC_CONDITION: (e, n) => L(n, 'MAGIC_CONDITION', { who: n.seat(e.caster) }),
  MAGIC_CAST: (e, n) => L(n, 'MAGIC_CAST', { who: n.seat(e.caster) }),
  LOTTERY_TICKET: (e, n) => L(n, 'LOTTERY_TICKET', { who: n.seat(e.seat), n: e.number + 1 }),
  LOTTERY_DRAW: (e, n) =>
    e.number === null
      ? L(n, 'LOTTERY_DRAW', {}, 'none')
      : e.winner === null
        ? L(n, 'LOTTERY_DRAW', { n: e.number + 1 }, 'noWinner')
        : L(n, 'LOTTERY_DRAW', { n: e.number + 1, who: n.seat(e.winner), amount: m(n, e.prize) }),
  MINIGAME_STARTED: (e, n) =>
    L(n, 'MINIGAME_STARTED', {
      who: n.seat(e.seat),
      game: n.t(`minigames:${e.minigameId}.name`, { defaultValue: n.t(`tiles:kind.${e.minigameId}`) }),
    }),
  MINIGAME_ENDED: (e, n) => L(n, 'MINIGAME_ENDED', { who: n.seat(e.seat), n: e.score }),
  BAIL: (e, n) => L(n, 'BAIL', { who: n.seat(e.by), target: n.seat(e.seat) }),
  VILLAIN_HIRED: (e, n) => L(n, 'VILLAIN_HIRED', { who: n.seat(e.by), villain: n.villain(e.kind) }),
  VILLAIN_ACTION: (e, n) => L(n, 'VILLAIN_ACTION', { villain: n.villain(e.kind), target: n.seat(e.victim) }),
  VILLAIN_HOME: (e, n) => L(n, 'VILLAIN_HOME', { villain: n.villain(e.kind) }),
  BEGGAR_ALMS: (e, n) => L(n, 'BEGGAR_ALMS', { who: n.seat(e.payer), amount: m(n, e.amount) }),
  STOCK_TRADED: (e, n) =>
    L(n, 'STOCK_TRADED', { who: n.seat(e.seat), stock: n.stock(e.stock), n: e.shares, amount: m(n, e.amount) }, e.side),
  CHAIRMAN_CHANGED: (e, n) =>
    e.to === null ? null : L(n, 'CHAIRMAN_CHANGED', { who: n.seat(e.to), stock: n.stock(e.stock) }),
  STOCK_FLAG: (e, n) => L(n, 'STOCK_FLAG', { stock: n.stock(e.stock) }),
  SUSPENDED: (e, n) => L(n, 'SUSPENDED', { stock: n.stock(e.stock), n: e.days }),
  RESUMED: (e, n) => L(n, 'RESUMED', { stock: n.stock(e.stock) }),
  MARKET_TICK: () => null,
  MARKET_CLOSED: (e, n) => L(n, 'MARKET_CLOSED', {}, e.reason),
  LISTING_ADDED: (e, n) => L(n, 'LISTING_ADDED', { who: n.seat(e.listing.seller), amount: m(n, e.listing.price) }),
  LISTING_REMOVED: () => null,
  LISTING_SOLD: (e, n) => L(n, 'LISTING_SOLD', { who: n.seat(e.buyer), amount: m(n, e.price) }),
  AUCTION_STARTED: (e, n) => L(n, 'AUCTION_STARTED', { lot: n.lot(e.lot), amount: m(n, e.start) }),
  AUCTION_BID: (e, n) => L(n, 'AUCTION_BID', { who: n.seat(e.seat), amount: m(n, e.price) }),
  AUCTION_PASS: () => null,
  AUCTION_QUIT: (e, n) => L(n, 'AUCTION_QUIT', { who: n.seat(e.seat) }),
  AUCTION_ENDED: (e, n) =>
    e.winner === null
      ? L(n, 'AUCTION_ENDED', { lot: n.lot(e.lot) }, 'none')
      : L(n, 'AUCTION_ENDED', { lot: n.lot(e.lot), who: n.seat(e.winner), amount: m(n, e.price) }),
  DAY_ADVANCED: (e, n) => L(n, 'DAY_ADVANCED', { date: n.date(e.date) }),
  PRICE_INDEX: (e, n) => L(n, 'PRICE_INDEX', { from: e.from, to: e.to }),
  HOLIDAY: (e, n) => L(n, 'HOLIDAY', { name: n.holiday(e.key) }),
  DIVIDENDS: (e, n) => {
    // 15 日一次分红只发一个事件（按座位净额入账，exe 0x42ba97），rows 按公司、座位逐条列出；负数为亏损反扣
    const companies = [...new Set(e.rows.map((r) => r.company))];
    const one = companies.length === 1;
    const rows = e.rows
      .map(
        (r) =>
          `${one ? '' : `${n.lot(r.company)} `}${n.seat(r.seat)} ${r.amount >= 0 ? '+' : '−'}${m(n, Math.abs(r.amount))}`,
      )
      .join(n.t('events:listSep'));
    return one
      ? L(n, 'DIVIDENDS', { company: n.lot(companies[0]!), rows })
      : L(n, 'DIVIDENDS', { n: e.rows.length, rows }, 'many');
  },
  MONTHLY_REPORT: (e, n) =>
    e.champion === null ? L(n, 'MONTHLY_REPORT', {}, 'none') : L(n, 'MONTHLY_REPORT', { who: n.seat(e.champion) }),
  OBJECTS_RESPAWNED: () => null,
  DAY_END: () => null,
  BANKRUPT: (e, n) => L(n, 'BANKRUPT', { who: n.seat(e.seat) }),
  LIQUIDATION: (e, n) => L(n, 'LIQUIDATION', { who: n.seat(e.seat), n: e.lots.length }),
  BECAME_BEGGAR: (e, n) => L(n, 'BECAME_BEGGAR', { who: n.seat(e.seat) }),
  SURRENDERED: (e, n) => L(n, 'SURRENDERED', { who: n.seat(e.seat) }),
  GAME_OVER: (e, n) =>
    e.result.winner === null ? L(n, 'GAME_OVER', {}, 'none') : L(n, 'GAME_OVER', { who: n.seat(e.result.winner) }),
  CONTROLLER_CHANGED: (e, n) => L(n, 'CONTROLLER_CHANGED', { who: n.seat(e.seat) }, e.controller),
  AI_TRAITS_CHANGED: () => null,
  DEBUG_APPLIED: (e, n) => L(n, 'DEBUG_APPLIED', { op: e.op }),
  SYNC: () => null,
} as const satisfies { readonly [T in GameEventType]: Fmt<T> };

/** 一个事件的日志行（不记录时为 null） */
export function formatEvent(e: GameEvent, n: NameKit): string | null {
  const f = LOG_FORMAT[e.type] as unknown as (x: GameEvent, k: NameKit) => string | null;
  try {
    return f(e, n);
  } catch {
    return null;
  }
}
