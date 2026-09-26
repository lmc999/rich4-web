import { encodeBig5 } from '../../src/bin/big5';
import { Asm } from './asm';
import { codePe, DataBuilder, dataVaFor, TEXT_VA } from './codePe';

/**
 * 测试专用：同一段「程序」的两个版本（ref ≈ v3.11，dst ≈ v2.06），用来测指令迁移、常量锚点与函数级对比。
 * 两版的差别：数据地址整体平移、串的位置不同、H0/H1 的栈帧大小不同（位移编码长度随之改变）、
 * 资源号 push 差 0x29（表现层）、H1 的天数常量不同（5 vs 7）、H3 在 dst 多一条指令（结构差异）。
 * 全部内容为虚构。
 */

export interface PairVariant {
  bytes: Uint8Array;
  va: Record<string, number>;
}

function big5(s: string): number[] {
  const b = encodeBig5(s);
  if (!b) throw new Error(`无法编码 ${s}`);
  return [...b, 0];
}

export function buildVariant(kind: 'ref' | 'dst'): PairVariant {
  const dst = kind === 'dst';
  const d = new DataBuilder(dataVaFor(0x1000));
  const va: Record<string, number> = {};
  if (dst) d.u8(...new Array(0x24).fill(0x11));
  va.PI = d.va;
  d.u32(2);
  va.OUT = d.va;
  d.u32(0);
  va.RATE = d.va;
  d.f64(0.9);
  va.TABLE = d.va;
  d.u32(30, 30, 300, 300);
  // 串：dst 里顺序不同
  const strs: [string, string][] = [
    ['STR_A', '#0001測試甲事件%d天'],
    ['STR_B', '#0002測試乙事件%d天'],
    ['STR_C', '#0003測試丙事件%d元'],
    ['STR_X', '測試寅'],
    ['STR_Y', '測試卯'],
  ];
  for (const [k, s] of dst ? [...strs].reverse() : strs) {
    va[k] = d.va;
    d.bytes(big5(s));
  }
  d.align(4);
  va.HANDLERS = d.va;
  d.u32(0, 0, 0, 0, 0, 0, 0);

  const frame = dst ? 0x54 : 0x84;
  const a = new Asm(TEXT_VA);
  a.label('MAIN');
  for (const h of ['H0', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']) a.call(h);
  a.ret();
  a.label('PRINT').ret();
  const handler = (name: string, days: number, str: number) => {
    a.label(name)
      .pushReg('ebx')
      .subEsp(frame)
      .cmpArg0(frame + 0xc)
      .jcc(5, `${name}_ret`);
    a.label(`${name}_days`).movRegImm('ecx', days).pushReg('ecx').pushImm(str).call('PRINT').addEsp(8);
    a.label(`${name}_res`)
      .pushImm(dst ? 0x1ea : 0x213)
      .call('PRINT')
      .addEsp(4);
    a.label(`${name}_ret`).addEsp(frame).popReg('ebx').ret();
  };
  handler('H0', 3, va.STR_A!);
  handler('H1', dst ? 7 : 5, va.STR_B!);
  a.label('H2').movRegMem('edx', va.PI!).movRegReg('eax', 'edx').shl('eax', 2).addRegReg('eax', 'edx');
  a.shl('eax', 3).subRegReg('eax', 'edx').shl('eax', 4).addRegReg('eax', 'edx').shl('eax', 4);
  a.movMemReg(va.OUT!, 'eax').pushImm(va.STR_C!).call('PRINT').addEsp(4).ret();
  a.label('H3').label('H3_fmul').fmulQword(va.RATE!);
  if (dst) a.nop();
  a.ret();
  a.label('H4').label('H4_ref').bytes(0x8b, 0x34, 0x9d).u32(va.TABLE!).ret();
  a.label('H5').pushImm(va.STR_X!).label('H5_imm').movRegImm('eax', 1).ret();
  a.label('H6').pushImm(va.STR_Y!).label('H6_imm').movRegImm('eax', 2).ret();
  const text = a.finish();
  for (const l of [
    'MAIN',
    'PRINT',
    'H0',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'H0_days',
    'H1_days',
    'H0_res',
    'H3_fmul',
    'H4_ref',
    'H5_imm',
    'H6_imm',
  ]) {
    va[l] = a.addr(l);
  }
  ['H0', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].forEach((h, k) => {
    d.patch32(va.HANDLERS! + 4 * k, a.addr(h));
  });
  return { bytes: codePe(text, d.finish(), 0x1000), va };
}
