# 临时调试：解析 map.mkf 地图结构资源（gm*2+1）
import struct, sys
sys.path.insert(0, __file__.rsplit('/',1)[0])
from render_sprites import resource
def big5(bs):
    bs=bs.split(b'\0')[0]
    try: return bs.decode('big5')
    except: return bs.hex()
def parse_map(path, gm):
    d=resource(path, gm*2+1)
    h=struct.unpack_from('<10I',d,0)
    nN,oN,nL,oL,nF,oF,nC,oC,nS,oS=h
    nodes=[None]; lands=[None]; facs=[None]; comps=[None]; lsc=[None]
    for i in range(1,nN+1):
        o=oN+i*0x28; x,y=struct.unpack_from('<hh',d,o)
        adj=struct.unpack_from('<4H',d,o+0x18); typ,decor=struct.unpack_from('<HH',d,o+0x20); fl=struct.unpack_from('<I',d,o+0x24)[0]
        nodes.append(dict(id=i,x=x,y=y,name=big5(d[o+4:o+0x18]),adj=adj,type=typ,decor=decor,flags=fl))
    for i in range(1,nL+1):
        o=oL+i*0x34; x,y=struct.unpack_from('<hh',d,o)
        lands.append(dict(id=i,x=x,y=y,name=big5(d[o+4:o+0x17]),facing=d[o+0x1b],chain=d[o+0x18],owner=d[o+0x19],level=d[o+0x1a]))
    for i in range(1,nF+1):
        o=oF+i*0x38; x,y=struct.unpack_from('<hh',d,o)
        facs.append(dict(id=i,x=x,y=y,name=big5(d[o+4:o+0x18]),kind=d[o+0x18],facing=d[o+0x1b],level=d[o+0x1a]))
    for i in range(1,nC+1):
        o=oC+i*0x34; x,y=struct.unpack_from('<hh',d,o)
        comps.append(dict(id=i,x=x,y=y,name=big5(d[o+4:o+0x18]),facing=d[o+0x1b],sprite=struct.unpack_from('<H',d,o+0x20)[0]))
    for i in range(1,nS+1):
        o=oS+i*0x1c; x,y=struct.unpack_from('<hh',d,o)
        lsc.append(dict(id=i,x=x,y=y,name=big5(d[o+4:o+0x18]),facing=d[o+0x18],b19=d[o+0x19],sprite=struct.unpack_from('<H',d,o+0x1a)[0]))
    return dict(header=h,nodes=nodes,lands=lands,facs=facs,comps=comps,lsc=lsc)
if __name__=='__main__':
    m=parse_map(sys.argv[1], int(sys.argv[2]))
    print(m['header'])
    for k in ['facs','comps','lsc']:
        for r in m[k][1:]: print(k, r)
    for r in m['lands'][1:8]: print('land', r)
    for r in m['nodes'][1:8]: print('node', r)
