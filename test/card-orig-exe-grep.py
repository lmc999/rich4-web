# 调试脚本（卡片取证）：把 rich4.exe（v2.06）DGROUP 段里的 NUL 结尾串按 Big5 解码，按关键字过滤并打印 VA
# 用法：python3 test/card-orig-exe-grep.py 卡 [关键字...]
import sys

buf = open('original/Game/rich4.exe', 'rb').read()
P, V, S = 0x5FC00, 0x461000, 0x25E00
seg = buf[P:P + S]
keys = sys.argv[1:] or ['卡']
i = 0
while i < len(seg):
    j = seg.find(b'\0', i)
    if j < 0:
        break
    raw = seg[i:j]
    if len(raw) >= 2:
        try:
            s = raw.decode('big5')
            if any(k in s for k in keys):
                print(hex(V + i), repr(s))
        except UnicodeDecodeError:
            pass
    i = j + 1
