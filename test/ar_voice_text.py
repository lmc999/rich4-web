#!/usr/bin/env python3
"""调研：从 rich4.exe 抽出所有以 "#NNNN" 开头的 Big5 台词字符串（NNNN = Speaking.mkf 资源号），生成语音清单。只读。
用法：python3 test/ar_voice_text.py <rich4.exe> <speaking.index.json> <out.json>"""
import sys, re, json, struct
sys.path.insert(0, __import__('os').path.dirname(__file__))
from ar_sfx_tables import pe_sections
exe, idx, out = sys.argv[1:4]
b = open(exe, 'rb').read(); base, secs = pe_sections(b)
found = {}
for s in secs:
    if s['chars'] & 0x20: continue
    data = b[s['raw']:s['raw'] + s['rsize']]
    for m in re.finditer(rb'#(\d{4})([^\x00]{1,120})\x00', data):
        # 要求前一个字节是 NUL（字符串起点）
        if m.start() > 0 and data[m.start() - 1] != 0: continue
        try: txt = m.group(2).decode('big5')
        except UnicodeDecodeError: txt = m.group(2).decode('big5', 'replace')
        vid = int(m.group(1)); va = s['va'] + m.start()
        found.setdefault(vid, []).append({'va': hex(va), 'text': txt})
rows = {r['i']: r for r in json.load(open(idx))}
seg = lambda i: 'system' if i < 426 else ('card' if i < 1050 else 'event')
manifest = []
for i in range(1374):
    r = rows[i]
    manifest.append({'id': i, 'segment': seg(i), 'char': None if i < 426 else ((i - 426) // 52 if i < 1050 else (i - 1050) // 27),
                     'slot': None if i < 426 else ((i - 426) % 52 if i < 1050 else (i - 1050) % 27),
                     'rate': r['rate'], 'bits': r['bits'], 'ch': r['ch'], 'dur': r['dur'], 'bytes': r['size'],
                     'texts': [t['text'] for t in found.get(i, [])]})
json.dump(manifest, open(out, 'w'), ensure_ascii=False, indent=0)
have = sum(1 for m in manifest if m['texts'])
print('ids with text', have, '/ 1374; strings', sum(len(v) for v in found.values()), '; out-of-range ids', [k for k in found if k >= 1374])
from collections import Counter
print('by segment', Counter(m['segment'] for m in manifest if m['texts']))
for i in [0, 1, 2, 4, 10, 14, 36, 100, 266, 330, 361, 425, 426, 455, 477, 1050, 1074, 1075, 1076, 1373]:
    print(i, manifest[i]['texts'][:2])
