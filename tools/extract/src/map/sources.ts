import path from 'node:path';
import { ExitCode, type ExtractContext, ExtractError } from '../context';
import type { KnownFiles } from '../fingerprint/identify';
import { sha256Hex } from '../io/hash';
import { findCaseInsensitive, readFileRO } from '../io/readOnly';
import { MkfArchive } from '../mkf/container';
import { parseMapRaw } from './parseRaw';
import type { EditionId, MapDataRaw, RawSourceId } from './rawTypes';

export interface RawSourceDef {
  id: RawSourceId;
  edition: EditionId;
  /** 相对 original/ 的路径（大小写不敏感匹配） */
  relPath: string;
  container: 'MapDat.mkf' | 'map.mkf';
  resourceFor(globalMapId: number): number;
}

/** 按优先级排列：v2.06 exe 先读 MapDat.mkf[gm]，失败才回退 map.mkf[gm*2+1]（§5.1）。 */
export const RAW_SOURCES: readonly RawSourceDef[] = [
  { id: 'v206-mapdat', edition: 'v206', relPath: 'Game/MapDat.mkf', container: 'MapDat.mkf', resourceFor: (gm) => gm },
  {
    id: 'v206-mapmkf',
    edition: 'v206',
    relPath: 'Game/map.mkf',
    container: 'map.mkf',
    resourceFor: (gm) => gm * 2 + 1,
  },
  {
    id: 'v311-mapmkf',
    edition: 'v311',
    relPath: 'MultiverseJourney/map.mkf',
    container: 'map.mkf',
    resourceFor: (gm) => gm * 2 + 1,
  },
];

export function sourceDef(id: string): RawSourceDef {
  const def = RAW_SOURCES.find((s) => s.id === id);
  if (!def) throw new ExtractError('E_SOURCE_ID', `未知来源 ${id}（可选：${RAW_SOURCES.map((s) => s.id).join(', ')}）`);
  return def;
}

export interface LoadedRawSource {
  raw: MapDataRaw;
  /** 资源体（零拷贝视图），供 --dump-bin */
  resource: Uint8Array;
}

export async function locateSource(ctx: ExtractContext, def: RawSourceDef): Promise<string | null> {
  return findCaseInsensitive(ctx.srcDir, def.relPath);
}

/** 读取来源文件 → MKF → 资源 → MapDataRaw。 */
export async function loadRawSource(
  ctx: ExtractContext,
  def: RawSourceDef,
  globalMapId: number,
  known: KnownFiles | null,
): Promise<LoadedRawSource> {
  const file = await locateSource(ctx, def);
  if (file === null) {
    throw new ExtractError(
      'E_MISSING_INPUT',
      `找不到 ${def.relPath}（于 ${ctx.displayPath(ctx.srcDir)}）`,
      ExitCode.MISSING_INPUT,
    );
  }
  const bytes = await readFileRO(file);
  const fileSha256 = sha256Hex(bytes);
  const rel = path.relative(ctx.srcDir, file).split(path.sep).join('/');
  const mkf = MkfArchive.open(bytes, rel);
  const resourceIndex = def.resourceFor(globalMapId);
  const entry = mkf.entry(resourceIndex);
  const resource = mkf.read(resourceIndex);
  const knownFileId = known?.files.find((k) => k.sha256 === fileSha256)?.id ?? null;
  const raw = parseMapRaw(
    resource,
    {
      id: def.id,
      edition: def.edition,
      file: rel,
      fileSha256,
      knownFileId,
      container: def.container,
      resource: resourceIndex,
      compressed: entry.compressed,
    },
    globalMapId,
  );
  return { raw, resource };
}

/**
 * 解析 --sources：all = 三个来源都必须存在；auto = 存在哪个用哪个；也可逗号分隔列出来源 id。
 * 返回要处理的来源及被跳过的（auto 模式下缺失的）。
 */
export async function selectSources(
  ctx: ExtractContext,
  spec: string,
): Promise<{ selected: RawSourceDef[]; skipped: RawSourceDef[] }> {
  if (spec === 'all' || spec === 'auto') {
    const selected: RawSourceDef[] = [];
    const skipped: RawSourceDef[] = [];
    for (const def of RAW_SOURCES) {
      if ((await locateSource(ctx, def)) !== null) selected.push(def);
      else if (spec === 'all') {
        throw new ExtractError(
          'E_MISSING_INPUT',
          `--sources all 需要 ${def.relPath}，但未找到`,
          ExitCode.MISSING_INPUT,
        );
      } else skipped.push(def);
    }
    if (selected.length === 0) {
      throw new ExtractError('E_MISSING_INPUT', '没有找到任何地图来源文件', ExitCode.MISSING_INPUT);
    }
    return { selected, skipped };
  }
  const ids = spec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { selected: ids.map(sourceDef), skipped: [] };
}
