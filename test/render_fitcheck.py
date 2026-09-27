# 临时调试：投影表的仿射（带常数项）与单应（透视）拟合误差对比，纯 python 最小二乘
import json
d=json.load(open('.cache/extract/tables.v206.json'))['view']['cellScreen']['data']
def solve(M,b):
    n=len(b); A=[row[:]+[b[i]] for i,row in enumerate(M)]
    for c in range(n):
        p=max(range(c,n),key=lambda r:abs(A[r][c])); A[c],A[p]=A[p],A[c]
        for r in range(n):
            if r!=c:
                f=A[r][c]/A[c][c]
                for k in range(c,n+1): A[r][k]-=f*A[c][k]
    return [A[i][n]/A[i][i] for i in range(n)]
def lstsq(rows,b):
    n=len(rows[0]); M=[[sum(r[i]*r[j] for r in rows) for j in range(n)] for i in range(n)]
    v=[sum(r[i]*bb for r,bb in zip(rows,b)) for i in range(n)]
    return solve(M,v)
for v in range(8):
    pts=[]
    for dy in range(-14,15):
        for dx in range(-14,15):
            sy,sx=d[v][(dy+14)*29+(dx+14)]; pts.append((dx,dy,sx,sy))
    rows=[];b=[]
    for x,y,u,w in pts:
        rows.append([x,y,1,0,0,0,-u*x,-u*y]); b.append(u)
        rows.append([0,0,0,x,y,1,-w*x,-w*y]); b.append(w)
    h=lstsq(rows,b)
    # refine: iterate reweighted (Gauss-Newton skipped); report errors
    errs=[]
    for x,y,u,w in pts:
        den=h[6]*x+h[7]*y+1; pu=(h[0]*x+h[1]*y+h[2])/den; pw=(h[3]*x+h[4]*y+h[5])/den
        errs.append(max(abs(pu-u),abs(pw-w)))
    rows2=[];b2=[]
    for x,y,u,w in pts:
        rows2.append([x,y,1,0,0,0]);b2.append(u);rows2.append([0,0,0,x,y,1]);b2.append(w)
    g=lstsq(rows2,b2)
    e2=[max(abs(g[0]*x+g[1]*y+g[2]-u),abs(g[3]*x+g[4]*y+g[5]-w)) for x,y,u,w in pts]
    print(v,'homography max %.2f mean %.2f h31 %.5f h32 %.5f'%(max(errs),sum(errs)/len(errs),h[6],h[7]),'| affine+offset max %.2f mean %.2f offset (%.2f,%.2f)'%(max(e2),sum(e2)/len(e2),g[2],g[5]))

# 输出仿射+常数项拟合参数（屏幕 = base + a*dx + b*dy + o，dx/dy 为格差；世界单位时再 /32）
import math
out=[]
for v in range(8):
    pts=[]
    for dy in range(-14,15):
        for dx in range(-14,15):
            sy,sx=d[v][(dy+14)*29+(dx+14)]; pts.append((dx,dy,sx,sy))
    rows2=[];b2=[]
    for x,y,u,w in pts:
        rows2.append([x,y,1,0,0,0]);b2.append(u);rows2.append([0,0,0,x,y,1]);b2.append(w)
    g=lstsq(rows2,b2)
    e2=[max(abs(g[0]*x+g[1]*y+g[2]-u),abs(g[3]*x+g[4]*y+g[5]-w)) for x,y,u,w in pts]
    s=math.hypot(g[0],g[1]); th=math.degrees(math.atan2(-g[1],g[0])); k=math.hypot(g[3],g[4])/s
    out.append(dict(view=v,sx=dict(dx=round(g[0],4),dy=round(g[1],4),c=round(g[2],3)),sy=dict(dx=round(g[3],4),dy=round(g[4],4),c=round(g[5],3)),
                    maxErrPx=round(max(e2),3),meanErrPx=round(sum(e2)/len(e2),3),scalePxPerCell=round(s,3),thetaDeg=round(th,2),vertSquash=round(k,4)))
json.dump(dict(note='v2.06 投影表 0x46ab9c 的仿射拟合；表项存储为 (sy,sx)，外层 dy；单应拟合的透视项 |h31|,|h32|<2e-5，故为仿射+取整噪声',views=out),
          open('.cache/assets-research/render/projection-fit.v206.json','w'),ensure_ascii=False,indent=1)
print('written')
