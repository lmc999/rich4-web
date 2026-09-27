#!/usr/bin/env python3
"""调研：列出 MKF 资源头统计（压缩/大小/首字节签名）。只读。"""
import struct, sys, collections, json
def open_mkf(path):
    b = open(path,'rb').read()
    x = struct.unpack_from('<I', b, 0)[0]
    n = (len(b)-x)//4
    starts = list(struct.unpack_from('<%dI'%n, b, x))
    sentinel = starts[-1] == x
    cnt = n-1 if sentinel else n
    ents=[]
    for i in range(cnt):
        off = starts[i]; nxt = starts[i+1] if i+1<n else x
        raw, st, io, isz = struct.unpack_from('<4I', b, off)
        ents.append(dict(i=i, off=off, raw=raw, stored=st, imgOff=io, imgSize=isz, gap=nxt-(off+16+st), head=b[off+16:off+16+16].hex()))
    return b, x, n, sentinel, ents
if __name__=='__main__':
    p=sys.argv[1]
    b,x,n,s,ents=open_mkf(p)
    print(p, 'size',len(b),'X',x,'n',n,'sentinel',s,'count',len(ents))
    comp=sum(1 for e in ents if e['raw']!=e['stored'])
    print('compressed',comp,'img',sum(1 for e in ents if e['imgSize']))
    heads=collections.Counter(e['head'][:8] for e in ents)
    print('head4 top', heads.most_common(10))
    for e in ents[:int(sys.argv[2]) if len(sys.argv)>2 else 5]:
        print(e)
