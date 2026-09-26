/** 需要用户正版文件（original/）；文件不存在时整组 skip。 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExtractContext } from '../../src/context';
import { loadKnownFiles } from '../../src/fingerprint/identify';
import { readFileRO } from '../../src/io/readOnly';
import { failedChecks } from '../../src/map/parseRaw';
import { diffExitCode, diffRaw } from '../../src/map/rawDiff';
import { computeRawStats } from '../../src/map/rawStats';
import type { MapDataRaw } from '../../src/map/rawTypes';
import { loadRawSource, RAW_SOURCES } from '../../src/map/sources';
import { MkfArchive } from '../../src/mkf/container';
import { runTaiwanSamples } from '../../src/verify/samples';

const ctx = new ExtractContext({ logger: { out: () => {}, err: () => {} } });
const REQUIRED = ['Game/MapDat.MKF', 'Game/map.mkf', 'MultiverseJourney/map.mkf'];
const available = REQUIRED.every((p) => existsSync(path.join(ctx.srcDir, p)));

describe.skipIf(!available)('台湾图（本机原版文件）', () => {
  const load = async (): Promise<MapDataRaw[]> => {
    const known = await loadKnownFiles(ctx.packageDir);
    const out: MapDataRaw[] = [];
    for (const def of RAW_SOURCES) out.push((await loadRawSource(ctx, def, 0, known)).raw);
    return out;
  };

  it('三个 MKF 容器不变量成立（资源数 4/150/298，无哨兵）', async () => {
    const counts: number[] = [];
    for (const rel of REQUIRED) {
      const mkf = MkfArchive.open(await readFileRO(path.join(ctx.srcDir, rel)), rel);
      expect(mkf.hasSentinel, rel).toBe(false);
      counts.push(mkf.count);
    }
    expect(counts).toEqual([4, 150, 298]);
  });

  it('三个来源都能解析、未压缩、结构不变量无错误', async () => {
    const raws = await load();
    expect(raws.map((r) => r.source.id)).toEqual(['v206-mapdat', 'v206-mapmkf', 'v311-mapmkf']);
    for (const r of raws) {
      expect(r.source.compressed).toBe(false);
      expect(r.source.byteLength).toBe(7956);
      expect(r.source.knownFileId).not.toBeNull();
      expect(failedChecks(r, 'error'), r.source.id).toEqual([]);
      expect(Object.values(r.header).map((t) => t.count)).toEqual([103, 50, 4, 3, 21]);
    }
  });

  it('§10.1 样本全部通过（三个来源）', async () => {
    for (const r of await load()) {
      const fails = runTaiwanSamples(r).filter((s) => s.status === 'fail');
      expect(fails, r.source.id).toEqual([]);
    }
  });

  it('恰好 2 个节点带静态封路位', async () => {
    const [raw] = await load();
    const s = computeRawStats(raw!);
    expect(new Set(s.blocked.map((b) => b.node)).size).toBe(2);
    expect(s.blocked.every((b) => b.target !== 0)).toBe(true);
  });

  it('rawDiff 只有表现相关差异（node+0x22、company+0x20、landscape+0x1a/0x1b）', async () => {
    const d = diffRaw(await load());
    expect(d.rule).toEqual([]);
    expect(diffExitCode(d)).toBe(0);
    expect(d.identicalGroups).toEqual([['v206-mapdat', 'v206-mapmkf'], ['v311-mapmkf']]);
    const where = new Set(d.presentation.flatMap((it) => it.byteOffsets.map((b) => `${it.table}+${b}`)));
    for (const w of where) {
      expect(['nodes+0x22', 'companies+0x20', 'landscapes+0x1a', 'landscapes+0x1b']).toContain(w);
    }
  });
});
