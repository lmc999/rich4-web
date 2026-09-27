// 素材包注册表：只认合法 manifest、白名单、quick/full 校验、任何不符都整体不启用
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { packServablePaths } from '@rich4/shared/assets';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPackRegistry } from '../../src/assets/PackRegistry';
import { silentLogger } from '../../src/infra/logger';
import { type TestPack, writeTestPack } from '../helpers/testPack';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'rich4-pack-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const load = (dir: string | null, verify: 'quick' | 'full' = 'quick') =>
  loadPackRegistry({ dir, verify, log: silentLogger });

describe('PackRegistry', () => {
  it('合法素材包：启用，白名单正好是 packServablePaths，manifest 带 br/gzip 与 ETag=packId', async () => {
    const p: TestPack = writeTestPack(tmp());
    const r = await load(p.dir, 'full');
    expect(r).toMatchObject({ enabled: true, packId: p.manifest.packId, reason: null });
    const served = packServablePaths(p.manifest);
    expect(served.length).toBe(p.contents.size);
    for (const path of served) expect(r.lookup(path)?.path).toBe(path);
    expect(r.stats.files).toBe(served.length);
    expect(r.manifest!.raw.equals(p.manifestRaw)).toBe(true);
    expect(r.manifest!.etag).toBe(`"${p.manifest.packId}"`);
    expect(gunzipSync(r.manifest!.gzip).equals(p.manifestRaw)).toBe(true);
    expect(r.manifest!.br.length).toBeLessThan(p.manifestRaw.length);

    const json = r.lookup(p.pathOf('data/voice-map.json'))!;
    expect(json).toMatchObject({ contentType: 'application/json; charset=utf-8', kind: 'data' });
    expect(Object.keys(json.variants).sort()).toEqual(['br', 'gzip']);
    expect(r.lookup(p.pathOf('audio/sfx/090.opus'))).toMatchObject({ contentType: 'audio/ogg', variants: {} });
    expect(r.lookup(`${p.pathOf('flic/data/482.flc')}.br`)).toMatchObject({ contentType: 'application/octet-stream' });
  });

  it('白名单之外（逻辑路径、杂散文件、manifest 本身、穿越）一律查不到', async () => {
    const p = writeTestPack(tmp());
    const r = await load(p.dir);
    for (const path of [
      'audio/sfx/090.opus',
      '.rich4-extract.json',
      'manifest.json',
      `../${p.pathOf('audio/sfx/090.opus')}`,
      `audio/sfx/../sfx/${p.pathOf('audio/sfx/090.opus').split('/').pop()}`,
      '/etc/passwd',
      '__proto__',
      '',
    ]) {
      expect(r.lookup(path)).toBeNull();
    }
  });

  it('未配置、目录不存在、没有 manifest、不是 JSON、契约不符：都不启用', async () => {
    expect(await load(null)).toMatchObject({ enabled: false, reason: 'RICH4_ASSETS_DIR 未设置' });
    expect(await load(join(tmp(), 'nope'))).toMatchObject({ enabled: false, reason: '目录不存在' });
    expect(await load(tmp())).toMatchObject({ enabled: false, reason: '没有可读的 manifest.json' });
    const bad = tmp();
    writeFileSync(join(bad, 'manifest.json'), '<!doctype html>');
    expect(await load(bad)).toMatchObject({ enabled: false, reason: 'manifest.json 不是合法 JSON' });
    const p = writeTestPack(tmp());
    const m = JSON.parse(p.manifestRaw.toString('utf8')) as { packId: string };
    m.packId = '0000000000000000';
    writeFileSync(join(p.dir, 'manifest.json'), JSON.stringify(m));
    expect(await load(p.dir)).toMatchObject({ enabled: false, reason: 'manifest.json 未通过契约校验' });
  });

  it('文件缺失、字节数不符、包外符号链接：quick 就能发现；内容被改但长度不变只有 full 能发现', async () => {
    const a = writeTestPack(tmp());
    unlinkSync(join(a.dir, a.pathOf('images/data/530.png')));
    expect(await load(a.dir)).toMatchObject({ enabled: false, reason: '1 个文件与 manifest 不符' });

    const b = writeTestPack(tmp());
    writeFileSync(join(b.dir, b.pathOf('masks/panel/8.png')), 'short');
    expect((await load(b.dir)).enabled).toBe(false);

    const c = writeTestPack(tmp());
    const target = join(c.dir, c.pathOf('sprites/data/88.png'));
    const outside = join(tmp(), 'outside.png');
    writeFileSync(outside, c.contents.get(c.pathOf('sprites/data/88.png'))!);
    unlinkSync(target);
    symlinkSync(outside, target);
    expect((await load(c.dir)).enabled).toBe(false);

    const d = writeTestPack(tmp());
    const f = join(d.dir, d.pathOf('audio/voice/1074.opus'));
    const body = Buffer.from(d.contents.get(d.pathOf('audio/voice/1074.opus'))!);
    body[0] = body[0]! ^ 0xff;
    writeFileSync(f, body);
    expect((await load(d.dir, 'quick')).enabled).toBe(true);
    expect(await load(d.dir, 'full')).toMatchObject({ enabled: false, reason: '1 个文件与 manifest 不符' });
  });
});
