/**
 * 系统 action（只能由服务器产生，architecture §5.5）：
 * - MINIGAME_RESULT：小游戏裁判重放后的结算（M8）；
 * - SYS_SET_CONTROLLER：被踢后转为纯电脑（托管不改 controller）→ CONTROLLER_CHANGED；
 * - SYS_SET_AI_TRAITS：托管设置写入 aiTraits（随存档保存）→ AI_TRAITS_CHANGED；
 * - SYS_DEBUG：要求 config.debug（RICH4_TEST_MODE），forceNext / setCash / setPoints / teleport / give / setDate / clearBoard
 *   → DEBUG_APPLIED。
 * 除 MINIGAME_RESULT（回答 MINIGAME 决策，随后照常推进帧栈）外，这些 action 不改变帧栈；
 * 唯一例外：SYS_DEBUG 改了手牌道具、钱、点券或清空了路面时，待答的回合菜单按新状态重发（新 decisionId），
 * 否则调试发的卡要等到下一回合才出现在菜单里（只在测试模式发生，不影响正式对局）。
 */
import { ECON } from '../../data/tables/economy';
import { EngineRuleError } from '../errors';
import { applyCalendar } from '../flow/day';
import { isValidDate } from '../rules/calendar';
import { receiveCard, receiveItem, takeFromDeck } from '../rules/inventory';
import { resolveMinigameResult } from '../squares/minigame';
import { type AiTraits, ITEM, type ItemId, isSeatIndex, type SeatIndex } from '../types/ids';
import { type DebugOp, DebugOpSchema, type SystemAction } from '../types/intent';
import type { PlayerState, RoadObjectKind } from '../types/state';
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
    case 'MINIGAME_RESULT':
      // 结束 MINIGAME 决策并结算（squares/minigame.ts）；这是唯一会改变待决策的系统 action
      resolveMinigameResult(ctx, a);
      return;
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
      if (MENU_REFRESH_OPS.has(parsed.data.op)) refreshTurnMenu(ctx);
      return;
    }
  }
}

/** 路面物件 → 共享库存里的道具（路障 2、地雷 3、定时炸弹 4；礼物、宝箱不占库存） */
const OBJECT_ITEM: Readonly<Record<RoadObjectKind, ItemId | null>> = {
  roadblock: ITEM.ROADBLOCK,
  mine: ITEM.MINE,
  bomb: ITEM.TIME_BOMB,
  gift: null,
  chest: null,
};

/**
 * 会改变回合菜单内容（卡片 / 道具行、可用性）的调试操作。teleport 不在内：场景测试常用它摆位置后再掷骰，
 * 重发菜单会重新走 menu 阶段的复查（例如梦游自动乱走）；需要按新位置算目标时先 teleport 再 give。
 */
const MENU_REFRESH_OPS: ReadonlySet<DebugOp['op']> = new Set(['give', 'setCash', 'setPoints', 'clearBoard']);

/**
 * 回合菜单是唯一待决策、且 TURN 帧停在 menu 阶段时撤掉它；随后的 run 循环按新状态重新发出 TURN_MENU。
 * 有其他并发决策时不动（菜单会在那些决策结束后自然重建）。
 */
function refreshTurnMenu(ctx: Ctx): void {
  const pending = ctx.s.pending;
  if (pending.length !== 1) return;
  const d = pending[0];
  if (d?.kind !== 'TURN_MENU') return;
  const f = ctx.findFrame(d.frameId);
  if (f?.k !== 'TURN' || f.stage !== 'menu') return;
  ctx.clearPending(d.id);
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
    case 'clearBoard': {
      for (const o of s.objects) {
        const item = OBJECT_ITEM[o.kind];
        if (item !== null) s.pools.items[item] = (s.pools.items[item] ?? 0) + 1;
      }
      s.objects = [];
      for (const g of s.gods) if (g.where.t === 'road') g.where = { t: 'absent' };
      return;
    }
  }
}
