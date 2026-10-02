/**
 * 从决策的 options 里均匀抽一个合法 intent（属性测试、fuzz、simulate --policy random 用）。
 * 使用独立的 xoshiro 流，不消耗引擎 RNG。覆盖 M1 的 TURN_MENU（掷骰颗数）、BUY_LAND、UPGRADE_LAND，
 * M4 的股票买卖、银行、设施、研究所、百货、乐透、认购、建设公司，
 * M6 的用卡、用道具（按候选取样）、保释、免费卡、嫁祸卡、满手弃牌；收起交通工具（STOW_VEHICLE）；
 * M7 的公布栏（挂牌 / 撤牌 / 购买）、投降、雇恶人、拍卖出价、魔法屋、死神目标、生日挑卡；
 * 其余 kind 退回 defaultIntent（它总是合法的）。
 * anyNode（飞弹、核弹）没有候选列表：用 hint.nodes（randomAction 取玩家与物件所在格）。
 */
import { seedFromHex, type XoshiroState, xoshiroInt } from '../../util/rng/xoshiro';
import { asAnyPending, type PendingDecision, type TargetCandidates } from '../types/decision';
import type { TileId } from '../types/ids';
import type { GameAction, PlayerIntent, UseTarget } from '../types/intent';
import type { GameState } from '../types/state';

export interface IntentRng {
  /** 0..n-1 */
  int(n: number): number;
}

export function intentRng(seedHex: string): IntentRng {
  const st: XoshiroState = seedFromHex(seedHex);
  return { int: (n) => xoshiroInt(st, n) };
}

function choose<T>(rng: IntentRng, xs: readonly T[]): T {
  return xs[rng.int(xs.length)]!;
}

function half(n: number): number {
  return Math.max(1, Math.trunc(n / 2));
}

/** 每种候选最多取样的目标数（控制 TURN_MENU 候选规模） */
const TARGET_SAMPLES = 4;

export interface IntentHint {
  /** anyNode 目标可用的格 */
  nodes: readonly TileId[];
}

/** 从候选里取样几个合法目标（按候选顺序取前几个） */
export function sampleTargets(c: TargetCandidates, hint: IntentHint = { nodes: [] }): UseTarget[] {
  const n = TARGET_SAMPLES;
  switch (c.t) {
    case 'none':
    case 'auto':
      return [{ t: 'none' }];
    case 'seat':
      return c.seats.slice(0, n).map((seat) => ({ t: 'seat', seat }));
    case 'actor':
      return c.actors.slice(0, n).map((actor) => ({ t: 'actor', actor }));
    case 'lot':
      return c.lots
        .slice(0, n)
        .map((lot) => ({ t: 'lot', lot, facility: c.needType.includes(lot) ? ('hotel' as const) : null }));
    case 'underfoot':
      return c.types === null
        ? [{ t: 'underfoot', facility: null }]
        : c.types.slice(0, n).map((facility) => ({ t: 'underfoot', facility }));
    case 'lotPair':
      return c.to.slice(0, n).map((to) => ({ t: 'lotPair', from: c.from, to }));
    case 'lotOrObject':
      return [
        ...c.lots.slice(0, n).map((lot): UseTarget => ({ t: 'lot', lot, facility: null })),
        ...c.objects.slice(0, n).map((object): UseTarget => ({ t: 'object', object })),
      ];
    case 'stock':
      return c.stocks.slice(0, n).map((stock) => ({ t: 'stock', stock }));
    case 'node':
      return c.nodes.slice(0, n).map((node) => ({ t: 'node', node }));
    case 'anyNode':
      return hint.nodes.slice(0, n).map((node) => ({ t: 'node', node }));
    case 'dice':
      return c.values.map((value) => ({ t: 'dice', value }));
    case 'rob': {
      const out: UseTarget[] = [];
      for (const v of c.victims.slice(0, n)) {
        const card = v.cards[0];
        if (card) out.push({ t: 'rob', seat: v.seat, take: { k: 'card', slot: card.slot } });
        const item = v.items[0];
        if (item) out.push({ t: 'rob', seat: v.seat, take: { k: 'item', item: item.item } });
      }
      return out;
    }
    case 'teleport': {
      const out: UseTarget[] = [];
      for (const source of c.sources.slice(0, n)) {
        if (source.k === 'house') {
          const lot = c.lands.find((l) => l[0] === source.lot[0]);
          if (lot) out.push({ t: 'teleport', source, dest: { k: 'lot', lot } });
        } else if (c.roads.length > 0) {
          out.push({ t: 'teleport', source, dest: { k: 'road', node: c.roads[c.roads.length - 1]! } });
        }
      }
      return out;
    }
  }
}

/** 当前决策的全部候选 intent（已实现的 kind 逐一枚举；其余只含 defaultIntent） */
export function candidateIntents(d: PendingDecision, hint: IntentHint = { nodes: [] }): PlayerIntent[] {
  const a = asAnyPending(d);
  switch (a.kind) {
    case 'TURN_MENU': {
      const o = a.options;
      const out: PlayerIntent[] =
        o.dice.locked !== null
          ? [{ type: 'ROLL' }]
          : [{ type: 'ROLL' }, ...o.dice.allowed.map((n): PlayerIntent => ({ type: 'ROLL', dice: n }))];
      if (o.menuActions.used < o.menuActions.limit) {
        for (const r of o.stock.rows) {
          if (r.maxBuy > 0) out.push({ type: 'STOCK_BUY', stock: r.idx, shares: half(r.maxBuy) });
          if (r.maxSell > 0) out.push({ type: 'STOCK_SELL', stock: r.idx, shares: r.maxSell });
        }
        for (const r of o.cards) {
          if (!r.usable) continue;
          for (const target of sampleTargets(r.targets, hint)) {
            out.push({ type: 'USE_CARD', slot: r.slot, card: r.card, target });
          }
        }
        for (const r of o.items) {
          if (!r.usable) continue;
          for (const target of sampleTargets(r.targets, hint)) out.push({ type: 'USE_ITEM', item: r.item, target });
        }
        // 收起机车 / 汽车（真人专用的非终结 intent；随机对局对所有座位都会挑，引擎不看座位的控制方）
        if (o.vehicle?.canStow) out.push({ type: 'STOW_VEHICLE' });
        // M7 公布栏：买别人的、撤自己的、挂一件（地产按上限的一半标价）
        for (const l of o.board.listings.slice(0, TARGET_SAMPLES)) {
          if (l.mine) out.push({ type: 'BOARD_DELIST', listingId: l.id });
          else if (l.affordable) out.push({ type: 'BOARD_BUY', listingId: l.id });
        }
        if (o.board.canList && o.board.mine < 7) {
          // 未挂出的数量 = 持有量 − 自己有效挂牌已认领的数量（options 只列有效挂牌）
          const mine = o.board.listings.filter((l) => l.mine).map((l) => l.asset);
          const listed = (pred: (a: (typeof mine)[number]) => number) => mine.reduce((n, a) => n + pred(a), 0);
          const cap = o.board.lotCaps[0];
          if (cap) out.push({ type: 'BOARD_LIST', asset: { t: 'lot', lot: cap.lot }, price: half(cap.cap) });
          const card = o.cards.find(
            (r) =>
              o.cards.filter((x) => x.card === r.card).length -
                listed((a) => (a.t === 'card' && a.card === r.card ? 1 : 0)) >
              0,
          );
          if (card) out.push({ type: 'BOARD_LIST', asset: { t: 'card', card: card.card }, price: 1000 });
          for (const r of o.stock.rows) {
            const free = r.shares - listed((a) => (a.t === 'stock' && a.stock === r.idx ? a.shares : 0));
            if (free > 0) {
              out.push({ type: 'BOARD_LIST', asset: { t: 'stock', stock: r.idx, shares: free }, price: 500 });
              break;
            }
          }
          const item = o.items.find(
            (r) => r.count - listed((a) => (a.t === 'item' && a.item === r.item ? a.qty : 0)) > 0,
          );
          if (item) out.push({ type: 'BOARD_LIST', asset: { t: 'item', item: item.item, qty: 1 }, price: 300 });
        }
      }
      if (o.canSurrender) out.push({ type: 'SURRENDER' });
      return out;
    }
    case 'BAIL':
      return [
        { type: 'SKIP' },
        ...a.options.inmates.map((i): PlayerIntent => ({ type: 'BAIL', target: i.seat })),
        ...a.options.villains.filter((v) => v.available).map((v): PlayerIntent => ({ type: 'HIRE', villain: v.kind })),
      ];
    case 'AUCTION_BID':
      return [
        { type: 'PASS' },
        { type: 'QUIT' },
        ...a.options.increments.map((inc): PlayerIntent => ({ type: 'BID', inc })),
      ];
    case 'MAGIC_CAST':
      return a.options.effects.map((effect): PlayerIntent => ({ type: 'MAGIC_CAST', effect }));
    case 'DEATH_GOD_TARGET':
      return a.options.candidates.map((target): PlayerIntent => ({ type: 'DEATH_GOD_TARGET', target }));
    case 'BIRTHDAY_PICK':
      return [
        d.defaultIntent,
        {
          type: 'PICK_CARDS',
          picks: a.options.victims.map((v) => ({ from: v.seat, slot: v.cards[v.cards.length - 1]!.slot })),
        },
      ];
    case 'USE_FREE_CARD':
      return [{ type: 'CONFIRM' }, { type: 'DECLINE' }];
    case 'SCAPEGOAT':
      return [
        { type: 'DECLINE' },
        ...a.options.candidates.map((t): PlayerIntent => ({ type: 'SCAPEGOAT', target: t })),
      ];
    case 'DISCARD_CARD':
      return a.options.hand.map((h): PlayerIntent => ({ type: 'DISCARD', slot: h.slot }));
    case 'BUY_LAND':
      return a.options.price <= a.options.cash ? [{ type: 'CONFIRM' }, { type: 'DECLINE' }] : [{ type: 'DECLINE' }];
    case 'UPGRADE_LAND':
      return a.options.cost <= a.options.cash ? [{ type: 'CONFIRM' }, { type: 'DECLINE' }] : [{ type: 'DECLINE' }];
    case 'BUY_FACILITY':
      return a.options.price <= a.options.cash ? [{ type: 'CONFIRM' }, { type: 'DECLINE' }] : [{ type: 'DECLINE' }];
    case 'UPGRADE_FACILITY':
      return a.options.cost <= a.options.cash ? [{ type: 'CONFIRM' }, { type: 'DECLINE' }] : [{ type: 'DECLINE' }];
    case 'BUILD_FACILITY':
      return [
        { type: 'DECLINE' },
        ...a.options.types.map((t): PlayerIntent => ({ type: 'BUILD_FACILITY', facility: t.type })),
      ];
    case 'FACILITY_TYPE':
      return a.options.types.map((t): PlayerIntent => ({ type: 'CHOOSE_FACILITY_TYPE', facility: t.type }));
    case 'RESEARCH':
      return [
        { type: 'SKIP' },
        ...a.options.projects.map((p): PlayerIntent => ({ type: 'RESEARCH', project: p.project })),
      ];
    case 'BANK_ATM': {
      const o = a.options;
      const out: PlayerIntent[] = [{ type: 'SKIP' }];
      if (o.cash > 0) {
        out.push({ type: 'ATM', op: 'deposit', amount: o.cash }, { type: 'ATM', op: 'deposit', amount: half(o.cash) });
      }
      if (o.canWithdraw && o.deposit > 0) {
        out.push(
          { type: 'ATM', op: 'withdraw', amount: o.deposit },
          { type: 'ATM', op: 'withdraw', amount: half(o.deposit) },
        );
      }
      return out;
    }
    case 'BANK_COUNTER': {
      const o = a.options;
      const out: PlayerIntent[] = [{ type: 'SKIP' }];
      if (o.loanBlocked === null && o.loanLimit > 0) {
        out.push({ type: 'LOAN', amount: o.loanLimit }, { type: 'LOAN', amount: half(o.loanLimit) });
      }
      if (o.repayMax > 0) out.push({ type: 'REPAY', amount: o.repayMax }, { type: 'REPAY', amount: half(o.repayMax) });
      if ((o.financeLimit ?? 0) > 0) out.push({ type: 'FINANCE', amount: o.financeLimit! });
      return out;
    }
    case 'SHOP': {
      const o = a.options;
      const out: PlayerIntent[] = [{ type: 'LEAVE' }];
      if (o.visit.remaining <= 0) return out;
      for (const r of o.shelf) if (r.buyable) out.push({ type: 'SHOP_BUY_CARD', shelfIdx: r.idx });
      for (const r of o.items) if (r.maxQty > 0) out.push({ type: 'SHOP_BUY_ITEM', item: r.item, qty: 1 });
      for (const r of o.sell.cards) out.push({ type: 'SHOP_SELL_CARD', slot: r.slot });
      for (const r of o.sell.items) out.push({ type: 'SHOP_SELL_ITEM', item: r.item, qty: r.count });
      return out;
    }
    case 'LOTTERY': {
      const out: PlayerIntent[] = [{ type: 'SKIP' }];
      a.options.sold.forEach((o, i) => {
        if (o === null && out.length < 4) out.push({ type: 'LOTTERY_BUY', number: i });
      });
      return out;
    }
    case 'SUBSCRIBE_SHARES':
      return [
        { type: 'SKIP' },
        { type: 'SUBSCRIBE', shares: a.options.max },
        { type: 'SUBSCRIBE', shares: half(a.options.max) },
      ];
    case 'CONSTRUCTION_PICK':
      return [
        ...(a.options.canSkip ? [{ type: 'SKIP' } as PlayerIntent] : []),
        ...a.options.lots.map((l): PlayerIntent => ({ type: 'PICK_LOT', lot: l.lot })),
      ];
    default:
      return [d.defaultIntent];
  }
}

export function randomIntent(d: PendingDecision, rng: IntentRng, hint?: IntentHint): PlayerIntent {
  return choose(rng, candidateIntents(d, hint));
}

/** anyNode 目标的取样：在场玩家与路面物件所在的格 */
export function intentHint(state: GameState): IntentHint {
  const nodes: TileId[] = [];
  for (const p of state.players) if (p.alive && p.placed && !nodes.includes(p.node)) nodes.push(p.node);
  for (const o of state.objects) if (!nodes.includes(o.node)) nodes.push(o.node);
  return { nodes };
}

/** 从当前待决策中随机挑一个（并发时也随机挑座位），生成合法的 GameAction；没有待决策返回 null */
export function randomAction(state: GameState, rng: IntentRng): GameAction | null {
  if (state.pending.length === 0) return null;
  const d = state.pending.length === 1 ? state.pending[0]! : choose(rng, state.pending);
  return { ...randomIntent(d, rng, intentHint(state)), seat: d.seat, decisionId: d.id } as GameAction;
}
