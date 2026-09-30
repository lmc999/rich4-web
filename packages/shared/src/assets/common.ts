/**
 * 素材包契约的公共原语（docs/design/original-skin.md §2、§3 修正 5/9；design-draft §2.5）。
 *
 * - shared/assets 只依赖 shared/util：零 IO、确定性、浏览器可用（client、server、tools/extract 共用）。
 * - 素材包仅供私人与朋友游玩：由用户自己的 Steam 正版离线派生到 rich4-assets/ 或 .cache/**，不入库、不进镜像、不公开。
 * - 所有引用一律按「逻辑键 / 逻辑路径」，不按原版资源号；原版编号只作为证据（src）出现，便于日后按类别替换为 AI 素材。
 */
import { z } from 'zod';

// ───────────────────────── schema 标识与派生标记 ─────────────────────────

/** 素材包里每种 JSON 文件顶层的 `schema` 字段（scripts/check-no-original 按它拦截入库） */
export const ASSET_SCHEMA = {
  manifest: 'rich4.assets/1',
  mapSkin: 'rich4.mapskin/1',
  atlas: 'rich4.atlas/1',
  voiceMap: 'rich4.voicemap/1',
  sfxSets: 'rich4.sfxsets/1',
  musicMap: 'rich4.musicmap/1',
  flicMap: 'rich4.flicmap/1',
} as const;

export type AssetSchemaId = (typeof ASSET_SCHEMA)[keyof typeof ASSET_SCHEMA];

/** 全部派生 JSON 的 schema 标识（按 ASSET_SCHEMA 声明顺序） */
export const DERIVED_JSON_SCHEMAS: readonly AssetSchemaId[] = Object.freeze([
  ASSET_SCHEMA.manifest,
  ASSET_SCHEMA.mapSkin,
  ASSET_SCHEMA.atlas,
  ASSET_SCHEMA.voiceMap,
  ASSET_SCHEMA.sfxSets,
  ASSET_SCHEMA.musicMap,
  ASSET_SCHEMA.flicMap,
]);

/**
 * tools/extract A3 的详表与暂存 JSON（素材包 data/detail/ 与 .cache/assets-staging/data/）的 schema 标识。
 * 不属于客户端契约，但同样是原版派生物，scripts/check-no-original 按它们拦截入库（与契约版名字不同：带连字符）。
 */
export const DERIVED_DETAIL_JSON_SCHEMAS: readonly string[] = Object.freeze([
  'rich4.voice-map/1',
  'rich4.sfx-sets/1',
  'rich4.music-map/1',
  'rich4.flic-map/1',
  'rich4.video-map/1',
]);

/** manifest.license 的唯一取值 */
export const PACK_LICENSE = 'private-personal-use' as const;

/**
 * 派生标记：extract 写入，scripts/check-no-original 与镜像扫描识别。均为常量，不影响输出确定性。
 * - PNG：tEXt 关键字 `rich4:derived`，文本 `private`；
 * - Opus / m4a / MP4：comment `RICH4_DERIVED=1`（ffmpeg `-metadata comment=…`，同时 `-map_metadata -1 -fflags +bitexact`；
 *   音频与视频共用同一个值，videoComment 与 audioComment 相同）。
 */
export const DERIVED_MARKERS = {
  pngTextKeyword: 'rich4:derived',
  pngTextValue: 'private',
  audioComment: 'RICH4_DERIVED=1',
  videoComment: 'RICH4_DERIVED=1',
} as const;

// ───────────────────────── 基础取值 ─────────────────────────

export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
/** 逻辑键：点分段，每段以字母或数字开头，只含 [A-Za-z0-9_-]，例如 `char.3.walk`、`ui.hud.toolbar`、`sfx.042` */
export const LOGICAL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)*$/;
/**
 * 包内相对路径（逻辑路径与带哈希的实际路径共用）：posix、无前导 `/`、各段以字母或数字开头、只含 [A-Za-z0-9._-]。
 * 因为段首不能是 `.`，所以天然排除 `.`、`..` 与隐藏文件，服务器可以直接拿它做白名单。
 */
export const PACK_PATH_RE = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** MapDef.id 的形状（taiwan、test、test-allkinds） */
export const MAP_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
/** MapDef 的 LotId：住宅 L、设施 F、企业 C，1 基 */
export const LOT_ID_RE = /^[LFC][1-9]\d*$/;

export const Sha256HexSchema = z.string().regex(SHA256_HEX_RE, 'sha256 必须是 64 位小写 hex');
export const LogicalKeySchema = z.string().max(128).regex(LOGICAL_KEY_RE, '逻辑键格式不正确');
export const PackPathSchema = z.string().max(240).regex(PACK_PATH_RE, '包内路径格式不正确');
export const MapIdSchema = z.string().max(64).regex(MAP_ID_RE, '地图 id 格式不正确');
export const LotIdSchema = z.string().max(16).regex(LOT_ID_RE, 'LotId 必须形如 L1 / F1 / C1');

/** 语义置信度：exe = 有反汇编证据；visual = 只有目视依据；guess = 推测（前端默认回退程序化） */
export const ConfidenceSchema = z.enum(['exe', 'visual', 'guess']);
export type Confidence = z.output<typeof ConfidenceSchema>;

/** 素材来源：original = 原版派生；ai = AI 生成替换；synthetic = CI 合成包；custom = 手工素材 */
export const ProvenanceSchema = z.enum(['original', 'ai', 'synthetic', 'custom']);
export type Provenance = z.output<typeof ProvenanceSchema>;

/** 原版版本：v2.06（original/Game，默认基准）或 v3.11（MultiverseJourney） */
export const EditionSchema = z.enum(['v206', 'v311']);
export type Edition = z.output<typeof EditionSchema>;

/** 证据：原版资源号（如 `Data#88`）、exe 地址（如 `VA 0x40b5cb`）、样图名等，第一项放最主要的来源 */
export const EvidenceSchema = z.array(z.string().min(1).max(200)).max(32);

export const NonNegIntSchema = z.int().nonnegative();
export const PosIntSchema = z.int().positive();

export const PointSchema = z.strictObject({ x: z.int(), y: z.int() });
export type Point = z.output<typeof PointSchema>;
export const SizeSchema = z.strictObject({ w: PosIntSchema, h: PosIntSchema });
export type Size = z.output<typeof SizeSchema>;

/**
 * 懒加载与替换的类别。每个组（group）只属于一个类别，替换为 AI 素材时整组替换：
 * board 棋盘（地面、小地图、装饰、建筑、景观、地块标记）· actor 角色棋子 · npc 恶人与娃娃 · object 路面物件与路上神明 ·
 * fx 棋盘 FLIC 特效 · ui 界面（工具列、资料栏、对话框、光标、预画字模）· venue 场所屏 · card 卡片与道具图 ·
 * illustration 新闻/命运/节日插图 · portrait 头像、讲话表情、表情动画 · minigame 小游戏 · title 标题/选人/开局/Loading/跳伞 ·
 * voice 语音 · sfx 音效 · music 音乐 · video 过场视频 · data 映射表等数据
 */
export const ASSET_CATEGORIES = [
  'board',
  'actor',
  'npc',
  'object',
  'fx',
  'ui',
  'venue',
  'card',
  'illustration',
  'portrait',
  'minigame',
  'title',
  'voice',
  'sfx',
  'music',
  'video',
  'data',
] as const;
export const AssetCategorySchema = z.enum(ASSET_CATEGORIES);
export type AssetCategory = z.output<typeof AssetCategorySchema>;

/**
 * 透明规则（记录派生时采用的规则；PNG 已带 alpha）：
 * index0 = 调色板索引 0 透明（SPR、FLIC）· rgb0 = RGB555 值 0 透明（SMP）· rgb0-backdrop = 同 rgb0，但整屏背景需先铺黑底 ·
 * corner-rgb0 = 只有四角连通的 0 值透明（旧素材包的卡片插画用过；原版卡片插画是不透明整图，exe 0x440c95，新包不再产出）·
 * opaque = 不透明（GND、RAW16 背景与卡片插画、Panel#16/#20、jump#42）·
 * alpha = 素材自带 alpha（替换素材）
 */
export const TransparencySchema = z.enum(['index0', 'rgb0', 'rgb0-backdrop', 'corner-rgb0', 'opaque', 'alpha']);
export type Transparency = z.output<typeof TransparencySchema>;

// ───────────────────────── 文件类型 ─────────────────────────

/** 包内允许的扩展名 → Content-Type。只列安全的静态类型：绝不出现 text/html、image/svg+xml、脚本等可执行类型 */
export const CONTENT_TYPE_BY_EXT = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.json': 'application/json',
  '.flc': 'application/octet-stream',
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.weba': 'audio/webm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
} as const;

export type PackExt = keyof typeof CONTENT_TYPE_BY_EXT;

export const CONTENT_TYPES = [
  'image/png',
  'image/webp',
  'image/avif',
  'application/json',
  'application/octet-stream',
  'audio/ogg',
  'audio/mp4',
  'audio/webm',
  'video/mp4',
  'video/webm',
] as const;
export const ContentTypeSchema = z.enum(CONTENT_TYPES);
export type ContentType = z.output<typeof ContentTypeSchema>;

/**
 * 文件种类：image 位图（图集页、整图、地面切块、主人色掩膜）· atlas 图集 JSON（AtlasV1）· mask 区域图（8 位灰度 PNG，值即区号）·
 * flic 解压后的 FLC · audio 音频 · video 视频 · data 映射表 JSON · mapskin 地图皮肤 JSON（MapSkinV1）
 */
export const FILE_KINDS = ['image', 'atlas', 'mask', 'flic', 'audio', 'video', 'data', 'mapskin'] as const;
export const FileKindSchema = z.enum(FILE_KINDS);
export type FileKind = z.output<typeof FileKindSchema>;

/** 每种文件允许的 Content-Type */
export const KIND_CONTENT_TYPES: { readonly [K in FileKind]: readonly ContentType[] } = {
  image: ['image/png', 'image/webp', 'image/avif'],
  atlas: ['application/json'],
  mask: ['image/png'],
  flic: ['application/octet-stream'],
  audio: ['audio/ogg', 'audio/mp4', 'audio/webm'],
  video: ['video/mp4', 'video/webm'],
  data: ['application/json'],
  mapskin: ['application/json'],
};

/** 小写扩展名（含点）；没有扩展名时返回空串 */
export function pathExt(path: string): string {
  const slash = path.lastIndexOf('/');
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/** 扩展名对应的 Content-Type；不在白名单里时返回 null */
export function contentTypeForPath(path: string): ContentType | null {
  const ext = pathExt(path);
  return Object.hasOwn(CONTENT_TYPE_BY_EXT, ext) ? CONTENT_TYPE_BY_EXT[ext as PackExt] : null;
}

/** 内容哈希前 8 位 */
export function hash8(sha256: string): string {
  return sha256.slice(0, 8);
}

/**
 * 带哈希的实际路径：在最后一个扩展名前插入 `.<sha256 前 8 位>`。
 * `sprites/data/88.png` → `sprites/data/88.1a2b3c4d.png`；`sprites/map/27.mask.png` → `sprites/map/27.mask.1a2b3c4d.png`。
 */
export function hashedPath(logicalPath: string, sha256: string): string {
  const slash = logicalPath.lastIndexOf('/');
  const dot = logicalPath.lastIndexOf('.');
  const h = hash8(sha256);
  if (dot <= slash + 1) return `${logicalPath}.${h}`;
  return `${logicalPath.slice(0, dot)}.${h}${logicalPath.slice(dot)}`;
}

/** 预压缩变体：`<path>.br` / `<path>.gz` */
export type PrecompressedEncoding = 'br' | 'gzip';
export function variantPath(path: string, enc: PrecompressedEncoding): string {
  return enc === 'br' ? `${path}.br` : `${path}.gz`;
}

// ───────────────────────── 解析结果 ─────────────────────────

export type AssetParseResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

/** 结构或一致性校验失败（throwing 版 parse* 抛出） */
export class AssetContractError extends Error {
  override name = 'AssetContractError';

  constructor(
    readonly schema: string,
    readonly issues: readonly string[],
  ) {
    super(`${schema}: ${issues.slice(0, 5).join('; ') || 'invalid'}`);
  }
}

/** superRefine 里汇报的一致性问题（path 相对于被校验的对象） */
export interface ContractIssue {
  path: (string | number)[];
  message: string;
}

export function formatIssuePath(path: readonly PropertyKey[]): string {
  return path.map((p) => (typeof p === 'symbol' ? p.toString() : String(p))).join('.');
}

/** 单条 zod issue 的可读形式；非法记录键等嵌套 issue 会带上内层原因 */
function formatIssue(i: z.core.$ZodIssue): string {
  const nested =
    'issues' in i && Array.isArray(i.issues) && i.issues.length > 0
      ? `（${(i.issues as z.core.$ZodIssue[]).map((x) => x.message).join('；')}）`
      : '';
  return `${formatIssuePath(i.path) || '(root)'}: ${i.message}${nested}`;
}

export function runSafeParse<T>(schema: z.ZodType<T>, json: unknown): AssetParseResult<T> {
  const r = schema.safeParse(json);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, issues: r.error.issues.map(formatIssue) };
}

export function runParse<T>(schemaId: string, schema: z.ZodType<T>, json: unknown): T {
  const r = runSafeParse(schema, json);
  if (!r.ok) throw new AssetContractError(schemaId, r.issues);
  return r.value;
}

/** 把一致性问题转交给 zod（superRefine 用） */
export function reportIssues(ctx: z.RefinementCtx, issues: readonly ContractIssue[]): void {
  for (const i of issues) ctx.addIssue({ code: 'custom', message: i.message, path: i.path });
}

/** 按 UTF-16 码元升序的键（确定性遍历；不依赖区域设置） */
export function sortedKeys(rec: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(rec).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 数组是否严格升序（因此无重复） */
export function isStrictlySorted<T extends string | number>(xs: readonly T[]): boolean {
  for (let i = 1; i < xs.length; i++) if (!(xs[i - 1]! < xs[i]!)) return false;
  return true;
}
