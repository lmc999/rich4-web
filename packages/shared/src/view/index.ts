// @rich4/shared/view 入口：投影类型、按观察者投影（project）、动画预算（pacing），
// 以及客户端 viewReducer 用的 applyPostPatch / foldPosts（实现在 engine/core/postPatch，check-deps 放行）。
export {
  applyPostPatch,
  type DiffableWorld,
  diffPublic,
  foldPosts,
  type PatchableWorld,
  publicWorld,
} from '../engine/core/postPatch';
export * from './handLeaks';
export * from './pacing';
export * from './project';
export * from './types';
