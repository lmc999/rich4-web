/**
 * 17 类落点的分派（design/engine.md §8；docs/research/r_rules_map.md §11.4；落点码见 data/maps/kinds.ts）。
 * 只在停下时触发。梦游中：特殊格（落点码 1..16）全部跳过，地产只结算过路费（不能买、不能盖）。
 *
 * M1 实现：地产（住宅的买、盖、过路费）、公园、点券格 10/11/12、卡片格 13。
 * 其余先做空处理，按里程碑补上（见各 TODO）。
 */
import type { TileDef, TileKind } from '../../data/maps/types';
import type { Ctx } from '../core/ctx';
import type { FrameOf } from '../types/frames';
import type { SeatIndex } from '../types/ids';
import { cardSquare } from './cardSquare';
import { parkSquare } from './park';
import { pointsSquare } from './points';
import { propertySquare } from './property';

export interface SquareContext {
  seat: SeatIndex;
  tile: TileDef;
  sleepwalk: boolean;
  frame: FrameOf<'LAND'>;
}

export type SquareHandler = (ctx: Ctx, sq: SquareContext) => void;

const noop: SquareHandler = () => {};

export const SQUARE_HANDLERS = Object.freeze({
  property: propertySquare,
  plain: noop,
  park: parkSquare,
  // TODO(M7)：新闻 / 命运（游标取下一张，不可行就跳过）
  news: noop,
  fate: noop,
  // TODO(M6)：监狱 / 医院格的 BAIL 决策（保释 30 点券、雇恶人 300 点券）
  jail: noop,
  hospital: noop,
  // TODO(M8)：小游戏（真人座位 MINIGAME 决策；电脑座位或 minigames='skip' 直接 50+rand15()%20 点券）
  penguin: noop,
  balloon: noop,
  xicong: noop,
  // TODO(M4)：乐透（现金 ≥1000 且有未售号码 → LOTTERY 决策）
  lottery: noop,
  points50: pointsSquare,
  points30: pointsSquare,
  points10: pointsSquare,
  card: cardSquare,
  // TODO(M4)：银行（BANK(stop)：先 ATM 再柜台）、百货公司（SHOP）
  bank: noop,
  shop: noop,
  // TODO(M7)：魔法屋（抽条件 → MAGIC_CAST）
  magic: noop,
} satisfies { readonly [K in TileKind]: SquareHandler });

export function settleSquare(ctx: Ctx, f: FrameOf<'LAND'>): void {
  if (f.actor.t !== 'seat') return;
  const seat = f.actor.seat;
  const p = ctx.player(seat);
  if (!p.alive) return;
  const tile = ctx.map.index.tile(f.node);
  const sleepwalk = p.st.sleepwalk !== 0;
  if (sleepwalk && tile.kind !== 'property') return;
  SQUARE_HANDLERS[tile.kind](ctx, { seat, tile, sleepwalk, frame: f });
}
