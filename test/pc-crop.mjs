// 调试：从若干截图里裁出指定矩形竖排拼成一张（看细节用）。用法：node test/pc-crop.mjs <输出.png> <文件:x,y,w,h> …
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
const [, , out, ...specs] = process.argv; // spec: file:x,y,w,h
const items = specs.map((s) => {
  const [f, r] = s.split(':');
  const [x, y, w, h] = r.split(',').map(Number);
  return { f, x, y, w, h };
});
const html = `<!doctype html><style>body{margin:0;background:#222;color:#eee;font:12px sans-serif}main{display:flex;flex-direction:column;gap:6px;padding:6px;width:max-content}div.c{position:relative;overflow:hidden}img{position:absolute}</style><main>${items
  .map(
    (it) =>
      `<div>${it.f.split('/').pop()}</div><div class="c" style="width:${it.w}px;height:${it.h}px"><img src="data:image/png;base64,${readFileSync(it.f).toString('base64')}" style="left:${-it.x}px;top:${-it.y}px"></div>`,
  )
  .join('')}</main>`;
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await b.newPage({ viewport: { width: 2000, height: 400 } });
await p.setContent(html);
await p.locator('main').screenshot({ path: out });
await b.close();
