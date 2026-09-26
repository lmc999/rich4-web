import { canonicalJson } from '../../util/canonicalJson';
import { sha256Hex } from '../../util/sha256';
import type { MapDef } from './types';

/** mapHash = 排除 meta.dataHash 后的规范化 JSON（UTF-8）的 sha256 hex */
export function computeMapDataHash(def: MapDef): string {
  const { dataHash: _omit, ...meta } = def.meta;
  return sha256Hex(canonicalJson({ ...def, meta }));
}

export function verifyMapDataHash(def: MapDef): boolean {
  return computeMapDataHash(def) === def.meta.dataHash;
}

/** 返回写好 meta.dataHash 的新对象（浅拷贝） */
export function withDataHash(def: MapDef): MapDef {
  return { ...def, meta: { ...def.meta, dataHash: computeMapDataHash(def) } };
}
