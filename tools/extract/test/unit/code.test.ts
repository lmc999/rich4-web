import { describe, expect, it } from 'vitest';
import { CodeIndex, disasmFunction, MulChainError, mulChain } from '../../src/exe/code';
import { PeFile } from '../../src/pe/scan';
import { Asm } from '../helpers/asm';
import { codePe, DataBuilder, dataVaFor, TEXT_VA } from '../helpers/codePe';

/**
 * 合成代码：
 *   F0: call F1; call F2; call F3; ret
 *   （填充 0xc1：线性扫描会把它与 F1 的首字节拼成一条 grp2 指令）
 *   F1: push ebx; mov edx,[PI]; 乘法链 ×10000; mov [OUT],eax; pop ebx; ret
 *   F2: cmp eax,2; ja D; jmp [eax*4+T]; T: C0,C1,C2（代码节内）; C0/C1/C2: ret；D: jmp F3（F3 为 stopAt）
 *   F3: mov edx,[PI]; lea eax,[edx+edx*4]; shl eax,1; imul eax,eax,0x64; ret   → ×1000
 */
function build() {
  const dataVa = dataVaFor(0x1000);
  const d = new DataBuilder(dataVa);
  const PI = d.va;
  d.u32(3);
  const OUT = d.va;
  d.u32(0);
  const a = new Asm(TEXT_VA);
  a.label('F0').call('F1').call('F2').call('F3').ret();
  a.bytes(0xc1);
  a.label('F1').pushReg('ebx');
  a.label('chain').movRegMem('edx', PI).movRegReg('eax', 'edx').shl('eax', 2).addRegReg('eax', 'edx');
  a.shl('eax', 3).subRegReg('eax', 'edx').shl('eax', 4).addRegReg('eax', 'edx').shl('eax', 4);
  a.movMemReg(OUT, 'eax').popReg('ebx').ret();
  a.label('F2').cmpRegImm('eax', 2).jcc(7, 'D');
  const jt = a.va + 7;
  a.jmpTable('eax', jt);
  a.label('T').u32(0).u32(0).u32(0);
  a.label('C0').ret().label('C1').ret().label('C2').ret();
  a.label('D').jmp('F3');
  a.label('F3').movRegMem('edx', PI).bytes(0x8d, 0x04, 0x92).shl('eax', 1).bytes(0x6b, 0xc0, 0x64).ret();
  a.label('BAD').movRegMem('edx', PI).bytes(0x0f, 0xaf, 0xc2).ret();
  const text = a.finish();
  // 回填代码节内跳表
  const dv = new DataView(text.buffer);
  for (let k = 0; k < 3; k++) dv.setUint32(a.addr('T') - TEXT_VA + 4 * k, a.addr(`C${k}`), true);
  const pe = codePe(text, d.finish(), 0x1000);
  return { file: new PeFile(pe, 'code'), a, PI, OUT };
}

describe('CodeIndex 与函数体', () => {
  const { file, a, PI } = build();
  const code = CodeIndex.build(file);

  it('分支目标重新同步：填充字节不吞掉下一函数的首条指令；call 目标记为函数入口', () => {
    // 线性扫描从填充字节解出的指令跨过了 F1 的入口；重新同步后 F1 仍是指令起点
    expect(code.at(a.addr('F1') - 1).len).toBeGreaterThan(1);
    expect(code.isBoundary(a.addr('F1'))).toBe(true);
    expect(code.at(a.addr('F1')).mnem).toBe('push');
    expect([...code.entries]).toEqual([a.addr('F1'), a.addr('F2'), a.addr('F3')]);
    expect(code.enclosingEntry(a.addr('chain') + 3)).toBe(a.addr('F1'));
    expect(code.enclosingEntry(TEXT_VA)).toBeNull();
    expect(code.inCode(TEXT_VA)).toBe(true);
    expect(code.inCode(TEXT_VA + 0x1000)).toBe(false);
    const w = code.window(a.addr('F1'), 1, 2);
    expect(w.map((i) => i.va)).toEqual([w[0]!.va, a.addr('F1'), a.addr('chain')]);
  });

  it('disasmFunction：解析「cmp + ja + jmp [reg*4+表]」的跳表；stopAt 不进入其他入口；收集调用目标', () => {
    const f2 = disasmFunction(code, a.addr('F2'), { stopAt: new Set([a.addr('F3')]) });
    expect(f2.jumpTables).toEqual([{ table: a.addr('T'), targets: [a.addr('C0'), a.addr('C1'), a.addr('C2')] }]);
    const vas = f2.insns.map((i) => i.va);
    expect(vas).toContain(a.addr('C2'));
    expect(vas).toContain(a.addr('D'));
    expect(vas).not.toContain(a.addr('F3'));
    const f2all = disasmFunction(code, a.addr('F2'));
    expect(f2all.insns.map((i) => i.va)).toContain(a.addr('F3'));
    const f0 = disasmFunction(code, a.addr('F0'));
    expect(f0.calls).toEqual([a.addr('F1'), a.addr('F2'), a.addr('F3')]);
    expect(f0.insns).toHaveLength(4);
    expect(disasmFunction(code, a.addr('F1'), { maxInsns: 3 }).truncated).toBe(true);
  });

  it('mulChain：移位/加减链与 lea/imul 链求系数，记录链首读取地址', () => {
    expect(mulChain(code, a.addr('chain'), 9, 'eax')).toMatchObject({ factor: 10000, source: PI });
    expect(mulChain(code, a.addr('F3'), 4, 'eax').factor).toBe(1000);
    expect(() => mulChain(code, a.addr('F1'), 3, 'eax')).toThrow(MulChainError);
    expect(() => mulChain(code, a.addr('chain'), 3, 'ebx')).toThrow(/不含源量/);
    expect(() => mulChain(code, a.addr('BAD'), 2, 'edx')).toThrow(/imul/);
  });
});
