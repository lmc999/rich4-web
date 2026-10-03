// handler 侧的弹窗与文案工具：打开 / 关闭演出弹窗（ui/popups/popupStore）、玩家引用、金额变化、
// 新闻与命运文案的插值参数见 ../eventText。
import type { GameEvent, PostPatch, SeatIndex } from '@rich4/shared/engine';
import {
  type AffectedRow,
  onPopupSkip,
  type PlayerRef,
  type PopupSpec,
  type StatDelta,
  usePopupStore,
} from '../../ui/popups/popupStore';
import type { PresentationContext } from '../types';
import { cashDelta } from './common';

/** 显示态里的玩家（弹窗头像与名字）；不在场时 null */
export function playerRef(ctx: PresentationContext, seat: SeatIndex | null): PlayerRef | null {
  if (seat === null) return null;
  const p = ctx.view().players.find((x) => x.seat === seat);
  if (!p) return null;
  return { seat, character: p.character, name: ctx.names.seat(seat) };
}

/** 本事件对某座位的现金 / 存款 / 点券变化（post 与提交前显示态之差） */
export function statDeltas(ctx: PresentationContext, e: { post?: PostPatch }, seat: SeatIndex): StatDelta[] {
  const out: StatDelta[] = [];
  for (const field of ['cash', 'deposit', 'points'] as const) {
    const delta = cashDelta(ctx, e, seat, field);
    if (delta !== 0) out.push({ field, delta });
  }
  return out;
}

/** 受影响玩家的列表（按座位去重，附金额变化） */
export function affectedRows(
  ctx: PresentationContext,
  e: { post?: PostPatch },
  seats: readonly SeatIndex[],
): AffectedRow[] {
  const all = new Set<SeatIndex>(seats);
  for (const p of e.post?.players ?? []) {
    if (statDeltas(ctx, e, p.seat).length > 0) all.add(p.seat);
  }
  const out: AffectedRow[] = [];
  for (const seat of [...all].sort((a, b) => a - b)) {
    const ref = playerRef(ctx, seat);
    if (ref) out.push({ ...ref, deltas: statDeltas(ctx, e, seat) });
  }
  return out;
}

/** 金额文案：+1,200 / -3,000 */
export function signedMoney(ctx: PresentationContext, n: number): string {
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}${ctx.names.money(Math.abs(n))}`;
}

/**
 * 打开弹窗并等待 ms（1x 时钟；中止、跳过时提前结束），结束时关闭。已中止时不打开。
 * minMs：最短展示时间（1x 毫秒，按当前倍速换算），之后用户点击可以跳过。
 * 弹窗寿命按动画时钟计，组件内部动画按真实时间走：打开时把当前倍速一并交给弹窗，组件按真实寿命安排节奏。
 * 返回是否被用户跳过（命运板跳过时停掉语音，原版 fcn.00452c39 → fcn.00452bd6）。
 */
export async function showPopup(
  ctx: PresentationContext,
  spec: PopupSpec,
  ms: number,
  minMs?: number,
): Promise<boolean> {
  if (ctx.signal.aborted) return false;
  const store = usePopupStore.getState();
  const id = store.open(spec, ms, minMs ?? Math.min(ms, 1200), ctx.animSpeed?.() ?? 1);
  let skip: () => void = () => {};
  let wasSkipped = false;
  const skipped = new Promise<void>((resolve) => {
    skip = resolve;
  });
  const off = onPopupSkip(id, () => {
    wasSkipped = true;
    skip();
  });
  try {
    await Promise.race([ctx.wait(ms), skipped]);
  } finally {
    off();
    usePopupStore.getState().close(id);
  }
  return wasSkipped;
}

/** 事件的 post（handler 的泛型参数统一取用） */
export function postOf(e: GameEvent | { post?: PostPatch }): PostPatch | undefined {
  return e.post;
}
