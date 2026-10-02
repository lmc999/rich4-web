// 调试脚本（T2 真实出包）：比较重建前后两份素材包 manifest，核对方案 T2 verify 各项并统计体积增量。
// 用法：npx tsx test/maps-t2-pack-diff.ts [旧 manifest，默认 .cache/maps/assets/manifest.before.json] [新包目录，默认 rich4-assets]
// 只读：不写 rich4-assets/，结果打到标准输出（可重定向到 .cache/maps/assets/）。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

interface Entry {
  group: string;
  file?: string;
  files?: Record<string, string>;
  atlas?: string[];
  [k: string]: unknown;
}
interface FileRec {
  bytes: number;
  path: string;
  sha256: string;
}
interface Manifest {
  packId: string;
  entries: Record<string, Entry>;
  files: Record<string, FileRec>;
  groups: Record<string, { bytes: number; category: string; files: string[] }>;
  maps: Record<string, { group: string; skin: string; binding: { counts: Record<string, number> } }>;
}

const oldPath = process.argv[2] ?? '.cache/maps/assets/manifest.before.json';
const packDir = process.argv[3] ?? 'rich4-assets';
const oldM = JSON.parse(readFileSync(oldPath, 'utf8')) as Manifest;
const newM = JSON.parse(readFileSync(path.join(packDir, 'manifest.json'), 'utf8')) as Manifest;

const mb = (n: number) => `${(n / 1048576).toFixed(2)} MB`;
const sum = (m: Manifest) => Object.values(m.files).reduce((a, f) => a + f.bytes, 0);
let bad = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) bad++;
  console.log(`${ok ? 'OK ' : 'BAD'} ${msg}`);
};

console.log(`旧 packId ${oldM.packId}：${Object.keys(oldM.entries).length} 条目、${Object.keys(oldM.files).length} 文件、${mb(sum(oldM))}`);
console.log(`新 packId ${newM.packId}：${Object.keys(newM.entries).length} 条目、${Object.keys(newM.files).length} 文件、${mb(sum(newM))}`);
console.log(`增量：条目 +${Object.keys(newM.entries).length - Object.keys(oldM.entries).length}、文件 +${Object.keys(newM.files).length - Object.keys(oldM.files).length}、体积 +${mb(sum(newM) - sum(oldM))}`);

// 1. manifest.maps 四张图与 binding 计数
const expectCounts: Record<string, [number, number, number]> = {
  taiwan: [3, 54, 103],
  china: [4, 81, 144],
  japan: [6, 54, 110],
  usa: [6, 63, 118],
};
check(Object.keys(newM.maps).sort().join(',') === 'china,japan,taiwan,usa', `manifest.maps = ${Object.keys(newM.maps).join(',')}`);
for (const [id, [c, l, t]] of Object.entries(expectCounts)) {
  const b = newM.maps[id]?.binding.counts;
  check(b?.companies === c && b?.lots === l && b?.tiles === t, `${id} binding 企业/地块/节点 = ${b?.companies}/${b?.lots}/${b?.tiles}（期望 ${c}/${l}/${t}），分组 ${newM.maps[id]?.group}`);
}

// 2. 台湾皮肤内容不变
const skinSha = (m: Manifest) => m.files['maps/taiwan.skin.json']?.sha256;
const onDisk = createHash('sha256')
  .update(readFileSync(path.join(packDir, newM.files['maps/taiwan.skin.json']?.path ?? '')))
  .digest('hex');
check(skinSha(oldM) === skinSha(newM) && onDisk === skinSha(newM), `taiwan.skin.json sha ${skinSha(newM)}（旧 ${skinSha(oldM)}，盘上 ${onDisk}）`);

// 3. 旧条目全部保留；分组变化只允许共用精灵换到 board.landmarks
const removed = Object.keys(oldM.entries).filter((k) => !(k in newM.entries));
check(removed.length === 0, `旧条目缺失 ${removed.length} 个${removed.length ? `：${removed.slice(0, 20).join(', ')}` : ''}`);
const moved = Object.keys(oldM.entries)
  .filter((k) => k in newM.entries && oldM.entries[k]?.group !== newM.entries[k]?.group)
  .map((k) => `${k}: ${oldM.entries[k]?.group} → ${newM.entries[k]?.group}`);
const allowedMoved = [75, 80, 84, 87, 144].map((r) => `board.landmark.${r}: map.taiwan → board.landmarks`);
check(
  moved.length === allowedMoved.length && allowedMoved.every((s) => moved.includes(s)),
  `旧条目换分组 ${moved.length} 个：${moved.join('；')}`,
);
// 旧条目内容（除分组外）是否变化
const changed = Object.keys(oldM.entries).filter((k) => {
  const a = { ...oldM.entries[k], group: undefined };
  const b = { ...newM.entries[k], group: undefined };
  return k in newM.entries && JSON.stringify(a) !== JSON.stringify(b);
});
console.log(`    旧条目除分组外有变化 ${changed.length} 个${changed.length ? `：${changed.join(', ')}` : ''}`);
for (const k of changed.slice(0, 60)) {
  const a = oldM.entries[k] as Record<string, unknown>;
  const b = newM.entries[k] as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (f) => f !== 'group' && JSON.stringify(a[f]) !== JSON.stringify(b[f]),
  );
  for (const f of keys) console.log(`      ${k}.${f}: ${JSON.stringify(a[f])} → ${JSON.stringify(b[f])}`);
}

// 4. 新增条目
const added = Object.keys(newM.entries).filter((k) => !(k in oldM.entries));
const byGroup = new Map<string, string[]>();
for (const k of added) {
  const g = newM.entries[k]?.group ?? '?';
  byGroup.set(g, [...(byGroup.get(g) ?? []), k]);
}
console.log(`新增条目 ${added.length} 个：`);
for (const [g, ks] of [...byGroup].sort()) console.log(`    ${g}（${ks.length}）：${ks.join(' ')}`);

// 5. 节日插画 82 个、编号 0..82 缺 62（Data#66）
const hol = Object.keys(newM.entries)
  .filter((k) => k.startsWith('illustration.holiday.'))
  .map((k) => Number(k.slice('illustration.holiday.'.length)))
  .sort((a, b) => a - b);
const expectHol = [...Array(83).keys()].filter((i) => i !== 62);
check(JSON.stringify(hol) === JSON.stringify(expectHol), `illustration.holiday 条目 ${hol.length} 个，缺编号 ${expectHol.length === hol.length ? '62（Data#66）' : '不符'}`);
const holFiles = newM.groups['illustration.holiday']?.files ?? [];
check(holFiles.length === 82, `illustration.holiday 分组文件 ${holFiles.length} 个，${mb(newM.groups['illustration.holiday']?.bytes ?? 0)}（旧 ${oldM.groups['illustration.holiday']?.files.length} 个 ${mb(oldM.groups['illustration.holiday']?.bytes ?? 0)}）`);
// 每图首末 slot 的源资源号
const base = [4, 28, 47, 67];
const cnt = [24, 19, 19, 20];
const keyOff = [0, 24, 43, 63];
for (let gm = 0; gm < 4; gm++) {
  for (const slot of [0, cnt[gm]! - 1]) {
    const key = `illustration.holiday.${keyOff[gm]! + slot}`;
    const src = (newM.entries[key]?.src as string[] | undefined)?.[0];
    check(src === `Data#${base[gm]! + slot}`, `gm${gm} slot${slot} → ${key} = ${src}（期望 Data#${base[gm]! + slot}）`);
  }
}

// 6. 开局设置背景与飞行动画
for (const k of ['title.setup.bg', 'title.setup.bg.china', 'title.setup.bg.japan', 'title.setup.bg.usa']) {
  const e = newM.entries[k];
  check(!!e && !!e.file && e.file in newM.files, `${k}：${(e?.src as string[] | undefined)?.[0]} → ${e?.file}`);
}
for (const k of ['video.flytw', 'video.flychina', 'video.flyjp', 'video.flyus']) {
  const e = newM.entries[k];
  const f = e?.files?.mp4;
  check(!!f && f in newM.files, `${k}：${f}，${f ? mb(newM.files[f]?.bytes ?? 0) : '-'}，${e?.durationMs} ms`);
}

// 7. 分组体积增量
console.log('分组体积（仅列有变化的）：');
const groups = [...new Set([...Object.keys(oldM.groups), ...Object.keys(newM.groups)])].sort();
for (const g of groups) {
  const a = oldM.groups[g];
  const b = newM.groups[g];
  if (a?.bytes === b?.bytes && a?.files.length === b?.files.length) continue;
  console.log(
    `    ${g.padEnd(24)} ${String(a?.files.length ?? 0).padStart(4)} → ${String(b?.files.length ?? 0).padStart(4)} 文件  ${mb(a?.bytes ?? 0).padStart(10)} → ${mb(b?.bytes ?? 0).padStart(10)}  (${(b?.bytes ?? 0) >= (a?.bytes ?? 0) ? '+' : ''}${mb((b?.bytes ?? 0) - (a?.bytes ?? 0))})`,
  );
}

// 8. 被清理的旧文件（旧 manifest 有、新 manifest 没有的物理路径）
const newPaths = new Set(Object.values(newM.files).map((f) => f.path));
const gone = Object.values(oldM.files)
  .map((f) => f.path)
  .filter((p) => !newPaths.has(p));
console.log(`旧物理文件不再引用 ${gone.length} 个：${gone.join(' ')}`);

console.log(bad === 0 ? '全部核对通过' : `${bad} 项不符`);
process.exit(bad === 0 ? 0 : 1);
