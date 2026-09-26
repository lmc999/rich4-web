/**
 * 自增 id（architecture §4「ID」）：决策 `d${n}`、帧 fid、路面物件、公布栏挂牌都用 state.counters 自增。
 * counters 不下发、时光机回滚也不回退，所以 id 全局单调。
 */
import type { GameState } from '../types/state';

export function nextDecisionId(s: GameState): string {
  s.counters.decision += 1;
  return `d${s.counters.decision}`;
}

export function nextFrameId(s: GameState): number {
  s.counters.frame += 1;
  return s.counters.frame;
}

export function nextObjectId(s: GameState): number {
  s.counters.object += 1;
  return s.counters.object;
}

export function nextListingId(s: GameState): number {
  s.counters.listing += 1;
  return s.counters.listing;
}

/** 'd12' → 12；格式不对返回 null */
export function decisionNumber(id: string): number | null {
  const m = /^d([1-9]\d*)$/.exec(id);
  return m ? Number(m[1]) : null;
}
