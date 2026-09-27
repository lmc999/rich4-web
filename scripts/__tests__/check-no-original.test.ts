import { createHash } from 'node:crypto';
import { rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, crc32, deflateSync, gzipSync } from 'node:zlib';
import { DERIVED_DETAIL_JSON_SCHEMAS, DERIVED_JSON_SCHEMAS, DERIVED_MARKERS } from '@rich4/shared/assets';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ASSET_MANIFEST_CANDIDATES,
  assetManifestPaths,
  BINARY_SIZE_THRESHOLD,
  CACHE_MANIFEST_MAX_DEPTH,
  cacheAssetManifests,
  check,
  checkContent,
  checkPath,
  checkWarnings,
  compressionKind,
  contentWarnings,
  DERIVED_JSON_SCHEMA_IDS,
  DERIVED_MEDIA_MARKER_RE,
  DERIVED_PNG_KEYWORD,
  derivedJsonSchema,
  loadBannedHashes,
  longestBase64Run,
  looksLikeFlic,
  looksLikeMkf,
  pngHasDerivedText,
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

// ───────────── 合成的派生文件（只在内存或临时目录里构造，不含任何原版内容） ─────────────

const u32le = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

function pngChunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 2×2 RGBA PNG；text 为 [关键字, 文本]，where 决定文本块在 IDAT 前还是后 */
function fakePng(text?: [string, string], where: 'before' | 'after' = 'before'): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = pngChunk('IDAT', deflateSync(Buffer.alloc(2 * (1 + 8))));
  const t = text ? [pngChunk('tEXt', Buffer.from(`${text[0]}\0${text[1]}`, 'latin1'))] : [];
  const mid = where === 'before' ? [...t, idat] : [idat, ...t];
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...mid,
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Ogg Opus 的头两页（只保留判定需要的字节形状） */
function fakeOgg(comment: string | null): Buffer {
  const tags = comment ? [u32le(1), u32le(comment.length), Buffer.from(comment, 'latin1')] : [u32le(0)];
  return Buffer.concat([
    Buffer.from('OggS\0\x02', 'latin1'),
    Buffer.alloc(22),
    Buffer.from('OpusHead\x01\x01', 'latin1'),
    Buffer.from('OggS\0\0', 'latin1'),
    Buffer.alloc(22),
    Buffer.from('OpusTags', 'latin1'),
    u32le(4),
    Buffer.from('Lavf', 'latin1'),
    ...tags,
  ]);
}

/** ISO BMFF：ftyp + 大 mdat + 文件尾的 moov（未 faststart），comment 写在 moov 的 ilst 里 */
function fakeMp4(comment: string | null, mdatBytes: number): Buffer {
  const box = (type: string, body: Buffer): Buffer => {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(8 + body.length, 0);
    h.write(type, 4, 'latin1');
    return Buffer.concat([h, body]);
  };
  const ilst = comment
    ? box('\xa9cmt', box('data', Buffer.concat([Buffer.alloc(8), Buffer.from(comment)])))
    : Buffer.alloc(0);
  return Buffer.concat([
    box('ftyp', Buffer.from('M4A \0\0\0\0isomM4A ', 'latin1')),
    box('mdat', Buffer.alloc(mdatBytes)),
    box('moov', box('udta', box('meta', Buffer.concat([Buffer.alloc(4), box('ilst', ilst)])))),
  ]);
}

/** RIFF WAVE（u8 单声道），可带 LIST/INFO/ISFT */
function fakeWav(isft: string | null, comment?: string): Buffer {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(22050, 4);
  fmt.writeUInt32LE(22050, 8);
  fmt.writeUInt16LE(1, 12);
  fmt.writeUInt16LE(8, 14);
  const chunk = (id: string, body: Buffer): Buffer => {
    const pad = body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0);
    return Buffer.concat([Buffer.from(id, 'latin1'), u32le(body.length), body, pad]);
  };
  const info: Buffer[] = [];
  if (isft) info.push(chunk('ISFT', Buffer.from(`${isft}\0`, 'latin1')));
  if (comment) info.push(chunk('ICMT', Buffer.from(`${comment}\0`, 'latin1')));
  const list = info.length > 0 ? [chunk('LIST', Buffer.concat([Buffer.from('INFO'), ...info]))] : [];
  const body = Buffer.concat([
    Buffer.from('WAVE'),
    chunk('fmt ', fmt),
    chunk('data', Buffer.alloc(101, 0x80)),
    ...list,
  ]);
  return Buffer.concat([Buffer.from('RIFF'), u32le(body.length), body]);
}

/** FLIC 文件头（128 字节）+ 一点数据 */
function fakeFlic(magic: number, depth: number): Buffer {
  const b = Buffer.alloc(256);
  b.writeUInt32LE(b.length, 0);
  b.writeUInt16LE(magic, 4);
  b.writeUInt16LE(36, 6);
  b.writeUInt16LE(189, 8);
  b.writeUInt16LE(285, 10);
  b.writeUInt16LE(depth, 12);
  b.writeUInt32LE(14, 16);
  return b;
}

const reasonsOf = (path: string, data: Uint8Array | string): string[] =>
  checkContent(path, probeFromBytes(typeof data === 'string' ? Buffer.from(data) : data));

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
      'sha256 命中禁单（原版文件指纹或本机素材包 manifest）',
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

describe('原版皮肤素材包：路径规则', () => {
  it.each([
    ['rich4-assets/manifest.json'],
    ['rich4-assets/sprites/data/88.1a2b3c4d.png'],
    ['apps/client/public/rich4-assets/ground/taiwan/0_0.png'],
    ['fx/boom.flc'],
    ['x/intro.FLI'],
    ['pack/flic/data/482.1a2b3c4d.flc.br'],
    ['pack/flic/data/482.1a2b3c4d.flc.gz'],
  ])('拦截 %s', (p) => {
    expect(checkPath(p).length).toBeGreaterThan(0);
  });

  it.each([
    ['docs/rich4-assets.md'],
    ['packages/shared/src/assets/pack.ts'],
    ['scripts/flc-notes.md'],
    ['apps/client/src/skin/flic/FlcDecoder.ts'],
    ['x/intro.flcx'],
  ])('放行 %s', (p) => {
    expect(checkPath(p)).toEqual([]);
  });

  it('符号链接指向 rich4-assets 时拦截', () => {
    const entries: RepoEntry[] = [
      { path: 'apps/server/pack', content: null, symlinkTarget: 'rich4-assets' },
      { path: 'apps/client/public/pack', content: null, symlinkTarget: 'build/rich4-assets/sprites' },
    ];
    expect(check(entries).map((v) => v.path)).toEqual(['apps/server/pack', 'apps/client/public/pack']);
  });
});

describe('原版皮肤素材包：内容规则', () => {
  it('PNG 带 tEXt rich4:derived（IDAT 前后都能识别），普通 PNG 放行', () => {
    const marked = fakePng([DERIVED_MARKERS.pngTextKeyword, DERIVED_MARKERS.pngTextValue]);
    expect(pngHasDerivedText(probeFromBytes(marked))).toBe(true);
    expect(reasonsOf('apps/client/public/tile.png', marked)).toEqual(['派生 PNG（tEXt rich4:derived）']);
    expect(reasonsOf('renamed.bin', fakePng(['rich4:derived', 'private'], 'after'))).toEqual([
      '派生 PNG（tEXt rich4:derived）',
    ]);
    expect(reasonsOf('icon.png', fakePng())).toEqual([]);
    expect(reasonsOf('icon.png', fakePng(['Software', 'rich4 editor']))).toEqual([]);
    const truncated = marked.subarray(0, 40);
    expect(() => pngHasDerivedText(probeFromBytes(truncated))).not.toThrow();
  });

  it('Ogg / m4a / MP4 / WebM 元数据带派生标记（含文件尾的 moov）', () => {
    const media = '派生音视频（元数据含 RICH4_DERIVED / rich4-derived）';
    expect(reasonsOf('a.opus', fakeOgg(`comment=${DERIVED_MARKERS.audioComment}`))).toEqual([media]);
    expect(reasonsOf('a.opus', fakeOgg('comment=hello'))).toEqual([]);
    expect(reasonsOf('a.m4a', fakeMp4(DERIVED_MARKERS.audioComment, 1000))).toEqual([media]);
    expect(reasonsOf('v.mp4', fakeMp4(DERIVED_MARKERS.videoComment, 3 * 1024 * 1024))).toEqual([media]);
    expect(reasonsOf('v.mp4', fakeMp4(null, 3 * 1024 * 1024))).toEqual([]);
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(40), Buffer.from('rich4-derived')]);
    expect(reasonsOf('v.webm', webm)).toEqual([media]);
    expect(reasonsOf('s.wav', fakeWav(null, 'RICH4_DERIVED=1'))).toEqual([media]);
  });

  it('JSON 的 schema 为素材包 schema（改名、嵌套、转义斜杠都能识别）', () => {
    const manifest = JSON.stringify({ files: {}, packId: '0'.repeat(16), schema: 'rich4.assets/1' });
    expect(reasonsOf('rich/manifest.json', manifest)).toEqual(['原版皮肤素材包 JSON（schema rich4.assets/1）']);
    expect(reasonsOf('notes/pack.txt', `\n  ${manifest}`)).toEqual(['原版皮肤素材包 JSON（schema rich4.assets/1）']);
    expect(reasonsOf('maps/taiwan.skin.json', '{"mapId":"taiwan","schema":"rich4.mapskin/1"}')).toEqual([
      '原版皮肤素材包 JSON（schema rich4.mapskin/1）',
    ]);
    expect(reasonsOf('a.json', '{"meta":{"schema":"rich4.atlas\\/1"}}')).toEqual([
      '原版皮肤素材包 JSON（schema rich4.atlas/1）',
    ]);
    expect(reasonsOf('render-model.json', '{"schema":"rich4.render-model/research-1"}')).toEqual([]);
    expect(reasonsOf('docs/design.md', '# 设计\n\n```json\n{"schema": "rich4.assets/1"}\n```\n')).toEqual([]);
    expect(reasonsOf('src/pack.ts', "export const S = { schema: 'rich4.assets/1' };\n")).toEqual([]);
    expect(derivedJsonSchema('x.json', '{"schema":"rich4.voicemap/2"}')).toBe('rich4.voicemap/2');
  });

  it('超过 8MB 的 JSON 也按头尾窗口识别 schema', () => {
    const big = Buffer.from(`{"a":"${'x'.repeat(9 * 1024 * 1024)}","schema":"rich4.assets/1"}`);
    expect(reasonsOf('big/manifest.json', big)).toEqual(['原版皮肤素材包 JSON（schema rich4.assets/1）']);
  });

  it('魔数 SPR\\0 / SMP\\0 / GND\\0 与 FLC/FLI 文件头', () => {
    const withMagic = (m: string): Buffer => Buffer.concat([Buffer.from(m, 'latin1'), Buffer.alloc(60, 1)]);
    expect(reasonsOf('a.bin', withMagic('SPR\0'))).toEqual(['内容为原版 SPR 资源（魔数 SPR\\0）']);
    expect(reasonsOf('a.bin', withMagic('SMP\0'))).toEqual(['内容为原版 SMP 资源（魔数 SMP\\0）']);
    expect(reasonsOf('a.bin', withMagic('GND\0'))).toEqual(['内容为原版 GND 资源（魔数 GND\\0）']);
    expect(reasonsOf('a.bin', withMagic('SPRX'))).toEqual([]);
    expect(looksLikeFlic(probeFromBytes(fakeFlic(0xaf12, 8)))).toBe(true);
    expect(reasonsOf('dice.dat', fakeFlic(0xaf12, 8))).toEqual(['内容为 FLIC 动画（FLC/FLI 8bpp 文件头）']);
    expect(reasonsOf('old.dat', fakeFlic(0xaf11, 8))).toEqual(['内容为 FLIC 动画（FLC/FLI 8bpp 文件头）']);
    expect(reasonsOf('hi.dat', fakeFlic(0xaf12, 16))).toEqual([]);
    expect(reasonsOf('tiny.dat', Buffer.from([0, 0, 0, 0, 0x12, 0xaf]))).toEqual([]);
  });

  it('WAV 的 ISFT 为 GoldWave/Awave 只告警，不判违规', () => {
    const wav = fakeWav('GoldWave v4.26');
    expect(reasonsOf('voice/0001.wav', wav)).toEqual([]);
    expect(contentWarnings(probeFromBytes(wav))).toEqual([
      '疑似原版 WAV（ISFT=GoldWave v4.26），请确认不是原版派生音频',
    ]);
    expect(contentWarnings(probeFromBytes(fakeWav('Awave Studio')))).toHaveLength(1);
    expect(contentWarnings(probeFromBytes(fakeWav('Audacity')))).toEqual([]);
    expect(contentWarnings(probeFromBytes(fakeWav(null)))).toEqual([]);
    expect(
      checkWarnings([
        { path: 'a.wav', content: probeFromBytes(wav) },
        { path: 'link.wav', content: null, symlinkTarget: 'x.wav' },
      ]).map((w) => w.path),
    ).toEqual(['a.wav']);
  });

  it('A3 的详表与暂存映射表（带连字符的 schema）也识别；仓库里合法入库的 rich4.* JSON 放行', () => {
    for (const id of DERIVED_DETAIL_JSON_SCHEMAS) {
      expect(reasonsOf('detail-voice.json', JSON.stringify({ count: 1, schema: id }))).toEqual([
        `原版皮肤素材包 JSON（schema ${id}）`,
      ]);
    }
    expect(derivedJsonSchema('staging-flic.json', '{"entries":[],"schema":"rich4.flic-map\\/2"}')).toBe(
      'rich4.flic-map/2',
    );
    for (const ok of [
      'rich4.known-files/1',
      'rich4.fingerprints-lock/1',
      'rich4.anchors-tables/1',
      'rich4.anchors-constants/1',
      'rich4.assets-build/1',
      'rich4.voicemapx/1',
    ]) {
      expect(reasonsOf('tools/extract/known.json', JSON.stringify({ schema: ok })), ok).toEqual([]);
    }
  });

  it('预压缩变体改名后：解压再判定（brotli 的 FLC、PNG、JSON，gzip 的 JSON）；普通压缩内容放行', () => {
    const flcBr = brotliCompressSync(fakeFlic(0xaf12, 8));
    expect(compressionKind('nuke.bin', probeFromBytes(flcBr))).toBe('brotli');
    expect(reasonsOf('nuke.bin', flcBr)).toEqual(['brotli 解压后：内容为 FLIC 动画（FLC/FLI 8bpp 文件头）']);
    expect(reasonsOf('anim/489.1a2b3c4d.flc.br', flcBr)).toEqual([
      'brotli 解压后：内容为 FLIC 动画（FLC/FLI 8bpp 文件头）',
    ]);
    const atlas = Buffer.from(
      JSON.stringify({
        frames: Array.from({ length: 3000 }, (_, i) => ({ x: i, y: i * 7, w: 32, h: 32 })),
        schema: 'rich4.atlas/1',
      }),
    );
    expect(reasonsOf('house-atlas.bin', brotliCompressSync(atlas))).toEqual([
      'brotli 解压后：原版皮肤素材包 JSON（schema rich4.atlas/1）',
    ]);
    expect(reasonsOf('house-atlas.dat', gzipSync(atlas))).toEqual([
      'gzip 解压后：原版皮肤素材包 JSON（schema rich4.atlas/1）',
    ]);
    const png = fakePng([DERIVED_MARKERS.pngTextKeyword, DERIVED_MARKERS.pngTextValue]);
    expect(reasonsOf('tile.gz', gzipSync(png))).toEqual(['gzip 解压后：派生 PNG（tEXt rich4:derived）']);
    // 普通内容压缩后放行；纯文本、已知二进制格式不尝试 brotli
    const plain = Buffer.from(JSON.stringify({ frames: Array.from({ length: 3000 }, (_, i) => i) }));
    expect(reasonsOf('data.json.br', brotliCompressSync(plain))).toEqual([]);
    expect(reasonsOf('data.json.gz', gzipSync(plain))).toEqual([]);
    expect(compressionKind('a.md', probeFromBytes(Buffer.from('# 标题\n正文\n')))).toBeNull();
    expect(compressionKind('icon.png', probeFromBytes(fakePng()))).toBeNull();
    expect(reasonsOf('noise.bin', pseudoRandom(4096))).toEqual([]);
  });

  it('守卫常量与 shared/assets 的派生标记、schema 表一致', () => {
    expect(DERIVED_JSON_SCHEMA_IDS).toEqual([...DERIVED_JSON_SCHEMAS, ...DERIVED_DETAIL_JSON_SCHEMAS]);
    expect(DERIVED_PNG_KEYWORD).toBe(DERIVED_MARKERS.pngTextKeyword);
    expect(DERIVED_MEDIA_MARKER_RE.test(DERIVED_MARKERS.audioComment)).toBe(true);
    expect(DERIVED_MEDIA_MARKER_RE.test(DERIVED_MARKERS.videoComment)).toBe(true);
    for (const id of DERIVED_JSON_SCHEMA_IDS) {
      expect(derivedJsonSchema('x.json', JSON.stringify({ schema: id }))).toBe(id);
    }
    expect(DERIVED_MARKERS.videoComment).toBe(DERIVED_MARKERS.audioComment);
  });

  it('禁单并入本机素材包 manifest 的全部 sha256（含 RICH4_ASSETS_DIR）', () => {
    const repo = makeTempRepo('noorig-banned');
    try {
      const a = createHash('sha256').update('derived A').digest('hex');
      const b = createHash('sha256').update('derived B').digest('hex');
      const c = createHash('sha256').update('derived C').digest('hex');
      repo.write(
        'rich4-assets/manifest.json',
        JSON.stringify({ schema: 'rich4.assets/1', files: { x: { sha256: a } } }),
      );
      repo.write('.cache/rich4-assets/manifest.json', JSON.stringify({ files: { y: { sha256: b.toUpperCase() } } }));
      repo.write('elsewhere/pack/manifest.json', JSON.stringify({ files: { z: { sha256: c } } }));
      expect(ASSET_MANIFEST_CANDIDATES).toEqual(['rich4-assets/manifest.json', '.cache/rich4-assets/manifest.json']);
      expect(assetManifestPaths(repo.root, { RICH4_ASSETS_DIR: 'elsewhere/pack' })).toContain(
        join(repo.root, 'elsewhere/pack/manifest.json'),
      );
      const banned = loadBannedHashes(repo.root, {});
      expect(banned.has(a)).toBe(true);
      expect(banned.has(b)).toBe(true);
      expect(banned.has(c)).toBe(false);
      expect(loadBannedHashes(repo.root, { RICH4_ASSETS_DIR: 'elsewhere/pack' }).has(c)).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  it('禁单另收 .cache/** 下 schema 为 rich4.assets/* 的 manifest（自选输出目录）；其他 manifest 与过深的目录不收', () => {
    const repo = makeTempRepo('noorig-cache');
    try {
      const h = (s: string) => createHash('sha256').update(s).digest('hex');
      const pack = JSON.stringify({ files: { x: { sha256: h('p') } }, schema: 'rich4.assets/1' });
      repo.write('.cache/xxx/manifest.json', pack);
      repo.write('.cache/test-tmp/rich4-a2-local-1/manifest.json', pack.replace(h('p'), h('q')));
      repo.write('.cache/extract/manifest.json', JSON.stringify({ files: [h('d')], schema: 'rich4.data-manifest/1' }));
      const deep = `.cache/${'d/'.repeat(CACHE_MANIFEST_MAX_DEPTH + 1)}manifest.json`;
      repo.write(deep, pack.replace(h('p'), h('deep')));
      expect(cacheAssetManifests(repo.root)).toEqual([
        join(repo.root, '.cache/test-tmp/rich4-a2-local-1/manifest.json'),
        join(repo.root, '.cache/xxx/manifest.json'),
      ]);
      const banned = loadBannedHashes(repo.root, {});
      expect(banned.has(h('p'))).toBe(true);
      expect(banned.has(h('q'))).toBe(true);
      expect(banned.has(h('d'))).toBe(false);
      expect(banned.has(h('deep'))).toBe(false);
    } finally {
      repo.cleanup();
    }
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

  it('CLI：植入的派生 PNG、FLC、manifest 与改名拷贝的素材包文件都被拦下；清理后退出 0', () => {
    const repo = makeTempRepo('noorig-pack');
    cleanup = repo.cleanup;
    git(repo.root, 'init', '-q');
    repo.write('.gitignore', 'rich4-assets/\n.cache/\n');
    repo.write('README.md', '# demo\n');
    // 自选目录 .cache/custom 的素材包（被忽略）：manifest 的哈希同样并入禁单
    const custom = Buffer.from('bytes of another derived file from a custom --out');
    repo.write(
      '.cache/custom/manifest.json',
      JSON.stringify({
        files: { b: { sha256: createHash('sha256').update(custom).digest('hex') } },
        schema: 'rich4.assets/1',
      }),
    );
    // 本机素材包（被忽略，不扫描）；其 manifest 里的哈希并入禁单
    const copied = Buffer.from('bytes of a derived opus file without any marker');
    const copiedSha = createHash('sha256').update(copied).digest('hex');
    repo.write(
      'rich4-assets/manifest.json',
      JSON.stringify({ schema: 'rich4.assets/1', files: { a: { sha256: copiedSha } } }),
    );
    repo.write('rich4-assets/sprites/data/88.1a2b3c4d.png', fakePng(['rich4:derived', 'private']));
    // 植入仓库的派生物
    repo.write('apps/client/public/tile.png', fakePng(['rich4:derived', 'private']));
    repo.write('apps/client/src/dice.dat', fakeFlic(0xaf12, 8));
    repo.write('apps/client/src/pack.json', JSON.stringify({ schema: 'rich4.assets/1' }));
    repo.write('apps/client/src/sound.bin', copied);
    repo.write('apps/client/src/custom.bin', custom);
    repo.write('apps/client/src/nuke.bin', brotliCompressSync(fakeFlic(0xaf12, 8)));
    repo.write('apps/client/src/staging-voice.json', JSON.stringify({ count: 1374, schema: 'rich4.voice-map/1' }));
    const { violations, warnings } = scan(repo.root, { bannedHashes: loadBannedHashes(repo.root, {}) });
    expect(violations.map((v) => v.path)).toEqual([
      'apps/client/public/tile.png',
      'apps/client/src/custom.bin',
      'apps/client/src/dice.dat',
      'apps/client/src/nuke.bin',
      'apps/client/src/pack.json',
      'apps/client/src/sound.bin',
      'apps/client/src/staging-voice.json',
    ]);
    expect(warnings).toEqual([]);
    const bad = runScript('check-no-original.ts', repo.root, { RICH4_ASSETS_DIR: '' });
    expect(bad.code).toBe(1);
    for (const p of [
      'tile.png',
      'dice.dat',
      'pack.json',
      'sound.bin',
      'custom.bin',
      'nuke.bin',
      'staging-voice.json',
    ]) {
      expect(bad.out).toContain(p);
    }
    for (const p of [
      'apps/client/public/tile.png',
      'apps/client/src/dice.dat',
      'apps/client/src/pack.json',
      'apps/client/src/custom.bin',
      'apps/client/src/nuke.bin',
      'apps/client/src/staging-voice.json',
    ]) {
      rmSync(join(repo.root, p));
    }
    rmSync(join(repo.root, 'apps/client/src/sound.bin'));
    repo.write('media/voice.wav', fakeWav('GoldWave v4.26'));
    const ok = runScript('check-no-original.ts', repo.root, { RICH4_ASSETS_DIR: '' });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('告警 1 处');
  });
});
