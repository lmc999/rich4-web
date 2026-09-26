import {
  type CompanyDef,
  countMap,
  DataError,
  type FacilityLot,
  type HolidayDef,
  type LandLot,
  type LandmarkDef,
  type MapDef,
  type MapIssue,
  parseMapDef,
  type StockDef,
  type StreetDef,
  type TileDef,
  type TileLink,
  type ValidateMapResult,
  validateMap,
  withDataHash,
} from '@rich4/shared/data';
import { ExitCode, type ExitCodeValue, ExtractError } from '../context';
import { type GeometryResult, geometryErrors, normalizeGeometry } from './geometry/normalize';
import { viaFrom } from './geometry/routeEdges';
import type { Rect } from './geometry/types';
import { MAP_NAMES, StringTable } from './i18n';
import { checkOverrideRefs, type MapOverrides } from './overrides';
import type { MapDataRaw } from './rawTypes';
import { buildSemantic, type MapSemantic } from './semantic';

/**
 * 组装 MapDef（architecture §5.1）：语义层 + 几何层 → MapDef，计算 dataHash（shared 的实现），
 * 先过 zod 结构校验，再跑 shared 的 validateMap，并对 issue 分类。
 */

export const GENERATOR = 'rich4-extract/map-build@1';

export interface BuildOptions {
  mapKey: string;
  strict4?: boolean;
  /** 本图 12 支股票（D2 起由 exe 股票模板表提供，见 exe/mapData.ts；nameKey 由这里按 map.<id>.stock.<index> 生成） */
  stocks?: readonly { stock: Omit<StockDef, 'nameKey'>; name: string }[];
  holidays?: HolidayDef[];
}

/**
 * issue 分类：
 * - error：必须处理；
 * - pending：等待 exe 表数据引起（没有 exe 表时 stocks 为空 → 企业的 stockIndex 悬空）；
 * - warn：validateMap 的警告（含 architecture §16.2 的 W_COMPANY_REMOTE_FRONT：企业远端的银行/百货格）。
 */
export type IssueClass = 'error' | 'pending' | 'warn';

export interface ClassifiedIssue extends MapIssue {
  class: IssueClass;
}

export interface BuildResult {
  def: MapDef;
  semantic: MapSemantic;
  geometry: GeometryResult;
  validation: ValidateMapResult;
  classified: ClassifiedIssue[];
  exitCode: ExitCodeValue;
}

const PLACEHOLDER: Rect = { x: 0, y: 0, w: 1, h: 1 };

function textOf(name: { text: string | null }): string {
  return name.text ?? '';
}

export function classifyIssues(
  def: MapDef,
  issues: readonly MapIssue[],
  pending: readonly string[],
): ClassifiedIssue[] {
  return issues.map((i): ClassifiedIssue => {
    const pendingStock =
      i.code === 'E_TILE_REF_MISMATCH' &&
      /^companies\[\d+\]\.stockIndex$/.test(i.path) &&
      def.stocks.length === 0 &&
      pending.includes('stocks');
    return { ...i, class: pendingStock ? 'pending' : i.severity === 'error' ? 'error' : 'warn' };
  });
}

export function buildMapDef(raw: MapDataRaw, ov: MapOverrides, opts: BuildOptions): BuildResult {
  const key = opts.mapKey;
  const semantic = buildSemantic(raw, { mapKey: key });
  checkOverrideRefs(ov, semantic);
  for (const m of semantic.landmarks) {
    const k = ov.landmark[m.id]?.kind;
    if (k !== undefined && m.holdTile === undefined) m.kind = k;
  }
  if (opts.stocks) {
    semantic.stocks = opts.stocks.map((s) => ({ ...s.stock, nameKey: `map.${key}.stock.${s.stock.index}` }));
    semantic.pending = semantic.pending.filter((p) => p !== 'stocks');
  }
  if (opts.holidays) {
    semantic.holidays = opts.holidays;
    semantic.pending = semantic.pending.filter((p) => p !== 'holidays');
  }

  const geo = normalizeGeometry(semantic, ov);
  const nk = (kind: string, id: string | number) => `map.${key}.${kind}.${id}`;
  const strings = new StringTable();
  strings.put(`map.${key}.name`, MAP_NAMES[key] ?? key);

  const tiles: TileDef[] = [...semantic.tiles]
    .sort((a, b) => a.id - b.id)
    .map((t) => {
      const links: TileLink[] = t.links.map((l) => {
        const via = viaFrom(geo.vias, t.id, l.to);
        const link: TileLink = { to: l.to, slot: l.slot, blocked: l.blocked };
        if (via.length > 0) link.via = via;
        return link;
      });
      const def: TileDef = {
        id: t.id,
        cell: geo.tileCells.get(t.id)!,
        world: { ...t.world },
        kind: t.kind,
        landingCode: t.landingCode,
        links,
        noItems: t.noItems,
        src: { flags: t.flags },
      };
      if (t.ref) def.ref = { ...t.ref };
      if (t.holdFor) def.holdFor = t.holdFor;
      const name = textOf(t.name);
      if (name !== '') {
        def.nameKey = nk('tile', t.id);
        strings.put(def.nameKey, name);
      }
      return def;
    });

  const rectOf = (id: string) => geo.lotRects.get(id) ?? PLACEHOLDER;
  const lands: LandLot[] = semantic.lands.map((l) => {
    const nameKey = nk('lot', l.id);
    strings.put(nameKey, textOf(l.name));
    return {
      id: l.id,
      world: { ...l.world },
      rect: { ...rectOf(l.id) },
      frontTiles: [...l.frontTiles],
      facing: l.facing,
      nameKey,
      kind: 'land',
      streetId: l.streetId,
      landPrice: l.landPrice,
      housePrice: l.housePrice,
      rent: [...l.rent],
    };
  });
  const facilities: FacilityLot[] = semantic.facilities.map((f) => {
    const nameKey = nk('lot', f.id);
    strings.put(nameKey, textOf(f.name));
    return {
      id: f.id,
      world: { ...f.world },
      rect: { ...rectOf(f.id) },
      frontTiles: [...f.frontTiles],
      facing: f.facing,
      nameKey,
      kind: 'facility',
      landPrice: f.landPrice,
      housePrice: f.housePrice,
      rateWindow: [...f.rateWindow],
    };
  });
  const companies: CompanyDef[] = semantic.companies.map((c) => {
    const nameKey = nk('company', c.id);
    strings.put(nameKey, textOf(c.name));
    return {
      id: c.id,
      world: { ...c.world },
      rect: { ...rectOf(c.id) },
      frontTiles: [...c.frontTiles],
      facing: c.facing,
      nameKey,
      kind: 'company',
      industry: c.industry,
      industryKey: c.industryKey,
      stockIndex: c.stockIndex,
      tollBase: c.tollBase,
      assetValue: c.assetValue,
    };
  });
  const landmarks: LandmarkDef[] = semantic.landmarks
    .filter((m) => !geo.report.hiddenLandmarks.includes(m.id))
    .map((m) => {
      const nameKey = nk('landmark', m.id);
      strings.put(nameKey, textOf(m.name));
      const lm: LandmarkDef = {
        id: m.id,
        kind: m.kind,
        rect: { ...(geo.landmarkRects.get(m.id) ?? PLACEHOLDER) },
        nameKey,
      };
      if (m.holdTile !== undefined) lm.holdTile = m.holdTile;
      return lm;
    });
  for (const s of opts.stocks ?? []) strings.put(`map.${key}.stock.${s.stock.index}`, s.name);
  const streets: StreetDef[] = semantic.streets.map((s) => {
    const nameKey = nk('street', s.id);
    strings.put(nameKey, textOf(s.name));
    return { id: s.id, nameKey, lots: [...s.lots] };
  });

  const body: MapDef = {
    schemaVersion: 1,
    id: key,
    globalMapId: semantic.globalMapId,
    nameKey: `map.${key}.name`,
    grid: { ...geo.grid },
    terrain: [...geo.terrain],
    tiles,
    roadCells: geo.roadCells,
    lots: [...lands, ...facilities],
    companies,
    landmarks,
    streets,
    stocks: semantic.stocks,
    holidays: semantic.holidays,
    decorations: [],
    strings: strings.toStrings(),
    meta: {
      source: { ...semantic.source },
      counts: { nodes: 0, lands: 0, facilities: 0, companies: 0, landscapes: 0 },
      dataHash: '0'.repeat(64),
      generator: GENERATOR,
    },
  };
  body.meta.counts = countMap(body);
  const def = withDataHash(body);
  try {
    parseMapDef(def);
  } catch (e) {
    if (e instanceof DataError) throw new ExtractError('E_MAPDEF_SCHEMA', `生成的 MapDef 未通过 zod：${e.message}`);
    throw e;
  }

  const validation = validateMap(def, { strict4: opts.strict4 === true, ...(ov.expect ? { expect: ov.expect } : {}) });
  const classified = classifyIssues(def, validation.issues, semantic.pending);
  let exitCode: ExitCodeValue = ExitCode.OK;
  if (geometryErrors(geo).length > 0) exitCode = ExitCode.OVERRIDE;
  else if (semantic.issues.some((i) => i.severity === 'error') || classified.some((i) => i.class === 'error')) {
    exitCode = ExitCode.STRUCTURE;
  }
  return { def, semantic, geometry: geo, validation, classified, exitCode };
}
