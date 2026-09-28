import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { brotliCompressSync, crc32, deflateRawSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { probeFromBytes } from '../check-no-original';
import { REPO_ROOT } from '../lib/cli';
import {
  artifactPathReasons,
  isEmptyTar,
  looksLikeTar,
  opaqueArchiveKind,
  type Profile,
  pathReasons,
  type ScanOutcome,
  scanEntries,
  type TreeEntry,
  tarEntries,
  zipEntries,
} from '../scan-tree';
import { makeTempRepo } from './helpers';

// ───────────── 合成数据（只在内存或临时目录里构造，不含任何原版内容） ─────────────

const text = (s: string): Buffer => Buffer.from(s, 'utf8');

/** 最小的 ustar 归档；path 超过 100 字节时先写一个 pax 扩展头 */
function tar(entries: { path: string; data?: Uint8Array; type?: '0' | '2' | '5'; link?: string }[]): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, type: string, link = ''): Buffer => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(type, 156);
    h.write(link, 157);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return h;
  };
  const body = (data: Uint8Array): Buffer[] => [Buffer.from(data), Buffer.alloc((512 - (data.length % 512)) % 512)];
  for (const e of entries) {
    if (Buffer.byteLength(e.path) > 100) {
      const rec = ` path=${e.path}\n`;
      let len = rec.length + 2;
      while (`${len}${rec}`.length !== len) len = `${len}${rec}`.length;
      const pax = text(`${len}${rec}`);
      blocks.push(header('PaxHeader', pax.length, 'x'), ...body(pax));
    }
    const data = e.data ?? new Uint8Array(0);
    blocks.push(header(e.path, data.length, e.type ?? '0', e.link), ...body(data));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** 最小的 zip：deflate 为 true 的条目用 deflate，其余 stored */
function zip(entries: { path: string; data: Uint8Array; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const name = text(e.path);
    const payload = e.deflate ? deflateRawSync(e.data) : Buffer.from(e.data);
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(e.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(e.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(payload.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(off, 42);
    locals.push(lh, name, payload);
    centrals.push(ch, name);
    off += 30 + name.length + payload.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** FLIC 文件头（FLC 魔数 0xAF12，8bpp） */
function fakeFlic(): Buffer {
  const b = Buffer.alloc(256);
  b.writeUInt32LE(256, 0);
  b.writeUInt16LE(0xaf12, 4);
  b.writeUInt16LE(8, 12);
  return b;
}

/** Ogg 页头 + 元数据里的派生标记（素材包的 opus 写的是大写 RICH4_DERIVED=1） */
const fakeDerivedOpus = (): Buffer =>
  Buffer.concat([text('OggS\0\x02'), Buffer.alloc(22), text('OpusTags\x07\0\0\0encoderRICH4_DERIVED=1')]);

const file = (path: string, data: Uint8Array | string): TreeEntry => ({
  path,
  kind: 'file',
  content: probeFromBytes(typeof data === 'string' ? text(data) : data),
});

const hitPaths = (r: ScanOutcome): string[] => [...new Set(r.hits.map((h) => h.path))].sort();
const scan = (entries: TreeEntry[], profile: Profile = 'image', banned?: Set<string>): ScanOutcome =>
  scanEntries(entries, { profile, ...(banned ? { bannedHashes: banned } : {}) });

describe('scan-tree：路径规则', () => {
  it('镜像 / 产物档：M11 审查自测里漏掉的形态全部命中', () => {
    for (const p of [
      'app/public/vendor/78.c5d26f34.flc.br',
      'app/public/vendor/78.c5d26f34.flc.gz',
      'app/public/vendor/.rich4-extract.json',
      'app/public/vendor/maps/taiwan.skin.ca179eee.json',
      'app/public/vendor/data/flic-map.38238323.json',
      'app/public/vendor/data/flic-map.38238323.json.br',
      'app/public/vendor/track03.94a26a33.opus',
      'app/public/vendor/track24.c2708ae7.m4a',
      'app/public/vendor/start.22f4561c.mp4',
      'app/public/vendor/masks/panel/x.mask.0a1b2c3d.png',
      'app/public/vendor/track02.ogg',
      'app/public/vendor/InstOK.wav',
      'app/public/midi/Rich4.MID',
      'app/rich4-assets',
      'app/public/original/readme.txt',
      'app/public/Data.mkf',
      'app/public/.wh.Data.mkf',
    ]) {
      expect(pathReasons(p, 'image').length, p).toBeGreaterThan(0);
    }
    expect(pathReasons('assets/78.c5d26f34.flc.gz', 'artifact').length).toBeGreaterThan(0);
  });

  it('正常的代码、样式、字体、基础镜像文件不误报', () => {
    for (const p of [
      'app/public/assets/index-B3x9_aZq.js',
      'app/public/assets/index-B3x9_aZq.js.map',
      'app/public/assets/noto-sans-sc-400.woff2',
      'app/public/index.html',
      'app/server/main.mjs',
      'app/node_modules/@fastify/static/test/static-pre-compressed/index.html.br',
      'app/node_modules/thread-stream/test/dir with spaces/test-package.zip',
      'var/log/apt/eipp.log.xz',
      'usr/local/bin/node',
      'app/.wh..wh..opq',
    ]) {
      expect(pathReasons(p, 'image'), p).toEqual([]);
    }
  });

  it('repo 档与 check-no-original 一致：fixtures 地图放行，original/ 只看顶层', () => {
    expect(pathReasons('packages/shared/src/data/maps/fixtures/test.map.json', 'repo')).toEqual([]);
    expect(pathReasons('apps/client/public/taiwan.map.json', 'repo').length).toBeGreaterThan(0);
    expect(pathReasons('original/Game/Data.mkf', 'repo').length).toBeGreaterThan(0);
    expect(pathReasons('docs/original/notes.md', 'repo')).toEqual([]);
    expect(pathReasons('docs/original/notes.md', 'artifact').length).toBeGreaterThan(0);
    expect(artifactPathReasons('assets/x.12345678.js')).toEqual([]);
  });
});

describe('scan-tree：内容规则与压缩包', () => {
  it('改了名的派生内容：大写 RICH4_DERIVED 的音频、带连字符 schema 的 JSON（含 .br / .gz）、FLIC 文件头', () => {
    const r = scan([
      file('app/public/a.bin', fakeDerivedOpus()),
      file('app/public/b.txt', '{"schema":"rich4.voice-map/1","voices":[]}'),
      file('app/public/c.json.br', brotliCompressSync(text('{"schema":"rich4.video-map/1"}'))),
      file('app/public/d.json.gz', gzipSync(text('{"a":1,"schema":"rich4.sfx-sets/1"}'))),
      file('app/public/manifest.json.gz', gzipSync(text('{"schema":"rich4.assets/1","files":[]}'))),
      file('app/public/e.dat', fakeFlic()),
      file('app/public/ok.js', 'console.log("rich4")'),
    ]);
    expect(hitPaths(r)).toEqual([
      'app/public/a.bin',
      'app/public/b.txt',
      'app/public/c.json.br',
      'app/public/d.json.gz',
      'app/public/e.dat',
      'app/public/manifest.json.gz',
    ]);
  });

  it('sha256 禁单：改名、去掉标记之后仍按内容哈希命中', () => {
    const data = text('pretend these are original bytes');
    const banned = new Set([createHash('sha256').update(data).digest('hex')]);
    expect(hitPaths(scan([file('app/public/x.bin', data)], 'image', banned))).toEqual(['app/public/x.bin']);
    expect(hitPaths(scan([file('app/public/x.bin', data)], 'image'))).toEqual([]);
  });

  it('tar（含 .tar.gz、pax 长路径）与 zip 展开后逐条目再查', () => {
    const inner = tar([
      { path: 'Game/Data.mkf', data: text('FAKE') },
      { path: 'x.bin', data: fakeFlic() },
      { path: `${'deep/'.repeat(30)}rich4-assets/manifest.json`, data: text('{}') },
      { path: 'ok.txt', data: text('hello') },
    ]);
    const z = zip([
      { path: 'pack/rich4-assets/a.png', data: text('FAKE') },
      { path: 'pack/map.json', data: text('{"schema":"rich4.mapskin/1"}'), deflate: true },
      { path: 'pack/readme.txt', data: text('fine'), deflate: true },
    ]);
    const r = scan([file('app/public/bundle.tar.gz', gzipSync(inner)), file('app/public/bundle.zip', z)]);
    expect(hitPaths(r)).toEqual([
      'app/public/bundle.tar.gz!Game/Data.mkf',
      `app/public/bundle.tar.gz!${'deep/'.repeat(30)}rich4-assets/manifest.json`,
      'app/public/bundle.tar.gz!x.bin',
      'app/public/bundle.zip!pack/map.json',
      'app/public/bundle.zip!pack/rich4-assets/a.png',
    ]);
  });

  it('展不开的压缩包：app/ 下（与 artifact 档）判命中，镜像基础层里只告警', () => {
    const xz = Buffer.concat([Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), Buffer.alloc(64)]);
    expect(opaqueArchiveKind(probeFromBytes(xz))).toBe('xz');
    const r = scan([file('app/public/pack.bin', xz), file('var/log/apt/eipp.log.xz', xz)]);
    expect(hitPaths(r)).toEqual(['app/public/pack.bin']);
    expect(r.warnings.map((w) => w.path)).toEqual(['var/log/apt/eipp.log.xz']);
    expect(hitPaths(scan([file('assets/pack.bin', xz)], 'artifact'))).toEqual(['assets/pack.bin']);
  });

  it('tar 解析：ustar、符号链接、目录、空 tar', () => {
    const t = probeFromBytes(
      tar([
        { path: 'app/', type: '5' },
        { path: 'app/link', type: '2', link: '../assets-rich4/rich4-assets/manifest.json' },
        { path: 'app/a.txt', data: text('abc') },
      ]),
    );
    expect(looksLikeTar(t)).toBe(true);
    const list = [...tarEntries(t)];
    expect(list.map((e) => [e.path, e.kind])).toEqual([
      ['app/', 'dir'],
      ['app/link', 'symlink'],
      ['app/a.txt', 'file'],
    ]);
    expect(latin(list[2]!.content!.read(0, 3))).toBe('abc');
    expect(hitPaths(scan(list))).toEqual(['app/link']);
    const empty = probeFromBytes(Buffer.alloc(1024));
    expect(looksLikeTar(empty)).toBe(false);
    expect(isEmptyTar(empty)).toBe(true);
    expect(zipEntries(probeFromBytes(zip([{ path: 'a/', data: new Uint8Array(0) }]))).entries[0]!.kind).toBe('dir');
  });
});

const latin = (b: Uint8Array): string => Buffer.from(b).toString('latin1');

describe('scan-tree：命令行（Node 自带类型剥离直接运行，不经 tsx）', () => {
  let repo: ReturnType<typeof makeTempRepo> | null = null;
  afterEach(() => {
    repo?.cleanup();
    repo = null;
  });

  const run = (args: string[], input?: string) => {
    const r = spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', join(REPO_ROOT, 'scripts/scan-tree.ts'), ...args],
      { encoding: 'utf8', timeout: 60_000, ...(input !== undefined ? { input } : {}) },
    );
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('目录、层 tar（含 gzip 压缩的层）、路径清单；干净时退出 0，有命中退出 1，用法错误退出 2', () => {
    repo = makeTempRepo('scan-tree');
    const root = repo.root;
    repo.write('clean/assets/index-abc.js', 'export {}');
    repo.write('clean/index.html', '<!doctype html>');
    expect(run(['--root', root, join(root, 'clean')])).toMatchObject({ code: 0 });

    repo.write('dirty/assets/78.c5d26f34.flc.br', 'FAKE');
    repo.write('dirty/assets/secret.bin', 'pretend original');
    repo.write(
      'banned.json',
      JSON.stringify({ sha256: createHash('sha256').update('pretend original').digest('hex') }),
    );
    const dirty = run(['--root', root, '--banned-json', join(root, 'banned.json'), join(root, 'dirty')]);
    expect(dirty.code, dirty.out).toBe(1);
    expect(dirty.out).toContain('assets/78.c5d26f34.flc.br');
    expect(dirty.out).toContain('assets/secret.bin');

    const layer = tar([{ path: 'app/public/InstOK.wav', data: text('FAKE') }]);
    repo.write('layer.tar', layer);
    repo.write('layer.tar.gz', gzipSync(layer));
    for (const f of ['layer.tar', 'layer.tar.gz']) {
      const r = run(['--root', root, '--profile', 'image', join(root, f)]);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('app/public/InstOK.wav');
    }
    const paths = run(['--root', root, '--profile', 'image', '--paths-stdin'], '/app/server/main.mjs\n/app/x.fli\n');
    expect(paths.code, paths.out).toBe(1);
    expect(paths.out).toContain('/app/x.fli');
    expect(run(['--profile', 'bogus', root]).code).toBe(2);
  });
});
