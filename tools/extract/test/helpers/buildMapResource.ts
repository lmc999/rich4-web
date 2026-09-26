/** 测试专用：按 data-pipeline.md §5.2/§5.3 布局合成地图结构资源（数值均为虚构，与原版无关）。 */
import { encodeBig5 } from '../../src/bin/big5';
import { MAP_HEADER_SIZE, STRIDES, TABLE_ORDER } from '../../src/map/layout';
import { blockedBit } from '../../src/map/parseRaw';
import type { TableName } from '../../src/map/rawTypes';

type Name = string | Uint8Array;

export interface NodeSpec {
  x?: number;
  y?: number;
  name?: Name;
  adj?: number[];
  type?: number;
  decor?: number;
  flags?: number;
}

export interface LandSpec {
  x?: number;
  y?: number;
  name?: Name;
  b17?: number;
  b18?: number;
  b19?: number;
  b1a?: number;
  facing?: number;
  landPrice?: number;
  housePrice?: number;
  rent?: number[];
  u2c?: number;
  u30?: number;
}

export interface FacilitySpec {
  x?: number;
  y?: number;
  name?: Name;
  b18?: number;
  b19?: number;
  b1a?: number;
  facing?: number;
  b1c?: number;
  b1d?: number;
  b1e?: number;
  b1f?: number;
  u20?: number;
  landPrice?: number;
  rateWindow?: number[];
  u30?: number;
  u34?: number;
}

export interface CompanySpec {
  x?: number;
  y?: number;
  name?: Name;
  owner?: number;
  stockIndex?: number;
  industry?: number;
  facing?: number;
  ranking?: number[];
  spriteRes?: number;
  tollBase?: number;
  assetValue?: number;
  funds?: number;
  profit?: number;
  shares?: number;
}

export interface LandscapeSpec {
  x?: number;
  y?: number;
  name?: Name;
  facing?: number;
  b19?: number;
  spriteRes?: number;
}

export interface MapSpec {
  nodes?: NodeSpec[];
  lands?: LandSpec[];
  facilities?: FacilitySpec[];
  companies?: CompanySpec[];
  landscapes?: LandscapeSpec[];
}

function nameBytes(n: Name | undefined): Uint8Array {
  if (n === undefined) return new Uint8Array(0);
  if (n instanceof Uint8Array) return n;
  const b = encodeBig5(n);
  if (!b) throw new Error(`测试名称无法 Big5 编码：${n}`);
  return b;
}

export function tableOffsets(spec: MapSpec): Record<TableName, { count: number; offset: number }> {
  const out = {} as Record<TableName, { count: number; offset: number }>;
  let off = MAP_HEADER_SIZE;
  for (const t of TABLE_ORDER) {
    const count = spec[t]?.length ?? 0;
    out[t] = { count, offset: off };
    off += (count + 1) * STRIDES[t];
  }
  return out;
}

export function buildMapResource(spec: MapSpec): Uint8Array {
  const tabs = tableOffsets(spec);
  const last = tabs.landscapes;
  const out = new Uint8Array(last.offset + (last.count + 1) * STRIDES.landscapes);
  const dv = new DataView(out.buffer);
  TABLE_ORDER.forEach((t, i) => {
    dv.setUint32(i * 8, tabs[t].count, true);
    dv.setUint32(i * 8 + 4, tabs[t].offset, true);
  });
  const rec = (t: TableName, id: number) => tabs[t].offset + id * STRIDES[t];
  const putName = (o: number, n: Name | undefined, max: number) => {
    const b = nameBytes(n);
    out.set(b.subarray(0, max), o);
  };
  const u16s = (o: number, vs: readonly number[] | undefined, n: number) => {
    for (let k = 0; k < n; k++) dv.setUint16(o + k * 2, vs?.[k] ?? 0, true);
  };

  spec.nodes?.forEach((s, i) => {
    const o = rec('nodes', i + 1);
    dv.setInt16(o, s.x ?? 0, true);
    dv.setInt16(o + 2, s.y ?? 0, true);
    putName(o + 0x04, s.name, 20);
    u16s(o + 0x18, s.adj, 4);
    dv.setUint16(o + 0x20, s.type ?? 0, true);
    dv.setUint16(o + 0x22, s.decor ?? 0, true);
    dv.setUint32(o + 0x24, s.flags ?? 0, true);
  });
  spec.lands?.forEach((s, i) => {
    const o = rec('lands', i + 1);
    dv.setInt16(o, s.x ?? 0, true);
    dv.setInt16(o + 2, s.y ?? 0, true);
    putName(o + 0x04, s.name, 19);
    out[o + 0x17] = s.b17 ?? 0;
    out[o + 0x18] = s.b18 ?? 0;
    out[o + 0x19] = s.b19 ?? 0;
    out[o + 0x1a] = s.b1a ?? 0;
    out[o + 0x1b] = s.facing ?? 0;
    dv.setUint16(o + 0x1c, s.landPrice ?? 0, true);
    dv.setUint16(o + 0x1e, s.housePrice ?? 0, true);
    u16s(o + 0x20, s.rent, 6);
    dv.setUint32(o + 0x2c, s.u2c ?? 0, true);
    dv.setUint32(o + 0x30, s.u30 ?? 0, true);
  });
  spec.facilities?.forEach((s, i) => {
    const o = rec('facilities', i + 1);
    dv.setInt16(o, s.x ?? 0, true);
    dv.setInt16(o + 2, s.y ?? 0, true);
    putName(o + 0x04, s.name, 20);
    out[o + 0x18] = s.b18 ?? 0;
    out[o + 0x19] = s.b19 ?? 0;
    out[o + 0x1a] = s.b1a ?? 0;
    out[o + 0x1b] = s.facing ?? 0;
    out[o + 0x1c] = s.b1c ?? 0;
    out[o + 0x1d] = s.b1d ?? 0;
    out[o + 0x1e] = s.b1e ?? 0;
    out[o + 0x1f] = s.b1f ?? 0;
    dv.setUint16(o + 0x20, s.u20 ?? 0, true);
    dv.setUint16(o + 0x22, s.landPrice ?? 0, true);
    u16s(o + 0x24, s.rateWindow, 6);
    dv.setUint32(o + 0x30, s.u30 ?? 0, true);
    dv.setUint32(o + 0x34, s.u34 ?? 0, true);
  });
  spec.companies?.forEach((s, i) => {
    const o = rec('companies', i + 1);
    dv.setInt16(o, s.x ?? 0, true);
    dv.setInt16(o + 2, s.y ?? 0, true);
    putName(o + 0x04, s.name, 20);
    out[o + 0x18] = s.owner ?? 0;
    out[o + 0x19] = s.stockIndex ?? 0;
    out[o + 0x1a] = s.industry ?? 0;
    out[o + 0x1b] = s.facing ?? 0;
    for (let k = 0; k < 4; k++) out[o + 0x1c + k] = s.ranking?.[k] ?? 0;
    dv.setUint16(o + 0x20, s.spriteRes ?? 0, true);
    dv.setUint16(o + 0x22, s.tollBase ?? 0, true);
    dv.setUint32(o + 0x24, s.assetValue ?? 0, true);
    dv.setInt32(o + 0x28, s.funds ?? 0, true);
    dv.setInt32(o + 0x2c, s.profit ?? 0, true);
    dv.setUint32(o + 0x30, s.shares ?? 0, true);
  });
  spec.landscapes?.forEach((s, i) => {
    const o = rec('landscapes', i + 1);
    dv.setInt16(o, s.x ?? 0, true);
    dv.setInt16(o + 2, s.y ?? 0, true);
    putName(o + 0x04, s.name, 20);
    out[o + 0x18] = s.facing ?? 0;
    out[o + 0x19] = s.b19 ?? 0;
    dv.setUint16(o + 0x1a, s.spriteRes ?? 0, true);
  });
  return out;
}

/**
 * 小型自洽样例：8 个节点（6 格环路 + 3 号岔路经 7 通往关押格 8），2 块住宅、1 设施、1 企业、1 景观。
 * 3 号的槽 2（→7）带静态封路位。
 */
export function smallMapSpec(): MapSpec {
  return {
    nodes: [
      { x: 100, y: 100, name: '甲街', adj: [2, 6], type: 2001 },
      { x: 148, y: 100, name: '甲街', adj: [3, 1], type: 2002 },
      { x: 196, y: 100, name: '卡片', adj: [4, 2, 7, 0], type: 0, decor: 13, flags: 13 | blockedBit(2) },
      { x: 196, y: 148, name: '乙站', adj: [5, 3], type: 4001 },
      { x: 148, y: 148, name: '銀行', adj: [6, 4], type: 6001, decor: 14, flags: 14 },
      { x: 100, y: 148, adj: [1, 5], flags: 0x80000000 },
      { x: 244, y: 100, name: '醫院', adj: [3, 8], decor: 5, flags: 5 },
      { x: 292, y: 100, adj: [7], type: 8001 },
    ],
    lands: [
      {
        x: 100,
        y: 60,
        name: '甲街',
        facing: 2,
        landPrice: 1200,
        housePrice: 300,
        rent: [240, 600, 1500, 3600, 7200, 12000],
      },
      {
        x: 148,
        y: 60,
        name: '甲街',
        facing: 2,
        landPrice: 1200,
        housePrice: 350,
        rent: [240, 600, 1500, 3600, 7200, 12000],
      },
    ],
    facilities: [
      { x: 240, y: 150, name: '乙站', facing: 1, landPrice: 4000, rateWindow: [800, 600, 1500, 3500, 7000, 13000] },
    ],
    companies: [
      {
        x: 120,
        y: 190,
        name: '銀行',
        stockIndex: 0,
        industry: 7,
        facing: 3,
        spriteRes: 40,
        tollBase: 0,
        assetValue: 500000,
      },
    ],
    landscapes: [{ x: 300, y: 60, name: '醫院', facing: 1, spriteRes: 70 }],
  };
}

/**
 * 满足台湾样本期望的合成图（样本期望值是公开资料中的事实；其余记录全为填充数据）。
 * 计数 103/50/4/3/21；节点 3..103 成环，10、20 号各有一条封路支线通往关押格 1、2。
 */
export function taiwanLikeSpec(): MapSpec {
  const N = 103;
  const nodes: NodeSpec[] = [];
  const ring = (i: number, d: number) => ((i - 3 + d + (N - 2)) % (N - 2)) + 3;
  for (let id = 1; id <= N; id++) {
    const n: NodeSpec = { x: id * 16, y: 64 };
    if (id === 1) Object.assign(n, { type: 8002, adj: [10] });
    else if (id === 2) Object.assign(n, { type: 8001, adj: [20] });
    else {
      n.adj = [ring(id, 1), ring(id, -1)];
      if (id >= 3 && id <= 52) n.type = 2000 + (id - 2);
      else if (id >= 53 && id <= 56) n.type = 4000 + (id - 52);
      else if (id >= 57 && id <= 59) n.type = 6000 + (id - 56);
      if (id === 10)
        Object.assign(n, { type: 0, adj: [ring(id, 1), ring(id, -1), 1, 0], name: '監獄', flags: 4 | blockedBit(2) });
      if (id === 20)
        Object.assign(n, { type: 0, adj: [ring(id, 1), ring(id, -1), 2, 0], name: '醫院', flags: 5 | blockedBit(2) });
    }
    nodes.push(n);
  }
  const street = (name: string, landPrice: number, rent: number[], house: number[]): LandSpec[] =>
    house.map((h) => ({ name, landPrice, housePrice: h, rent }));
  const lands: LandSpec[] = [
    ...street('台北市', 2500, [500, 1200, 3000, 7500, 16000, 30000], [500, 500, 500, 500]),
    ...street('新竹市', 1000, [200, 500, 1200, 2800, 6000, 10000], [200, 200, 200, 200]),
    ...street('臺南市', 1500, [300, 750, 2000, 4800, 10000, 18000], [500, 300, 300, 300]),
  ];
  while (lands.length < 50)
    lands.push({ name: '測試市', landPrice: 1000, housePrice: 200, rent: [200, 1, 2, 3, 4, 5] });
  const facilities: FacilitySpec[] = [1, 2, 3, 4].map(() => ({
    name: '測試站',
    landPrice: 4000,
    rateWindow: [1, 2, 3, 4, 5, 6],
  }));
  const companies: CompanySpec[] = [
    { name: '臺灣人壽', stockIndex: 1, industry: 4, assetValue: 400000 },
    { name: '測試百貨', stockIndex: 2, industry: 10, assetValue: 1 },
    { name: '中國信託', stockIndex: 0, industry: 7, assetValue: 1 },
  ];
  const landscapes: LandscapeSpec[] = [{ name: '醫院' }, { name: '綠島' }];
  while (landscapes.length < 21) landscapes.push({ name: '景點' });
  return { nodes, lands, facilities, companies, landscapes };
}
