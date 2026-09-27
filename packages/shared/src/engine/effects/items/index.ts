/**
 * 13 种道具的效果注册表（design/engine.md §10.4）：ITEM_EFFECTS 用 satisfies 对 ItemId 穷举。
 * 道具全部在 USE_ITEM 时立即结算；遥控骰子与对自己用传送机是终结 intent（TURN 帧随后掷骰 / 结束回合）。
 */
import type { ItemId } from '../../../data/tables/ids';
import { timeMachine } from '../timeMachine';
import type { ItemEffect } from '../types';
import { mine, roadblock, robotDoll, timeBomb } from './objects';
import { robotWorker, teleporter } from './research';
import { car, engineeringVehicle, motorcycle, remoteDice } from './vehicle';
import { missile, nuke } from './weapons';

export const ITEM_EFFECTS = Object.freeze({
  1: robotDoll,
  2: roadblock,
  3: mine,
  4: timeBomb,
  5: motorcycle,
  6: car,
  7: missile,
  8: remoteDice,
  9: robotWorker,
  10: timeMachine,
  11: teleporter,
  12: engineeringVehicle,
  13: nuke,
} satisfies { readonly [I in ItemId]: ItemEffect });

export function itemEffect(item: ItemId): ItemEffect {
  return ITEM_EFFECTS[item];
}
