/**
 * 原版皮肤 A2：fixture 地图的合成素材包（CI 覆盖原版渲染路径；审查修正 6）与 assets CLI（synth / verify / ls）。
 * 合成包不含任何原版字节；输出到临时目录（不入库）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkMapSkinBinding, mapSkinBindingOf, parseMapSkin, parsePackManifest } from '@rich4/shared/assets';
import { buildFixtureMaps } from '@rich4/shared/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogV206 } from '../../src/assets/catalog.v206';
import { buildSyntheticPack, synthGnd } from '../../src/assets/synthetic';
import { main } from '../../src/cli';
import { ExitCode, ExtractContext, realpathLoose } from '../../src/context';
import { parseGnd } from '../../src/gfx/gnd';
import { isDerivedPng } from '../../src/gfx/png';

let root: string;
let out: string[];
const logger = { out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
const run = (...args: string[]) => main([...args, '--root', root], { logger, cwd: root });

beforeAll(() => {
  root = realpathLoose(mkdtempSync(path.join(tmpdir(), 'rich4-synth-')));
  out = [];
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('合成素材包', () => {
  it('assets synth → exit 0；两张 fixture 地图的皮肤绑定 fixture 身份，棋盘类条目与原版包同键', async () => {
    const dir = path.join(root, '.cache', 'synthetic-pack');
    expect(await run('assets', 'synth', '--out', dir)).toBe(ExitCode.OK);
    const m = parsePackManifest(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
    expect(m.generator).toBe('rich4-extract/synthetic@1');
    expect(m.source).toEqual({ files: {}, exeSha256: null });
    expect(m.features.board).toBe(true);
    for (const def of buildFixtureMaps()) {
      const mp = m.maps[def.id]!;
      expect(mp.binding).toEqual(mapSkinBindingOf(def));
      const skin = parseMapSkin(JSON.parse(readFileSync(path.join(dir, m.files[mp.skin]!.path), 'utf8')));
      expect(checkMapSkinBinding(skin, def)).toEqual([]);
      expect(skin.world).toEqual({ w: def.grid.w * 32, h: def.grid.h * 32 });
      expect(skin.ground.chunks).toHaveLength(4);
    }
    const boardKeys = catalogV206()
      .items.filter((it) => it.type === 'sprite' && it.token === 'board' && !it.group.startsWith('map.'))
      .map((it) => it.key);
    for (const k of boardKeys) expect(m.entries[k]?.type, k).toBe('sprite');
    const walk = m.entries['char.0.walk']!;
    expect(walk.type === 'sprite' && [walk.frames.count, walk.dirs]).toEqual([72, 8]);
    for (const g of Object.values(m.groups)) expect(g.provenance).toBe('synthetic');
    // 合成内容不是原版派生：PNG 不写派生标记
    const png = Object.values(m.files).find((f) => f.contentType === 'image/png')!;
    expect(isDerivedPng(new Uint8Array(readFileSync(path.join(dir, png.path))))).toBe(false);
  }, 60_000);

  it('assets verify --full 通过；assets ls 能列出分组内的构建结果', async () => {
    const dir = path.join(root, '.cache', 'synthetic-pack');
    out = [];
    expect(await run('assets', 'verify', '--out', dir, '--full')).toBe(ExitCode.OK);
    expect(out.some((l) => l.includes('0 处不符'))).toBe(true);
    out = [];
    expect(await run('assets', 'ls', '--out', dir, '--group', 'char.0', '--json')).toBe(ExitCode.OK);
    const rows = JSON.parse(out.join('\n')) as { key: string; built: boolean }[];
    const sprites = rows.filter((r) => r.key.startsWith('char.0.') && !/emote|parachute/.test(r.key));
    expect(sprites).toHaveLength(21);
    expect(sprites.every((r) => r.built)).toBe(true);
  }, 60_000);

  it('确定性：同输入两次生成的 manifest 字节相同', async () => {
    const ctx = new ExtractContext({ root, logger: { out: () => {}, err: () => {} } });
    const a = await buildSyntheticPack({ ctx, outDir: path.join(root, '.cache', 'synth-a') });
    const b = await buildSyntheticPack({ ctx, outDir: path.join(root, '.cache', 'synth-b') });
    expect(a.manifestSha256).toBe(b.manifestSha256);
  }, 60_000);

  it('合成 GND 与原版格式相同（头、恒等排布、2304 以外的任意尺寸）', () => {
    for (const def of buildFixtureMaps()) {
      const g = parseGnd(synthGnd(def), def.id);
      expect([g.cols, g.rows, g.identityLayout]).toEqual([def.grid.w, def.grid.h, true]);
    }
  });

  it('输出目录不在 rich4-assets/ 或 .cache/ 下时拒绝（git 不可用时只放行这两处）', async () => {
    out = [];
    expect(await run('assets', 'synth', '--out', path.join(root, 'src', 'pack'))).toBe(ExitCode.STRUCTURE);
    expect(out.join('\n')).toMatch(/E_ASSETS_OUT_NOT_IGNORED/);
  });
});
