/**
 * 原版皮肤 A2：`rich4-extract assets preview [--out .cache/assets-preview/]`——本机浏览用的联系表与 index.html（不进素材包）。
 *
 * 从素材包本身回读（manifest → 图集 JSON → PNG 页；FLC；掩膜），因此同时验证了写入端：
 * - 精灵：按帧序排成网格（8 方向的资源每行一个方向槽、每列一个动画帧），棋盘格底显示透明，红点标锚点，左上角标帧号；
 * - 整图 / 掩膜（伪彩色）/ FLIC（均匀抽帧）；
 * - 地图皮肤：用拟合的仿射投影把地面、装饰、建筑、景观、几个角色渲染成原版 440×440 棋盘视窗（视角 0/1/2/5），
 *   核对建筑是否落在地块框内、装饰是否在路口、朝向与帧号是否正确。manifest.maps 里每张图各渲染一组
 *  （MapDef 按 mapId 取 <mapDataDir>/<id>.map.json；缺 MapDef 的图跳过棋盘渲染）。
 * 输出目录守卫见 ./outputDir（默认 .cache/assets-preview/）；只在带 rich4-extract 归属标记的目录里清理旧文件；PNG 带派生标记。
 */
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  type AssetEntry,
  type AtlasV1,
  buildingFrame,
  type MapSkinV1,
  type PackManifestV1,
  parseAtlas,
  parseMapSkin,
  parsePackManifest,
  projectWorld,
  spriteFrameName,
  unprojectScreen,
} from '@rich4/shared/assets';
import { type MapDef, parseMapDef } from '@rich4/shared/data';
import { type ExtractContext, ExtractError, type Logger } from '../context';
import type { RgbaImage } from '../gfx/errors';
import { decodeFlcFrames, flcFrameToRgba, parseFlc } from '../gfx/flc';
import { encodePngRgba } from '../gfx/png';
import { isFile } from '../io/readOnly';
import { safeWriteFile } from '../io/writeCanonicalJson';
import { type MapDataLocation, mapDefPath } from './build';
import { type Catalog, catalogV206 } from './catalog.v206';
import { MANIFEST_FILE, resolvePackOutputDir } from './manifest';
import { assertOwnedOutputDir, checkClaimable, claimOutputDir } from './outputDir';
import { readPng } from './pngRead';

export const DEFAULT_PREVIEW_DIR = path.join('.cache', 'assets-preview');

export interface PreviewOptions extends MapDataLocation {
  ctx: ExtractContext;
  packDir: string;
  outDir?: string;
  /** 允许输出到仓库外（见 ./outputDir）；默认 false */
  allowOutsideRepo?: boolean;
  /** 只做这些分组（前缀匹配） */
  group?: string;
  catalog?: Catalog;
  log?: Logger;
}

export interface PreviewResult {
  outDir: string;
  sheets: string[];
  boards: string[];
  index: string;
}

// ───────────────────────── 画布 ─────────────────────────

function canvas(w: number, h: number): RgbaImage {
  return { w, h, rgba: new Uint8Array(w * h * 4) };
}

function fillRect(img: RgbaImage, x0: number, y0: number, w: number, h: number, rgb: readonly number[]): void {
  for (let y = Math.max(0, y0); y < Math.min(img.h, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.w, x0 + w); x++) {
      const o = (y * img.w + x) * 4;
      img.rgba[o] = rgb[0]!;
      img.rgba[o + 1] = rgb[1]!;
      img.rgba[o + 2] = rgb[2]!;
      img.rgba[o + 3] = 255;
    }
  }
}

function checker(img: RgbaImage, x0: number, y0: number, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const light = ((x >> 3) + (y >> 3)) & 1;
      fillRect(img, x0 + x, y0 + y, 1, 1, light ? [204, 204, 204] : [153, 153, 153]);
    }
  }
}

/** 按 alpha 叠加（源为非预乘 RGBA），缩小因子 k（最近邻） */
function blend(
  dst: RgbaImage,
  src: RgbaImage,
  sx0: number,
  sy0: number,
  sw: number,
  sh: number,
  dx0: number,
  dy0: number,
  k = 1,
): void {
  const w = Math.floor(sw / k);
  const h = Math.floor(sh / k);
  for (let y = 0; y < h; y++) {
    const dy = dy0 + y;
    if (dy < 0 || dy >= dst.h) continue;
    for (let x = 0; x < w; x++) {
      const dx = dx0 + x;
      if (dx < 0 || dx >= dst.w) continue;
      const so = ((sy0 + y * k) * src.w + (sx0 + x * k)) * 4;
      const a = src.rgba[so + 3]!;
      if (a === 0) continue;
      const o = (dy * dst.w + dx) * 4;
      for (let c = 0; c < 3; c++)
        dst.rgba[o + c] = Math.trunc((src.rgba[so + c]! * a + dst.rgba[o + c]! * (255 - a)) / 255);
      dst.rgba[o + 3] = 255;
    }
  }
}

const DIGITS: readonly string[] = [
  '111101101101111',
  '010110010010111',
  '111001111100111',
  '111001111001111',
  '101101111001001',
  '111100111001111',
  '111100111101111',
  '111001001001001',
  '111101111101111',
  '111101111001111',
];

function drawNumber(img: RgbaImage, n: number, x0: number, y0: number, rgb: readonly number[] = [255, 255, 255]): void {
  const s = String(n);
  for (let i = 0; i < s.length; i++) {
    const bits = DIGITS[s.charCodeAt(i) - 48]!;
    for (let p = 0; p < 15; p++) {
      if (bits[p] === '1') fillRect(img, x0 + i * 8 + (p % 3) * 2, y0 + Math.trunc(p / 3) * 2, 2, 2, rgb);
    }
  }
}

function dot(img: RgbaImage, x: number, y: number, rgb: readonly number[], r = 1): void {
  fillRect(img, Math.round(x) - r, Math.round(y) - r, 2 * r + 1, 2 * r + 1, rgb);
}

// ───────────────────────── 素材包读取 ─────────────────────────

class PackReader {
  private readonly pngs = new Map<string, RgbaImage>();
  private readonly atlases = new Map<string, AtlasV1>();
  constructor(
    readonly dir: string,
    readonly m: PackManifestV1,
  ) {}

  async bytes(lp: string): Promise<Uint8Array> {
    const f = this.m.files[lp];
    if (!f) throw new ExtractError('E_PREVIEW', `manifest 里没有 ${lp}`);
    return new Uint8Array(await readFile(path.join(this.dir, ...f.path.split('/'))));
  }

  async png(lp: string): Promise<RgbaImage> {
    const hit = this.pngs.get(lp);
    if (hit) return hit;
    const p = readPng(await this.bytes(lp), lp);
    const img = { w: p.w, h: p.h, rgba: p.rgba };
    this.pngs.set(lp, img);
    return img;
  }

  async atlas(lp: string): Promise<AtlasV1> {
    const hit = this.atlases.get(lp);
    if (hit) return hit;
    const a = parseAtlas(JSON.parse(Buffer.from(await this.bytes(lp)).toString('utf8')));
    this.atlases.set(lp, a);
    return a;
  }

  /** 精灵条目的第 i 帧：所在页位图、帧矩形与锚点 */
  async frame(
    e: Extract<AssetEntry, { type: 'sprite' }>,
    i: number,
  ): Promise<{ page: RgbaImage; x: number; y: number; w: number; h: number; ax: number; ay: number } | null> {
    const name = spriteFrameName(e.frames.base, e.frames.start + i);
    for (const lp of e.atlas) {
      const a = await this.atlas(lp);
      const fr = a.frames[name];
      if (!fr) continue;
      const imgLp = Object.keys(this.m.files).find(
        (k) =>
          this.m.files[k]!.path ===
          `${this.m.files[lp]!.path.slice(0, this.m.files[lp]!.path.lastIndexOf('/') + 1)}${a.meta.image}`,
      );
      if (!imgLp) return null;
      const [ax, ay] = a.meta.r4.anchorsPx[name]!;
      return { page: await this.png(imgLp), ...fr.frame, ax, ay };
    }
    return null;
  }
}

// ───────────────────────── 各类联系表 ─────────────────────────

type FrameRef = Awaited<ReturnType<PackReader['frame']>>;

function drawCell(img: RgbaImage, f: FrameRef, i: number, cx: number, cy: number, k: number): void {
  drawNumber(img, i, cx + 2, cy + 1);
  if (!f) return;
  checker(img, cx + 2, cy + 12, Math.floor(f.w / k), Math.floor(f.h / k));
  blend(img, f.page, f.x, f.y, f.w, f.h, cx + 2, cy + 12, k);
  if (f.ax >= 0 && f.ay >= 0 && f.ax <= f.w && f.ay <= f.h) {
    const ax = cx + 2 + Math.floor(f.ax / k);
    const ay = cy + 12 + Math.floor(f.ay / k);
    fillRect(img, ax - 2, ay, 5, 1, [255, 0, 0]);
    fillRect(img, ax, ay - 2, 1, 5, [255, 0, 0]);
  }
}

/**
 * 8 方向的资源：网格，每行一个方向槽、每列一个动画帧；其余：按帧宽流式排版（行宽上限 1600 px），
 * 大帧整数倍缩小（最近邻），红十字 = 锚点，左上角 = 帧号。
 */
async function spriteSheet(r: PackReader, e: Extract<AssetEntry, { type: 'sprite' }>): Promise<RgbaImage> {
  const n = e.frames.count;
  const frames: FrameRef[] = [];
  for (let i = 0; i < n; i++) frames.push(await r.frame(e, i));
  const maxW = Math.max(1, ...frames.map((f) => f?.w ?? 1));
  const maxH = Math.max(1, ...frames.map((f) => f?.h ?? 1));
  if (e.dirs === 8) {
    const cols = n / 8;
    let k = Math.max(1, Math.ceil(Math.max(maxW, maxH) / 256));
    k = Math.max(k, Math.ceil((cols * (maxW + 4)) / 2400));
    const cw = Math.ceil(maxW / k) + 4;
    const ch = Math.ceil(maxH / k) + 14;
    const img = canvas(cols * cw, 8 * ch);
    fillRect(img, 0, 0, img.w, img.h, [40, 40, 48]);
    frames.forEach((f, i) => {
      drawCell(img, f, i, (i % cols) * cw, Math.trunc(i / cols) * ch, k);
    });
    return img;
  }
  const k = Math.max(1, Math.ceil(Math.max(maxW, maxH) / 320));
  const LIMIT = 1600;
  const pos: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  let width = 1;
  for (const f of frames) {
    const w = Math.max(24, Math.ceil((f?.w ?? 1) / k) + 4);
    const h = Math.ceil((f?.h ?? 1) / k) + 14;
    if (x > 0 && x + w > LIMIT) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    pos.push({ x, y });
    x += w;
    rowH = Math.max(rowH, h);
    width = Math.max(width, x);
  }
  const img = canvas(width, y + rowH);
  fillRect(img, 0, 0, img.w, img.h, [40, 40, 48]);
  frames.forEach((f, i) => {
    drawCell(img, f, i, pos[i]!.x, pos[i]!.y, k);
  });
  return img;
}

function fit(img: RgbaImage, max: number): { img: RgbaImage; k: number } {
  const k = Math.max(1, Math.ceil(Math.max(img.w, img.h) / max));
  return { img, k };
}

async function imageSheet(r: PackReader, file: string, transparentBg: boolean): Promise<RgbaImage> {
  const src = await r.png(file);
  const { k } = fit(src, 800);
  const out = canvas(Math.floor(src.w / k), Math.floor(src.h / k));
  if (transparentBg) checker(out, 0, 0, out.w, out.h);
  blend(out, src, 0, 0, src.w, src.h, 0, 0, k);
  return out;
}

async function maskSheet(r: PackReader, file: string): Promise<RgbaImage> {
  const p = readPng(await r.bytes(file), file);
  const gray = p.gray ?? new Uint8Array(p.w * p.h);
  const out = canvas(p.w, p.h);
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i]!;
    const o = i * 4;
    if (v === 0) {
      out.rgba[o] = out.rgba[o + 1] = out.rgba[o + 2] = 20;
    } else {
      out.rgba[o] = (v * 97) & 255;
      out.rgba[o + 1] = (v * 57 + 80) & 255;
      out.rgba[o + 2] = (v * 151 + 40) & 255;
    }
    out.rgba[o + 3] = 255;
  }
  return out;
}

async function flicSheet(r: PackReader, e: Extract<AssetEntry, { type: 'flic' }>): Promise<RgbaImage> {
  const flc = parseFlc(await r.bytes(e.file), e.file);
  const frames = decodeFlcFrames(flc);
  const want = Math.min(frames.length, 24);
  const pick = Array.from({ length: want }, (_, i) => Math.round((i * (frames.length - 1)) / Math.max(1, want - 1)));
  const k = Math.max(1, Math.ceil(Math.max(e.w, e.h) / 220));
  const cw = Math.floor(e.w / k) + 4;
  const chh = Math.floor(e.h / k) + 14;
  const cols = Math.min(6, want);
  const out = canvas(cols * cw, Math.ceil(want / cols) * chh);
  fillRect(out, 0, 0, out.w, out.h, [40, 40, 48]);
  pick.forEach((fi, i) => {
    const f = frames[fi]!;
    const rgba = flcFrameToRgba(f, e.w, e.h, { transparentIndex: e.transparency === 'opaque' ? null : 0 });
    const cx = (i % cols) * cw;
    const cy = Math.trunc(i / cols) * chh;
    drawNumber(out, fi, cx + 2, cy + 1);
    checker(out, cx + 2, cy + 12, Math.floor(e.w / k), Math.floor(e.h / k));
    blend(out, rgba, 0, 0, e.w, e.h, cx + 2, cy + 12, k);
  });
  return out;
}

// ───────────────────────── 棋盘渲染（仿射投影） ─────────────────────────

const OWNER_TINT: readonly (readonly number[])[] = [
  [230, 40, 40],
  [40, 90, 230],
  [40, 180, 60],
  [230, 190, 30],
];

async function drawSprite(
  r: PackReader,
  out: RgbaImage,
  key: string,
  frame: number,
  sx: number,
  sy: number,
  tint: readonly number[] | null,
  center = false,
): Promise<void> {
  const e = r.m.entries[key];
  if (e?.type !== 'sprite') return;
  const f = await r.frame(e, frame);
  if (!f) return;
  const ax = center ? f.w >> 1 : f.ax;
  const ay = center ? f.h >> 1 : f.ay;
  blend(out, f.page, f.x, f.y, f.w, f.h, Math.round(sx - ax), Math.round(sy - ay));
  if (tint && e.ownerMask) {
    const a = await r.atlas(e.atlas[0]!);
    const maskName = a.meta.r4.mask;
    if (!maskName) return;
    const dir = r.m.files[e.atlas[0]!]!.path;
    const maskLp = Object.keys(r.m.files).find(
      (k) => r.m.files[k]!.path === `${dir.slice(0, dir.lastIndexOf('/') + 1)}${maskName}`,
    );
    if (!maskLp) return;
    const mask = await r.png(maskLp);
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        if (mask.rgba[((f.y + y) * mask.w + f.x + x) * 4]! < 128) continue;
        fillRect(out, Math.round(sx - ax) + x, Math.round(sy - ay) + y, 1, 1, tint);
      }
    }
  }
}

async function renderBoard(
  r: PackReader,
  skin: MapSkinV1,
  def: MapDef,
  view: number,
  camera: { x: number; y: number },
): Promise<RgbaImage> {
  const vp = skin.projection.viewport;
  const origin = { x: skin.projection.origin.x - vp.x, y: skin.projection.origin.y - vp.y };
  const A = skin.projection.views[view]!;
  const out = canvas(vp.w, vp.h);
  // 地面：逐像素反投影后最近邻取样
  const chunks = [];
  for (const c of skin.ground.chunks) chunks.push({ ...c, img: await r.png(c.file) });
  for (let y = 0; y < out.h; y++) {
    for (let x = 0; x < out.w; x++) {
      const w = unprojectScreen(A, origin, camera, { x: x + 0.5, y: y + 0.5 });
      const wx = Math.floor(w.x);
      const wy = Math.floor(w.y);
      const c = chunks.find((q) => wx >= q.x && wy >= q.y && wx < q.x + q.w && wy < q.y + q.h);
      const o = (y * out.w + x) * 4;
      if (!c) {
        out.rgba[o + 3] = 255;
        continue;
      }
      const so = ((wy - c.y) * c.img.w + (wx - c.x)) * 4;
      out.rgba[o] = c.img.rgba[so]!;
      out.rgba[o + 1] = c.img.rgba[so + 1]!;
      out.rgba[o + 2] = c.img.rgba[so + 2]!;
      out.rgba[o + 3] = 255;
    }
  }
  const proj = (p: { x: number; y: number }) => projectWorld(A, origin, camera, p);
  const inView = (s: { x: number; y: number }) => s.x > -200 && s.y > -200 && s.x < vp.w + 200 && s.y < vp.h + 300;
  const tiles = new Map(def.tiles.map((t) => [t.id, t]));
  // 装饰（排序层之下）
  if (skin.decor.sprite) {
    for (const n of skin.decor.nodes) {
      const t = tiles.get(n.tile);
      if (!t) continue;
      const s = proj(t.world);
      if (inView(s)) await drawSprite(r, out, skin.decor.sprite, n.frame, s.x, s.y, null, true);
    }
  }
  // 排序层：建筑、景观、角色，按屏幕 y
  type Item = { sy: number; draw: () => Promise<void> };
  const items: Item[] = [];
  let lotIdx = 0;
  for (const l of def.lots) {
    const s = proj(l.world);
    if (!inView(s)) continue;
    const facing = l.facing ?? 0;
    const frame = buildingFrame(facing, view);
    const i = lotIdx++;
    const key =
      l.kind === 'facility'
        ? (skin.buildings.facilities.hotel[1] ?? skin.buildings.facilities.park)
        : skin.buildings.house.levels[i % 5]!;
    items.push({ sy: s.y, draw: () => drawSprite(r, out, key, frame, s.x, s.y, OWNER_TINT[i % 4]!) });
  }
  const compWorld = new Map(def.companies.map((c) => [c.id as string, c]));
  for (const c of skin.buildings.companies) {
    const d = compWorld.get(c.lot);
    if (!d) continue;
    const s = proj(d.world);
    if (inView(s))
      items.push({
        sy: s.y,
        draw: () => drawSprite(r, out, c.sprite, buildingFrame(d.facing ?? 0, view), s.x, s.y, [0, 0, 0]),
      });
  }
  for (const sc of skin.scenery) {
    const s = proj(sc.world);
    if (inView(s))
      items.push({
        sy: s.y,
        draw: () => drawSprite(r, out, sc.sprite, buildingFrame(sc.facing, view), s.x, s.y, null),
      });
  }
  // 几个角色：站在相邻节点上、面朝下一节点
  const chars = def.tiles.slice(0, 40).filter((_, i) => i % 5 === 0);
  chars.forEach((t, i) => {
    const next = tiles.get(t.links[0]?.to ?? t.id) ?? t;
    const dx = next.world.x - t.world.x;
    const dy = next.world.y - t.world.y;
    const ang = Math.round((Math.atan2(-dy, dx) / Math.PI) * 4) & 7;
    const dir = [2, 3, 4, 5, 6, 7, 0, 1][ang]!;
    const key = `char.${i % 12}.walk`;
    const e = r.m.entries[key];
    if (e?.type !== 'sprite') return;
    const perDir = e.frames.count / 8;
    const frame = ((8 - view + dir) & 7) * perDir;
    const s = proj(t.world);
    if (inView(s)) items.push({ sy: s.y + 0.5, draw: () => drawSprite(r, out, key, frame, s.x, s.y, null) });
  });
  items.sort((a, b) => a.sy - b.sy);
  for (const it of items) await it.draw();
  // 节点位置（红点）
  for (const t of def.tiles) {
    const s = proj(t.world);
    if (s.x >= 0 && s.y >= 0 && s.x < vp.w && s.y < vp.h)
      dot(out, s.x, s.y, skin.boatTiles.includes(t.id) ? [0, 220, 255] : [255, 30, 30]);
  }
  return out;
}

/**
 * 棋盘渲染的镜头。台湾与调研原型 render-proto 相同（中部、台北、绿岛 = 节点 1），便于并排对照；
 * 其他图取节点包围盒中心、医院与监狱的关押格（环路上的关押格要看被关棋子与路过棋子的相对位置），有快艇节点时加一个快艇段。
 */
export function previewCameras(def: MapDef, skin: MapSkinV1): [string, { x: number; y: number }][] {
  if (def.id === 'taiwan') {
    return [
      ['center', { x: 1203, y: 578 }],
      ['taipei', { x: 1463, y: 239 }],
      ['greenisland', def.tiles.find((t) => t.id === 1)?.world ?? { x: 1752, y: 1871 }],
    ];
  }
  const xs = def.tiles.map((t) => t.world.x);
  const ys = def.tiles.map((t) => t.world.y);
  const cams: [string, { x: number; y: number }][] = [
    [
      'center',
      {
        x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2),
        y: Math.round((Math.min(...ys) + Math.max(...ys)) / 2),
      },
    ],
  ];
  const tile = (id: number | undefined) => (id === undefined ? undefined : def.tiles.find((t) => t.id === id));
  for (const kind of ['hospital', 'jail'] as const) {
    const t = tile(def.landmarks.find((l) => l.kind === kind && l.holdTile !== undefined)?.holdTile);
    if (t) cams.push([kind, t.world]);
  }
  const boat = tile(skin.boatTiles[Math.trunc(skin.boatTiles.length / 2)]);
  if (boat) cams.push(['boat', boat.world]);
  return cams;
}

// ───────────────────────── 主流程 ─────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fileSafe = (k: string) => k.replace(/[^A-Za-z0-9._-]/g, '_');

export async function buildPreview(opts: PreviewOptions): Promise<PreviewResult> {
  const { ctx } = opts;
  const log = opts.log ?? ctx.log;
  const outDir = resolvePackOutputDir(ctx, opts.outDir ?? DEFAULT_PREVIEW_DIR, {
    allowOutsideRepo: opts.allowOutsideRepo === true,
  });
  await checkClaimable(ctx, outDir);
  const mfPath = path.join(opts.packDir, MANIFEST_FILE);
  if (!(await isFile(mfPath))) {
    throw new ExtractError('E_ASSETS_NO_MANIFEST', `找不到 ${ctx.displayPath(mfPath)}（先运行 assets build）`, 2);
  }
  const m = parsePackManifest(JSON.parse(await readFile(mfPath, 'utf8')));
  const r = new PackReader(opts.packDir, m);
  const cat = opts.catalog ?? catalogV206();
  const descOf = new Map(cat.items.map((it) => [it.key, it.desc]));
  // 认领输出目录（非空且不是 rich4-extract 生成的目录直接拒绝）；全量预览时先清空旧的联系表与棋盘渲染
  //（--group 只增量覆盖对应文件）。删除只在带归属标记的目录里进行
  await claimOutputDir(ctx, outDir);
  if (!opts.group) {
    assertOwnedOutputDir(ctx, outDir);
    for (const sub of ['sheets', 'board']) {
      const d = path.join(outDir, sub);
      ctx.assertWritable(d);
      await rm(d, { recursive: true, force: true });
    }
  }
  const sheets: string[] = [];
  const boards: string[] = [];
  const cards: { group: string; key: string; img: string; e: AssetEntry }[] = [];
  const keys = Object.keys(m.entries)
    .filter((k) => !opts.group || m.entries[k]!.group.startsWith(opts.group))
    .sort();
  let n = 0;
  for (const key of keys) {
    const e = m.entries[key]!;
    let img: RgbaImage | null = null;
    if (e.type === 'sprite') img = await spriteSheet(r, e);
    else if (e.type === 'image') img = await imageSheet(r, e.file, e.transparency !== 'opaque');
    else if (e.type === 'mask') img = await maskSheet(r, e.file);
    else if (e.type === 'flic') img = await flicSheet(r, e);
    if (!img) continue;
    const rel = `sheets/${fileSafe(key)}.png`;
    await safeWriteFile(ctx, path.join(outDir, ...rel.split('/')), encodePngRgba(img.w, img.h, img.rgba));
    sheets.push(rel);
    cards.push({ group: e.group, key, img: rel, e });
    if (++n % 100 === 0) log.out(`  联系表：${n}`);
  }
  // 地图皮肤：棋盘渲染（每张图读自己的 MapDef）
  for (const [id, mp] of Object.entries(m.maps)) {
    if (opts.group && !mp.group.startsWith(opts.group)) continue;
    const skin = parseMapSkin(JSON.parse(Buffer.from(await r.bytes(mp.skin)).toString('utf8')));
    const mapPath = mapDefPath(ctx.root, id, opts);
    let def: MapDef | null = null;
    if (await isFile(mapPath)) def = parseMapDef(JSON.parse(await readFile(mapPath, 'utf8')));
    if (!def || def.id !== id) {
      log.err(`  （跳过 ${id} 的棋盘渲染：没有 MapDef ${ctx.displayPath(mapPath)}）`);
      continue;
    }
    const cams = previewCameras(def, skin);
    for (const view of [0, 1, 2, 5]) {
      for (const [name, cam] of cams) {
        const img = await renderBoard(r, skin, def, view, cam);
        const rel = `board/${id}_v${view}_${name}.png`;
        await safeWriteFile(ctx, path.join(outDir, ...rel.split('/')), encodePngRgba(img.w, img.h, img.rgba));
        boards.push(rel);
      }
    }
  }
  // index.html
  const byGroup = new Map<string, typeof cards>();
  for (const c of cards) {
    const list = byGroup.get(c.group) ?? [];
    list.push(c);
    byGroup.set(c.group, list);
  }
  const groups = [...byGroup.keys()].sort();
  const html = [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="robots" content="noindex">',
    '<title>素材包预览（本机私用）</title><style>body{font:13px system-ui;background:#1e1e24;color:#ddd;margin:16px}',
    'h2{margin-top:32px;border-bottom:1px solid #444}figure{display:inline-block;vertical-align:top;margin:6px;max-width:100%}',
    'img{image-rendering:pixelated;max-width:100%;border:1px solid #444}figcaption{max-width:640px;color:#aaa}',
    '.c-exe{color:#7c7}.c-visual{color:#cc7}.c-guess{color:#e77}code{color:#fff}</style></head><body>',
    `<h1>原版皮肤素材包预览</h1><p>packId <code>${esc(m.packId)}</code>，${Object.keys(m.entries).length} 个条目。仅供本机浏览，不得上传或入库。</p>`,
    `<p>分组：${groups.map((g) => `<a href="#g-${esc(g)}">${esc(g)}</a>`).join(' · ')}${boards.length ? ' · <a href="#boards">棋盘渲染</a>' : ''}</p>`,
  ];
  if (boards.length > 0) {
    html.push('<h2 id="boards">棋盘渲染（仿射投影，红点 = 节点，青点 = 快艇节点）</h2>');
    for (const b of boards) html.push(`<figure><img src="${esc(b)}"><figcaption>${esc(b)}</figcaption></figure>`);
  }
  for (const g of groups) {
    html.push(
      `<h2 id="g-${esc(g)}">${esc(g)}（${m.groups[g]?.category ?? ''}，${((m.groups[g]?.bytes ?? 0) / 1024).toFixed(0)} KB）</h2>`,
    );
    for (const c of byGroup.get(g)!) {
      const e = c.e;
      const extra =
        e.type === 'sprite'
          ? `${e.frames.count} 帧 · dirs ${e.dirs} · ${e.transparency}${e.ownerMask ? ' · 主人色掩膜' : ''}`
          : e.type === 'flic'
            ? `${e.w}×${e.h} · ${e.frames} 帧 × ${e.frameMs} ms${e.sfx ? ` · 音效 ${e.sfx}` : ''}`
            : e.type === 'image' || e.type === 'mask'
              ? `${e.w}×${e.h}`
              : '';
      html.push(
        `<figure><img src="${esc(c.img)}" loading="lazy"><figcaption><code>${esc(c.key)}</code> ` +
          `<span class="c-${e.confidence}">${e.confidence}</span> · ${esc(e.src.join('，'))} · ${esc(extra)}<br>${esc(descOf.get(c.key) ?? '')}</figcaption></figure>`,
      );
    }
  }
  html.push('</body></html>\n');
  const index = await safeWriteFile(ctx, path.join(outDir, 'index.html'), html.join('\n'));
  log.out(`预览：${sheets.length} 张联系表、${boards.length} 张棋盘渲染 → ${ctx.displayPath(index)}`);
  return { outDir, sheets, boards, index };
}
