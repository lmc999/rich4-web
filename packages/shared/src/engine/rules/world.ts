/**
 * 规则计算器共用的「世界」结构类型：GameState、PublicWorld 与客户端 GameView 都满足它，
 * 所以 rules/* 与 selectors 可以在服务器、客户端预览、AI 三处复用（design/engine.md §2 rules/：纯计算、不压帧、不发事件）。
 */
import type { OverflowMode } from '../../util/int32';
import type { SeatIndex } from '../types/ids';
import type { PlayerState, PublicWorld } from '../types/state';

/** 规则只读玩家的公开字段（不含手牌与背包，私密模式下 GameView 的 cards / items 为 null） */
export type RulePlayer = Omit<PlayerState, 'cards' | 'items'>;

export interface RuleWorld {
  config: PublicWorld['config'];
  econ: PublicWorld['econ'];
  clock: PublicWorld['clock'];
  players: readonly RulePlayer[];
  lands: readonly PublicWorld['lands'][number][];
  facilities: readonly PublicWorld['facilities'][number][];
  companies: readonly PublicWorld['companies'][number][];
  stocks: readonly PublicWorld['stocks'][number][];
}

export function modeOf(w: Pick<RuleWorld, 'config'>): OverflowMode {
  return w.config.rules.intOverflow;
}

export function findPlayer<P extends { seat: SeatIndex }>(players: readonly P[], seat: SeatIndex): P | null {
  for (const p of players) if (p.seat === seat) return p;
  return null;
}

export function playerOf<P extends { seat: SeatIndex }>(players: readonly P[], seat: SeatIndex): P {
  const p = findPlayer(players, seat);
  if (!p) throw new RangeError(`no player at seat ${seat}`);
  return p;
}
