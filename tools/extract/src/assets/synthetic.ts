/**
 * 原版皮肤 A2：fixture 地图（test、test-allkinds）的合成素材包（docs/design/original-skin.md §3 修正 6）。
 *
 * 目的：CI 没有原版文件，也要能走一遍「原版皮肤」的渲染路径（OrigRenderer / OrigActor / OrigStage）。
 * 内容全部是我们自己画的简单图形（色块、描边、方向指示、帧号条），**不含任何原版字节或数值**：
 * - 地面：按 MapDef.terrain / roadCells 合成 GND 棋盘格底图，再走与原版相同的 GND → 切块 → 索引色 PNG 管线；
 * - 精灵：资源目录里全部「棋盘」类精灵条目（角色 21 套姿态、恶人、路面物件与神明、装饰、占地标志、高亮、连锁店与设施），
 *   逻辑键、分组、帧数结构与原版包相同，客户端代码无需区分；
 * - 每张 fixture 地图：住宅 5 级、景观、企业精灵与 MapSkinV1（投影用我们自己的参数化，绑定 fixture 身份 resourceSha256=null）；
 * - 经典外壳 UI（./syntheticUi）：工具列、资料栏、日历、GO 钮与命中掩膜、骰子面、共享 UI、头像、滚骰 FLC，
 *   E2E 用它走原版 UI 精灵路径（帧号、锚点、掩膜区号语义与原版包一致）。
 *
 * 合成包的 JSON 带素材包 schema，会被 check-no-original 按 schema 拦截，所以**不入库**：
 * 由 `rich4-extract assets synth [--out .cache/synthetic-pack]` 在 CI / 测试时现场生成（输出目录同样必须已被忽略或在仓库外）。
 */
import path from 'node:path';
import type { PackManifestV1 } from '@rich4/shared/assets';
import { buildFixtureMaps, type MapDef } from '@rich4/shared/data';
import type { ExtractContext, Logger } from '../context';
import type { PngOptions } from '../gfx/png';
import { SPR_OWNER_INDEX } from '../gfx/spr';
import { type Catalog, catalogV206, type SpriteItem } from './catalog.v206';
import { buildAtlasPages, type FrameSet, groundChunks } from './images';
import { PackWriter, pruneStalePack, resolvePackOutputDir } from './manifest';
import { claimOutputDir } from './outputDir';
import { buildSyntheticSkin } from './skin';
import { addSyntheticUi } from './syntheticUi';

export const SYNTH_GENERATOR = 'rich4-extract/synthetic@1';
export const DEFAULT_SYNTH_DIR = path.join('.cache', 'synthetic-pack');
const PNG: PngOptions = { derivedMarker: false };

export interface SyntheticOptions {
  ctx: ExtractContext;
  outDir?: string;
  /** 允许输出到仓库外（见 ./outputDir）；默认 false */
  allowOutsideRepo?: boolean;
  /** 默认 shared/data 的 buildFixtureMaps()（test、test-allkinds） */
  maps?: readonly MapDef[];
  catalog?: Catalog;
  log?: Logger;
}

export interface SyntheticResult {
  outDir: string;
  manifest: PackManifestV1;
  manifestSha256: string;
}

// ───────────────────────── 调色板与绘制 ─────────────────────────

/** 合成调色板：0 透明、1 描边、2 白、3..14 色相、255 主人色占位 */
const HUES: readonly [number, number, number][] = [
  [220, 60, 60],
  [230, 140, 40],
  [220, 200, 40],
  [120, 200, 60],
  [40, 170, 90],
  [40, 180, 180],
  [50, 130, 220],
  [90, 80, 210],
  [160, 70, 200],
  [210, 70, 160],
  [150, 110, 70],
  [120, 120, 130],
];

function synthPalette(): { palette: Uint8Array; alpha: Uint8Array } {
  const palette = new Uint8Array(768);
  const alpha = new Uint8Array(256).fill(255);
  alpha[0] = 0;
  palette.set([16, 16, 16], 3);
  palette.set([240, 240, 240], 6);
  HUES.forEach((c, i) => {
    palette.set(c, (3 + i) * 3);
  });
  alpha[SPR_OWNER_INDEX] = 0;
  return { palette, alpha };
}

/** 字符串 → 稳定的小整数（FNV-1a 32） */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** 8 方向槽的单位向量（0 南 +y、2 东 +x、4 北、6 西），用整数近似 */
const DIR_VEC: readonly [number, number][] = [
  [0, 3],
  [2, 2],
  [3, 0],
  [2, -2],
  [0, -3],
  [-2, -2],
  [-3, 0],
  [-2, 2],
];

interface ShapeSpec {
  w: number;
  h: number;
  ax: number;
  ay: number;
  shape: 'box' | 'disc' | 'diamond';
}

function shapeFor(it: SpriteItem): ShapeSpec {
  if (it.key === 'board.decor') return { w: 48, h: 32, ax: 24, ay: 16, shape: 'disc' };
  if (it.key === 'board.lotHighlight') return { w: 64, h: 32, ax: 32, ay: 16, shape: 'diamond' };
  if (it.key === 'board.ownerMark') return { w: 20, h: 24, ax: 10, ay: 23, shape: 'box' };
  if (it.group.startsWith('char.') || it.group === 'npc') return { w: 28, h: 44, ax: 14, ay: 43, shape: 'box' };
  if (it.group === 'object') return { w: 24, h: 28, ax: 12, ay: 27, shape: 'disc' };
  return { w: 48, h: 56, ax: 24, ay: 50, shape: 'box' };
}

function drawFrame(
  spec: ShapeSpec,
  color: number,
  frame: number,
  dirs: 1 | 8,
  perDir: number,
  owner: boolean,
): Uint8Array {
  const { w, h } = spec;
  const px = new Uint8Array(w * h);
  const set = (x: number, y: number, v: number) => {
    if (x >= 0 && y >= 0 && x < w && y < h) px[y * w + x] = v;
  };
  const inside = (x: number, y: number): boolean => {
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    if (spec.shape === 'disc') return ((x - cx) / (w / 2)) ** 2 + ((y - cy) / (h / 2)) ** 2 <= 1;
    if (spec.shape === 'diamond') return Math.abs(x - cx) / (w / 2) + Math.abs(y - cy) / (h / 2) <= 1;
    return x >= 2 && x < w - 2 && y >= 4 && y < h;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside(x, y)) set(x, y, color);
  // 描边（主人色类用 255 占位）
  const edge = owner ? SPR_OWNER_INDEX : 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x, y)) continue;
      if (!inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) set(x, y, edge);
    }
  }
  // 方向指示：从中心指向方向槽
  if (dirs === 8) {
    const d = Math.trunc(frame / perDir);
    const [vx, vy] = DIR_VEC[d]!;
    const cx = w >> 1;
    const cy = h >> 1;
    for (let t = 0; t <= 3; t++) {
      set(cx + vx * t, cy + vy * t, 2);
      set(cx + vx * t + 1, cy + vy * t, 2);
    }
  }
  // 动画帧条：顶部白条长度 = 帧内序号 + 1
  const anim = dirs === 8 ? frame % perDir : frame;
  for (let i = 0; i <= Math.min(anim, w - 1); i++) set(i, 0, 2);
  return px;
}

function synthFrameSet(it: SpriteItem, count: number): FrameSet {
  const spec = shapeFor(it);
  const { palette, alpha } = synthPalette();
  const color = 3 + (hash(it.key) % HUES.length);
  const perDir = it.dirs === 8 ? count / 8 : count;
  const frames = Array.from({ length: count }, (_, i) => ({
    w: spec.w,
    h: spec.h,
    ax: spec.ax,
    ay: spec.ay,
    pixels: drawFrame(spec, color, i, it.dirs, perDir, it.ownerMask),
  }));
  return { kind: 'indexed', frames, palette, alpha, ownerMask: it.ownerMask };
}

function frameCount(it: SpriteItem): number {
  if (typeof it.frames === 'number') return it.frames;
  if (/walk/.test(it.key)) return 72;
  // 持骰动作（原版步行每方向 7–9 帧、机车 / 汽车 / 快艇 4–8 帧，掷骰时逐 tick 播一遍）：步行 9 帧、其余 4 帧
  if (/^char\.\d+\.dice$/.test(it.key)) return 72;
  if (/\.dice$/.test(it.key)) return 32;
  return 8;
}

// ───────────────────────── 合成地面（GND 格式） ─────────────────────────

const rgb555 = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/** 按 MapDef 合成一份 GND 资源（格式与原版相同：头 + 调色板 + 恒等排布 + 32×32 图块） */
export function synthGnd(def: MapDef): Uint8Array {
  const cols = def.grid.w;
  const rows = def.grid.h;
  const n = cols * rows;
  const out = new Uint8Array(0x210 + 2 * n + 1024 * n);
  const dv = new DataView(out.buffer);
  out.set([0x47, 0x4e, 0x44, 0], 0);
  dv.setUint16(4, cols, true);
  dv.setUint16(6, rows, true);
  dv.setUint32(8, n, true);
  // 调色板：每种地形两档（棋盘格）+ 路 + 节点 + 格线
  const colors: Record<string, [number, number, number]> = {
    w: [40, 90, 170],
    g: [70, 150, 70],
    s: [200, 180, 120],
    p: [120, 160, 90],
    m: [130, 110, 90],
  };
  const terrains = Object.keys(colors);
  const pal: [number, number, number][] = [[0, 0, 0]];
  for (const t of terrains) {
    const [r, g, b] = colors[t]!;
    pal.push([r, g, b], [Math.trunc(r * 0.85), Math.trunc(g * 0.85), Math.trunc(b * 0.85)]);
  }
  const ROAD = pal.push([110, 110, 110]) - 1;
  const NODE = pal.push([170, 170, 170]) - 1;
  const LINE = pal.push([30, 30, 30]) - 1;
  pal.forEach(([r, g, b], i) => {
    dv.setUint16(0x10 + i * 2, rgb555(r, g, b), true);
  });
  for (let i = 0; i < n; i++) dv.setUint16(0x210 + i * 2, i, true);
  const roads = new Set(def.roadCells.map((c) => `${c.x},${c.y}`));
  const nodes = new Set(def.tiles.map((t) => `${t.cell.x},${t.cell.y}`));
  const base = 0x210 + 2 * n;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const t = def.terrain[cy]?.[cx] ?? 'g';
      const ti = Math.max(0, terrains.indexOf(t));
      const k = `${cx},${cy}`;
      const fill = nodes.has(k) ? NODE : roads.has(k) ? ROAD : 1 + ti * 2 + ((cx + cy) & 1);
      const o = base + (cy * cols + cx) * 1024;
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) out[o + y * 32 + x] = x === 0 || y === 0 ? LINE : fill;
    }
  }
  return out;
}

// ───────────────────────── 主流程 ─────────────────────────

export async function buildSyntheticPack(opts: SyntheticOptions): Promise<SyntheticResult> {
  const { ctx } = opts;
  const log = opts.log ?? ctx.log;
  const outDir = resolvePackOutputDir(ctx, opts.outDir ?? DEFAULT_SYNTH_DIR, {
    allowOutsideRepo: opts.allowOutsideRepo === true,
  });
  const cat = opts.catalog ?? catalogV206();
  const maps = opts.maps ?? buildFixtureMaps();
  await claimOutputDir(ctx, outDir);
  const writer = new PackWriter(ctx, outDir, 'synthetic');

  const addSprite = async (it: SpriteItem, dir: string, name: string): Promise<void> => {
    const count = frameCount(it);
    const base = `S#${name}`;
    const pages = buildAtlasPages({
      dir,
      name,
      base,
      set: synthFrameSet(it, count),
      transparency: 'index0',
      src: ['synthetic'],
      png: PNG,
    });
    for (const p of pages) {
      await writer.writeFile(p.imagePath, p.imageBytes, 'image', it.group);
      if (p.maskPath && p.maskBytes) await writer.writeFile(p.maskPath, p.maskBytes, 'image', it.group);
      await writer.writeFile(p.jsonPath, p.jsonBytes, 'atlas', it.group);
    }
    writer.addEntry(it.key, {
      type: 'sprite',
      group: it.group,
      confidence: it.confidence,
      src: ['synthetic'],
      atlas: pages.map((p) => p.jsonPath),
      frames: { base, start: 0, count },
      dirs: it.dirs,
      frameMs: null,
      transparency: 'index0',
      ownerMask: it.ownerMask,
      anchor: it.anchor,
    });
  };

  // 通用棋盘精灵（与原版包同键同组）
  const shared = cat.items.filter(
    (it): it is SpriteItem => it.type === 'sprite' && it.token === 'board' && !it.group.startsWith('map.'),
  );
  for (const it of shared) await addSprite(it, 'sprites/synthetic', it.key);

  // 经典外壳 UI（与原版包同键同组）
  await addSyntheticUi(writer, cat, PNG);

  // 每张 fixture 地图
  const building = (mapId: string, key: string, ownerMask: boolean): SpriteItem => ({
    type: 'sprite',
    kind: 'SPR',
    key,
    mkf: 'map',
    res: 0,
    group: `map.${mapId}`,
    token: 'board',
    frames: 8,
    dirs: 8,
    frameRule: 'building-8',
    transparency: 'index0',
    ownerMask,
    anchor: 'frame',
    confidence: 'exe',
    src: [],
    desc: 'synthetic',
  });
  for (const def of [...maps].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const group = `map.${def.id}`;
    const houses = [1, 2, 3, 4, 5].map((L) => `${group}.house.${L}`);
    for (const k of houses) await addSprite(building(def.id, k, true), `sprites/${def.id}`, k);
    const lm = {
      hospital: `${group}.landmark.hospital`,
      jail: `${group}.landmark.jail`,
      scenery: `${group}.landmark.scenery`,
    };
    for (const k of Object.values(lm)) await addSprite(building(def.id, k, false), `sprites/${def.id}`, k);
    const company = `${group}.company`;
    await addSprite(building(def.id, company, true), `sprites/${def.id}`, company);
    const g = groundChunks(synthGnd(def), def.id, 2, 2, 1, `synthetic GND ${def.id}`, PNG);
    const chunks = [];
    for (const c of g.chunks) {
      await writer.writeFile(c.path, c.bytes, 'image', group);
      chunks.push({ file: c.path, x: c.x, y: c.y, w: c.w, h: c.h });
    }
    const skin = buildSyntheticSkin({
      mapDef: def,
      ground: { chunks, overlap: 1 },
      keys: {
        decor: 'board.decor',
        houses,
        chain: 'board.chain',
        ownerMark: 'board.ownerMark',
        lotHighlight: 'board.lotHighlight',
      },
      companySprites: [company],
      landmarkSprites: lm,
    });
    const logical = `maps/${def.id}.skin.json`;
    await writer.writeJson(logical, skin, 'mapskin', group);
    writer.addMap(def.id, { skin: logical, group, binding: skin.binding });
  }

  const manifest = writer.manifest({
    edition: 'v206',
    generator: SYNTH_GENERATOR,
    source: { files: {}, exeSha256: null },
    tools: { ffmpeg: null },
    features: {
      board: true,
      ui: true,
      fx: false,
      minigames: false,
      audio: false,
      voice: false,
      music: false,
      video: false,
    },
  });
  const written = await writer.writeManifest(manifest);
  await pruneStalePack(ctx, outDir, manifest);
  log.out(
    `合成素材包：${Object.keys(manifest.entries).length} 个条目、${Object.keys(manifest.maps).length} 张地图 → ${ctx.displayPath(outDir)}（packId ${manifest.packId}）`,
  );
  return { outDir, manifest, manifestSha256: written.sha256 };
}
