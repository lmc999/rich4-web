#!/usr/bin/env python3
"""调研：百货公司道具店在原版 rich4.exe（v2.06）里的买卖流程取证（只读）。

打印：
  1. 道具表 tool_table（VA 0x47d63a + id*8：+0 名称指针、+4 共享库存初始量、+5 点券价）1..8 的库存与价格；
  2. 店员讲话表（VA 0x4733f4，卡片页 / 道具页各 6 条），确认没有「库存」「数量」之类的提示；
  3. 用 radare2 反汇编关键片段：进店建道具货架（只列库存 > 0 的，行里只画名称与 $价格）、真人点道具行
     （一次买 1 个、买后该行清零变灰）、买 1 个道具的函数（无数量参数）、真人卖道具（push 1）、电脑买道具循环。
用法：python3 test/shop-orig-exe.py [exe 路径，默认 original/Game/rich4.exe]
"""
import struct
import subprocess
import sys

EXE = sys.argv[1] if len(sys.argv) > 1 else 'original/Game/rich4.exe'
data = open(EXE, 'rb').read()
pe = struct.unpack_from('<I', data, 0x3C)[0]
nsec = struct.unpack_from('<H', data, pe + 6)[0]
opt = struct.unpack_from('<H', data, pe + 20)[0]
base = struct.unpack_from('<I', data, pe + 24 + 28)[0]
secs = []
for i in range(nsec):
    _name, vs, va, rs, ra = struct.unpack_from('<8sIIII', data, pe + 24 + opt + i * 40)
    secs.append((va + base, vs, ra, rs))


def v2o(v):
    for va, vs, ra, rs in secs:
        if va <= v < va + max(vs, rs):
            return v - va + ra
    return None


def cstr(v):
    o = v2o(v)
    if o is None:
        return None
    e = data.index(b'\0', o)
    return data[o:e].decode('big5', 'replace')


print('== tool_table 1..8（VA 0x47d63a + id*8）')
for i in range(1, 9):
    o = v2o(0x47D63A + i * 8)
    ptr, pool, price = struct.unpack_from('<IBB', data, o)
    print(f'  id {i}: {cstr(ptr)}  库存初始 {pool}  价格 {price}')

print('== 店员讲话表（VA 0x4733f4，页 * 0x18）')
for page in range(2):
    for k in range(6):
        a = 0x4733F4 + page * 0x18 + k * 4
        p = struct.unpack_from('<I', data, v2o(a))[0]
        s = cstr(p) if 0x460000 < p < 0x480000 else None
        print(f'  page {page} [{k}] {hex(a)} → {s!r}')
for a in (0x462360, 0x463436):
    print(f'  格式串 {hex(a)} {cstr(a)!r}')

RANGES = [
    ('进店：道具货架（只列库存>0，画名称与 $价格）', 0x42DFEC, 0x42E0AF),
    ('真人点道具行：点券 / 持有检查 → 买 1 个 → 该行变灰并清零', 0x42D775, 0x42D9F0),
    ('真人卖道具：一次 1 个', 0x42D4D9, 0x42D521),
    ('买 1 个道具 fcn.0042c64b（无数量参数）', 0x42C64B, 0x42C672),
    ('电脑买道具循环（表 0x473424 各买 1 个）', 0x42E615, 0x42E6EF),
]
for title, lo, hi in RANGES:
    print(f'== {title} {hex(lo)}..{hex(hi)}')
    cmd = f'e scr.color=0;e asm.bytes=false;aa;pD {hi - lo} @ {hex(lo)}'
    print(subprocess.run(['r2', '-q', '-c', cmd, EXE], capture_output=True, text=True).stdout)
