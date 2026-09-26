// 地图（architecture §5.8 HTTP）：按 view.dataRef 的 {mapId, mapHash} 经 GET /api/maps/:id?h=<mapHash> 取 MapDef，
// zod 结构校验后建 MapIndex 并缓存（同一 id+hash 只请求一次，immutable 缓存）。
// 服务器不可达且是 fixture 地图（test / test-allkinds）时，退回 shared 里的 fixture，但 hash 必须一致。
import { buildFixtureMaps, buildMapIndex, type MapDef, type MapIndex, parseMapDef } from '@rich4/shared/data';
import { create } from 'zustand';

export type MapStatus = 'loading' | 'ready' | 'error';

export interface MapEntry {
  status: MapStatus;
  def: MapDef | null;
  index: MapIndex | null;
  error: string | null;
}

export interface MapStoreState {
  entries: Record<string, MapEntry>;
  /** 读取（或复用缓存）；失败时 reject */
  load(mapId: string, mapHash: string): Promise<MapIndex>;
  get(mapId: string, mapHash: string): MapEntry | null;
  clear(): void;
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

let fetchImpl: FetchLike = (url) => fetch(url);

/** 测试注入 fetch */
export function setMapFetch(f: FetchLike | null): void {
  fetchImpl = f ?? ((url) => fetch(url));
}

export const mapKey = (mapId: string, mapHash: string): string => `${mapId}@${mapHash}`;

const inflight = new Map<string, Promise<MapIndex>>();

function fixtureFallback(mapId: string, mapHash: string): MapDef | null {
  if (mapId !== 'test' && mapId !== 'test-allkinds') return null;
  const def = buildFixtureMaps().find((m) => m.id === mapId);
  return def && def.meta.dataHash === mapHash ? def : null;
}

async function fetchMap(mapId: string, mapHash: string): Promise<MapDef> {
  const url = `/api/maps/${encodeURIComponent(mapId)}?h=${encodeURIComponent(mapHash)}`;
  let reason = '';
  try {
    const res = await fetchImpl(url);
    if (res.ok) {
      const def = parseMapDef(await res.json());
      if (def.meta.dataHash !== mapHash) throw new Error(`mapHash 不符：${def.meta.dataHash}`);
      return def;
    }
    reason = `HTTP ${res.status}`;
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }
  const fb = fixtureFallback(mapId, mapHash);
  if (fb) return fb;
  throw new Error(`地图 ${mapId} 加载失败：${reason}`);
}

export const useMapStore = create<MapStoreState>()((set, get) => ({
  entries: {},
  get: (mapId, mapHash) => get().entries[mapKey(mapId, mapHash)] ?? null,
  load: (mapId, mapHash) => {
    const key = mapKey(mapId, mapHash);
    const hit = get().entries[key];
    if (hit?.status === 'ready' && hit.index) return Promise.resolve(hit.index);
    const running = inflight.get(key);
    if (running) return running;
    set((s) => ({ entries: { ...s.entries, [key]: { status: 'loading', def: null, index: null, error: null } } }));
    const p = fetchMap(mapId, mapHash).then(
      (def) => {
        const index = buildMapIndex(def);
        inflight.delete(key);
        set((s) => ({ entries: { ...s.entries, [key]: { status: 'ready', def, index, error: null } } }));
        return index;
      },
      (e: unknown) => {
        inflight.delete(key);
        const error = e instanceof Error ? e.message : String(e);
        set((s) => ({ entries: { ...s.entries, [key]: { status: 'error', def: null, index: null, error } } }));
        throw e;
      },
    );
    inflight.set(key, p);
    return p;
  },
  clear: () => {
    inflight.clear();
    set({ entries: {} });
  },
}));
