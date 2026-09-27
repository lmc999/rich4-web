/**
 * MAGIC_CAST（design/minigames-ai.md §9.7；docs/research/events-from-exe.md §3；exe 0x43381b）：
 * 名单里有自己 → 效果 6（得一张卡）；否则 rng % 11，抽到 6 改为 7（原地向后转）。条件由引擎用 RNG 抽。
 */
import { MAGIC_FLOW } from '../../data/tables/magic';
import type { MagicEffectId, PlayerIntent } from '../../engine/types/index';
import type { DecisionForYou } from '../../view/types';
import type { AiContext } from '../types';

export function magicCast(d: DecisionForYou<'MAGIC_CAST'>, ctx: AiContext): PlayerIntent {
  const o = d.options;
  const self = MAGIC_FLOW.aiSelfEffect.value as MagicEffectId;
  let effect: MagicEffectId;
  if (o.targets.includes(d.seat)) effect = self;
  else {
    const r = ctx.rng.mod(MAGIC_FLOW.aiEffectPick.value);
    effect = (r === self ? self + 1 : r) as MagicEffectId;
  }
  return o.effects.includes(effect) ? { type: 'MAGIC_CAST', effect } : d.defaultIntent;
}
