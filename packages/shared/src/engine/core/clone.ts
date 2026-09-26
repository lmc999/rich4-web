/**
 * 克隆与冻结（design/engine.md §2 core/clone.ts）。
 * - cloneState：applyAction 的草稿（structuredClone，约 1ms / 100KB）。
 * - cloneJson：小块 JSON 值的手写深拷贝（post 生成时逐字段调用，比 structuredClone 的固定开销小）。
 * - deepFreeze：开发模式下冻结 applyAction 的入参，任何误写都会立即抛 TypeError。
 */
import type { GameState } from '../types/state';

export function cloneState(s: GameState): GameState {
  return structuredClone(s);
}

/** 只接受 JSON 值（对象、数组、字符串、数字、布尔、null） */
export function cloneJson<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const out = new Array<unknown>(v.length);
    for (let i = 0; i < v.length; i++) out[i] = cloneJson(v[i] as unknown);
    return out as T;
  }
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) out[k] = cloneJson(src[k]);
  return out as T;
}

export function deepFreeze<T>(v: T): T {
  if (v === null || typeof v !== 'object' || Object.isFrozen(v)) return v;
  Object.freeze(v);
  if (Array.isArray(v)) {
    for (const x of v) deepFreeze(x as unknown);
  } else {
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return v;
}

/** JSON 值的结构相等（键顺序无关；undefined 属性视为不存在） */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const aa = Array.isArray(a);
  if (aa !== Array.isArray(b)) return false;
  if (aa) {
    const x = a as unknown[];
    const y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!jsonEqual(x[i], y[i])) return false;
    return true;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  let nx = 0;
  for (const k of Object.keys(x)) {
    const v = x[k];
    if (v === undefined) continue;
    nx++;
    if (!jsonEqual(v, y[k])) return false;
  }
  let ny = 0;
  for (const k of Object.keys(y)) if (y[k] !== undefined) ny++;
  return nx === ny;
}
