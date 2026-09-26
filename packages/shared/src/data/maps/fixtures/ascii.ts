import { computeMapDataHash } from '../dataHash';
import { cellKey, industryKeyOf, kindForLandingCode, SLOT_DIRS, slotOfStep } from '../kinds';
import type {
  Cell,
  CompanyDef,
  Decoration,
  FacilityLot,
  HolidayDef,
  LandLot,
  LandmarkDef,
  LotId,
  MapDef,
  Rect,
  Rent6,
  StockDef,
  StreetDef,
  TileDef,
  TileId,
  TileLink,
  World,
} from '../types';
import { countMap } from '../validate';

/**
 * ASCII 布局 + 声明表 → MapDef 的确定性生成器（design/data-pipeline.md §11）。
 *
 * 布局每行是空白分隔的 token，一个 token 对应一格：
 *   `.` 空地   `~` 水（地形 w）   `=` 连接格（via，须由 viaLinks 声明）
 *   数字       TileId（1 基，要求 1..n 连续）
 *   其他符号   areas 里声明的地块 / 企业 / 地标，占满其包围矩形
 * 4-相邻的两格自动连边，槽号固定 N=0、E=1、S=2、W=3；world = cell×32。
 */
export interface Names {
  'zh-TW': string;
  'zh-CN': string;
}

export interface AsciiTileSpec {
  id: TileId;
  /** 落点码 0..16 */
  code: number;
  lot?: LotId;
  landmark?: string;
  holdFor?: 'hospital' | 'jail';
  noItems?: boolean;
  name?: Names;
}

export type AsciiArea =
  | {
      symbol: string;
      kind: 'land';
      id: `L${number}`;
      streetId: string;
      landPrice: number;
      housePrice: number;
      rent: Rent6;
    }
  | {
      symbol: string;
      kind: 'facility';
      id: `F${number}`;
      landPrice: number;
      housePrice: number;
      rateWindow: Rent6;
      name: Names;
    }
  | {
      symbol: string;
      kind: 'company';
      id: `C${number}`;
      industry: number;
      stockIndex: number;
      tollBase: number;
      assetValue: number;
      name: Names;
    }
  | { symbol: string; kind: 'landmark'; id: string; landmarkKind: LandmarkDef['kind']; name: Names };

export interface AsciiStreetSpec {
  id: string;
  /** 街道名，同时也是该街每块住宅地的名称 */
  name: Names;
}

export interface AsciiStockSpec {
  name: Names;
  hasCompany: boolean;
  float: number;
  initPriceCents: number;
  volatility: number;
}

export interface AsciiViaLink {
  a: TileId;
  b: TileId;
  /** 从 a 到 b 依次经过的连接格 */
  via: Cell[];
}

export interface AsciiMapSpec {
  id: string;
  name: Names;
  layout: readonly string[];
  tiles: readonly AsciiTileSpec[];
  areas: readonly AsciiArea[];
  streets: readonly AsciiStreetSpec[];
  /** [from, to]：从 from 经该槽去 to 被静态封路 */
  blocked?: readonly (readonly [TileId, TileId])[];
  /** 取消这两格之间的自动连边 */
  noLink?: readonly (readonly [TileId, TileId])[];
  viaLinks?: readonly AsciiViaLink[];
  stocks: readonly AsciiStockSpec[];
  holidays: readonly HolidayDef[];
  decorations: readonly Decoration[];
}

export const FIXTURE_WORLD_SCALE = 32;
export const ASCII_GENERATOR = 'rich4-shared/ascii@1';

function fail(spec: AsciiMapSpec, msg: string): never {
  throw new Error(`buildAsciiMap(${spec.id}): ${msg}`);
}

function toWorld(c: Cell): World {
  return { x: c.x * FIXTURE_WORLD_SCALE, y: c.y * FIXTURE_WORLD_SCALE };
}

/** 矩形中心（1×1 时等于 cell×32） */
function rectWorld(r: Rect): World {
  const half = FIXTURE_WORLD_SCALE / 2;
  return { x: r.x * FIXTURE_WORLD_SCALE + (r.w - 1) * half, y: r.y * FIXTURE_WORLD_SCALE + (r.h - 1) * half };
}

/** f32 位型的 8 位小写 hex */
export function f32Hex(x: number): string {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setFloat32(0, x);
  return dv.getUint32(0).toString(16).padStart(8, '0');
}

function lotNum(id: string): number {
  return Number.parseInt(id.slice(1), 10);
}

export function buildAsciiMap(spec: AsciiMapSpec): MapDef {
  const rows = spec.layout.map((r) => r.trim().split(/\s+/));
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  if (h === 0 || w === 0) fail(spec, 'empty layout');
  rows.forEach((r, y) => {
    if (r.length !== w) fail(spec, `row ${y} has ${r.length} cells, want ${w}`);
  });

  const tileCells = new Map<TileId, Cell>();
  const areaCells = new Map<string, Cell[]>();
  const roadCells: Cell[] = [];
  const tokenAt = new Map<string, string>();
  const areaBySymbol = new Map(spec.areas.map((a) => [a.symbol, a]));
  rows.forEach((r, y) => {
    r.forEach((tok, x) => {
      const cell = { x, y };
      tokenAt.set(cellKey(cell), tok);
      if (tok === '.' || tok === '~') return;
      if (tok === '=') roadCells.push(cell);
      else if (/^\d+$/.test(tok)) {
        const id = Number.parseInt(tok, 10);
        if (tileCells.has(id)) fail(spec, `tile ${id} appears twice`);
        tileCells.set(id, cell);
      } else if (areaBySymbol.has(tok)) {
        const list = areaCells.get(tok);
        if (list) list.push(cell);
        else areaCells.set(tok, [cell]);
      } else fail(spec, `unknown symbol "${tok}" at ${x},${y}`);
    });
  });

  const specById = new Map(spec.tiles.map((t) => [t.id, t]));
  const n = tileCells.size;
  for (let id = 1; id <= n; id++) {
    if (!tileCells.has(id)) fail(spec, `tile ids must be 1..${n}, missing ${id}`);
    if (!specById.has(id)) fail(spec, `tile ${id} has no declaration`);
  }
  if (spec.tiles.length !== n) fail(spec, 'tile declarations do not match the layout');

  // 连边：自动 4-相邻 + via 长边
  const pairKey = (a: TileId, b: TileId) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const noLink = new Set((spec.noLink ?? []).map(([a, b]) => pairKey(a, b)));
  const blocked = new Set((spec.blocked ?? []).map(([a, b]) => `${a}>${b}`));
  const tileAt = new Map<string, TileId>();
  for (const [id, c] of tileCells) tileAt.set(cellKey(c), id);
  const links = new Map<TileId, TileLink[]>();
  const addLink = (from: TileId, to: TileId, slot: TileLink['slot'], via?: Cell[]) => {
    const list = links.get(from) ?? [];
    if (list.some((l) => l.slot === slot)) fail(spec, `tile ${from} slot ${slot} used twice`);
    const link: TileLink = { to, slot, blocked: blocked.has(`${from}>${to}`) };
    if (via) link.via = via.map((c) => ({ x: c.x, y: c.y }));
    list.push(link);
    links.set(from, list);
  };
  for (let id = 1; id <= n; id++) {
    const c = tileCells.get(id)!;
    SLOT_DIRS.forEach((d, slot) => {
      const other = tileAt.get(cellKey({ x: c.x + d.x, y: c.y + d.y }));
      if (other !== undefined && !noLink.has(pairKey(id, other))) addLink(id, other, slot as TileLink['slot']);
    });
  }
  const usedRoad = new Set<string>();
  for (const vl of spec.viaLinks ?? []) {
    const a = tileCells.get(vl.a);
    const b = tileCells.get(vl.b);
    if (!a || !b || vl.via.length === 0) fail(spec, `bad via link ${vl.a}-${vl.b}`);
    const chain = [a, ...vl.via, b];
    for (let k = 1; k < chain.length; k++) {
      if (slotOfStep(chain[k - 1]!, chain[k]!) === null) fail(spec, `via ${vl.a}-${vl.b} is not an axial chain`);
    }
    for (const c of vl.via) {
      const k = cellKey(c);
      if (tokenAt.get(k) !== '=' || usedRoad.has(k)) fail(spec, `via cell ${k} is not a free "=" cell`);
      usedRoad.add(k);
    }
    addLink(vl.a, vl.b, slotOfStep(a, vl.via[0]!)!, vl.via);
    addLink(vl.b, vl.a, slotOfStep(b, vl.via[vl.via.length - 1]!)!, [...vl.via].reverse());
  }
  if (usedRoad.size !== roadCells.length) fail(spec, 'every "=" cell must belong to exactly one via link');
  for (const k of blocked) {
    const [from, to] = k.split('>').map(Number);
    if (!(links.get(from!) ?? []).some((l) => l.to === to)) fail(spec, `blocked ${k} is not a link`);
  }

  const tiles: TileDef[] = [];
  for (let id = 1; id <= n; id++) {
    const ts = specById.get(id)!;
    const cell = tileCells.get(id)!;
    const kind = kindForLandingCode(ts.code, ts.lot !== undefined);
    if (kind === null) fail(spec, `tile ${id} has invalid landing code ${ts.code}`);
    const ref: NonNullable<TileDef['ref']> = {};
    if (ts.lot !== undefined) ref.lot = ts.lot;
    if (ts.landmark !== undefined) ref.landmark = ts.landmark;
    tiles.push({
      id,
      cell,
      world: toWorld(cell),
      kind,
      landingCode: ts.code,
      ...(ts.lot !== undefined || ts.landmark !== undefined ? { ref } : {}),
      links: (links.get(id) ?? []).sort((x, y) => x.slot - y.slot),
      noItems: ts.noItems === true,
      ...(ts.holdFor !== undefined ? { holdFor: ts.holdFor } : {}),
      ...(ts.name !== undefined ? { nameKey: `map.${spec.id}.tile.${id}` } : {}),
    });
  }

  // 地块矩形：取包围盒，并要求被该符号占满
  const rectOf = (symbol: string): Rect => {
    const cells = areaCells.get(symbol);
    if (!cells) fail(spec, `area ${symbol} does not appear in the layout`);
    const xs = cells.map((c) => c.x);
    const ys = cells.map((c) => c.y);
    const r = { x: Math.min(...xs), y: Math.min(...ys), w: 0, h: 0 };
    r.w = Math.max(...xs) - r.x + 1;
    r.h = Math.max(...ys) - r.y + 1;
    if (cells.length !== r.w * r.h) fail(spec, `area ${symbol} is not a filled rectangle`);
    return r;
  };
  const frontOf = (id: LotId) => spec.tiles.filter((t) => t.lot === id).map((t) => t.id);
  const nk = (kind: string, id: string | number) => `map.${spec.id}.${kind}.${id}`;

  const lands: LandLot[] = [];
  const facilities: FacilityLot[] = [];
  const companies: CompanyDef[] = [];
  const landmarks: LandmarkDef[] = [];
  for (const a of spec.areas) {
    const rect = rectOf(a.symbol);
    if (a.kind === 'land') {
      lands.push({
        id: a.id,
        world: rectWorld(rect),
        rect,
        frontTiles: frontOf(a.id),
        nameKey: nk('lot', a.id),
        kind: 'land',
        streetId: a.streetId,
        landPrice: a.landPrice,
        housePrice: a.housePrice,
        rent: [...a.rent],
      });
    } else if (a.kind === 'facility') {
      facilities.push({
        id: a.id,
        world: rectWorld(rect),
        rect,
        frontTiles: frontOf(a.id),
        nameKey: nk('lot', a.id),
        kind: 'facility',
        landPrice: a.landPrice,
        housePrice: a.housePrice,
        rateWindow: [...a.rateWindow],
      });
    } else if (a.kind === 'company') {
      companies.push({
        id: a.id,
        world: rectWorld(rect),
        rect,
        frontTiles: frontOf(a.id),
        nameKey: nk('company', a.id),
        kind: 'company',
        industry: a.industry,
        industryKey: industryKeyOf(a.industry),
        stockIndex: a.stockIndex,
        tollBase: a.tollBase,
        assetValue: a.assetValue,
      });
    } else {
      const m: LandmarkDef = { id: a.id, kind: a.landmarkKind, rect, nameKey: nk('landmark', a.id) };
      const hold = spec.tiles.find((t) => t.landmark === a.id && t.holdFor !== undefined);
      if (hold) m.holdTile = hold.id;
      landmarks.push(m);
    }
  }
  const byNum = (x: { id: string }, y: { id: string }) => lotNum(x.id) - lotNum(y.id);
  lands.sort(byNum);
  facilities.sort(byNum);
  companies.sort(byNum);

  const streets: StreetDef[] = spec.streets.map((s) => ({
    id: s.id,
    nameKey: nk('street', s.id),
    lots: lands.filter((l) => l.streetId === s.id).map((l) => l.id),
  }));
  const stocks: StockDef[] = spec.stocks.map((s, index) => ({
    index,
    nameKey: nk('stock', index),
    hasCompany: s.hasCompany,
    float: s.float,
    initPriceCents: s.initPriceCents,
    volatility: s.volatility,
    volatilityF32: f32Hex(s.volatility),
  }));

  for (const d of spec.decorations) {
    if (tokenAt.get(cellKey(d.cell)) !== '.') fail(spec, `decoration at ${cellKey(d.cell)} is not on a free cell`);
  }

  // 文案：住宅地名 = 所在街道名
  const strings: MapDef['strings'] = { 'zh-TW': {}, 'zh-CN': {} };
  const put = (key: string, names: Names) => {
    strings['zh-TW'][key] = names['zh-TW'];
    strings['zh-CN'][key] = names['zh-CN'];
  };
  put(`map.${spec.id}.name`, spec.name);
  const streetName = new Map(spec.streets.map((s) => [s.id, s.name]));
  for (const s of streets) put(s.nameKey, streetName.get(s.id)!);
  for (const l of lands) {
    const name = streetName.get(l.streetId);
    if (!name) fail(spec, `lot ${l.id} is in unknown street ${l.streetId}`);
    put(l.nameKey, name);
  }
  for (const a of spec.areas) {
    if (a.kind === 'facility') put(nk('lot', a.id), a.name);
    else if (a.kind === 'company') put(nk('company', a.id), a.name);
    else if (a.kind === 'landmark') put(nk('landmark', a.id), a.name);
  }
  for (const [i, s] of spec.stocks.entries()) put(nk('stock', i), s.name);
  for (const t of spec.tiles) if (t.name) put(nk('tile', t.id), t.name);

  const def: MapDef = {
    schemaVersion: 1,
    id: spec.id,
    globalMapId: null,
    nameKey: `map.${spec.id}.name`,
    grid: { w, h },
    terrain: rows.map((r) => r.map((tok) => (tok === '~' ? 'w' : 'g')).join('')),
    tiles,
    roadCells,
    lots: [...lands, ...facilities],
    companies,
    landmarks,
    streets,
    stocks,
    holidays: spec.holidays.map((x) => ({ ...x })),
    decorations: spec.decorations.map((d) => ({
      kind: d.kind,
      cell: { x: d.cell.x, y: d.cell.y },
      variant: d.variant,
    })),
    strings,
    meta: {
      source: { fixture: true },
      counts: { nodes: 0, lands: 0, facilities: 0, companies: 0, landscapes: 0 },
      dataHash: '',
      generator: ASCII_GENERATOR,
    },
  };
  def.meta.counts = countMap(def);
  def.meta.dataHash = computeMapDataHash(def);
  return def;
}
