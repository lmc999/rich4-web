/**
 * TURN 帧（design/engine.md §7.2–§7.4、§7.7；docs/research/g_arbitration.md §3）。
 *
 * start  回合数 +1、清空回合临时状态、刷新股票可买量、计数器两段式推进 → TURN_STARTED；
 *        释放 → RELEASED；首回合跳伞 → PARACHUTE；
 *        主阻碍 ≠0 → TURN_BLOCKED → end；刚释放（returning）→ RETURNED，走回棋盘不掷骰 → end；
 *        冬眠 → TURN_BLOCKED → end；梦游 → 自动掷 1 颗骰子乱走（停留 0 步、乌龟 1 步照样生效）；否则 menu。
 * menu   TURN_MENU 决策。ROLL{dice?}（校验交通工具上限）是终结 intent；其余为非终结（每回合 ≤ 40 次，M4/M6/M7 实现）。
 * landed MOVE / LAND 出栈后 → end。
 * end    清空回合临时状态 → TURN_ENDED → 出栈。
 *
 * M4：回合开始的贷款到期检查（剩 3/2/1 天 LOAN_REMINDER；到期按银行口径强制还款，扣不出来就破产）、
 *     保险与拒绝往来的两段式倒数、名下研究所倒数（到 0 交付道具 8+project）；菜单里的股票买卖（STOCK_BUY / STOCK_SELL）。
 * M6：回合开始时神明任期 −1（到 0 离场、搭档刷出）、工程车倒数（到 0 恢复原车）、同盟两段式倒数（期间双方敌意各
 *     −20×PI，到期 ALLIANCE_EXPIRED）；走回棋盘时压 LAND（只做物件结算与显灵、工程车，skipSquare）；
 *     菜单里用卡（USE_CARD）与用道具（USE_ITEM）：候选与合法性来自 effects 注册表，扣卡 / 扣道具后发 CARD_USED / ITEM_USED
 *     再结算效果；遥控骰子（选点即掷）与对自己用传送机（视为已掷骰）是终结 intent。
 *     非终结操作之后回到 menu 时先复查：被关押（复仇、嫁祸、自己的飞弹）或冬眠 → 结束回合；被嫁祸梦游 → 自动乱走。
 * M7：ROLL 时记时光机锚点（effects/timeMachine.ts）；SURRENDER 压 SURRENDER 帧（flow/surrender.ts）；
 *     公布栏的挂牌 / 撤牌 / 购买（flow/board.ts），回合开始时撤下失效的挂牌。
 */
import { CMB } from '../../data/tables/combat';
import { ECON } from '../../data/tables/economy';
import { ITEM, researchItemOf } from '../../data/tables/ids';
import type { Ctx } from '../core/ctx';
import type { FrameHandler } from '../core/frameHandler';
import { buildTurnMenu } from '../decisions/build';
import { targetMatches } from '../decisions/targets';
import { turnMenuBudgetKey } from '../decisions/timing';
import { cardEffect } from '../effects/cards/index';
import { timesPI } from '../effects/common';
import { attachedSlot, leaveGod } from '../effects/gods/lifecycle';
import { itemEffect } from '../effects/items/index';
import { restoreEngineer, tickEngineer } from '../effects/items/vehicle';
import { captureAnchor } from '../effects/timeMachine';
import type { MenuRow } from '../effects/types';
import { EngineInvariantError, EngineRuleError } from '../errors';
import { daysBetween } from '../rules/calendar';
import { displayRemaining, mainBlockOf, tick2, tickActorCounters } from '../rules/counters';
import { receiveItem, removeItem, returnCardToDeck } from '../rules/inventory';
import { diceAllowed } from '../rules/movement';
import { MENU_ACTION_LIMIT } from '../types/decision';
import type { ConfineWhere, FrameOf } from '../types/frames';
import type { DiceFace, SeatIndex, TileId } from '../types/ids';
import type { IntentOf, PlayerAction } from '../types/intent';
import type { PlayerState, PlayerTurnState } from '../types/state';
import { buyFromBoard, delistFromBoard, listOnBoard, pruneListings } from './board';
import { buyStock, sellStock } from './stock';
import { canSurrender } from './surrender';

type TurnFrame = FrameOf<'TURN'>;

export function freshTurnState(): PlayerTurnState {
  return { forcedSteps: null, teleportedSelf: false, cardsUsed: 0, itemsUsed: 0, menuActions: 0, log: [] };
}

/**
 * 每回合开始刷新本人各股可买量：float ≤ 1000 时为 float，否则 floor(float × (1000 + rand15()%2000) / 10000)
 * @source exe v3.11 0x42915a（design/engine.md §7.2 步骤 1）
 */
function refreshQuota(ctx: Ctx, p: PlayerState): void {
  p.quota = ctx.s.stocks.map((st) => {
    if (st.float <= ECON.QUOTA_FLOAT_MIN) return st.float;
    const k = ECON.QUOTA_BASE + (ctx.rand15('quota') % ECON.QUOTA_RANGE);
    return Math.floor((st.float * k) / ECON.QUOTA_DEN);
  });
}

/** 关押类释放：搬到保释格、恢复进关押前的朝向、本回合走回棋盘（原版 +0x15|=0x10） */
function release(ctx: Ctx, p: PlayerState, where: ConfineWhere): void {
  const idx = ctx.map.index;
  if (where === 'jail' || where === 'hospital') {
    const gate = where === 'jail' ? idx.jailGate : idx.hospitalGate;
    p.node = gate;
    const nb = ctx.map.neighbors(gate);
    p.prevNode = p.savedPrevNode !== null && nb.includes(p.savedPrevNode) ? p.savedPrevNode : (nb[0] ?? gate);
  }
  // hotel / away 的去向属于 M4 / M7（旅馆原地、航空与出国回到原节点）
  p.savedPrevNode = null;
  p.returning = true;
}

/**
 * 首回合跳伞的落点：随机可放置格（排除有物件、路上神明的格）+ 随机来路邻格（⚑V-R2：落地后是否结算落点，M1 不结算）。
 * 只取随机数、不改 state：engine.md §7.2 规定跳伞（步骤 0）先于 refreshQuota（步骤 1）消耗随机数，
 * 而落地本身与 PARACHUTE 事件放在 TURN_STARTED 之后，公开变化随 PARACHUTE 公布。
 */
function parachuteSpot(ctx: Ctx): { node: TileId; prev: TileId } {
  const taken = new Set<TileId>(ctx.s.objects.map((o) => o.node));
  for (const g of ctx.s.gods) if (g.where.t === 'road') taken.add(g.where.node);
  const tiles = ctx.map.index.placeableTiles().filter((t) => !taken.has(t));
  if (tiles.length === 0) throw new EngineInvariantError('NO_PLACEABLE_TILE');
  const node = tiles[ctx.pick('parachute', tiles.length)]!;
  const nb = ctx.map.neighbors(node);
  const prev = nb.length > 0 ? nb[ctx.pick('parachute', nb.length)]! : node;
  return { node, prev };
}

function start(ctx: Ctx, f: TurnFrame): void {
  const s = ctx.s;
  const p = ctx.player(f.seat);
  if (!p.alive) {
    ctx.pop(f);
    return;
  }
  const actor = { t: 'seat', seat: f.seat } as const;
  s.clock.turnNo += 1;
  s.clock.cursor = { t: 'seat', seat: f.seat };
  p.turn = freshTurnState();
  // §7.2 步骤 0：未落地先跳伞（先取随机数），步骤 1 再刷新本人股票可买量
  const drop = p.placed ? null : parachuteSpot(ctx);
  refreshQuota(ctx, p);
  const released = tickActorCounters(p.st);
  // 保险、拒绝往来、同盟按两段式倒数（g_arbitration §3.2）；神明任期直接 −1；工程车 −1
  p.insuranceDays = tick2(p.insuranceDays).next;
  p.bankReject = tick2(p.bankReject).next;
  const allianceEnded = tickAlliance(ctx, p);
  const godExpired = tickGod(p);
  const engineerDue = tickEngineer(p);
  const research = tickResearch(ctx, f.seat);
  ctx.emit('TURN_STARTED', { actor, turnNo: s.clock.turnNo });
  // 公布栏：撤下资产已不在的挂牌
  pruneListings(ctx);

  if (checkLoan(ctx, f.seat)) {
    f.stage = 'end';
    return;
  }
  deliverResearch(ctx, f.seat, research);
  if (allianceEnded) expireAlliance(ctx, f.seat);
  if (godExpired) {
    const slot = attachedSlot(s, f.seat);
    if (slot !== null) leaveGod(ctx, slot, 'expired');
    else p.god = null;
  }
  if (engineerDue) restoreEngineer(ctx, f.seat);

  for (const where of released) {
    release(ctx, p, where);
    ctx.emit('RELEASED', { actor, from: where });
  }
  if (drop !== null) {
    p.placed = true;
    p.node = drop.node;
    p.prevNode = drop.prev;
    ctx.emit('PARACHUTE', { seat: f.seat, node: p.node, prev: p.prevNode });
  }

  const block = mainBlockOf(p.st);
  if (block !== null) {
    // 关押期间每天计入「本月倒楣天数」（月结悲情人物评分，M4）
    if (block === 'jail' || block === 'hospital') p.monthly.badDays += 1;
    ctx.emit('TURN_BLOCKED', { seat: f.seat, reason: block, remaining: displayRemaining(p.st[block]) });
    f.stage = 'end';
    return;
  }
  if (p.returning) {
    // 走回棋盘（@0x418f04）：不掷骰，只在当前格做物件结算（地雷、神明、礼物…，路障除外）、神明显灵与工程车拆房
    ctx.emit('RETURNED', { seat: f.seat, node: p.node });
    f.stage = 'landed';
    ctx.push({ k: 'LAND', actor, node: p.node, steps: 0, stage: 'object', skipSquare: true });
    return;
  }
  if (p.st.hibernate !== 0) {
    ctx.emit('TURN_BLOCKED', { seat: f.seat, reason: 'hibernate', remaining: displayRemaining(p.st.hibernate) });
    f.stage = 'end';
    return;
  }
  if (p.st.sleepwalk !== 0) {
    sleepwalkRoll(ctx, f);
    return;
  }
  f.stage = 'menu';
}

/**
 * 停留 → 0 步、乌龟 → 1 步（都不掷骰）；否则 null。菜单掷骰与梦游乱走共用（engine.md §7.4；原版走子闸门
 * 0x4012a7 先看这两个计数，g_arbitration §3.3），恶人同理（g_villains §2）。
 */
function lockedSteps(p: PlayerState): 0 | 1 | null {
  if (p.st.stay !== 0) return 0;
  if (p.st.tortoise !== 0) return 1;
  return null;
}

/** 原地停留（0 步）压 LAND 当前格（仍做落点结算），否则压 MOVE */
function pushWalk(ctx: Ctx, f: TurnFrame, p: PlayerState, steps: number, mode: 'normal' | 'sleepwalk'): void {
  f.stage = 'landed';
  const actor = { t: 'seat', seat: f.seat } as const;
  if (steps === 0) ctx.push({ k: 'LAND', actor, node: p.node, steps: 0, stage: 'beggar', skipSquare: false });
  else ctx.push({ k: 'MOVE', actor, remaining: steps, total: steps, seg: [], mode, bankPassed: false });
}

/** 梦游：强制 1 颗骰子自动乱走，不开 ATM，落点只结算过路费；停留 / 乌龟计数照样生效（0 步 / 1 步） */
function sleepwalkRoll(ctx: Ctx, f: TurnFrame): void {
  const p = ctx.player(f.seat);
  const locked = lockedSteps(p);
  const dice: DiceFace[] = locked === null ? [ctx.rollDie()] : [];
  const steps = locked ?? dice[0]!;
  ctx.emit('DICE_ROLLED', { seat: f.seat, dice, steps, forced: false, diceCount: 1 });
  pushWalk(ctx, f, p, steps, 'sleepwalk');
}

/** 神明任期 −1；到 0 返回 true（TURN_STARTED 之后离场） */
function tickGod(p: PlayerState): boolean {
  if (p.god === null) return false;
  const days = p.god.days - 1;
  p.god = { kind: p.god.kind, days: days > 0 ? days : 0 };
  return days <= 0;
}

/**
 * 同盟：期间每个自己的回合对盟友的敌意 −20×PI（不低于 0 ⚑）；天数两段式倒数，释放时返回 true（双方同时解除）。
 */
function tickAlliance(ctx: Ctx, p: PlayerState): boolean {
  const a = p.alliance;
  if (a === null) return false;
  const decay = timesPI(ctx, CMB.ALLIANCE_DECAY_PI);
  const h = p.hostility[a.seat] - decay;
  p.hostility[a.seat] = h > 0 ? h : 0;
  const r = tick2(a.days);
  p.alliance = { seat: a.seat, days: r.next };
  return r.released;
}

function expireAlliance(ctx: Ctx, seat: SeatIndex): void {
  const p = ctx.player(seat);
  const ally = p.alliance?.seat;
  if (ally === undefined) return;
  p.alliance = null;
  const q = ctx.s.players.find((x) => x.seat === ally);
  if (q?.alliance?.seat === seat) q.alliance = null;
  ctx.emit('ALLIANCE_EXPIRED', { a: seat, b: ally });
}

function roll(ctx: Ctx, f: TurnFrame, p: PlayerState, a: IntentOf<'ROLL'>): void {
  if (a.dice !== undefined) {
    if (!diceAllowed(p.vehicle).includes(a.dice)) {
      throw new EngineRuleError('OUT_OF_RANGE', `dice ${a.dice} exceeds vehicle ${p.vehicle}`, { dice: a.dice });
    }
    p.diceCount = a.dice;
  }
  const seat: SeatIndex = f.seat;
  let steps: number;
  let dice: DiceFace[] = [];
  let forced = false;
  const locked = lockedSteps(p);
  if (locked !== null) steps = locked;
  else if (p.turn.forcedSteps !== null) {
    steps = p.turn.forcedSteps;
    dice = [steps as DiceFace];
    forced = true;
  } else {
    for (let i = 0; i < p.diceCount; i++) dice.push(ctx.rollDie());
    steps = dice.reduce((x, y) => x + y, 0);
  }
  ctx.emit('DICE_ROLLED', { seat, dice, steps, forced, diceCount: p.diceCount });
  pushWalk(ctx, f, p, steps, 'normal');
}

function checkRow(row: MenuRow, what: string): void {
  if (!row.usable) throw new EngineRuleError('NOT_USABLE', `${what}: ${row.reason}`, { reason: row.reason });
}

/** USE_CARD：卡槽与卡号一致 → 可用 → 目标在候选里 → 额外校验；全部通过才扣卡（回牌堆）→ CARD_USED → 结算 */
function useCard(ctx: Ctx, f: TurnFrame, p: PlayerState, a: IntentOf<'USE_CARD'>): void {
  if (p.cards[a.slot] !== a.card) throw new EngineRuleError('INVALID_TARGET', `slot ${a.slot} is not card ${a.card}`);
  const eff = cardEffect(a.card);
  const row = eff.menu(ctx.s, ctx.map, f.seat);
  checkRow(row, `card ${a.card}`);
  if (!targetMatches(row.targets, a.target, (t) => ctx.map.hasTile(t))) {
    throw new EngineRuleError('INVALID_TARGET', `card ${a.card}: target not allowed`, { target: a.target.t });
  }
  const fail = eff.check?.(ctx.s, ctx.map, f.seat, a.target) ?? null;
  if (fail) throw new EngineRuleError(fail.rule, fail.msg);
  eff.before?.(ctx, f.seat, a.target);
  p.cards.splice(a.slot, 1);
  returnCardToDeck(ctx.s, a.card);
  p.turn.cardsUsed += 1;
  p.turn.log.push('card');
  ctx.emit('CARD_USED', { seat: f.seat, card: a.card, target: a.target });
  eff.apply(ctx, f.seat, a.target);
}

/** USE_ITEM：持有 → 可用 → 目标在候选里 → 额外校验 → 扣道具 → ITEM_USED → 结算；遥控骰子随即掷骰，传送自己结束回合 */
function useItem(ctx: Ctx, f: TurnFrame, p: PlayerState, a: IntentOf<'USE_ITEM'>): void {
  if ((p.items[a.item] ?? 0) <= 0) throw new EngineRuleError('INVALID_TARGET', `no item ${a.item}`);
  const eff = itemEffect(a.item);
  const row = eff.menu(ctx.s, ctx.map, f.seat);
  checkRow(row, `item ${a.item}`);
  if (!targetMatches(row.targets, a.target, (t) => ctx.map.hasTile(t))) {
    throw new EngineRuleError('INVALID_TARGET', `item ${a.item}: target not allowed`, { target: a.target.t });
  }
  const fail = eff.check?.(ctx.s, ctx.map, f.seat, a.target) ?? null;
  if (fail) throw new EngineRuleError(fail.rule, fail.msg);
  eff.before?.(ctx, f.seat, a.target);
  if (eff.consume === 'pool') removeItem(ctx.s, f.seat, a.item, 1);
  else p.items[a.item] = p.items[a.item]! - 1;
  p.turn.itemsUsed += 1;
  p.turn.log.push('item');
  ctx.emit('ITEM_USED', { seat: f.seat, item: a.item, target: a.target });
  eff.apply(ctx, f.seat, a.target);
  if (a.item === ITEM.REMOTE_DICE && p.turn.forcedSteps !== null) roll(ctx, f, p, { type: 'ROLL' });
  else if (p.turn.teleportedSelf) f.stage = 'end';
}

/** 非终结的菜单操作：股票买卖（M4）、卡片与道具（M6）、公布栏（M7，flow/board.ts） */
function menuAction(ctx: Ctx, f: TurnFrame, p: PlayerState, a: PlayerAction): void {
  switch (a.type) {
    case 'USE_CARD':
      useCard(ctx, f, p, a);
      return;
    case 'USE_ITEM':
      useItem(ctx, f, p, a);
      return;
    case 'STOCK_BUY':
      // 先记日志再成交：日志随 STOCK_TRADED 的 post 公布（非法时整个草稿丢弃）
      p.turn.log.push('stockBuy');
      buyStock(ctx, f.seat, a.stock, a.shares);
      return;
    case 'STOCK_SELL':
      p.turn.log.push('stockSell');
      sellStock(ctx, f.seat, a.stock, a.shares);
      return;
    case 'BOARD_LIST':
      listOnBoard(ctx, f.seat, a.asset, a.price);
      return;
    case 'BOARD_DELIST':
      delistFromBoard(ctx, f.seat, a.listingId);
      return;
    case 'BOARD_BUY':
      buyFromBoard(ctx, f.seat, a.listingId);
      return;
    default:
      throw new EngineRuleError('NOT_USABLE', `${a.type} is not available`, { intent: a.type });
  }
}

/** 名下研究所倒数（回合开始、TURN_STARTED 之前）；返回本回合到期的研究所下标 */
function tickResearch(ctx: Ctx, seat: SeatIndex): number[] {
  const done: number[] = [];
  ctx.s.facilities.forEach((fac, i) => {
    if (fac.owner !== seat || fac.research === null) return;
    fac.research = { project: fac.research.project, days: fac.research.days - 1 };
    if (fac.research.days <= 0) done.push(i);
  });
  return done;
}

/** 研发到期：交付道具 8+project（持有已满 9 个则作废）；研究所已不是 ≥ 项目等级的研究所则作废 */
function deliverResearch(ctx: Ctx, seat: SeatIndex, idx: readonly number[]): void {
  for (const i of idx) {
    const fac = ctx.s.facilities[i]!;
    const r = fac.research;
    if (r === null) continue;
    fac.research = null;
    if (fac.type !== 'lab' || fac.level < r.project || fac.owner !== seat) {
      ctx.emit('RESEARCH_CANCELLED', { seat, lot: fac.id, project: r.project });
      continue;
    }
    const item = researchItemOf(r.project);
    const got = receiveItem(ctx.s, seat, item, 1);
    ctx.emit('RESEARCH_DONE', { seat, lot: fac.id, project: r.project, item, delivered: got > 0 });
  }
}

/**
 * 贷款到期检查（exe 0x41c86d）：剩 3/2/1 天 → LOAN_REMINDER；≤0 天 → 按银行口径（先存款后现金）归还全部贷款，
 * 扣不出来就破产（返回 true，本回合随即结束）。
 */
function checkLoan(ctx: Ctx, seat: SeatIndex): boolean {
  const p = ctx.player(seat);
  if (p.loan <= 0 || p.loanDue === 0) return false;
  const left = daysBetween(ctx.s.clock.date, p.loanDue);
  if (left > 0) {
    if (left <= ECON.LOAN_REMINDER_DAYS) ctx.emit('LOAN_REMINDER', { seat, daysLeft: left });
    return false;
  }
  const amount = p.loan;
  const r = ctx.pay({ t: 'seat', seat }, { t: 'bank' }, amount, {
    order: 'depositFirst',
    reason: 'loanForced',
    cause: { k: 'loan', ref: null, by: null },
  });
  p.loan = 0;
  p.loanDue = 0;
  ctx.emit('LOAN_FORCED', { seat, amount, paid: r.paid });
  return r.bankrupt;
}

export const TURN: FrameHandler<TurnFrame> = {
  step(ctx, f) {
    switch (f.stage) {
      case 'start':
        start(ctx, f);
        return;
      case 'menu': {
        const p = ctx.player(f.seat);
        // 菜单操作之后复查：被关进监狱 / 医院（复仇、嫁祸、自己的飞弹）或冬眠 → 回合结束；被嫁祸梦游 → 自动乱走
        if (mainBlockOf(p.st) !== null || p.st.hibernate !== 0 || !p.alive) {
          f.stage = 'end';
          return;
        }
        if (p.st.sleepwalk !== 0) {
          sleepwalkRoll(ctx, f);
          return;
        }
        const opts = buildTurnMenu(ctx.s, ctx.map, f.seat);
        ctx.ask(
          f,
          f.seat,
          'TURN_MENU',
          opts,
          { type: 'ROLL' },
          {},
          {
            budgetKey: turnMenuBudgetKey(ctx.s.clock.turnNo, f.seat),
          },
        );
        return;
      }
      case 'rolled':
      case 'landed':
        f.stage = 'end';
        return;
      case 'end': {
        const p = ctx.player(f.seat);
        p.turn = freshTurnState();
        p.returning = false;
        ctx.emit('TURN_ENDED', { actor: { t: 'seat', seat: f.seat } });
        ctx.pop(f);
        return;
      }
    }
  },
  resume(ctx, f, a) {
    if (f.stage !== 'menu') throw new EngineInvariantError('TURN_RESUME_STAGE', f.stage);
    const p = ctx.player(f.seat);
    switch (a.type) {
      case 'ROLL':
        // 时光机锚点：真人掷骰前的世界（还没有任何修改；rules.timeMachine='disabled' 或电脑座位时不记）
        captureAnchor(ctx, f.seat);
        roll(ctx, f, p, a);
        return;
      case 'SURRENDER':
        // 投降（真人 ≥ 2、在场 ≥ 3）：压 SURRENDER 帧（召唤死神 → 清算），本回合随即结束
        if (!canSurrender(ctx.s, f.seat)) throw new EngineRuleError('NOT_ALLOWED', 'cannot surrender now');
        f.stage = 'end';
        ctx.push({ k: 'SURRENDER', seat: f.seat, stage: 'announce', auctionLots: [] });
        return;
      default:
        if (p.turn.menuActions >= MENU_ACTION_LIMIT) {
          throw new EngineRuleError('MENU_LIMIT', `more than ${MENU_ACTION_LIMIT} menu actions this turn`);
        }
        p.turn.menuActions += 1;
        menuAction(ctx, f, p, a);
    }
  },
};
