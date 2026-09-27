/** 临时调试：角色 8 向帧 vs 世界方向（视角 0/2），检验帧号公式 ((8 − view + dir) & 7) 与 dir 编码 */
import { Canvas, Mkf, parseLib } from './render-lib';
import { readFileSync } from 'node:fs';
const ROOT = new URL('..', import.meta.url).pathname;
const data = new Mkf(`${ROOT}original/Game/Data.mkf`);
const map = new Mkf(`${ROOT}original/Game/map.mkf`);
const V = JSON.parse(readFileSync(`${ROOT}.cache/extract/tables.v206.json`, 'utf8')).view;
const walk = parseLib(data.get(88)); // 角色 0 走姿 72 帧 = 8 向 × 9
const house = parseLib(map.get(29)); // 台湾 3 级房
for (const view of [0, 2]) {
  const cv = new Canvas(560, 300, [60, 90, 60]);
  const T = (dx: number, dy: number) => { const e = V.cellScreen.data[view][(dy + 14) * 29 + (dx + 14)]; return [e[1], e[0]]; };
  for (let dir = 0; dir < 8; dir++) {
    const ang = ((dir - 2) * Math.PI) / 4; // dir 2 = +x（东），逆时针（y 朝上）
    const wx = Math.cos(ang), wy = -Math.sin(ang);
    const [ax, ay] = T(1, 0); const [bx, by] = T(0, 1);
    const sx = ax * wx + bx * wy, sy = ay * wx + by * wy;
    const n = Math.hypot(sx, sy);
    const cx = 140, cy = 160;
    cv.line(cx, cy, cx + (sx / n) * 110, cy + (sy / n) * 110, [255, 255, 0]);
    cv.blit(walk, ((8 - view + dir) & 7) * 9, Math.round(cx + (sx / n) * 100), Math.round(cy + (sy / n) * 100) + 20);
  }
  // 建筑：facing 0..7，一排
  for (let f = 0; f < 8; f++) cv.blit(house, (8 - (f + view)) & 7, 320 + (f % 4) * 60, 110 + Math.floor(f / 4) * 110);
  cv.savePng(`${ROOT}.cache/assets-research/render/dircheck_view${view}.png`);
}
console.log('ok');
// 放大 ×3 的左半部分便于目视
{
  const view = 0;
  const walk2 = walk;
  const cv = new Canvas(900, 900, [60, 90, 60]);
  const T = (dx: number, dy: number) => { const e = V.cellScreen.data[view][(dy + 14) * 29 + (dx + 14)]; return [e[1], e[0]]; };
  const small = new Canvas(300, 300, [60, 90, 60]);
  for (let dir = 0; dir < 8; dir++) {
    const ang = ((dir - 2) * Math.PI) / 4;
    const wx = Math.cos(ang), wy = -Math.sin(ang);
    const [ax, ay] = T(1, 0); const [bx, by] = T(0, 1);
    const sx = ax * wx + bx * wy, sy = ay * wx + by * wy;
    const n = Math.hypot(sx, sy);
    small.line(150, 150, 150 + (sx / n) * 120, 150 + (sy / n) * 120, [255, 255, 0]);
    small.blit(walk2, ((8 - view + dir) & 7) * 9 + 4, Math.round(150 + (sx / n) * 105), Math.round(150 + (sy / n) * 105) + 25);
  }
  for (let y = 0; y < 900; y++) for (let x = 0; x < 900; x++) { const o = ((y / 3 | 0) * 300 + (x / 3 | 0)) * 4; cv.px.set(small.px.subarray(o, o + 4), (y * 900 + x) * 4); }
  cv.savePng(`${ROOT}.cache/assets-research/render/dircheck_view0_x3.png`);
}
