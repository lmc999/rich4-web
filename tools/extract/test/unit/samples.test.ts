import { describe, expect, it } from 'vitest';
import { blockedBit, failedChecks, parseMapRaw } from '../../src/map/parseRaw';
import type { MapDataRaw } from '../../src/map/rawTypes';
import {
  MAP_SAMPLES,
  type MapSampleSpec,
  normalizeName,
  runMapSamples,
  runTaiwanSamples,
  samplesFailed,
  samplesSpecFor,
} from '../../src/verify/samples';
import { buildMapResource, type MapSpec, smallMapSpec, taiwanLikeSpec } from '../helpers/buildMapResource';

function rawOf(spec: MapSpec, sourceId: MapDataRaw['source']['id'] = 'v206-mapdat'): MapDataRaw {
  return parseMapRaw(
    buildMapResource(spec),
    {
      id: sourceId,
      edition: sourceId === 'v311-mapmkf' ? 'v311' : 'v206',
      file: 't',
      fileSha256: '0'.repeat(64),
      knownFileId: null,
      container: sourceId === 'v206-mapdat' ? 'MapDat.mkf' : 'map.mkf',
      resource: 0,
      compressed: false,
    },
    0,
  );
}

const byId = (rs: ReturnType<typeof runTaiwanSamples>, id: string) => rs.find((r) => r.id === id)!;

describe('台湾样本（合成数据）', () => {
  it('满足期望的合成图全部通过，且结构检查无错误', () => {
    const raw = rawOf(taiwanLikeSpec());
    expect(failedChecks(raw, 'all')).toEqual([]);
    const rs = runTaiwanSamples(raw);
    expect(rs.filter((r) => r.status === 'fail')).toEqual([]);
    expect(samplesFailed(rs)).toBe(false);
    expect(byId(rs, 'blocked').detail).toContain('10「監獄」槽2→1');
    expect(byId(rs, 'hold.8001').detail).toContain('醫院');
    // 「臺南市」与「台南市」视为同名
    expect(byId(rs, 'tainan.count').status).toBe('pass');
    expect(byId(rs, 'heuristic.rent20').status).toBe('pass');
  });

  it('台/臺 归一', () => {
    expect(normalizeName('臺灣人壽')).toBe('台灣人壽');
  });

  it('计数、价格、房价顺序、租金不符时失败', () => {
    const spec = taiwanLikeSpec();
    spec.landscapes!.pop();
    spec.lands![0]!.landPrice = 2400;
    spec.lands![8]!.housePrice = 300;
    spec.lands![5]!.rent = [200, 500, 1200, 2800, 6000, 9999];
    const rs = runTaiwanSamples(rawOf(spec));
    expect(byId(rs, 'counts').status).toBe('fail');
    expect(byId(rs, 'taipei.landPrice').status).toBe('fail');
    expect(byId(rs, 'taipei.landPrice').actual).toBe('[2400,2500]');
    expect(byId(rs, 'tainan.housePrice').status).toBe('fail');
    expect(byId(rs, 'hsinchu.rent').status).toBe('fail');
    expect(byId(rs, 'taipei.rent').status).toBe('pass');
    expect(samplesFailed(rs)).toBe(true);
  });

  it('封路不是恰好 2 处时如实失败并列出节点', () => {
    const spec = taiwanLikeSpec();
    spec.nodes![29]!.flags = blockedBit(0);
    const r = byId(runTaiwanSamples(rawOf(spec)), 'blocked');
    expect(r.status).toBe('fail');
    expect(r.actual).toBe('3');
    expect(r.detail).toContain('30「」槽0');
  });

  it('企业、关押格、Big5 失败', () => {
    const spec = taiwanLikeSpec();
    spec.companies![0]!.assetValue = 1;
    spec.companies![2]!.industry = 3;
    spec.nodes![0]!.type = 0;
    spec.nodes![1]!.adj = [0, 0, 0, 0];
    spec.nodes![40]!.name = Uint8Array.from([0x88, 0x40]);
    const rs = runTaiwanSamples(rawOf(spec));
    expect(byId(rs, 'company.life.asset').status).toBe('fail');
    expect(byId(rs, 'company.bank').status).toBe('fail');
    expect(byId(rs, 'hold.8002').status).toBe('fail');
    expect(byId(rs, 'hold.8001').status).toBe('pass');
    expect(byId(rs, 'big5').status).toBe('fail');
    expect(byId(rs, 'big5').detail).toContain('node#41(8840)');
  });

  it('rent[0]≠地价×20% 只告警', () => {
    const spec = taiwanLikeSpec();
    spec.lands![20]!.rent = [150, 1, 2, 3, 4, 5];
    const rs = runTaiwanSamples(rawOf(spec));
    expect(byId(rs, 'heuristic.rent20').status).toBe('warn');
    expect(samplesFailed(rs)).toBe(false);
  });
});

/**
 * 新图样式的合成图：smallMapSpec（8 节点，3 号槽 2→7 静态封路，6 号 bit31，8 号医院关押格）
 * 再加一个监狱关押格 9 与景观 2「監獄」。数值全部虚构。
 */
function newStyleSpec(): MapSpec {
  const spec = smallMapSpec();
  spec.nodes!.push({ x: 340, y: 100, adj: [7], type: 8002 });
  spec.landscapes!.push({ x: 340, y: 60, name: '監獄', facing: 1, spriteRes: 71 });
  return spec;
}

const newStyle: MapSampleSpec = {
  key: 'synthetic',
  globalMapId: 9,
  counts: [9, 2, 1, 1, 2],
  streets: [],
  streetsPending: '合成图没有街道样本',
  hold: { 8001: 8, 8002: 9 },
  blocked: { edges: ['3->7'] },
  noItems: [6],
  companies: [
    { id: 'company.C1', label: '銀行', companyId: 1, fields: { industry: 7, stockIndex: 0, assetValue: 500000 } },
  ],
  fields: [
    {
      id: 'flaw.L2.landPrice',
      label: 'L2 地价',
      table: 'lands',
      recordId: 2,
      field: 'landPrice',
      expected: 1200,
      bySource: { 'v206-mapmkf': 9999 },
    },
    { id: 'flaw.C1.name', label: 'C1 名称', table: 'companies', recordId: 1, field: 'name', expected: '銀行' },
  ],
};

describe('按图样本（spec 驱动）', () => {
  it('新图样式：关押格与景观、确切封路边、bit31、按企业号的企业字段、字段样本全部通过；街道占位只告警', () => {
    const rs = runMapSamples(rawOf(newStyleSpec()), newStyle);
    expect(rs.filter((r) => r.status === 'fail')).toEqual([]);
    expect(samplesFailed(rs)).toBe(false);
    expect(rs.map((r) => r.id)).toEqual([
      'counts',
      'streets.pending',
      'hold.8001',
      'hold.8002',
      'blocked',
      'noItems',
      'big5',
      'company.C1',
      'flaw.L2.landPrice',
      'flaw.C1.name',
      'heuristic.rent20',
    ]);
    expect(byId(rs, 'streets.pending')).toMatchObject({ status: 'warn', detail: '合成图没有街道样本' });
    expect(byId(rs, 'hold.8002')).toMatchObject({ expected: '节点 9「監獄」', actual: '节点 9「監獄」' });
    expect(byId(rs, 'blocked')).toMatchObject({ expected: '3->7', actual: '3->7' });
    expect(byId(rs, 'noItems').actual).toBe('1 个 [6]');
    expect(byId(rs, 'company.C1')).toMatchObject({
      label: '銀行 industry/stockIndex/assetValue',
      detail: '企业 C1「銀行」',
    });
  });

  it('关押格节点或景观名不符、封路边不同、bit31 不同、企业字段不符时失败', () => {
    const spec = newStyleSpec();
    spec.landscapes![1]!.name = '綠島';
    spec.nodes![2]!.flags = 13; // 去掉 3 号的封路位
    spec.nodes![0]!.flags = 0x80000000;
    spec.companies![0]!.assetValue = 1;
    const rs = runMapSamples(rawOf(spec), newStyle);
    expect(byId(rs, 'hold.8001').status).toBe('pass');
    expect(byId(rs, 'hold.8002')).toMatchObject({ status: 'fail', actual: '节点 9「綠島」' });
    expect(byId(rs, 'blocked')).toMatchObject({ status: 'fail', actual: '无' });
    expect(byId(rs, 'noItems')).toMatchObject({ status: 'fail', actual: '2 个 [1,6]' });
    expect(byId(rs, 'company.C1').status).toBe('fail');
    const wrongHold = runMapSamples(rawOf(newStyleSpec()), { ...newStyle, hold: { 8001: 7, 8002: 9 } });
    expect(byId(wrongHold, 'hold.8001')).toMatchObject({ status: 'fail', expected: '节点 7「醫院」' });
  });

  it('字段样本按来源取期望（记录已知的多来源基线差异）', () => {
    const spec = newStyleSpec();
    spec.lands![1]!.landPrice = 9999;
    expect(byId(runMapSamples(rawOf(spec, 'v206-mapmkf'), newStyle), 'flaw.L2.landPrice')).toMatchObject({
      status: 'pass',
      expected: '9999',
    });
    expect(byId(runMapSamples(rawOf(spec, 'v206-mapdat'), newStyle), 'flaw.L2.landPrice')).toMatchObject({
      status: 'fail',
      expected: '1200',
      actual: '9999',
    });
    expect(byId(runMapSamples(rawOf(spec, 'v311-mapmkf'), newStyle), 'flaw.L2.landPrice').status).toBe('fail');
  });

  it('MAP_SAMPLES：四张图、globalMapId 与键一致；台湾入口与泛化后的 spec 等价', () => {
    expect(Object.keys(MAP_SAMPLES)).toEqual(['taiwan', 'china', 'japan', 'usa']);
    expect([0, 1, 2, 3].map((gm) => samplesSpecFor(gm)?.key)).toEqual(['taiwan', 'china', 'japan', 'usa']);
    expect(samplesSpecFor(4)).toBeUndefined();
    const raw = rawOf(taiwanLikeSpec());
    expect(runMapSamples(raw, MAP_SAMPLES.taiwan!)).toEqual(runTaiwanSamples(raw));
    // 新图：计数、关押格、封路边、禁放物件与企业按公开资料和三来源一致的结构给出；街道样本留空待核对
    expect(MAP_SAMPLES.china).toMatchObject({ counts: [144, 73, 8, 4, 26], hold: { 8001: 63, 8002: 144 } });
    expect(MAP_SAMPLES.japan).toMatchObject({ blocked: { edges: ['78->79'] }, noItems: [23, 24, 25, 26, 27, 28, 29] });
    expect(MAP_SAMPLES.usa).toMatchObject({ blocked: { edges: [] }, hold: { 8001: 85, 8002: 118 } });
    for (const k of ['china', 'japan', 'usa']) {
      expect(MAP_SAMPLES[k]!.streets, k).toEqual([]);
      expect(MAP_SAMPLES[k]!.streetsPending, k).toBeTruthy();
    }
  });

  it('台湾 spec 的结果顺序与泛化前一致（samples.map0.json 字节不变的前提）', () => {
    expect(runTaiwanSamples(rawOf(taiwanLikeSpec())).map((r) => r.id)).toEqual([
      'counts',
      'taipei.count',
      'taipei.landPrice',
      'taipei.rent',
      'hsinchu.exists',
      'hsinchu.landPrice',
      'hsinchu.rent',
      'tainan.count',
      'tainan.landPrice',
      'tainan.housePrice',
      'tainan.rent',
      'hold.8001',
      'hold.8002',
      'blocked',
      'big5',
      'company.life.asset',
      'company.bank',
      'heuristic.rent20',
    ]);
  });
});
