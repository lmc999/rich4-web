// 调试：用本机真实地图皮肤的精确表，度量原版「精灵锚点相对底图」的相对误差，以及仿射模型的误差（A6）
import { readdirSync, readFileSync } from 'node:fs';
import { OrigExactModel, OrigProjection } from '../apps/client/src/game/orig/OrigProjection';

const dir = 'rich4-assets/maps';
const f = readdirSync(dir).find((x) => /^taiwan\.skin\.[0-9a-f]{8}\.json$/.test(x));
if (!f) throw new Error('no skin');
const skin = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
const exact = new OrigExactModel(skin.projection.exact, skin.projection.origin);
const proj = OrigProjection.fromSkin(skin);
const map = JSON.parse(readFileSync('rich4-data/maps/taiwan.map.json', 'utf8'));
const pts: { x: number; y: number }[] = [
  ...map.tiles.map((t: { world: { x: number; y: number } }) => t.world),
  ...map.lots.map((t: { world: { x: number; y: number } }) => t.world),
];
for (let v = 0; v < 8; v++) {
  let relMax = 0;
  let relSum = 0;
  let n = 0;
  let affMax = 0;
  for (const cam of pts.slice(0, 40)) {
    for (const w of pts) {
      const o = exact.objectScreen(v, cam, w);
      const g = exact.groundScreen(v, cam, w);
      if (!o || !g) continue;
      const d = Math.hypot(o.x - g.x, o.y - g.y);
      relMax = Math.max(relMax, d);
      relSum += d;
      n++;
      // 仿射模型下同一对点的相对位移 vs 原版物体位置（绝对位置差：只作参考）
      const a = proj.project(w, v);
      const c = proj.project(cam, v);
      const ours = { x: skin.projection.origin.x + a.x - c.x, y: skin.projection.origin.y + a.y - c.y };
      affMax = Math.max(affMax, Math.hypot(ours.x - o.x, ours.y - o.y));
    }
  }
  console.log(`view ${v}: 原版相对误差 max ${relMax.toFixed(2)} mean ${(relSum / n).toFixed(2)} (n=${n}); 仿射 vs 原版物体绝对差 max ${affMax.toFixed(2)}`);
}
