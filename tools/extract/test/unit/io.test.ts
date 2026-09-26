import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExtractContext, isInside, ReadOnlyViolationError, realpathLoose } from '../../src/context';
import { hashFileRO, sha256Hex } from '../../src/io/hash';
import { findCaseInsensitive, readFileRO } from '../../src/io/readOnly';
import { canonicalJson, safeWriteFile, writeCanonicalJson } from '../../src/io/writeCanonicalJson';

let root: string;
let ctx: ExtractContext;
const silent = { out: () => {}, err: () => {} };

beforeAll(() => {
  root = realpathLoose(mkdtempSync(path.join(tmpdir(), 'rich4-extract-io-')));
  mkdirSync(path.join(root, 'original', 'Game'), { recursive: true });
  writeFileSync(path.join(root, 'original', 'Game', 'MapDat.MKF'), 'abc');
  ctx = new ExtractContext({ root, logger: silent });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('只读守卫', () => {
  it('拒绝写入 original/ 及其子路径', async () => {
    expect(() => ctx.assertWritable(path.join(root, 'original', 'x.json'))).toThrow(ReadOnlyViolationError);
    expect(() => ctx.assertWritable(path.join(root, 'original'))).toThrow(/E_READONLY_SOURCE/);
    expect(() => ctx.assertWritable(path.join(root, 'original', 'new', 'deep', 'f.bin'))).toThrow(
      ReadOnlyViolationError,
    );
    await expect(writeCanonicalJson(ctx, path.join(root, 'original', 'Game', 'MapDat.MKF'), {})).rejects.toThrow(
      ReadOnlyViolationError,
    );
    expect(readFileSync(path.join(root, 'original', 'Game', 'MapDat.MKF'), 'utf8')).toBe('abc');
    expect(existsSync(path.join(root, 'original', 'x.json'))).toBe(false);
  });

  it('相对路径、.. 绕行、大小写变体都被拦下', () => {
    expect(() => ctx.assertWritable('original/Game/a.json')).toThrow(ReadOnlyViolationError);
    expect(() => ctx.assertWritable(path.join(root, '.cache', '..', 'original', 'a.json'))).toThrow(
      ReadOnlyViolationError,
    );
    if (process.platform === 'darwin' || process.platform === 'win32') {
      expect(() => ctx.assertWritable(path.join(root, 'ORIGINAL', 'a.json'))).toThrow(ReadOnlyViolationError);
    }
  });

  it('经符号链接指向 original/ 的目标也被拦下', () => {
    const link = path.join(root, 'sneaky');
    symlinkSync(path.join(root, 'original', 'Game'), link);
    expect(() => ctx.assertWritable(path.join(link, 'x.json'))).toThrow(ReadOnlyViolationError);
  });

  it('--src 指向别处时同样受保护，且 original/ 仍受保护', () => {
    const other = path.join(root, 'elsewhere');
    mkdirSync(other, { recursive: true });
    const c2 = new ExtractContext({ root, src: other, logger: silent });
    expect(() => c2.assertWritable(path.join(other, 'a'))).toThrow(ReadOnlyViolationError);
    expect(() => c2.assertWritable(path.join(root, 'original', 'a'))).toThrow(ReadOnlyViolationError);
  });

  it('允许写入 .cache/extract', async () => {
    const p = await writeCanonicalJson(ctx, ctx.cachePath('t', 'a.json'), { b: 1, a: [1, { d: 2, c: null }] });
    expect(readFileSync(p, 'utf8')).toBe(
      '{\n  "a": [\n    1,\n    {\n      "c": null,\n      "d": 2\n    }\n  ],\n  "b": 1\n}\n',
    );
    const q = await safeWriteFile(ctx, ctx.cachePath('t', 'b.bin'), Uint8Array.from([1, 2]));
    expect([...readFileSync(q)]).toEqual([1, 2]);
  });

  it('isInside 边界', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b/c', '/a/b')).toBe(true);
    expect(isInside('/a/bc', '/a/b')).toBe(false);
    expect(isInside('/a/..b/c', '/a')).toBe(true);
    expect(isInside('/x', '/a')).toBe(false);
  });
});

describe('canonicalJson', () => {
  it('键排序、末尾换行、丢弃 undefined 属性', () => {
    expect(canonicalJson({ z: 1, a: { y: undefined, x: 'q' } })).toBe('{\n  "a": {\n    "x": "q"\n  },\n  "z": 1\n}\n');
    expect(canonicalJson({ n: -0 })).toBe('{\n  "n": 0\n}\n');
  });

  it('拒绝非有限数、数组里的 undefined、Map/Set、二进制数组', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson([undefined])).toThrow(TypeError);
    expect(() => canonicalJson({ m: new Map() })).toThrow(TypeError);
    expect(() => canonicalJson({ b: new Uint8Array(1) })).toThrow(TypeError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
  });
});

describe('只读读取与哈希', () => {
  it('大小写不敏感查找并读取', async () => {
    const p = await findCaseInsensitive(path.join(root, 'original'), 'game/mapdat.mkf');
    expect(p).toBe(path.join(root, 'original', 'Game', 'MapDat.MKF'));
    expect(await findCaseInsensitive(path.join(root, 'original'), 'Game/nothing.mkf')).toBeNull();
    const bytes = await readFileRO(p!);
    expect(Buffer.from(bytes).toString()).toBe('abc');
    const h = await hashFileRO(p!, ['sha256', 'sha1'] as const);
    expect(h.sha256).toBe(sha256Hex(bytes));
    expect(h.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(h.sha1).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });
});
