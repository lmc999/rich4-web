import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli';
import { ExitCode, realpathLoose } from '../../src/context';
import { buildMapResource, type MapSpec, taiwanLikeSpec } from '../helpers/buildMapResource';
import { buildMkf } from '../helpers/buildMkf';
import { buildPe } from '../helpers/buildPe';

let root: string;
let out: string[];
let err: string[];
const logger = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
const run = (...args: string[]) => main([...args, '--root', root], { logger, cwd: root });

function writeOriginal(rel: string, bytes: Uint8Array): void {
  const p = path.join(root, 'original', rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, bytes);
}

function writeSources(v311: MapSpec, opts: { v311Compressed?: boolean } = {}): void {
  const base = buildMapResource(taiwanLikeSpec());
  const filler = { body: Uint8Array.from([1, 2, 3, 4]) };
  writeOriginal('Game/MapDat.MKF', buildMkf([{ body: base }]));
  writeOriginal('Game/map.mkf', buildMkf([filler, { body: base }]));
  const mj = buildMapResource(v311);
  writeOriginal(
    'MultiverseJourney/map.mkf',
    buildMkf([filler, opts.v311Compressed ? { body: mj.subarray(0, 100), rawSize: mj.length } : { body: mj }]),
  );
}

/** 四张图的合成来源：每个 gm 都放同一张台湾样式图（MapDat[gm]、map.mkf[gm*2+1]），三个来源逐字节相同。 */
function writeFourMaps(): void {
  const body = buildMapResource(taiwanLikeSpec());
  const filler = { body: Uint8Array.from([1, 2, 3, 4]) };
  writeOriginal('Game/MapDat.MKF', buildMkf([0, 1, 2, 3].map(() => ({ body }))));
  const mkf = buildMkf([0, 1, 2, 3].flatMap(() => [filler, { body }]));
  writeOriginal('Game/map.mkf', mkf);
  writeOriginal('MultiverseJourney/map.mkf', mkf);
}

/**
 * 四张图，按 gm 给出 MapDat（v206-mapdat、v311-mapmkf 同）与 v206 map.mkf 的合成图：
 * mkf(gm) 返回 null 时三个来源相同，返回改过的图时 v206-mapmkf 与另两个来源不同（map diff 的第二个来源）。
 */
function writeFourMapsDiff(base: (gm: number) => MapSpec, mkf: (gm: number) => MapSpec | null): void {
  const filler = { body: Uint8Array.from([1, 2, 3, 4]) };
  const bodies = [0, 1, 2, 3].map((gm) => buildMapResource(base(gm)));
  const mkfBodies = [0, 1, 2, 3].map((gm) => {
    const m = mkf(gm);
    return m ? buildMapResource(m) : bodies[gm]!;
  });
  writeOriginal('Game/MapDat.MKF', buildMkf(bodies.map((body) => ({ body }))));
  writeOriginal('Game/map.mkf', buildMkf(mkfBodies.flatMap((body) => [filler, { body }])));
  writeOriginal('MultiverseJourney/map.mkf', buildMkf(bodies.flatMap((body) => [filler, { body }])));
}

/** 带第 4 家企业的台湾样式图（大陆的已知差异在 companies#4.name） */
function withFourthCompany(name: string): MapSpec {
  const m = taiwanLikeSpec();
  m.companies!.push({ name, stockIndex: 3, industry: 10, assetValue: 1 });
  return m;
}

beforeEach(() => {
  root = realpathLoose(mkdtempSync(path.join(tmpdir(), 'rich4-extract-cli-')));
  out = [];
  err = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('CLI 退出码（合成文件）', () => {
  it('map raw → map diff：只有表现差异 exit 0，并写入 .cache', async () => {
    const mj = taiwanLikeSpec();
    mj.nodes![4]!.decor = 99;
    mj.companies![1]!.spriteRes = 7;
    writeSources(mj);
    expect(await run('map', 'raw', '--map', '0', '--sources', 'all')).toBe(ExitCode.OK);
    for (const id of ['v206-mapdat', 'v206-mapmkf', 'v311-mapmkf']) {
      const p = path.join(root, '.cache', 'extract', 'raw', id, 'map0.raw.json');
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      expect(raw.source).toMatchObject({ id, compressed: false });
      expect(existsSync(path.join(root, '.cache', 'extract', 'raw', id, 'map0.stats.json'))).toBe(true);
    }
    expect(await run('map', 'diff', '--map', '0')).toBe(ExitCode.OK);
    const diff = JSON.parse(readFileSync(path.join(root, '.cache', 'extract', 'diff', 'map0.json'), 'utf8'));
    expect(diff.counts).toEqual({ presentation: 2, rule: 0 });
    expect(diff.identicalGroups).toEqual([['v206-mapdat', 'v206-mapmkf'], ['v311-mapmkf']]);
  });

  it('规则相关差异 → exit 4', async () => {
    const mj = taiwanLikeSpec();
    mj.lands![3]!.rent = [1, 2, 3, 4, 5, 6];
    writeSources(mj);
    expect(await run('map', 'raw', '--map', '0')).toBe(ExitCode.OK);
    expect(await run('map', 'diff', '--map', '0')).toBe(ExitCode.RULE_DIFF);
    expect(out.join('\n')).toContain('规则相关');
  });

  it('map raw 结果可复现：两次输出字节一致', async () => {
    writeSources(taiwanLikeSpec());
    const p = path.join(root, '.cache', 'extract', 'raw', 'v206-mapdat', 'map0.raw.json');
    await run('map', 'raw', '--map', '0', '--sources', 'v206-mapdat');
    const a = readFileSync(p);
    await run('map', 'raw', '--map', '0', '--sources', 'v206-mapdat');
    expect(readFileSync(p).equals(a)).toBe(true);
  });

  it('结构不变量失败 → exit 1', async () => {
    const bad = taiwanLikeSpec();
    bad.lands![0]!.b19 = 3;
    writeSources(bad);
    expect(await run('map', 'raw', '--map', '0', '--sources', 'v311-mapmkf')).toBe(ExitCode.STRUCTURE);
    expect(out.join('\n')).toContain('lands.runtimeZero');
  });

  it('压缩的地图资源 → COMPRESSED_NOT_SUPPORTED，exit 1', async () => {
    writeSources(taiwanLikeSpec(), { v311Compressed: true });
    expect(await run('map', 'raw', '--map', '0', '--sources', 'all')).toBe(ExitCode.STRUCTURE);
    expect(err.join('\n')).toContain('COMPRESSED_NOT_SUPPORTED');
  });

  it('缺少来源：--sources all exit 2；map diff 缺 raw exit 2', async () => {
    writeOriginal('Game/MapDat.MKF', buildMkf([{ body: buildMapResource(taiwanLikeSpec()) }]));
    expect(await run('map', 'raw', '--map', '0', '--sources', 'all')).toBe(ExitCode.MISSING_INPUT);
    expect(await run('map', 'raw', '--map', '0', '--sources', 'auto')).toBe(ExitCode.OK);
    expect(await run('map', 'diff', '--map', '0')).toBe(ExitCode.MISSING_INPUT);
    expect(await run('map', 'raw')).toBe(ExitCode.MISSING_INPUT);
  });

  it('verify --samples：合成的台湾样图全部通过；改坏后 exit 1', async () => {
    writeSources(taiwanLikeSpec());
    expect(await run('verify', '--samples')).toBe(ExitCode.OK);
    expect(out.join('\n')).toContain('样本全部通过');
    const bad = taiwanLikeSpec();
    bad.companies![2]!.stockIndex = 4;
    writeSources(bad);
    out = [];
    expect(await run('verify', '--samples')).toBe(ExitCode.STRUCTURE);
    expect(out.join('\n')).toContain('❌');
  });

  it('verify --samples --map 1..3：按该图的样本规格；gm 超出 0..3 → 参数错误', async () => {
    writeFourMaps();
    expect(await run('verify', '--samples', '--map', '2')).toBe(ExitCode.STRUCTURE);
    const text = out.join('\n');
    // 日本规格：计数、关押格节点、确切封路边与 bit31 快艇段（合成图当然对不上），街道样本留空只告警
    expect(text).toContain('bit31 禁放物件节点');
    expect(text).toContain('静态封路的边');
    expect(text).toContain('街道价格样本（待原版核对）');
    const saved = JSON.parse(readFileSync(path.join(root, '.cache', 'extract', 'verify', 'samples.map2.json'), 'utf8'));
    expect(saved).toMatchObject({ schema: 'rich4.samples/1', globalMapId: 2 });
    expect(await run('verify', '--samples', '--map', '4')).toBe(ExitCode.STRUCTURE);
    expect(err.join('\n')).toContain('0 taiwan、1 china、2 japan、3 usa');
  });

  it('all：不接受 --map；依次 map raw 0–3 → map diff 0–3 → exe tables，缺 exe 时在这一步停下', async () => {
    expect(await run('all', '--map', '1')).toBe(ExitCode.STRUCTURE);
    expect(err.join('\n')).toContain('不接受 --map');
    writeFourMaps();
    err = [];
    expect(await run('all')).toBe(ExitCode.MISSING_INPUT);
    const steps = out.filter((l) => l.startsWith('── ')).map((l) => l.slice(3));
    expect(steps).toEqual([
      'map raw --map 0 --sources all',
      'map raw --map 1 --sources all',
      'map raw --map 2 --sources all',
      'map raw --map 3 --sources all',
      'map diff --map 0',
      'map diff --map 1',
      'map diff --map 2',
      'map diff --map 3',
      'exe tables',
    ]);
    expect(out.join('\n')).toContain('exe tables：exit 2，停止');
    for (const gm of [0, 1, 2, 3]) {
      expect(existsSync(path.join(root, '.cache', 'extract', 'diff', `map${gm}.json`)), `diff ${gm}`).toBe(true);
    }
    // all 不自动 pack
    expect(existsSync(path.join(root, 'rich4-data'))).toBe(false);
  });

  it('all：map diff exit 4 只放行已知差异（大陆 companies#4.name、日本 lands#17.rent），且 overrides 基线为 v206-mapdat', async () => {
    const base = (gm: number): MapSpec => (gm === 1 ? withFourthCompany('王井府百貨') : taiwanLikeSpec());
    const known = (gm: number): MapSpec | null => {
      if (gm === 1) return withFourthCompany('玉井府百貨');
      if (gm === 2) {
        const m = taiwanLikeSpec();
        m.lands![16]!.rent = [300, 7500, 2000, 4800, 10000, 18000];
        return m;
      }
      return null;
    };
    writeFourMapsDiff(base, known);
    expect(await run('all')).toBe(ExitCode.MISSING_INPUT);
    const text = out.join('\n');
    // 已知差异放行，一直走到 exe tables（缺 exe → exit 2）
    expect(out.filter((l) => l.startsWith('── ')).at(-1)).toBe('── exe tables');
    expect(text).toContain('china 的规则差异 companies#4.name 是已知差异');
    expect(text).toContain('japan 的规则差异 lands#17.rent 是已知差异');
  });

  it('all：已知清单之外的规则差异（美国、台湾，或大陆多出一处）→ 在 map diff 停下，exit 4', async () => {
    // 美国 lands#17.rent：日本的已知差异出现在美国，不放行
    const usa = (gm: number): MapSpec | null => {
      if (gm !== 3) return null;
      const m = taiwanLikeSpec();
      m.lands![16]!.rent = [300, 7500, 2000, 4800, 10000, 18000];
      return m;
    };
    writeFourMapsDiff(() => taiwanLikeSpec(), usa);
    expect(await run('all')).toBe(ExitCode.RULE_DIFF);
    expect(out.filter((l) => l.startsWith('── ')).at(-1)).toBe('── map diff --map 3');
    expect(out.join('\n')).toContain('usa：已知清单之外的规则差异 lands#17.rent');
    expect(out.join('\n')).toContain('map diff --map 3：exit 4，停止');

    // 大陆：已知的 companies#4.name 之外还多出 lands#3.rent
    rmSync(path.join(root, '.cache'), { recursive: true, force: true });
    out = [];
    const china = (gm: number): MapSpec | null => {
      if (gm !== 1) return null;
      const m = withFourthCompany('玉井府百貨');
      m.lands![2]!.rent = [1, 2, 3, 4, 5, 6];
      return m;
    };
    writeFourMapsDiff((gm) => (gm === 1 ? withFourthCompany('王井府百貨') : taiwanLikeSpec()), china);
    expect(await run('all')).toBe(ExitCode.RULE_DIFF);
    expect(out.filter((l) => l.startsWith('── ')).at(-1)).toBe('── map diff --map 1');
    expect(out.join('\n')).toContain('china：已知清单之外的规则差异 lands#3.rent');

    // 台湾：任何规则差异都不放行
    rmSync(path.join(root, '.cache'), { recursive: true, force: true });
    out = [];
    writeFourMapsDiff(
      () => taiwanLikeSpec(),
      (gm) => {
        if (gm !== 0) return null;
        const m = taiwanLikeSpec();
        m.lands![3]!.rent = [1, 2, 3, 4, 5, 6];
        return m;
      },
    );
    expect(await run('all')).toBe(ExitCode.RULE_DIFF);
    expect(out.filter((l) => l.startsWith('── ')).at(-1)).toBe('── map diff --map 0');
    expect(out.join('\n')).toContain('taiwan：gm 0 没有已知规则差异清单');
  });

  it('all：map raw 失败即停（缺来源 → exit 2），退出码取最大值', async () => {
    writeOriginal('Game/MapDat.MKF', buildMkf([{ body: buildMapResource(taiwanLikeSpec()) }]));
    expect(await run('all')).toBe(ExitCode.MISSING_INPUT);
    expect(out.filter((l) => l.startsWith('── '))).toEqual(['── map raw --map 0 --sources all']);
  });

  it('mkf ls', async () => {
    writeSources(taiwanLikeSpec());
    expect(await run('mkf', 'ls', '--file', 'original/Game/map.mkf')).toBe(ExitCode.OK);
    expect(out.join('\n')).toContain('资源数=2');
    expect(await run('mkf', 'ls', '--file', 'original/nope.mkf')).toBe(ExitCode.MISSING_INPUT);
    writeOriginal('Game/bad.mkf', Uint8Array.from([0xff, 0, 0, 0, 0, 0, 0, 0]));
    expect(await run('mkf', 'ls', '--file', 'original/Game/bad.mkf')).toBe(ExitCode.STRUCTURE);
  });

  it('fingerprint：未知哈希 exit 3，--allow-unknown 放行并写基线', async () => {
    writeSources(taiwanLikeSpec());
    const pe = buildPe([{ name: 'AUTO', virtualAddress: 0x1000, virtualSize: 0, rawSize: 0x200, rawPointer: 0x400 }]);
    writeOriginal('Game/RICH4.EXE', pe);
    writeOriginal('MultiverseJourney/RICH4.EXE', pe);
    const lock = path.join(root, 'lock.json');
    expect(await run('fingerprint', '--lock', lock)).toBe(ExitCode.UNKNOWN_FINGERPRINT);
    expect(existsSync(lock)).toBe(false);
    expect(await run('fingerprint', '--lock', lock, '--allow-unknown')).toBe(ExitCode.OK);
    const l = JSON.parse(readFileSync(lock, 'utf8'));
    expect(Object.keys(l.files)).toEqual([
      'Game/MapDat.MKF',
      'Game/RICH4.EXE',
      'Game/map.mkf',
      'MultiverseJourney/RICH4.EXE',
      'MultiverseJourney/map.mkf',
    ]);
    expect(existsSync(path.join(root, '.cache', 'extract', 'manifest.json'))).toBe(true);
  });

  it('只读守卫：--cache 指到 original/ 下时拒绝写入且不产生文件', async () => {
    writeSources(taiwanLikeSpec());
    const before = readdirSync(path.join(root, 'original'));
    expect(await run('map', 'raw', '--map', '0', '--sources', 'v206-mapdat', '--cache', 'original/cache')).toBe(
      ExitCode.STRUCTURE,
    );
    expect(err.join('\n')).toContain('E_READONLY_SOURCE');
    expect(readdirSync(path.join(root, 'original'))).toEqual(before);
  });

  it('未知命令与参数错误', async () => {
    expect(await run('bogus')).toBe(ExitCode.STRUCTURE);
    expect(await main(['map', 'raw', '--nope'], { logger })).toBe(ExitCode.STRUCTURE);
    // verify 不带参数 = --samples 与 --tables 都跑；空目录下缺少输入
    expect(await run('verify')).toBe(ExitCode.MISSING_INPUT);
    expect(await run('--help')).toBe(ExitCode.OK);
  });
});
