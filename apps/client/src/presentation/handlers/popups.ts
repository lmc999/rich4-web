// handler 侧的弹窗与文案工具：打开 / 关闭演出弹窗（ui/popups/popupStore）、玩家引用、金额变化、
// 新闻与命运文案的插值参数（引擎只给 id / key，名字在这里按显示态解析）。
import type { EventParams, GameEvent, LotId, PostPatch, SeatIndex, TileId } from '@rich4/shared/engine';
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
 * 文案插值参数：把引擎给的 id 按键名解析成名字（lot / company → 地块名，stock → 股票名，seat / who → 人名，
 * tile / node → 格名，amount / price / fine / reward → 金额），其余原样；缺失的常用键给中性默认值，
 * 避免模板里残留 {{…}}。
 */
export function textParams(ctx: PresentationContext, params: EventParams | null | undefined): Record<string, unknown> {
  const n = ctx.names;
  const out: Record<string, unknown> = {
    lot: ctx.t('events:param.lot'),
    company: ctx.t('events:param.company'),
    stock: ctx.t('events:param.stock'),
    who: ctx.t('events:param.who'),
    days: ctx.t('events:param.days'),
    amount: ctx.t('events:param.amount'),
    pct: ctx.t('events:param.pct'),
  };
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === null) continue;
    switch (k) {
      case 'lot':
      case 'company':
        out[k] = typeof v === 'string' ? n.lot(v as LotId) : v;
        break;
      case 'stock':
        out[k] = typeof v === 'number' ? n.stock(v) : v;
        break;
      case 'seat':
      case 'who':
        out.who = typeof v === 'number' ? n.seat(v as SeatIndex) : v;
        break;
      case 'tile':
      case 'node':
        out.tile = typeof v === 'number' ? n.tile(v as TileId) : v;
        break;
      case 'amount':
      case 'price':
      case 'fine':
      case 'reward':
      case 'loan':
      case 'gain':
      case 'loss':
        out[k] = typeof v === 'number' ? n.money(v) : v;
        break;
      default:
        out[k] = v;
    }
  }
  return out;
}

/**
 * 打开弹窗并等待 ms（1x 时钟；中止、跳过时提前结束），结束时关闭。已中止时不打开。
 * minMs：最短展示时间（1x 毫秒，按当前倍速换算），之后用户点击可以跳过。
 * 弹窗寿命按动画时钟计，组件内部动画按真实时间走：打开时把当前倍速一并交给弹窗，组件按真实寿命安排节奏。
 */
export async function showPopup(ctx: PresentationContext, spec: PopupSpec, ms: number, minMs?: number): Promise<void> {
  if (ctx.signal.aborted) return;
  const store = usePopupStore.getState();
  const id = store.open(spec, ms, minMs ?? Math.min(ms, 1200), ctx.animSpeed?.() ?? 1);
  let skip: () => void = () => {};
  const skipped = new Promise<void>((resolve) => {
    skip = resolve;
  });
  const off = onPopupSkip(id, () => skip());
  try {
    await Promise.race([ctx.wait(ms), skipped]);
  } finally {
    off();
    usePopupStore.getState().close(id);
  }
}

/** 事件的 post（handler 的泛型参数统一取用） */
export function postOf(e: GameEvent | { post?: PostPatch }): PostPatch | undefined {
  return e.post;
}
