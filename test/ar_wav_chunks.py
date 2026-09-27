#!/usr/bin/env python3
"""调研：打印 MKF 内 WAV 的 LIST/INFO 文本和 smpl 循环点。只读。"""
import struct, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from ar_mkf_survey import open_mkf
def chunks(buf):
    p=12
    while p+8<=len(buf):
        cid=buf[p:p+4]; sz=struct.unpack_from('<I',buf,p+4)[0]
        yield cid, buf[p+8:p+8+sz]
        p+=8+sz+(sz&1)
def info_list(d):
    if d[:4]!=b'INFO': return d[:40].hex()
    p=4; out=[]
    while p+8<=len(d):
        cid=d[p:p+4]; sz=struct.unpack_from('<I',d,p+4)[0]
        v=d[p+8:p+8+sz].rstrip(b'\0')
        try: v=v.decode('big5')
        except: v=v.decode('latin1')
        out.append(f"{cid.decode('latin1')}={v}")
        p+=8+sz+(sz&1)
    return '; '.join(out)
def smpl(d):
    f=struct.unpack_from('<9I',d,0)
    n=f[7]; loops=[]
    for k in range(n):
        l=struct.unpack_from('<6I',d,36+24*k); loops.append(dict(type=l[1],start=l[2],end=l[3],frac=l[4],count=l[5]))
    return dict(period=f[2],unity=f[3],nloops=n,loops=loops)
if __name__=='__main__':
    b,x,n,s,ents=open_mkf(sys.argv[1])
    sel = range(len(ents)) if len(sys.argv)<3 else [int(t) for t in sys.argv[2].split(',')]
    for i in sel:
        e=ents[i]; body=b[e['off']+16:e['off']+16+e['stored']]
        if body[:4]!=b'RIFF': print(i,'EMPTY'); continue
        parts=[]
        for cid,d in chunks(body):
            if cid==b'LIST': parts.append('LIST['+info_list(d)+']')
            elif cid==b'smpl': parts.append('smpl'+str(smpl(d)))
            elif cid==b'fmt ': 
                f=struct.unpack_from('<HHIIHH',d,0); parts.append(f'fmt{f[2]}/{f[5]}b/{f[1]}ch')
            elif cid==b'data': parts.append(f'data{len(d)}')
        print(i,' '.join(parts))
