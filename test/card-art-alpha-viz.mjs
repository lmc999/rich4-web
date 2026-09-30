// 调研（出卡插画，只读）：把 card.<k> 放大 3 倍画出透明像素（绿）与不透明纯黑像素（红），看泛洪透明掏到了哪里。
// 用法：OUT=.cache/card/tmp/alpha.png node test/card-art-alpha-viz.mjs 1 10
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
const m = JSON.parse(readFileSync('rich4-assets/manifest.json','utf8'));
const ids = process.argv.slice(2).map(Number);
const S = 3, W=165, H=256, G=6;
const out = new PNG({ width: ids.length*(W*S+G)+G, height: H*S+2*G });
for (let i=0;i<out.data.length;i+=4) out.data.set([80,80,80,255],i);
ids.forEach((k,j)=>{
  const png = PNG.sync.read(readFileSync('rich4-assets/'+m.files[m.entries['card.'+k].file].path));
  for (let y=0;y<H*S;y++) for (let x=0;x<W*S;x++){
    const si=((y/S|0)*W+(x/S|0))*4; const a=png.data[si+3];
    const di=((G+y)*out.width+G+j*(W*S+G)+x)*4;
    if(a===0) out.data.set([0,255,0,255],di); else {
      const r=png.data[si],g=png.data[si+1],b=png.data[si+2];
      out.data.set((r|g|b)===0?[255,0,0,255]:[r,g,b,255],di);
    }
  }
});
writeFileSync(process.env.OUT, PNG.sync.write(out));
