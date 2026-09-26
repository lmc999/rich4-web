import { createHash } from 'node:crypto';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BINARY_SIZE_THRESHOLD,
  check,
  checkContent,
  checkPath,
  longestBase64Run,
  looksLikeMkf,
  probeFromBytes,
  type RepoEntry,
  scan,
} from '../check-no-original';
import { git, hasGit, makeTempRepo, runScript } from './helpers';

/** 合成一个大富翁4 风格的 MKF：u32@0 为索引表偏移，资源从 4 开始，索引表在文件尾 */
function fakeMkf(resourceSizes: number[]): Uint8Array {
  const starts: number[] = [];
  let off = 4;
  for (const s of resourceSizes) {
    starts.push(off);
    off += 16 + s;
  }
  const buf = Buffer.alloc(off + starts.length * 4);
  buf.writeUInt32LE(off, 0);
  starts.forEach((s, i) => {
    buf.writeUInt32LE(s, off + i * 4);
  });
  return buf;
}

const pseudoRandom = (n: number): Uint8Array => {
  const b = Buffer.alloc(n);
  let x = 12345;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    b[i] = (x >>> 16) & 0xff;
  }
  b[0] = 0x89; // 避免碰巧像 MKF 或 MZ
  return b;
};

describe('checkPath', () => {
  it.each([
    ['fake.mkf'],
    ['assets/Panel.MKF'],
    ['RICH4.EXE'],
    ['tools/extract/test/rich4.exe'],
    ['bin/tool.dll'],
    ['saves/SAVE01.DAT'],
    ['media/intro.AVI'],
    ['audio/bgm01.mid'],
    ['original/Game/readme.txt'],
    ['rich4-data/manifest.json'],
    ['apps/server/rich4-data/x.json'],
    ['.cache/extract/raw/map0.raw.json'],
    ['rich4-data/maps/taiwan.map.json'],
    ['packages/shared/src/data/maps/taiwan.map.json'],
    ['packages/shared/src/data/extracted/manifest.json'],
  ])('拦截 %s', (p) => {
    expect(checkPath(p).length).toBeGreaterThan(0);
  });

  it.each([
    ['packages/shared/src/data/maps/fixtures/test-map.json'],
    ['packages/shared/src/data/maps/fixtures/demo.map.json'],
    ['docs/original-notes.md'],
    ['apps/client/src/i18n/locales/zh-CN/characters.original.json'],
    ['packages/shared/src/ai/original/policy.ts'],
    ['scripts/check-no-original.ts'],
    ['save.dat.md'],
  ])('放行 %s', (p) => {
    expect(checkPath(p)).toEqual([]);
  });

  it('RICH4_ALLOW_EXTRACTED_COMMIT 只放行派生地图，不放行原版文件', () => {
    expect(checkPath('data/taiwan.map.json', { allowExtracted: true })).toEqual([]);
    expect(checkPath('rich4-data/maps/taiwan.map.json', { allowExtracted: true }).length).toBeGreaterThan(0);
    expect(checkPath('x/map.mkf', { allowExtracted: true }).length).toBeGreaterThan(0);
  });
});

describe('checkContent', () => {
  it('超过 64KB 且以 MZ 开头的二进制被拦，小文件放行', () => {
    const big = Buffer.alloc(BINARY_SIZE_THRESHOLD + 1);
    big.write('MZ', 0, 'latin1');
    expect(checkContent('bin/blob.bin', probeFromBytes(big))).toEqual(['内容为 PE/MZ 可执行文件且超过 64KB']);
    expect(checkContent('bin/small.bin', probeFromBytes(big.subarray(0, 1024)))).toEqual([]);
  });

  it('识别 MKF 容器特征（改名也能拦住）', () => {
    const mkf = fakeMkf([40_000, 30_000, 1_000]);
    expect(looksLikeMkf(probeFromBytes(mkf))).toBe(true);
    expect(checkContent('assets/data.bin', probeFromBytes(mkf))).toEqual(['内容符合 MKF 容器特征且超过 64KB']);
    expect(looksLikeMkf(probeFromBytes(pseudoRandom(100_000)))).toBe(false);
    expect(checkContent('assets/noise.bin', probeFromBytes(pseudoRandom(100_000)))).toEqual([]);
  });

  it('longestBase64Run 线性统计连续段', () => {
    expect(longestBase64Run('ab+/=  xyz')).toBe(5);
    expect(longestBase64Run('')).toBe(0);
  });

  it('sha256 命中原版指纹时拦截', () => {
    const data = Buffer.from('pretend this is an original file');
    const hash = createHash('sha256').update(data).digest('hex');
    expect(checkContent('x.bin', probeFromBytes(data), { bannedHashes: new Set([hash]) })).toEqual([
      'sha256 与原版文件指纹一致',
    ]);
  });

  it('超长 base64 串（≥64KB）视为内嵌二进制', () => {
    const b64 = Buffer.from(pseudoRandom(60_000)).toString('base64');
    expect(checkContent('apps/client/src/icon.ts', probeFromBytes(Buffer.from(`export const x = '${b64}';`)))).toEqual([
      '疑似内嵌二进制（超长 base64 串）',
    ]);
    const short = Buffer.from(pseudoRandom(1000)).toString('base64');
    expect(
      checkContent('apps/client/src/icon.ts', probeFromBytes(Buffer.from(`export const x = '${short}';`))),
    ).toEqual([]);
  });

  it('JSON 中的长 hex 原始字节字段只允许出现在 test/', () => {
    const json = Buffer.from(JSON.stringify({ rawHex: 'ab'.repeat(100) }));
    expect(checkContent('tools/extract/anchors/tables.json', probeFromBytes(json)).length).toBe(1);
    expect(checkContent('tools/extract/test/fixtures/raw.json', probeFromBytes(json))).toEqual([]);
    const sha = Buffer.from(JSON.stringify({ hex: 'a'.repeat(64) }));
    expect(checkContent('tools/extract/known-files.json', probeFromBytes(sha))).toEqual([]);
  });
});

describe('check', () => {
  it('符号链接指向 original/ 时拦截', () => {
    const entries: RepoEntry[] = [
      { path: 'apps/server/data', content: null, symlinkTarget: 'original/Game' },
      { path: 'apps/server/ok', content: null, symlinkTarget: 'packages/shared' },
    ];
    expect(check(entries).map((v) => v.path)).toEqual(['apps/server/data']);
  });
});

describe.skipIf(!hasGit())('scan（临时 git 仓库）', () => {
  let cleanup = (): void => {};
  afterEach(() => cleanup());

  it('fake.mkf 被拦；gitignore 忽略的文件不检查', () => {
    const repo = makeTempRepo('noorig');
    cleanup = repo.cleanup;
    git(repo.root, 'init', '-q');
    repo.write('.gitignore', 'original/\n');
    repo.write('src/index.ts', 'export {};\n');
    repo.write('fake.mkf', 'not really');
    repo.write('original/Game/map.mkf', 'ignored');
    const { violations } = scan(repo.root);
    expect(violations).toEqual([{ path: 'fake.mkf', reason: 'MKF 资源容器（原版文件）' }]);
  });

  it('符号链接到 original/ 被拦', () => {
    const repo = makeTempRepo('noorig-link');
    cleanup = repo.cleanup;
    git(repo.root, 'init', '-q');
    repo.write('.gitignore', 'original/\n');
    repo.write('original/Game/readme.txt', 'x');
    symlinkSync(join(repo.root, 'original'), join(repo.root, 'orig-link'));
    expect(scan(repo.root).violations.map((v) => v.path)).toEqual(['orig-link']);
  });

  it('CLI：违规退出 1，清理后退出 0', () => {
    const repo = makeTempRepo('noorig-cli');
    cleanup = repo.cleanup;
    git(repo.root, 'init', '-q');
    repo.write('README.md', '# demo\n');
    repo.write('assets/fake.mkf', 'x');
    const bad = runScript('check-no-original.ts', repo.root);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('assets/fake.mkf');
    repo.write('.gitignore', '**/*.mkf\n');
    expect(runScript('check-no-original.ts', repo.root).code).toBe(0);
  });
});
