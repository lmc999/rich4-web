/**
 * 测试专用：可控几何的合成地图（数值、名称、坐标全部虚构，与原版无关；台湾样本期望值沿用 taiwanLikeSpec）。
 */
import { blockedBit } from '../../src/map/parseRaw';
import {
  type CompanySpec,
  type FacilitySpec,
  type LandSpec,
  type LandscapeSpec,
  type MapSpec,
  type NodeSpec,
  taiwanLikeSpec,
} from './buildMapResource';

export const STEP = 48;
export const BASE = 200;

export interface Pt {
  x: number;
  y: number;
}

/** 矩形环路的周界格（顺时针，自左上角起）；cut=true 时去掉右上角，用一条对角边相连。 */
export function perimeter(w: number, h: number, cut = false): Pt[] {
  const out: Pt[] = [];
  for (let x = 0; x < w; x++) out.push({ x, y: 0 });
  for (let y = 1; y < h; y++) out.push({ x: w - 1, y });
  for (let x = w - 2; x >= 0; x--) out.push({ x, y: h - 1 });
  for (let y = h - 2; y >= 1; y--) out.push({ x: 0, y });
  return cut ? out.filter((p) => !(p.x === w - 1 && p.y === 0)) : out;
}

/** 周界格的外法线（角格取第一个命中的边） */
export function outward(p: Pt, w: number, h: number): Pt {
  if (p.y === 0) return { x: 0, y: -1 };
  if (p.x === w - 1) return { x: 1, y: 0 };
  if (p.y === h - 1) return { x: 0, y: 1 };
  return { x: -1, y: 0 };
}

/** 确定性的小抖动（|d| ≤ amp），模拟原版坐标不严格落在格点上。 */
export function jitter(id: number, axis: number, amp: number): number {
  if (amp === 0) return 0;
  const h = Math.imul(id * 2 + axis + 1, 0x9e3779b1) >>> 0;
  return (h % (2 * amp + 1)) - amp;
}

export const world = (c: Pt, id: number, amp: number): Pt => ({
  x: BASE + c.x * STEP + jitter(id, 0, amp),
  y: BASE + c.y * STEP + jitter(id, 1, amp),
});

export interface RingOptions {
  w: number;
  h: number;
  cut?: boolean;
  amp?: number;
  /** 周界下标 → 是否带住宅地（默认：上、下两边除角与特殊格外全部带地） */
  landAt?: (index: number, p: Pt) => boolean;
}

/**
 * 小型完整地图：矩形环路；左边中点是监狱闸口（落点码 4，槽 2 封路通往关押格）、右边中点是医院闸口；
 * 上边第 2 格为银行（企业 C1，落点码 14）；下边第 2、3 格为设施 F1 的两个前沿格；下边第 5、6 格为企业 C2；
 * 其余格按规则分配住宅地与特殊落点。
 */
export function ringMapSpec(o: RingOptions): MapSpec {
  const { w, h } = o;
  const amp = o.amp ?? 0;
  const per = perimeter(w, h, o.cut ?? false);
  const n = per.length;
  const idx = (p: Pt) => per.findIndex((q) => q.x === p.x && q.y === p.y);
  const jailGate = idx({ x: 0, y: Math.floor(h / 2) });
  const hospGate = idx({ x: w - 1, y: Math.floor(h / 2) });
  const bank = idx({ x: 2, y: 0 });
  const fac = [idx({ x: w - 3, y: h - 1 }), idx({ x: w - 4, y: h - 1 })];
  const com = [idx({ x: w - 6, y: h - 1 }), idx({ x: w - 7, y: h - 1 })];
  const special = new Set([jailGate, hospGate, bank, ...fac, ...com]);
  const isCorner = (p: Pt) => (p.x === 0 || p.x === w - 1) && (p.y === 0 || p.y === h - 1);
  const landAt = o.landAt ?? ((_: number, p: Pt) => (p.y === 0 || p.y === h - 1) && !isCorner(p));

  const nodes: NodeSpec[] = [];
  const lands: LandSpec[] = [];
  const codes = [2, 3, 9, 13, 16, 1, 6, 7, 8, 10, 11, 12, 15];
  let codeK = 0;
  per.forEach((p, i) => {
    const id = i + 1;
    const next = ((i + 1) % n) + 1;
    const prev = ((i - 1 + n) % n) + 1;
    const node: NodeSpec = { ...world(p, id, amp), adj: [next, prev, 0, 0] };
    if (i === jailGate || i === hospGate) {
      const hold = i === jailGate ? n + 1 : n + 2;
      node.adj = [next, prev, hold, 0];
      node.flags = (i === jailGate ? 4 : 5) | blockedBit(2);
      node.name = i === jailGate ? '監獄' : '醫院';
    } else if (i === bank) {
      node.type = 6001;
      node.flags = 14;
      node.name = '銀行';
    } else if (fac.includes(i)) {
      node.type = 4001;
      node.name = '乙站';
    } else if (com.includes(i)) {
      node.type = 6002;
      node.name = '丙壽';
    } else if (landAt(i, p) && !special.has(i)) {
      lands.push({
        ...world({ x: p.x + outward(p, w, h).x, y: p.y + outward(p, w, h).y }, 1000 + id, amp),
        name: p.y === 0 ? '甲街' : p.y === h - 1 ? '乙街' : '丙街',
        facing: p.y === 0 ? 0 : p.x === w - 1 ? 2 : p.y === h - 1 ? 4 : 6,
        landPrice: 1000,
        housePrice: 200,
        rent: [200, 500, 1200, 2800, 6000, 10000],
      });
      node.type = 2000 + lands.length;
      node.name = lands[lands.length - 1]!.name as string;
    } else if (!isCorner(p) && codeK < codes.length && i % 2 === 1) {
      node.flags = codes[codeK++]!;
    }
    nodes.push(node);
  });
  // 关押格：闸口内侧一格
  for (const [gate, type] of [
    [jailGate, 8002],
    [hospGate, 8001],
  ] as const) {
    const p = per[gate]!;
    const out = outward(p, w, h);
    nodes.push({ ...world({ x: p.x - out.x, y: p.y - out.y }, 500 + gate, amp), adj: [gate + 1, 0, 0, 0], type });
  }
  const mid = (a: number, b: number) => ({ x: (per[a]!.x + per[b]!.x) / 2, y: (per[a]!.y + per[b]!.y) / 2 });
  const facilities: FacilitySpec[] = [
    {
      ...world({ x: mid(fac[0]!, fac[1]!).x, y: h - 1 + 1.5 }, 900, amp),
      name: '乙站',
      facing: 4,
      landPrice: 4000,
      rateWindow: [800, 600, 1500, 3500, 7000, 13000],
    },
  ];
  const companies: CompanySpec[] = [
    { ...world({ x: 2.5, y: -1.5 }, 901, amp), name: '銀行', stockIndex: 0, industry: 7, assetValue: 500000 },
    {
      ...world({ x: mid(com[0]!, com[1]!).x, y: h - 1 + 1.5 }, 902, amp),
      name: '丙壽',
      stockIndex: 1,
      industry: 4,
      tollBase: 500,
      assetValue: 300000,
    },
  ];
  const landscapes: LandscapeSpec[] = [
    { ...world({ x: w - 3, y: Math.floor(h / 2) }, 903, amp), name: '醫院' },
    { ...world({ x: 2, y: Math.floor(h / 2) }, 904, amp), name: '綠島' },
    { ...world({ x: Math.floor(w / 2), y: Math.floor(h / 2) }, 905, amp), name: '湖景' },
  ];
  return { nodes, lands, facilities, companies, landscapes };
}

/**
 * 满足台湾样本（计数 103/50/4/3/21、三组街道、两个封路闸口、关押格、企业字段）且几何可归一化的合成图：
 * 节点 3..103 排在 27×26 的矩形环上（右上角斜切），1、2 为闸口 10、20 内侧的关押格；
 * 50 块住宅地的前沿格为 3..9、11..19、21..54，设施 55..58，企业 59..61。数值取自 taiwanLikeSpec（虚构填充）。
 */
export function laidOutTaiwanLike(amp = 0): MapSpec {
  const base = taiwanLikeSpec();
  const W = 27;
  const H = 26;
  const per = perimeter(W, H, true);
  const N = 103;
  const ringIds = Array.from({ length: N - 2 }, (_, i) => i + 3);
  const pos = new Map<number, Pt>(ringIds.map((id, i) => [id, per[i]!]));
  const landFronts = ringIds.filter((id) => id !== 10 && id !== 20).slice(0, 50);
  const facFronts = ringIds.filter((id) => id > 54 && id !== 10 && id !== 20).slice(0, 4);
  const comFronts = ringIds.filter((id) => id > 58).slice(0, 3);

  const nodes: NodeSpec[] = base.nodes!.map((n, i) => {
    const id = i + 1;
    const out: NodeSpec = { ...n };
    if (id <= 2) {
      const gate = id === 1 ? 10 : 20;
      const g = pos.get(gate)!;
      const inward = { x: -outward(g, W, H).x, y: -outward(g, W, H).y };
      Object.assign(out, world({ x: g.x + inward.x, y: g.y + inward.y }, id, amp));
      return out;
    }
    Object.assign(out, world(pos.get(id)!, id, amp));
    if (id === 10 || id === 20) return out;
    delete out.type;
    const li = landFronts.indexOf(id);
    const fi = facFronts.indexOf(id);
    const ci = comFronts.indexOf(id);
    if (li >= 0) out.type = 2001 + li;
    else if (fi >= 0) out.type = 4001 + fi;
    else if (ci >= 0) out.type = 6001 + ci;
    return out;
  });
  const offset = (id: number, k: number, salt: number): Pt => {
    const p = pos.get(id)!;
    const o = outward(p, W, H);
    return world({ x: p.x + o.x * k, y: p.y + o.y * k }, salt, amp);
  };
  const lands = base.lands!.map((l, i) => ({ ...l, ...offset(landFronts[i]!, 1, 2000 + i) }));
  const facilities = base.facilities!.map((f, i) => ({ ...f, ...offset(facFronts[i]!, 1.5, 3000 + i) }));
  const companies = base.companies!.map((c, i) => ({ ...c, ...offset(comFronts[i]!, 1.5, 4000 + i) }));
  const hold = (id: number): Pt => {
    const n = nodes[id - 1]!;
    return { x: n.x! + 72, y: n.y! + 72 };
  };
  const landscapes = base.landscapes!.map((s, i) => {
    if (i === 0) return { ...s, ...hold(2) };
    if (i === 1) return { ...s, ...hold(1) };
    const k = i - 2;
    return { ...s, ...world({ x: 4 + (k % 5) * 4, y: 5 + Math.floor(k / 5) * 4 }, 5000 + i, amp) };
  });
  return { nodes, lands, facilities, companies, landscapes };
}
