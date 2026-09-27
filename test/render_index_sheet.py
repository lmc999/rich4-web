# 临时调试：把一个 MKF 中一段资源的第 0 帧拼成索引图（每行 10 个，格 180x170，缩放到格内）
import sys
sys.path.insert(0, __file__.rsplit('/',1)[0])
from render_sprites import resource, parse_lib, frame_rgba
from render_png import write_png
path=sys.argv[1]; out=sys.argv[2]; a=int(sys.argv[3]); b=int(sys.argv[4]); fi=int(sys.argv[5]) if len(sys.argv)>5 else 0
CW,CH,COLS=180,170,10
ids=list(range(a,b+1)); rows=(len(ids)+COLS-1)//COLS
W,H=CW*COLS,CH*rows
img=bytearray(b'\x28\x28\x30\xff')*(W*H)
for n,i in enumerate(ids):
    try:
        d=resource(path,i); sig,frames,pal=parse_lib(d)
    except Exception as ex:
        continue
    f=frames[min(fi,len(frames)-1)]
    px=frame_rgba(d,sig,f,pal)
    s=max(1, max((f['w']+CW-1)//CW, (f['h']+CH-1)//CH))
    ox=(n%COLS)*CW; oy=(n//COLS)*CH
    for yy in range(0,f['h'],s):
        for xx in range(0,f['w'],s):
            p=(yy*f['w']+xx)*4
            if px[p+3]:
                X=ox+xx//s; Y=oy+yy//s
                if X<ox+CW and Y<oy+CH: o=(Y*W+X)*4; img[o:o+4]=px[p:p+4]
    # grid border
    for X in range(ox,ox+CW): o=(oy*W+X)*4; img[o:o+4]=b'\x60\x60\x60\xff'
    for Y in range(oy,oy+CH): o=(Y*W+ox)*4; img[o:o+4]=b'\x60\x60\x60\xff'
write_png(out,W,H,[bytes(img[r*W*4:(r+1)*W*4]) for r in range(H)],mode='RGBA')
print('ids',a,b,'rows',rows)
