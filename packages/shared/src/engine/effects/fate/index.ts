/**
 * 命运 37 条（design/engine.md §10.7，以 docs/research/events-from-exe.md §2、§4 为准；数值读 data/tables/fate.ts）。
 *
 * 抽牌（squares/fate.ts → drawFate）：游标取下一张 → 按座驾替换（10↔11、12↔13、14/15/16）→ 不可行就跳过（游标照样前进），
 * 最多试 37 次，可行的压 FATE 帧。魔法屋「连抽三张」压 stage='draw' 的 FATE 帧，执行时再抽。
 *
 * FATE 帧：
 *   bless   有加持类别的命运（33 条）：evalBlessing（值 > 100 必定 high；50 < 值 ≤ 100 rand & 1；< 0 为 low）；
 *           奖金、罚金读财运，劫难读福运。handlesDouble=false（3、8、9、10、11、32）的 low 按 none 处理（不加倍）
 *   apply   公布 FATE{seat, id, amount, blessing}（blessing：high / low，没有加持效果为 null）后结算：
 *     0 自家一栋有建筑的住宅被强拆（夷平、保留地主），补偿 等级 × 房价进现金（不乘 PI）
 *     1 自家一块空地被征收（变无主），补偿地价进现金
 *     2 被冒用贷款：贷款 += 10000 × PI（high 免、low ×2），没有到期日时设到期日；投保中保险公司赔同额
 *     3 银行拒绝往来 30 天（累加；high 免）
 *     4 每位其他在场玩家存款的 10% 转入自己的存款
 *     5 生日：每位持卡的对手给一张（真人 BIRTHDAY_PICK 逐人挑，电脑随机）
 *     6/7 出国 / 被外星人绑架 3 天（high 逃过、low ×2）→ 免罪 → 嫁祸 → 消失
 *     8 每支持股收回 10%（退回市场，按市价进公库）；9 按市价卖光全部持股进存款（都只处理 high 免）
 *     10/11 失去机车 / 汽车（只处理 high 逃过）
 *     12/13 掉进水沟 / 骑车摔伤：免罪 → 嫁祸 → 先毁座驾再住院 3 天（high 逃过、low ×2）
 *     14–19、23、24、26、30 罚款 × PI 进公库（high 免付、low ×2；rules.freeCardOnFines 时先问免费卡、嫁祸卡）；
 *       投保中（且确实由本人付了）保险公司赔同额
 *     20–22、25、27–29、31 奖金 × PI 进现金（high ×2、low 作废）
 *     32 卡片、道具全部按商店价全价折点券（座驾先折回道具；只处理 high 逃过）
 *     33–36 坐牢 3/5/7/9 天（high 逃过、low ×2）→ 免罪 → 嫁祸
 */
import { cardDef } from '../../../data/tables/cards';
import { type FateDef, fateDef, fateParam, swapFateByVehicle } from '../../../data/tables/fate';
import { FATE_IDS, type FateId, ITEM, ITEM_IDS, type ItemId, isPoolItem } from '../../../data/tables/ids';
import { itemDef } from '../../../data/tables/items';
import { VEHICLE_ITEM } from '../../../data/tables/setup';
import { add32, addU16, divTrunc, mul32 } from '../../../util/int32';
import type { Ctx } from '../../core/ctx';
import type { FrameHandler } from '../../core/frameHandler';
import { EngineInvariantError, EngineRuleError } from '../../errors';
import { pushConfine } from '../../flow/confine';
import {
  askFreeCard,
  askScapegoat,
  passiveThreshold,
  resolveFreeCard,
  resolveScapegoat,
  scapegoatCandidates,
} from '../../flow/passive';
import { insuranceCompanyIdx, newLoanDue } from '../../rules/bank';
import { evalBlessing, luckFor } from '../../rules/blessing';
import { addCounterDays } from '../../rules/counters';
import { returnCardToDeck } from '../../rules/inventory';
import { addMoney } from '../../rules/payment';
import { tradeAmount, updateChairman } from '../../rules/stock';
import type { BirthdayPickOptions, ScapegoatOptions } from '../../types/decision';
import type { BlessingResult } from '../../types/events';
import type { FrameOf } from '../../types/frames';
import type { SeatIndex, Vehicle } from '../../types/ids';
import type { PlayerAction } from '../../types/intent';
import type { GameState, PlayerState } from '../../types/state';
import { destroyVehicle, gainCard, mutateLot, timesPI } from '../common';

type FateFrame = FrameOf<'FATE'>;

// ───────────────────────── 可行性与抽牌 ─────────────────────────

export function fateFeasible(s: GameState, seat: SeatIndex, id: FateId): boolean {
  const p = s.players.find((x) => x.seat === seat);
  if (!p?.alive) return false;
  switch (fateDef(id).feasible) {
    case 'always':
      return true;
    case 'ownBuiltLand':
      return s.lands.some((l) => l.owner === seat && l.level > 0);
    case 'ownEmptyLand':
      return s.lands.some((l) => l.owner === seat && l.level === 0);
    case 'rivalCards':
      return s.players.some((q) => q.alive && q.seat !== seat && q.cards.length > 0);
    case 'ownHoldings':
      return p.holdings.some((h) => h.shares > 0);
    case 'moto':
      return p.vehicle === 'moto';
    case 'car':
      return p.vehicle === 'car';
    case 'walk':
      return p.vehicle === 'walk';
  }
}

/** 从牌堆抽下一张可行的命运（替换后）；37 张都不可行返回 null */
export function nextFate(ctx: Ctx, seat: SeatIndex): FateId | null {
  const sec = ctx.s.secret;
  const p = ctx.player(seat);
  for (let i = 0; i < FATE_IDS.length; i++) {
    const drawn = sec.fateOrder[sec.fateCursor % sec.fateOrder.length]!;
    sec.fateCursor = (sec.fateCursor + 1) % sec.fateOrder.length;
    const id = swapFateByVehicle(drawn, p.vehicle);
    if (fateFeasible(ctx.s, seat, id)) return id;
  }
  return null;
}

/** 命运格：抽一张可行的命运并压 FATE 帧 */
export function drawFate(ctx: Ctx, seat: SeatIndex): void {
  const id = nextFate(ctx, seat);
  if (id !== null) ctx.push({ k: 'FATE', seat, id, stage: 'bless', data: {} });
}

/** 魔法屋「连抽三张」：压一个执行时才抽的 FATE 帧 */
export function pushFateDraw(ctx: Ctx, seat: SeatIndex): void {
  ctx.push({ k: 'FATE', seat, id: 0, stage: 'draw', data: {} });
}

// ───────────────────────── 全价折点券（命运 32、魔法屋 0 / 8） ─────────────────────────

/** 卡片全部按商店价折点券（回牌堆）；返回得到的点券 */
export function sellAllCardsFull(ctx: Ctx, seat: SeatIndex): number {
  const s = ctx.s;
  const p = ctx.player(seat);
  let gained = 0;
  for (const c of p.cards) {
    gained += cardDef(c).price;
    returnCardToDeck(s, c);
  }
  p.cards = [];
  p.points = addU16(p.points, gained, s.config.rules.intOverflow);
  return gained;
}

/** 道具（含座驾：先折回道具）全部按商店价折点券；1..8 回库存，9..13 消失；返回得到的点券 */
export function sellAllItemsFull(ctx: Ctx, seat: SeatIndex): number {
  return sellAllItemsDetailed(ctx, seat).gained;
}

/**
 * 同 sellAllItemsFull，另外列出卖掉的道具；vehicleFrom 是改回步行之前的座驾（本来步行时为 null）。座驾先折回背包里的道具
 * 一起卖：机车 / 汽车折成 5 / 6 号（卖后回库存），工程车折成 12 号（按 12 号的价钱卖掉、不回库存，剩余天数一并作废）；
 * 之后步行、1 颗骰子。调用方没有随后的公布事件时要自己补发 VEHICLE（魔法屋 8：背包空着时只剩座驾那一件）。
 * 梦游卡停放的座驾（parked）不在这里：停放的机车 / 汽车早已在背包里一起卖掉，工程车不受影响，梦游结束时照样装回
 * （原版只看模式字节 +0x11）。
 * @source exe v2.06 fcn.004446de（魔法屋 0x431612、命运 32 0x44c09a、破产 0x40cc53 / 0x40ede0）：模式 & 3 为 1 / 2 / 3 时背包
 *   机车 / 汽车 / 12 号道具 +1（0x444718 / 0x444720 / 0x444728），模式写 0、骰子写 1、调 0x40b425；再逐个道具（0..12）把数量
 *   × 价格（道具表 0x47d640 + 8·i 的 +7 字节）累计、前 8 种回库存、背包清 0，返回值由调用方加到点券（0x43111d / 0x44c0a2）；
 *   v3.11 0x445b66–0x445bae 相同
 */
export function sellAllItemsDetailed(
  ctx: Ctx,
  seat: SeatIndex,
): { gained: number; sold: { item: ItemId; qty: number }[]; vehicleFrom: Vehicle | null } {
  const s = ctx.s;
  const p = ctx.player(seat);
  const vItem = p.vehicle === 'engineer' ? ITEM.ENGINEERING_VEHICLE : VEHICLE_ITEM[p.vehicle];
  if (vItem !== null) p.items[vItem] = (p.items[vItem] ?? 0) + 1;
  const vehicleFrom = p.vehicle === 'walk' ? null : p.vehicle;
  if (vehicleFrom !== null) {
    p.vehicle = 'walk';
    p.diceCount = 1;
    p.engineer = null;
  }
  let gained = 0;
  const sold: { item: ItemId; qty: number }[] = [];
  for (const it of ITEM_IDS) {
    const n = p.items[it] ?? 0;
    if (n <= 0) continue;
    gained += itemDef(it).price * n;
    if (isPoolItem(it)) s.pools.items[it] = (s.pools.items[it] ?? 0) + n;
    p.items[it] = 0;
    sold.push({ item: it, qty: n });
  }
  p.points = addU16(p.points, gained, s.config.rules.intOverflow);
  return { gained, sold, vehicleFrom };
}

// ───────────────────────── 共用 ─────────────────────────

function blessingOf(f: FateFrame): BlessingResult {
  const b = f.data.bless;
  return b === 'high' || b === 'low' ? b : 'none';
}

function emitFate(ctx: Ctx, f: FateFrame, amount: number | null): void {
  const b = blessingOf(f);
  ctx.emit('FATE', { seat: f.seat, id: f.id, amount, blessing: b === 'none' ? null : b });
}

/** 保险公司（首家行业 4）赔 amount 进现金 → INSURANCE_PAYOUT（没有保险公司、没投保或金额为 0 时不赔） */
function insurancePay(ctx: Ctx, seat: SeatIndex, amount: number): void {
  const p = ctx.player(seat);
  if (!p.alive || p.insuranceDays === 0 || amount <= 0) return;
  const ci = insuranceCompanyIdx(ctx.map);
  if (ci < 0) return;
  const company = ctx.s.companies[ci]!;
  ctx.pay({ t: 'company', company: company.id }, { t: 'seat', seat }, amount, {
    reason: 'insurance',
    cause: { k: 'system', ref: 'insurance', by: null },
  });
  ctx.emit('INSURANCE_PAYOUT', { seat, amount, days: 0 });
}

function mintReward(ctx: Ctx, seat: SeatIndex, amount: number): void {
  if (amount <= 0) return;
  ctx.mint(seat, amount, 'cash', true);
  ctx.emit('MONEY', {
    from: { t: 'bank' },
    to: { t: 'seat', seat },
    amount,
    paid: amount,
    reason: 'reward',
    ref: null,
  });
}

/** 罚金付给公库（不走被动卡），返回是否破产 */
function payFine(ctx: Ctx, seat: SeatIndex, amount: number, id: FateId): boolean {
  const from = { t: 'seat', seat } as const;
  const r = ctx.pay(from, { t: 'pool' }, amount, {
    reason: 'fine',
    accident: true,
    cause: { k: 'fate', ref: id, by: null },
  });
  ctx.emit('MONEY', { from, to: { t: 'pool' }, amount, paid: r.paid, reason: 'fine', ref: null });
  return r.bankrupt;
}

function x2(ctx: Ctx, n: number): number {
  return mul32(n, 2, ctx.s.config.rules.intOverflow);
}

// ───────────────────────── 各效果 ─────────────────────────

type Apply = (ctx: Ctx, f: FateFrame, def: FateDef, p: PlayerState) => void;

const demolishOwn: Apply = (ctx, f, _def, p) => {
  const s = ctx.s;
  const idx = s.lands.map((l, i) => (l.owner === p.seat && l.level > 0 ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) {
    emitFate(ctx, f, 0);
    return;
  }
  const i = idx[ctx.pick('fate', idx.length)]!;
  const land = s.lands[i]!;
  const comp = mul32(land.level, ctx.map.lands[i]!.housePrice, s.config.rules.intOverflow);
  emitFate(ctx, f, comp);
  mutateLot(ctx, land.id, 2, { k: 'fate', ref: f.id, by: null });
  mintReward(ctx, p.seat, comp);
};

const expropriate: Apply = (ctx, f, _def, p) => {
  const s = ctx.s;
  const idx = s.lands.map((l, i) => (l.owner === p.seat && l.level === 0 ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) {
    emitFate(ctx, f, 0);
    return;
  }
  const land = s.lands[idx[ctx.pick('fate', idx.length)]!]!;
  const comp = land.landPrice;
  emitFate(ctx, f, comp);
  mutateLot(ctx, land.id, 1, { k: 'fate', ref: f.id, by: null });
  mintReward(ctx, p.seat, comp);
};

const fakeLoan: Apply = (ctx, f, def, p) => {
  const b = blessingOf(f);
  let amount = timesPI(ctx, fateParam(def.id, 'loan'));
  if (b === 'high') {
    emitFate(ctx, f, amount);
    return;
  }
  if (b === 'low') amount = x2(ctx, amount);
  p.loan = add32(p.loan, amount, ctx.s.config.rules.intOverflow);
  if (p.loanDue === 0) p.loanDue = newLoanDue(ctx.s, ctx.map);
  emitFate(ctx, f, amount);
  insurancePay(ctx, p.seat, amount);
};

const bankRefuse: Apply = (ctx, f, def, p) => {
  if (blessingOf(f) === 'high') {
    emitFate(ctx, f, null);
    return;
  }
  const days = fateParam(def.id, 'days');
  p.bankReject = p.bankReject === 0 ? days : addCounterDays(p.bankReject, days);
  emitFate(ctx, f, null);
  ctx.emit('STATUS_SET', { actor: { t: 'seat', seat: p.seat }, status: 'bankReject', value: p.bankReject });
};

const embezzle: Apply = (ctx, f, def, p) => {
  emitFate(ctx, f, null);
  const pct = fateParam(def.id, 'pct');
  for (const q of ctx.s.players) {
    if (!q.alive || q.seat === p.seat || q.deposit <= 0) continue;
    const amt = divTrunc(q.deposit * pct, 100);
    if (amt <= 0) continue;
    const from = { t: 'seat', seat: q.seat } as const;
    const to = { t: 'seat', seat: p.seat } as const;
    const r = ctx.pay(from, to, amt, {
      order: 'depositFirst',
      credit: 'deposit',
      reason: 'fine',
      accident: true,
      cause: { k: 'fate', ref: f.id, by: p.seat },
    });
    ctx.emit('MONEY', { from, to, amount: amt, paid: r.paid, reason: 'fine', ref: null });
  }
};

export function birthdayVictims(s: GameState, seat: SeatIndex): BirthdayPickOptions['victims'] {
  return s.players
    .filter((q) => q.alive && q.seat !== seat && q.cards.length > 0)
    .map((q) => ({ seat: q.seat, cards: q.cards.map((card, slot) => ({ slot, card })) }));
}

function takeBirthdayCards(ctx: Ctx, seat: SeatIndex, picks: readonly { from: SeatIndex; slot: number }[]): void {
  for (const pk of picks) {
    const q = ctx.player(pk.from);
    const card = q.cards[pk.slot];
    if (card === undefined) continue;
    q.cards.splice(pk.slot, 1);
    ctx.emit('CARD_LOST', { seat: pk.from, card, cause: 'birthday' });
    gainCard(ctx, seat, card, 'birthday');
  }
}

const birthday: Apply = (ctx, f, _def, p) => {
  emitFate(ctx, f, null);
  const victims = birthdayVictims(ctx.s, p.seat);
  if (victims.length === 0) return;
  if (p.controller === 'human') {
    f.stage = 'pick';
    const options: BirthdayPickOptions = { victims };
    const def = { type: 'PICK_CARDS', picks: victims.map((v) => ({ from: v.seat, slot: v.cards[0]!.slot })) } as const;
    ctx.ask(f, p.seat, 'BIRTHDAY_PICK', options, def);
    return;
  }
  const picks = victims.map((v) => ({ from: v.seat, slot: ctx.pick('birthday', v.cards.length) }));
  takeBirthdayCards(ctx, p.seat, picks);
};

/** 坐牢、住院、出国：high 逃过；low 天数 ×2（handlesDouble）；→ 免罪 → 嫁祸 → 施加 */
function confineFate(where: 'jail' | 'hospital' | 'away', wreck: boolean): Apply {
  return (ctx, f, def, p) => {
    const b = blessingOf(f);
    emitFate(ctx, f, null);
    if (b === 'high') return;
    let days = fateParam(def.id, 'days');
    if (b === 'low') days *= 2;
    pushConfine(
      ctx,
      { t: 'seat', seat: p.seat },
      { where, days, cause: { k: 'fate', ref: f.id, by: null }, passive: def.passive, wreck },
    );
  };
}

const stockDefault: Apply = (ctx, f, def, p) => {
  if (blessingOf(f) === 'high') {
    emitFate(ctx, f, null);
    return;
  }
  const s = ctx.s;
  const pct = fateParam(def.id, 'pct');
  let total = 0;
  const changed: number[] = [];
  s.stocks.forEach((st, i) => {
    const h = p.holdings[i]!;
    const n = divTrunc(h.shares * pct, 100);
    if (n <= 0) return;
    const left = h.shares - n;
    p.holdings[i] = { shares: left, costCents: left === 0 ? 0 : Math.trunc((h.costCents * left) / h.shares) };
    st.float += n;
    const value = tradeAmount(st.priceCents, n);
    s.econ.pool = addMoney(s, s.econ.pool, value);
    s.econ.ledger.minted += value;
    total += value;
    changed.push(i);
  });
  emitFate(ctx, f, total);
  for (const i of changed) {
    const ch = updateChairman(s, i);
    if (ch) ctx.emit('CHAIRMAN_CHANGED', ch);
  }
};

const sellAllStocks: Apply = (ctx, f, _def, p) => {
  if (blessingOf(f) === 'high') {
    emitFate(ctx, f, null);
    return;
  }
  const s = ctx.s;
  let total = 0;
  const changed: number[] = [];
  s.stocks.forEach((st, i) => {
    const h = p.holdings[i]!;
    if (h.shares <= 0) return;
    const amount = tradeAmount(st.priceCents, h.shares);
    st.float += h.shares;
    p.quota[i] = (p.quota[i] ?? 0) + h.shares;
    p.holdings[i] = { shares: 0, costCents: 0 };
    p.deposit = addMoney(s, p.deposit, amount);
    s.econ.ledger.minted += amount;
    total += amount;
    changed.push(i);
  });
  emitFate(ctx, f, total);
  for (const i of changed) {
    const ch = updateChairman(s, i);
    if (ch) ctx.emit('CHAIRMAN_CHANGED', ch);
  }
};

/**
 * 命运 10 机车被偷 / 11 汽车撞毁：车回共享库存、步行。原版直接把模式写成 0、骰子 1，刷新外观、重画，再说事件槽台词
 * （命运 10 槽 3 / 4 随机二选一，命运 11 槽 3），不走地雷炸弹的毁车 0x40c7cd（没有烧焦外观），客户端据 via 'fate' 不播车毁。
 * @source exe v2.06 命运 10 0x44b4e0–0x44b559（库存机车 +1）、命运 11 0x44b5f1–0x44b659（库存汽车 +1），台词表 0x47db2a；
 *   有加持（high）只出消息框
 */
const loseVehicle: Apply = (ctx, f, _def, p) => {
  emitFate(ctx, f, null);
  if (blessingOf(f) === 'high') return;
  destroyVehicle(ctx, p.seat, 'fate');
};

/** 罚金：high 免付（不赔）；low ×2；PROGRAM 直接付；rules.freeCardOnFines 时走 free → scapegoat → pay → insure */
const fine: Apply = (ctx, f, def, p) => {
  const b = blessingOf(f);
  let amount = timesPI(ctx, fateParam(def.id, 'amount'));
  if (b === 'low') amount = x2(ctx, amount);
  emitFate(ctx, f, amount);
  if (b === 'high') return;
  f.data.amount = amount;
  f.data.payer = p.seat;
  f.stage = ctx.s.config.rules.freeCardOnFines ? 'free' : 'pay';
};

const reward: Apply = (ctx, f, def, p) => {
  const b = blessingOf(f);
  let amount = timesPI(ctx, fateParam(def.id, 'amount'));
  if (b === 'high') amount = x2(ctx, amount);
  emitFate(ctx, f, amount);
  if (b === 'low') return;
  mintReward(ctx, p.seat, amount);
};

const sellAllCardsTools: Apply = (ctx, f, _def, p) => {
  if (blessingOf(f) === 'high') {
    emitFate(ctx, f, null);
    return;
  }
  const gained = sellAllCardsFull(ctx, p.seat) + sellAllItemsFull(ctx, p.seat);
  emitFate(ctx, f, gained);
};

const APPLY = Object.freeze({
  demolishOwn,
  expropriate,
  fakeLoan,
  bankRefuse,
  embezzle,
  birthday,
  abroad: confineFate('away', false),
  stockDefault,
  sellAllStocks,
  loseVehicle,
  ditch: confineFate('hospital', true),
  fine,
  reward,
  sellAllCardsTools,
  jail: confineFate('jail', false),
} satisfies { readonly [E in FateDef['effect']]: Apply });

// ───────────────────────── 帧 ─────────────────────────

function payerOf(f: FateFrame): SeatIndex {
  const x = f.data.payer;
  return (typeof x === 'number' ? x : f.seat) as SeatIndex;
}

function amountOf(f: FateFrame): number {
  return typeof f.data.amount === 'number' ? f.data.amount : 0;
}

export const FATE: FrameHandler<FateFrame> = {
  step(ctx, f) {
    const p = ctx.player(f.seat);
    switch (f.stage) {
      case 'draw': {
        const id = p.alive ? nextFate(ctx, f.seat) : null;
        if (id === null) {
          f.stage = 'done';
          return;
        }
        f.id = id;
        f.stage = 'bless';
        return;
      }
      case 'bless': {
        f.stage = 'apply';
        const def = fateDef(f.id);
        if (def.blessing === null) {
          f.data.bless = null;
          return;
        }
        let r = evalBlessing(luckFor(p, def.blessing.category), () => ctx.rand15('bless') & 1);
        // 只处理「免付 / 逃过」的命运：低档照常执行、不加倍
        if (r === 'low' && !def.blessing.handlesDouble) r = 'none';
        f.data.bless = r;
        return;
      }
      case 'apply': {
        f.stage = 'done';
        APPLY[fateDef(f.id).effect](ctx, f, fateDef(f.id), p);
        return;
      }
      case 'free':
        // rules.freeCardOnFines：持免费卡且金额 ≥ 2000 × PI（或 > 现金 + 存款）时先问免费卡
        if (!askFreeCard(ctx, f, payerOf(f), 'fine', amountOf(f), null)) f.stage = 'scapegoat';
        return;
      case 'scapegoat': {
        const payer = payerOf(f);
        const asked =
          passiveThreshold(ctx.s, ctx.player(payer), amountOf(f)) &&
          askScapegoat(ctx, f, payer, 'fine', amountOf(f), null, scapegoatCandidates(ctx.s, payer));
        if (!asked) f.stage = 'pay';
        return;
      }
      case 'pay': {
        f.stage = 'insure';
        const payer = payerOf(f);
        if (!ctx.player(payer).alive) {
          f.stage = 'done';
          return;
        }
        if (payFine(ctx, payer, amountOf(f), f.id)) f.stage = 'done';
        return;
      }
      case 'insure': {
        f.stage = 'done';
        // 投保中且确实由本人付了罚金：保险公司赔同额（嫁祸给别人或用了免费卡时不赔）
        if (payerOf(f) === f.seat && fateDef(f.id).insured) insurancePay(ctx, f.seat, amountOf(f));
        return;
      }
      case 'pick':
        // 只会在决策被回答后到这里（resume 已结算）
        f.stage = 'done';
        return;
      case 'done':
        ctx.pop(f);
        return;
    }
  },
  resume(ctx, f, a: PlayerAction, d) {
    if (f.stage === 'pick' && d.kind === 'BIRTHDAY_PICK' && a.type === 'PICK_CARDS') {
      const victims = (d.options as BirthdayPickOptions).victims;
      const seen = new Set<SeatIndex>();
      for (const pk of a.picks) {
        const v = victims.find((x) => x.seat === pk.from);
        if (!v || seen.has(pk.from) || !v.cards.some((c) => c.slot === pk.slot)) {
          throw new EngineRuleError('INVALID_TARGET', `bad birthday pick ${pk.from}:${pk.slot}`);
        }
        seen.add(pk.from);
      }
      if (seen.size !== victims.length) throw new EngineRuleError('INVALID_TARGET', 'pick one card from every victim');
      f.stage = 'done';
      takeBirthdayCards(
        ctx,
        f.seat,
        victims.map((v) => a.picks.find((pk) => pk.from === v.seat)!),
      );
      return;
    }
    if (f.stage === 'free' && d.kind === 'USE_FREE_CARD') {
      f.stage = resolveFreeCard(ctx, payerOf(f), a, 'fine', null) ? 'done' : 'scapegoat';
      return;
    }
    if (f.stage === 'scapegoat' && d.kind === 'SCAPEGOAT') {
      const t = resolveScapegoat(ctx, payerOf(f), a, (d.options as ScapegoatOptions).candidates, 'fine');
      if (t !== null) f.data.payer = t;
      f.stage = 'pay';
      return;
    }
    throw new EngineInvariantError('FATE_RESUME', `${f.stage}/${d.kind}`);
  },
};

/** 测试与调试用：直接压一张指定的命运（不经牌堆与替换） */
export function pushFate(ctx: Ctx, seat: SeatIndex, id: FateId): void {
  ctx.push({ k: 'FATE', seat, id, stage: 'bless', data: {} });
}
