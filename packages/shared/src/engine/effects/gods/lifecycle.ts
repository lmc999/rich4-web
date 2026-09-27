/**
 * 神明的出现、附身、离场与搭档重生（design/engine.md §10.5；docs/research/r_deities.md §1–§4、§8）。
 *
 * - 离场（期满、被挤走、送神、娃娃扫走、被炸、恶犬咬人或被撞飞、附身者破产）：槽位清为 absent，附身者减回三项运势 → GOD_LEFT；
 *   随后搭档在随机格刷出 → GOD_SPAWNED（死神没有搭档）。
 * - 刷出位置（respawnTile）：可放置（非禁放位、非关押格）、无物件、无路上神明、无人（棋盘上的玩家与恶人、乞丐）的格，
 *   且与参照点 |dx| ≥ 300 或 |dy| ≥ 300；每次在全部空格里 rand15()%n 抽一格，64 次都不满足就不看距离再抽一次（DEV-08）。
 *   参照点是离场那一刻附身者所在的格（受困时即关押格 / 旅馆格），路上的神是它自己的格。
 * - 附身（attachGod）：槽位记为 attached，玩家 god = {kind, days}，三项运势加上去 → GOD_ATTACHED。
 * 每对搭档同一时刻最多一个在场（不变量 7）。
 */
import type { World } from '../../../data/maps/types';
import { CMB } from '../../../data/tables/combat';
import { ECON } from '../../../data/tables/economy';
import { GODS } from '../../../data/tables/gods';
import type { GodKind } from '../../../data/tables/ids';
import type { Ctx } from '../../core/ctx';
import type { EngineMap } from '../../core/mapCache';
import { emptyRoadTiles, tileWorld } from '../../decisions/targets';
import type { GodLeaveReason } from '../../types/events';
import type { RandPurpose, SeatIndex, TileId } from '../../types/ids';
import type { GameState, GodSlot, PlayerState } from '../../types/state';

/** 与参照点在 X 或 Y 方向上相距 ≥ RESPAWN_DIST */
export function farEnough(ref: World, p: World): boolean {
  const dx = p.x - ref.x;
  const dy = p.y - ref.y;
  const d = ECON.RESPAWN_DIST;
  return dx >= d || dx <= -d || dy >= d || dy <= -d;
}

/**
 * 在空道路格里随机抽一格：最多 RESPAWN_TRIES 次要求远离参照点，之后放宽（DEV-08）。没有空格返回 null。
 * pick 接引擎 RNG（purpose 'respawn' 或 'beggar'）。
 */
export function farRandomTile(
  s: GameState,
  em: EngineMap,
  ref: World,
  pick: (n: number) => number,
  exclude: readonly TileId[] = [],
): TileId | null {
  const free = emptyRoadTiles(s, em).filter((t) => !exclude.includes(t));
  if (free.length === 0) return null;
  for (let i = 0; i < CMB.RESPAWN_TRIES; i++) {
    const t = free[pick(free.length)]!;
    if (farEnough(ref, tileWorld(em, t))) return t;
  }
  return free[pick(free.length)]!;
}

export function slotIndexOf(s: GameState, slot: number): number {
  return s.gods.findIndex((g) => g.slot === slot);
}

/** 某种神的槽位（死神有两个槽，取第一个） */
export function slotOfKind(s: GameState, kind: GodKind): GodSlot | null {
  return s.gods.find((g) => g.kind === kind) ?? null;
}

/** 玩家身上神明的槽位 */
export function attachedSlot(s: GameState, seat: SeatIndex): GodSlot | null {
  return s.gods.find((g) => g.where.t === 'attached' && g.where.seat === seat) ?? null;
}

/** 路上 tile 处的神（未附身） */
export function roadGodAt(s: GameState, tile: TileId): GodSlot | null {
  return s.gods.find((g) => g.where.t === 'road' && g.where.node === tile) ?? null;
}

function addLuck(p: PlayerState, kind: GodKind, sign: 1 | -1): void {
  const l = GODS[kind].luck;
  p.luck = {
    bad: p.luck.bad + sign * l.bad,
    wealth: p.luck.wealth + sign * l.wealth,
    fortune: p.luck.fortune + sign * l.fortune,
  };
}

/** 在随机格刷出某个槽位的神（远离 ref）→ GOD_SPAWNED；没有空格时保持不在场 */
export function spawnGod(ctx: Ctx, slot: GodSlot, ref: World, purpose: RandPurpose = 'respawn'): void {
  const tile = farRandomTile(ctx.s, ctx.map, ref, (n) => ctx.pick(purpose, n));
  if (tile === null) return;
  slot.where = { t: 'road', node: tile };
  ctx.emit('GOD_SPAWNED', { kind: slot.kind, node: tile });
}

/** 离场的神在 ref 处离开：搭档刷出（远离 ref） */
function spawnPartner(ctx: Ctx, kind: GodKind, ref: World): void {
  const partner = GODS[kind].partner;
  if (partner === null) return;
  const slot = slotOfKind(ctx.s, partner);
  if (slot === null || slot.where.t !== 'absent') return;
  spawnGod(ctx, slot, ref);
}

/** 离场参照点：附身者所在格（受困时即关押格）；路上的神取它自己的格 */
function refOf(ctx: Ctx, slot: GodSlot): World {
  const w = slot.where;
  if (w.t === 'road') return tileWorld(ctx.map, w.node);
  if (w.t === 'attached') {
    const p = ctx.s.players.find((x) => x.seat === w.seat);
    if (p?.placed && ctx.map.hasTile(p.node)) return tileWorld(ctx.map, p.node);
  }
  return { x: 0, y: 0 };
}

/**
 * 神离场 → GOD_LEFT，随后搭档刷出 → GOD_SPAWNED。附身的神同时清掉玩家的 god 并减回运势。
 * 不在场的槽位直接返回。
 */
export function leaveGod(ctx: Ctx, slot: GodSlot, reason: GodLeaveReason): void {
  const w = slot.where;
  if (w.t === 'absent') return;
  const ref = refOf(ctx, slot);
  let seat: SeatIndex | null = null;
  if (w.t === 'attached') {
    seat = w.seat;
    const p = ctx.s.players.find((x) => x.seat === w.seat);
    if (p && p.god?.kind === slot.kind) {
      p.god = null;
      addLuck(p, slot.kind, -1);
    }
  }
  slot.where = { t: 'absent' };
  ctx.emit('GOD_LEFT', { seat, kind: slot.kind, reason });
  spawnPartner(ctx, slot.kind, ref);
}

/** 附身（槽位必须不在别人身上；调用方先挤走旧神）→ GOD_ATTACHED */
export function attachGod(ctx: Ctx, seat: SeatIndex, slot: GodSlot, displaced: GodKind | null): void {
  const p = ctx.player(seat);
  const def = GODS[slot.kind];
  slot.where = { t: 'attached', seat };
  p.god = { kind: slot.kind, days: def.days };
  addLuck(p, slot.kind, 1);
  ctx.emit('GOD_ATTACHED', { seat, kind: slot.kind, displaced });
}
