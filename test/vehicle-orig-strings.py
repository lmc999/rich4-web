# 临时调研（交通工具）：在 rich4.exe（v2.06）数据段里找含关键字的 Big5 字符串并打印 VA
# 用法：python3 test/vehicle-orig-strings.py [关键字...]
import re
import sys

EXE = 'original/Game/rich4.exe'
buf = open(EXE, 'rb').read()
# (vaddr, vsize, paddr, psize) —— rabin2 -S 结果
SECS = [(0x401000, 0x5F000, 0x400, 0x5EA00), (0x460000, 0x1000, 0x5EE00, 0xE00), (0x461000, 0x26000, 0x5FC00, 0x25E00)]
keys = sys.argv[1:] or ['步行', '機車', '汽車', '下車', '收車', '走路', '座車', '交通', '騎', '開車', '坐車', '徒步']


def va_of(off):
    for v, vs, p, ps in SECS:
        if p <= off < p + ps:
            return v + (off - p)
    return None


for m in re.finditer(rb'[\x20-\x7e\x81-\xfe][\x20-\x7e\x40-\xfe]{3,}\x00', buf):
    raw = m.group(0)[:-1]
    try:
        s = raw.decode('big5')
    except UnicodeDecodeError:
        continue
    if any(k in s for k in keys):
        va = va_of(m.start())
        print(hex(va) if va else '?', repr(s))
