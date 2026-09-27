#!/usr/bin/env python3
"""A3 调试：给 sfx-callsites.v206.json 里每个已解析调用点，列出附近（±窗口）代码引用的 Big5 字符串与 FLIC/语音调用，
用于把「音效号 → 用途」标注到调用语境。只读；输出到 stdout。
用法：python3 test/skin-sfx-context.py original/Game/rich4.exe .cache/assets-research/audio/sfx-callsites.v206.json [窗口字节]"""
import json, sys, struct, re
sys.path.insert(0, __import__('os').path.dirname(__file__))
from ar_sfx_tables import pe_sections
exe, cs = sys.argv[1], sys.argv[2]
win = int(sys.argv[3]) if len(sys.argv) > 3 else 0x180
b = open(exe, 'rb').read(); base, secs = pe_sections(b)
def va2off(va):
    for s in secs:
        if s['va'] <= va < s['va'] + s['rsize']: return s['raw'] + va - s['va']
    return None
def cstr(va):
    o = va2off(va)
    if o is None or (o > 0 and b[o - 1] != 0): return None
    e = b.find(b'\0', o, o + 200)
    if e < 0 or e - o < 2: return None
    raw = b[o:e]
    try: t = raw.decode('big5')
    except Exception: return None
    if not re.search(r'[一-鿿]', t): return None
    return t
calls = json.load(open(cs))['resolved']
for c in sorted(calls, key=lambda c: int(c[0], 16)):
    a = int(c[0], 16); o = va2off(a); near = []
    for p in range(o - win, o + win):
        v = struct.unpack_from('<I', b, p)[0]
        if 0x460000 <= v < 0x470000:
            t = cstr(v)
            if t and (p - o, t) not in near: near.append((p - o, t))
    near.sort(key=lambda x: abs(x[0]))
    print(c[0], 'sfx', c[3], ' || '.join(f'{d:+d}:{t.replace(chr(10), "/")[:24]}' for d, t in near[:4]))
