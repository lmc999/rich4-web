/**
 * T1 调试脚本：对 tools/extract/maps/<key>.overrides.json 逐条去掉一个 nodeCell / edgeRoute / lot 条目，
 * 跑 buildMapDef，报告去掉后出现的问题（几何 error、偏侧住宅地、W_TILES_TOUCH、1×1 企业），用来核对每条 override 的理由。
 * 用法（仓库根）：npx tsx test/maps-t1-ablate.ts <key>
 */
import { readFileSync } from 'node:fs';
import { ExtractContext } from '../tools/extract/src/context';
import { loadKnownFiles } from '../tools/extract/src/fingerprint/identify';
import { buildMapDef } from '../tools/extract/src/map/build';
import { facingDirs } from '../tools/extract/src/map/geometry/placeLands';
import { dirIndex } from '../tools/extract/src/map/geometry/types';
import { parseOverrides } from '../tools/extract/src/map/overrides';
import { MAP_KEYS } from '../tools/extract/src/map/pack';
import { loadRawSource, sourceDef } from '../tools/extract/src/map/sources';

const key = process.argv[2]!;
const ctx = new ExtractContext({ logger: { out: () => {}, err: () => {} } });
const base = JSON.parse(readFileSync(`tools/extract/maps/${key}.overrides.json`, 'utf8'));
const { raw } = await loadRawSource(ctx, sourceDef(base.source.id), MAP_KEYS[key]!, await loadKnownFiles(ctx.packageDir));

function report(ovJson: unknown): string {
  let r: ReturnType<typeof buildMapDef>;
  try {
    r = buildMapDef(raw, parseOverrides(ovJson), { mapKey: key, strict4: true });
  } catch (e) {
    return `抛错 ${e instanceof Error ? e.message : String(e)}`;
  }
  const g = r.geometry.report;
  const errs = [
    ...g.issues.filter((i) => i.severity === 'error').map((i) => `${i.code}(${i.msg.slice(0, 40)})`),
    ...r.classified.filter((i) => i.class === 'error').map((i) => `${i.code}(${i.path})`),
  ];
  const cellOf = new Map(r.def.tiles.map((t) => [t.id, t.cell]));
  const off = r.def.lots
    .filter((l) => l.kind === 'land' && l.rect.w === 1)
    .filter((l) => {
      const fc = cellOf.get(l.frontTiles[0]!)!;
      return !facingDirs(l.facing, g.lattice.transform).includes(dirIndex(fc, { x: l.rect.x, y: l.rect.y }));
    })
    .map((l) => l.id);
  const small = r.def.companies.filter((c) => c.rect.w * c.rect.h < 4).map((c) => c.id);
  return `err [${errs.join(' ')}] facing ${g.facing.enabled ? 'on' : 'OFF'} offSide [${off.join(',')}] touch ${JSON.stringify(g.unlinkedAdjacent)} small [${small.join(',')}]`;
}

console.log(`全部：${report(base)}`);
for (const sec of ['nodeCell', 'edgeRoute', 'lot'] as const) {
  for (const k of Object.keys(base[sec] ?? {})) {
    const next = structuredClone(base);
    delete next[sec][k];
    console.log(`去掉 ${sec}.${k}：${report(next)}`);
  }
}
