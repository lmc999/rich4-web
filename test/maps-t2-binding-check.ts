// 调试脚本（T2 真实出包）：用客户端同一套 checkMapSkinBinding 核对 rich4-assets 里各图皮肤与 rich4-data 的 MapDef 是否绑定成功
// （绑定只看 resourceSha256 与世界坐标/朝向，不看 dataHash），并核对皮肤里引用的素材键都在 manifest 里、分组正确。
// 用法：npx tsx test/maps-t2-binding-check.ts [素材包目录，默认 rich4-assets] [MapDef 目录，默认 rich4-data/maps]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkMapSkinBinding, mapSkinBindingOf } from '../packages/shared/src/assets';

const packDir = process.argv[2] ?? 'rich4-assets';
const dataDir = process.argv[3] ?? path.join('rich4-data', 'maps');
const m = JSON.parse(readFileSync(path.join(packDir, 'manifest.json'), 'utf8'));
let bad = 0;
const SHARED = new Set([75, 80, 82, 84, 87, 132, 144]);

for (const [id, mp] of Object.entries<{ skin: string; group: string; binding: unknown }>(m.maps)) {
  const def = JSON.parse(readFileSync(path.join(dataDir, `${id}.map.json`), 'utf8'));
  const skinRec = m.files[mp.skin];
  const skin = JSON.parse(readFileSync(path.join(packDir, skinRec.path), 'utf8'));
  const mis = checkMapSkinBinding({ mapId: id, binding: mp.binding as never }, def);
  const misSkin = checkMapSkinBinding({ mapId: skin.mapId, binding: skin.binding }, def);
  const b = mapSkinBindingOf(def);
  // 皮肤里引用的素材键：递归收集字符串值中形如 board.* / map.* 的键
  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string' && /^(board|map)\./.test(v) && v in m.entries) keys.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(skin);
  const groups = new Map<string, string[]>();
  for (const k of keys) {
    const g = m.entries[k].group as string;
    groups.set(g, [...(groups.get(g) ?? []), k]);
  }
  // 企业/景观精灵：单图的必须在 map.<id>，共用的必须在 board.landmarks
  const wrong = [...keys].filter((k) => {
    const r = /^board\.landmark\.(\d+)$/.exec(k);
    if (!r) return false;
    const want = SHARED.has(Number(r[1])) ? 'board.landmarks' : `map.${id}`;
    return m.entries[k].group !== want;
  });
  const ok = mis.length === 0 && misSkin.length === 0 && wrong.length === 0;
  if (!ok) bad++;
  console.log(
    `${ok ? 'OK ' : 'BAD'} ${id}：manifest 绑定 ${mis.length ? JSON.stringify(mis) : '匹配'}；皮肤文件绑定 ${misSkin.length ? JSON.stringify(misSkin) : '匹配'}；` +
      `geometry ${b.geometry.slice(0, 12)}…；dataHash ${String(def.meta?.dataHash ?? def.dataHash ?? '').slice(0, 12)}…`,
  );
  for (const [g, ks] of [...groups].sort()) console.log(`      ${g}（${ks.length}）：${ks.sort().join(' ')}`);
  if (wrong.length) console.log(`      分组不对：${wrong.join(' ')}`);
}
console.log(bad === 0 ? '全部绑定成功' : `${bad} 张图不符`);
process.exit(bad === 0 ? 0 : 1);
