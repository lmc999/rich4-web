import { canonicalJson } from '../../util/canonicalJson';
import { fnv1a64 } from '../../util/hash';
import { DataError } from '../errors';
import { TABLES } from '../tables/index';
import { computeMapDataHash } from './dataHash';
import { buildFixtureMaps } from './fixtures/testMap';
import { buildMapIndex, type MapIndex } from './mapIndex';
import type { MapCounts, MapDef } from './types';

export interface MapListing {
  id: string;
  mapHash: string;
  nameKey: string;
  counts: MapCounts;
  fixture: boolean;
}

export interface DataRegistry {
  /** FNV-1a 64(规范化 TABLES)，同步计算 */
  readonly tablesHash: string;
  /** 地图不存在或 mapHash 不符时抛 DataError('MAP_UNAVAILABLE') */
  getMap(id: string, mapHash?: string): MapIndex;
  listMaps(): MapListing[];
}

export interface CreateRegistryOptions {
  /** 全局数据表（data/tables 的 TABLES），用于计算 tablesHash；缺省按空对象计算 */
  tables?: unknown;
  /** 复算每张图的 dataHash 并与 meta.dataHash 比对（默认 true） */
  verifyHash?: boolean;
}

export function computeTablesHash(tables: unknown): string {
  return fnv1a64(canonicalJson(tables));
}

/** 由调用方先执行 validateMap；这里只检查 id 重复与 dataHash */
export function createRegistry(maps: readonly MapDef[], opts: CreateRegistryOptions = {}): DataRegistry {
  const byId = new Map<string, MapDef>();
  for (const def of maps) {
    if (byId.has(def.id)) throw new DataError('MAP_DUPLICATE', `map id ${def.id} registered twice`, { id: def.id });
    if (opts.verifyHash !== false) {
      const actual = computeMapDataHash(def);
      if (actual !== def.meta.dataHash) {
        throw new DataError('MAP_HASH_MISMATCH', `map ${def.id} dataHash does not match its content`, {
          id: def.id,
          declared: def.meta.dataHash,
          actual,
        });
      }
    }
    byId.set(def.id, def);
  }
  const tablesHash = computeTablesHash(opts.tables ?? {});
  return {
    tablesHash,
    getMap(id, mapHash) {
      const def = byId.get(id);
      if (!def) throw new DataError('MAP_UNAVAILABLE', `map ${id} is not available`, { id });
      if (mapHash !== undefined && mapHash !== def.meta.dataHash) {
        throw new DataError('MAP_UNAVAILABLE', `map ${id} hash mismatch`, {
          id,
          requested: mapHash,
          available: def.meta.dataHash,
        });
      }
      return buildMapIndex(def);
    },
    listMaps() {
      return [...byId.values()].map((def) => ({
        id: def.id,
        mapHash: def.meta.dataHash,
        nameKey: def.nameKey,
        counts: { ...def.meta.counts },
        fixture: 'fixture' in def.meta.source,
      }));
    },
  };
}

let fixtureInner: DataRegistry | null = null;
function fixtures(): DataRegistry {
  fixtureInner ??= createRegistry(buildFixtureMaps(), { tables: TABLES });
  return fixtureInner;
}

/** 内含 test 与 test-allkinds 两张 fixture（首次访问时生成） */
export const fixtureRegistry: DataRegistry = {
  get tablesHash() {
    return fixtures().tablesHash;
  },
  getMap(id, mapHash) {
    return fixtures().getMap(id, mapHash);
  },
  listMaps() {
    return fixtures().listMaps();
  },
};
