/**
 * TURN 帧（design/engine.md §7.2–§7.4、§7.7；docs/research/g_arbitration.md §3）。
 *
 * start  回合数 +1、清空回合临时状态、刷新股票可买量、计数器两段式推进 → TURN_STARTED；
 *        释放 → RELEASED；首回合跳伞 → PARACHUTE；
 *        主阻碍 ≠0 → TURN_BLOCKED → end；刚释放（returning）→ RETURNED，走回棋盘不掷骰 → end；
 *        冬眠 → TURN_BLOCKED → end；梦游 → 自动掷 1 颗骰子乱走；否则 menu。
 * menu   TURN_MENU 决策。ROLL{dice?}（校验交通工具上限）是终结 intent；其余为非终结（每回合 ≤ 40 次，M4/M6/M7 实现）。
 * landed MOVE / LAND 出栈后 → end。
 * end    清空回合临时状态 → TURN_ENDED → 出栈。
 *
 * 钩子：贷款到期检查（M4）、神明 / 同盟 / 工程车 / 研究所倒数（M4/M6）、走回棋盘时的物件结算（M6）、时光机锚点（M7）。
 */
import { ECON } from '../../data/tables/economy';
import type { Ctx } from '../core/ctx';
import type { FrameHandler } from '../core/frameHandler';
import { buildTurnMenu } from '../decisions/build';
import { turnMenuBudgetKey } from '../decisions/timing';
import { EngineInvariantError, EngineRuleError } from '../errors';
import { displayRemaining, mainBlockOf, tickActorCounters } from '../rules/counters';
import { diceAllowed } from '../rules/movement';
import { MENU_ACTION_LIMIT } from '../types/decision';
import type { ConfineWhere, FrameOf } from '../types/frames';
import type { DiceFace, SeatIndex, TileId } from '../types/ids';
import type { IntentOf, PlayerAction } from '../types/intent';
import type { PlayerState, PlayerTurnState } from '../types/state';

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
 * 首回合跳伞的落点：随机可放置格（排除有物件的格）+ 随机来路邻格（⚑V-R2：落地后是否结算落点，M1 不结算）。
 * 只取随机数、不改 state：engine.md §7.2 规定跳伞（步骤 0）先于 refreshQuota（步骤 1）消耗随机数，
 * 而落地本身与 PARACHUTE 事件放在 TURN_STARTED 之后，公开变化随 PARACHUTE 公布。
 */
function parachuteSpot(ctx: Ctx): { node: TileId; prev: TileId } {
  const taken = new Set<TileId>(ctx.s.objects.map((o) => o.node));
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
  // TODO(M4)：贷款到期检查（剩 3/2/1 天 LOAN_REMINDER；到期按银行口径强制还款，扣不出来就破产）
  const released = tickActorCounters(p.st);
  // TODO(M4/M6)：同盟、保险、拒贷、神明任期、研究所、工程车的倒数
  ctx.emit('TURN_STARTED', { actor, turnNo: s.clock.turnNo });

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
    // 走回棋盘：不掷骰，只在当前格做物件结算（路障除外）——TODO(M6)：物件、神明显灵、工程车
    ctx.emit('RETURNED', { seat: f.seat, node: p.node });
    f.stage = 'end';
    return;
  }
  if (p.st.hibernate !== 0) {
    ctx.emit('TURN_BLOCKED', { seat: f.seat, reason: 'hibernate', remaining: displayRemaining(p.st.hibernate) });
    f.stage = 'end';
    return;
  }
  if (p.st.sleepwalk !== 0) {
    // 梦游：强制 1 颗骰子自动乱走，不开 ATM，落点只结算过路费
    const die = ctx.rollDie();
    ctx.emit('DICE_ROLLED', { seat: f.seat, dice: [die], steps: die, forced: false, diceCount: 1 });
    f.stage = 'landed';
    ctx.push({ k: 'MOVE', actor, remaining: die, total: die, seg: [], mode: 'sleepwalk', bankPassed: false });
    return;
  }
  f.stage = 'menu';
}

function roll(ctx: Ctx, f: TurnFrame, p: PlayerState, a: IntentOf<'ROLL'>): void {
  if (a.dice !== undefined) {
    if (!diceAllowed(p.vehicle).includes(a.dice)) {
      throw new EngineRuleError('OUT_OF_RANGE', `dice ${a.dice} exceeds vehicle ${p.vehicle}`, { dice: a.dice });
    }
    p.diceCount = a.dice;
  }
  // TODO(M7)：timeMachine !== 'disabled' 且 controller=human 时，用 applyAction 入参（掷骰前的世界）刷新时光机锚点
  const seat: SeatIndex = f.seat;
  let steps: number;
  let dice: DiceFace[] = [];
  let forced = false;
  if (p.st.stay !== 0) steps = 0;
  else if (p.st.tortoise !== 0) steps = 1;
  else if (p.turn.forcedSteps !== null) {
    steps = p.turn.forcedSteps;
    dice = [steps as DiceFace];
    forced = true;
  } else {
    for (let i = 0; i < p.diceCount; i++) dice.push(ctx.rollDie());
    steps = dice.reduce((x, y) => x + y, 0);
  }
  ctx.emit('DICE_ROLLED', { seat, dice, steps, forced, diceCount: p.diceCount });
  f.stage = 'landed';
  const actor = { t: 'seat', seat } as const;
  if (steps === 0) ctx.push({ k: 'LAND', actor, node: p.node, steps: 0, stage: 'beggar', skipSquare: false });
  else ctx.push({ k: 'MOVE', actor, remaining: steps, total: steps, seg: [], mode: 'normal', bankPassed: false });
}

/** 非终结的菜单操作（M4 股票、M6 卡片与道具、M7 公布栏）；M1 一律不可用 */
function menuAction(ctx: Ctx, f: TurnFrame, p: PlayerState, a: PlayerAction): void {
  void ctx;
  void f;
  void p;
  throw new EngineRuleError('NOT_USABLE', `${a.type} is not available yet`, { intent: a.type });
}

export const TURN: FrameHandler<TurnFrame> = {
  step(ctx, f) {
    switch (f.stage) {
      case 'start':
        start(ctx, f);
        return;
      case 'menu': {
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
        roll(ctx, f, p, a);
        return;
      case 'SURRENDER':
        // TODO(M7)：投降（≥2 名真人时召唤死神）；options.canSurrender=false
        throw new EngineRuleError('NOT_ALLOWED', 'surrender is not available yet');
      default:
        if (p.turn.menuActions >= MENU_ACTION_LIMIT) {
          throw new EngineRuleError('MENU_LIMIT', `more than ${MENU_ACTION_LIMIT} menu actions this turn`);
        }
        p.turn.menuActions += 1;
        menuAction(ctx, f, p, a);
    }
  },
};
