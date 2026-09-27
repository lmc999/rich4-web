/**
 * 跨文件一致性检查：映射表、地图皮肤与 manifest.entries / files 的交叉引用。
 * `assets verify`、合成包生成器与客户端 PackClient（加载映射表后）共用；返回空数组表示通过。
 */
import type { ContractIssue } from './common';
import { sortedKeys } from './common';
import type { MapSkinV1 } from './mapskin';
import { type FlicMapV1, type MusicMapV1, type SfxSetsV1, type VoiceMapV1, voiceMapKeys } from './media';
import { type AssetEntryType, type AtlasV1, type PackManifestV1, type SpriteEntry, spriteFrameName } from './pack';

function entryTypeIssue(
  m: PackManifestV1,
  key: string,
  want: AssetEntryType,
  path: (string | number)[],
): ContractIssue | null {
  const e = Object.hasOwn(m.entries, key) ? m.entries[key] : undefined;
  if (!e) return { path, message: `条目 ${key} 不存在` };
  if (e.type !== want) return { path, message: `条目 ${key} 的类型应为 ${want}` };
  return null;
}

function collect(out: ContractIssue[], i: ContractIssue | null): void {
  if (i) out.push(i);
}

export function checkVoiceMapRefs(m: PackManifestV1, v: VoiceMapV1): ContractIssue[] {
  const out: ContractIssue[] = [];
  for (const key of voiceMapKeys(v)) collect(out, entryTypeIssue(m, key, 'audio', ['voice-map', key]));
  return out;
}

export function checkSfxSetsRefs(m: PackManifestV1, s: SfxSetsV1): ContractIssue[] {
  const out: ContractIssue[] = [];
  for (const name of sortedKeys(s.sets)) {
    s.sets[name]!.sfx.forEach((key, i) => {
      collect(out, entryTypeIssue(m, key, 'audio', ['sfx-sets', 'sets', name, 'sfx', i]));
    });
  }
  return out;
}

export function checkMusicMapRefs(m: PackManifestV1, mm: MusicMapV1): ContractIssue[] {
  const out: ContractIssue[] = [];
  mm.board.forEach((t, i) => {
    collect(out, entryTypeIssue(m, t.key, 'audio', ['music-map', 'board', i]));
  });
  for (const scene of sortedKeys(mm.scenes)) {
    const t = mm.scenes[scene as keyof typeof mm.scenes];
    if (t) collect(out, entryTypeIssue(m, t.key, 'audio', ['music-map', 'scenes', scene]));
  }
  return out;
}

/** flic-map 的每一项必须对应 type 'flic' 的条目，且尺寸、帧数、帧间隔、音效与条目一致 */
export function checkFlicMapRefs(m: PackManifestV1, f: FlicMapV1): ContractIssue[] {
  const out: ContractIssue[] = [];
  for (const key of sortedKeys(f.flics)) {
    const info = f.flics[key]!;
    const path = ['flic-map', 'flics', key];
    const issue = entryTypeIssue(m, key, 'flic', path);
    if (issue) {
      out.push(issue);
      continue;
    }
    const e = m.entries[key]!;
    if (e.type !== 'flic') continue;
    if (e.w !== info.w || e.h !== info.h || e.frames !== info.frames || e.frameMs !== info.frameMs) {
      out.push({ path, message: `与条目 ${key} 的尺寸、帧数或帧间隔不一致` });
    }
    if (e.sfx !== info.sfx) out.push({ path: [...path, 'sfx'], message: `与条目 ${key} 的同步音效不一致` });
    if ((e.transparency === 'opaque') !== info.opaque) {
      out.push({ path: [...path, 'opaque'], message: `与条目 ${key} 的透明规则不一致` });
    }
    if (info.sfx !== null) collect(out, entryTypeIssue(m, info.sfx, 'audio', [...path, 'sfx']));
  }
  return out;
}

/** 地图皮肤与 manifest：绑定一致、引用的精灵条目存在、地面切块文件存在且属于该地图的组 */
export function checkMapSkinRefs(m: PackManifestV1, skin: MapSkinV1): ContractIssue[] {
  const out: ContractIssue[] = [];
  const mp = Object.hasOwn(m.maps, skin.mapId) ? m.maps[skin.mapId] : undefined;
  if (!mp) return [{ path: ['maps', skin.mapId], message: `manifest.maps 中没有 ${skin.mapId}` }];
  const a = mp.binding;
  const b = skin.binding;
  if (
    a.resourceSha256 !== b.resourceSha256 ||
    a.geometry !== b.geometry ||
    a.counts.tiles !== b.counts.tiles ||
    a.counts.lots !== b.counts.lots ||
    a.counts.companies !== b.counts.companies
  ) {
    out.push({ path: ['binding'], message: 'skin.binding 与 manifest.maps 中的绑定不一致' });
  }
  const group = Object.hasOwn(m.groups, mp.group) ? m.groups[mp.group] : undefined;
  skin.ground.chunks.forEach((c, i) => {
    const f = Object.hasOwn(m.files, c.file) ? m.files[c.file] : undefined;
    if (f?.kind !== 'image')
      out.push({ path: ['ground', 'chunks', i], message: `切块文件 ${c.file} 不存在或不是 image` });
    else if (!group?.files.includes(c.file)) {
      out.push({ path: ['ground', 'chunks', i], message: `切块文件 ${c.file} 不在组 ${mp.group} 中` });
    }
  });
  const sprite = (key: string | null, path: (string | number)[]): void => {
    if (key !== null) collect(out, entryTypeIssue(m, key, 'sprite', path));
  };
  sprite(skin.minimap?.sprite ?? null, ['minimap', 'sprite']);
  sprite(skin.decor.sprite, ['decor', 'sprite']);
  const bd = skin.buildings;
  bd.house.levels.forEach((k, i) => {
    sprite(k, ['buildings', 'house', 'levels', i]);
  });
  sprite(bd.house.chain, ['buildings', 'house', 'chain']);
  sprite(bd.facilities.park, ['buildings', 'facilities', 'park']);
  for (const t of ['hotel', 'mall', 'gas', 'lab'] as const) {
    bd.facilities[t].forEach((k, i) => {
      sprite(k, ['buildings', 'facilities', t, i]);
    });
  }
  bd.companies.forEach((c, i) => {
    sprite(c.sprite, ['buildings', 'companies', i, 'sprite']);
  });
  sprite(bd.ownerMark, ['buildings', 'ownerMark']);
  sprite(bd.lotHighlight?.sprite ?? null, ['buildings', 'lotHighlight', 'sprite']);
  skin.scenery.forEach((s, i) => {
    sprite(s.sprite, ['scenery', i, 'sprite']);
  });
  return out;
}

/** 图集页与 manifest：meta.image / meta.r4.mask 必须是与图集同目录、kind 为 image 的文件，并且与图集在同一组 */
export function checkAtlasRefs(m: PackManifestV1, atlasPath: string, atlas: AtlasV1): ContractIssue[] {
  const af = Object.hasOwn(m.files, atlasPath) ? m.files[atlasPath] : undefined;
  if (af?.kind !== 'atlas') return [{ path: ['atlas'], message: `${atlasPath} 不是 manifest 中的图集` }];
  const out: ContractIssue[] = [];
  const dir = af.path.slice(0, af.path.lastIndexOf('/') + 1);
  const logicalByPath = new Map<string, string>();
  for (const lp of sortedKeys(m.files)) logicalByPath.set(m.files[lp]!.path, lp);
  const atlasGroups = sortedKeys(m.groups).filter((g) => m.groups[g]!.files.includes(atlasPath));
  const refs: [(string | number)[], string | null][] = [
    [['meta', 'image'], atlas.meta.image],
    [['meta', 'r4', 'mask'], atlas.meta.r4.mask],
  ];
  for (const [path, name] of refs) {
    if (name === null) continue;
    const lp = logicalByPath.get(dir + name);
    if (lp === undefined) {
      out.push({ path, message: `${dir + name} 不在 manifest.files 中` });
      continue;
    }
    if (m.files[lp]!.kind !== 'image') out.push({ path, message: `${lp} 的 kind 应为 image` });
    for (const g of atlasGroups) {
      if (!m.groups[g]!.files.includes(lp)) out.push({ path, message: `${lp} 不在图集所在的组 ${g} 中` });
    }
  }
  return out;
}

/** 精灵条目的每一帧都必须能在它的图集页里找到；ownerMask 要求每页都带掩膜 */
export function checkSpriteFrames(entry: SpriteEntry, pages: readonly AtlasV1[]): ContractIssue[] {
  const out: ContractIssue[] = [];
  const missing: string[] = [];
  for (let i = 0; i < entry.frames.count; i++) {
    const name = spriteFrameName(entry.frames.base, entry.frames.start + i);
    if (!pages.some((p) => Object.hasOwn(p.frames, name))) missing.push(name);
  }
  if (missing.length > 0) {
    const more = missing.length > 3 ? ` 等 ${missing.length} 帧` : '';
    out.push({ path: ['frames'], message: `图集中缺少帧 ${missing.slice(0, 3).join('、')}${more}` });
  }
  if (entry.ownerMask && pages.some((p) => p.meta.r4.mask === null)) {
    out.push({ path: ['ownerMask'], message: 'ownerMask 为 true，但有图集页没有主人色掩膜' });
  }
  return out;
}
