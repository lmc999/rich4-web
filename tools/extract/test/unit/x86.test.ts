import { describe, expect, it } from 'vitest';
import { decodeAt, flowOf, formatInsn, type Insn, relTarget } from '../../src/exe/x86';

const dec = (hex: string, va = 0x401000): Insn => {
  const b = Uint8Array.from(hex.split(/\s+/).map((x) => Number.parseInt(x, 16)));
  return decodeAt(b, 0, va);
};
const txt = (hex: string, va?: number) => {
  const i = dec(hex, va);
  return `${i.len}|${formatInsn(i)}`;
};

describe('x86 解码：长度与 Intel 语法', () => {
  it('ModRM / SIB / 位移 / 立即数', () => {
    expect(txt('8b 45 08')).toBe('3|mov eax, dword [ebp + 0x8]');
    expect(txt('8b 0d 10 20 49 00')).toBe('6|mov ecx, dword [0x492010]');
    expect(txt('8b 04 85 44 5c 47 00')).toBe('7|mov eax, dword [eax*4 + 0x475c44]');
    expect(txt('89 8c 24 80 00 00 00')).toBe('7|mov dword [esp + 0x80], ecx');
    expect(txt('83 bc 24 90 00 00 00 00')).toBe('8|cmp dword [esp + 0x90], 0x0');
    expect(txt('83 7c 24 60 00')).toBe('5|cmp dword [esp + 0x60], 0x0');
    expect(txt('c6 80 26 00 00 00 03')).toBe('7|mov byte [eax + 0x26], 0x3');
    expect(txt('c7 05 2c bd 48 00 96 00 00 00')).toBe('10|mov dword [0x48bd2c], 0x96');
    expect(txt('81 ec 84 00 00 00')).toBe('6|sub esp, 0x84');
    expect(txt('6b c0 34')).toBe('3|imul eax, eax, 0x34');
    expect(txt('69 c0 68 00 00 00')).toBe('6|imul eax, eax, 0x68');
    expect(txt('8d 44 24 08')).toBe('4|lea eax, [esp + 0x8]');
    expect(txt('8d 34 49')).toBe('3|lea esi, [ecx + ecx*2]');
  });

  it('立即数的符号：push 8 位符号扩展、32 位按有符号保存；cmp r/m8, imm8 无符号', () => {
    const p = dec('6a ff');
    expect(p.ops[0]).toMatchObject({ t: 'imm', value: -1, size: 1, off: 1 });
    expect(dec('68 ff ff ff ff').ops[0]).toMatchObject({ value: -1, size: 4 });
    expect(dec('80 3d 00 10 40 00 80').ops[1]).toMatchObject({ value: 0x80, size: 1 });
    expect(dec('b7 0f').ops).toEqual([
      { t: 'reg', name: 'bh', size: 1 },
      { t: 'imm', value: 15, size: 1, off: 1 },
    ]);
  });

  it('前缀：0x66 操作数宽度、rep、段超越', () => {
    expect(txt('66 8b 45 08')).toBe('4|mov ax, word [ebp + 0x8]');
    expect(txt('66 c7 00 34 12')).toBe('5|mov word [eax], 0x1234');
    expect(txt('f3 a5')).toBe('2|rep movsd');
    expect(txt('2e ff 15 10 23 46 00')).toBe('7|call dword cs:[0x462310]');
  });

  it('分组指令：grp1/grp2/grp3/grp5', () => {
    expect(txt('83 c4 10')).toBe('3|add esp, 0x10');
    expect(txt('c1 e0 04')).toBe('3|shl eax, 0x4');
    expect(txt('d1 f8')).toBe('2|sar eax, 0x1');
    expect(txt('f6 80 05 00 00 00 08')).toBe('7|test byte [eax + 0x5], 0x8');
    expect(txt('f7 f9')).toBe('2|idiv ecx');
    expect(txt('ff 24 85 7a 1c 43 00')).toBe('7|jmp dword [eax*4 + 0x431c7a]');
    expect(txt('ff 14 9d 24 5e 47 00')).toBe('7|call dword [ebx*4 + 0x475e24]');
    expect(txt('ff 35 00 10 40 00')).toBe('6|push dword [0x401000]');
  });

  it('0F 双字节：jcc rel32、movzx/movsx、setcc、imul r,r/m', () => {
    expect(txt('0f 85 10 00 00 00', 0x401000)).toBe('6|jne 0x401016');
    expect(txt('0f b6 10')).toBe('3|movzx edx, byte [eax]');
    expect(txt('0f bf 46 02')).toBe('4|movsx eax, word [esi + 0x2]');
    expect(txt('0f 9c c0')).toBe('3|setl al');
    expect(txt('0f af c6')).toBe('3|imul eax, esi');
  });

  it('x87：内存操作数宽度', () => {
    expect(dec('dc 0d dc 54 46 00').ops[0]).toMatchObject({ t: 'mem', size: 8, dispU: 0x4654dc });
    expect(dec('dc 0d dc 54 46 00').mnem).toBe('fmul');
    expect(dec('d8 35 a0 59 46 00')).toMatchObject({ mnem: 'fdiv', len: 6 });
    expect(dec('d8 35 a0 59 46 00').ops[0]).toMatchObject({ size: 4 });
    expect(txt('db 1c 24')).toBe('3|fistp dword [esp]');
    expect(txt('df 6c 24 04')).toBe('4|fild qword [esp + 0x4]');
    expect(txt('d9 e8')).toBe('2|fld1');
    expect(txt('de c9')).toBe('2|fmulp st(1)');
  });

  it('相对跳转目标与控制流类别', () => {
    const j = dec('eb fe', 0x402000);
    expect(relTarget(j)).toBe(0x402000);
    expect(flowOf(j)).toBe('jmp');
    expect(relTarget(dec('e8 00 00 00 00', 0x402000))).toBe(0x402005);
    expect(flowOf(dec('e8 00 00 00 00'))).toBe('call');
    expect(flowOf(dec('75 02'))).toBe('jcc');
    expect(flowOf(dec('c3'))).toBe('ret');
    expect(flowOf(dec('ff e0'))).toBe('ijmp');
    expect(flowOf(dec('ff d0'))).toBe('icall');
    expect(flowOf(dec('cc'))).toBe('stop');
  });

  it('非法与截断：返回 (bad)、长度 1', () => {
    expect(dec('c6 c8 43')).toMatchObject({ mnem: '(bad)', len: 1 });
    expect(dec('8f c8')).toMatchObject({ mnem: '(bad)', len: 1 });
    expect(dec('8e 72 42')).toMatchObject({ mnem: '(bad)', len: 1 });
    expect(txt('8e d8')).toBe('2|mov ds, ax');
    expect(dec('8b')).toMatchObject({ mnem: '(bad)', len: 1 });
    expect(dec('0f 0f')).toMatchObject({ mnem: '(bad)', len: 1 });
    expect(dec('ee')).toMatchObject({ mnem: 'out', len: 1 });
    expect(dec('0f 2a 43 00')).toMatchObject({ mnem: 'simd', len: 4 });
  });
});
