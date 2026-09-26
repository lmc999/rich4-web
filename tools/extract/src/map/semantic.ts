import {
  type HolidayDef,
  type IndustryKey,
  industryKeyOf,
  kindForLandingCode,
  type LotId,
  type MapCounts,
  type Slot,
  type StockDef,
  type TileKind,
  type World,
} from '@rich4/shared/data';
import { blockedBit, FLAG_NO_ITEMS, landingCode, resolveNodeType } from './parseRaw';
import type { MapDataRaw, RawName, RawSourceId, Six } from './rawTypes';

/**
 * 语义层 MapSemantic（data-pipeline.md §7）：只处理规则语义（kind、槽序、封路、街道、关押格、企业前沿格），
 * 不含网格几何。编号沿用原版 1 基编号。
 */

export interface SemLink {
  to: number;
  slot: Slot;
  /** 从本格经此槽出发被禁止（flags bit(30−slot)） */
  blocked: boolean;
}

export interface SemTile {
  id: number;
  world: World;
  landingCode: number;
  kind: TileKind;
  ref?: { lot?: LotId; landmark?: string };
  links: SemLink[];
  noItems: boolean;
  holdFor?: 'hospital' | 'jail';
  name: RawName;
  type: number;
  flags: number;
}

interface SemLotBase {
  index: number;
  world: World;
  name: RawName;
  facing: number;
  frontTiles: number[];
}

export interface SemLand extends SemLotBase {
  id: `L${number}`;
  streetId: string;
  landPrice: number;
  housePrice: number;
  rent: Six;
}

export interface SemFacility extends SemLotBase {
  id: `F${number}`;
  landPrice: number;
  housePrice: number;
  rateWindow: Six;
}

export interface SemCompany extends SemLotBase {
  id: `C${number}`;
  industry: number;
  industryKey: IndustryKey;
  stockIndex: number;
  tollBase: number;
  assetValue: number;
}

export interface SemLandmark {
  /** 景观号（1 基）的字符串 */
  id: string;
  index: number;
  world: World;
  name: RawName;
  facing: number;
  kind: 'hospital' | 'jail' | 'scenery';
  holdTile?: number;
  /** type 为 8000+k 的节点 */
  refTiles: number[];
}

export interface SemStreet {
  id: string;
  /** 分组依据：原始名称字节 */
  nameHex: string;
  name: RawName;
  lots: `L${number}`[];
}

export interface SemIssue {
  code: string;
  severity: 'error' | 'warn' | 'info';
  msg: string;
  tiles?: number[];
}

export interface MapSemantic {
  schema: 'rich4.map-semantic/1';
  mapKey: string;
  globalMapId: number;
  source: { id: RawSourceId; fileSha256: string; resourceSha256: string };
  counts: MapCounts;
  tiles: SemTile[];
  lands: SemLand[];
  facilities: SemFacility[];
  companies: SemCompany[];
  landmarks: SemLandmark[];
  streets: SemStreet[];
  /** 本期不抽 exe 表（D2），为空 */
  stocks: StockDef[];
  holidays: HolidayDef[];
  /** 尚未填充、等待后续里程碑的数据块 */
  pending: string[];
  issues: SemIssue[];
}

/** 关押格 type：8001 → 医院，8002 → 监狱（引用景观 1、2）。 */
export const HOLD_TYPES: Readonly<Record<number, 'hospital' | 'jail'>> = { 8001: 'hospital', 8002: 'jail' };

/**
 * 落点码 → 期望节点名（zh-TW，用于复核落点码表；比较前做 NFKC 与 臺→台 归一）。
 * @source docs/research/g_map.md §3.1；oama 以节点名交叉验证
 */
export const LANDING_CODE_NAMES: Readonly<Record<number, readonly string[]>> = {
  1: ['公園'],
  2: ['新聞'],
  3: ['命運'],
  4: ['監獄'],
  5: ['醫院'],
  6: ['企鵝挖寶'],
  7: ['七彩氣球'],
  8: ['喜從天降'],
  9: ['樂透'],
  10: ['得50點'],
  11: ['得30點'],
  12: ['得10點'],
  13: ['卡片'],
  14: ['銀行'],
  15: ['百貨公司'],
  16: ['魔法屋'],
};

export function normalizeNodeName(s: string): string {
  return s.normalize('NFKC').replaceAll('臺', '台');
}

function codeForName(text: string): number | null {
  const n = normalizeNodeName(text);
  for (const [code, names] of Object.entries(LANDING_CODE_NAMES)) {
    if (names.some((x) => normalizeNodeName(x) === n)) return Number(code);
  }
  return null;
}

export interface SemanticOptions {
  mapKey: string;
}

export function buildSemantic(raw: MapDataRaw, opts: SemanticOptions): MapSemantic {
  const issues: SemIssue[] = [];
  const issue = (code: string, severity: SemIssue['severity'], msg: string, tiles?: number[]) => {
    const it: SemIssue = { code, severity, msg };
    if (tiles && tiles.length > 0) it.tiles = tiles;
    issues.push(it);
  };

  const nodeIds = new Set(raw.nodes.map((n) => n.id));
  const fronts = {
    lands: new Map<number, number[]>(),
    facilities: new Map<number, number[]>(),
    companies: new Map<number, number[]>(),
    landscapes: new Map<number, number[]>(),
  };

  const tiles: SemTile[] = raw.nodes.map((n) => {
    const code = landingCode(n.flags);
    const t = resolveNodeType(n.type);
    let ref: SemTile['ref'];
    if (t.kind === 'invalid') issue('S_TYPE_INVALID', 'error', `节点 ${n.id} 的 type ${n.type} 不在任何区间内`, [n.id]);
    if (t.kind === 'ref') {
      const list = fronts[t.table].get(t.index) ?? [];
      list.push(n.id);
      fronts[t.table].set(t.index, list);
      if (t.table === 'lands') ref = { lot: `L${t.index}` };
      else if (t.table === 'facilities') ref = { lot: `F${t.index}` };
      else if (t.table === 'companies') ref = { lot: `C${t.index}` };
      else ref = { landmark: String(t.index) };
    }
    const hasLot = ref?.lot !== undefined;
    let kind = kindForLandingCode(code, hasLot);
    if (kind === null) {
      issue('S_LANDING_CODE', 'error', `节点 ${n.id} 的落点码 ${code} 超出 0..16`, [n.id]);
      kind = 'plain';
    }
    const links: SemLink[] = [];
    n.adj.forEach((to, slot) => {
      if (to === 0) return;
      if (!nodeIds.has(to) || to === n.id) {
        issue('S_LINK_TARGET', 'error', `节点 ${n.id} 槽 ${slot} 指向不存在的节点 ${to}`, [n.id]);
        return;
      }
      links.push({ to, slot: slot as Slot, blocked: (n.flags & blockedBit(slot)) !== 0 });
    });
    const tile: SemTile = {
      id: n.id,
      world: { x: n.x, y: n.y },
      landingCode: code,
      kind,
      links,
      noItems: (n.flags & FLAG_NO_ITEMS) !== 0,
      name: n.name,
      type: n.type,
      flags: n.flags >>> 0,
    };
    if (ref) tile.ref = ref;
    const hold = HOLD_TYPES[n.type];
    if (hold) tile.holdFor = hold;
    return tile;
  });

  // 名称复核落点码
  for (const t of tiles) {
    const text = t.name.text ?? '';
    if (t.landingCode !== 0) {
      const want = LANDING_CODE_NAMES[t.landingCode] ?? [];
      if (text === '' || !want.some((w) => normalizeNodeName(w) === normalizeNodeName(text))) {
        issue(
          'S_NAME_CODE',
          'warn',
          `节点 ${t.id} 落点码 ${t.landingCode}，名称「${text}」与期望「${want.join('/')}」不符`,
          [t.id],
        );
      }
    } else if (text !== '') {
      const c = codeForName(text);
      if (c !== null) {
        issue('S_NAME_SUGGESTS_CODE', 'warn', `节点 ${t.id} 名称「${text}」像落点码 ${c}，但实际落点码为 0`, [t.id]);
      }
    }
  }

  // 邻接对称性
  const byId = new Map(tiles.map((t) => [t.id, t]));
  for (const t of tiles) {
    for (const l of t.links) {
      if (!byId.get(l.to)?.links.some((b) => b.to === t.id)) {
        issue('S_LINK_ASYM', 'warn', `邻接 ${t.id}→${l.to} 没有反向槽`, [t.id, l.to]);
      }
    }
  }

  const needFront = (kind: string, id: string, list: number[] | undefined): number[] => {
    if (!list || list.length === 0) issue('S_LOT_NO_FRONT', 'error', `${kind} ${id} 没有任何节点引用（无前沿格）`);
    return list ?? [];
  };

  // 街道：按原始名称字节分组，按首次出现编号
  const streets: SemStreet[] = [];
  const streetByHex = new Map<string, SemStreet>();
  const width = String(raw.lands.length).length > 2 ? String(raw.lands.length).length : 2;
  const lands: SemLand[] = raw.lands.map((l) => {
    let s = streetByHex.get(l.name.hex);
    if (!s) {
      s = { id: `S${String(streets.length + 1).padStart(width, '0')}`, nameHex: l.name.hex, name: l.name, lots: [] };
      streets.push(s);
      streetByHex.set(l.name.hex, s);
    }
    const id = `L${l.id}` as const;
    s.lots.push(id);
    return {
      id,
      index: l.id,
      world: { x: l.x, y: l.y },
      name: l.name,
      facing: l.facing,
      frontTiles: needFront('住宅地', id, fronts.lands.get(l.id)),
      streetId: s.id,
      landPrice: l.landPrice,
      housePrice: l.housePrice,
      rent: [...l.rent] as Six,
    };
  });

  const facilities: SemFacility[] = raw.facilities.map((f) => {
    const id = `F${f.id}` as const;
    return {
      id,
      index: f.id,
      world: { x: f.x, y: f.y },
      name: f.name,
      facing: f.facing,
      frontTiles: needFront('设施', id, fronts.facilities.get(f.id)),
      landPrice: f.landPrice,
      housePrice: f.rateWindow[0],
      rateWindow: [...f.rateWindow] as Six,
    };
  });

  const companies: SemCompany[] = raw.companies.map((c) => {
    const id = `C${c.id}` as const;
    return {
      id,
      index: c.id,
      world: { x: c.x, y: c.y },
      name: c.name,
      facing: c.facing,
      frontTiles: needFront('企业', id, fronts.companies.get(c.id)),
      industry: c.industry,
      industryKey: industryKeyOf(c.industry),
      stockIndex: c.stockIndex,
      tollBase: c.tollBase,
      assetValue: c.assetValue,
    };
  });

  const holdOf = new Map<number, { kind: 'hospital' | 'jail'; tile: number }[]>();
  for (const t of tiles) {
    if (t.holdFor && t.ref?.landmark !== undefined) {
      const k = Number(t.ref.landmark);
      holdOf.set(k, [...(holdOf.get(k) ?? []), { kind: t.holdFor, tile: t.id }]);
    }
  }
  const landmarks: SemLandmark[] = raw.landscapes.map((s) => {
    const holds = holdOf.get(s.id) ?? [];
    if (holds.length > 1) {
      issue(
        'S_HOLD_MULTI',
        'error',
        `景观 ${s.id} 被多个关押格引用：${holds.map((h) => h.tile).join(',')}`,
        holds.map((h) => h.tile),
      );
    }
    const lm: SemLandmark = {
      id: String(s.id),
      index: s.id,
      world: { x: s.x, y: s.y },
      name: s.name,
      facing: s.facing,
      kind: holds[0]?.kind ?? 'scenery',
      refTiles: fronts.landscapes.get(s.id) ?? [],
    };
    if (holds[0]) lm.holdTile = holds[0].tile;
    return lm;
  });
  for (const kind of ['hospital', 'jail'] as const) {
    const n = landmarks.filter((m) => m.kind === kind).length;
    if (n !== 1) issue('S_HOLD_COUNT', 'error', `${kind} 关押格应恰好 1 个，实际 ${n}`);
  }

  return {
    schema: 'rich4.map-semantic/1',
    mapKey: opts.mapKey,
    globalMapId: raw.globalMapId,
    source: { id: raw.source.id, fileSha256: raw.source.fileSha256, resourceSha256: raw.source.resourceSha256 },
    counts: {
      nodes: raw.header.nodes.count,
      lands: raw.header.lands.count,
      facilities: raw.header.facilities.count,
      companies: raw.header.companies.count,
      landscapes: raw.header.landscapes.count,
    },
    tiles,
    lands,
    facilities,
    companies,
    landmarks,
    streets,
    stocks: [],
    holidays: [],
    pending: ['stocks', 'holidays'],
    issues,
  };
}

/** 无向边（a<b），按 (a,b) 升序；含单向邻接（另由 S_LINK_ASYM 报告）。 */
export function semanticEdges(sem: MapSemantic): [number, number][] {
  const set = new Set<string>();
  const out: [number, number][] = [];
  for (const t of sem.tiles) {
    for (const l of t.links) {
      const a = Math.min(t.id, l.to);
      const b = Math.max(t.id, l.to);
      const k = `${a}-${b}`;
      if (set.has(k)) continue;
      set.add(k);
      out.push([a, b]);
    }
  }
  return out.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}
