# 临时调试：MKF 私有压缩（自适应哈夫曼 + LZ77，LSB-first）的自写实现，依据 docs/research/g_map.md §6.3 伪代码
NCHAR=321; T=641; R=640
def _tables():
    LEN=[0]*256; HI=[0]*256
    for v in range(256):
        blk=v>>4; lo=v&15
        if lo==0: LEN[v]=8; HI[v]=63-blk
        elif lo in (7,15): LEN[v]=3; HI[v]=0
        elif lo in (3,11,13): LEN[v]=4; HI[v]=3-{3:0,11:1,13:2}[lo]
        elif lo in (1,5,9,14): LEN[v]=5; HI[v]=11-4*(blk%2)-{1:0,5:1,9:2,14:3}[lo]
        elif lo in (2,6,10): LEN[v]=6; HI[v]=23-3*(blk%4)-{2:0,6:1,10:2}[lo]
        elif lo in (4,8,12): LEN[v]=7; HI[v]=47-3*(blk%8)-{4:0,8:1,12:2}[lo]
        else: raise Exception(lo)
    return LEN,HI
LEN,HI=_tables()
def decompress(src, size):
    freq=[0]*(T+1); son=[0]*T; prnt=[0]*(T+NCHAR+1)
    for i in range(NCHAR): freq[i]=1
    for j in range(NCHAR,T): freq[j]=freq[2*(j-NCHAR)]+freq[2*(j-NCHAR)+1]
    freq[T]=0xFFFF
    for i in range(NCHAR): son[i]=(i+T)*2
    for k in range(T-NCHAR): son[NCHAR+k]=(2*k)*2
    for i in range(640): prnt[i]=(NCHAR+i//2)*2
    prnt[640]=0
    for s in range(NCHAR): prnt[T+s]=s*2
    prnt[962]=0
    nbits=len(src)*8
    pos=0
    def bit(p):
        return (src[p>>3]>>(p&7))&1 if p<nbits else 0
    def bump(s):
        e=prnt[T+s]//2
        while True:
            freq[e]+=1; a=freq[e]
            if a<=freq[e+1]:
                e=prnt[e]//2
                if e==0: return
                continue
            l=e+1
            while freq[l]==a-1: l+=1
            l-=1
            freq[e],freq[l]=freq[l],freq[e]
            i=son[e]; j=son[l]
            prnt[j//2]=e*2
            if j<0x502: prnt[j//2+1]=e*2
            prnt[i//2]=l*2
            if i<0x502: prnt[i//2+1]=l*2
            son[e]=j; son[l]=i
            e=prnt[l]//2
            if e==0: return
    def rescale():
        for s in range(NCHAR):
            if freq[prnt[T+s]//2]&1: bump(s)
        for k in range(T): freq[k]>>=1
    out=bytearray()
    while len(out)<size:
        n=640
        while True:
            c=son[n]//2
            if c>=T: break
            c+=bit(pos); pos+=1; n=c
        s=c-T
        if freq[640]==0x8000: rescale()
        bump(s)
        if s<256: out.append(s); continue
        bv=0
        for k in range(8): bv|=bit(pos+k)<<k
        L=LEN[bv]; hi=HI[bv]
        lo6=0
        for k in range(6): lo6|=bit(pos+L+k)<<k
        dist=(hi<<6)|lo6; pos+=L+6
        if dist==0xFFF: break
        n2=min(s-253, size-len(out)); p=len(out)-1-dist
        for _ in range(n2): out.append(out[p]); p+=1
    return bytes(out)
