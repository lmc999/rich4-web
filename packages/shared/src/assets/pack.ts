/**
 * 素材包契约 PackManifestV1（schema 'rich4.assets/1'）与图集 AtlasV1（schema 'rich4.atlas/1'）。
 * 依据：docs/design/original-skin.md（定稿，§2 总体架构、§3 修正 4/5/9）、docs/research/original-assets/design-draft.md §2.5。
 *
 * 目录（默认 rich4-assets/，已被 .gitignore/.dockerignore 忽略）：
 *   manifest.json                         本文件描述的清单（不带哈希；服务器以 no-cache 提供，ETag = packId）
 *   maps/<mapId>.skin.<h8>.json           MapSkinV1
 *   ground/ sprites/ images/ flic/ masks/ audio/{voice,sfx,music}/ video/ data/   其余文件，文件名都带内容哈希前 8 位
 *
 * 三层结构，全部按逻辑名引用（不按原版资源号），便于日后按类别替换为 AI 素材：
 * - files：逻辑路径 → 实际文件（带哈希的 path、bytes、sha256、kind、contentType），服务器只提供这里列出的路径（白名单）；
 * - groups：懒加载与替换单元（每组一个类别、一个来源），列出组内全部逻辑路径；
 * - entries：逻辑键 → 资源描述（图集帧、锚点、帧数、帧间隔、透明规则、置信度、证据），客户端只认逻辑键。
 *
 * 分组命名建议：board.common · map.<mapId> · char.<c> · npc · object · fx.board · ui.hud · ui.dialog · venue.<name> ·
 * card · illustration.news · illustration.holiday · portrait · mg.<id> · title · voice.npc · voice.char.<c> ·
 * sfx.<set> · music.board · music.scene · video · data。
 */
import { z } from 'zod';
import { canonicalJson } from '../util/canonicalJson';
import { sha256Hex } from '../util/sha256';
import {
  ASSET_SCHEMA,
  AssetCategorySchema,
  type AssetParseResult,
  ConfidenceSchema,
  type ContentType,
  ContentTypeSchema,
  type ContractIssue,
  contentTypeForPath,
  EditionSchema,
  EvidenceSchema,
  type FileKind,
  FileKindSchema,
  hashedPath,
  isStrictlySorted,
  KIND_CONTENT_TYPES,
  LogicalKeySchema,
  MapIdSchema,
  NonNegIntSchema,
  PACK_LICENSE,
  PackPathSchema,
  PointSchema,
  PosIntSchema,
  ProvenanceSchema,
  pathExt,
  reportIssues,
  runParse,
  runSafeParse,
  Sha256HexSchema,
  sortedKeys,
  TransparencySchema,
} from './common';
import { MapSkinBindingSchema } from './mapskin';

// ───────────────────────── files ─────────────────────────

const VariantSchema = z.strictObject({ bytes: NonNegIntSchema, sha256: Sha256HexSchema });

export const PackFileSchema = z.strictObject({
  /** 带哈希的实际路径，必须等于 hashedPath(逻辑路径, sha256) */
  path: PackPathSchema,
  bytes: NonNegIntSchema,
  sha256: Sha256HexSchema,
  kind: FileKindSchema,
  /** 必须与扩展名一致，且在该 kind 允许的类型内 */
  contentType: ContentTypeSchema,
  /** 预压缩变体（`<path>.br` / `<path>.gz`），服务器在 Accept-Encoding 允许时返回 */
  variants: z.strictObject({ br: VariantSchema.optional(), gzip: VariantSchema.optional() }).optional(),
});
export type PackFile = z.output<typeof PackFileSchema>;

// ───────────────────────── groups ─────────────────────────

export const PackGroupSchema = z.strictObject({
  category: AssetCategorySchema,
  provenance: ProvenanceSchema,
  /** 组内全部逻辑路径（files 的键），升序且唯一；加载该组即下载这些文件 */
  files: z.array(PackPathSchema),
  /** Σ files[].bytes（不含预压缩变体） */
  bytes: NonNegIntSchema,
});
export type PackGroup = z.output<typeof PackGroupSchema>;

// ───────────────────────── entries ─────────────────────────

/** 图集帧名的前缀（原版建议用资源号，如 `Data#88`；替换素材可用任意名） */
export const FRAME_BASE_RE = /^[A-Za-z0-9#._-]{1,48}$/;
/** 图集帧名：`<base>/<index>` */
export const FRAME_NAME_RE = /^[A-Za-z0-9#._-]{1,48}\/\d{1,4}$/;

export function spriteFrameName(base: string, index: number): string {
  return `${base}/${index}`;
}

const entryBase = {
  /** 所属组（懒加载与替换单元） */
  group: LogicalKeySchema,
  confidence: ConfidenceSchema,
  /** 证据：第一项放原版资源号（如 `Data#88`），其后为 exe 地址或样图名 */
  src: EvidenceSchema,
};

/**
 * 图集精灵（SPR/SMP 派生，或替换素材）。第 i 帧（0 ≤ i < frames.count）的帧名为 `${frames.base}/${frames.start + i}`，
 * 在 atlas 列出的任一图集 JSON 里查找；每帧的像素尺寸与锚点（落点 = 画点 − 锚点）写在图集里。
 * dirs=8 时帧序为方向主序：帧 = 方向槽 × perDir + 动画帧，perDir = count / 8（见 frames.ts）。
 */
export const SpriteEntrySchema = z.strictObject({
  type: z.literal('sprite'),
  ...entryBase,
  /** 图集 JSON 的逻辑路径（kind 'atlas'），至少一页 */
  atlas: z.array(PackPathSchema).min(1),
  frames: z.strictObject({ base: z.string().regex(FRAME_BASE_RE), start: NonNegIntSchema, count: PosIntSchema }),
  dirs: z.literal([1, 8]),
  /** 动画帧间隔（ms）；静态或由调用方逐帧选择时为 null */
  frameMs: PosIntSchema.nullable(),
  transparency: TransparencySchema,
  /** 是否带主人色掩膜（原版 map.mkf 建筑类 SPR 的调色板 255；掩膜页由图集 meta.r4.mask 给出） */
  ownerMask: z.boolean(),
  /** frame = 用图集里的逐帧锚点；center = 以帧中心为锚点（原版装饰圆盘） */
  anchor: z.enum(['frame', 'center']),
});

/** 单张整图（RAW16 派生：卡片、新闻/命运插图、节日图、Loading、整屏背景等） */
export const ImageEntrySchema = z.strictObject({
  type: z.literal('image'),
  ...entryBase,
  file: PackPathSchema,
  w: PosIntSchema,
  h: PosIntSchema,
  transparency: TransparencySchema,
  /** 锚点（像素）；null 表示左上角 */
  anchor: PointSchema.nullable(),
});

/** 解压后的 FLC 动画（客户端自写解码器逐帧画到单张画布；索引 0 透明，3 段例外为 opaque） */
export const FlicEntrySchema = z.strictObject({
  type: z.literal('flic'),
  ...entryBase,
  file: PackPathSchema,
  w: PosIntSchema,
  h: PosIntSchema,
  /** 头部帧数（不含 ring 帧） */
  frames: PosIntSchema,
  /** 头部 +0x10 的帧间隔（ms） */
  frameMs: PosIntSchema,
  /** 原版时长 = frames × frameMs */
  durationMs: PosIntSchema,
  transparency: z.enum(['index0', 'opaque']),
  /** 首帧同步播放的音效条目（原版 0x452a83）；无则 null */
  sfx: LogicalKeySchema.nullable(),
});

/** 命中区域图（Panel#8/#19/#22/#81 派生）：8 位灰度 PNG，像素值即区号（0 = 无） */
export const MaskEntrySchema = z.strictObject({
  type: z.literal('mask'),
  ...entryBase,
  file: PackPathSchema,
  w: PosIntSchema,
  h: PosIntSchema,
  /** 最大区号（区号为 1..regions） */
  regions: PosIntSchema.max(255),
});

/** 音频（语音、音效、音乐）；opus 为主、m4a 为旧 iOS 回退 */
export const AudioEntrySchema = z.strictObject({
  type: z.literal('audio'),
  ...entryBase,
  files: z.strictObject({ opus: PackPathSchema.optional(), m4a: PackPathSchema.optional() }),
  durationMs: PosIntSchema,
  channels: z.literal([1, 2]),
  sampleRate: PosIntSchema,
  /** 场景曲的循环区间（已按首尾静音裁剪时为 [0, durationMs]）；不循环为 null */
  loop: z.strictObject({ startMs: NonNegIntSchema, endMs: PosIntSchema }).nullable(),
});

/** 过场视频（AVI 转码，可选） */
export const VideoEntrySchema = z.strictObject({
  type: z.literal('video'),
  ...entryBase,
  files: z.strictObject({ mp4: PackPathSchema.optional(), webm: PackPathSchema.optional() }),
  w: PosIntSchema,
  h: PosIntSchema,
  durationMs: PosIntSchema,
});

/** 映射表等数据 JSON（voice-map / sfx-sets / music-map / flic-map） */
export const DATA_SCHEMAS = [
  ASSET_SCHEMA.voiceMap,
  ASSET_SCHEMA.sfxSets,
  ASSET_SCHEMA.musicMap,
  ASSET_SCHEMA.flicMap,
] as const;

export const DataEntrySchema = z.strictObject({
  type: z.literal('data'),
  ...entryBase,
  file: PackPathSchema,
  schema: z.enum(DATA_SCHEMAS),
});

/** 数据条目的固定逻辑键 */
export const DATA_KEYS = {
  voiceMap: 'data.voice-map',
  sfxSets: 'data.sfx-sets',
  musicMap: 'data.music-map',
  flicMap: 'data.flic-map',
} as const;

const DATA_KEY_SCHEMA: Readonly<Record<string, string>> = {
  [DATA_KEYS.voiceMap]: ASSET_SCHEMA.voiceMap,
  [DATA_KEYS.sfxSets]: ASSET_SCHEMA.sfxSets,
  [DATA_KEYS.musicMap]: ASSET_SCHEMA.musicMap,
  [DATA_KEYS.flicMap]: ASSET_SCHEMA.flicMap,
};

export const AssetEntrySchema = z.discriminatedUnion('type', [
  SpriteEntrySchema,
  ImageEntrySchema,
  FlicEntrySchema,
  MaskEntrySchema,
  AudioEntrySchema,
  VideoEntrySchema,
  DataEntrySchema,
]);
export type AssetEntry = z.output<typeof AssetEntrySchema>;
export type AssetEntryType = AssetEntry['type'];
export type SpriteEntry = z.output<typeof SpriteEntrySchema>;
export type ImageEntry = z.output<typeof ImageEntrySchema>;
export type FlicEntry = z.output<typeof FlicEntrySchema>;
export type MaskEntry = z.output<typeof MaskEntrySchema>;
export type AudioEntry = z.output<typeof AudioEntrySchema>;
export type VideoEntry = z.output<typeof VideoEntrySchema>;
export type DataEntry = z.output<typeof DataEntrySchema>;

export interface EntryFileRef {
  /** 相对条目的字段路径 */
  field: (string | number)[];
  /** 逻辑路径 */
  file: string;
  kind: FileKind;
}

/** 条目依赖的全部文件（逻辑路径），按字段顺序 */
export function entryFileRefs(e: AssetEntry): EntryFileRef[] {
  switch (e.type) {
    case 'sprite':
      return e.atlas.map((file, i) => ({ field: ['atlas', i], file, kind: 'atlas' as const }));
    case 'image':
      return [{ field: ['file'], file: e.file, kind: 'image' }];
    case 'flic':
      return [{ field: ['file'], file: e.file, kind: 'flic' }];
    case 'mask':
      return [{ field: ['file'], file: e.file, kind: 'mask' }];
    case 'data':
      return [{ field: ['file'], file: e.file, kind: 'data' }];
    case 'audio': {
      const out: EntryFileRef[] = [];
      if (e.files.opus !== undefined) out.push({ field: ['files', 'opus'], file: e.files.opus, kind: 'audio' });
      if (e.files.m4a !== undefined) out.push({ field: ['files', 'm4a'], file: e.files.m4a, kind: 'audio' });
      return out;
    }
    case 'video': {
      const out: EntryFileRef[] = [];
      if (e.files.mp4 !== undefined) out.push({ field: ['files', 'mp4'], file: e.files.mp4, kind: 'video' });
      if (e.files.webm !== undefined) out.push({ field: ['files', 'webm'], file: e.files.webm, kind: 'video' });
      return out;
    }
  }
}

// ───────────────────────── maps ─────────────────────────

export const PackMapSchema = z.strictObject({
  /** MapSkinV1 的逻辑路径（kind 'mapskin'） */
  skin: PackPathSchema,
  group: LogicalKeySchema,
  /** 与 skin 内 binding 相同；客户端不必先下载 skin 就能判断是否匹配 */
  binding: MapSkinBindingSchema,
});
export type PackMap = z.output<typeof PackMapSchema>;

// ───────────────────────── manifest ─────────────────────────

export const PackFeaturesSchema = z.strictObject({
  board: z.boolean(),
  ui: z.boolean(),
  fx: z.boolean(),
  minigames: z.boolean(),
  audio: z.boolean(),
  voice: z.boolean(),
  music: z.boolean(),
  video: z.boolean(),
});
export type PackFeatures = z.output<typeof PackFeaturesSchema>;

export const PackManifestV1BaseSchema = z.strictObject({
  schema: z.literal(ASSET_SCHEMA.manifest),
  /** 除 packId 外的规范化 manifest 的 sha256 前 16 位（computePackId）；服务器用作 manifest 的 ETag */
  packId: z.string().regex(/^[0-9a-f]{16}$/, 'packId 必须是 16 位小写 hex'),
  /** 生成器与版本，例如 `rich4-extract/assets@1` */
  generator: z.string().min(1).max(64),
  edition: EditionSchema,
  license: z.literal(PACK_LICENSE),
  /** 源文件指纹：键为 original/ 下的相对路径（如 `Game/Data.mkf`）；合成包为空表 */
  source: z.strictObject({
    files: z.record(PackPathSchema, z.strictObject({ sha256: Sha256HexSchema, bytes: NonNegIntSchema })),
    exeSha256: Sha256HexSchema.nullable(),
  }),
  /** 转码工具版本（音视频只做参数级确定；ffmpeg 版本变化会改变字节） */
  tools: z.strictObject({ ffmpeg: z.string().min(1).max(200).nullable() }),
  features: PackFeaturesSchema,
  groups: z.record(LogicalKeySchema, PackGroupSchema),
  files: z.record(PackPathSchema, PackFileSchema),
  entries: z.record(LogicalKeySchema, AssetEntrySchema),
  maps: z.record(MapIdSchema, PackMapSchema),
});
type PackManifestShape = z.output<typeof PackManifestV1BaseSchema>;

/** packId = sha256(canonicalJson(除 packId 外的 manifest)) 的前 16 位 */
export function computePackId(m: Omit<PackManifestShape, 'packId'> & { packId?: string }): string {
  const { packId: _omit, ...rest } = m;
  return sha256Hex(canonicalJson(rest)).slice(0, 16);
}

/** 返回写好 packId 的新对象（extract 与合成包生成器用） */
export function withPackId(m: Omit<PackManifestShape, 'packId'>): PackManifestV1 {
  return { ...m, packId: computePackId(m) };
}

/** manifest 的一致性检查（结构之外）；返回空数组表示通过 */
export function checkPackManifest(m: PackManifestShape): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const push = (path: (string | number)[], message: string): void => {
    issues.push({ path, message });
  };

  // files：路径带哈希、扩展名与 Content-Type、kind 一致
  for (const lp of sortedKeys(m.files)) {
    const f = m.files[lp]!;
    const expected = hashedPath(lp, f.sha256);
    if (f.path !== expected) push(['files', lp, 'path'], `path 必须为 ${expected}`);
    const ct = contentTypeForPath(f.path);
    if (ct === null) push(['files', lp, 'path'], `扩展名 ${pathExt(f.path) || '(无)'} 不在白名单内`);
    else if (ct !== f.contentType && !(pathExt(f.path) === '.webm' && f.contentType === 'audio/webm')) {
      push(['files', lp, 'contentType'], `扩展名要求 ${ct}`);
    }
    if (!KIND_CONTENT_TYPES[f.kind].includes(f.contentType)) {
      push(['files', lp, 'contentType'], `${f.kind} 不允许 ${f.contentType}`);
    }
  }

  // groups：文件存在、升序唯一、字节数闭合；每个文件至少属于一个组
  const memberOf = new Map<string, Set<string>>();
  for (const g of sortedKeys(m.groups)) {
    const grp = m.groups[g]!;
    if (!isStrictlySorted(grp.files)) push(['groups', g, 'files'], 'files 必须升序且唯一');
    let bytes = 0;
    grp.files.forEach((lp, i) => {
      const f = Object.hasOwn(m.files, lp) ? m.files[lp] : undefined;
      if (!f) {
        push(['groups', g, 'files', i], `文件 ${lp} 不在 files 中`);
        return;
      }
      bytes += f.bytes;
      const set = memberOf.get(lp);
      if (set) set.add(g);
      else memberOf.set(lp, new Set([g]));
    });
    if (bytes !== grp.bytes) push(['groups', g, 'bytes'], `bytes 应为 ${bytes}`);
  }
  for (const lp of sortedKeys(m.files)) {
    if (!memberOf.has(lp)) push(['files', lp], '文件不属于任何组');
  }

  const inGroup = (lp: string, g: string): boolean => memberOf.get(lp)?.has(g) ?? false;
  const checkRef = (base: (string | number)[], field: (string | number)[], lp: string, kind: FileKind, g: string) => {
    const f = Object.hasOwn(m.files, lp) ? m.files[lp] : undefined;
    if (!f) push([...base, ...field], `文件 ${lp} 不在 files 中`);
    else if (f.kind !== kind) push([...base, ...field], `文件 ${lp} 的 kind 应为 ${kind}`);
    else if (!inGroup(lp, g)) push([...base, ...field], `文件 ${lp} 不在组 ${g} 中`);
  };
  /** 按格式键引用的文件必须是对应的容器（客户端按 canPlayType 选格式） */
  const expectType = (
    base: (string | number)[],
    field: (string | number)[],
    lp: string | undefined,
    types: readonly ContentType[],
  ): void => {
    if (lp === undefined) return;
    const f = Object.hasOwn(m.files, lp) ? m.files[lp] : undefined;
    if (f && !types.includes(f.contentType)) {
      push([...base, ...field], `文件 ${lp} 的 Content-Type 应为 ${types.join(' 或 ')}`);
    }
  };

  // entries：组存在、引用的文件存在且在同组、按类型的自洽检查
  for (const key of sortedKeys(m.entries)) {
    const e = m.entries[key]!;
    const base = ['entries', key];
    if (!Object.hasOwn(m.groups, e.group)) push([...base, 'group'], `组 ${e.group} 不存在`);
    for (const ref of entryFileRefs(e)) checkRef(base, ref.field, ref.file, ref.kind, e.group);
    switch (e.type) {
      case 'sprite':
        if (e.frames.count % e.dirs !== 0) push([...base, 'frames', 'count'], `帧数必须是 dirs=${e.dirs} 的整数倍`);
        break;
      case 'flic':
        if (e.durationMs !== e.frames * e.frameMs)
          push([...base, 'durationMs'], 'durationMs 必须等于 frames × frameMs');
        if (e.sfx !== null) {
          const s = Object.hasOwn(m.entries, e.sfx) ? m.entries[e.sfx] : undefined;
          if (s?.type !== 'audio') push([...base, 'sfx'], `音效条目 ${e.sfx} 不存在或不是 audio`);
        }
        break;
      case 'audio':
        if (e.files.opus === undefined && e.files.m4a === undefined) push([...base, 'files'], '至少需要一种音频格式');
        expectType(base, ['files', 'opus'], e.files.opus, ['audio/ogg', 'audio/webm']);
        expectType(base, ['files', 'm4a'], e.files.m4a, ['audio/mp4']);
        if (e.loop && !(e.loop.startMs < e.loop.endMs && e.loop.endMs <= e.durationMs)) {
          push([...base, 'loop'], '循环区间必须满足 0 ≤ startMs < endMs ≤ durationMs');
        }
        break;
      case 'video':
        if (e.files.mp4 === undefined && e.files.webm === undefined) push([...base, 'files'], '至少需要一种视频格式');
        expectType(base, ['files', 'mp4'], e.files.mp4, ['video/mp4']);
        expectType(base, ['files', 'webm'], e.files.webm, ['video/webm']);
        break;
      case 'data': {
        const want = Object.hasOwn(DATA_KEY_SCHEMA, key) ? DATA_KEY_SCHEMA[key] : undefined;
        if (want !== undefined && want !== e.schema) push([...base, 'schema'], `${key} 的 schema 应为 ${want}`);
        break;
      }
      default:
        break;
    }
  }

  // maps
  for (const id of sortedKeys(m.maps)) {
    const mp = m.maps[id]!;
    if (!Object.hasOwn(m.groups, mp.group)) push(['maps', id, 'group'], `组 ${mp.group} 不存在`);
    checkRef(['maps', id], ['skin'], mp.skin, 'mapskin', mp.group);
  }

  if (m.packId !== computePackId(m)) push(['packId'], 'packId 与内容不符');
  return issues;
}

export const PackManifestV1Schema = PackManifestV1BaseSchema.superRefine((m, ctx) =>
  reportIssues(ctx, checkPackManifest(m)),
);
export type PackManifestV1 = z.output<typeof PackManifestV1Schema>;

/** 结构与一致性校验；PackClient 把失败（以及非 JSON）一律视为「没有素材包」 */
export function safeParsePackManifest(json: unknown): AssetParseResult<PackManifestV1> {
  return runSafeParse(PackManifestV1Schema, json);
}

/** 结构与一致性校验；失败抛 AssetContractError */
export function parsePackManifest(json: unknown): PackManifestV1 {
  return runParse(ASSET_SCHEMA.manifest, PackManifestV1Schema, json);
}

/** manifest 列出的全部可提供路径（实际路径与预压缩变体），升序；服务器 `/pack/*` 白名单 */
export function packServablePaths(m: PackManifestV1): string[] {
  const out: string[] = [];
  for (const lp of sortedKeys(m.files)) {
    const f = m.files[lp]!;
    out.push(f.path);
    if (f.variants?.br) out.push(`${f.path}.br`);
    if (f.variants?.gzip) out.push(`${f.path}.gz`);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 组内全部条目的逻辑键（升序） */
export function groupEntryKeys(m: PackManifestV1, group: string): string[] {
  return sortedKeys(m.entries).filter((k) => m.entries[k]!.group === group);
}

// ───────────────────────── 图集 AtlasV1 ─────────────────────────

const RectSchema = z.strictObject({ x: NonNegIntSchema, y: NonNegIntSchema, w: PosIntSchema, h: PosIntSchema });

/**
 * 与 Pixi Spritesheet（TexturePacker hash）兼容的帧：不旋转、不裁边；anchor = 锚点像素 / 帧尺寸（可为负或超出 [0,1]）。
 * 原版空帧（w 或 h 为 0）由 extract 补成 1×1 透明像素、锚点不变。
 */
export const AtlasFrameSchema = z.strictObject({
  frame: RectSchema,
  rotated: z.literal(false),
  trimmed: z.literal(false),
  spriteSourceSize: z.strictObject({ x: z.literal(0), y: z.literal(0), w: PosIntSchema, h: PosIntSchema }),
  sourceSize: z.strictObject({ w: PosIntSchema, h: PosIntSchema }),
  anchor: z.strictObject({ x: z.number(), y: z.number() }),
  /** 9-slice 边距（像素），供 NineSliceSprite / border-image 使用 */
  borders: z
    .strictObject({ left: NonNegIntSchema, top: NonNegIntSchema, right: NonNegIntSchema, bottom: NonNegIntSchema })
    .optional(),
});
export type AtlasFrame = z.output<typeof AtlasFrameSchema>;

/** 与图集 JSON 同目录的文件名（带哈希） */
const SIBLING_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const AtlasV1BaseSchema = z.strictObject({
  schema: z.literal(ASSET_SCHEMA.atlas),
  frames: z.record(z.string().regex(FRAME_NAME_RE), AtlasFrameSchema),
  meta: z.strictObject({
    app: z.string().min(1).max(64),
    version: z.string().min(1).max(16),
    /** 图集页位图（与本 JSON 同目录的带哈希文件名） */
    image: z.string().max(200).regex(SIBLING_FILE_RE),
    format: z.literal('RGBA8888'),
    size: z.strictObject({ w: PosIntSchema.max(4096), h: PosIntSchema.max(4096) }),
    scale: z.literal('1'),
    r4: z.strictObject({
      /** 每帧锚点（整数像素）：落点 = 画点 − 锚点 */
      anchorsPx: z.record(z.string().regex(FRAME_NAME_RE), z.tuple([z.int(), z.int()])),
      /** 主人色掩膜页（同布局的白色掩膜，同目录文件名）；没有则 null */
      mask: z.string().max(200).regex(SIBLING_FILE_RE).nullable(),
      transparency: TransparencySchema,
      src: EvidenceSchema,
    }),
  }),
});
type AtlasShape = z.output<typeof AtlasV1BaseSchema>;

export function checkAtlas(a: AtlasShape): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const { w: W, h: H } = a.meta.size;
  const names = sortedKeys(a.frames);
  const anchorNames = sortedKeys(a.meta.r4.anchorsPx);
  if (names.join('\n') !== anchorNames.join('\n')) {
    issues.push({ path: ['meta', 'r4', 'anchorsPx'], message: 'anchorsPx 的键必须与 frames 完全一致' });
  }
  for (const n of names) {
    const f = a.frames[n]!;
    const { x, y, w, h } = f.frame;
    if (x + w > W || y + h > H) issues.push({ path: ['frames', n, 'frame'], message: '帧超出图集页' });
    if (f.sourceSize.w !== w || f.sourceSize.h !== h) {
      issues.push({ path: ['frames', n, 'sourceSize'], message: 'sourceSize 必须等于帧尺寸（不裁边）' });
    }
    if (f.spriteSourceSize.w !== w || f.spriteSourceSize.h !== h) {
      issues.push({ path: ['frames', n, 'spriteSourceSize'], message: 'spriteSourceSize 必须等于帧尺寸（不裁边）' });
    }
    const px = Object.hasOwn(a.meta.r4.anchorsPx, n) ? a.meta.r4.anchorsPx[n] : undefined;
    if (px && (f.anchor.x !== px[0] / w || f.anchor.y !== px[1] / h)) {
      issues.push({ path: ['frames', n, 'anchor'], message: 'anchor 必须等于 anchorsPx / 帧尺寸' });
    }
    if (f.borders && (f.borders.left + f.borders.right > w || f.borders.top + f.borders.bottom > h)) {
      issues.push({ path: ['frames', n, 'borders'], message: '9-slice 边距超出帧尺寸' });
    }
  }
  return issues;
}

export const AtlasV1Schema = AtlasV1BaseSchema.superRefine((a, ctx) => reportIssues(ctx, checkAtlas(a)));
export type AtlasV1 = z.output<typeof AtlasV1Schema>;

export function safeParseAtlas(json: unknown): AssetParseResult<AtlasV1> {
  return runSafeParse(AtlasV1Schema, json);
}

export function parseAtlas(json: unknown): AtlasV1 {
  return runParse(ASSET_SCHEMA.atlas, AtlasV1Schema, json);
}

/** 用整数锚点生成图集帧（extract 与合成包生成器用，保证 anchor 与 anchorsPx 一致） */
export function atlasFrame(rect: { x: number; y: number; w: number; h: number }, ax: number, ay: number): AtlasFrame {
  return {
    frame: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    rotated: false,
    trimmed: false,
    spriteSourceSize: { x: 0, y: 0, w: rect.w, h: rect.h },
    sourceSize: { w: rect.w, h: rect.h },
    anchor: { x: ax / rect.w, y: ay / rect.h },
  };
}
