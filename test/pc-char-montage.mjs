// 调试（头像映射排查）：把真实素材包里「按角色号取」的各个素材键的首帧按行排成对照表（行 = 角色号 0..11），
// 目视核对每一列是不是同一个人物。输出 .cache/pc/portrait/montage-*.png（含原版素材，不入库）。
// 用法：node test/pc-char-montage.mjs [素材包目录=rich4-assets]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const PACK = resolve(process.argv[2] ?? 'rich4-assets');
const OUT = resolve('.cache/pc/portrait');
const manifest = JSON.parse(readFileSync(join(PACK, 'manifest.json'), 'utf8'));
const NAMES = ['约翰乔', '沙隆巴斯', '忍太郎', '钱夫人', '阿土伯', '莎拉公主', '宫本宝藏', '糖糖', '乌咪', '孙小美', '小丹尼', '金贝贝'];

/** 取一个精灵条目的第 i 帧：{ png 路径, 帧矩形 } */
function frameOf(key, i) {
  const e = manifest.entries[key];
  if (!e?.atlas) return null;
  const name = `${e.frames.base}/${e.frames.start + i}`;
  for (const a of e.atlas) {
    const f = manifest.files[a];
    const atlasPath = join(PACK, f ? f.path : a);
    const atlas = JSON.parse(readFileSync(atlasPath, 'utf8'));
    const fr = atlas.frames[name];
    if (!fr) continue;
    const dir = atlasPath.slice(0, atlasPath.lastIndexOf('/'));
    return { src: `file://${join(dir, atlas.meta.image)}`, ...fr.frame };
  }
  return null;
}

const COLS = [
  ['face72', (c) => frameOf('portrait.face72', c)],
  ...[0, 1, 2, 3, 4, 5, 6].map((i) => [`spk${i}`, (c) => frameOf(`portrait.speaker.${c}`, i)]),
  ['walk', (c) => frameOf(`title.sidewalk.${c}.walk`, 0)],
  ['moto', (c) => frameOf(`title.sidewalk.${c}.moto`, 0)],
  ['car', (c) => frameOf(`title.sidewalk.${c}.car`, 0)],
  ['stand', (c) => frameOf(`char.${c}.stand`, 0)],
  ['bwalk', (c) => frameOf(`char.${c}.walk`, 0)],
  ['dice', (c) => frameOf(`char.${c}.dice`, 0)],
  ['owner', (c) => frameOf('board.ownerMark', c)],
  ['chibi0', (c) => frameOf(`venue.chibi.${c}.0`, 0)],
  ['xicong', (c) => frameOf(`mg.xicong.char.${c}`, 0)],
];

const rows = NAMES.map((n, c) => ({ c, n, cells: COLS.map(([k, f]) => ({ k, f: f(c) })) }));
const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#556;font:12px sans-serif;color:#fff">
<table style="border-collapse:collapse"><tr><th>c</th>${COLS.map(([k]) => `<th>${k}</th>`).join('')}</tr>
${rows
  .map(
    (r) =>
      `<tr><td style="padding:4px;white-space:nowrap">${r.c}<br>${r.n}</td>${r.cells
        .map(({ f }) =>
          f
            ? `<td style="border:1px solid #889;padding:2px;vertical-align:bottom"><div style="width:${Math.min(f.w, 110)}px;height:${Math.min(f.h, 110)}px;overflow:hidden"><div style="width:${f.w}px;height:${f.h}px;background:url('${f.src}') -${f.x}px -${f.y}px;transform:scale(${Math.min(1, 110 / Math.max(f.w, f.h))});transform-origin:0 0"></div></div></td>`
            : '<td>—</td>',
        )
        .join('')}</tr>`,
  )
  .join('\n')}
</table></body>`;
const file = join(OUT, 'montage.html');
writeFileSync(file, html);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 2200, height: 1200 } });
await page.goto(`file://${file}`);
await page.waitForTimeout(1500);
await page.screenshot({ path: join(OUT, 'montage-all.png'), fullPage: true });
await browser.close();
console.log('ok', join(OUT, 'montage-all.png'));
