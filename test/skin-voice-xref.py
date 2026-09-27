#!/usr/bin/env python3
"""A3 调试：找出 '#NNNN' 台词字符串的 VA，再在数据段/代码段里搜引用这些 VA 的指针（表结构），用于核实语音编号的 k 语义。只读。
用法：python3 test/skin-voice-xref.py original/Game/rich4.exe"""
import sys, re, struct
sys.path.insert(0, __import__('os').path.dirname(__file__))
from ar_sfx_tables import pe_sections
b = open(sys.argv[1], 'rb').read(); base, secs = pe_sections(b)
def off2va(o):
    for s in secs:
        if s['raw'] <= o < s['raw'] + s['rsize']: return s['va'] + o - s['raw']
strs = {}
for s in secs:
    if s['chars'] & 0x20: continue
    data = b[s['raw']:s['raw'] + s['rsize']]
    for m in re.finditer(rb'#(\d{4})', data):
        if m.start() > 0 and data[m.start() - 1] != 0: continue
        strs.setdefault(int(m.group(1)), []).append(s['va'] + m.start())
va2id = {va: vid for vid, vas in strs.items() for va in vas}
# 扫描所有 u32（步长 4 与步长 1 都试）
refs = {}
for o in range(0, len(b) - 4):
    v = struct.unpack_from('<I', b, o)[0]
    if v in va2id: refs.setdefault(va2id[v], []).append(off2va(o))
lo, hi = int(sys.argv[2]) if len(sys.argv) > 2 else 234, int(sys.argv[3]) if len(sys.argv) > 3 else 270
for vid in range(lo, hi):
    print(vid, [hex(x) for x in strs.get(vid, [])], [hex(x) if x else None for x in refs.get(vid, [])][:6])
