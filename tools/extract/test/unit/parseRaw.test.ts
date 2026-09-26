import { describe, expect, it } from 'vitest';
import { BinReader, fromHex } from '../../src/bin/reader';
import { LAYOUTS, readFieldValue, STRIDES, TABLE_ORDER } from '../../src/map/layout';
import {
  blockedBit,
  blockedSlots,
  failedChecks,
  landingCode,
  parseMapRaw,
  resolveNodeType,
} from '../../src/map/parseRaw';
import { computeRawStats } from '../../src/map/rawStats';
import type { MapDataRaw, RawSource } from '../../src/map/rawTypes';
import { buildMapResource, type MapSpec, smallMapSpec, tableOffsets } from '../helpers/buildMapResource';

const SOURCE: Omit<RawSource, 'byteLength' | 'resourceSha256'> = {
  id: 'v206-mapdat',
  edition: 'v206',
  file: 'Game/MapDat.mkf',
  fileSha256: '0'.repeat(64),
  knownFileId: null,
  container: 'MapDat.mkf',
  resource: 0,
  compressed: false,
};

const parse = (bytes: Uint8Array): MapDataRaw => parseMapRaw(bytes, SOURCE, 0);
const parseSpec = (spec: MapSpec): MapDataRaw => parse(buildMapResource(spec));

describe('parseRaw 字段偏移', () => {
  const raw = parseSpec(smallMapSpec());

  it('头部：1 基表、首尾相接、字节长度', () => {
    expect(raw.header.nodes).toEqual({ count: 8, offset: 40, stride: 0x28 });
    expect(raw.header.lands).toEqual({ count: 2, offset: 40 + 9 * 0x28, stride: 0x34 });
    expect(raw.header.landscapes.count).toBe(1);
    expect(raw.source.byteLength).toBe(raw.header.landscapes.offset + 2 * 0x1c);
    expect(failedChecks(raw, 'all')).toEqual([]);
  });

  it('节点：x/y/name/adj/type/decor/flags', () => {
    const n3 = raw.nodes[2]!;
    expect(n3).toMatchObject({ id: 3, x: 196, y: 100, adj: [4, 2, 7, 0], type: 0, decor: 13 });
    expect(n3.name).toEqual({ hex: 'a564a4f9', text: '卡片', roundtrip: true });
    expect(landingCode(n3.flags)).toBe(13);
    expect(blockedSlots(n3.flags)).toEqual([2]);
    expect(n3.hex).toHaveLength(0x28 * 2);
    expect(raw.nodes[5]!.flags >>> 0).toBe(0x80000000);
    expect(raw.nodes[5]!.name).toEqual({ hex: '', text: '', roundtrip: true });
  });

  it('住宅地：0x1c 地价、0x1e 房价、0x20 租金[6]、0x1b 朝向', () => {
    expect(raw.lands[1]).toMatchObject({
      id: 2,
      x: 148,
      y: 60,
      facing: 2,
      landPrice: 1200,
      housePrice: 350,
      rent: [240, 600, 1500, 3600, 7200, 12000],
      b17: 0,
      u2c: 0,
      u30: 0,
    });
  });

  it('设施：0x22 地价、0x24 rateWindow', () => {
    expect(raw.facilities[0]).toMatchObject({
      landPrice: 4000,
      rateWindow: [800, 600, 1500, 3500, 7000, 13000],
      facing: 1,
    });
  });

  it('企业：0x19 股票下标、0x1a 行业、0x20 精灵、0x22 收费基数、0x24 资产', () => {
    expect(raw.companies[0]).toMatchObject({
      stockIndex: 0,
      industry: 7,
      facing: 3,
      spriteRes: 40,
      tollBase: 0,
      assetValue: 500000,
      ranking: [0, 0, 0, 0],
    });
  });

  it('景观：0x18 朝向、0x1a 精灵', () => {
    expect(raw.landscapes[0]).toMatchObject({ facing: 1, b19: 0, spriteRes: 70 });
    expect(raw.landscapes[0]!.name.text).toBe('醫院');
  });

  it('布局表逐字节全覆盖，且与解析结果一致', () => {
    for (const t of TABLE_ORDER) {
      const specs = [...LAYOUTS[t]].sort((a, b) => a.off - b.off);
      let pos = 0;
      for (const s of specs) {
        expect(s.off, `${t}.${s.name}`).toBe(pos);
        pos += s.size;
      }
      expect(pos, t).toBe(STRIDES[t]);
      for (const rec of raw[t]) {
        const r = new BinReader(fromHex(rec.hex));
        for (const s of specs) {
          const parsed = (rec as unknown as Record<string, unknown>)[s.name];
          const expected = s.type === 'name' ? (parsed as { text: string | null }).text : parsed;
          expect(readFieldValue(r, 0, s), `${t}#${rec.id}.${s.name}`).toEqual(expected);
        }
      }
    }
  });

  it('type 开区间解析', () => {
    expect(resolveNodeType(0)).toEqual({ kind: 'special' });
    expect(resolveNodeType(2000)).toEqual({ kind: 'invalid' });
    expect(resolveNodeType(2001)).toEqual({ kind: 'ref', table: 'lands', index: 1 });
    expect(resolveNodeType(4000)).toEqual({ kind: 'invalid' });
    expect(resolveNodeType(5999)).toEqual({ kind: 'ref', table: 'facilities', index: 1999 });
    expect(resolveNodeType(6003)).toEqual({ kind: 'ref', table: 'companies', index: 3 });
    expect(resolveNodeType(8002)).toEqual({ kind: 'ref', table: 'landscapes', index: 2 });
    expect(resolveNodeType(10000)).toEqual({ kind: 'invalid' });
    expect(blockedBit(0)).toBe(0x40000000);
    expect(blockedBit(3)).toBe(0x08000000);
  });

  it('统计：落点码、封路、坐标残差', () => {
    const s = computeRawStats(raw);
    expect(s.landingCodes['13']).toEqual({ count: 1, names: ['卡片'] });
    expect(s.blocked).toEqual([{ node: 3, name: '卡片', slot: 2, target: 7 }]);
    expect(s.noItems).toEqual({ count: 1, nodes: [6] });
    expect(s.coords.nodes.x.min).toBe(100);
    expect(s.coords.nodes.x.mod['32']).toEqual({ '4': 5, '20': 3 });
    expect(s.degree).toEqual({ '1': 1, '2': 6, '3': 1 });
  });
});

describe('parseRaw 结构不变量', () => {
  const failing = (raw: MapDataRaw) => failedChecks(raw, 'all').map(([k]) => k);

  it('哨兵非零 → tables.sentinelZero 失败', () => {
    const bytes = buildMapResource(smallMapSpec());
    bytes[tableOffsets(smallMapSpec()).companies.offset + 5] = 1;
    expect(failing(parse(bytes))).toContain('tables.sentinelZero');
  });

  it('表不相接 / 长度不符', () => {
    const bytes = buildMapResource(smallMapSpec());
    const padded = new Uint8Array(bytes.length + 4);
    padded.set(bytes);
    expect(failing(parse(padded))).toEqual(['header.byteLength']);
    const dv = new DataView(bytes.buffer);
    dv.setUint32(12, dv.getUint32(12, true) + 4, true); // lands.offset 后移
    expect(failing(parse(bytes))).toContain('header.tableLayout');
  });

  it('表越界时直接抛错', () => {
    const bytes = buildMapResource(smallMapSpec());
    new DataView(bytes.buffer).setUint32(0, 500, true);
    expect(() => parse(bytes)).toThrow(/E_MAP_TABLE_RANGE/);
    expect(() => parse(new Uint8Array(10))).toThrow(/E_MAP_HEADER/);
  });

  it('邻接越界为 error，不对称为 warn', () => {
    const spec = smallMapSpec();
    spec.nodes![0]!.adj = [2, 6, 9, 0];
    const r1 = parseSpec(spec);
    expect(r1.checks['nodes.adjRange']).toMatchObject({ ok: false, severity: 'error' });
    const spec2 = smallMapSpec();
    spec2.nodes![1]!.adj = [3, 0];
    const r2 = parseSpec(spec2);
    expect(r2.checks['nodes.adjSymmetric']).toMatchObject({ ok: false, severity: 'warn' });
    expect(r2.checks['nodes.adjSymmetric']!.detail).toContain('1→2');
    expect(failedChecks(r2, 'error')).toEqual([]);
  });

  it('type 引用超出表范围或落在区间端点', () => {
    const spec = smallMapSpec();
    spec.nodes![0]!.type = 2003;
    spec.nodes![1]!.type = 4000;
    const raw = parseSpec(spec);
    expect(raw.checks['nodes.typeRefs']).toMatchObject({ ok: false, severity: 'error' });
    expect(raw.checks['nodes.typeRefs']!.detail).toContain('1:lands#3');
    expect(raw.checks['nodes.typeRefs']!.detail).toContain('2:type=4000');
  });

  it('落点码 > 16、未知 flag 位、封路位指向空槽', () => {
    const spec = smallMapSpec();
    spec.nodes![0]!.flags = 17;
    spec.nodes![1]!.flags = 0x100;
    spec.nodes![3]!.flags = blockedBit(3);
    const raw = parseSpec(spec);
    expect(raw.checks['nodes.landingCode']!.ok).toBe(false);
    expect(raw.checks['nodes.flagsKnownBits']).toMatchObject({ ok: false, severity: 'warn' });
    expect(raw.checks['nodes.blockedSlotsValid']).toMatchObject({ ok: false, severity: 'warn' });
  });

  it('运行期字段非零（存档里被写过的地图块）', () => {
    const spec = smallMapSpec();
    spec.lands![0]!.b19 = 2;
    spec.companies![0]!.shares = 100;
    spec.facilities![0]!.b1d = 1;
    const raw = parseSpec(spec);
    expect(raw.checks['lands.runtimeZero']).toMatchObject({ ok: false, severity: 'error' });
    expect(raw.checks['companies.runtimeZero']).toMatchObject({ ok: false, severity: 'error' });
    expect(raw.checks['facilities.runtimeZero']).toMatchObject({ ok: false, severity: 'warn' });
  });

  it('名称：Big5 失败与 NUL 后残留只告警', () => {
    const spec = smallMapSpec();
    spec.nodes![0]!.name = Uint8Array.from([0x88, 0x40]);
    spec.nodes![1]!.name = Uint8Array.from([0x41, 0x00, 0x42]);
    const raw = parseSpec(spec);
    expect(raw.nodes[0]!.name).toMatchObject({ hex: '8840', roundtrip: false });
    expect(raw.checks['names.big5']).toMatchObject({ ok: false, severity: 'warn' });
    expect(raw.checks['names.terminated']).toMatchObject({ ok: false, severity: 'warn' });
    expect(failedChecks(raw, 'error')).toEqual([]);
  });

  it('输出只含 JSON 值且可确定性序列化', () => {
    const a = JSON.stringify(parseSpec(smallMapSpec()));
    const b = JSON.stringify(parseSpec(smallMapSpec()));
    expect(a).toBe(b);
    expect(a).not.toContain('undefined');
  });
});
