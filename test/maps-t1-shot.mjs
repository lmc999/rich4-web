// T1 调试脚本：把 map build 的预览 SVG（.cache/extract/preview/<key>.svg）右栏网格截成 PNG，可按网格坐标放大局部。
// 用法（仓库根）：node test/maps-t1-shot.mjs <key> [x0,y0,x1,y1 ...]   （网格坐标，不是格点坐标）
// 输出：.cache/maps/t1/preview/<key>-grid.png 与 <key>-<x0>_<y0>.png（不起服务、不占端口）
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const [key, ...regions] = process.argv.slice(2);
const svg = readFileSync(`.cache/extract/preview/${key}.svg`, 'utf8');
const def = JSON.parse(readFileSync(`.cache/extract/maps/${key}.map.json`, 'utf8'));
const PANEL = 620;
const PAD = 24;
const HEADER = 56;
const cs = Math.max(4, Math.floor(PANEL / Math.max(def.grid.w, def.grid.h)));
const gx0 = PAD * 2 + PANEL;
const gy0 = HEADER + PAD;
const outDir = '.cache/maps/t1/preview';
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const shot = async (clip, scale, out) => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: scale });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">${svg}</body></html>`);
  await page.screenshot({ path: out, clip, timeout: 60000 });
  await page.close();
  console.log(out);
};
await shot({ x: gx0, y: gy0, width: def.grid.w * cs, height: def.grid.h * cs }, 2, `${outDir}/${key}-grid.png`);
for (const r of regions) {
  const [x0, y0, x1, y1] = r.split(',').map(Number);
  await shot(
    { x: gx0 + x0 * cs, y: gy0 + y0 * cs, width: (x1 - x0 + 1) * cs, height: (y1 - y0 + 1) * cs },
    5,
    `${outDir}/${key}-${x0}_${y0}.png`,
  );
}
await browser.close();
