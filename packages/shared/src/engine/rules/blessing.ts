/**
 * 神明加持判定（design/engine.md §10.7；docs/research/g_arbitration.md §2.b；r_deities.md §6；exe 0x44b896）。
 * 只作用于命运（rules.blessingOnNews=true 时新闻也用）：
 *   奖金、罚金读财运（luck.wealth），劫难（坐牢、住院、出国等）读福运（luck.fortune）。
 *   值 > 100 必定 high；50 < 值 ≤ 100 时 rand15()&1（1 为 high，消耗随机数 purpose 'bless'）；0..50 无效果；< 0 为 low。
 * 结果：奖金 high ×2 / low 作废；罚金 high 免付 / low ×2；劫难 high 逃过此劫 / low 天数 ×2。
 */
import { CMB } from '../../data/tables/combat';
import type { BlessingCategory, BlessingResult } from '../types/events';
import type { PlayerState } from '../types/state';

/** 按运势值判定；bit 只在 50 < value ≤ 100 时调用（接 rand15()&1） */
export function evalBlessing(value: number, bit: () => number): BlessingResult {
  if (value > CMB.BLESS_HIGH) return 'high';
  if (value > CMB.BLESS_MID) return bit() === 1 ? 'high' : 'none';
  if (value >= 0) return 'none';
  return 'low';
}

/** 类别对应的运势值：奖金、罚金看财运，劫难看福运 */
export function luckFor(p: Pick<PlayerState, 'luck'>, category: BlessingCategory): number {
  return category === 'misfortune' ? p.luck.fortune : p.luck.wealth;
}
