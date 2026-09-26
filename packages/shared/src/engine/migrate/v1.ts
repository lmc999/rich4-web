/**
 * state 结构 v1（STATE_SCHEMA_VERSION = 1）：M1 的基线，没有更早的版本需要迁移。
 * 以后 state 结构变化时：STATE_SCHEMA_VERSION 加 1，新建 v{n}.ts 导出 migrateV{n-1}ToV{n}，
 * 在 migrate/index.ts 的 MIGRATIONS 登记，并为每一步补一个 fixture 测试（design/engine.md §15）。
 */
export const V1 = 1;

/** v1 → v1：只做深拷贝（调用方随后做结构校验） */
export function identityV1(state: unknown): unknown {
  return structuredClone(state);
}
