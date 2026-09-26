import { readNameField } from '../bin/big5';
import { BinReader } from '../bin/reader';
import { ExtractError } from '../context';
import { sha256Hex } from '../io/hash';
import { MAP_HEADER_SIZE, STRIDES, TABLE_ORDER } from './layout';
import type {
  MapDataRaw,
  Quad,
  RawCheck,
  RawCompany,
  RawFacility,
  RawLand,
  RawLandscape,
  RawName,
  RawNode,
  RawSource,
  Six,
  TableName,
  TableRef,
} from './rawTypes';

/** 落点码最大值（flags 低字节 0..16）。 */
export const MAX_LANDING_CODE = 16;
/** flags bit31：禁放物件。 */
export const FLAG_NO_ITEMS = 0x80000000;
/** flags 中已知含义之外的位（8..26）。 */
export const FLAG_UNKNOWN_MASK = 0x07ffff00;

export function landingCode(flags: number): number {
  return flags & 0xff;
}

/** 槽 k 的静态封路位 bit(30−k)。 */
export function blockedBit(slot: number): number {
  return 0x40000000 >>> slot;
}

export function blockedSlots(flags: number): number[] {
  return [0, 1, 2, 3].filter((k) => (flags & blockedBit(k)) !== 0);
}

export type NodeTypeRef =
  | { kind: 'special' }
  | { kind: 'invalid' }
  | { kind: 'ref'; table: Exclude<TableName, 'nodes'>; index: number };

/** type 取值区间都是开区间：0 特殊；(2000,4000) 住宅；(4000,6000) 设施；(6000,8000) 企业；(8000,10000) 景观。 */
export function resolveNodeType(type: number): NodeTypeRef {
  if (type === 0) return { kind: 'special' };
  if (type > 2000 && type < 4000) return { kind: 'ref', table: 'lands', index: type - 2000 };
  if (type > 4000 && type < 6000) return { kind: 'ref', table: 'facilities', index: type - 4000 };
  if (type > 6000 && type < 8000) return { kind: 'ref', table: 'companies', index: type - 6000 };
  if (type > 8000 && type < 10000) return { kind: 'ref', table: 'landscapes', index: type - 8000 };
  return { kind: 'invalid' };
}

interface NameObs {
  table: TableName;
  id: number;
  terminated: boolean;
  trailingGarbage: boolean;
  name: RawName;
}

function listIds(ids: readonly (number | string)[], max = 12): string {
  const head = ids.slice(0, max).join(', ');
  return ids.length > max ? `${head} …（共 ${ids.length}）` : head;
}

function check(ok: boolean, severity: RawCheck['severity'], detail?: string): RawCheck {
  return ok || detail === undefined ? { ok, severity } : { ok, severity, detail };
}

/**
 * 解析地图结构资源为 MapDataRaw（data-pipeline.md §5.2–§5.4）。
 * 头部或表范围越界时无法解析，直接抛错；其余结构不变量写入 checks。
 */
export function parseMapRaw(
  bytes: Uint8Array,
  source: Omit<RawSource, 'byteLength' | 'resourceSha256'>,
  globalMapId: number,
): MapDataRaw {
  const r = new BinReader(bytes, `${source.id}/map${globalMapId}`);
  if (r.length < MAP_HEADER_SIZE) {
    throw new ExtractError('E_MAP_HEADER', `${r.label}: 资源只有 ${r.length} 字节，不足 40 字节头`);
  }
  const header = {} as Record<TableName, TableRef>;
  TABLE_ORDER.forEach((t, i) => {
    const count = r.u32(i * 8);
    const offset = r.u32(i * 8 + 4);
    const stride = STRIDES[t];
    if (count > 0xffff || !r.inRange(offset, (count + 1) * stride)) {
      throw new ExtractError(
        'E_MAP_TABLE_RANGE',
        `${r.label}: ${t} 表 count=${count} offset=${offset} stride=${stride} 越界（资源 ${r.length} 字节）`,
      );
    }
    header[t] = { count, offset, stride };
  });

  const names: NameObs[] = [];
  const nameAt = (table: TableName, id: number, off: number, len: number): RawName => {
    const info = readNameField(r.slice(off, len));
    names.push({ table, id, terminated: info.terminated, trailingGarbage: info.trailingGarbage, name: info.name });
    return info.name;
  };
  const rec = (t: TableName, id: number): number => header[t].offset + id * header[t].stride;

  const nodes: RawNode[] = [];
  for (let id = 1; id <= header.nodes.count; id++) {
    const o = rec('nodes', id);
    nodes.push({
      id,
      x: r.i16(o),
      y: r.i16(o + 2),
      name: nameAt('nodes', id, o + 0x04, 20),
      adj: r.u16Array(o + 0x18, 4) as Quad,
      type: r.u16(o + 0x20),
      decor: r.u16(o + 0x22),
      flags: r.u32(o + 0x24),
      hex: r.hex(o, STRIDES.nodes),
    });
  }

  const lands: RawLand[] = [];
  for (let id = 1; id <= header.lands.count; id++) {
    const o = rec('lands', id);
    lands.push({
      id,
      x: r.i16(o),
      y: r.i16(o + 2),
      name: nameAt('lands', id, o + 0x04, 19),
      b17: r.u8(o + 0x17),
      b18: r.u8(o + 0x18),
      b19: r.u8(o + 0x19),
      b1a: r.u8(o + 0x1a),
      facing: r.u8(o + 0x1b),
      landPrice: r.u16(o + 0x1c),
      housePrice: r.u16(o + 0x1e),
      rent: r.u16Array(o + 0x20, 6) as Six,
      u2c: r.u32(o + 0x2c),
      u30: r.u32(o + 0x30),
      hex: r.hex(o, STRIDES.lands),
    });
  }

  const facilities: RawFacility[] = [];
  for (let id = 1; id <= header.facilities.count; id++) {
    const o = rec('facilities', id);
    facilities.push({
      id,
      x: r.i16(o),
      y: r.i16(o + 2),
      name: nameAt('facilities', id, o + 0x04, 20),
      b18: r.u8(o + 0x18),
      b19: r.u8(o + 0x19),
      b1a: r.u8(o + 0x1a),
      facing: r.u8(o + 0x1b),
      b1c: r.u8(o + 0x1c),
      b1d: r.u8(o + 0x1d),
      b1e: r.u8(o + 0x1e),
      b1f: r.u8(o + 0x1f),
      u20: r.u16(o + 0x20),
      landPrice: r.u16(o + 0x22),
      rateWindow: r.u16Array(o + 0x24, 6) as Six,
      u30: r.u32(o + 0x30),
      u34: r.u32(o + 0x34),
      hex: r.hex(o, STRIDES.facilities),
    });
  }

  const companies: RawCompany[] = [];
  for (let id = 1; id <= header.companies.count; id++) {
    const o = rec('companies', id);
    companies.push({
      id,
      x: r.i16(o),
      y: r.i16(o + 2),
      name: nameAt('companies', id, o + 0x04, 20),
      owner: r.u8(o + 0x18),
      stockIndex: r.u8(o + 0x19),
      industry: r.u8(o + 0x1a),
      facing: r.u8(o + 0x1b),
      ranking: r.u8Array(o + 0x1c, 4) as Quad,
      spriteRes: r.u16(o + 0x20),
      tollBase: r.u16(o + 0x22),
      assetValue: r.u32(o + 0x24),
      funds: r.i32(o + 0x28),
      profit: r.i32(o + 0x2c),
      shares: r.u32(o + 0x30),
      hex: r.hex(o, STRIDES.companies),
    });
  }

  const landscapes: RawLandscape[] = [];
  for (let id = 1; id <= header.landscapes.count; id++) {
    const o = rec('landscapes', id);
    landscapes.push({
      id,
      x: r.i16(o),
      y: r.i16(o + 2),
      name: nameAt('landscapes', id, o + 0x04, 20),
      facing: r.u8(o + 0x18),
      b19: r.u8(o + 0x19),
      spriteRes: r.u16(o + 0x1a),
      hex: r.hex(o, STRIDES.landscapes),
    });
  }

  const checks: Record<string, RawCheck> = {};

  // 五张表首尾相接：间距 = (count+1)×stride
  {
    const bad: string[] = [];
    let expect = MAP_HEADER_SIZE;
    for (const t of TABLE_ORDER) {
      if (header[t].offset !== expect) bad.push(`${t}.offset=${header[t].offset}≠${expect}`);
      expect = header[t].offset + (header[t].count + 1) * header[t].stride;
    }
    checks['header.tableLayout'] = check(bad.length === 0, 'error', bad.join('; '));
    checks['header.byteLength'] = check(expect === r.length, 'error', `byteLength=${r.length}，按表推算应为 ${expect}`);
  }

  // 第 0 项哨兵全 0
  {
    const bad = TABLE_ORDER.filter((t) => !r.isZero(header[t].offset, header[t].stride));
    checks['tables.sentinelZero'] = check(bad.length === 0, 'error', `非零哨兵：${bad.join(', ')}`);
  }

  // 邻接
  {
    const n = header.nodes.count;
    const outOfRange: string[] = [];
    const asym: string[] = [];
    const self: number[] = [];
    for (const node of nodes) {
      node.adj.forEach((a, k) => {
        if (a === 0) return;
        if (a > n) outOfRange.push(`${node.id}[${k}]=${a}`);
        else if (!nodes[a - 1]!.adj.includes(node.id)) asym.push(`${node.id}→${a}`);
        if (a === node.id) self.push(node.id);
      });
    }
    checks['nodes.adjRange'] = check(outOfRange.length === 0, 'error', `越界：${listIds(outOfRange)}`);
    checks['nodes.adjSymmetric'] = check(asym.length === 0, 'warn', `不对称：${listIds(asym)}`);
    checks['nodes.adjNoSelf'] = check(self.length === 0, 'warn', `自环：${listIds(self)}`);
  }

  // type 引用范围
  {
    const bad: string[] = [];
    for (const node of nodes) {
      const ref = resolveNodeType(node.type);
      if (ref.kind === 'invalid') bad.push(`${node.id}:type=${node.type}`);
      else if (ref.kind === 'ref' && (ref.index < 1 || ref.index > header[ref.table].count)) {
        bad.push(`${node.id}:${ref.table}#${ref.index}`);
      }
    }
    checks['nodes.typeRefs'] = check(bad.length === 0, 'error', `非法引用：${listIds(bad)}`);
  }

  // flags
  {
    const badCode = nodes.filter((nd) => landingCode(nd.flags) > MAX_LANDING_CODE).map((nd) => nd.id);
    checks['nodes.landingCode'] = check(
      badCode.length === 0,
      'error',
      `落点码 > ${MAX_LANDING_CODE}：${listIds(badCode)}`,
    );
    const unknownBits = nodes
      .filter((nd) => (nd.flags & FLAG_UNKNOWN_MASK) !== 0)
      .map((nd) => `${nd.id}:0x${nd.flags.toString(16)}`);
    checks['nodes.flagsKnownBits'] = check(
      unknownBits.length === 0,
      'warn',
      `未知位（8..26）：${listIds(unknownBits)}`,
    );
    const badBlock: string[] = [];
    for (const nd of nodes) {
      for (const k of blockedSlots(nd.flags)) if (nd.adj[k] === 0) badBlock.push(`${nd.id}[${k}]`);
    }
    checks['nodes.blockedSlotsValid'] = check(badBlock.length === 0, 'warn', `封路位指向空槽：${listIds(badBlock)}`);
  }

  // 运行期字段应为 0（说明读到的是干净的地图模板）
  {
    const landBad = lands.filter((l) => l.b17 || l.b18 || l.b19 || l.b1a || l.u2c || l.u30).map((l) => l.id);
    checks['lands.runtimeZero'] = check(landBad.length === 0, 'error', `运行期字段非 0：${listIds(landBad)}`);
    const comBad = companies
      .filter((c) => c.owner || c.ranking.some((v) => v !== 0) || c.funds || c.profit || c.shares)
      .map((c) => c.id);
    checks['companies.runtimeZero'] = check(comBad.length === 0, 'error', `运行期字段非 0：${listIds(comBad)}`);
    const facBad = facilities
      .filter((fc) => fc.b18 || fc.b19 || fc.b1a || fc.b1c || fc.b1d || fc.b1e || fc.u30 || fc.u34)
      .map((fc) => fc.id);
    checks['facilities.runtimeZero'] = check(facBad.length === 0, 'warn', `运行期字段非 0：${listIds(facBad)}`);
  }

  // 名称
  {
    const unterminated = names.filter((x) => !x.terminated || x.trailingGarbage).map((x) => `${x.table}#${x.id}`);
    checks['names.terminated'] = check(
      unterminated.length === 0,
      'warn',
      `未以 NUL 结尾或 NUL 后有残留：${listIds(unterminated)}`,
    );
    const badBig5 = names
      .filter((x) => x.name.hex !== '' && (x.name.text === null || !x.name.roundtrip))
      .map((x) => `${x.table}#${x.id}(${x.name.hex})`);
    checks['names.big5'] = check(badBig5.length === 0, 'warn', `Big5 解码或回编码失败：${listIds(badBig5)}`);
  }

  return {
    schema: 'rich4.map-raw/1',
    source: { ...source, byteLength: r.length, resourceSha256: sha256Hex(bytes) },
    globalMapId,
    header,
    nodes,
    lands,
    facilities,
    companies,
    landscapes,
    checks,
  };
}

/** 失败的检查（默认只看 error 级）。 */
export function failedChecks(raw: MapDataRaw, severity: RawCheck['severity'] | 'all' = 'error'): [string, RawCheck][] {
  return Object.entries(raw.checks)
    .filter(([, c]) => !c.ok && (severity === 'all' || c.severity === severity))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
