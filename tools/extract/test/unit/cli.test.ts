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
