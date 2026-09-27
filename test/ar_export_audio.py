#!/usr/bin/env python3
"""调研：把 MKF 内的 RIFF WAV 资源原样导出为 .wav（资源体本身就是完整 WAV 文件）。只读原版。
用法：python3 test/ar_export_audio.py <mkf> <ids: 1,2,5-9|all> <outdir> <prefix>"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from ar_mkf_survey import open_mkf
def parse_ids(s, n):
    if s=='all': return list(range(n))
    out=[]
    for t in s.split(','):
        if '-' in t: a,b=map(int,t.split('-')); out+=range(a,b+1)
        else: out.append(int(t))
    return out
if __name__=='__main__':
    path, ids, outdir, prefix = sys.argv[1:5]
    b,x,n,s,ents=open_mkf(path); os.makedirs(outdir, exist_ok=True); cnt=0
    for i in parse_ids(ids, len(ents)):
        e=ents[i]; body=b[e['off']+16:e['off']+16+e['stored']]
        if body[:4]!=b'RIFF': continue
        open(os.path.join(outdir, f'{prefix}{i:04d}.wav'),'wb').write(body); cnt+=1
    print('exported', cnt, 'to', outdir)
