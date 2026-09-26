// 开发页的地图来源：fixture 直接从 shared 构造；台湾图走 GET /api/maps/taiwan（服务端 DataRegistry），
// 开发服务器下失败时再试 /__dev/maps/taiwan（vite 中间件直读本机 rich4-data，见 vite.config.ts）。
import { buildTestMap, buildTestMapAllKinds, type MapDef, parseMapDef, validateMap } from '@rich4/shared/data';

export const MAP_CHOICES = ['test', 'test-allkinds', 'taiwan'] as const;
export type MapChoice = (typeof MAP_CHOICES)[number];

export interface LoadedMap {
  def: MapDef;
  source: 'fixture' | 'api' | 'dev-local';
  errors: number;
  warns: number;
}

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function summarize(def: MapDef, source: LoadedMap['source']): LoadedMap {
  const r = validateMap(def);
  return {
    def,
    source,
    errors: r.issues.filter((i) => i.severity === 'error').length,
    warns: r.issues.filter((i) => i.severity === 'warn').length,
  };
}

export async function loadMapDef(
  id: MapChoice,
  fetchImpl: FetchLike = fetch,
  allowDevLocal = import.meta.env.DEV,
): Promise<LoadedMap> {
  if (id === 'test') return summarize(buildTestMap(), 'fixture');
  if (id === 'test-allkinds') return summarize(buildTestMapAllKinds(), 'fixture');
  const reasons: string[] = [];
  const urls: [string, LoadedMap['source']][] = [[`/api/maps/${id}`, 'api']];
  if (allowDevLocal) urls.push([`/__dev/maps/${id}`, 'dev-local']);
  for (const [url, source] of urls) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) {
        reasons.push(`${url} → HTTP ${res.status}`);
        continue;
      }
      return summarize(parseMapDef(await res.json()), source);
    } catch (e) {
      reasons.push(`${url} → ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(reasons.join('；'));
}
