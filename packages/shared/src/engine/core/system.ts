/**
 * 系统 action（只能由服务器产生，architecture §5.5）：
 * - MINIGAME_RESULT：小游戏裁判重放后的结算（M8）；
 * - SYS_SET_CONTROLLER：被踢后转为纯电脑（托管不改 controller）→ CONTROLLER_CHANGED；
 * - SYS_SET_AI_TRAITS：托管设置写入 aiTraits（随存档保存）→ AI_TRAITS_CHANGED；
 * - SYS_DEBUG：要求 config.debug（RICH4_TEST_MODE），forceNext / setCash / setPoints / teleport / give / setDate → DEBUG_APPLIED。
 * 这些 action 不改变帧栈与待决策，所以当前的 pending 保持不变。
 */
import { ECON } from '../../data/tables/economy';
import { EngineRuleError } from '../errors';
import { applyCalendar } from '../flow/day';
import { isValidDate } from '../rules/calendar';
import { receiveCard, receiveItem, takeFromDeck } from '../rules/inventory';
import { type AiTraits, isSeatIndex, type SeatIndex } from '../types/ids';
import { type DebugOp, DebugOpSchema, type SystemAction } from '../types/intent';
import type { PlayerState } from '../types/state';
import type { Ctx } from './ctx';

function playerOrThrow(ctx: Ctx, seat: SeatIndex): PlayerState {
  if (!isSeatIndex(seat)) throw new EngineRuleError('BAD_SEAT', `seat ${String(seat)}`);
  const p = ctx.s.players.find((x) => x.seat === seat);
  if (!p) throw new EngineRuleError('BAD_SEAT', `no player at seat ${seat}`);
  return p;
}

function isRatio(x: unknown): boolean {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 100;
}

function validTraits(t: AiTraits): boolean {
  return (
    t !== null &&
    typeof t === 'object' &&
    (t.personality === 0 || t.personality === 1 || t.personality === 2) &&
    typeof t.useCards === 'boolean' &&
    typeof t.useItems === 'boolean' &&
    isRatio(t.loanRatio) &&
    isRatio(t.cashRatio) &&
    isRatio(t.stockRatio)
  );
}

export function handleSystem(ctx: Ctx, a: SystemAction): void {
  switch (a.type) {
    case 'MINIGAME_RESULT': {
      const d = ctx.s.pending.find((p) => p.id === a.decisionId);
      if (!d) throw new EngineRuleError('STALE_DECISION');
      if (d.seat !== a.seat) throw new EngineRuleError('NOT_YOUR_DECISION');
      if (d.kind !== 'MINIGAME') throw new EngineRuleError('INTENT_NOT_ALLOWED');
      // TODO(M8)：按 spec.scoreSanityMax 夹紧 score，点券 += score → MINIGAME_ENDED{mode:'played'}
      throw new EngineRuleError('NOT_ALLOWED', 'minigames are not implemented yet');
    }
    case 'SYS_SET_CONTROLLER': {
      const p = playerOrThrow(ctx, a.seat);
      if (a.controller !== 'human' && a.controller !== 'ai') throw new EngineRuleError('BAD_ACTION', 'controller');
      p.controller = a.controller;
      ctx.emit('CONTROLLER_CHANGED', { seat: a.seat, controller: a.controller });
      return;
    }
    case 'SYS_SET_AI_TRAITS': {
      const p = playerOrThrow(ctx, a.seat);
      if (!validTraits(a.traits)) throw new EngineRuleError('BAD_ACTION', 'traits');
      p.aiTraits = { ...a.traits };
      ctx.emit('AI_TRAITS_CHANGED', { seat: a.seat });
      return;
    }
    case 'SYS_DEBUG': {
      if (!ctx.s.config.debug) throw new EngineRuleError('NOT_DEBUG');
      const parsed = DebugOpSchema.safeParse(a.op);
      if (!parsed.success) throw new EngineRuleError('BAD_ACTION', parsed.error.message);
      applyDebug(ctx, parsed.data);
      ctx.emit('DEBUG_APPLIED', { op: a.op.op });
      return;
    }
  }
}

function applyDebug(ctx: Ctx, op: DebugOp): void {
  const s = ctx.s;
  switch (op.op) {
    case 'forceNext':
      s.secret.debugQueue.push({ purpose: op.purpose, values: op.values.slice() });
      return;
    case 'setCash': {
      const p = playerOrThrow(ctx, op.seat);
      // 台账：调试改钱视为铸造 / 销毁
      const delta = op.cash - p.cash + (op.deposit === null ? 0 : op.deposit - p.deposit);
      p.cash = op.cash;
      if (op.deposit !== null) p.deposit = op.deposit;
      if (delta > 0) s.econ.ledger.minted += delta;
      else s.econ.ledger.burned += -delta;
      return;
    }
    case 'setPoints': {
      const p = playerOrThrow(ctx, op.seat);
      p.points = Math.min(op.points, ECON.POINTS_MAX);
      return;
    }
    case 'teleport': {
      const p = playerOrThrow(ctx, op.seat);
      if (!ctx.map.hasTile(op.node)) throw new EngineRuleError('INVALID_TARGET', `no tile ${op.node}`);
      const nb = ctx.map.neighbors(op.node);
      let prev: number;
      if (op.prev !== undefined) {
        if (!nb.includes(op.prev)) throw new EngineRuleError('INVALID_TARGET', `${op.prev} is not next to ${op.node}`);
        prev = op.prev;
      } else prev = nb.includes(p.prevNode) ? p.prevNode : (nb[0] ?? op.node);
      p.node = op.node;
      p.prevNode = prev;
      p.placed = true;
      return;
    }
    case 'give': {
      const p = playerOrThrow(ctx, op.seat);
      for (const c of op.cards) {
        if (!takeFromDeck(s, c)) throw new EngineRuleError('OUT_OF_RANGE', `card ${c} is not in the deck`);
        receiveCard(s, p.seat, c);
      }
      for (const it of op.items) receiveItem(s, p.seat, it.item, it.qty);
      return;
    }
    case 'setDate': {
      if (!isValidDate(op.date)) throw new EngineRuleError('OUT_OF_RANGE', `bad date ${op.date}`);
      s.clock.date = op.date;
      applyCalendar(s, ctx.map.def.holidays);
      return;
    }
  }
}
