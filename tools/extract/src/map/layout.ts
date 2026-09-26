import { readNameField } from '../bin/big5';
import type { BinReader } from '../bin/reader';
import type { TableName } from './rawTypes';

/** 地图资源头：10 个 u32 = [count, offset] × 5。 */
export const MAP_HEADER_SIZE = 40;

export const TABLE_ORDER: readonly TableName[] = ['nodes', 'lands', 'facilities', 'companies', 'landscapes'];

export const STRIDES: Readonly<Record<TableName, number>> = {
  nodes: 0x28,
  lands: 0x34,
  facilities: 0x38,
  companies: 0x34,
  landscapes: 0x1c,
};

export type FieldType = 'u8' | 'u16' | 'i16' | 'u32' | 'i32' | 'name' | 'u8x4' | 'u16x4' | 'u16x6';

/**
 * 字段类别（§5.5）：rule = 规则相关；presentation = 表现相关（坐标、装饰、朝向、精灵号）；
 * runtime = 运行期字段（模板里应为 0）；unknown = 用途未明。rawDiff 中非 presentation 一律按规则相关处理。
 */
export type FieldClass = 'rule' | 'presentation' | 'runtime' | 'unknown';

export interface FieldSpec {
  name: string;
  off: number;
  size: number;
  type: FieldType;
  cls: FieldClass;
}

const f = (name: string, off: number, size: number, type: FieldType, cls: FieldClass): FieldSpec => ({
  name,
  off,
  size,
  type,
  cls,
});

/** 各表逐字节全覆盖的字段布局（data-pipeline.md §5.3）。 */
export const LAYOUTS: Readonly<Record<TableName, readonly FieldSpec[]>> = {
  nodes: [
    f('x', 0x00, 2, 'i16', 'presentation'),
    f('y', 0x02, 2, 'i16', 'presentation'),
    f('name', 0x04, 20, 'name', 'rule'),
    f('adj', 0x18, 8, 'u16x4', 'rule'),
    f('type', 0x20, 2, 'u16', 'rule'),
    f('decor', 0x22, 2, 'u16', 'presentation'),
    f('flags', 0x24, 4, 'u32', 'rule'),
  ],
  lands: [
    f('x', 0x00, 2, 'i16', 'presentation'),
    f('y', 0x02, 2, 'i16', 'presentation'),
    f('name', 0x04, 19, 'name', 'rule'),
    f('b17', 0x17, 1, 'u8', 'runtime'),
    f('b18', 0x18, 1, 'u8', 'runtime'),
    f('b19', 0x19, 1, 'u8', 'runtime'),
    f('b1a', 0x1a, 1, 'u8', 'runtime'),
    f('facing', 0x1b, 1, 'u8', 'presentation'),
    f('landPrice', 0x1c, 2, 'u16', 'rule'),
    f('housePrice', 0x1e, 2, 'u16', 'rule'),
    f('rent', 0x20, 12, 'u16x6', 'rule'),
    f('u2c', 0x2c, 4, 'u32', 'runtime'),
    f('u30', 0x30, 4, 'u32', 'runtime'),
  ],
  facilities: [
    f('x', 0x00, 2, 'i16', 'presentation'),
    f('y', 0x02, 2, 'i16', 'presentation'),
    f('name', 0x04, 20, 'name', 'rule'),
    f('b18', 0x18, 1, 'u8', 'runtime'),
    f('b19', 0x19, 1, 'u8', 'runtime'),
    f('b1a', 0x1a, 1, 'u8', 'runtime'),
    f('facing', 0x1b, 1, 'u8', 'presentation'),
    f('b1c', 0x1c, 1, 'u8', 'runtime'),
    f('b1d', 0x1d, 1, 'u8', 'runtime'),
    f('b1e', 0x1e, 1, 'u8', 'runtime'),
    f('b1f', 0x1f, 1, 'u8', 'unknown'),
    f('u20', 0x20, 2, 'u16', 'unknown'),
    f('landPrice', 0x22, 2, 'u16', 'rule'),
    f('rateWindow', 0x24, 12, 'u16x6', 'rule'),
    f('u30', 0x30, 4, 'u32', 'runtime'),
    f('u34', 0x34, 4, 'u32', 'runtime'),
  ],
  companies: [
    f('x', 0x00, 2, 'i16', 'presentation'),
    f('y', 0x02, 2, 'i16', 'presentation'),
    f('name', 0x04, 20, 'name', 'rule'),
    f('owner', 0x18, 1, 'u8', 'runtime'),
    f('stockIndex', 0x19, 1, 'u8', 'rule'),
    f('industry', 0x1a, 1, 'u8', 'rule'),
    f('facing', 0x1b, 1, 'u8', 'presentation'),
    f('ranking', 0x1c, 4, 'u8x4', 'runtime'),
    f('spriteRes', 0x20, 2, 'u16', 'presentation'),
    f('tollBase', 0x22, 2, 'u16', 'rule'),
    f('assetValue', 0x24, 4, 'u32', 'rule'),
    f('funds', 0x28, 4, 'i32', 'runtime'),
    f('profit', 0x2c, 4, 'i32', 'runtime'),
    f('shares', 0x30, 4, 'u32', 'runtime'),
  ],
  landscapes: [
    f('x', 0x00, 2, 'i16', 'presentation'),
    f('y', 0x02, 2, 'i16', 'presentation'),
    f('name', 0x04, 20, 'name', 'rule'),
    f('facing', 0x18, 1, 'u8', 'presentation'),
    f('b19', 0x19, 1, 'u8', 'unknown'),
    f('spriteRes', 0x1a, 2, 'u16', 'presentation'),
  ],
};

export type FieldValue = number | number[] | string | null;

/** 按布局读取一个字段的值（名称字段返回严格解码文本，失败为 null）。 */
export function readFieldValue(r: BinReader, base: number, spec: FieldSpec): FieldValue {
  const o = base + spec.off;
  switch (spec.type) {
    case 'u8':
      return r.u8(o);
    case 'u16':
      return r.u16(o);
    case 'i16':
      return r.i16(o);
    case 'u32':
      return r.u32(o);
    case 'i32':
      return r.i32(o);
    case 'u8x4':
      return r.u8Array(o, 4);
    case 'u16x4':
      return r.u16Array(o, 4);
    case 'u16x6':
      return r.u16Array(o, 6);
    case 'name':
      return readNameField(r.slice(o, spec.size)).name.text;
  }
}

export function fieldAt(table: TableName, recordOffset: number): FieldSpec | null {
  return LAYOUTS[table].find((s) => recordOffset >= s.off && recordOffset < s.off + s.size) ?? null;
}

export function hex2(n: number): string {
  return `0x${n.toString(16).padStart(2, '0')}`;
}
