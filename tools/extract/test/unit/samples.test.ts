import { describe, expect, it } from 'vitest';
import { blockedBit, failedChecks, parseMapRaw } from '../../src/map/parseRaw';
import type { MapDataRaw } from '../../src/map/rawTypes';
import { normalizeName, runTaiwanSamples, samplesFailed } from '../../src/verify/samples';
import { buildMapResource, type MapSpec, taiwanLikeSpec } from '../helpers/buildMapResource';

function rawOf(spec: MapSpec): MapDataRaw {
  return parseMapRaw(
    buildMapResource(spec),
    {
      id: 'v206-mapdat',
      edition: 'v206',
      file: 't',
      fileSha256: '0'.repeat(64),
      knownFileId: null,
      container: 'MapDat.mkf',
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
