import { describe, expect, it } from 'vitest';
import { patchAnchorsText } from '../../src/commands/constants';
import { CodeIndex } from '../../src/exe/code';
import {
  type ConstantAnchors,
  chainSourceChecks,
  constantsFailed,
  evalDerived,
  loadConstantAnchors,
  parseConstantAnchors,
  resolveConstants,
} from '../../src/exe/constants';
import { hexVa, PeFile } from '../../src/pe/scan';
import { buildVariant } from '../helpers/buildCodePair';

const ref = buildVariant('ref');
const dst = buildVariant('dst');
const rc = CodeIndex.build(new PeFile(ref.bytes, 'ref'));
const dc = CodeIndex.build(new PeFile(dst.bytes, 'dst'));
const h = (k: string) => hexVa(ref.va[k]!);

function anchors(extra: Partial<Record<string, unknown>> = {}): ConstantAnchors {
  return parseConstantAnchors({
    schema: 'rich4.anchors-constants/1',
    note: '合成',
    reference: 'v311',
    constants: [
      {
        id: 'h.zero.days',
        value: 3,
        desc: 'H0 天数',
        loc: { kind: 'imm' },
        v311: h('H0_days'),
        v206: null,
        confirmed: true,
        verify: 'T',
        source: 's',
      },
      {
        id: 'h.one.days',
        value: 5,
        v206Value: 7,
        desc: 'H1 天数（两版不同）',
        loc: { kind: 'imm' },
        v311: h('H1_days'),
        v206: null,
        confirmed: false,
        verify: 'T',
        source: 's',
      },
      {
        id: 'h.two.amount',
        value: 10000,
        desc: '乘法链',
        loc: { kind: 'mulChain', length: 9, reg: 'eax', source: 'PI' },
        v311: h('H2'),
        v206: null,
        confirmed: true,
        verify: 'T',
        source: 's',
      },
      {
        id: 'h.three.rate',
        value: 0.9,
        desc: 'f64',
        loc: { kind: 'f64' },
        v311: h('H3_fmul'),
        v206: null,
        confirmed: true,
        verify: 'T',
        source: 's',
      },
      {
        id: 'h.four.table',
        value: [30, 30, 300, 300],
        desc: '数据表',
        loc: { kind: 'data', type: 'u32', count: 4, ref: h('H4_ref') },
        v311: h('TABLE'),
        v206: null,
        confirmed: true,
        verify: 'T',
        source: 's',
      },
      {
        id: 'h.four.sum',
        value: 660,
        desc: '派生',
        loc: { kind: 'derived', op: 'sum', args: ['h.four.table'] },
        v311: null,
        v206: null,
        confirmed: true,
        verify: 'T',
        source: 's',
      },
      ...((extra.constants as unknown[]) ?? []),
    ],
  });
}

describe('常量锚点：两版解析', () => {
  it('imm / mulChain / f64 / data / derived 在两版都读到期望值；v2.06 位置由迁移得到', () => {
    const rs = resolveConstants(anchors(), rc, dc);
    expect(constantsFailed(rs, ['v311', 'v206'])).toEqual([]);
    const by = Object.fromEntries(rs.map((r) => [r.id, r]));
    expect(by['h.zero.days']!.v206).toMatchObject({ va: hexVa(dst.va.H0_days!), value: 3, ok: true, anchored: null });
    expect(by['h.one.days']!).toMatchObject({ same: false, v311: { value: 5 }, v206: { value: 7, expected: 7 } });
    expect(by['h.two.amount']!.v206).toMatchObject({ value: 10000, extra: hexVa(dst.va.PI!) });
    expect(by['h.three.rate']!.v206).toMatchObject({ value: 0.9, extra: hexVa(dst.va.RATE!) });
    expect(by['h.four.table']!.v206).toMatchObject({
      va: hexVa(dst.va.TABLE!),
      value: [30, 30, 300, 300],
      refVa: hexVa(dst.va.H4_ref!),
    });
    expect(by['h.four.sum']!.v311.value).toBe(660);
    expect(by['h.four.sum']!.v206?.value).toBe(660);
    expect(chainSourceChecks(anchors(), rs).every((c) => c.ok)).toBe(true);
  });

  it('只有 v2.06（无参考）时退回 anchors 登记的 VA；登记错误则读到错值', () => {
    const a = anchors();
    a.constants[0]!.v206 = hexVa(dst.va.H0_days!);
    a.constants[1]!.v206 = hexVa(dst.va.H0_days!);
    const rs = resolveConstants(a, null, dc);
    expect(rs[0]!.v206).toMatchObject({ ok: true, transferred: null, value: 3 });
    expect(rs[1]!.v206).toMatchObject({ ok: false, value: 3 });
    expect(rs[2]!.v206?.error).toMatch(/无法定位/);
    expect(rs[0]!.v311.error).toMatch(/缺少 v3.11/);
    expect(resolveConstants(a, null, dc, { trustAnchored: false })[0]!.v206?.error).toMatch(/无法定位/);
  });

  it('期望值不符与位置错误都报出', () => {
    const a = anchors();
    a.constants[0]!.value = 4;
    a.constants[3]!.v311 = h('H3');
    const rs = resolveConstants(a, rc, dc);
    expect(rs[0]!.v311).toMatchObject({ ok: false, value: 3 });
    expect(rs[3]!.v311.ok).toBe(true);
    const bad = anchors();
    bad.constants[3]!.v311 = hexVa(ref.va.H3_fmul! + 1);
    expect(resolveConstants(bad, rc, null)[3]!.v311.error).toMatch(/指令起点/);
  });

  it('派生运算与 schema 约束', () => {
    const get = (id: string) => ({ a: [3, 12, 3, 9, 1], b: 5, m: 10, t: 7, s: 40, e: 640, st: 80 })[id] ?? null;
    expect(evalDerived('sum', ['a'], get)).toBe(28);
    expect(evalDerived('dot', ['a', [0, 'b', 12, 8, 20]], get)).toBe(188);
    expect(evalDerived('rangeCount', ['s', 'e', 'st'], get)).toBe(8);
    expect(evalDerived('pctGe', ['m', 't'], get)).toBe(30);
    expect(evalDerived('dot', ['a', [1, 2]], get)).toBeNull();
    expect(evalDerived('sum', ['missing'], get)).toBeNull();
    expect(() => anchors({ constants: [{ ...anchors().constants[0]! }] })).toThrow(/重复的 id/);
    const derivedWithVa = { ...anchors().constants[5]!, id: 'x.y', v311: '0x1' };
    expect(() => anchors({ constants: [derivedWithVa] })).toThrow(/derived/);
    expect(() => parseConstantAnchors({ schema: 'x' })).toThrow(/结构不符/);
  });

  it('patchAnchorsText 只改能迁移且值正确的项，无改动时返回 null', () => {
    const a = anchors();
    const rs = resolveConstants(a, rc, dc);
    const text = `${JSON.stringify(a, null, 2)}\n`;
    const refSites = new Map([['h.four.table', hexVa(dst.va.H4_ref!)]]);
    const p = patchAnchorsText(text, rs, refSites)!;
    expect(p.changed).toEqual(['h.zero.days', 'h.one.days', 'h.two.amount', 'h.three.rate', 'h.four.table']);
    const j = JSON.parse(p.text) as ConstantAnchors;
    expect(j.constants[0]!.v206).toBe(hexVa(dst.va.H0_days!));
    expect((j.constants[4]!.loc as { ref206?: string }).ref206).toBe(hexVa(dst.va.H4_ref!));
    expect(patchAnchorsText(p.text, rs, refSites)).toBeNull();
  });

  it('入库的 anchors/constants.json 合法：id 唯一、除 derived 外都有 v3.11 VA', () => {
    const real = loadConstantAnchors();
    expect(real.constants.length).toBeGreaterThanOrEqual(150);
    expect(real.constants.filter((c) => c.loc.kind !== 'derived').every((c) => c.v311 !== null)).toBe(true);
  });
});
