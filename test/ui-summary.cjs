// 临时调试：打印目录摘要
const c=require('../.cache/assets-research/ui/catalog-Panel-Data-help-jump.json');
const nm=process.argv[2];
for (const r of c[nm]) {
  let s = r.i+' '+r.kind+(r.comp?'*':'')+' '+r.raw;
  if (r.frames) { const dims={}; for (const f of r.frames){const k=f[0]+'x'+f[1]; dims[k]=(dims[k]||0)+1;} s+=' n='+r.n+' '+Object.entries(dims).slice(0,5).map(([k,v])=>k+(v>1?'×'+v:'')).join(',')+(Object.keys(dims).length>5?',…('+Object.keys(dims).length+'种)':''); }
  if (r.flic) s+=' '+r.flic.w+'x'+r.flic.h+' f='+r.flic.frames+' spd='+r.flic.speed;
  if (r.head && !r.flic) s+=' '+r.head;
  console.log(s);
}
