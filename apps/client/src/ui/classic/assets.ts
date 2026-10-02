// 经典画面的原版素材（original-skin.md §4.1、design-draft §4.2 主 HUD 素材对照）：按逻辑键从素材包取图集帧、整图、
// 命中掩膜与 FLIC。条目缺失、所属组缺失、置信度 guess 或加载失败 → 该键记为 null，组件改画 CSS 回退（CI 的合成素材包
// 不含 UI 条目，走的就是这条路径）。
//
// 精灵用 CSS 背景图画（background-position 定位到图集帧），落点 = 画点 − 锚点（图集 meta.r4.anchorsPx 的整数锚点）；
// 图集位图 URL 与 manifest 里的其他文件一样带哈希、同源带 cookie（门禁）。
import type { AtlasV1, SpriteEntry } from '@rich4/shared/assets';
import { create } from 'zustand';
import type { FlicClock, FlicPlayer } from '../../skin/flic';
import type { PackClient } from '../../skin/pack/PackClient';

/** 启动时预取的精灵条目 */
export const CLASSIC_SPRITES = [
  'ui.toolbar',
  'ui.sidebar',
  'ui.calendar',
  'ui.goButton',
  'ui.diceFaces',
  'ui.common',
  'portrait.face72',
] as const;
export type ClassicSpriteKey = (typeof CLASSIC_SPRITES)[number];

/** GO 钮命中掩膜（Panel#8，72×67，区号 1–4） */
export const GO_MASK_KEY = 'ui.goButton.mask';

/** 滚骰 FLC：1/2/3 颗骰子 */
export function diceFlicKey(n: number): string {
  return `ui.dice.roll${Math.min(3, Math.max(1, Math.trunc(n)))}`;
}

/**
 * 节日插画的全局编号基址（按原版地图号 gm）：键 illustration.holiday.<n>，n = Data 资源号 − 4 = 基址 + slot
 * @source exe v2.06 VA 0x473098 u16[4] = (4, 28, 47, 67)（0x416428、0x43333e：mov bx,[gm*2+0x473098]; add ebx, slot），
 *   slot 为 fcn.00450a17 按日期查节日表返回的槽号；Data#66（七夕）节日表里没有对应项，不用
 */
export const HOLIDAY_ART_BASE: readonly number[] = [0, 24, 43, 63];
/** 各图节日表的有效项数（台湾 24、大陆 19、日本 19、美国 20；exe 节日表 VA 0x47d6aa） */
export const HOLIDAY_ART_COUNT: readonly number[] = [24, 19, 19, 20];

/** 节日插画（原版四张图：illustration.holiday.<基址 + slot>）；不是原版地图（fixture）、slot 越界时 null */
export function holidayArtKey(globalMapId: number | null, holiday: string | null): string | null {
  if (!holiday || globalMapId === null) return null;
  const base = HOLIDAY_ART_BASE[globalMapId];
  const count = HOLIDAY_ART_COUNT[globalMapId];
  if (base === undefined || count === undefined) return null;
  const m = /^h(\d{1,2})$/.exec(holiday);
  if (!m) return null;
  const slot = Number(m[1]);
  return slot < count ? `illustration.holiday.${base + slot}` : null;
}

export interface SpriteFrame {
  /** 图集页位图 URL */
  url: string;
  /** 帧在图集页中的位置与尺寸 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 锚点（落点 = 画点 − 锚点） */
  ax: number;
  ay: number;
  /** 图集页尺寸 */
  sheetW: number;
  sheetH: number;
}

export interface SpriteSheet {
  key: string;
  /** 下标 = 帧号（条目内 0..count−1）；图集里找不到的帧为 null */
  frames: (SpriteFrame | null)[];
}

export interface ImageAsset {
  url: string;
  w: number;
  h: number;
}

/** 命中掩膜：每像素一个区号（0 = 无） */
export interface MaskAsset {
  w: number;
  h: number;
  data: Uint8Array;
}

export function maskRegion(m: MaskAsset, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  if (xi < 0 || yi < 0 || xi >= m.w || yi >= m.h) return 0;
  return m.data[yi * m.w + xi] ?? 0;
}

export type FlicLoader = (key: string, clock: FlicClock) => Promise<FlicPlayer | null>;

export interface ClassicAssetState {
  /** 当前素材包（null = 没有素材包：全部回退） */
  packId: string | null;
  /** 逻辑键 → 精灵表；null = 不可用（回退）；键不存在 = 还在加载 */
  sprites: Readonly<Record<string, SpriteSheet | null>>;
  images: Readonly<Record<string, ImageAsset | null>>;
  masks: Readonly<Record<string, MaskAsset | null>>;
  /** FLIC 加载器（素材包就绪时由 bindClassicAssets 设置；测试可替换） */
  loadFlic: FlicLoader | null;
}

const EMPTY: ClassicAssetState = { packId: null, sprites: {}, images: {}, masks: {}, loadFlic: null };

export const useClassicAssets = create<ClassicAssetState>()(() => ({ ...EMPTY }));

let bound: { packId: string; client: PackClient } | null = null;
const warned = new Set<string>();
/** 预取过的位图（素材包 id + 键或 url:<地址> → 加载结果）；持有 <img> 引用，解码结果留在内存缓存里。换包时清空 */
const preloaded = new Map<string, { el: HTMLImageElement; done: Promise<boolean> }>();

function warnOnce(key: string, e: unknown): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[classic] 素材 ${key} 不可用，改用回退画法`, e);
}

/** 从图集里取条目的全部帧 */
export function sheetFromAtlases(
  key: string,
  entry: Pick<SpriteEntry, 'frames' | 'anchor'>,
  pages: readonly { atlas: AtlasV1; url: string }[],
): SpriteSheet {
  const frames: (SpriteFrame | null)[] = [];
  for (let i = 0; i < entry.frames.count; i++) {
    const name = `${entry.frames.base}/${entry.frames.start + i}`;
    let found: SpriteFrame | null = null;
    for (const p of pages) {
      const f = Object.hasOwn(p.atlas.frames, name) ? p.atlas.frames[name] : undefined;
      if (!f) continue;
      const px = Object.hasOwn(p.atlas.meta.r4.anchorsPx, name) ? p.atlas.meta.r4.anchorsPx[name] : undefined;
      const ax =
        entry.anchor === 'center' ? Math.round(f.frame.w / 2) : (px?.[0] ?? Math.round(f.anchor.x * f.frame.w));
      const ay =
        entry.anchor === 'center' ? Math.round(f.frame.h / 2) : (px?.[1] ?? Math.round(f.anchor.y * f.frame.h));
      found = {
        url: p.url,
        x: f.frame.x,
        y: f.frame.y,
        w: f.frame.w,
        h: f.frame.h,
        ax,
        ay,
        sheetW: p.atlas.meta.size.w,
        sheetH: p.atlas.meta.size.h,
      };
      break;
    }
    frames.push(found);
  }
  return { key, frames };
}

async function loadSprite(client: PackClient, key: string): Promise<SpriteSheet | null> {
  const e = client.usableEntry(key);
  if (e?.type !== 'sprite') return null;
  const pages: { atlas: AtlasV1; url: string }[] = [];
  for (const lp of e.atlas) {
    const atlas = await client.loadAtlas(lp);
    const url = client.atlasImageUrl(lp, atlas);
    if (url) pages.push({ atlas, url });
  }
  const sheet = sheetFromAtlases(key, e, pages);
  return sheet.frames.some((f) => f !== null) ? sheet : null;
}

function setIfCurrent(packId: string, patch: (s: ClassicAssetState) => Partial<ClassicAssetState>): void {
  const s = useClassicAssets.getState();
  if (s.packId !== packId) return;
  useClassicAssets.setState(patch(s));
}

/**
 * 绑定素材包（原版皮肤就绪时由 ClassicLayout 调用）：换包时清空，预取工具列、资料栏、日历、GO 钮、骰子面、头像等精灵。
 * client 为 null 或 packId 为 null → 全部回退。
 */
export function bindClassicAssets(client: PackClient | null, packId: string | null): void {
  if (!client || !packId) {
    bound = null;
    preloaded.clear();
    if (useClassicAssets.getState().packId !== null) useClassicAssets.setState({ ...EMPTY });
    return;
  }
  if (bound && bound.packId === packId && bound.client === client) return;
  bound = { packId, client };
  preloaded.clear();
  const loadFlic: FlicLoader = async (key, clock) => {
    const e = client.usableEntry(key);
    if (e?.type !== 'flic') return null;
    const { loadFlicPlayer } = await import('../../skin/flic/packFlic');
    try {
      return (await loadFlicPlayer(client, key, { clock })).player;
    } catch (err) {
      warnOnce(key, err);
      return null;
    }
  };
  useClassicAssets.setState({ packId, sprites: {}, images: {}, masks: {}, loadFlic });
  for (const key of CLASSIC_SPRITES) {
    loadSprite(client, key).then(
      (sheet) => setIfCurrent(packId, (s) => ({ sprites: { ...s.sprites, [key]: sheet } })),
      (e: unknown) => {
        warnOnce(key, e);
        setIfCurrent(packId, (s) => ({ sprites: { ...s.sprites, [key]: null } }));
      },
    );
  }
}

/** 整图（节日插画等）：按需取 URL（只登记，不下载；<img>/背景图自己加载。要提前下载用 preloadClassicImage） */
export function ensureClassicImage(key: string): void {
  const s = useClassicAssets.getState();
  if (Object.hasOwn(s.images, key)) return;
  const b = bound;
  if (!b || s.packId !== b.packId) {
    useClassicAssets.setState({ images: { ...s.images, [key]: null } });
    return;
  }
  const e = b.client.usableEntry(key);
  const url = e?.type === 'image' ? b.client.fileUrl(e.file) : null;
  const img: ImageAsset | null = e?.type === 'image' && url ? { url, w: e.w, h: e.h } : null;
  useClassicAssets.setState({ images: { ...s.images, [key]: img } });
}

/** 预取的下载优先级（HTMLImageElement.fetchPriority）：卡片插画用 low，不和棋盘、界面素材抢带宽 */
export type PreloadPriority = 'high' | 'low' | 'auto';

/** 后台下载并解码一个位图 URL；同一 id（素材包内）只下一次，返回是否成功 */
function preloadUrl(id: string, url: string, label: string, priority: PreloadPriority): Promise<boolean> {
  const cur = preloaded.get(id);
  if (cur) return cur.done;
  const el = new Image();
  el.decoding = 'async';
  el.fetchPriority = priority;
  const loaded = new Promise<boolean>((resolve) => {
    el.onload = () => resolve(true);
    el.onerror = () => resolve(false);
  });
  const done = loaded.then(async (ok) => {
    if (!ok) {
      warnOnce(label, new Error(`位图预取失败：${url}`));
      return false;
    }
    // 解码失败不影响显示（背景图会自己解码）：照样算预取成功
    await el.decode?.().catch(() => undefined);
    return true;
  });
  preloaded.set(id, { el, done });
  el.src = url;
  return done;
}

/**
 * 预取整图：登记 URL（同 ensureClassicImage），并在后台下载、解码，返回是否成功（条目不可用、加载失败为 false）。
 * 背景图用的是同一个带哈希的 URL，之后显示时直接命中缓存。出卡弹窗只停 1.2–1.5 秒，卡片插画若等到弹窗出现才下载，
 * 慢网络下会空白或只画出一截（弹窗宿主空闲时按手牌优先把 30 张都预取一遍）。同一素材包内重复调用共用一次加载。
 */
export function preloadClassicImage(key: string, priority: PreloadPriority = 'low'): Promise<boolean> {
  ensureClassicImage(key);
  const s = useClassicAssets.getState();
  const img = s.images[key];
  if (!img || s.packId === null || typeof Image === 'undefined') return Promise.resolve(false);
  return preloadUrl(`${s.packId}\n${key}`, img.url, key, priority);
}

/**
 * 预取精灵表所在的图集页位图（精灵表进仓库只代表图集 JSON 已到，页位图要等画出来时才由背景图去下载）：
 * 亮卡的宝石消息框（ui.common）在弹窗出现前就要能画出来，否则慢网络下首个弹窗的字直接浮在棋盘上
 */
export function preloadSpritePages(sheet: SpriteSheet, priority: PreloadPriority = 'auto'): Promise<boolean> {
  const packId = useClassicAssets.getState().packId;
  if (packId === null || typeof Image === 'undefined') return Promise.resolve(false);
  const urls = [...new Set(sheet.frames.flatMap((f) => (f ? [f.url] : [])))];
  return Promise.all(urls.map((u) => preloadUrl(`${packId}\nurl:${u}`, u, sheet.key, priority))).then((r) =>
    r.every(Boolean),
  );
}

/** 这张整图（或 url: 开头的图集页位图 URL）是否已经开始预取（不论成败，测试与调试用） */
export function classicImagePreloadStarted(keyOrUrl: string): boolean {
  const packId = useClassicAssets.getState().packId;
  return packId !== null && preloaded.has(`${packId}\n${keyOrUrl}`);
}

/** 命中掩膜：解码 8 位灰度 PNG 取区号（需要 canvas；不可用时 null → 按矩形命中） */
export function ensureClassicMask(key: string): void {
  const s = useClassicAssets.getState();
  if (Object.hasOwn(s.masks, key)) return;
  const b = bound;
  const e = b && s.packId === b.packId ? b.client.usableEntry(key) : null;
  if (!b || e?.type !== 'mask') {
    useClassicAssets.setState({ masks: { ...s.masks, [key]: null } });
    return;
  }
  const packId = b.packId;
  useClassicAssets.setState({ masks: { ...s.masks, [key]: null } });
  const file = e.file;
  b.client
    .loadImage(file)
    .then((img) => {
      // 区号读进 Uint8Array 之后位图就用不到了：马上归还（素材包客户端没有别的使用者时关闭它）
      try {
        return decodeMask(img, e.w, e.h);
      } finally {
        b.client.releaseImage(file);
      }
    })
    .then(
      (m) => setIfCurrent(packId, (st) => ({ masks: { ...st.masks, [key]: m } })),
      (err: unknown) => warnOnce(key, err),
    );
}

function decodeMask(img: CanvasImageSource, w: number, h: number): MaskAsset | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4]!;
  c.width = 0;
  c.height = 0;
  return { w, h, data };
}

/** 测试：清空（可带预置状态） */
export function resetClassicAssetsForTest(state: Partial<ClassicAssetState> = {}): void {
  bound = null;
  warned.clear();
  preloaded.clear();
  useClassicAssets.setState({ ...EMPTY, ...state });
}
