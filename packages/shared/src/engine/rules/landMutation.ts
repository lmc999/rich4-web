/**
 * 地产等级变化（design/engine.md §2 rules/landMutation.ts；docs/research/r_property.md §8）。
 * mode 0 拆一级（连锁店直接变 0 级住宅；设施降到 0 级清成公园）、mode 1 清为无主（等级归 0）、mode 2 夷平保留地主。
 * 纯状态变换：不发事件，调用方负责先改再 emit。
 */
import type { LotLevel } from '../types/ids';
import type { FacilityState, LandState } from '../types/state';
import { MAX_LEVEL } from './purchase';

export type MutateMode = 0 | 1 | 2;

export interface LevelChange {
  from: LotLevel;
  to: LotLevel;
}

/** 住宅升 n 级（连锁店上限 1，普通住宅上限 5） */
export function levelUpLand(l: LandState, n: number): LevelChange {
  const from = l.level;
  const cap = l.chain ? 1 : MAX_LEVEL;
  const to = Math.min(cap, from + n) as LotLevel;
  l.level = to < from ? from : to;
  return { from, to: l.level };
}

export function mutateLand(l: LandState, mode: MutateMode): LevelChange {
  const from = l.level;
  if (mode === 0) {
    if (l.chain) {
      l.chain = false;
      l.level = 0;
    } else if (l.level > 0) l.level = (l.level - 1) as LotLevel;
  } else {
    l.level = 0;
    l.chain = false;
    if (mode === 1) {
      l.owner = null;
      l.tenure = 0;
    }
  }
  return { from, to: l.level };
}

/** 设施等级上限：公园 1、旅馆 5、购物中心 5、加油站 1、研究所 5（docs/research/r_rules_map.md §11.3） */
export const FACILITY_LEVEL_CAP = Object.freeze({ park: 1, hotel: 5, mall: 5, gas: 1, lab: 5 } as const);

export function mutateFacility(f: FacilityState, mode: MutateMode): LevelChange {
  const from = f.level;
  if (mode === 0) {
    if (f.level > 0) f.level = (f.level - 1) as LotLevel;
  } else {
    f.level = 0;
    if (mode === 1) {
      f.owner = null;
      f.tenure = 0;
    }
  }
  if (f.level === 0) {
    f.type = 'park';
    f.research = null;
  }
  return { from, to: f.level };
}
