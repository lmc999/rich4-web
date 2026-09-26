/**
 * validateState（design/engine.md §15）：先做 zod 结构校验，再逐项检查不变量。
 * explainState 返回全部问题（开发 / 测试用）；validateState 只回答是否合法。
 */
import type { DataRegistry } from '../../data/maps/registry';
import { engineMap } from '../core/mapCache';
import type { GameState } from '../types/state';
import { checkInvariants } from './invariants';
import { GameStateSchema } from './schema';

export function explainState(reg: DataRegistry, x: unknown): string[] {
  const parsed = GameStateSchema.safeParse(x);
  if (!parsed.success) {
    return parsed.error.issues.slice(0, 20).map((i) => `schema ${i.path.join('.')}: ${i.message}`);
  }
  const s = x as GameState;
  let em: ReturnType<typeof engineMap>;
  try {
    // 与 applyAction 同一口径：mapHash 必须与注册表一致（不符即 DataError MAP_UNAVAILABLE「hash mismatch」）
    em = engineMap(reg.getMap(s.dataRef.mapId, s.dataRef.mapHash));
  } catch (e) {
    return [`map ${s.dataRef.mapId} unavailable: ${String(e)}`];
  }
  return checkInvariants(s, em);
}

export function validateStateWith(reg: DataRegistry, x: unknown): x is GameState {
  return explainState(reg, x).length === 0;
}

export { checkInvariants } from './invariants';
export { GameConfigSchema, GameStateSchema, PlayerSetupSchema, RuleConfigSchema } from './schema';
