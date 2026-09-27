#!/usr/bin/env python3
"""调研：解析 MKF 内每个 RIFF/WAVE 资源的 fmt/data 块，统计格式与时长。只读。"""
import struct, sys, collections, json, os
sys.path.insert(0, os.path.dirname(__file__))
from ar_mkf_survey import open_mkf

def parse_wav(buf):
    if buf[:4]!=b'RIFF' or buf[8:12]!=b'WAVE': return None
    riff_size = struct.unpack_from('<I',buf,4)[0]
    p=12; info={'riffSize':riff_size,'chunks':[]}
    while p+8<=len(buf):
        cid=buf[p:p+4]; sz=struct.unpack_from('<I',buf,p+4)[0]
        info['chunks'].append((cid.decode('latin1'),sz,p))
        if cid==b'fmt ':
            fmt=struct.unpack_from('<HHIIHH',buf,p+8)
            info.update(tag=fmt[0],ch=fmt[1],rate=fmt[2],bps=fmt[3],align=fmt[4],bits=fmt[5])
            if sz>16: info['fmtExtra']=buf[p+24:p+8+sz].hex()
        if cid==b'data':
            info['dataSize']=sz; info['dataOff']=p+8
        p+=8+sz+(sz&1)
    if 'bps' in info and 'dataSize' in info:
        info['dur']=info['dataSize']/info['bps']
    return info

if __name__=='__main__':
    path=sys.argv[1]; out=sys.argv[2] if len(sys.argv)>2 else None
    b,x,n,s,ents=open_mkf(path)
    fmts=collections.Counter(); total=0; rows=[]; nonwav=[]
    for e in ents:
        body=b[e['off']+16:e['off']+16+e['stored']]
        w=parse_wav(body)
        if not w:
            nonwav.append((e['i'],e['stored'],body[:32].hex())); rows.append(dict(i=e['i'],off=e['off'],size=e['stored'],wav=False)); continue
        key=(w.get('tag'),w.get('ch'),w.get('rate'),w.get('bits'),tuple(c[0] for c in w['chunks']))
        fmts[key]+=1; total+=w.get('dur',0)
        mism = w['riffSize']+8 != len(body)
        rows.append(dict(i=e['i'],off=e['off'],size=e['stored'],wav=True,tag=w.get('tag'),ch=w.get('ch'),rate=w.get('rate'),bits=w.get('bits'),dataSize=w.get('dataSize'),dur=round(w.get('dur',0),3),riffMismatch=mism,chunks=[c[0] for c in w['chunks']]))
    print(path,'entries',len(ents))
    for k,v in fmts.most_common(): print(' fmt',k,v)
    print(' total dur s',round(total,1),'min',round(total/60,1))
    durs=[r['dur'] for r in rows if r.get('wav')]
    if durs: print(' dur min/max/avg',min(durs),max(durs),round(sum(durs)/len(durs),3))
    print(' riff size mismatches',sum(1 for r in rows if r.get('riffMismatch')))
    print(' nonwav',len(nonwav))
    for t in nonwav: print('  ',t)
    if out: json.dump(rows,open(out,'w'),ensure_ascii=False,indent=0)
