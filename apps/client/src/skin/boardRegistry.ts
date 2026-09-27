// 棋盘工厂注册表（轻量，不引入 Pixi）：程序化棋盘由 skin/boards.ts 内置；A6 的原版棋盘在加载后调用
// registerBoardFactory('original', …) 注册。skinStore 据 hasBoardFactory('original') 判定「原版渲染器是否可用」。
import type { BoardFactory } from './BoardSurface';
import type { SkinKind } from './types';

const factories = new Map<SkinKind, BoardFactory>();
const listeners = new Set<() => void>();

export function registerBoardFactory(kind: SkinKind, factory: BoardFactory | null): void {
  if (factory) factories.set(kind, factory);
  else factories.delete(kind);
  for (const fn of [...listeners]) fn();
}

export function boardFactory(kind: SkinKind): BoardFactory | null {
  return factories.get(kind) ?? null;
}

export function hasBoardFactory(kind: SkinKind): boolean {
  return factories.has(kind);
}

/** 注册表变化（skinStore 重新判定） */
export function onBoardFactoriesChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
