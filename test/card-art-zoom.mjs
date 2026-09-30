// 调研（出卡插画，只读）：把 card.<k> 放大 2 倍贴在亮绿底上（透明处露绿）。用法：OUT=.cache/card/tmp/zoom.png node test/card-art-zoom.mjs 10 17 18
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
const m = JSON.parse(readFileSync('rich4-assets/manifest.json','utf8'));
const ids = process.argv.slice(2).map(Number);
const S = 2, W=165, H=256, G=6;
const out = new PNG({ width: ids.length*(W*S+G)+G, height: H*S+2*G });
for (let i=0;i<out.data.length;i+=4) out.data.set([0,255,0,255],i);
ids.forEach((k,j)=>{
  const png = PNG.sync.read(readFileSync('rich4-assets/'+m.files[m.entries['card.'+k].file].path));
  for (let y=0;y<H*S;y++) for (let x=0;x<W*S;x++){
    const si=((y/S|0)*W+(x/S|0))*4; if(png.data[si+3]===0) continue;
    const di=((G+y)*out.width+G+j*(W*S+G)+x)*4; out.data.set([png.data[si],png.data[si+1],png.data[si+2],255],di);
  }
});
writeFileSync(process.env.OUT, PNG.sync.write(out));
