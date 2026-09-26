/**
 * 服务端数据注册表（architecture §5.2、§9.2、§16.5；design/data-pipeline.md contracts）。
 *
 * - fixture 地图（test、test-allkinds）始终可用；
 * - 读取 RICH4_DATA_DIR/manifest.json 与 maps/*.map.json：核对文件 sha256、zod 结构校验、复算 dataHash、validateMap；
 * - manifest 条目的 pending 非空（例如台湾图的 stocks/holidays 尚待 D2 填充）时，只放行由缺项引起的校验错误，
 *   地图照常列出、可以下发 MapDef，但禁止用它开局（playable=false）；
 * - 其余校验错误、hash 不符、文件缺失的地图一律跳过并告警；目录或 manifest 缺失时只提供 fixture 并告警。
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  buildFixtureMaps,
  createRegistry,
  type DataRegistry,
  type MapDef,
  type MapIssue,
  type MapListing,
  parseMapDef,
  TABLES,
  validateMap,
  verifyMapDataHash,
} from '@rich4/shared/data';
import { z } from 'zod';
import type { Logger } from '../infra/logger';

export interface ServerMapListing extends MapListing {
  /** false：数据不完整（manifest.pending 非空），只列出不可开局 */
  playable: boolean;
  pending: string[];
}

export interface MapCatalog {
  readonly registry: DataRegistry;
  /** 找不到或不可开局时回退到 test */
  readonly defaultMap: string;
  list(): ServerMapListing[];
  has(id: string): boolean;
  isPlayable(id: string): boolean;
  def(id: string): MapDef | undefined;
}

const ManifestSchema = z.object({
  schema: z.literal('rich4.data-manifest/1'),
  maps: z.array(
    z.object({
      id: z.string().min(1).max(64),
      file: z.string().min(1).max(256),
      mapHash: z.string().regex(/^[0-9a-f]{64}$/),
      sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
      pending: z.array(z.string()).optional(),
    }),
  ),
});

/** 由 manifest.pending 缺项解释的校验错误（与 tools/extract classifyIssues 的 pending 分支一致） */
export function isPendingIssue(def: MapDef, issue: MapIssue, pending: readonly string[]): boolean {
  if (
    pending.includes('stocks') &&
    def.stocks.length === 0 &&
    issue.code === 'E_TILE_REF_MISMATCH' &&
    /^companies\[\d+\]\.stockIndex$/.test(issue.path)
  ) {
    return true;
  }
  return pending.includes('holidays') && def.holidays.length === 0 && issue.path.startsWith('holidays');
}

interface Entry {
  def: MapDef;
  fixture: boolean;
  pending: string[];
}

export interface LoadDataOptions {
  dataDir: string | null;
  defaultMap: string;
  log: Logger;
}

async function loadDir(dir: string, log: Logger): Promise<Entry[]> {
  let manifestText: string;
  try {
    manifestText = await readFile(resolve(dir, 'manifest.json'), 'utf8');
  } catch {
    log.warn({ dir }, 'RICH4_DATA_DIR 下没有 manifest.json，只提供 fixture 地图');
    return [];
  }
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestText);
  } catch (err) {
    log.error({ dir, err }, 'manifest.json 不是合法 JSON，只提供 fixture 地图');
    return [];
  }
  const parsed = ManifestSchema.safeParse(manifestJson);
  if (!parsed.success) {
    log.error({ dir }, 'manifest.json 格式不正确，只提供 fixture 地图');
    return [];
  }
  const out: Entry[] = [];
  for (const m of parsed.data.maps) {
    const path = resolve(dir, m.file);
    const rel = relative(resolve(dir), path);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      log.error({ id: m.id, file: m.file }, 'manifest 条目的文件越出数据目录，跳过');
      continue;
    }
    try {
      const bytes = await readFile(path);
      if (m.sha256 && createHash('sha256').update(bytes).digest('hex') !== m.sha256) {
        log.error({ id: m.id }, '地图文件 sha256 与 manifest 不符，跳过');
        continue;
      }
      const def = parseMapDef(JSON.parse(bytes.toString('utf8')));
      if (def.id !== m.id) {
        log.error({ id: m.id, actual: def.id }, '地图 id 与 manifest 不符，跳过');
        continue;
      }
      if (!verifyMapDataHash(def) || def.meta.dataHash !== m.mapHash) {
        log.error({ id: m.id }, '地图 dataHash 复算不符，跳过');
        continue;
      }
      const pending = m.pending ?? [];
      const v = validateMap(def);
      const errors = v.issues.filter((i) => i.severity === 'error' && !isPendingIssue(def, i, pending));
      if (errors.length > 0) {
        log.error(
          { id: m.id, errors: errors.slice(0, 5).map((i) => `${i.code} ${i.path}`), count: errors.length },
          'validateMap 未通过，跳过',
        );
        continue;
      }
      if (pending.length > 0) log.warn({ id: m.id, pending }, '地图数据待补，只列出、禁止开局');
      out.push({ def, fixture: false, pending: [...pending] });
    } catch (err) {
      log.error({ id: m.id, err }, '读取地图失败，跳过');
    }
  }
  return out;
}

export function catalogFromEntries(entries: Entry[], requestedDefault: string): MapCatalog {
  const byId = new Map<string, Entry>();
  for (const e of entries) if (!byId.has(e.def.id)) byId.set(e.def.id, e);
  const registry = createRegistry(
    [...byId.values()].map((e) => e.def),
    { tables: TABLES, verifyHash: false },
  );
  const playable = (id: string) => {
    const e = byId.get(id);
    return !!e && e.pending.length === 0;
  };
  const defaultMap = playable(requestedDefault) ? requestedDefault : 'test';
  return {
    registry,
    defaultMap,
    list: () =>
      registry.listMaps().map((l) => {
        const e = byId.get(l.id)!;
        return { ...l, playable: e.pending.length === 0, pending: [...e.pending] };
      }),
    has: (id) => byId.has(id),
    isPlayable: playable,
    def: (id) => byId.get(id)?.def,
  };
}

/** 只含 fixture 的目录（测试默认） */
export function fixtureCatalog(): MapCatalog {
  return catalogFromEntries(
    buildFixtureMaps().map((def) => ({ def, fixture: true, pending: [] })),
    'test',
  );
}

export async function loadMapCatalog(o: LoadDataOptions): Promise<MapCatalog> {
  const fixtures: Entry[] = buildFixtureMaps().map((def) => ({ def, fixture: true, pending: [] }));
  const loaded = o.dataDir ? await loadDir(o.dataDir, o.log) : [];
  if (!o.dataDir) o.log.warn('未设置 RICH4_DATA_DIR，只提供 fixture 地图');
  const dup = loaded.filter((e) => fixtures.some((f) => f.def.id === e.def.id));
  for (const d of dup) o.log.error({ id: d.def.id }, '地图 id 与 fixture 冲突，跳过');
  const catalog = catalogFromEntries([...fixtures, ...loaded.filter((e) => !dup.includes(e))], o.defaultMap);
  if (catalog.defaultMap !== o.defaultMap) {
    o.log.warn({ requested: o.defaultMap, using: catalog.defaultMap }, 'DEFAULT_MAP 不可开局，回退');
  }
  return catalog;
}
