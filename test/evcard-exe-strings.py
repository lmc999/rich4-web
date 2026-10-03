# 调试脚本（事件卡片取证）：列出 rich4.exe（v2.06）里一段 VA 区间内的 Big5 字符串（含 #NNNN 语音前缀）。
# 用法：python3 test/evcard-exe-strings.py 0x463400 0x463e30
import struct, sys
data = open('original/Game/rich4.exe', 'rb').read()
pe = struct.unpack_from('<I', data, 0x3c)[0]
nsec = struct.unpack_from('<H', data, pe + 6)[0]
opt = struct.unpack_from('<H', data, pe + 20)[0]
base = struct.unpack_from('<I', data, pe + 24 + 28)[0]
secs = []
for i in range(nsec):
    o = pe + 24 + opt + 40 * i
    vsz, va, rsz, rp = struct.unpack_from('<IIII', data, o + 8)
    secs.append((va + base, max(vsz, rsz), rp))
def off(v):
    for va, sz, rp in secs:
        if va <= v < va + sz:
            return rp + (v - va)
def s(v):
    o = off(v); e = data.index(b'\0', o)
    return data[o:e].decode('big5', errors='replace')
lo, hi = int(sys.argv[1], 16), int(sys.argv[2], 16)
v = lo
while v < hi:
    o = off(v); e = data.index(b'\0', o)
    if e > o:
        print(hex(v), repr(data[o:e].decode('big5', errors='replace')))
    v += (e - o) + 1
