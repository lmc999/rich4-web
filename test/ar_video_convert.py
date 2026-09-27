#!/usr/bin/env python3
"""调研：把共享盘 Media/*.avi（Indeo5 + IMA ADPCM/PCM）批量转 MP4(H.264+AAC) 与 WebM(VP9+Opus)，统计体积与耗时。
用法：python3 test/ar_video_convert.py <Media目录> <输出目录> [--keep]"""
import sys, os, subprocess, glob, json, time
from concurrent.futures import ThreadPoolExecutor
SRC, OUT = sys.argv[1], sys.argv[2]; KEEP = '--keep' in sys.argv
os.makedirs(OUT, exist_ok=True)
MP4 = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '96k']
WEBM = ['-c:v', 'libvpx-vp9', '-crf', '33', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '64k']
def probe(f):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], capture_output=True, text=True)
    return float(r.stdout.strip() or 0)
def job(f):
    b = os.path.splitext(os.path.basename(f))[0]; row = {'src': os.path.basename(f), 'srcBytes': os.path.getsize(f), 'dur': round(probe(f), 2)}
    for ext, args in (('mp4', MP4), ('webm', WEBM)):
        o = os.path.join(OUT, f'{b}.{ext}'); t = time.time()
        r = subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-v', 'error', '-y', '-i', f, *args, o], capture_output=True, text=True)
        row[ext] = os.path.getsize(o) if os.path.exists(o) else None; row[ext + 'Sec'] = round(time.time() - t, 1); row[ext + 'Err'] = r.stderr.strip()[:120]
        if not KEEP and os.path.exists(o): os.remove(o)
    return row
files = sorted(glob.glob(os.path.join(SRC, '*.avi')) + glob.glob(os.path.join(SRC, '*.AVI')))
with ThreadPoolExecutor(3) as ex: rows = list(ex.map(job, files))
for r in rows: print(r)
tot = {k: sum(r[k] or 0 for r in rows) for k in ('srcBytes', 'mp4', 'webm', 'dur')}
print('TOTAL', tot)
json.dump(dict(rows=rows, total=tot), open(os.path.join(OUT, 'video-convert.json'), 'w'), indent=1)
