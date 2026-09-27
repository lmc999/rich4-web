// 皮肤判定与回退矩阵（design-draft §3.1「皮肤判定顺序」；original-skin.md §3 修正 4/9）。纯函数，不做 IO。
//
// | 条件                                         | skin        | board                       |
// |----------------------------------------------|-------------|-----------------------------|
// | 设置为程序化                                 | procedural  | procedural（setting）       |
// | 素材包加载中 / 404 / 非 JSON / 校验失败 / 网络 | procedural  | procedural（pack-*）        |
// | manifest 401                                 | procedural  | procedural（access-required，另弹门禁页） |
// | 素材包正常，不在对局中                       | original    | —                           |
// | 素材包正常，地图缺失 / 绑定不匹配 / 分组缺失 | auto：procedural；original：original | procedural（map-* / group-missing） |
// | 素材包不含棋盘（features.board=false）       | 同上        | procedural（no-board）      |
// | 全部匹配，但原版棋盘渲染器未注册 / 创建失败  | original    | procedural（renderer-*）    |
// | 全部匹配                                     | original    | original                    |
//
// 条目级回退（usableEntry）：条目不存在、所属组缺失或加载失败、置信度 guess → null（调用方走程序化）。
import type { AssetEntry, PackManifestV1 } from '@rich4/shared/assets';
import type { MapCheck, PackState, SkinPref, SkinReason, SkinResolution } from './types';

export interface ResolveInput {
  pref: SkinPref;
  pack: PackState;
  /** 当前对局地图的匹配结果；不在对局中为 null */
  map: MapCheck | null;
  /** 在对局中但地图匹配还没算出来（素材包刚就绪）：按「加载中」处理 */
  mapPending?: boolean;
  /** 加载失败的组 */
  failedGroups?: Iterable<string>;
  /** 是否已注册原版棋盘渲染器（A6 之前为 false） */
  boardRenderer: boolean;
  /** 原版棋盘创建失败（本局改用程序化） */
  boardFailed?: boolean;
}

function packReason(pack: PackState): SkinReason | null {
  switch (pack.status) {
    case 'ready':
      return null;
    case 'idle':
    case 'loading':
      return 'pack-loading';
    case 'access-required':
      return 'access-required';
    case 'absent':
      if (pack.reason === 'invalid') return 'pack-invalid';
      if (pack.reason === 'network' || pack.reason === 'http') return 'pack-error';
      return 'pack-absent';
  }
}

const MAP_REASON: Readonly<Record<Exclude<MapCheck['status'], 'ok'>, SkinReason>> = {
  'no-board': 'no-board',
  missing: 'map-missing',
  mismatch: 'map-mismatch',
  'group-missing': 'group-missing',
};

export function resolveSkin(i: ResolveInput): SkinResolution {
  const packId = i.pack.status === 'ready' ? i.pack.manifest.packId : null;
  const mapId = i.map?.mapId ?? null;
  const base = { pref: i.pref, mapId, packId, mismatches: i.map?.mismatches ?? [] };
  const procedural = (reason: SkinReason): SkinResolution => ({
    ...base,
    skin: 'procedural',
    board: 'procedural',
    reason,
    boardReason: reason,
  });
  if (i.pref === 'procedural') return procedural('setting');
  const pr = packReason(i.pack);
  if (pr) return procedural(pr);
  if (i.mapPending) return procedural('pack-loading');
  if (!i.map) return { ...base, skin: 'original', board: 'procedural', reason: null, boardReason: null };

  let mapReason: SkinReason | null = i.map.status === 'ok' ? null : MAP_REASON[i.map.status];
  if (mapReason === null && i.map.group !== null && i.failedGroups) {
    for (const g of i.failedGroups) {
      if (g === i.map.group) mapReason = 'group-missing';
    }
  }
  if (mapReason) {
    // auto：只有地图也能用原版时才整体切到原版；强制 original：界面与语言照样原版，棋盘回退
    if (i.pref === 'auto') return procedural(mapReason);
    return { ...base, skin: 'original', board: 'procedural', reason: null, boardReason: mapReason };
  }
  if (!i.boardRenderer) {
    return { ...base, skin: 'original', board: 'procedural', reason: null, boardReason: 'renderer-unavailable' };
  }
  if (i.boardFailed) {
    return { ...base, skin: 'original', board: 'procedural', reason: null, boardReason: 'renderer-failed' };
  }
  return { ...base, skin: 'original', board: 'original', reason: null, boardReason: null };
}

export type EntryRejection = 'missing' | 'group-missing' | 'guess';

/** 条目级回退：可用时返回条目，否则返回拒绝原因 */
export function checkEntry(
  manifest: PackManifestV1,
  key: string,
  failedGroups?: ReadonlySet<string>,
  opts: { allowGuess?: boolean } = {},
): { entry: AssetEntry; rejected: null } | { entry: null; rejected: EntryRejection } {
  const e = Object.hasOwn(manifest.entries, key) ? manifest.entries[key] : undefined;
  if (!e) return { entry: null, rejected: 'missing' };
  if (!Object.hasOwn(manifest.groups, e.group) || failedGroups?.has(e.group)) {
    return { entry: null, rejected: 'group-missing' };
  }
  if (e.confidence === 'guess' && opts.allowGuess !== true) return { entry: null, rejected: 'guess' };
  return { entry: e, rejected: null };
}

/** 条目可用时返回它，否则 null（调用方走程序化回退） */
export function usableEntry(
  manifest: PackManifestV1 | null,
  key: string,
  failedGroups?: ReadonlySet<string>,
  opts: { allowGuess?: boolean } = {},
): AssetEntry | null {
  if (!manifest) return null;
  return checkEntry(manifest, key, failedGroups, opts).entry;
}
