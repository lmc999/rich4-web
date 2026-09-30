// 调研脚本：把 .cache/maps/preview/*.svg（map build 预览）用 headless Chrome 截成 PNG（不起服务、不占端口）。
// 用法（仓库根）：node test/maps-svg-shot.mjs [.cache/maps/preview/china.svg ...]
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const dir = '.cache/maps/preview';
const files = args.length > 0 ? args : readdirSync(dir).filter((f) => f.endsWith('.svg')).map((f) => path.join(dir, f));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
for (const f of files) {
  const svg = readFileSync(f, 'utf8');
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">${svg}</body></html>`);
  const el = await page.$('svg');
  const out = f.replace(/\.svg$/, '.png');
  await el.screenshot({ path: out, timeout: 60000, animations: 'disabled' });
  console.log(out);
}
await browser.close();
