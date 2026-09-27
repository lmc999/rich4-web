#!/usr/bin/env python3
"""调研：在 rich4.exe 数据段扫描音效集表 {u32 id, u32 0}* + 0xFFFFFFFF（步长 1），并核对 push imm32 引用。只读。"""
import struct, sys, json
def pe_sections(b):
    pe = struct.unpack_from('<I', b, 0x3c)[0]
    nsec = struct.unpack_from('<H', b, pe+6)[0]; opt = struct.unpack_from('<H', b, pe+20)[0]
    base = struct.unpack_from('<I', b, pe+24+28)[0]
    secs=[]; o = pe+24+opt
    for k in range(nsec):
        name=b[o:o+8].rstrip(b'\0').decode('latin1'); vs,va,rs,ra=struct.unpack_from('<IIII',b,o+8)
        chars=struct.unpack_from('<I',b,o+36)[0]
        secs.append(dict(name=name,va=base+va,vsize=vs,raw=ra,rsize=rs,chars=chars)); o+=40
    return base, secs
def main(path, maxid=114):
    b=open(path,'rb').read(); base,secs=pe_sections(b)
    code=[s for s in secs if s['chars'] & 0x20]
    pushed={}
    for s in code:
        for off in range(s['raw'], s['raw']+s['rsize']-5):
            if b[off]==0x68:
                v=struct.unpack_from('<I',b,off+1)[0]; pushed.setdefault(v,[]).append(s['va']+off-s['raw'])
    tables=[]
    for s in secs:
        if s['chars'] & 0x20: continue
        data=b[s['raw']:s['raw']+s['rsize']]
        for p in range(0, len(data)-4):
            if data[p:p+4]!=b'\xff\xff\xff\xff': continue
            ids=[]; q=p-8
            while q>=0:
                i,z=struct.unpack_from('<II',data,q)
                if z==0 and 0<=i<=maxid: ids.insert(0,i); q-=8
                else: break
            if not ids: continue
            va=s['va']+q+8
            tables.append(dict(va=hex(va),n=len(ids),ids=ids,pushedAt=[hex(x) for x in pushed.get(va,[])][:6]))
    return tables
if __name__=='__main__':
    t=main(sys.argv[1])
    real=[x for x in t if x['pushedAt']]
    for x in t: print(x['va'], x['n'], x['ids'], 'PUSH' if x['pushedAt'] else '-', x['pushedAt'])
    print('tables with push refs:',len(real),'entries',sum(x['n'] for x in real))
    ref=set(i for x in real for i in x['ids'])
    print('ids referenced',len(ref),sorted(ref)); print('unreferenced 0..63:',[i for i in range(64) if i not in ref])
    if len(sys.argv)>2: json.dump(t,open(sys.argv[2],'w'),indent=1)
