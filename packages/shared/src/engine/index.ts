// @rich4/shared/engine 入口：公开类型、契约表、错误、版本、createEngine、postPatch 与 selectors。
// view、ai、net、save、client 只能取用类型、契约表、postPatch 与 selectors；createEngine / engine / internal 属于引擎实现
// （scripts/check-deps.ts）。测试与脚本用的 builders / scenario / randomIntent / debug 在 @rich4/shared/engine-testing。
// 手录全局数据表（卡片、道具、角色、常数、开局表、TABLES / tablesHash）：规范入口是 @rich4/shared/data，
// 这里原样再导出，兼容已经从引擎入口取用的代码。
export * from '../data/tables/index';
export * from './api';
export {
  applyPostPatch,
  type DiffableWorld,
  diffPublic,
  foldPosts,
  type PatchableWorld,
  publicWorld,
} from './core/postPatch';
export * from './decisions/allowed';
export * from './decisions/defaults';
export { targetMatches } from './decisions/targets';
export * from './decisions/timing';
export * from './errors';
export * from './selectors/index';
export * from './types/index';
export * from './version';
