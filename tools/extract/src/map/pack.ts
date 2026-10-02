import {
  type MapCounts,
  type MapDef,
  type MapSource,
  parseMapDef,
  validateMap,
  verifyMapDataHash,
} from '@rich4/shared/data';
import { z } from 'zod';
import { ExitCode, ExtractError } from '../context';
import { sha256Hex } from '../io/hash';
import { classifyIssues, type IssueClass } from './build';

/**
 * 部署数据包（data-pipeline.md §3 pack；architecture §14：产物写入 rich4-data/）：
 * rich4-data/maps/<id>.map.json（与 map build 输出逐字节相同）+ rich4-data/manifest.json（mapHash 与文件 sha256）。
 */

export const PACK_GENERATOR = 'rich4-extract/pack@1';

/**
 * 地图键 → globalMapId（= 原版地图号 gm，也是 MapDat.MKF / map.mkf 的资源号）。
 * 顺序即原版关卡顺序：开局设置关卡行点击区 exe 0x46aac4 第 9–12 项、按 OK 后 gm = 所选行（0x4070e1）。
 * 键名与客户端存读档缩图表一致（apps/client/src/ui/classic/popups/SaveLoadScreen.tsx）。
 * @source rich4.exe v2.06 0x46aac4、0x4070e1
 */
export const MAP_KEYS: Readonly<Record<string, number>> = { taiwan: 0, china: 1, japan: 2, usa: 3 };

export interface MapKeyRef {
  key: string;
  gm: number;
}

const keyList = (): string => Object.keys(MAP_KEYS).join('|');

/** 全部已接入的地图（按 gm 排序）。 */
export function allMapKeys(): MapKeyRef[] {
  return Object.entries(MAP_KEYS)
    .map(([key, gm]) => ({ key, gm }))
    .sort((a, b) => a.gm - b.gm);
}

/**
 * 解析 --map：地图键（taiwan、china…）、gm 数字（0..3）或 all（按 gm 顺序返回全部）。
 */
export function resolveMapKeys(v: string | undefined): MapKeyRef[] {
  if (v === undefined) throw new ExtractError('E_ARGS', `缺少 --map <${keyList()}|all>`, ExitCode.MISSING_INPUT);
  if (v === 'all') return allMapKeys();
  if (Object.hasOwn(MAP_KEYS, v)) return [{ key: v, gm: MAP_KEYS[v]! }];
  if (/^\d+$/.test(v)) {
    const hit = allMapKeys().find((m) => m.gm === Number(v));
    if (hit) return [hit];
  }
  throw new ExtractError(
    'E_ARGS',
    `未知地图 ${v}（可选：${Object.entries(MAP_KEYS)
      .map(([k, gm]) => `${k}(${gm})`)
      .join(', ')}，或 all）`,
  );
}

/** 解析单张图的 --map；all 在需要单张图的地方视为参数错误。 */
export function resolveMapKey(v: string | undefined): MapKeyRef {
  const list = resolveMapKeys(v);
  if (list.length !== 1) throw new ExtractError('E_ARGS', `--map ${v} 在这里只能指定一张图（${keyList()} 或 0..3）`);
  return list[0]!;
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

/**
 * <out>/manifest.json 里已有的条目（pack 合并用）。只核对合并需要的字段，其余字段原样保留，
 * 重新写出时与原文件逐字节相同（canonicalJson）。格式不对时抛 E_PACK_MERGE。
 */
const ExistingManifestSchema = z.object({
  schema: z.literal('rich4.data-manifest/1'),
  maps: z.array(
    z.looseObject({
      id: z.string().min(1),
      file: z.string().min(1),
      mapHash: z.string().regex(/^[0-9a-f]{64}$/),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
});

export function parseExistingManifest(json: unknown, where: string): ManifestMapEntry[] {
  const r = ExistingManifestSchema.safeParse(json);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new ExtractError(
      'E_PACK_MERGE',
      `${where} 不是可合并的数据包 manifest（${first ? `${first.path.join('.')}: ${first.message}` : '格式不对'}）；` +
        '确认无误后可加 --replace 整份重写',
    );
  }
  return r.data.maps as unknown as ManifestMapEntry[];
}

/**
 * 合并 manifest 条目：本次打包的图（fresh）替换或新增，已有的其他图（existing 里 id 不在 fresh 中的）原样保留。
 * 返回保留下来的 id，供调用方核对其地图文件仍在、sha256 相符。
 */
export function mergeManifestEntries(
  existing: readonly ManifestMapEntry[],
  fresh: readonly ManifestMapEntry[],
): { entries: ManifestMapEntry[]; kept: ManifestMapEntry[] } {
  const ids = new Set(fresh.map((e) => e.id));
  const kept = existing.filter((e) => !ids.has(e.id));
  return { entries: [...kept, ...fresh], kept };
}
