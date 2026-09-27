/**
 * 原版皮肤 A2：地图皮肤 MapSkinV1（schema 'rich4.mapskin/1'；docs/design/original-skin.md §3 修正 9，design-draft §2.5）。
 *
 * - 绑定：MapDef.meta.source.resourceSha256 + 几何摘要（tiles[].world、lots[].world/facing、companies[].world/facing），
 *   由 shared mapSkinBindingOf 计算；不绑定 meta.dataHash。
 * - 投影：exe 视角表 cellScreen（v2.06 0x46ab9c）按格点最小二乘拟合 8 个仿射。表项顺序是 **[view][dy+14][dx+14] → (sy, sx)**，
 *   dy 在外层、先 sy 后 sx（render.md §1.2 反汇编与渲染验证；exe/types.ts 的注释把轴序写反了，以调研结论为准）。
 *   每视角：sx ≈ Ax·dx + Bx·dy + Cx、sy ≈ Ay·dx + By·dy + Cy（dx、dy 为格差）；按世界像素：a=Ax/32、c=Bx/32、b=Ay/32、d=By/32、
 *   tx=Cx、ty=Cy（Pixi Matrix 约定：屏幕 = origin + M·(世界 − 镜头) + t）。另附原版精确表（可选画质项）。
 * - 装饰、快艇节点、景观坐标/精灵号/朝向、企业精灵号从 raw 地图（与 MapDef 同一来源资源）读取，并与 MapDef 逐项交叉核对。
 * - 合成皮肤（fixture 地图，CI 用）：投影用我们自己的参数化（θ = −22.5° + 45°·view、1.2172 px/世界像素、纵向 0.7086），
 *   不含任何原版数值。
 */
import {
  type Affine,
  EXACT_TABLE_SPAN,
  type MapSkinV1,
  mapSkinBindingOf,
  parseMapSkin,
  VIEW_COUNT,
} from '@rich4/shared/assets';
import type { MapDef } from '@rich4/shared/data';
import { ExtractError } from '../context';
import type { MapDataRaw } from '../map/rawTypes';
import { FACILITY_KINDS, LANDMARK_SPRITE_OFFSET } from './catalog.v206';

/** exe 视角表（tables.v206.json 的 view 字段形状） */
export interface ViewTablesInput {
  cellScreen: { va?: string; data: [number, number][][] };
  subcell: { va?: string; data: [number, number, number, number][] };
}

/** 原版投影中心与棋盘视窗（render.md §1.3：0x408001/0x408009、裁剪矩形 0x483498 初值） */
export const ORIGIN = { x: 220, y: 260 } as const;
export const VIEWPORT = { x: 0, y: 40, w: 440, h: 440 } as const;
/** 镜头夹取（oama 对 v3.11 的结论，v2.06 未读 → guess） */
export const CAMERA_CLAMP = { min: { x: 220, y: 220 }, max: { x: 2084, y: 2084 } } as const;
const HALF = (EXACT_TABLE_SPAN - 1) / 2;

const round6 = (x: number): number => {
  const r = Math.round(x * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
};
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** 3×3 线性方程组（高斯消元，列主元）；无解抛错 */
function solve3(m: number[][], v: number[]): [number, number, number] {
  const a = m.map((row, i) => [...row, v[i]!]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    if (Math.abs(a[piv]![col]!) < 1e-12) throw new ExtractError('E_SKIN_FIT', '最小二乘矩阵奇异');
    [a[col], a[piv]] = [a[piv]!, a[col]!];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = a[r]![col]! / a[col]![col]!;
      for (let k = col; k < 4; k++) a[r]![k]! -= f * a[col]![k]!;
    }
  }
  return [a[0]![3]! / a[0]![0]!, a[1]![3]! / a[1]![1]!, a[2]![3]! / a[2]![2]!];
}

export interface ViewFit {
  view: number;
  /** 按格差的系数：[dx, dy, 常数] */
  sx: [number, number, number];
  sy: [number, number, number];
  affine: Affine;
}

/** 按格点最小二乘拟合 8 个视角（点为 dx,dy ∈ −14..14 的整格差）；maxErrPx 为分轴最大残差（与调研 projection-fit 同口径） */
export function fitViewAffines(view: ViewTablesInput): ViewFit[] {
  const tbl = view.cellScreen.data;
  const n = EXACT_TABLE_SPAN * EXACT_TABLE_SPAN;
  if (tbl.length !== VIEW_COUNT || tbl.some((t) => t.length !== n)) {
    throw new ExtractError(
      'E_SKIN_VIEW',
      `视角表形状应为 ${VIEW_COUNT}×${n}，实为 ${tbl.length}×${tbl[0]?.length ?? 0}`,
    );
  }
  return tbl.map((cells, v) => {
    // 法方程 Σ[x x^T] β = Σ[x s]，x = (dx, dy, 1)
    const M = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const bx = [0, 0, 0];
    const by = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const dy = Math.trunc(i / EXACT_TABLE_SPAN) - HALF;
      const dx = (i % EXACT_TABLE_SPAN) - HALF;
      const [sy, sx] = cells[i]!;
      const x = [dx, dy, 1];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) M[r]![c]! += x[r]! * x[c]!;
        bx[r]! += x[r]! * sx;
        by[r]! += x[r]! * sy;
      }
    }
    const fx = solve3(M, bx).map(round6) as [number, number, number];
    const fy = solve3(M, by).map(round6) as [number, number, number];
    let maxErr = 0;
    for (let i = 0; i < n; i++) {
      const dy = Math.trunc(i / EXACT_TABLE_SPAN) - HALF;
      const dx = (i % EXACT_TABLE_SPAN) - HALF;
      const [sy, sx] = cells[i]!;
      const ex = fx[0] * dx + fx[1] * dy + fx[2] - sx;
      const ey = fy[0] * dx + fy[1] * dy + fy[2] - sy;
      maxErr = Math.max(maxErr, Math.abs(ex), Math.abs(ey));
    }
    return {
      view: v,
      sx: fx,
      sy: fy,
      affine: {
        a: round6(fx[0] / 32),
        b: round6(fy[0] / 32),
        c: round6(fx[1] / 32),
        d: round6(fy[1] / 32),
        tx: fx[2],
        ty: fy[2],
        maxErrPx: round3(maxErr),
      },
    };
  });
}

/** 原版精确表：cellScreen 按 [view][dy+14][dx+14] → (sy, sx) 展平；subcell 每视角 m0..m3 */
export function exactTables(view: ViewTablesInput, src: string[]): NonNullable<MapSkinV1['projection']['exact']> {
  const cellScreen: number[] = [];
  for (const t of view.cellScreen.data) for (const [sy, sx] of t) cellScreen.push(sy, sx);
  const subcell: number[] = [];
  for (const m of view.subcell.data) subcell.push(...m);
  return { cellScreen, subcell, src };
}

// ───────────────────────── 原版地图 ─────────────────────────

export interface OriginalSkinInput {
  mapDef: MapDef;
  raw: MapDataRaw;
  view: ViewTablesInput;
  world: { w: number; h: number };
  ground: { chunks: { file: string; x: number; y: number; w: number; h: number }[]; overlap: number };
  /** 装饰帧数（map#12） */
  decorFrames: number;
  /** 条目键 */
  keys: {
    minimap: string | null;
    decor: string;
    houses: string[];
    chain: string;
    ownerMark: string;
    lotHighlight: string;
  };
  src: string[];
  /** 期望引用的企业/景观精灵资源号（资源目录登记的集合；给出时逐项核对） */
  expectSprites?: { companies: readonly number[]; scenery: readonly number[] };
}

function fail(msg: string): never {
  throw new ExtractError('E_SKIN_MISMATCH', msg);
}

/**
 * 核对 raw 地图与 MapDef 来自同一资源、几何一致（节点 world、地块 world/facing、企业 world/facing）。
 * 不一致说明 MapDef 与原版文件不同源，皮肤会错位，直接失败。
 */
export function crossCheckRaw(def: MapDef, raw: MapDataRaw): void {
  const src = def.meta.source;
  if (!('resourceSha256' in src)) fail(`MapDef ${def.id} 不是原版地图（meta.source 为 fixture）`);
  if (src.resourceSha256 !== raw.source.resourceSha256) {
    fail(`MapDef.meta.source.resourceSha256=${src.resourceSha256} 与原版资源 ${raw.source.resourceSha256} 不同`);
  }
  const tiles = new Map(def.tiles.map((t) => [t.id, t]));
  if (tiles.size !== raw.nodes.length) fail(`节点数 ${tiles.size} ≠ raw ${raw.nodes.length}`);
  for (const n of raw.nodes) {
    const t = tiles.get(n.id);
    if (!t || t.world.x !== n.x || t.world.y !== n.y) fail(`节点 ${n.id} 的 world 与 raw (${n.x},${n.y}) 不符`);
  }
  const lots = new Map<string, MapDef['lots'][number]>(def.lots.map((l) => [l.id, l]));
  const checkLot = (id: string, x: number, y: number, facing: number) => {
    const l = lots.get(id);
    if (!l || l.world.x !== x || l.world.y !== y || (l.facing ?? 0) !== facing) {
      fail(`地块 ${id} 的 world/facing 与 raw (${x},${y}) f${facing} 不符`);
    }
  };
  for (const l of raw.lands) checkLot(`L${l.id}`, l.x, l.y, l.facing);
  for (const f of raw.facilities) checkLot(`F${f.id}`, f.x, f.y, f.facing);
  const comps = new Map<string, MapDef['companies'][number]>(def.companies.map((c) => [c.id, c]));
  for (const c of raw.companies) {
    const d = comps.get(`C${c.id}`);
    if (!d || d.world.x !== c.x || d.world.y !== c.y || (d.facing ?? 0) !== c.facing) {
      fail(`企业 C${c.id} 的 world/facing 与 raw 不符`);
    }
  }
}

/** 由 raw 地图 + MapDef + exe 视角表生成原版地图皮肤（结构与一致性经 parseMapSkin 校验） */
export function buildOriginalSkin(input: OriginalSkinInput): MapSkinV1 {
  const { mapDef: def, raw } = input;
  crossCheckRaw(def, raw);
  const fits = fitViewAffines(input.view);
  const decorNodes = raw.nodes
    .filter((n) => n.decor > 0)
    .map((n) => {
      if (n.decor > input.decorFrames) fail(`节点 ${n.id} 的 decor=${n.decor} 超过装饰帧数 ${input.decorFrames}`);
      return { tile: n.id, frame: n.decor - 1 };
    })
    .sort((a, b) => a.tile - b.tile);
  const boatTiles = raw.nodes
    .filter((n) => (n.flags & 0x80000000) !== 0)
    .map((n) => n.id)
    .sort((a, b) => a - b);
  const landmarkIds = new Set(def.landmarks.map((l) => l.id));
  const sceneryRes = new Set<number>();
  const scenery = raw.landscapes.map((ls) => {
    if (ls.facing < 0 || ls.facing > 7) fail(`景观 ${ls.id} 的 facing=${ls.facing} 越界`);
    const res = ls.spriteRes + LANDMARK_SPRITE_OFFSET;
    sceneryRes.add(res);
    return {
      id: `S${ls.id}`,
      world: { x: ls.x, y: ls.y },
      sprite: `board.landmark.${res}`,
      facing: ls.facing,
      spriteId: ls.spriteRes,
      landmark: landmarkIds.has(String(ls.id)) ? String(ls.id) : null,
    };
  });
  const companyRes = new Set<number>();
  const companies = raw.companies.map((c) => {
    const res = c.spriteRes + LANDMARK_SPRITE_OFFSET;
    companyRes.add(res);
    return { lot: `C${c.id}`, sprite: `board.landmark.${res}`, spriteId: c.spriteRes };
  });
  const same = (a: Set<number>, b: readonly number[]) => a.size === b.length && b.every((x) => a.has(x));
  const want = input.expectSprites;
  if (want && (!same(companyRes, want.companies) || !same(sceneryRes, want.scenery))) {
    fail(
      `raw 地图引用的企业/景观精灵 [${[...companyRes].sort()}]/[${[...sceneryRes].sort((a, b) => a - b)}] 与资源目录不符`,
    );
  }
  const facility = (i: number) => [1, 2, 3, 4, 5].map((L) => `board.facility.${FACILITY_KINDS[i]}.${L}`);
  const skin: MapSkinV1 = {
    schema: 'rich4.mapskin/1',
    mapId: def.id,
    binding: mapSkinBindingOf(def),
    world: input.world,
    ground: { chunks: input.ground.chunks, overlap: input.ground.overlap },
    minimap: input.keys.minimap ? { sprite: input.keys.minimap, small: 0, large: 1 } : null,
    projection: {
      origin: { ...ORIGIN },
      viewport: { ...VIEWPORT },
      views: fits.map((f) => f.affine),
      initialView: 0,
      cameraClamp: { min: { ...CAMERA_CLAMP.min }, max: { ...CAMERA_CLAMP.max }, confidence: 'guess' },
      exact: exactTables(input.view, [
        `VA ${input.view.cellScreen.va ?? '0x46ab9c'}（cellScreen [view][dy+14][dx+14] → (sy,sx)）`,
        `VA ${input.view.subcell.va ?? '0x4727bc'}（subcell m0..m3，负偏移）`,
      ]),
    },
    decor: { sprite: input.keys.decor, nodes: decorNodes },
    buildings: {
      frameRule: 'facing-view-8',
      house: { levels: input.keys.houses, chain: input.keys.chain },
      facilities: {
        park: 'board.facility.park',
        hotel: facility(0),
        mall: facility(1),
        gas: facility(2),
        lab: facility(3),
      },
      companies,
      ownerMark: input.keys.ownerMark,
      lotHighlight: { sprite: input.keys.lotHighlight, confidence: 'guess' },
    },
    scenery,
    boatTiles,
    src: input.src,
  };
  return parseMapSkin(skin);
}

// ───────────────────────── 合成皮肤（fixture 地图） ─────────────────────────

const C225 = 0.9238795325112867;
const S225 = 0.3826834323650898;
/** 每视角 (cosθ, sinθ)，θ = −22.5° + 45°·view */
const VIEW_TRIG: readonly [number, number][] = [
  [C225, -S225],
  [C225, S225],
  [S225, C225],
  [-S225, C225],
  [-C225, S225],
  [-C225, -S225],
  [-S225, -C225],
  [S225, -C225],
];
/** 合成投影：1.2172 px / 世界像素、纵向压缩 0.7086（我们自己的参数化） */
export const SYNTH_SCALE = 1.2172;
export const SYNTH_SQUASH = 0.7086;

export function syntheticViews(): Affine[] {
  return VIEW_TRIG.map(([cos, sin]) => ({
    a: round6(SYNTH_SCALE * cos),
    b: round6(SYNTH_SQUASH * SYNTH_SCALE * sin),
    c: round6(-SYNTH_SCALE * sin),
    d: round6(SYNTH_SQUASH * SYNTH_SCALE * cos),
    tx: 0,
    ty: 0,
    maxErrPx: null,
  }));
}

/** fixture 地块/企业的朝向缺省为 0；落点码 1..16 的节点画装饰帧 code−1（与原版 decor 顺序一致） */
export interface SyntheticSkinInput {
  mapDef: MapDef;
  ground: { chunks: { file: string; x: number; y: number; w: number; h: number }[]; overlap: number };
  keys: { decor: string; houses: string[]; chain: string; ownerMark: string; lotHighlight: string };
  /** 企业精灵（按企业序号循环取用） */
  companySprites: string[];
  /** 景观精灵：hospital、jail、scenery */
  landmarkSprites: { hospital: string; jail: string; scenery: string };
}

export function buildSyntheticSkin(input: SyntheticSkinInput): MapSkinV1 {
  const def = input.mapDef;
  const world = { w: def.grid.w * 32, h: def.grid.h * 32 };
  const decorNodes = def.tiles
    .filter((t) => t.landingCode >= 1 && t.landingCode <= 16)
    .map((t) => ({ tile: t.id, frame: t.landingCode - 1 }))
    .sort((a, b) => a.tile - b.tile);
  const boatTiles = def.tiles
    .filter((t) => ((t.src?.flags ?? 0) & 0x80000000) !== 0)
    .map((t) => t.id)
    .sort((a, b) => a - b);
  const companies = [...def.companies]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c, i) => ({
      lot: c.id,
      sprite: input.companySprites[i % input.companySprites.length]!,
      spriteId: null,
    }));
  const scenery = def.landmarks.map((l, i) => ({
    id: `S${i + 1}`,
    world: { x: (l.rect.x + l.rect.w / 2) * 32, y: (l.rect.y + l.rect.h / 2) * 32 },
    sprite: input.landmarkSprites[l.kind],
    facing: 0,
    spriteId: null,
    landmark: l.id,
  }));
  const facility = (kind: string) => [1, 2, 3, 4, 5].map((L) => `board.facility.${kind}.${L}`);
  const skin: MapSkinV1 = {
    schema: 'rich4.mapskin/1',
    mapId: def.id,
    binding: mapSkinBindingOf(def),
    world,
    ground: input.ground,
    minimap: null,
    projection: {
      origin: { ...ORIGIN },
      viewport: { ...VIEWPORT },
      views: syntheticViews(),
      initialView: 0,
      cameraClamp: null,
      exact: null,
    },
    decor: { sprite: input.keys.decor, nodes: decorNodes },
    buildings: {
      frameRule: 'facing-view-8',
      house: { levels: input.keys.houses, chain: input.keys.chain },
      facilities: {
        park: 'board.facility.park',
        hotel: facility('hotel'),
        mall: facility('mall'),
        gas: facility('gas'),
        lab: facility('lab'),
      },
      companies,
      ownerMark: input.keys.ownerMark,
      lotHighlight: { sprite: input.keys.lotHighlight, confidence: 'guess' },
    },
    scenery,
    boatTiles,
    src: ['synthetic'],
  };
  return parseMapSkin(skin);
}
