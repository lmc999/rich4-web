# 调试脚本（卡片取证）：按 VA 读 rich4.exe（v2.06）里的 Big5 字符串与卡名表
# 用法：python3 test/card-orig-exe-strings.py
import struct

EXE = 'original/Game/rich4.exe'
buf = open(EXE, 'rb').read()
# (vaddr, vsize, paddr, psize) —— rabin2 -S 结果
SECS = [(0x401000, 0x5F000, 0x400, 0x5EA00), (0x460000, 0x1000, 0x5EE00, 0xE00), (0x461000, 0x26000, 0x5FC00, 0x25E00)]


def off(va):
    for v, vs, p, ps in SECS:
        if v <= va < v + ps:
            return p + (va - v)
    raise ValueError(hex(va))


def cstr(va):
    o = off(va)
    e = buf.index(b'\0', o)
    return buf[o:e].decode('big5', errors='replace')


def u32(va):
    return struct.unpack_from('<I', buf, off(va))[0]


print('== 卡名表 0x47d54a（步长 8：u32 名字指针 + u32 ?）')
for k in range(0, 32):
    va = 0x47D54A + k * 8
    p, q = struct.unpack_from('<II', buf, off(va))
    name = cstr(p) if 0x461000 <= p < 0x487000 else '?'
    print(f'k={k:2d} @{va:#x} ptr={p:#x} f2={q:#010x} name={name!r}')

print('== 格式串')
for va in [0x461A7B, 0x463353, 0x46337C, 0x46338D, 0x4633E9, 0x464230]:
    print(hex(va), repr(cstr(va)))
