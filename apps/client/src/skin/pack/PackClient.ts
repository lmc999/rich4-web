// 素材包客户端（design-draft §3.1；original-skin.md §3 修正 4）：
// - GET /pack/manifest.json（no-cache）：非 JSON、zod 或一致性校验失败、404、204 一律视为「没有素材包」；
//   401（ACCESS_REQUIRED）→ 状态 access-required 并通知门禁页；
// - 按逻辑路径解析带哈希的实际 URL（manifest.files[lp].path）；
// - 按组（group）懒加载：图集 JSON、地图皮肤、映射表逐个校验；位图按需解码；FLC、音频按条目取用；
// - 组内文件缺失或加载失败 → 记为失败组（skinStore 据此回退程序化）；
// - 二进制（FLC 字节）按字节预算做 LRU（BINARY_CACHE_BYTES）：原版 105 段 FLC 共约 38 MB，不能在页面里全部常驻，
//   淘汰后再取走 HTTP 缓存（private, max-age=30 天）。
// 本模块引入 shared/assets 的 zod 契约（体积较大），由 skinStore 动态 import，不进首屏。
import {
  type AssetEntry,
  type AtlasV1,
  type AudioEntry,
  checkAtlasRefs,
  checkMapSkinBinding,
  checkMapSkinRefs,
  type DataEntry,
  type FlicEntry,
  type MapBindingInput,
  type MapSkinV1,
  type PackManifestV1,
  safeParseAtlas,
  safeParseFlicMap,
  safeParseMapSkin,
  safeParseMusicMap,
  safeParsePackManifest,
  safeParseSfxSets,
  safeParseVoiceMap,
} from '@rich4/shared/assets';
import { type FlcFile, parseFlc } from '../flic/FlcDecoder';
import { checkEntry, type EntryRejection } from '../resolve';
import type { MapCheck, PackState } from '../types';
import { defaultFetch, type FetchLike, HttpError, isJsonResponse, readErrorCode, withTimeout } from './http';

export const PACK_BASE = '/pack/';
export const MANIFEST_TIMEOUT_MS = 8000;
export const FILE_TIMEOUT_MS = 30_000;
/** 已下载二进制（FLC 字节）的缓存预算：超过时淘汰最久未用的 */
export const BINARY_CACHE_BYTES = 16 * 1024 * 1024;

/** 服务器在 /pack 与 /api 响应里带的门禁模式（可选）：off | passcode | invite */
export const ACCESS_MODE_HEADER = 'x-rich4-access';

export type PackImage = ImageBitmap | HTMLImageElement;

export interface PackClientOptions {
  /** 素材包 URL 前缀（缺省 /pack/） */
  base?: string;
  fetch?: FetchLike;
  manifestTimeoutMs?: number;
  fileTimeoutMs?: number;
  /** 收到 401：显示门禁页 */
  onAccessRequired?(where: 'manifest' | 'file'): void;
  /** 响应头里的门禁模式 */
  onAccessMode?(mode: string): void;
  /** 位图解码（缺省 createImageBitmap，退化为 <img>） */
  decodeImage?(blob: Blob, url: string): Promise<PackImage>;
  /** 音频格式探测（缺省 new Audio().canPlayType） */
  canPlayType?(mime: string): string;
  /** 二进制缓存预算（字节；缺省 BINARY_CACHE_BYTES） */
  binaryCacheBytes?: number;
}

export interface PackGroupBundle {
  group: string;
  /** 逻辑路径 → 图集 */
  atlases: Map<string, AtlasV1>;
  /** mapId → 地图皮肤 */
  mapSkins: Map<string, MapSkinV1>;
  /** 逻辑路径 → 已校验的映射表 */
  data: Map<string, unknown>;
  /** 逻辑路径 → 位图（loadGroup({images:true}) 时） */
  images: Map<string, PackImage>;
}

export class PackAssetError extends Error {
  override name = 'PackAssetError';
}

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/') + 1);
}

async function defaultDecodeImage(blob: Blob, url: string): Promise<PackImage> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  if (typeof Image === 'undefined') throw new PackAssetError(`当前环境无法解码位图：${url}`);
  const src = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(src);
  }
}

export class PackClient {
  private stateValue: PackState = { status: 'idle' };
  private manifestPromise: Promise<PackState> | null = null;
  private readonly listeners = new Set<(s: PackState) => void>();
  private readonly jsonCache = new Map<string, Promise<unknown>>();
  private readonly binCache = new Map<string, Promise<ArrayBuffer>>();
  /** 已下载完成的二进制字节数（Map 的顺序即 LRU 次序） */
  private readonly binSizes = new Map<string, number>();
  private binBytes = 0;
  private readonly imageCache = new Map<string, Promise<PackImage>>();
  private readonly groupCache = new Map<string, Promise<PackGroupBundle>>();
  private readonly failed = new Set<string>();
  private readonly base: string;
  private readonly doFetch: FetchLike | null;

  constructor(private readonly o: PackClientOptions = {}) {
    const b = o.base ?? PACK_BASE;
    this.base = b.endsWith('/') ? b : `${b}/`;
    this.doFetch = o.fetch ?? defaultFetch();
  }

  // ───────────────────────── 状态 ─────────────────────────

  get state(): PackState {
    return this.stateValue;
  }

  get manifest(): PackManifestV1 | null {
    return this.stateValue.status === 'ready' ? this.stateValue.manifest : null;
  }

  /** 加载失败的组 */
  get failedGroups(): ReadonlySet<string> {
    return this.failed;
  }

  subscribe(fn: (s: PackState) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private setState(s: PackState): PackState {
    this.stateValue = s;
    for (const fn of [...this.listeners]) fn(s);
    return s;
  }

  // ───────────────────────── manifest ─────────────────────────

  /** 取 manifest（同一实例只请求一次；force 重新请求，例如通过门禁之后） */
  loadManifest(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<PackState> {
    if (this.manifestPromise && !opts.force) return this.manifestPromise;
    if (opts.force) this.resetCaches();
    this.setState({ status: 'loading' });
    const p = this.fetchManifest(opts.signal).then((s) => this.setState(s));
    this.manifestPromise = p;
    return p;
  }

  private resetCaches(): void {
    this.jsonCache.clear();
    this.binCache.clear();
    this.binSizes.clear();
    this.binBytes = 0;
    this.imageCache.clear();
    this.groupCache.clear();
    this.failed.clear();
  }

  private async fetchManifest(signal?: AbortSignal): Promise<PackState> {
    if (!this.doFetch) return { status: 'absent', reason: 'network', detail: 'fetch 不可用' };
    let res: Response;
    try {
      res = await this.doFetch(`${this.base}manifest.json`, {
        credentials: 'same-origin',
        cache: 'no-cache',
        headers: { Accept: 'application/json' },
        signal: withTimeout(signal, this.o.manifestTimeoutMs ?? MANIFEST_TIMEOUT_MS),
      });
    } catch (e) {
      return { status: 'absent', reason: 'network', detail: e instanceof Error ? e.message : String(e) };
    }
    const mode = res.headers.get(ACCESS_MODE_HEADER);
    if (mode) this.o.onAccessMode?.(mode);
    if (res.status === 401) {
      await readErrorCode(res);
      this.o.onAccessRequired?.('manifest');
      return { status: 'access-required' };
    }
    if (res.status === 204) return { status: 'absent', reason: 'no-content', detail: null };
    if (res.status === 404) return { status: 'absent', reason: 'not-found', detail: null };
    if (!res.ok) return { status: 'absent', reason: 'http', detail: `HTTP ${res.status}` };
    let json: unknown;
    try {
      const text = await res.text();
      if (!isJsonResponse(res) && !/^\s*\{/.test(text)) return { status: 'absent', reason: 'not-json', detail: null };
      json = JSON.parse(text) as unknown;
    } catch (e) {
      return { status: 'absent', reason: 'not-json', detail: e instanceof Error ? e.message : String(e) };
    }
    const r = safeParsePackManifest(json);
    if (!r.ok) return { status: 'absent', reason: 'invalid', detail: r.issues.slice(0, 3).join('; ') };
    return { status: 'ready', manifest: r.value };
  }

  // ───────────────────────── 路径与条目 ─────────────────────────

  /** 逻辑路径 → 实际 URL（带哈希）；不在 manifest 中返回 null */
  fileUrl(logicalPath: string): string | null {
    const m = this.manifest;
    const f = m && Object.hasOwn(m.files, logicalPath) ? m.files[logicalPath] : undefined;
    return f ? this.base + f.path : null;
  }

  /** 包内实际路径（manifest.files[].path，已带哈希）→ URL；音频来源（audio/sources 的 PackUrlOf）用它 */
  readonly urlOf = (packPath: string): string => this.base + packPath;

  /** 图集页位图的 URL（meta.image 是与图集 JSON 同目录的带哈希文件名） */
  atlasImageUrl(atlasPath: string, atlas: AtlasV1): string | null {
    const m = this.manifest;
    const f = m && Object.hasOwn(m.files, atlasPath) ? m.files[atlasPath] : undefined;
    return f ? this.base + dirOf(f.path) + atlas.meta.image : null;
  }

  entry(key: string): AssetEntry | null {
    const m = this.manifest;
    return m && Object.hasOwn(m.entries, key) ? m.entries[key]! : null;
  }

  /** 条目级回退：不存在、组缺失或失败、置信度 guess 时返回 null */
  usableEntry(key: string, opts: { allowGuess?: boolean } = {}): AssetEntry | null {
    const m = this.manifest;
    return m ? checkEntry(m, key, this.failed, opts).entry : null;
  }

  entryRejection(key: string, opts: { allowGuess?: boolean } = {}): EntryRejection | null {
    const m = this.manifest;
    return m ? checkEntry(m, key, this.failed, opts).rejected : 'missing';
  }

  /** 地图与素材包是否匹配（修正 9：绑定 resourceSha256 + 几何摘要） */
  checkMap(map: MapBindingInput): MapCheck {
    const m = this.manifest;
    if (!m) return { mapId: map.id, status: 'missing', mismatches: [], group: null };
    const mp = Object.hasOwn(m.maps, map.id) ? m.maps[map.id] : undefined;
    if (!mp) return { mapId: map.id, status: 'missing', mismatches: [], group: null };
    if (!m.features.board) return { mapId: map.id, status: 'no-board', mismatches: [], group: mp.group };
    const mismatches = checkMapSkinBinding({ mapId: map.id, binding: mp.binding }, map);
    if (mismatches.length > 0) return { mapId: map.id, status: 'mismatch', mismatches, group: mp.group };
    if (!Object.hasOwn(m.groups, mp.group) || this.failed.has(mp.group)) {
      return { mapId: map.id, status: 'group-missing', mismatches: [], group: mp.group };
    }
    return { mapId: map.id, status: 'ok', mismatches: [], group: mp.group };
  }

  /** 按浏览器能力挑选音频文件（opus 优先，其次 m4a） */
  audioFile(entry: AudioEntry): string | null {
    const can = this.o.canPlayType ?? defaultCanPlay;
    if (entry.files.opus && can('audio/ogg; codecs=opus') !== '') return entry.files.opus;
    if (entry.files.m4a && can('audio/mp4; codecs=mp4a.40.2') !== '') return entry.files.m4a;
    return entry.files.opus ?? entry.files.m4a ?? null;
  }

  // ───────────────────────── 文件 ─────────────────────────

  private async fetchFile(logicalPath: string, signal?: AbortSignal): Promise<Response> {
    const url = this.fileUrl(logicalPath);
    if (!url) throw new PackAssetError(`素材包中没有 ${logicalPath}`);
    if (!this.doFetch) throw new PackAssetError('fetch 不可用');
    const res = await this.doFetch(url, {
      credentials: 'same-origin',
      signal: withTimeout(signal, this.o.fileTimeoutMs ?? FILE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const code = await readErrorCode(res);
      const err = new HttpError(res.status, code, url);
      if (err.accessRequired) this.o.onAccessRequired?.('file');
      throw err;
    }
    return res;
  }

  private cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit) return hit;
    const p = load();
    cache.set(key, p);
    p.catch(() => {
      if (cache.get(key) === p) cache.delete(key);
    });
    return p;
  }

  /** 读 JSON 并用 parse 校验（按逻辑路径缓存） */
  loadJson<T>(logicalPath: string, parse: (json: unknown) => T, signal?: AbortSignal): Promise<T> {
    return this.cached(this.jsonCache, logicalPath, async () => {
      const res = await this.fetchFile(logicalPath, signal);
      return parse((await res.json()) as unknown);
    }) as Promise<T>;
  }

  /** 下载二进制（按逻辑路径缓存，按字节 LRU 淘汰；并发请求合并为一次） */
  loadBinary(logicalPath: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    const hit = this.binCache.get(logicalPath);
    if (hit) {
      // 刷新 LRU 次序
      this.binCache.delete(logicalPath);
      this.binCache.set(logicalPath, hit);
      const n = this.binSizes.get(logicalPath);
      if (n !== undefined) {
        this.binSizes.delete(logicalPath);
        this.binSizes.set(logicalPath, n);
      }
      return hit;
    }
    const p = (async () => (await this.fetchFile(logicalPath, signal)).arrayBuffer())();
    this.binCache.set(logicalPath, p);
    p.then(
      (buf) => {
        if (this.binCache.get(logicalPath) !== p) return;
        this.binSizes.set(logicalPath, buf.byteLength);
        this.binBytes += buf.byteLength;
        this.evictBinary(logicalPath);
      },
      () => {
        if (this.binCache.get(logicalPath) === p) this.binCache.delete(logicalPath);
      },
    );
    return p;
  }

  /** 缓存的二进制字节数（测试与调试） */
  get binaryCacheBytes(): number {
    return this.binBytes;
  }

  private evictBinary(keep: string): void {
    const budget = this.o.binaryCacheBytes ?? BINARY_CACHE_BYTES;
    if (this.binBytes <= budget) return;
    for (const [k, n] of this.binSizes) {
      if (this.binBytes <= budget) break;
      if (k === keep) continue;
      this.binSizes.delete(k);
      this.binCache.delete(k);
      this.binBytes -= n;
    }
  }

  loadImage(logicalPath: string, signal?: AbortSignal): Promise<PackImage> {
    return this.cached(this.imageCache, logicalPath, async () => {
      const res = await this.fetchFile(logicalPath, signal);
      const blob = await res.blob();
      return (this.o.decodeImage ?? defaultDecodeImage)(blob, logicalPath);
    });
  }

  loadAtlas(logicalPath: string, signal?: AbortSignal): Promise<AtlasV1> {
    return this.loadJson(
      logicalPath,
      (json) => {
        const r = safeParseAtlas(json);
        if (!r.ok) throw new PackAssetError(`图集 ${logicalPath} 校验失败：${r.issues.slice(0, 3).join('; ')}`);
        const m = this.manifest;
        const refs = m ? checkAtlasRefs(m, logicalPath, r.value) : [];
        if (refs.length > 0) throw new PackAssetError(`图集 ${logicalPath}：${refs[0]!.message}`);
        return r.value;
      },
      signal,
    );
  }

  /** 地图皮肤（按 manifest.maps[mapId].skin） */
  loadMapSkin(mapId: string, signal?: AbortSignal): Promise<MapSkinV1> {
    const m = this.manifest;
    const mp = m && Object.hasOwn(m.maps, mapId) ? m.maps[mapId] : undefined;
    if (!m || !mp) return Promise.reject(new PackAssetError(`素材包中没有地图 ${mapId}`));
    return this.loadJson(
      mp.skin,
      (json) => {
        const r = safeParseMapSkin(json);
        if (!r.ok) throw new PackAssetError(`地图皮肤 ${mapId} 校验失败：${r.issues.slice(0, 3).join('; ')}`);
        const refs = checkMapSkinRefs(m, r.value);
        if (refs.length > 0) throw new PackAssetError(`地图皮肤 ${mapId}：${refs[0]!.message}`);
        return r.value;
      },
      signal,
    );
  }

  /** 映射表数据（type 'data' 的条目；按 schema 校验） */
  loadData(key: string, signal?: AbortSignal): Promise<unknown> {
    const e = this.entry(key);
    if (e?.type !== 'data') return Promise.reject(new PackAssetError(`${key} 不是数据条目`));
    return this.loadJson(e.file, (json) => parseData(e, json), signal);
  }

  /** FLIC 条目：下载并解析（像素按播放器逐帧解码） */
  async loadFlic(key: string, signal?: AbortSignal): Promise<{ entry: FlicEntry; flc: FlcFile }> {
    const e = this.entry(key);
    if (e?.type !== 'flic') throw new PackAssetError(`${key} 不是 FLIC 条目`);
    const buf = await this.loadBinary(e.file, signal);
    const flc = parseFlc(buf, key);
    if (flc.width !== e.w || flc.height !== e.h || flc.frames !== e.frames) {
      throw new PackAssetError(
        `${key}: FLC 头部 ${flc.width}×${flc.height}×${flc.frames} 与条目 ${e.w}×${e.h}×${e.frames} 不符`,
      );
    }
    return { entry: e, flc };
  }

  /**
   * 懒加载一个组：JSON（图集、地图皮肤、映射表）逐个下载并校验，images=true 时同时解码位图；
   * FLC、音频、视频按条目取用（不在这里下载）。任何文件失败 → 该组记为失败并 reject。
   */
  loadGroup(group: string, opts: { images?: boolean; signal?: AbortSignal } = {}): Promise<PackGroupBundle> {
    const key = `${group}|${opts.images === true ? 'img' : 'json'}`;
    return this.cached(this.groupCache, key, async () => {
      const m = this.manifest;
      const g = m && Object.hasOwn(m.groups, group) ? m.groups[group] : undefined;
      if (!m || !g) {
        this.failed.add(group);
        throw new PackAssetError(`素材包中没有组 ${group}`);
      }
      const bundle: PackGroupBundle = {
        group,
        atlases: new Map(),
        mapSkins: new Map(),
        data: new Map(),
        images: new Map(),
      };
      const mapOfSkin = new Map<string, string>();
      for (const id of Object.keys(m.maps)) mapOfSkin.set(m.maps[id]!.skin, id);
      try {
        await Promise.all(
          g.files.map(async (lp) => {
            const f = m.files[lp]!;
            switch (f.kind) {
              case 'atlas':
                bundle.atlases.set(lp, await this.loadAtlas(lp, opts.signal));
                return;
              case 'mapskin': {
                const id = mapOfSkin.get(lp);
                if (id !== undefined) bundle.mapSkins.set(id, await this.loadMapSkin(id, opts.signal));
                return;
              }
              case 'data': {
                const e = Object.values(m.entries).find((x): x is DataEntry => x.type === 'data' && x.file === lp);
                if (e) bundle.data.set(lp, await this.loadJson(lp, (json) => parseData(e, json), opts.signal));
                return;
              }
              case 'image':
              case 'mask':
                if (opts.images === true) bundle.images.set(lp, await this.loadImage(lp, opts.signal));
                return;
              default:
                return;
            }
          }),
        );
      } catch (e) {
        this.failed.add(group);
        throw e;
      }
      return bundle;
    });
  }
}

function parseData(e: DataEntry, json: unknown): unknown {
  const r =
    e.schema === 'rich4.voicemap/1'
      ? safeParseVoiceMap(json)
      : e.schema === 'rich4.sfxsets/1'
        ? safeParseSfxSets(json)
        : e.schema === 'rich4.musicmap/1'
          ? safeParseMusicMap(json)
          : safeParseFlicMap(json);
  if (!r.ok) throw new PackAssetError(`${e.file} 校验失败：${r.issues.slice(0, 3).join('; ')}`);
  return r.value;
}

function defaultCanPlay(mime: string): string {
  if (typeof Audio === 'undefined') return 'maybe';
  try {
    return new Audio().canPlayType(mime);
  } catch {
    return '';
  }
}
