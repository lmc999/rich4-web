/**
 * 17 类落点的分派（design/engine.md §8；docs/research/r_rules_map.md §11.4；落点码见 data/maps/kinds.ts）。
 * 只在停下时触发。梦游中：特殊格（落点码 1..16）全部跳过，地产只结算过路费（不能买、不能盖）。
 *
 * M1 实现：地产（住宅的买、盖、过路费）、公园、点券格 10/11/12、卡片格 13。
 * M4 实现：设施与企业格（property 分派）、乐透 9、银行 14、百货公司 15。
 * M6 实现：监狱 / 医院保释格 4 / 5（squares/jail.ts）。
 * M8 实现：小游戏 6 / 7 / 8（squares/minigame.ts）。
 * 其余先做空处理，按里程碑补上（见各 TODO）。
 */
import type { TileDef, TileKind } from '../../data/maps/types';
import type { Ctx } from '../core/ctx';
import type { FrameOf } from '../types/frames';
import type { SeatIndex } from '../types/ids';
import { bankSquare } from './bank';
import { cardSquare } from './cardSquare';
import { jailSquare } from './jail';
import { lotterySquare } from './lottery';
import { minigameSquare } from './minigame';
import { parkSquare } from './park';
import { pointsSquare } from './points';
import { propertySquare } from './property';
import { shopSquare } from './shop';

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
  // 监狱 / 医院的保释格：BAIL 决策（保释 30 点券；雇恶人 300 点券属于 M7）
  jail: jailSquare,
  hospital: jailSquare,
  // 小游戏：真人座位 MINIGAME 决策；电脑座位或 minigames='skip' 直接 50+rand15()%20 点券
  penguin: minigameSquare,
  balloon: minigameSquare,
  xicong: minigameSquare,
  lottery: lotterySquare,
  points50: pointsSquare,
  points30: pointsSquare,
  points10: pointsSquare,
  card: cardSquare,
  bank: bankSquare,
  shop: shopSquare,
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
