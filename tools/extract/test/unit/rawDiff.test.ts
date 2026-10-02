import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/context';
import { parseMapRaw } from '../../src/map/parseRaw';
import {
  ACCEPTED_RULE_DIFFS,
  acceptRuleDiffs,
  bucketOf,
  diffExitCode,
  diffRaw,
  ruleDiffKey,
} from '../../src/map/rawDiff';
import type { MapDataRaw, RawSourceId } from '../../src/map/rawTypes';
import { buildMapResource, type MapSpec, smallMapSpec } from '../helpers/buildMapResource';

function rawOf(id: RawSourceId, spec: MapSpec): MapDataRaw {
  return parseMapRaw(
    buildMapResource(spec),
    {
      id,
      edition: id.startsWith('v206') ? 'v206' : 'v311',
      file: `${id}.mkf`,
      fileSha256: '0'.repeat(64),
      knownFileId: null,
      container: id === 'v206-mapdat' ? 'MapDat.mkf' : 'map.mkf',
      resource: id === 'v206-mapdat' ? 0 : 1,
      compressed: false,
    },
    0,
  );
}

describe('rawDiff 分类', () => {
  it('完全相同：无差异，exit 0', () => {
    const d = diffRaw([rawOf('v206-mapdat', smallMapSpec()), rawOf('v206-mapmkf', smallMapSpec())]);
    expect(d.identical).toBe(true);
    expect(d.identicalGroups).toEqual([['v206-mapdat', 'v206-mapmkf']]);
    expect(d.rule).toEqual([]);
    expect(d.presentation).toEqual([]);
    expect(diffExitCode(d)).toBe(ExitCode.OK);
  });

  it('只有 decor / 企业精灵 / 景观精灵不同 → 表现相关，exit 0', () => {
    const b = smallMapSpec();
    b.nodes![0]!.decor = 33;
    b.companies![0]!.spriteRes = 41;
    b.landscapes![0]!.spriteRes = 0x1234;
    b.landscapes![0]!.facing = 5;
    const d = diffRaw([
      rawOf('v206-mapdat', smallMapSpec()),
      rawOf('v206-mapmkf', smallMapSpec()),
      rawOf('v311-mapmkf', b),
    ]);
    expect(d.identical).toBe(false);
    expect(d.identicalGroups).toEqual([['v206-mapdat', 'v206-mapmkf'], ['v311-mapmkf']]);
    expect(d.rule).toEqual([]);
    expect(d.counts.presentation).toBe(4);
    const fields = d.summary.map((r) => `${r.table}+${r.offset}:${r.field}:${r.bucket}`);
    expect(fields).toEqual([
      'nodes+0x22:decor:presentation',
      'companies+0x20:spriteRes:presentation',
      'landscapes+0x18:facing:presentation',
      'landscapes+0x1a:spriteRes:presentation',
    ]);
    const scape = d.presentation.find((it) => it.table === 'landscapes' && it.field === 'spriteRes')!;
    expect(scape.byteOffsets).toEqual(['0x1a', '0x1b']);
    expect(scape.values).toEqual({ 'v206-mapdat': 70, 'v206-mapmkf': 70, 'v311-mapmkf': 0x1234 });
    const decor = d.presentation.find((it) => it.field === 'decor')!;
    expect(decor).toMatchObject({ table: 'nodes', id: 1, offset: '0x22', byteOffsets: ['0x22'] });
    expect(diffExitCode(d)).toBe(ExitCode.OK);
  });

  it('租金 / 邻接 / flags / 名称不同 → 规则相关，exit 4', () => {
    const b = smallMapSpec();
    b.lands![0]!.rent = [250, 600, 1500, 3600, 7200, 12000];
    b.nodes![2]!.adj = [4, 2, 0, 7];
    b.nodes![3]!.flags = 1;
    b.companies![0]!.name = '銀樓';
    const d = diffRaw([rawOf('v206-mapdat', smallMapSpec()), rawOf('v311-mapmkf', b)]);
    const keys = d.rule.map((it) => `${it.table}#${it.id}.${it.field}`);
    expect(keys).toEqual(['nodes#3.adj', 'nodes#4.flags', 'lands#1.rent', 'companies#1.name']);
    expect(d.rule[0]!.values).toEqual({ 'v206-mapdat': [4, 2, 7, 0], 'v311-mapmkf': [4, 2, 0, 7] });
    expect(d.rule[3]!.values).toEqual({ 'v206-mapdat': '銀行', 'v311-mapmkf': '銀樓' });
    expect(diffExitCode(d)).toBe(ExitCode.RULE_DIFF);
  });

  it('运行期/未知字段差异保守地归入规则相关', () => {
    expect(bucketOf('runtime')).toBe('rule');
    expect(bucketOf('unknown')).toBe('rule');
    const b = smallMapSpec();
    b.facilities![0]!.u20 = 7;
    const d = diffRaw([rawOf('v206-mapdat', smallMapSpec()), rawOf('v311-mapmkf', b)]);
    expect(d.rule).toHaveLength(1);
    expect(d.rule[0]).toMatchObject({ table: 'facilities', field: 'u20', cls: 'unknown' });
    expect(diffExitCode(d)).toBe(ExitCode.RULE_DIFF);
  });

  it('计数不同：头部与多出的记录都算规则相关', () => {
    const b = smallMapSpec();
    b.landscapes!.push({ name: '綠島' });
    const d = diffRaw([rawOf('v206-mapdat', smallMapSpec()), rawOf('v311-mapmkf', b)]);
    const keys = d.rule.map((it) => `${it.table}.${it.field}`);
    expect(keys).toContain('resource.byteLength');
    expect(keys).toContain('header.landscapes.count');
    expect(keys).toContain('landscapes.<record>');
    expect(diffExitCode(d)).toBe(ExitCode.RULE_DIFF);
  });

  it('来源不足 2 个时报错', () => {
    expect(() => diffRaw([rawOf('v206-mapdat', smallMapSpec())])).toThrow(/E_DIFF_SOURCES/);
  });
});

describe('已知规则差异清单（all 子命令放行 map diff exit 4 的条件）', () => {
  const item = (table: string, id: number | null, field: string) =>
    ({ table, id, field }) as Parameters<typeof ruleDiffKey>[0];
  const diffOf = (gm: number, ...rule: ReturnType<typeof item>[]) => ({
    globalMapId: gm,
    rule: rule as unknown as Parameters<typeof acceptRuleDiffs>[0]['rule'],
  });

  it('清单只有大陆 companies#4.name、日本 lands#17.rent，基线都是 v206-mapdat', () => {
    expect(Object.keys(ACCEPTED_RULE_DIFFS)).toEqual(['1', '2']);
    expect(ACCEPTED_RULE_DIFFS[1]).toMatchObject({ baseline: 'v206-mapdat', keys: ['companies#4.name'] });
    expect(ACCEPTED_RULE_DIFFS[2]).toMatchObject({ baseline: 'v206-mapdat', keys: ['lands#17.rent'] });
    expect(ruleDiffKey(item('header', null, 'lands.count'))).toBe('header#-.lands.count');
  });

  it('规则差异正好等于清单、基线一致 → 放行；多一处、少一处、没有清单、基线不符 → 不放行', () => {
    const china = item('companies', 4, 'name');
    expect(acceptRuleDiffs(diffOf(1, china), 'v206-mapdat')).toEqual({
      ok: true,
      unexpected: [],
      missing: [],
      baselineProblem: null,
    });
    // 同一处差异在两个来源里各出现一次（按键去重）
    expect(acceptRuleDiffs(diffOf(1, china, china), 'v206-mapdat').ok).toBe(true);
    const extra = acceptRuleDiffs(diffOf(1, china, item('lands', 3, 'rent')), 'v206-mapdat');
    expect(extra).toMatchObject({ ok: false, unexpected: ['lands#3.rent'] });
    expect(acceptRuleDiffs(diffOf(2, item('lands', 3, 'rent')), 'v206-mapdat')).toMatchObject({
      ok: false,
      unexpected: ['lands#3.rent'],
      missing: ['lands#17.rent'],
    });
    // 美国、台湾没有清单：任何规则差异都不放行
    expect(acceptRuleDiffs(diffOf(3, item('lands', 17, 'rent')), 'v206-mapdat')).toMatchObject({
      ok: false,
      baselineProblem: 'gm 3 没有已知规则差异清单',
    });
    expect(acceptRuleDiffs(diffOf(0, item('lands', 17, 'rent')), 'v206-mapdat').ok).toBe(false);
    // 基线：没选、选的不是 v206-mapdat
    expect(acceptRuleDiffs(diffOf(1, china), null).baselineProblem).toContain('没有选定基线');
    expect(acceptRuleDiffs(diffOf(1, china), 'v206-mapmkf').baselineProblem).toContain('v206-mapmkf');
  });
});
