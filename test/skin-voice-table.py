#!/usr/bin/env python3
"""A3 调试：按 VA 转储指针表（每项指向 Big5 字符串），打印 '#NNNN' 语音号，用于核实台词表的维度与下标语义。只读。
用法：python3 test/skin-voice-table.py <exe> <tableVA hex> <perRow> <rows>"""
import sys, struct, re
sys.path.insert(0, __import__('os').path.dirname(__file__))
from ar_sfx_tables import pe_sections
b = open(sys.argv[1], 'rb').read(); base, secs = pe_sections(b)
def va2off(va):
    for s in secs:
        if s['va'] <= va < s['va'] + max(s['rsize'], 1): return s['raw'] + va - s['va']
    return None
def cstr(va):
    o = va2off(va)
    if o is None: return None
    e = b.index(b'\0', o); return b[o:e]
t = int(sys.argv[2], 16); per = int(sys.argv[3]); rows = int(sys.argv[4])
for r in range(rows):
    out = []
    for j in range(per):
        p = struct.unpack_from('<I', b, va2off(t + 4 * (r * per + j)))[0]
        s = cstr(p) if p else None
        if s is None: out.append(f'{j}:{p:#x}?'); continue
        m = re.match(rb'#(\d{4})', s)
        out.append(f'{j}:{int(m.group(1)) if m else "-"}')
    print(r, ' '.join(out))
