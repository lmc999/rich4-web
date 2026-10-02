// 调试脚本（T2 真实出包）：把真实素材包里按地图的素材拼成几张联系表，供逐图目视，输出到 .cache/maps/assets/（已 gitignore）。
//   <id>-board.png    assets preview 的棋盘渲染拼图（行 = 镜头，列 = 视角 v0/v1/v2/v5）
//   <id>-houses.png   小地图 + 住宅 1–5 级 × 4 种主人色（帧 0 与帧 2）
//   <id>-sprites.png  该图用到的企业/景观精灵（帧 0，左上角 = 资源号；黄框 = 共用分组 board.landmarks）
//   <id>-ground.png   地面 2×2 切片按世界坐标拼回，1/4 缩小
//   holiday.png       节日插画四行（gm0–3），每格左上 = 键号 illustration.holiday.<n>，右下 = Data# 资源号
//   setup-bg.png      开局设置背景 jump#0–3（2×2）
//   fly.png           video.fly* 四段各取 1/2 处一帧（需要 ffmpeg）
// 用法：npx tsx test/maps-t2-contact.ts [素材包目录，默认 rich4-assets] [输出目录，默认 .cache/maps/assets]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spriteFrameName } from '../packages/shared/src/assets';
import { encodePngRgba } from '../tools/extract/src/gfx/png';
import { readPng } from '../tools/extract/src/assets/pngRead';

type Img = { w: number; h: number; rgba: Uint8Array };
const packDir = process.argv[2] ?? 'rich4-assets';
const outDir = process.argv[3] ?? path.join('.cache', 'maps', 'assets');
const previewDir = path.join('.cache', 'assets-preview');
mkdirSync(outDir, { recursive: true });
const m = JSON.parse(readFileSync(path.join(packDir, 'manifest.json'), 'utf8'));

const canvas = (w: number, h: number, rgb = [40, 40, 48]): Img => {
  const img = { w, h, rgba: new Uint8Array(w * h * 4) };
  fill(img, 0, 0, w, h, rgb);
  return img;
};
function fill(img: Img, x0: number, y0: number, w: number, h: number, rgb: readonly number[]): void {
  for (let y = Math.max(0, y0); y < Math.min(img.h, y0 + h); y++)
    for (let x = Math.max(0, x0); x < Math.min(img.w, x0 + w); x++) {
      const o = (y * img.w + x) * 4;
      img.rgba[o] = rgb[0]!;
      img.rgba[o + 1] = rgb[1]!;
      img.rgba[o + 2] = rgb[2]!;
      img.rgba[o + 3] = 255;
    }
}
function frame(img: Img, x0: number, y0: number, w: number, h: number, rgb: readonly number[]): void {
  fill(img, x0, y0, w, 1, rgb);
  fill(img, x0, y0 + h - 1, w, 1, rgb);
  fill(img, x0, y0, 1, h, rgb);
  fill(img, x0 + w - 1, y0, 1, h, rgb);
}
/** 源矩形按 alpha 叠加到 dst，缩小因子 k（最近邻，可为小数） */
function blit(dst: Img, src: Img, sx: number, sy: number, sw: number, sh: number, dx0: number, dy0: number, k = 1): void {
  // 目标坐标取整：小数下标写不进 Uint8Array
  const dx = Math.floor(dx0);
  const dy = Math.floor(dy0);
  const w = Math.floor(sw / k);
  const h = Math.floor(sh / k);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const X = dx + x;
      const Y = dy + y;
      if (X < 0 || Y < 0 || X >= dst.w || Y >= dst.h) continue;
      const so = ((sy + Math.floor(y * k)) * src.w + sx + Math.floor(x * k)) * 4;
      const a = src.rgba[so + 3]!;
      if (a === 0) continue;
      const o = (Y * dst.w + X) * 4;
      for (let c = 0; c < 3; c++) dst.rgba[o + c] = Math.trunc((src.rgba[so + c]! * a + dst.rgba[o + c]! * (255 - a)) / 255);
      dst.rgba[o + 3] = 255;
    }
}
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];
function num(img: Img, n: number | string, x0: number, y0: number, rgb: readonly number[] = [255, 255, 255], bg = true): void {
  const s = String(n);
  if (bg) fill(img, x0 - 1, y0 - 1, s.length * 8 + 1, 12, [0, 0, 0]);
  for (let i = 0; i < s.length; i++) {
    const d = DIGITS[s.charCodeAt(i) - 48];
    if (!d) continue;
    for (let p = 0; p < 15; p++) if (d[p] === '1') fill(img, x0 + i * 8 + (p % 3) * 2, y0 + Math.trunc(p / 3) * 2, 2, 2, rgb);
  }
}
const pngCache = new Map<string, Img>();
function filePng(p: string): Img {
  const hit = pngCache.get(p);
  if (hit) return hit;
  const r = readPng(new Uint8Array(readFileSync(p)), p);
  const img = { w: r.w, h: r.h, rgba: r.rgba };
  pngCache.set(p, img);
  return img;
}
const packPath = (lp: string) => path.join(packDir, ...m.files[lp].path.split('/'));
const packPng = (lp: string) => filePng(packPath(lp));
function save(name: string, img: Img): void {
  const p = path.join(outDir, name);
  writeFileSync(p, encodePngRgba(img.w, img.h, img.rgba));
  console.log(`写出 ${p}（${img.w}×${img.h}）`);
}

/** 精灵第 i 帧：页位图、帧矩形、锚点、主人色掩码页 */
function spriteFrame(key: string, i: number) {
  const e = m.entries[key];
  if (e?.type !== 'sprite') return null;
  const name = spriteFrameName(e.frames.base, e.frames.start + i);
  for (const lp of e.atlas as string[]) {
    const a = JSON.parse(readFileSync(packPath(lp), 'utf8'));
    const fr = a.frames[name];
    if (!fr) continue;
    const dir = m.files[lp].path.slice(0, m.files[lp].path.lastIndexOf('/') + 1);
    const lpOf = (file: string) => Object.keys(m.files).find((k) => m.files[k].path === `${dir}${file}`);
    const page = packPng(lpOf(a.meta.image)!);
    const maskLp = a.meta.r4.mask ? lpOf(a.meta.r4.mask) : undefined;
    const [ax, ay] = a.meta.r4.anchorsPx[name];
    return { ...fr.frame, ax, ay, page, mask: e.ownerMask && maskLp ? packPng(maskLp) : null };
  }
  return null;
}
function drawSprite(dst: Img, key: string, i: number, x0: number, y0: number, tint: readonly number[] | null): { w: number; h: number } {
  const x = Math.floor(x0);
  const y = Math.floor(y0);
  const f = spriteFrame(key, i);
  if (!f) return { w: 0, h: 0 };
  blit(dst, f.page, f.x, f.y, f.w, f.h, x, y);
  if (tint && f.mask)
    for (let yy = 0; yy < f.h; yy++)
      for (let xx = 0; xx < f.w; xx++) if (f.mask.rgba[((f.y + yy) * f.mask.w + f.x + xx) * 4]! >= 128) fill(dst, x + xx, y + yy, 1, 1, tint);
  return { w: f.w, h: f.h };
}

const TINTS = [
  [230, 40, 40],
  [40, 90, 230],
  [40, 180, 60],
  [230, 190, 30],
];
const MAPS = Object.keys(m.maps);
const SHARED = new Set([75, 80, 82, 84, 87, 132, 144]);

for (const id of MAPS) {
  // 棋盘渲染拼图
  const cams = id === 'taiwan' ? ['center', 'taipei', 'greenisland'] : ['center', 'hospital', 'jail', ...(id === 'japan' ? ['boat'] : [])];
  const views = [0, 1, 2, 5];
  const board = canvas(views.length * 444, cams.length * 444);
  cams.forEach((c, r) =>
    views.forEach((v, col) => {
      const src = filePng(path.join(previewDir, 'board', `${id}_v${v}_${c}.png`));
      blit(board, src, 0, 0, src.w, src.h, col * 444 + 2, r * 444 + 2);
    }),
  );
  save(`${id}-board.png`, board);

  // 小地图 + 住宅五级 × 四主人色
  // 小地图是 2 帧精灵（map#8+gm），两帧并排
  const m0 = spriteFrame(`map.${id}.minimap`, 0);
  const m1 = spriteFrame(`map.${id}.minimap`, 1);
  const mini = { w: (m0?.w ?? 0) + (m1?.w ?? 0) + 8, h: Math.max(m0?.h ?? 0, m1?.h ?? 0) };
  const cell = 90;
  const houses = canvas(Math.max(mini.w + 8, 8 * cell + 8), mini.h + 12 + 5 * cell + 8, [96, 120, 80]);
  drawSprite(houses, `map.${id}.minimap`, 0, 4, 4, null);
  drawSprite(houses, `map.${id}.minimap`, 1, 12 + (m0?.w ?? 0), 4, null);
  for (let L = 1; L <= 5; L++)
    for (let t = 0; t < 4; t++)
      for (const [fi, fr] of [0, 2].entries()) {
        const f = spriteFrame(`map.${id}.house.${L}`, fr);
        const x = 4 + (t * 2 + fi) * cell;
        const y = mini.h + 12 + (L - 1) * cell;
        if (f) drawSprite(houses, `map.${id}.house.${L}`, fr, x + (cell - f.w) / 2, y + (cell - f.h) / 2, TINTS[t]!);
        if (t === 0 && fi === 0) num(houses, L, x + 1, y + 1);
      }
  save(`${id}-houses.png`, houses);

  // 企业/景观精灵
  const skinLp = m.maps[id].skin;
  const skin = JSON.parse(readFileSync(packPath(skinLp), 'utf8'));
  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string' && /^board\.landmark\.\d+$/.test(v)) keys.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(skin);
  const list = [...keys].sort((a, b) => Number(a.split('.')[2]) - Number(b.split('.')[2]));
  const fr = list.map((k) => spriteFrame(k, 0));
  const cw = Math.min(260, Math.max(...fr.map((f) => f?.w ?? 0)) + 8);
  const chh = Math.min(260, Math.max(...fr.map((f) => f?.h ?? 0)) + 16);
  const cols = 6;
  const sprites = canvas(cols * cw, Math.ceil(list.length / cols) * chh, [96, 120, 80]);
  list.forEach((k, i) => {
    const x = (i % cols) * cw;
    const y = Math.trunc(i / cols) * chh;
    const f = fr[i];
    const res = Number(k.split('.')[2]);
    if (f) {
      const k2 = Math.max(1, Math.max(f.w / (cw - 8), f.h / (chh - 16)));
      blit(sprites, f.page, f.x, f.y, f.w, f.h, x + 4, y + 14, k2);
    }
    if (SHARED.has(res)) frame(sprites, x + 1, y + 1, cw - 2, chh - 2, [255, 220, 0]);
    num(sprites, res, x + 3, y + 3);
  });
  save(`${id}-sprites.png`, sprites);

  // 地面拼回
  const chunks = skin.ground.chunks as { file: string; x: number; y: number; w: number; h: number }[];
  const W = Math.max(...chunks.map((c) => c.x + c.w));
  const H = Math.max(...chunks.map((c) => c.y + c.h));
  const k = 4;
  const ground = canvas(Math.ceil(W / k), Math.ceil(H / k));
  for (const c of chunks) {
    const img = packPng(c.file);
    blit(ground, img, 0, 0, img.w, img.h, Math.floor(c.x / k), Math.floor(c.y / k), k);
  }
  save(`${id}-ground.png`, ground);
  console.log(`  ${id} 地面 ${chunks.length} 块，世界 ${W}×${H}；精灵 ${list.length} 个：${list.map((s) => s.split('.')[2]).join(',')}`);
}

// 节日插画
const base = [4, 28, 47, 67];
const cnt = [24, 19, 19, 20];
const off = [0, 24, 43, 63];
const T = 100;
const hol = canvas(24 * (T + 4) + 4, 4 * (T + 4) + 4);
for (let gm = 0; gm < 4; gm++)
  for (let s = 0; s < cnt[gm]!; s++) {
    const key = `illustration.holiday.${off[gm]! + s}`;
    const e = m.entries[key];
    const x = 4 + s * (T + 4);
    const y = 4 + gm * (T + 4);
    if (!e) {
      fill(hol, x, y, T, T, [200, 0, 0]);
      continue;
    }
    const img = packPng(e.file);
    blit(hol, img, 0, 0, img.w, img.h, x, y, img.w / T);
    num(hol, off[gm]! + s, x + 2, y + 2);
    const src = Number(String(e.src[0]).replace('Data#', ''));
    num(hol, src, x + T - String(src).length * 8 - 2, y + T - 12, src === base[gm]! + s ? [120, 255, 120] : [255, 60, 60]);
  }
save('holiday.png', hol);

// 开局设置背景
const bg = canvas(2 * 644, 2 * 484);
['title.setup.bg', 'title.setup.bg.china', 'title.setup.bg.japan', 'title.setup.bg.usa'].forEach((k, i) => {
  const img = packPng(m.entries[k].file);
  blit(bg, img, 0, 0, img.w, img.h, (i % 2) * 644 + 2, Math.trunc(i / 2) * 484 + 2);
  num(bg, i, (i % 2) * 644 + 6, Math.trunc(i / 2) * 484 + 6);
});
save('setup-bg.png', bg);

// 飞行动画各取一帧
const flys = ['video.flytw', 'video.flychina', 'video.flyjp', 'video.flyus'];
const tmp = path.join(outDir, 'fly-tmp');
mkdirSync(tmp, { recursive: true });
const flyImg = canvas(2 * 644, 2 * 484);
flys.forEach((k, i) => {
  const e = m.entries[k];
  const mp4 = packPath(e.files.mp4);
  const png = path.join(tmp, `${i}.png`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(e.durationMs / 2000), '-i', mp4, '-frames:v', '1', '-pix_fmt', 'rgba', png]);
  const img = filePng(png);
  blit(flyImg, img, 0, 0, img.w, img.h, (i % 2) * 644 + 2, Math.trunc(i / 2) * 484 + 2);
  num(flyImg, i, (i % 2) * 644 + 6, Math.trunc(i / 2) * 484 + 6);
});
rmSync(tmp, { recursive: true, force: true });
save('fly.png', flyImg);
