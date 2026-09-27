# 临时调试：最小 PNG 编码（RGB/RGBA）
import zlib, struct
def write_png(path, w, h, rows_bytes, mode='RGB'):
    ct = 2 if mode=='RGB' else 6
    raw = b''.join(b'\x00'+r for r in rows_bytes)
    def chunk(t, d): return struct.pack('>I',len(d))+t+d+struct.pack('>I', zlib.crc32(t+d)&0xffffffff)
    png = b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR', struct.pack('>IIBBBBB', w,h,8,ct,0,0,0))+chunk(b'IDAT', zlib.compress(raw,6))+chunk(b'IEND',b'')
    open(path,'wb').write(png)
def rgb565(v): return (((v>>11)&31)*255//31, ((v>>5)&63)*255//63, (v&31)*255//31)
def rgb555(v): return (((v>>10)&31)*255//31, ((v>>5)&31)*255//31, (v&31)*255//31)
