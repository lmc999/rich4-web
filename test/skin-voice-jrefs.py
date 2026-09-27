#!/usr/bin/env python3
"""A3 调试：列出代码段中对台词指针表 base+4j（j=0..n-1）的 disp32 引用，用于核实每个下标 j 的调用语境。只读。
用法：python3 test/skin-voice-jrefs.py <exe> <baseVA hex> <n>"""
import struct, sys
sys.path.insert(0, __import__('os').path.dirname(__file__))
from ar_sfx_tables import pe_sections
b = open(sys.argv[1], 'rb').read(); base, secs = pe_sections(b)
t = int(sys.argv[2], 16); n = int(sys.argv[3])
code = [s for s in secs if s['chars'] & 0x20]
for j in range(n):
    tgt = struct.pack('<I', t + 4 * j); hits = []
    for s in code:
        d = b[s['raw']:s['raw'] + s['rsize']]; p = d.find(tgt)
        while p >= 0:
            hits.append(hex(s['va'] + p)); p = d.find(tgt, p + 1)
    print(j, hits)
