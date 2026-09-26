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
    writeOriginal(laidOutTaiwanLike());
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
    const prov = readFileSync(at('docs', 'research', 'provenance-summary.md'), 'utf8');
    expect(prov).toContain('## 3. exe 表');
    expect(prov).toContain('待对照');
    expect(await run('pack', '--out', 'rich4-data')).toBe(ExitCode.OK);
    const manifest = JSON.parse(readFileSync(at('rich4-data', 'manifest.json'), 'utf8'));
    expect(manifest.maps[0]).toMatchObject({ pending: [], validation: { ok: true } });
  });

  it('默认（真实）overrides 的 expectResourceSha256 与合成数据不符 → exit 5', async () => {
    writeOriginal(laidOutTaiwanLike());
    expect(await run('map', 'build', '--map', 'taiwan')).toBe(ExitCode.OVERRIDE);
    expect(err.join('\n')).toContain('expectResourceSha256');
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
    expect(await run('map', 'build')).toBe(ExitCode.MISSING_INPUT);
  });
});
