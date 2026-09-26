// handler 共用工具：地块外观、按 post 同步棋盘、最简演出（toast + 等待）
import type {
  ActorRef,
  FacilityType,
  GameEvent,
  GameEventOf,
  GameEventType,
  LotId,
  PostPatch,
  SeatIndex,
} from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { formatEvent } from '../logFormat';
import type { EventHandler, LotLook, PresentationContext } from '../types';

export function actorSeat(a: ActorRef): SeatIndex | null {
  return a.t === 'seat' ? a.seat : null;
}

type FacilityLook = NonNullable<LotLook['facility']>;

export function facilityLook(type: FacilityType, level: number): FacilityLook {
  return level <= 0 ? 'vacant' : type;
}

/** 视图里某块地的外观（地块、设施、企业）；找不到返回 null */
export function lotLook(view: GameView, lot: LotId): LotLook | null {
  const land = view.lands.find((l) => l.id === lot);
  if (land) return { owner: land.owner, level: land.level };
  const fac = view.facilities.find((f) => f.id === lot);
  if (fac) return { owner: fac.owner, level: fac.level, facility: facilityLook(fac.type, fac.level) };
  const co = view.companies.find((c) => c.id === lot);
  if (co) return { owner: view.stocks[co.stock]?.chairman ?? null, level: 1 };
  return null;
}

/** 按事件的 post 立即更新棋盘上受影响的地块与角色位置（批尾还会整体 syncView） */
export function syncFromPost(ctx: PresentationContext, post: PostPatch | undefined): void {
  if (!post) return;
  const view = ctx.view();
  for (const p of post.lands ?? []) {
    const cur = view.lands.find((l) => l.id === p.id);
    if (!cur) continue;
    ctx.board.setLot(p.id, { owner: p.set.owner ?? cur.owner, level: p.set.level ?? cur.level });
  }
  for (const p of post.facilities ?? []) {
    const cur = view.facilities.find((f) => f.id === p.id);
    if (!cur) continue;
    const level = p.set.level ?? cur.level;
    ctx.board.setLot(p.id, {
      owner: p.set.owner === undefined ? cur.owner : p.set.owner,
      level,
      facility: facilityLook(p.set.type ?? cur.type, level),
    });
  }
  for (const p of post.players ?? []) {
    const node = p.set.node;
    const placed = p.set.placed ?? view.players.find((x) => x.seat === p.seat)?.placed ?? false;
    if (node !== undefined && node > 0 && placed) ctx.board.placeActor(p.seat, node);
  }
}

/** 最简演出：日志行做 toast（可选），按 post 同步棋盘，再等 ms */
export function brief<T extends GameEventType>(ms = 500, toast = true): EventHandler<T> {
  return async (e, ctx) => {
    if (toast) {
      const line = formatEvent(e as GameEvent, ctx.names);
      if (line) ctx.ui.toast(line);
    }
    syncFromPost(ctx, (e as GameEvent).post);
    if (ms > 0) await ctx.wait(ms);
  };
}

/** 不演出（系统事件、纯数据刷新）：同步棋盘即可 */
export function silent<T extends GameEventType>(): EventHandler<T> {
  return async (e, ctx) => {
    syncFromPost(ctx, (e as GameEvent).post);
  };
}

/** 本事件后某座位的现金变化（post 与提交前视图之差） */
export function cashDelta(
  ctx: PresentationContext,
  e: { post?: PostPatch },
  seat: SeatIndex,
  field: 'cash' | 'deposit' | 'points' = 'cash',
): number {
  const p = e.post?.players?.find((x) => x.seat === seat)?.set[field];
  if (p === undefined) return 0;
  const before = ctx.view().players.find((x) => x.seat === seat)?.[field] ?? 0;
  return p - before;
}

/** 飘字 + HUD 闪动（金额变化） */
export function showDelta(
  ctx: PresentationContext,
  seat: SeatIndex,
  delta: number,
  field: 'cash' | 'deposit' | 'points' = 'cash',
): void {
  if (delta === 0) return;
  const text =
    field === 'points'
      ? ctx.t('events:show.points', { n: delta })
      : `${delta > 0 ? '+' : '-'}${ctx.names.money(Math.abs(delta))}`;
  ctx.board.floatText({ seat }, text, field === 'points' ? 'points' : delta > 0 ? 'gain' : 'loss');
  ctx.ui.flash(seat, field, delta);
}

export type Ev<T extends GameEventType> = GameEventOf<T>;

/** 事件 post 里每位玩家的现金 / 存款 / 点券变化都飘字 */
export function showAllDeltas(ctx: PresentationContext, e: { post?: PostPatch }): void {
  for (const p of e.post?.players ?? []) {
    for (const f of ['cash', 'deposit', 'points'] as const) showDelta(ctx, p.seat, cashDelta(ctx, e, p.seat, f), f);
  }
}
