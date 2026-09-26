import { describe, expect, it } from 'vitest';
import { CodeIndex } from '../../src/exe/code';
import {
  alignTransfer,
  insnPattern,
  lcsAlign,
  shapeToken,
  stringMapping,
  stringTranslator,
  transferInsn,
} from '../../src/exe/insnTransfer';
import { PeFile } from '../../src/pe/scan';
import { buildVariant } from '../helpers/buildCodePair';

const ref = buildVariant('ref');
const dst = buildVariant('dst');
const rf = new PeFile(ref.bytes, 'ref');
const df = new PeFile(dst.bytes, 'dst');
const rc = CodeIndex.build(rf);
const dc = CodeIndex.build(df);
const tr = stringTranslator(rf, df);

describe('指令迁移（v3.11 → v2.06 的合成对照）', () => {
  it('串地址换算：两版都唯一的同文 Big5 串一一对应', () => {
    expect(tr(ref.va.STR_A!)).toBe(dst.va.STR_A);
    expect(tr(ref.va.STR_Y!)).toBe(dst.va.STR_Y);
    expect(tr(ref.va.PI!)).toBeNull();
    expect(stringMapping(rf, df).targets.has(dst.va.STR_C!)).toBe(true);
  });

  it('字节模式：数据地址与相对位移通配，目标指令的立即数通配（常量可以不同）', () => {
    // 默认窗口含前一函数的尾部（栈帧不同）→ 0 命中；只向后取则唯一
    expect(transferInsn(rc, dc, ref.va.H2!).va).toBeNull();
    const t = transferInsn(rc, dc, ref.va.H2!, { windows: [[0, 6]] });
    expect(t).toMatchObject({ va: dst.va.H2, hits: 1, window: [0, 6] });
    expect(transferInsn(rc, dc, ref.va.H4_ref!, { windows: [[0, 1]] }).va).toBe(dst.va.H4_ref);
    // dst 的 H3 在 fmul 后多一条 nop：只取前一条
    expect(transferInsn(rc, dc, ref.va.H3_fmul!, { windows: [[1, 1]] }).va).toBeNull();
    expect(transferInsn(rc, dc, ref.va.H3_fmul!, { windows: [[1, 0]] }).va).toBe(dst.va.H3_fmul);
    const p = insnPattern(rc, rc.window(ref.va.H4_ref!, 0, 1), ref.va.H4_ref!, true);
    expect(Array.from(p.mask.slice(3, 7))).toEqual([0, 0, 0, 0]);
  });

  it('结构相同的两个处理函数：不换算串时不唯一，换算后唯一', () => {
    const noTr = transferInsn(rc, dc, ref.va.H6_imm!, { windows: [[1, 1]] });
    expect(noTr.va).toBeNull();
    expect(noTr.hits).toBe(2);
    const withTr = transferInsn(rc, dc, ref.va.H6_imm!, { windows: [[1, 1]], translate: tr });
    expect(withTr.va).toBe(dst.va.H6_imm);
  });

  it('栈帧大小不同（位移编码长度改变）：字节模式 0 命中，锚点 + 规范化记号 LCS 对齐后找到', () => {
    const t = transferInsn(rc, dc, ref.va.H1_days!, { translate: tr });
    expect(t.va).toBeNull();
    const a = alignTransfer(rc, dc, ref.va.H1_days!, tr);
    expect(a.va).toBe(dst.va.H1_days);
    expect(a.anchor).not.toBeNull();
    expect(alignTransfer(rc, dc, ref.va.H0_res!, tr).va).toBe(dst.va.H0_res);
    expect(alignTransfer(rc, dc, ref.va.H0_days! + 1, tr).va).toBeNull();
  });

  it('shapeToken 不含数值；lcsAlign 给出单调对齐', () => {
    expect(shapeToken(rc.at(ref.va.H0_days!))).toBe('mov ecx,I');
    expect(shapeToken(rc.at(ref.va.H0!))).toBe('push ebx');
    const m = lcsAlign(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']);
    expect([...m.entries()]).toEqual([
      [0, 0],
      [2, 2],
      [3, 3],
    ]);
  });
});
