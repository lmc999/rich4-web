# 临时调试：列出 MKF 资源（只读原版文件）
import struct, sys
def load(path):
    b = open(path,'rb').read()
    x = struct.unpack_from('<I', b, 0)[0]
    n = (len(b)-x)//4
    starts = list(struct.unpack_from('<%dI'%n, b, x))
    ents=[]
    for i in range(n):
        off=starts[i]; nxt = starts[i+1] if i+1<n else x
        if off==x: break
        raw,st,io,isz = struct.unpack_from('<4I', b, off)
        body=b[off+16:off+16+st]
        ents.append(dict(i=i,off=off,raw=raw,stored=st,imgOff=io,imgSize=isz,magic=body[:4],gap=nxt-(off+16+st)))
    return b, ents
if __name__=='__main__':
    b,ents = load(sys.argv[1])
    for e in ents[: int(sys.argv[2]) if len(sys.argv)>2 else 9999]:
        print(e['i'], e['off'], e['raw'], e['stored'], e['imgOff'], e['imgSize'], e['magic'], 'C' if e['raw']!=e['stored'] else '', e['gap'])
