# 临时调试：解 SPR/SMP 精灵库并拼成联系表 PNG（只读原版文件，输出到 .cache/assets-research）
import struct, sys
sys.path.insert(0, __file__.rsplit('/',1)[0])
from render_mkf_list import load
from render_lzhuf import decompress
from render_png import write_png, rgb555
_cache={}
def resource(path, i):
    key=(path,i)
    if key in _cache: return _cache[key]
    if path not in _cache: _cache[path]=load(path)
    b,ents=_cache[path]
    e=ents[i]; body=b[e['off']+16:e['off']+16+e['stored']]
    d = body if e['raw']==e['stored'] else decompress(body, e['raw'])
    _cache[key]=d
    return d
def parse_lib(d):
    sig,n,start=struct.unpack_from('<4sII',d,0)
    sig=sig[:3].decode()
    frames=[]; off = start + (512 if sig=='SPR' else 0)
    pal = struct.unpack_from('<256H', d, start) if sig=='SPR' else None
    for k in range(n):
        w,h,ax,ay,gs=struct.unpack_from('<HHhhI',d,12+k*12)
        frames.append(dict(w=w,h=h,ax=ax,ay=ay,off=off,size=gs)); off+=gs
    assert off==len(d), (off,len(d))
    return sig, frames, pal
def frame_rgba(d, sig, f, pal, recolor=None):
    w,h=f['w'],f['h']; out=bytearray(w*h*4)
    if sig=='SPR':
        P=[rgb555(v) for v in pal]
        if recolor is not None: P[255]=recolor
        for i in range(w*h):
            c=d[f['off']+i]
            if c: out[i*4:i*4+4]=bytes(P[c])+b'\xff'
    else:
        for i in range(w*h):
            v=struct.unpack_from('<H',d,f['off']+2*i)[0]
            if v: out[i*4:i*4+4]=bytes(rgb555(v))+b'\xff'
    return out
def sheet(path, i, outpng, bg=(40,40,48)):
    d=resource(path,i); sig,frames,pal=parse_lib(d)
    pad=4; W=sum(f['w']+pad for f in frames)+pad; H=max(f['h'] for f in frames)+2*pad
    img=bytearray(bytes(bg)+b'\xff')*(W*H)
    x=pad
    for f in frames:
        px=frame_rgba(d,sig,f,pal)
        for yy in range(f['h']):
            for xx in range(f['w']):
                a=px[(yy*f['w']+xx)*4+3]
                if a: 
                    o=((yy+pad)*W+x+xx)*4; img[o:o+4]=px[(yy*f['w']+xx)*4:(yy*f['w']+xx)*4+4]
        # anchor cross (red)
        cx,cy=x+f['ax'],pad+f['ay']
        for t in range(-2,3):
            for (qx,qy) in [(cx+t,cy),(cx,cy+t)]:
                if 0<=qx<W and 0<=qy<H: o=(qy*W+qx)*4; img[o:o+4]=b'\xff\x00\x00\xff'
        x+=f['w']+pad
    write_png(outpng, W, H, [bytes(img[r*W*4:(r+1)*W*4]) for r in range(H)], mode='RGBA')
    return sig,len(frames)
if __name__=='__main__':
    path=sys.argv[1]; out=sys.argv[2]
    for s in sys.argv[3:]:
        i=int(s,0); print(i, sheet(path,i,f'{out}/res{i:03d}.png'))
