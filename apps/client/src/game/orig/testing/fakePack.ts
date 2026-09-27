// 测试用的内存合成素材包（client-browser）：与 `npm run extract -- assets synth` 的合成包同一套逻辑键、分组与帧数结构，
// 图形全是现场画的色块（方向箭头、帧号条、主人色描边），不含任何原版字节或数值。
// 浏览器模式读不到 .cache/synthetic-pack（Vite server.fs.deny），所以在浏览器里现场生成；位图用 OffscreenCanvas 画，
// 主人色掩膜与 extract 一样是不带 alpha 的灰度图（白 = 描边）。flics 选项另带原版舞台的合成 FLIC 与 flic-map
// （stage/testing/fakeFlics：帧数与帧间隔同原版时长，像素是现场编码的色块）。
import {
  type AssetEntry,
  type AtlasV1,
  atlasFrame,
  type MapSkinV1,
  mapSkinBindingOf,
  type PackManifestV1,
  type SpriteEntry,
} from '@rich4/shared/assets';
import { GOD_KEYS, type MapDef } from '@rich4/shared/data';
import type { OrigBoardPack } from '../createOrigBoard';
import { buildFakeFlicPack, type FakeFlicPack, type FakeFlicPackOptions } from '../stage/testing/fakeFlics';
import { trigViews } from './views';

interface Spec {
  key: string;
  group: string;
  count: number;
  dirs: 1 | 8;
  w: number;
  h: number;
  ax: number;
  ay: number;
  ownerMask: boolean;
  confidence: 'exe' | 'visual' | 'guess';
  anchor: 'frame' | 'center';
  color: string;
}

const COLORS = ['#dc3c3c', '#e68c28', '#dcc828', '#78c83c', '#28aa5a', '#28b4b4', '#3282dc', '#5a50d2', '#a046c8'];

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

const POSES: readonly [string, number, 1 | 8, 'exe' | 'visual' | 'guess'][] = [
  ['stand', 8, 8, 'exe'],
  ['walk', 72, 8, 'exe'],
  ['dice', 72, 8, 'exe'],
  ['moto.stand', 8, 8, 'exe'],
  ['moto.walk', 32, 8, 'exe'],
  ['moto.dice', 8, 8, 'exe'],
  ['car.stand', 8, 8, 'exe'],
  ['car.walk', 32, 8, 'exe'],
  ['car.dice', 8, 8, 'exe'],
  ['engineer.stand', 8, 8, 'guess'],
  ['engineer.walk', 16, 8, 'guess'],
  ['boat.stand', 8, 8, 'exe'],
  ['boat.walk', 24, 8, 'exe'],
  ['boat.dice', 8, 8, 'exe'],
  ['sleepwalk.stand', 8, 8, 'visual'],
  ['sleepwalk.walk', 72, 8, 'visual'],
  ['beggar', 8, 8, 'visual'],
  ['hospital', 8, 8, 'visual'],
  ['jail', 8, 8, 'visual'],
];

function specs(def: MapDef): Spec[] {
  const out: Spec[] = [];
  const add = (key: string, group: string, count: number, dirs: 1 | 8, shape: Partial<Spec> = {}): void => {
    out.push({
      key,
      group,
      count,
      dirs,
      w: 24,
      h: 30,
      ax: 12,
      ay: 29,
      ownerMask: false,
      confidence: 'exe',
      anchor: 'frame',
      color: COLORS[hash(key) % COLORS.length]!,
      ...shape,
    });
  };
  add('board.decor', 'board.common', 17, 1, { w: 40, h: 26, ax: 20, ay: 13, anchor: 'center' });
  add('board.ownerMark', 'board.common', 12, 1, { w: 12, h: 18, ax: 6, ay: 17 });
  add('board.lotHighlight', 'board.common', 5, 1, { confidence: 'guess' });
  const building = { w: 36, h: 44, ax: 18, ay: 40, ownerMask: true };
  add('board.chain', 'board.buildings', 8, 8, building);
  add('board.facility.park', 'board.buildings', 8, 8, building);
  for (const f of ['hotel', 'mall', 'gas', 'lab']) {
    for (let L = 1; L <= 5; L++) add(`board.facility.${f}.${L}`, 'board.buildings', 8, 8, building);
  }
  const g = `map.${def.id}`;
  for (let L = 1; L <= 5; L++) add(`${g}.house.${L}`, g, 8, 8, { ...building, h: 24 + L * 6, ay: 20 + L * 6 });
  add(`${g}.company`, g, 8, 8, { ...building, w: 48, h: 56, ax: 24, ay: 50 });
  for (const k of ['hospital', 'jail', 'scenery'])
    add(`${g}.landmark.${k}`, g, 8, 8, { ...building, ownerMask: false });
  for (let c = 0; c < 12; c++) {
    for (const [p, n, dirs, conf] of POSES) add(`char.${c}.${p}`, `char.${c}`, n, dirs, { confidence: conf });
  }
  for (const k of ['roadblock', 'mine', 'bomb', 'gift', 'chest'])
    add(`object.${k}`, 'object', 8, 8, { w: 16, h: 16, ax: 8, ay: 15 });
  for (const k of Object.values(GOD_KEYS)) add(`object.${k}`, 'object', 8, 8, { w: 18, h: 26, ax: 9, ay: 25 });
  // ZZZ 与原版同构：以脚底为画点，锚点 y 大于身高（把它抬到头顶上方）
  add('object.zzz', 'object', 6, 1, { w: 26, h: 10, ax: 13, ay: 40 });
  for (const v of ['thief', 'robber', 'thug', 'spy']) {
    add(`npc.villain.${v}.stand`, 'npc', 8, 8);
    add(`npc.villain.${v}.walk`, 'npc', 80, 8);
    add(`npc.villain.${v}.boat`, 'npc', 8, 8);
  }
  return out;
}

const atlasPath = (key: string): string => `sprites/fake/${key}.json`;
const pagePath = (key: string): string => `sprites/fake/${key}.png`;
const maskPath = (key: string): string => `sprites/fake/${key}.mask.png`;

export interface FakePack extends OrigBoardPack {
  readonly skin: MapSkinV1;
  /** 已请求过的逻辑路径（测试断言懒加载） */
  readonly requested: string[];
  /** 位图借出计数（loadImage 成功 +1、releaseImage −1；测试断言销毁后全部归还） */
  readonly borrowedImages: Map<string, number>;
  /** 合成的原版舞台 FLIC（没有要求时为 null） */
  readonly flics: FakeFlicPack | null;
}

export interface FakePackOptions {
  /** 快艇节点（fixture 地图没有；测试行走姿态时指定） */
  boatTiles?: number[];
  /** 带上原版舞台的合成 FLIC 与 flic-map（原版舞台 A8） */
  flics?: boolean | FakeFlicPackOptions;
}

function canvas(w: number, h: number): OffscreenCanvasRenderingContext2D {
  const ctx = new OffscreenCanvas(w, h).getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d 不可用');
  return ctx;
}

const DIR_VEC: readonly [number, number][] = [
  [0, 1],
  [0.7, 0.7],
  [1, 0],
  [0.7, -0.7],
  [0, -1],
  [-0.7, -0.7],
  [-1, 0],
  [-0.7, 0.7],
];

function drawSheet(s: Spec, mask: boolean): OffscreenCanvasRenderingContext2D {
  const ctx = canvas(s.w * s.count, s.h);
  if (mask) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, s.w * s.count, s.h);
  }
  const perDir = s.dirs === 8 ? s.count / 8 : s.count;
  for (let i = 0; i < s.count; i++) {
    const x0 = i * s.w;
    if (mask) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(x0 + 2, 2, s.w - 4, s.h - 4);
      continue;
    }
    ctx.fillStyle = s.color;
    ctx.fillRect(x0 + 3, 3, s.w - 6, s.h - 6);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x0 + 3, 3, Math.min(s.w - 6, (i % perDir) + 1), 2);
    if (s.dirs === 8) {
      const [vx, vy] = DIR_VEC[Math.trunc(i / perDir)]!;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x0 + s.w / 2, s.h / 2);
      ctx.lineTo(x0 + s.w / 2 + vx * 7, s.h / 2 + vy * 7);
      ctx.stroke();
    }
  }
  return ctx;
}

function drawGround(def: MapDef, w: number, h: number): OffscreenCanvasRenderingContext2D {
  const ctx = canvas(w, h);
  for (let y = 0; y < def.grid.h; y++) {
    for (let x = 0; x < def.grid.w; x++) {
      const t = def.terrain[y]?.[x] ?? 'g';
      ctx.fillStyle = t === 'w' ? '#285aaa' : (x + y) % 2 === 0 ? '#469646' : '#3c8039';
      ctx.fillRect(x * 32, y * 32, 32, 32);
    }
  }
  ctx.fillStyle = '#6e6e6e';
  for (const c of def.roadCells) ctx.fillRect(c.x * 32, c.y * 32, 32, 32);
  ctx.fillStyle = '#aaaaaa';
  for (const t of def.tiles) ctx.fillRect(t.world.x - 12, t.world.y - 12, 24, 24);
  return ctx;
}

/** 为 fixture 地图现场生成内存合成素材包 */
export function buildFakePack(def: MapDef, o: FakePackOptions = {}): FakePack {
  const all = specs(def);
  const byKey = new Map(all.map((s) => [s.key, s]));
  const byFile = new Map<string, { spec: Spec; kind: 'atlas' | 'page' | 'mask' }>();
  const files: PackManifestV1['files'] = {};
  const fileEntry = (lp: string) =>
    ({
      path: lp,
      bytes: 1,
      sha256: '0'.repeat(64),
      kind: 'image',
      contentType: 'image/png',
    }) as PackManifestV1['files'][string];
  for (const s of all) {
    byFile.set(atlasPath(s.key), { spec: s, kind: 'atlas' });
    byFile.set(pagePath(s.key), { spec: s, kind: 'page' });
    files[atlasPath(s.key)] = { ...fileEntry(atlasPath(s.key)), kind: 'atlas', contentType: 'application/json' };
    files[pagePath(s.key)] = fileEntry(pagePath(s.key));
    if (s.ownerMask) {
      byFile.set(maskPath(s.key), { spec: s, kind: 'mask' });
      files[maskPath(s.key)] = fileEntry(maskPath(s.key));
    }
  }
  const world = { w: def.grid.w * 32, h: def.grid.h * 32 };
  const groundFile = `ground/${def.id}/0_0.png`;
  files[groundFile] = fileEntry(groundFile);
  const g = `map.${def.id}`;
  const facility = (k: string) => [1, 2, 3, 4, 5].map((L) => `board.facility.${k}.${L}`);
  const lm: Record<string, string> = {
    hospital: `${g}.landmark.hospital`,
    jail: `${g}.landmark.jail`,
    scenery: `${g}.landmark.scenery`,
  };
  const skin: MapSkinV1 = {
    schema: 'rich4.mapskin/1',
    mapId: def.id,
    binding: mapSkinBindingOf(def),
    world,
    ground: { chunks: [{ file: groundFile, x: 0, y: 0, w: world.w, h: world.h }], overlap: 0 },
    minimap: null,
    projection: {
      origin: { x: 220, y: 260 },
      viewport: { x: 0, y: 40, w: 440, h: 440 },
      views: trigViews().map((v) => ({ ...v, maxErrPx: null })),
      initialView: 0,
      cameraClamp: null,
      exact: null,
    },
    decor: {
      sprite: 'board.decor',
      nodes: def.tiles
        .filter((t) => t.landingCode >= 1 && t.landingCode <= 16)
        .map((t) => ({ tile: t.id, frame: t.landingCode - 1 }))
        .sort((a, b) => a.tile - b.tile),
    },
    buildings: {
      frameRule: 'facing-view-8',
      house: { levels: [1, 2, 3, 4, 5].map((L) => `${g}.house.${L}`), chain: 'board.chain' },
      facilities: {
        park: 'board.facility.park',
        hotel: facility('hotel'),
        mall: facility('mall'),
        gas: facility('gas'),
        lab: facility('lab'),
      },
      companies: [...def.companies]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((c) => ({ lot: c.id, sprite: `${g}.company`, spriteId: null })),
      ownerMark: 'board.ownerMark',
      lotHighlight: { sprite: 'board.lotHighlight', confidence: 'guess' },
    },
    scenery: def.landmarks.map((l, i) => ({
      id: `S${i + 1}`,
      world: { x: (l.rect.x + l.rect.w / 2) * 32, y: (l.rect.y + l.rect.h / 2) * 32 },
      sprite: lm[l.kind]!,
      facing: 0,
      spriteId: null,
      landmark: l.id,
    })),
    boatTiles: [...(o.boatTiles ?? [])].sort((a, b) => a - b),
    src: ['fake'],
  };
  const entries: Record<string, AssetEntry> = {};
  for (const s of all) {
    const e: SpriteEntry = {
      type: 'sprite',
      group: s.group,
      confidence: s.confidence,
      src: ['fake'],
      atlas: [atlasPath(s.key)],
      frames: { base: `F#${s.key}`, start: 0, count: s.count },
      dirs: s.dirs,
      frameMs: null,
      transparency: 'index0',
      ownerMask: s.ownerMask,
      anchor: s.anchor,
    };
    entries[s.key] = e;
  }
  const manifest = {
    schema: 'rich4.assets/1',
    packId: '0123456789abcdef',
    generator: 'fake',
    edition: 'v206',
    license: 'private-personal-use',
    source: { files: {}, exeSha256: null },
    tools: { ffmpeg: null },
    features: {
      board: true,
      ui: false,
      fx: false,
      minigames: false,
      audio: false,
      voice: false,
      music: false,
      video: false,
    },
    groups: {},
    files,
    entries,
    maps: {},
  } as unknown as PackManifestV1;
  const requested: string[] = [];
  const borrowedImages = new Map<string, number>();
  const lend = (lp: string, img: ImageBitmap): ImageBitmap => {
    borrowedImages.set(lp, (borrowedImages.get(lp) ?? 0) + 1);
    return img;
  };
  const flics = o.flics ? buildFakeFlicPack(o.flics === true ? {} : o.flics) : null;
  if (flics) Object.assign(entries, flics.entries);
  return {
    skin,
    requested,
    borrowedImages,
    flics,
    manifest,
    usableEntry(key, opts = {}) {
      if (flics && !byKey.has(key)) return flics.usableEntry(key);
      const s = byKey.get(key);
      if (!s) return null;
      if (s.confidence === 'guess' && opts.allowGuess !== true) return null;
      return entries[key] ?? null;
    },
    ...(flics
      ? {
          loadFlic: (key: string, signal?: AbortSignal) => flics.loadFlic(key, signal),
          loadData: (key: string, signal?: AbortSignal) => flics.loadData(key, signal),
        }
      : {}),
    async loadAtlas(lp) {
      requested.push(lp);
      const f = byFile.get(lp);
      if (f?.kind !== 'atlas') throw new Error(`fake pack: 没有图集 ${lp}`);
      const s = f.spec;
      const frames: AtlasV1['frames'] = {};
      const anchorsPx: AtlasV1['meta']['r4']['anchorsPx'] = {};
      for (let i = 0; i < s.count; i++) {
        const name = `F#${s.key}/${i}`;
        frames[name] = atlasFrame({ x: i * s.w, y: 0, w: s.w, h: s.h }, s.ax, s.ay);
        anchorsPx[name] = [s.ax, s.ay];
      }
      return {
        schema: 'rich4.atlas/1',
        frames,
        meta: {
          app: 'fake',
          version: '1',
          image: `${s.key}.png`,
          format: 'RGBA8888',
          size: { w: s.w * s.count, h: s.h },
          scale: '1',
          r4: { anchorsPx, mask: s.ownerMask ? `${s.key}.mask.png` : null, transparency: 'index0', src: ['fake'] },
        },
      };
    },
    async loadImage(lp) {
      requested.push(lp);
      if (lp === groundFile) return lend(lp, drawGround(def, world.w, world.h).canvas.transferToImageBitmap());
      const f = byFile.get(lp);
      if (!f || f.kind === 'atlas') throw new Error(`fake pack: 没有位图 ${lp}`);
      return lend(lp, drawSheet(f.spec, f.kind === 'mask').canvas.transferToImageBitmap());
    },
    releaseImage(lp) {
      // 多还（没借就还）会留下负数，测试断言借出表最后为空即可同时发现漏还与多还
      const n = (borrowedImages.get(lp) ?? 0) - 1;
      if (n === 0) borrowedImages.delete(lp);
      else borrowedImages.set(lp, n);
    },
    async loadMapSkin(id) {
      if (id !== def.id) throw new Error(`fake pack: 没有地图 ${id}`);
      return skin;
    },
  };
}
