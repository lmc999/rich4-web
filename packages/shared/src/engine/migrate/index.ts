/**
 * migrateState（design/engine.md §15）：MIGRATIONS[v](state) 把 v 版的 state 迁到 v+1，依次串联到最新版本；
 * 迁移后做结构校验，失败抛 EngineRuleError('BAD_STATE')。版本高于本引擎抛 BAD_STATE_VERSION。
 */
import { EngineRuleError } from '../errors';
import type { GameState } from '../types/state';
import { GameStateSchema } from '../validate/schema';
import { STATE_SCHEMA_VERSION } from '../version';
import { identityV1 } from './v1';

/** 下标 = 源版本：把 v 版迁到 v+1（目前没有旧版本） */
export const MIGRATIONS: Readonly<Record<number, (state: unknown) => unknown>> = Object.freeze({});

export function migrateState(state: unknown, fromVersion: number): GameState {
  if (!Number.isInteger(fromVersion) || fromVersion < 1) {
    throw new EngineRuleError('BAD_STATE_VERSION', `unknown state version ${fromVersion}`);
  }
  if (fromVersion > STATE_SCHEMA_VERSION) {
    throw new EngineRuleError(
      'BAD_STATE_VERSION',
      `state v${fromVersion} is newer than engine v${STATE_SCHEMA_VERSION}`,
    );
  }
  let cur: unknown = identityV1(state);
  for (let v = fromVersion; v < STATE_SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new EngineRuleError('BAD_STATE_VERSION', `no migration from v${v}`);
    cur = step(cur);
  }
  const parsed = GameStateSchema.safeParse(cur);
  if (!parsed.success) throw new EngineRuleError('BAD_STATE', parsed.error.issues[0]?.message ?? 'invalid state');
  const s = cur as GameState;
  if (s.v !== STATE_SCHEMA_VERSION) s.v = STATE_SCHEMA_VERSION;
  return s;
}
