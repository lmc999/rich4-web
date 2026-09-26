import { hexVa, type PeFile, patternFromBytes } from '../../pe/scan';
import type { Check } from '../types';
import { chk, hintOf, type TableSpec } from './common';

/**
 * 设施等级上限表（v3.11 VA 0x474940）：u8 × 5，下标为设施编码 0 公园、1 旅馆、2 购物中心、3 加油站、4 研究所。
 * v3.11 的引用：0x40b201、0x40b4de、0x41a2c2、0x421c77（`cmp r8, byte [reg + 0x474940]`）。
 * 没有文本签名：v2.06 用 xrefTransfer 迁移；参考版本缺失时退回「数值序列在数据节唯一」。
 */

export const FACILITY_COUNT = 5;

export function parseFacilityLevels(file: PeFile, va: number): number[] {
  return Array.from(file.slice(va, FACILITY_COUNT));
}

export function validateFacilityLevels(file: PeFile, va: number): Check[] {
  if (file.kindOfVa(va) !== 'data' || file.tryVaToOff(va + FACILITY_COUNT - 1) === null) {
    return [chk('facilityLevels.mapped', 'error', false, `${hexVa(va)} 不在数据节`)];
  }
  const v = parseFacilityLevels(file, va);
  const refs = file.findU32InRange(va, va + 1, 'code').length;
  return [
    chk(
      'facilityLevels.range',
      'error',
      v.every((x) => x >= 1 && x <= 9),
      `上限 [${v.join(',')}]（每项 1..9）`,
    ),
    chk('facilityLevels.refs', 'error', refs >= 1, `代码中直接引用 ${refs} 处`),
  ];
}

export const facilityLevelsSpec: TableSpec<number[]> = {
  id: 'facilityLevels',
  xrefSpan: 1,
  hint: (ctx) => hintOf(ctx, ctx.anchors.tables.facilityLevels.hint),
  signature: (ctx) => {
    const exp = ctx.anchors.tables.facilityLevels.expect;
    const hits = ctx.file
      .findPattern(patternFromBytes(Uint8Array.from(exp)), 'data')
      .filter((va) => ctx.file.findU32InRange(va, va + 1, 'code').length > 0);
    if (hits.length !== 1) {
      return { va: null, detail: `被代码引用的字节序列 [${exp.join(',')}] 有 ${hits.length} 处` };
    }
    return { va: hits[0]!, detail: `被代码引用的字节序列 [${exp.join(',')}] 唯一` };
  },
  validate: (file, va) => validateFacilityLevels(file, va),
  parse: (file, va) => parseFacilityLevels(file, va),
  byteLength: () => FACILITY_COUNT,
};
