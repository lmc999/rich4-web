import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseMapDef, validateMap, verifyMapDataHash } from '@rich4/shared/data';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli';
import { ExitCode, realpathLoose } from '../../src/context';
import { buildSynthExe } from '../helpers/buildExe';
import { buildMapResource, type MapSpec } from '../helpers/buildMapResource';
import { buildMkf } from '../helpers/buildMkf';
import { laidOutTaiwanLike } from '../helpers/syntheticMap';

let root: string;
let out: string[];
let err: string[];
const logger = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
const run = (...args: string[]) => main([...args, '--root', root], { logger, cwd: root });
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const at = (...p: string[]) => path.join(root, ...p);

function writeOriginal(spec: MapSpec): void {
  const body = buildMapResource(spec);
  const filler = { body: Uint8Array.from([1, 2, 3, 4]) };
  const put = (rel: string, bytes: Uint8Array) => {
    mkdirSync(path.dirname(at('original', rel)), { recursive: true });
    writeFileSync(at('original', rel), bytes);
  };
  put('Game/MapDat.MKF', buildMkf([{ body }]));
  put('Game/map.mkf', buildMkf([filler, { body }]));
  put('MultiverseJourney/map.mkf', buildMkf([filler, { body }]));
}

/** 多张图：MapDat[gm] 与 map.mkf[gm*2+1] 都放同一张合成图 */
function writeOriginalMaps(spec: MapSpec, maps: number): void {
  const body = buildMapResource(spec);
  const filler = { body: Uint8Array.from([1, 2, 3, 4]) };
  const put = (rel: string, bytes: Uint8Array) => {
    mkdirSync(path.dirname(at('original', rel)), { recursive: true });
    writeFileSync(at('original', rel), bytes);
  };
  const gms = Array.from({ length: maps }, (_, i) => i);
  put('Game/MapDat.MKF', buildMkf(gms.map(() => ({ body }))));
  const mkf = buildMkf(gms.flatMap(() => [filler, { body }]));
  put('Game/map.mkf', mkf);
  put('MultiverseJourney/map.mkf', mkf);
}

function writeOverrides(extra: Record<string, unknown> = {}): string {
  const p = at('ov', 'taiwan.overrides.json');
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(
    p,
    JSON.stringify({
      mapKey: 'taiwan',
      source: { id: 'v206-mapdat' },
      expect: { nodes: 103, lands: 50, facilities: 4, companies: 3, landscapes: 21 },
      ...extra,
    }),
  );
  return p;
}

beforeEach(() => {
  root = realpathLoose(mkdtempSync(path.join(tmpdir(), 'rich4-extract-build-')));
  out = [];
  err = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('CLI map build / pack（合成台湾样式地图）', () => {
  it('map build → exit 0；写 MapDef、build/semantic 报告、预览、provenance；两次输出字节一致', async () => {
    writeOriginal(laidOutTaiwanLike(5));
    const ov = writeOverrides();
    expect(await run('map', 'build', '--map', 'taiwan', '--overrides', ov, '--strict4', '--preview')).toBe(ExitCode.OK);
    const files = [
      at('.cache', 'extract', 'maps', 'taiwan.map.json'),
      at('.cache', 'extract', 'maps', 'taiwan.build.json'),
      at('.cache', 'extract', 'maps', 'taiwan.semantic.json'),
      at('.cache', 'extract', 'preview', 'taiwan.svg'),
      at('docs', 'research', 'provenance-summary.md'),
    ];
    for (const f of files) expect(existsSync(f), f).toBe(true);
    const def = parseMapDef(JSON.parse(readFileSync(files[0]!, 'utf8')));
    expect(verifyMapDataHash(def)).toBe(true);
    expect(def.meta.counts).toEqual({ nodes: 103, lands: 50, facilities: 4, companies: 3, landscapes: 21 });
    const v = validateMap(def, { strict4: true });
    const errors = v.issues.filter((i) => i.severity === 'error');
    expect(errors.map((i) => i.path).sort()).toEqual([
      'companies[0].stockIndex',
      'companies[1].stockIndex',
      'companies[2].stockIndex',
    ]);
    expect(def.tiles.flatMap((t) => t.links).filter((l) => l.blocked)).toHaveLength(2);
    const prov = readFileSync(files[4]!, 'utf8');
    expect(prov).toContain('几何归一化统计');
    expect(prov).toContain('没有 exe 表');
    expect(prov).not.toMatch(/"hex"/);
    expect(readFileSync(files[3]!, 'utf8')).toMatch(/^<svg /);

    const before = files.map(sha);
    expect(await run('map', 'build', '--map', 'taiwan', '--overrides', ov, '--strict4', '--preview')).toBe(ExitCode.OK);
    expect(files.map(sha)).toEqual(before);
    expect(out.join('\n')).toContain('结果：exit 0');
  });

  it('pack → manifest 含 mapHash 与文件 sha256，地图文件与 build 输出逐字节相同', async () => {
    writeOriginal(laidOutTaiwanLike());
    const ov = writeOverrides();
    expect(await run('pack', '--out', 'rich4-data')).toBe(ExitCode.MISSING_INPUT);
    expect(await run('map', 'build', '--map', 'taiwan', '--overrides', ov)).toBe(ExitCode.OK);
    expect(await run('pack', '--out', 'rich4-data')).toBe(ExitCode.OK);
    const packed = at('rich4-data', 'maps', 'taiwan.map.json');
    expect(sha(packed)).toBe(sha(at('.cache', 'extract', 'maps', 'taiwan.map.json')));
    const manifest = JSON.parse(readFileSync(at('rich4-data', 'manifest.json'), 'utf8'));
    const def = JSON.parse(readFileSync(packed, 'utf8'));
    expect(manifest).toMatchObject({ schema: 'rich4.data-manifest/1' });
    expect(manifest.maps[0]).toMatchObject({
      id: 'taiwan',
      file: 'maps/taiwan.map.json',
      mapHash: def.meta.dataHash,
      sha256: sha(packed),
      pending: ['stocks', 'holidays'],
      validation: { ok: false, issues: { pending: 3 } },
    });
  });

  it('有 exe 时股票与节日来自 exe 表：pending 清空、validateMap ok、两版一致', async () => {
    const spec = laidOutTaiwanLike();
    // 合成企业 C2 引用股票 2：名称与合成 exe 的股票 2 对齐，企业↔股票核对为 OK
    spec.companies![1]!.name = '大宇百貨';
    writeOriginal(spec);
    const put = (rel: string, bytes: Uint8Array) => {
      mkdirSync(path.dirname(at('original', rel)), { recursive: true });
      writeFileSync(at('original', rel), bytes);
    };
    put('Game/RICH4.EXE', buildSynthExe({ maps: 1, dataShift: 0x40 }).bytes);
    put('MultiverseJourney/RICH4.EXE', buildSynthExe({ maps: 2 }).bytes);
    const ov = writeOverrides();
    expect(await run('map', 'build', '--map', 'taiwan', '--overrides', ov, '--strict4')).toBe(ExitCode.OK);
    const def = parseMapDef(JSON.parse(readFileSync(at('.cache', 'extract', 'maps', 'taiwan.map.json'), 'utf8')));
    expect(def.stocks).toHaveLength(12);
    expect(def.strings['zh-TW'][def.stocks[3]!.nameKey]).toBe('台積電');
    expect(def.strings['zh-CN'][def.stocks[3]!.nameKey]).toBe('台积电');
    expect(def.holidays).toHaveLength(23);
    const v = validateMap(def, { strict4: true });
    expect(v.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const text = out.join('\n');
    expect(text).toContain('股票 12 支、节日 23 条（停用槽 12 不输出）；两版该图数据一致');
    expect(text).not.toContain('❌ 企业↔股票');
    const prov = readFileSync(at('docs', 'research', 'provenance-summary.md'), 'utf8');
    expect(prov).toContain('## 3. exe 表');
    expect(prov).toContain('待对照');
    expect(await run('pack', '--out', 'rich4-data')).toBe(ExitCode.OK);
    const manifest = JSON.parse(readFileSync(at('rich4-data', 'manifest.json'), 'utf8'));
    expect(manifest.maps[0]).toMatchObject({ pending: [], validation: { ok: true } });
  });

  it('企业↔股票名称不一致（不在白名单）→ BAD，exit 1；pack 不打这张图', async () => {
    writeOriginal(laidOutTaiwanLike());
    const put = (rel: string, bytes: Uint8Array) => {
      mkdirSync(path.dirname(at('original', rel)), { recursive: true });
      writeFileSync(at('original', rel), bytes);
    };
    put('Game/RICH4.EXE', buildSynthExe({ maps: 1, dataShift: 0x40 }).bytes);
    const ov = writeOverrides();
    expect(await run('map', 'build', '--map', 'taiwan', '--overrides', ov, '--strict4')).toBe(ExitCode.STRUCTURE);
    expect(out.join('\n')).toContain('❌ 企业↔股票 「測試百貨」→ 股票 2「大宇百貨」');
    const report = JSON.parse(readFileSync(at('.cache', 'extract', 'maps', 'taiwan.build.json'), 'utf8'));
    expect(report).toMatchObject({ exitCode: 0, exit: 1 });
    expect(report.companyStocks.map((c: { status: string }) => c.status)).toEqual(['OK', 'BAD', 'OK', 'OK']);
    expect(await run('pack', '--out', 'rich4-data')).toBe(ExitCode.MISSING_INPUT);
    expect(out.join('\n')).toContain('跳过 taiwan：最近一次 map build 为 exit 1');
    expect(await run('pack', '--out', 'rich4-data', '--map', 'taiwan')).toBe(ExitCode.STRUCTURE);
    expect(err.join('\n')).toContain('E_PACK_BUILD');
    expect(existsSync(at('rich4-data', 'manifest.json'))).toBe(false);
  });

  it('多张图：pack 不带 --map 只打 exit 0 的图；新图的 provenance 写到 provenance-<key>.md', async () => {
    writeOriginalMaps(laidOutTaiwanLike(), 2);
    const ov = writeOverrides();
    const ovChina = at('ov', 'china.overrides.json');
    writeFileSync(ovChina, JSON.stringify({ mapKey: 'china', source: { id: 'v206-mapdat' } }));
    expect(await run('map', 'build', '--map', 'taiwan', '--overrides', ov)).toBe(ExitCode.OK);
    // 大陆的样本规格（计数 144/73/8/4/26 等）对合成图不成立 → exit 1，但 MapDef 与 provenance 照常写出
    expect(await run('map', 'build', '--map', '1', '--overrides', ovChina, '--preview')).toBe(ExitCode.STRUCTURE);
    expect(existsSync(at('.cache', 'extract', 'maps', 'china.map.json'))).toBe(true);
    expect(existsSync(at('.cache', 'extract', 'preview', 'china.svg'))).toBe(true);
    const prov = readFileSync(at('docs', 'research', 'provenance-china.md'), 'utf8');
    expect(prov).toContain('# 原版数据提取 provenance 摘要（china）');
    expect(prov).toContain('npm run extract -- map build --map china --strict4 --preview');
    expect(prov).toContain('| china.map.json sha256 |');
    expect(prov).toContain('.cache/extract/preview/china.svg');
    expect(prov).toContain('街道价格样本（待原版核对）');
    expect(readFileSync(at('docs', 'research', 'provenance-summary.md'), 'utf8')).toContain(
      '| taiwan.map.json sha256 |',
    );
    out = [];
    expect(await run('pack', '--out', 'rich4-data')).toBe(ExitCode.OK);
    expect(out.join('\n')).toContain('跳过 china：最近一次 map build 为 exit 1');
    const manifest = JSON.parse(readFileSync(at('rich4-data', 'manifest.json'), 'utf8'));
    expect(manifest.maps.map((m: { id: string }) => m.id)).toEqual(['taiwan']);
    expect(existsSync(at('rich4-data', 'maps', 'china.map.json'))).toBe(false);
    // 显式指定时不跳过：china 的报告不是 exit 0 → 报错；japan 根本没构建 → 缺少输入
    expect(await run('pack', '--out', 'rich4-data', '--map', 'china')).toBe(ExitCode.STRUCTURE);
    expect(err.join('\n')).toContain('E_PACK_BUILD: china：最近一次 map build 为 exit 1');
    expect(await run('pack', '--out', 'rich4-data', '--map', 'all')).toBe(ExitCode.STRUCTURE);
    expect(await run('pack', '--out', 'rich4-data', '--map', 'japan')).toBe(ExitCode.MISSING_INPUT);
  });

  it('pack 与已有 manifest 合并：--map 只替换指定的图，其余图原样保留；--replace 才整份重写', async () => {
    writeOriginalMaps(laidOutTaiwanLike(), 2);
    const ov = writeOverrides();
    const ovChina = at('ov', 'china.overrides.json');
    writeFileSync(ovChina, JSON.stringify({ mapKey: 'china', source: { id: 'v206-mapdat' } }));
    expect(await run('map', 'build', '--map', 'taiwan', '--overrides', ov)).toBe(ExitCode.OK);
    expect(await run('map', 'build', '--map', 'china', '--overrides', ovChina)).toBe(ExitCode.STRUCTURE);
    // 合成图对不上大陆的样本规格：把大陆的构建报告当作 exit 0（模拟两张图都已构建好）
    const chinaReport = at('.cache', 'extract', 'maps', 'china.build.json');
    writeFileSync(chinaReport, JSON.stringify({ ...JSON.parse(readFileSync(chinaReport, 'utf8')), exit: 0 }));
    expect(await run('pack', '--out', 'rich4-data')).toBe(ExitCode.OK);
    const manifestPath = at('rich4-data', 'manifest.json');
    const ids = () => JSON.parse(readFileSync(manifestPath, 'utf8')).maps.map((m: { id: string }) => m.id);
    expect(ids()).toEqual(['china', 'taiwan']);
    const full = sha(manifestPath);
    const taiwanFile = at('rich4-data', 'maps', 'taiwan.map.json');
    const taiwanSha = sha(taiwanFile);

    // 只重打大陆：台湾的条目与文件原样保留，manifest 与整包打出来的逐字节相同
    out = [];
    expect(await run('pack', '--out', 'rich4-data', '--map', 'china')).toBe(ExitCode.OK);
    expect(ids()).toEqual(['china', 'taiwan']);
    expect(sha(manifestPath)).toBe(full);
    expect(sha(taiwanFile)).toBe(taiwanSha);
    expect(out.join('\n')).toContain('taiwan  保留');

    // 保留的图，地图文件被改过 / 不见了：报错，manifest 不动
    writeFileSync(taiwanFile, '{}');
    err = [];
    expect(await run('pack', '--out', 'rich4-data', '--map', 'china')).toBe(ExitCode.STRUCTURE);
    expect(err.join('\n')).toContain('E_PACK_MERGE');
    expect(err.join('\n')).toContain('taiwan');
    expect(sha(manifestPath)).toBe(full);
    rmSync(taiwanFile);
    expect(await run('pack', '--out', 'rich4-data', '--map', 'china')).toBe(ExitCode.STRUCTURE);
    expect(sha(manifestPath)).toBe(full);

    // --replace：manifest 只剩本次的图
    expect(await run('pack', '--out', 'rich4-data', '--map', 'china', '--replace')).toBe(ExitCode.OK);
    expect(ids()).toEqual(['china']);
    expect(out.join('\n')).toContain('--replace：manifest 去掉 taiwan');

    // manifest 读不懂：不合并、报错；--replace 照样重写
    writeFileSync(manifestPath, '{"schema":"x"}');
    err = [];
    expect(await run('pack', '--out', 'rich4-data', '--map', 'taiwan')).toBe(ExitCode.STRUCTURE);
    expect(err.join('\n')).toContain('E_PACK_MERGE');
    expect(await run('pack', '--out', 'rich4-data', '--map', 'taiwan', '--replace')).toBe(ExitCode.OK);
    expect(ids()).toEqual(['taiwan']);
  });

  it('pack 不带 --map：要跳过的图已在 manifest 里 → E_PACK_DROP，manifest 与地图文件都不动；--replace 才允许去掉', async () => {
    writeOriginalMaps(laidOutTaiwanLike(), 2);
    const ov = writeOverrides();
    const ovChina = at('ov', 'china.overrides.json');
    writeFileSync(ovChina, JSON.stringify({ mapKey: 'china', source: { id: 'v206-mapdat' } }));
    expect(await run('map', 'build', '--map', 'taiwan', '--overrides', ov)).toBe(ExitCode.OK);
    expect(await run('map', 'build', '--map', 'china', '--overrides', ovChina)).toBe(ExitCode.STRUCTURE);
    const chinaReport = at('.cache', 'extract', 'maps', 'china.build.json');
    const okReport = JSON.stringify({ ...JSON.parse(readFileSync(chinaReport, 'utf8')), exit: 0 });
    writeFileSync(chinaReport, okReport);
    expect(await run('pack', '--out', 'rich4-data')).toBe(ExitCode.OK);
    const manifestPath = at('rich4-data', 'manifest.json');
    const full = sha(manifestPath);
    const taiwanSha = sha(at('rich4-data', 'maps', 'taiwan.map.json'));

    // 台湾最近一次 build 失败（真实 overrides 的 expectResourceSha256 与合成数据不符 → exit 5）
    expect(await run('map', 'build', '--map', 'taiwan')).toBe(ExitCode.OVERRIDE);
    out = [];
    err = [];
    expect(await run('pack', '--out', 'rich4-data')).toBe(ExitCode.STRUCTURE);
    expect(err.join('\n')).toContain('E_PACK_DROP');
    expect(err.join('\n')).toContain('taiwan（最近一次 map build 为 exit 5）');
    expect(sha(manifestPath)).toBe(full);
    expect(sha(at('rich4-data', 'maps', 'taiwan.map.json'))).toBe(taiwanSha);
    // 只更新其他图：--map china 与已有 manifest 合并，台湾保留
    expect(await run('pack', '--out', 'rich4-data', '--map', 'china')).toBe(ExitCode.OK);
    expect(sha(manifestPath)).toBe(full);
    // 构建产物整个不见了（换了一台机器 / 清了 .cache）同样不能悄悄去掉
    rmSync(at('.cache', 'extract', 'maps', 'taiwan.map.json'));
    err = [];
    expect(await run('pack', '--out', 'rich4-data')).toBe(ExitCode.STRUCTURE);
    expect(err.join('\n')).toContain('E_PACK_DROP');
    expect(sha(manifestPath)).toBe(full);
    // 确实要去掉：--replace
    out = [];
    expect(await run('pack', '--out', 'rich4-data', '--replace')).toBe(ExitCode.OK);
    expect(out.join('\n')).toContain('跳过 taiwan');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.maps.map((m: { id: string }) => m.id)).toEqual(['china']);
  });

  it('--map all：逐图构建，一张出错不影响其余；不能同时给 --overrides', async () => {
    writeOriginalMaps(laidOutTaiwanLike(), 4);
    expect(await run('map', 'build', '--map', 'all', '--overrides', 'x.json')).toBe(ExitCode.STRUCTURE);
    expect(err.join('\n')).toContain('不能指定 --overrides');
    // 真实 overrides 的 expectResourceSha256 与合成数据不符：四张图各自 exit 5
    expect(await run('map', 'build', '--map', 'all')).toBe(ExitCode.OVERRIDE);
    expect(out.filter((l) => l.startsWith('── map build')).length).toBe(4);
    expect(out.join('\n')).toContain('全部地图：taiwan ❌ exit 5  china ❌ exit 5  japan ❌ exit 5  usa ❌ exit 5');
  });

  it('默认（真实）overrides 的 expectResourceSha256 与合成数据不符 → exit 5；失败也写进构建报告，pack 不再打上一次的图', async () => {
    writeOriginal(laidOutTaiwanLike());
    expect(await run('map', 'build', '--map', 'taiwan', '--overrides', writeOverrides())).toBe(ExitCode.OK);
    expect(await run('map', 'build', '--map', 'taiwan')).toBe(ExitCode.OVERRIDE);
    expect(err.join('\n')).toContain('expectResourceSha256');
    const report = JSON.parse(readFileSync(at('.cache', 'extract', 'maps', 'taiwan.build.json'), 'utf8'));
    expect(report).toMatchObject({ mapKey: 'taiwan', exit: ExitCode.OVERRIDE });
    expect(report.error).toContain('E_OVERRIDE');
    // 上一次成功构建留下的 taiwan.map.json 仍在，但最近一次 build 失败 → 不打包
    expect(existsSync(at('.cache', 'extract', 'maps', 'taiwan.map.json'))).toBe(true);
    expect(await run('pack', '--out', 'rich4-data')).toBe(ExitCode.MISSING_INPUT);
    expect(out.join('\n')).toContain('跳过 taiwan：最近一次 map build 为 exit 5');
  });

  it('样本失败 → exit 1；没有 original/ 时退回 .cache 的 raw', async () => {
    const spec = laidOutTaiwanLike();
    spec.lands![0]!.landPrice = 1234;
    writeOriginal(spec);
    const ov = writeOverrides();
    expect(await run('map', 'build', '--map', 'taiwan', '--overrides', ov)).toBe(ExitCode.STRUCTURE);

    writeOriginal(laidOutTaiwanLike());
    expect(await run('map', 'raw', '--map', '0', '--sources', 'all')).toBe(ExitCode.OK);
    rmSync(at('original'), { recursive: true, force: true });
    out = [];
    expect(await run('map', 'build', '--map', 'taiwan', '--overrides', ov)).toBe(ExitCode.OK);
    expect(out.join('\n')).toContain('使用缓存的 raw');
  });

  it('未知地图键 / 缺少 --map → 参数错误', async () => {
    expect(await run('map', 'build', '--map', 'mars')).toBe(ExitCode.STRUCTURE);
    expect(err.join('\n')).toContain('taiwan(0), china(1), japan(2), usa(3)');
    expect(await run('map', 'build', '--map', '4')).toBe(ExitCode.STRUCTURE);
    expect(await run('map', 'build')).toBe(ExitCode.MISSING_INPUT);
    expect(await run('pack', '--map', 'mars')).toBe(ExitCode.STRUCTURE);
  });
});
