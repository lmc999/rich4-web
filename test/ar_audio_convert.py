#!/usr/bin/env python3
"""调研：把导出的 WAV 批量转成浏览器格式以估算体积（不入库）。
用法：python3 test/ar_audio_convert.py <wav目录> <输出根目录>
生成：opus/（Ogg Opus 单声道 32k VBR）、mp3/（LAME VBR V6 单声道）、m4a/（AAC-LC 48k 单声道）"""
import sys, os, subprocess, glob
from concurrent.futures import ThreadPoolExecutor
IN, OUT = sys.argv[1], sys.argv[2]
PRESETS = {
    'opus': ('ogg', ['-ac', '1', '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', '-application', 'audio']),
    'mp3': ('mp3', ['-ac', '1', '-c:a', 'libmp3lame', '-q:a', '6']),
    'm4a': ('m4a', ['-ac', '1', '-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart']),
}
for k in PRESETS: os.makedirs(os.path.join(OUT, k), exist_ok=True)
def job(f):
    b = os.path.splitext(os.path.basename(f))[0]; errs = []
    for k, (ext, args) in PRESETS.items():
        r = subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-v', 'error', '-y', '-i', f, *args, os.path.join(OUT, k, f'{b}.{ext}')], capture_output=True, text=True)
        if r.returncode or r.stderr.strip(): errs.append((k, r.stderr.strip()[:200]))
    return b, errs
files = sorted(glob.glob(os.path.join(IN, '*.wav')))
with ThreadPoolExecutor(8) as ex:
    bad = [x for x in ex.map(job, files) if x[1]]
print('converted', len(files), 'files; errors', len(bad))
for b in bad[:10]: print(b)
