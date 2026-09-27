/**
 * 时光机的联机语义（design/engine.md §10.10；architecture §7.3 DEV-05；rules.timeMachine）。
 *
 * 锚点：真人座位（controller='human'）在 TURN_MENU 提交 ROLL 时，用掷骰前的世界（公开世界 + 帧栈 + 新闻命运的牌序与游标）
 *   生成锚点；锚点不含 rng、counters、上一个锚点与待决策（锚点时刻的 TURN 帧停在 menu 阶段）。
 *   'global'：全场一个锚点（secret.timeAnchor），每次真人掷骰都覆盖（原版行为）；
 *   'perSeat'：每个座位一个（secret.timeAnchors[seat]）；'disabled'：不记锚点、时光机不可用。
 * 使用（TURN_MENU 的 USE_ITEM 10，只有真人能用；AI 永不使用）：
 *   1 TIME_REWOUND{bySeat, toTurnNo}（此时还没有任何回滚）；
 *   2 恢复锚点世界：rng 与 counters 保持当前值（决策 id、帧 id、物件 id 都不回退）；v / engine / dataRef / config 与
 *     各座位的 controller / aiTraits（服务器写入的系统状态）保持当前值；
 *   3 恢复后的世界里使用者的时光机 −1（最低 0），并用扣减后的世界更新锚点（反复使用不会让时光机「回来」）；perSeat 时
 *     其他座位在恢复点之后的锚点作废、之前的锚点里使用者的时光机也 −1；
 *   4 清空待决策，补发一个完整的 SYNC{reason:'timeRewind'}（客户端遇到 TIME_REWOUND 直接用批尾 view reset）；
 *   5 随后 run 循环从锚点的帧栈继续：轮到锚点座位重新发 TURN_MENU。
 * 服务器 journal 照常记录这个 action，所以重放仍然确定。
 */
import { ITEM } from '../../data/tables/ids';
import { cloneJson } from '../core/clone';
import type { Ctx } from '../core/ctx';
import { publicWorld } from '../core/postPatch';
import type { SeatIndex } from '../types/ids';
import type { AnchorWorld, GameState, PublicWorld, TimeAnchor } from '../types/state';
import type { ItemEffect } from './types';
import { unusable, usable } from './types';

/** 当前适用于 seat 的锚点（global：全场唯一；perSeat：自己的）；没有返回 null */
export function anchorFor(s: GameState, seat: SeatIndex): TimeAnchor | null {
  const mode = s.config.rules.timeMachine;
  if (mode === 'global') return s.secret.timeAnchor;
  if (mode === 'perSeat') return s.secret.timeAnchors[seat] ?? null;
  return null;
}

/** TURN_MENU 的时光机状态（options.timeMachine） */
export function timeMachineStatus(s: GameState, seat: SeatIndex): { usable: boolean; anchorTurn: number | null } {
  const p = s.players.find((x) => x.seat === seat);
  const a = anchorFor(s, seat);
  const usableNow = p?.controller === 'human' && a !== null && (p.items[ITEM.TIME_MACHINE] ?? 0) > 0;
  return { usable: usableNow, anchorTurn: a?.takenAtTurn ?? null };
}

/** 真人在 TURN_MENU 提交 ROLL 时（尚未修改任何东西之前）记下锚点 */
export function captureAnchor(ctx: Ctx, seat: SeatIndex): void {
  const s = ctx.s;
  const mode = s.config.rules.timeMachine;
  if (mode === 'disabled') return;
  const p = ctx.player(seat);
  if (p.controller !== 'human') return;
  const world: AnchorWorld = {
    ...cloneJson(publicWorld(s)),
    flow: cloneJson(s.flow),
    decks: {
      newsOrder: s.secret.newsOrder.slice(),
      newsCursor: s.secret.newsCursor,
      fateOrder: s.secret.fateOrder.slice(),
      fateCursor: s.secret.fateCursor,
    },
  };
  const anchor: TimeAnchor = { takenAtTurn: s.clock.turnNo, seat, world };
  if (mode === 'global') s.secret.timeAnchor = anchor;
  else {
    while (s.secret.timeAnchors.length < 4) s.secret.timeAnchors.push(null);
    s.secret.timeAnchors[seat] = anchor;
  }
}

/**
 * 从锚点恢复的键。不恢复 v / engine / dataRef / config：它们不是游戏世界（读档迁移、服务器设置），锚点里的旧值
 * 写回会让引擎与服务器分叉。players 整体恢复，但 controller / aiTraits 保留当前值（见 rewind）。
 */
const WORLD_KEYS = [
  'status',
  'result',
  'clock',
  'econ',
  'players',
  'villains',
  'lands',
  'facilities',
  'companies',
  'objects',
  'gods',
  'beggars',
  'stocks',
  'pools',
  'lottery',
  'noticeBoard',
] as const satisfies readonly (keyof PublicWorld)[];

function useOneTimeMachine(world: AnchorWorld, seat: SeatIndex): void {
  const p = world.players.find((x) => x.seat === seat);
  if (p) p.items[ITEM.TIME_MACHINE] = Math.max(0, (p.items[ITEM.TIME_MACHINE] ?? 0) - 1);
}

/**
 * 回到锚点世界（见文件头的步骤 1–4）。
 * - 服务器写入的系统状态（SYS_SET_CONTROLLER 的 controller、SYS_SET_AI_TRAITS 的 aiTraits）不回滚：被踢的座位仍由
 *   电脑代打、读档认领的座位仍是真人，引擎与服务器的座位控制方保持一致（engine.md §9.2）。
 * - perSeat：其他座位在恢复点之后（takenAtTurn ≥ 恢复点）记下的锚点属于被撤销的时间线，作废；恢复点之前的锚点保留，
 *   但其中使用者的时光机同样 −1。这样既不能「前跳」回被撤销的时间线，用掉的时光机也不会因别人回滚而回来。
 */
export function rewind(ctx: Ctx, seat: SeatIndex): void {
  const s = ctx.s;
  const anchor = anchorFor(s, seat);
  if (anchor === null) return;
  const w = cloneJson(anchor.world);
  for (const p of w.players) {
    const cur = s.players.find((x) => x.seat === p.seat);
    if (!cur) continue;
    p.controller = cur.controller;
    p.aiTraits = cloneJson(cur.aiTraits);
  }
  useOneTimeMachine(w, seat);
  const next: TimeAnchor = { takenAtTurn: anchor.takenAtTurn, seat: anchor.seat, world: cloneJson(w) };
  if (s.config.rules.timeMachine === 'global') s.secret.timeAnchor = next;
  else {
    const anchors = s.secret.timeAnchors;
    for (let k = 0; k < anchors.length; k++) {
      const a = anchors[k];
      if (k === seat || !a) continue;
      if (a.takenAtTurn >= anchor.takenAtTurn) anchors[k] = null;
      else useOneTimeMachine(a.world, seat);
    }
    anchors[seat] = next;
  }
  ctx.emit('TIME_REWOUND', { bySeat: seat, toTurnNo: anchor.takenAtTurn });
  const target = s as unknown as Record<string, unknown>;
  const src = w as unknown as Record<string, unknown>;
  for (const k of WORLD_KEYS) target[k] = src[k];
  s.flow = w.flow;
  s.secret.newsOrder = w.decks.newsOrder;
  s.secret.newsCursor = w.decks.newsCursor;
  s.secret.fateOrder = w.decks.fateOrder;
  s.secret.fateCursor = w.decks.fateCursor;
  s.pending = [];
  ctx.flushSync('timeRewind');
}

/** 10 时光机：只有真人、在有锚点时可用（TURN_MENU 的 USE_ITEM，目标 none） */
export const timeMachine: ItemEffect = {
  consume: 'pool',
  menu(s, _em, seat) {
    const p = s.players.find((x) => x.seat === seat);
    if (p?.controller !== 'human') return unusable('humanOnly');
    return anchorFor(s, seat) === null ? unusable('noAnchor') : usable({ t: 'none' });
  },
  apply(ctx, seat) {
    rewind(ctx, seat);
  },
};
