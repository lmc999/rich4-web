// 调试：把一个目录下的编号截图（01-xxx.png …）按网格拼成一张 montage.png（每格下方标文件名），用本机 Chrome 渲染。
// 用法：node test/pc-montage.mjs <目录> [列数=3] [每格宽=640]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [, , dir, colsArg = '3', cellArg = '640'] = process.argv;
const cols = Number(colsArg);
const cell = Number(cellArg);
const files = readdirSync(dir)
  .filter((f) => /^\d+-.*\.png$/.test(f))
  .sort();
const figs = files
  .map(
    (f) =>
      `<figure><img src="data:image/png;base64,${readFileSync(join(dir, f)).toString('base64')}"><figcaption>${f}</figcaption></figure>`,
  )
  .join('');
const html = `<!doctype html><style>
body{margin:0;background:#222;font:14px sans-serif;color:#eee}
main{display:grid;grid-template-columns:repeat(${cols},${cell}px);gap:6px;padding:6px;width:max-content}
figure{margin:0}img{width:${cell}px;display:block}figcaption{padding:2px 4px}
</style><main>${figs}</main>`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: cols * (cell + 6) + 6, height: 400 } });
await page.setContent(html);
await page.locator('main').screenshot({ path: join(dir, 'montage.png') });
await browser.close();
console.log(join(dir, 'montage.png'), files.length);
