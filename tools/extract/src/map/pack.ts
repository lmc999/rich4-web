import {
  type MapCounts,
  type MapDef,
  type MapSource,
  parseMapDef,
  validateMap,
  verifyMapDataHash,
} from '@rich4/shared/data';
import { ExitCode, ExtractError } from '../context';
import { sha256Hex } from '../io/hash';
import { classifyIssues, type IssueClass } from './build';

/**
 * 部署数据包（data-pipeline.md §3 pack；architecture §14：产物写入 rich4-data/）：
 * rich4-data/maps/<id>.map.json（与 map build 输出逐字节相同）+ rich4-data/manifest.json（mapHash 与文件 sha256）。
 */

export const PACK_GENERATOR = 'rich4-extract/pack@1';

/** 地图键 → globalMapId（目前只有台湾接入） */
export const MAP_KEYS: Readonly<Record<string, number>> = { taiwan: 0 };

export function resolveMapKey(v: string | undefined): { key: string; gm: number } {
  if (v === undefined) throw new ExtractError('E_ARGS', '缺少 --map <taiwan|0>', ExitCode.MISSING_INPUT);
  if (Object.hasOwn(MAP_KEYS, v)) return { key: v, gm: MAP_KEYS[v]! };
  if (/^\d+$/.test(v)) {
    const hit = Object.entries(MAP_KEYS).find(([, gm]) => gm === Number(v));
    if (hit) return { key: hit[0], gm: hit[1] };
  }
  throw new ExtractError('E_ARGS', `未知地图 ${v}（可选：${Object.keys(MAP_KEYS).join(', ')}）`);
}

export interface ManifestMapEntry {
  id: string;
  file: string;
  mapHash: string;
  sha256: string;
  bytes: number;
  globalMapId: number | null;
  nameKey: string;
  counts: MapCounts;
  source: MapSource;
  /** 尚未填充、等待后续里程碑的数据块（例如 stocks、holidays） */
  pending: string[];
  validation: { ok: boolean; issues: Partial<Record<IssueClass, number>> };
}

export interface DataManifest {
  schema: 'rich4.data-manifest/1';
  generator: string;
  maps: ManifestMapEntry[];
}

/** 核对一张已构建的地图文件并生成 manifest 条目；存在未分类的 validateMap 错误或 hash 不符时抛错。 */
export function manifestEntry(fileText: string, pending: readonly string[]): { def: MapDef; entry: ManifestMapEntry } {
  const def = parseMapDef(JSON.parse(fileText));
  if (!verifyMapDataHash(def)) {
    throw new ExtractError('E_PACK_HASH', `${def.id}: meta.dataHash 与内容不符（请重新运行 map build）`);
  }
  const v = validateMap(def);
  const classified = classifyIssues(def, v.issues, pending);
  const counts: Partial<Record<IssueClass, number>> = {};
  for (const i of classified) counts[i.class] = (counts[i.class] ?? 0) + 1;
  const bad = classified.filter((i) => i.class === 'error');
  if (bad.length > 0) {
    throw new ExtractError(
      'E_PACK_INVALID',
      `${def.id}: validateMap 有 ${bad.length} 个未分类错误（${bad
        .slice(0, 3)
        .map((i) => `${i.code} ${i.path}`)
        .join('；')}）`,
    );
  }
  const bytes = new TextEncoder().encode(fileText);
  return {
    def,
    entry: {
      id: def.id,
      file: `maps/${def.id}.map.json`,
      mapHash: def.meta.dataHash,
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
      globalMapId: def.globalMapId,
      nameKey: def.nameKey,
      counts: { ...def.meta.counts },
      source: def.meta.source,
      pending: [...pending],
      validation: { ok: v.ok, issues: counts },
    },
  };
}

export function buildManifest(entries: readonly ManifestMapEntry[]): DataManifest {
  return {
    schema: 'rich4.data-manifest/1',
    generator: PACK_GENERATOR,
    maps: [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}
