import { INT32_MAX } from '../../util/int32';
import { cellKey, kindForLandingCode, LANDING_HOSPITAL, LANDING_JAIL } from './kinds';
import type { AnyLot, Cell, LandLot, MapCounts, MapDef, MapLocale, Rect, TileDef, TileId, TileLink } from './types';

/**
 * issue code 全集（design/data-pipeline.md §8.4，另加 architecture §16.2 的 W_COMPANY_REMOTE_FRONT）：
 * E_* 为错误，W_* 为警告（W_DIAGONAL_LINK 在 strict4 下升为错误）
 */
export type MapIssueCode =
  | 'E_ID_DUP'
  | 'E_LINK_TARGET'
  | 'E_LINK_ASYM'
  | 'E_SLOT_DUP'
  | 'E_BLOCKED_NOT_LINK'
  | 'E_CELL_COLLIDE'
  | 'E_RECT_INVALID'
  | 'E_OUT_OF_BOUNDS'
  | 'E_OVERLAP'
  | 'E_LOT_FRONT_NOT_ADJ'
  | 'E_LOT_NO_FRONT'
  | 'E_TILE_REF_MISMATCH'
  | 'E_STREET_NAME'
  | 'E_RENT_SHAPE'
  | 'E_PRICE_RANGE'
  | 'E_UNREACHABLE'
  | 'E_HOLD_MISSING'
  | 'E_TERRAIN_SHAPE'
  | 'E_COUNT_MISMATCH'
  | 'E_VIA_BROKEN'
  | 'W_DIAGONAL_LINK'
  | 'W_VIA_LONG'
  | 'W_RENT_NONMONO'
  | 'W_DEADEND'
  | 'W_NAME_EMPTY'
  | 'W_LINK_ONEWAY'
  | 'W_COMPANY_REMOTE_FRONT';

export const MAP_ISSUE_CODES: readonly MapIssueCode[] = [
  'E_ID_DUP',
  'E_LINK_TARGET',
  'E_LINK_ASYM',
  'E_SLOT_DUP',
  'E_BLOCKED_NOT_LINK',
  'E_CELL_COLLIDE',
  'E_RECT_INVALID',
  'E_OUT_OF_BOUNDS',
  'E_OVERLAP',
  'E_LOT_FRONT_NOT_ADJ',
  'E_LOT_NO_FRONT',
  'E_TILE_REF_MISMATCH',
  'E_STREET_NAME',
  'E_RENT_SHAPE',
  'E_PRICE_RANGE',
  'E_UNREACHABLE',
  'E_HOLD_MISSING',
  'E_TERRAIN_SHAPE',
  'E_COUNT_MISMATCH',
  'E_VIA_BROKEN',
  'W_DIAGONAL_LINK',
  'W_VIA_LONG',
  'W_RENT_NONMONO',
  'W_DEADEND',
  'W_NAME_EMPTY',
  'W_LINK_ONEWAY',
  'W_COMPANY_REMOTE_FRONT',
];

export interface MapIssue {
  code: MapIssueCode;
  severity: 'error' | 'warn';
  path: string;
  msg: string;
  tiles?: number[];
  cells?: Cell[];
}

export interface ValidateMapOptions {
  /** 不允许对角 link（台湾图优先使用） */
  strict4?: boolean;
  expect?: Partial<MapCounts>;
}

export interface ValidateMapResult {
  ok: boolean;
  issues: MapIssue[];
}

/** via 连接格超过这个数量时报 W_VIA_LONG */
export const VIA_LONG_THRESHOLD = 3;

/**
 * 企业的远端前沿格允许的落点码：14 银行格、15 百货格（原版大宇百貨的两个百货格分处台湾南北）。
 * 企业至少有一个前沿格与建筑矩形相邻时，这些落点码的不相邻前沿格报 W_COMPANY_REMOTE_FRONT（warn），
 * 其他不相邻前沿格仍报 E_LOT_FRONT_NOT_ADJ（architecture §16.2）。
 */
export const COMPANY_REMOTE_FRONT_CODES: readonly number[] = [14, 15];

const TERRAIN_RE = /^[gwspm]*$/;
const LOCALES: readonly MapLocale[] = ['zh-TW', 'zh-CN'];
const COUNT_KEYS: readonly (keyof MapCounts)[] = ['nodes', 'lands', 'facilities', 'companies', 'landscapes'];

class Issues {
  readonly list: MapIssue[] = [];
  constructor(private readonly strict4: boolean) {}

  add(code: MapIssueCode, path: string, msg: string, extra?: { tiles?: number[]; cells?: Cell[] }): void {
    const error = code.startsWith('E_') || (code === 'W_DIAGONAL_LINK' && this.strict4);
    const issue: MapIssue = { code, severity: error ? 'error' : 'warn', path, msg };
    if (extra?.tiles) issue.tiles = extra.tiles;
    if (extra?.cells) issue.cells = extra.cells;
    this.list.push(issue);
  }
}

interface Ctx {
  def: MapDef;
  v: Issues;
  tileById: Map<TileId, TileDef>;
  lotById: Map<string, AnyLot>;
  roadSet: Set<string>;
}

/**
 * 地图语义校验（纯函数；服务器加载、提取工具自检和测试共用）。
 * 结构（类型、键）先经 MapDefSchema；这里对形状异常的输入也尽量不崩溃而是报 issue。
 */
export function validateMap(def: MapDef, opts: ValidateMapOptions = {}): ValidateMapResult {
  const v = new Issues(opts.strict4 === true);
  const tileById = new Map<TileId, TileDef>();
  for (const t of def.tiles) if (!tileById.has(t.id)) tileById.set(t.id, t);
  const lotById = new Map<string, AnyLot>();
  for (const l of [...def.lots, ...def.companies]) if (!lotById.has(l.id)) lotById.set(l.id, l);
  const roadSet = new Set(def.roadCells.map(cellKey));
  const ctx: Ctx = { def, v, tileById, lotById, roadSet };

  checkIds(ctx);
  checkLinks(ctx);
  checkGeometry(ctx);
  checkTerrain(ctx);
  checkLotRefs(ctx);
  checkStreets(ctx);
  checkPrices(ctx);
  checkGraph(ctx);
  checkHolds(ctx);
  checkCounts(ctx, opts.expect);
  checkNames(ctx);

  return { ok: !v.list.some((i) => i.severity === 'error'), issues: v.list };
}

function isPositiveInt(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

function isPrice(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= INT32_MAX;
}

function rectValid(r: Rect): boolean {
  return Number.isInteger(r.x) && Number.isInteger(r.y) && isPositiveInt(r.w) && isPositiveInt(r.h);
}

/** cell 在矩形外且与矩形某格 4-相邻 */
export function isAdjacentToRect(c: Cell, r: Rect): boolean {
  const inX = c.x >= r.x && c.x < r.x + r.w;
  const inY = c.y >= r.y && c.y < r.y + r.h;
  if (inX && (c.y === r.y - 1 || c.y === r.y + r.h)) return true;
  if (inY && (c.x === r.x - 1 || c.x === r.x + r.w)) return true;
  return false;
}

function lotsWithPath(def: MapDef): { lot: AnyLot; path: string }[] {
  return [
    ...def.lots.map((lot, i) => ({ lot, path: `lots[${i}]` })),
    ...def.companies.map((lot, i) => ({ lot, path: `companies[${i}]` })),
  ];
}

function dupCheck(v: Issues, entries: readonly { key: string | number; path: string }[]): void {
  const seen = new Set<string | number>();
  for (const { key, path } of entries) {
    if (seen.has(key)) v.add('E_ID_DUP', path, `duplicate id ${String(key)}`);
    seen.add(key);
  }
}

function checkIds({ def, v }: Ctx): void {
  def.tiles.forEach((t, i) => {
    if (!isPositiveInt(t.id)) v.add('E_ID_DUP', `tiles[${i}].id`, `tile id must be a positive integer: ${t.id}`);
  });
  dupCheck(
    v,
    def.tiles.map((t, i) => ({ key: t.id, path: `tiles[${i}].id` })),
  );
  dupCheck(
    v,
    lotsWithPath(def).map(({ lot, path }) => ({ key: lot.id, path: `${path}.id` })),
  );
  dupCheck(
    v,
    def.landmarks.map((m, i) => ({ key: m.id, path: `landmarks[${i}].id` })),
  );
  dupCheck(
    v,
    def.streets.map((s, i) => ({ key: s.id, path: `streets[${i}].id` })),
  );
  dupCheck(
    v,
    def.stocks.map((s, i) => ({ key: s.index, path: `stocks[${i}].index` })),
  );
  dupCheck(
    v,
    def.holidays.map((h, i) => ({ key: h.slot, path: `holidays[${i}].slot` })),
  );
}

function sameCells(a: readonly Cell[], b: readonly Cell[]): boolean {
  return a.length === b.length && a.every((c, i) => c.x === b[i]!.x && c.y === b[i]!.y);
}

function checkLinks(ctx: Ctx): void {
  const { def, v, tileById } = ctx;
  def.tiles.forEach((t, i) => {
    const seenSlot = [false, false, false, false];
    const seenTarget = new Set<TileId>();
    let lastSlot = -1;
    t.links.forEach((l, j) => {
      const path = `tiles[${i}].links[${j}]`;
      const slot: number = l.slot;
      if (!Number.isInteger(slot) || slot < 0 || slot > 3) {
        v.add('E_SLOT_DUP', path, `invalid slot ${slot}`, { tiles: [t.id] });
        return;
      }
      if (seenSlot[slot]) v.add('E_SLOT_DUP', path, `tile ${t.id} uses slot ${slot} twice`, { tiles: [t.id] });
      else if (slot < lastSlot)
        v.add('E_SLOT_DUP', path, `tile ${t.id} links are not in slot order`, { tiles: [t.id] });
      seenSlot[slot] = true;
      if (slot > lastSlot) lastSlot = slot;

      const target = tileById.get(l.to);
      if (l.to === t.id || !target) {
        v.add('E_LINK_TARGET', path, `tile ${t.id} links to missing or self tile ${l.to}`, { tiles: [t.id, l.to] });
        return;
      }
      if (seenTarget.has(l.to)) {
        v.add('E_LINK_TARGET', path, `tile ${t.id} links to ${l.to} twice`, { tiles: [t.id, l.to] });
        return;
      }
      seenTarget.add(l.to);

      const back = target.links.find((x) => x.to === t.id);
      if (!back) {
        v.add('E_LINK_ASYM', path, `${t.id}→${l.to} has no reverse link`, { tiles: [t.id, l.to] });
      } else {
        if (l.blocked && !back.blocked) {
          v.add('W_LINK_ONEWAY', path, `${t.id}→${l.to} is blocked, only ${l.to}→${t.id} is passable`, {
            tiles: [t.id, l.to],
          });
        } else if (l.blocked && back.blocked && t.id < l.to) {
          v.add('W_LINK_ONEWAY', path, `edge ${t.id}–${l.to} is blocked both ways`, { tiles: [t.id, l.to] });
        }
        if (t.id < l.to && !sameCells(l.via ?? [], [...(back.via ?? [])].reverse())) {
          v.add('E_VIA_BROKEN', path, `via of ${t.id}–${l.to} is not mirrored on the reverse link`, {
            tiles: [t.id, l.to],
          });
        }
      }
      if (!back || t.id < l.to) checkEdgeGeometry(ctx, t, target, l, path);
    });
    checkSrcFlags(ctx, t, i);
  });
}

function checkEdgeGeometry(ctx: Ctx, a: TileDef, b: TileDef, l: TileLink, path: string): void {
  const via = l.via ?? [];
  const chain: Cell[] = [a.cell, ...via, b.cell];
  let broken = false;
  let diagonal = false;
  for (let k = 1; k < chain.length; k++) {
    const dx = Math.abs(chain[k]!.x - chain[k - 1]!.x);
    const dy = Math.abs(chain[k]!.y - chain[k - 1]!.y);
    if (dx + dy === 1) continue;
    if (dx === 1 && dy === 1) diagonal = true;
    else broken = true;
  }
  const offRoad = via.filter((c) => !ctx.roadSet.has(cellKey(c)));
  const tiles = [a.id, b.id];
  if (broken) {
    const msg = via.length === 0 ? 'non-adjacent link without via' : 'via chain is not contiguous';
    ctx.v.add('E_VIA_BROKEN', path, `${a.id}–${b.id}: ${msg}`, { tiles, cells: chain });
  } else if (offRoad.length > 0) {
    ctx.v.add('E_VIA_BROKEN', path, `${a.id}–${b.id}: via cells missing from roadCells`, { tiles, cells: offRoad });
  } else if (diagonal) {
    ctx.v.add('W_DIAGONAL_LINK', path, `${a.id}–${b.id} has a diagonal step`, { tiles, cells: chain });
  }
  if (via.length > VIA_LONG_THRESHOLD) {
    ctx.v.add('W_VIA_LONG', path, `${a.id}–${b.id} uses ${via.length} via cells`, { tiles });
  }
}

/** 有原始 flags 时核对：封路位（bit 30-slot）必须落在真实的边上且与 link.blocked 一致；低字节 = 落点码；bit31 = noItems */
function checkSrcFlags({ v }: Ctx, t: TileDef, i: number): void {
  if (!t.src) return;
  const flags = t.src.flags >>> 0;
  const path = `tiles[${i}].src.flags`;
  for (let slot = 0; slot < 4; slot++) {
    const bit = (flags >>> (30 - slot)) & 1;
    const link = t.links.find((l) => l.slot === slot);
    if (bit === 1 && !link) {
      v.add('E_BLOCKED_NOT_LINK', path, `tile ${t.id} blocks empty slot ${slot}`, { tiles: [t.id] });
    } else if (link && link.blocked !== (bit === 1)) {
      v.add('E_BLOCKED_NOT_LINK', path, `tile ${t.id} slot ${slot}: link.blocked disagrees with flags`, {
        tiles: [t.id],
      });
    }
  }
  if ((flags & 0xff) !== t.landingCode) {
    v.add('E_TILE_REF_MISMATCH', path, `tile ${t.id}: landingCode differs from flags low byte`, { tiles: [t.id] });
  }
  if ((flags >>> 31 === 1) !== t.noItems) {
    v.add('E_TILE_REF_MISMATCH', path, `tile ${t.id}: noItems differs from flags bit31`, { tiles: [t.id] });
  }
}

function checkGeometry({ def, v }: Ctx): void {
  const { w, h } = def.grid;
  const gridOk = isPositiveInt(w) && isPositiveInt(h);
  if (!gridOk) v.add('E_TERRAIN_SHAPE', 'grid', `invalid grid ${w}×${h}`);
  const inBounds = (c: Cell) =>
    Number.isInteger(c.x) && Number.isInteger(c.y) && c.x >= 0 && c.y >= 0 && c.x < w && c.y < h;
  const occ = new Map<string, string>();

  def.tiles.forEach((t, i) => {
    const path = `tiles[${i}].cell`;
    if (gridOk && !inBounds(t.cell))
      v.add('E_OUT_OF_BOUNDS', path, `tile ${t.id} is outside the grid`, { tiles: [t.id] });
    const k = cellKey(t.cell);
    const other = occ.get(k);
    if (other) v.add('E_CELL_COLLIDE', path, `tile ${t.id} collides with ${other}`, { tiles: [t.id], cells: [t.cell] });
    else occ.set(k, `tile ${t.id}`);
  });
  def.roadCells.forEach((c, i) => {
    const path = `roadCells[${i}]`;
    if (gridOk && !inBounds(c)) v.add('E_OUT_OF_BOUNDS', path, 'road cell is outside the grid', { cells: [c] });
    const k = cellKey(c);
    const other = occ.get(k);
    if (other) v.add('E_CELL_COLLIDE', path, `road cell collides with ${other}`, { cells: [c] });
    else occ.set(k, 'road cell');
  });

  const rects: { label: string; path: string; rect: Rect }[] = [
    ...def.lots.map((l, i) => ({ label: `lot ${l.id}`, path: `lots[${i}].rect`, rect: l.rect })),
    ...def.companies.map((c, i) => ({ label: `company ${c.id}`, path: `companies[${i}].rect`, rect: c.rect })),
    ...def.landmarks.map((m, i) => ({ label: `landmark ${m.id}`, path: `landmarks[${i}].rect`, rect: m.rect })),
  ];
  for (const { label, path, rect } of rects) {
    if (!rectValid(rect)) {
      v.add('E_RECT_INVALID', path, `${label} has an invalid rect`);
      continue;
    }
    if (gridOk && (rect.x < 0 || rect.y < 0 || rect.x + rect.w > w || rect.y + rect.h > h)) {
      v.add('E_OUT_OF_BOUNDS', path, `${label} is outside the grid`);
    }
    const hits: string[] = [];
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const k = cellKey({ x, y });
        const other = occ.get(k);
        if (other) {
          if (!hits.includes(other)) hits.push(other);
        } else {
          occ.set(k, label);
        }
      }
    }
    for (const other of hits) v.add('E_OVERLAP', path, `${label} overlaps ${other}`);
  }
  def.decorations.forEach((d, i) => {
    const path = `decorations[${i}].cell`;
    if (gridOk && !inBounds(d.cell))
      v.add('E_OUT_OF_BOUNDS', path, 'decoration is outside the grid', { cells: [d.cell] });
    const k = cellKey(d.cell);
    const other = occ.get(k);
    if (other) v.add('E_OVERLAP', path, `decoration overlaps ${other}`, { cells: [d.cell] });
    else occ.set(k, 'decoration');
  });
}

function checkTerrain({ def, v }: Ctx): void {
  const { w, h } = def.grid;
  if (def.terrain.length !== h)
    v.add('E_TERRAIN_SHAPE', 'terrain', `terrain has ${def.terrain.length} rows, want ${h}`);
  def.terrain.forEach((row, y) => {
    if (typeof row !== 'string' || row.length !== w || !TERRAIN_RE.test(row)) {
      v.add('E_TERRAIN_SHAPE', `terrain[${y}]`, `row ${y} must be ${w} chars of [gwspm]`);
    }
  });
}

const LOT_PREFIX: Record<AnyLot['kind'], string> = { land: 'L', facility: 'F', company: 'C' };

function checkLotRefs(ctx: Ctx): void {
  const { def, v, tileById, lotById } = ctx;
  for (const { lot, path } of lotsWithPath(def)) {
    if (!lot.id.startsWith(LOT_PREFIX[lot.kind])) {
      v.add('E_TILE_REF_MISMATCH', `${path}.id`, `lot ${lot.id} does not match kind ${lot.kind}`);
    }
    if (lot.frontTiles.length === 0) v.add('E_LOT_NO_FRONT', `${path}.frontTiles`, `lot ${lot.id} has no front tile`);
    const seen = new Set<TileId>();
    const rectOk = rectValid(lot.rect);
    // 企业只要有一个前沿格与建筑相邻，其余不相邻的银行格 / 百货格只报警告（architecture §16.2）
    const companyAnchored =
      lot.kind === 'company' &&
      rectOk &&
      lot.frontTiles.some((id) => {
        const t = tileById.get(id);
        return t !== undefined && isAdjacentToRect(t.cell, lot.rect);
      });
    lot.frontTiles.forEach((id, j) => {
      const fpath = `${path}.frontTiles[${j}]`;
      if (seen.has(id)) v.add('E_TILE_REF_MISMATCH', fpath, `lot ${lot.id} lists front tile ${id} twice`);
      seen.add(id);
      const tile = tileById.get(id);
      if (!tile) {
        v.add('E_TILE_REF_MISMATCH', fpath, `lot ${lot.id} front tile ${id} does not exist`, { tiles: [id] });
        return;
      }
      if (tile.ref?.lot !== lot.id) {
        v.add('E_TILE_REF_MISMATCH', fpath, `tile ${id} does not reference lot ${lot.id}`, { tiles: [id] });
      }
      if (rectOk && !isAdjacentToRect(tile.cell, lot.rect)) {
        const extra = { tiles: [id], cells: [tile.cell] };
        if (companyAnchored && COMPANY_REMOTE_FRONT_CODES.includes(tile.landingCode)) {
          v.add('W_COMPANY_REMOTE_FRONT', fpath, `company ${lot.id} front tile ${id} is far from its building`, extra);
        } else {
          v.add('E_LOT_FRONT_NOT_ADJ', fpath, `tile ${id} is not 4-adjacent to lot ${lot.id}`, extra);
        }
      }
    });
  }

  const landmarkIds = new Set(def.landmarks.map((m) => m.id));
  def.tiles.forEach((t, i) => {
    const path = `tiles[${i}]`;
    const lotRef = t.ref?.lot;
    if (lotRef !== undefined) {
      const lot = lotById.get(lotRef);
      if (!lot)
        v.add('E_TILE_REF_MISMATCH', `${path}.ref.lot`, `tile ${t.id} references missing ${lotRef}`, { tiles: [t.id] });
      else if (!lot.frontTiles.includes(t.id)) {
        v.add('E_TILE_REF_MISMATCH', `${path}.ref.lot`, `${lotRef} does not list tile ${t.id} as front`, {
          tiles: [t.id],
        });
      }
    }
    const lmRef = t.ref?.landmark;
    if (lmRef !== undefined && !landmarkIds.has(lmRef)) {
      v.add('E_TILE_REF_MISMATCH', `${path}.ref.landmark`, `tile ${t.id} references missing landmark ${lmRef}`, {
        tiles: [t.id],
      });
    }
    const want = kindForLandingCode(t.landingCode, lotRef !== undefined);
    if (want === null) {
      v.add('E_TILE_REF_MISMATCH', `${path}.landingCode`, `tile ${t.id}: landingCode ${t.landingCode} out of 0..16`, {
        tiles: [t.id],
      });
    } else if (t.kind !== want) {
      v.add('E_TILE_REF_MISMATCH', `${path}.kind`, `tile ${t.id}: kind ${t.kind} does not match code (${want})`, {
        tiles: [t.id],
      });
    }
  });

  const stockIdx = new Set(def.stocks.map((s) => s.index));
  def.companies.forEach((c, i) => {
    if (!stockIdx.has(c.stockIndex)) {
      v.add('E_TILE_REF_MISMATCH', `companies[${i}].stockIndex`, `${c.id} references missing stock ${c.stockIndex}`);
    }
  });
}

function text(def: MapDef, locale: MapLocale, key: string): string | undefined {
  const table = def.strings[locale];
  return table && Object.hasOwn(table, key) ? table[key] : undefined;
}

function checkStreets({ def, v }: Ctx): void {
  const streetById = new Map(def.streets.map((s) => [s.id, s]));
  const lands = def.lots.filter((l): l is LandLot => l.kind === 'land');
  const landById = new Map(lands.map((l) => [l.id, l]));
  def.lots.forEach((lot, i) => {
    if (lot.kind !== 'land') return;
    const path = `lots[${i}].streetId`;
    const street = streetById.get(lot.streetId);
    if (!street) v.add('E_STREET_NAME', path, `lot ${lot.id} is in unknown street ${lot.streetId}`);
    else if (!street.lots.includes(lot.id)) v.add('E_STREET_NAME', path, `street ${street.id} does not list ${lot.id}`);
    else if (text(def, 'zh-TW', lot.nameKey) !== text(def, 'zh-TW', street.nameKey)) {
      v.add('E_STREET_NAME', `lots[${i}].nameKey`, `lot ${lot.id} name differs from street ${street.id}`);
    }
  });
  const nameOwner = new Map<string, string>();
  def.streets.forEach((s, i) => {
    const path = `streets[${i}]`;
    if (s.lots.length === 0) v.add('E_STREET_NAME', `${path}.lots`, `street ${s.id} is empty`);
    const seen = new Set<string>();
    s.lots.forEach((id, j) => {
      if (seen.has(id)) v.add('E_STREET_NAME', `${path}.lots[${j}]`, `street ${s.id} lists ${id} twice`);
      seen.add(id);
      const lot = landById.get(id);
      if (!lot || lot.streetId !== s.id)
        v.add('E_STREET_NAME', `${path}.lots[${j}]`, `${id} is not a land lot of ${s.id}`);
    });
    const name = text(def, 'zh-TW', s.nameKey) ?? '';
    const owner = nameOwner.get(name);
    if (owner !== undefined) v.add('E_STREET_NAME', `${path}.nameKey`, `streets ${owner} and ${s.id} share a name`);
    else nameOwner.set(name, s.id);
  });
}

function checkSix(v: Issues, path: string, arr: unknown, label: string): arr is number[] {
  const ok =
    Array.isArray(arr) && arr.length === 6 && arr.every((x) => typeof x === 'number' && Number.isInteger(x) && x >= 0);
  if (!ok) v.add('E_RENT_SHAPE', path, `${label} must be 6 non-negative integers`);
  return ok;
}

function nonDecreasing(a: readonly number[]): boolean {
  return a.every((x, i) => i === 0 || x >= a[i - 1]!);
}

function checkPrices({ def, v }: Ctx): void {
  const price = (path: string, n: number, label: string) => {
    if (!isPrice(n)) v.add('E_PRICE_RANGE', path, `${label} out of range: ${n}`);
  };
  def.lots.forEach((lot, i) => {
    const p = `lots[${i}]`;
    price(`${p}.landPrice`, lot.landPrice, `${lot.id} landPrice`);
    price(`${p}.housePrice`, lot.housePrice, `${lot.id} housePrice`);
    if (lot.kind === 'land') {
      if (checkSix(v, `${p}.rent`, lot.rent, `${lot.id} rent`)) {
        for (const [k, r] of lot.rent.entries()) price(`${p}.rent[${k}]`, r, `${lot.id} rent`);
        if (!nonDecreasing(lot.rent)) v.add('W_RENT_NONMONO', `${p}.rent`, `${lot.id} rent is not non-decreasing`);
      }
    } else if (checkSix(v, `${p}.rateWindow`, lot.rateWindow, `${lot.id} rateWindow`)) {
      for (const [k, r] of lot.rateWindow.entries()) price(`${p}.rateWindow[${k}]`, r, `${lot.id} rateWindow`);
      if (lot.rateWindow[0] !== lot.housePrice) {
        v.add('E_RENT_SHAPE', `${p}.rateWindow[0]`, `${lot.id} rateWindow[0] must equal housePrice`);
      }
      if (!nonDecreasing(lot.rateWindow.slice(1))) {
        v.add('W_RENT_NONMONO', `${p}.rateWindow`, `${lot.id} rates are not non-decreasing`);
      }
    }
  });
  def.companies.forEach((c, i) => {
    price(`companies[${i}].tollBase`, c.tollBase, `${c.id} tollBase`);
    price(`companies[${i}].assetValue`, c.assetValue, `${c.id} assetValue`);
  });
  def.stocks.forEach((s, i) => {
    price(`stocks[${i}].initPriceCents`, s.initPriceCents, `stock ${s.index} price`);
    if (!Number.isInteger(s.float) || s.float < 0 || s.float > 10000) {
      v.add('E_PRICE_RANGE', `stocks[${i}].float`, `stock ${s.index} float must be 0..10000`);
    }
    if (!Number.isFinite(s.volatility) || s.volatility < 0) {
      v.add('E_PRICE_RANGE', `stocks[${i}].volatility`, `stock ${s.index} volatility must be ≥ 0`);
    }
  });
}

function checkGraph({ def, v, tileById }: Ctx): void {
  if (def.tiles.length === 0) return;
  const adj = new Map<TileId, TileId[]>();
  const link = (a: TileId, b: TileId) => {
    const list = adj.get(a);
    if (!list) adj.set(a, [b]);
    else if (!list.includes(b)) list.push(b);
  };
  for (const t of def.tiles) {
    for (const l of t.links) {
      if (l.to === t.id || !tileById.has(l.to)) continue;
      link(t.id, l.to);
      link(l.to, t.id);
    }
  }
  const start = def.tiles[0]!.id;
  const seen = new Set<TileId>([start]);
  const queue: TileId[] = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    for (const n of adj.get(queue[qi]!) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  const unreachable = def.tiles.filter((t) => !seen.has(t.id)).map((t) => t.id);
  if (unreachable.length > 0) {
    v.add('E_UNREACHABLE', 'tiles', `tiles not connected to tile ${start}: ${unreachable.join(',')}`, {
      tiles: unreachable,
    });
  }
  def.tiles.forEach((t, i) => {
    if ((adj.get(t.id)?.length ?? 0) === 1) {
      v.add('W_DEADEND', `tiles[${i}]`, `tile ${t.id} is a dead end (pieces turn back)`, { tiles: [t.id] });
    }
  });
}

function checkHolds({ def, v, tileById }: Ctx): void {
  for (const kind of ['jail', 'hospital'] as const) {
    const code = kind === 'jail' ? LANDING_JAIL : LANDING_HOSPITAL;
    if (!def.tiles.some((t) => t.landingCode === code)) {
      v.add('E_HOLD_MISSING', 'tiles', `no ${kind} landing tile (code ${code})`);
    }
    const holders = def.landmarks.filter((m) => m.kind === kind && m.holdTile !== undefined);
    if (holders.length !== 1) {
      v.add(
        'E_HOLD_MISSING',
        'landmarks',
        `expected exactly one ${kind} landmark with holdTile, got ${holders.length}`,
      );
    }
    for (const m of holders) {
      const path = `landmarks[${def.landmarks.indexOf(m)}].holdTile`;
      const tile = tileById.get(m.holdTile!);
      if (!tile) {
        v.add('E_HOLD_MISSING', path, `landmark ${m.id} holdTile ${m.holdTile} does not exist`);
        continue;
      }
      if (tile.holdFor !== kind) {
        v.add('E_HOLD_MISSING', path, `tile ${tile.id} is not marked holdFor ${kind}`, { tiles: [tile.id] });
      }
      if (tile.ref?.landmark !== m.id) {
        v.add('E_TILE_REF_MISMATCH', path, `hold tile ${tile.id} does not reference landmark ${m.id}`, {
          tiles: [tile.id],
        });
      }
      if (rectValid(m.rect) && !isAdjacentToRect(tile.cell, m.rect)) {
        v.add('E_LOT_FRONT_NOT_ADJ', path, `hold tile ${tile.id} is not adjacent to landmark ${m.id}`, {
          tiles: [tile.id],
        });
      }
    }
  }
  def.tiles.forEach((t, i) => {
    if (t.holdFor === undefined) return;
    const owner = def.landmarks.some((m) => m.kind === t.holdFor && m.holdTile === t.id);
    if (!owner) {
      v.add('E_TILE_REF_MISMATCH', `tiles[${i}].holdFor`, `tile ${t.id} holdFor ${t.holdFor} has no landmark`, {
        tiles: [t.id],
      });
    }
  });
  def.landmarks.forEach((m, i) => {
    if (m.kind === 'scenery' && m.holdTile !== undefined) {
      v.add('E_TILE_REF_MISMATCH', `landmarks[${i}].holdTile`, `scenery landmark ${m.id} cannot hold players`);
    }
  });
}

export function countMap(def: MapDef): MapCounts {
  return {
    nodes: def.tiles.length,
    lands: def.lots.filter((l) => l.kind === 'land').length,
    facilities: def.lots.filter((l) => l.kind === 'facility').length,
    companies: def.companies.length,
    landscapes: def.landmarks.length,
  };
}

function checkCounts({ def, v }: Ctx, expect: Partial<MapCounts> | undefined): void {
  const actual = countMap(def);
  for (const k of COUNT_KEYS) {
    if (def.meta.counts[k] !== actual[k]) {
      v.add('E_COUNT_MISMATCH', `meta.counts.${k}`, `meta says ${def.meta.counts[k]} ${k}, map has ${actual[k]}`);
    }
    const want = expect?.[k];
    if (want !== undefined && want !== actual[k]) {
      v.add('E_COUNT_MISMATCH', `expect.${k}`, `expected ${want} ${k}, map has ${actual[k]}`);
    }
  }
}

function checkNames({ def, v }: Ctx): void {
  const keys: { path: string; key: string }[] = [
    { path: 'nameKey', key: def.nameKey },
    ...def.streets.map((s, i) => ({ path: `streets[${i}].nameKey`, key: s.nameKey })),
    ...def.lots.map((l, i) => ({ path: `lots[${i}].nameKey`, key: l.nameKey })),
    ...def.companies.map((c, i) => ({ path: `companies[${i}].nameKey`, key: c.nameKey })),
    ...def.landmarks.map((m, i) => ({ path: `landmarks[${i}].nameKey`, key: m.nameKey })),
    ...def.stocks.map((s, i) => ({ path: `stocks[${i}].nameKey`, key: s.nameKey })),
  ];
  def.tiles.forEach((t, i) => {
    if (t.nameKey !== undefined) keys.push({ path: `tiles[${i}].nameKey`, key: t.nameKey });
  });
  for (const { path, key } of keys) {
    const missing = LOCALES.filter((loc) => (text(def, loc, key) ?? '').trim() === '');
    if (missing.length > 0) v.add('W_NAME_EMPTY', path, `${key} is empty in ${missing.join(',')}`);
  }
}
