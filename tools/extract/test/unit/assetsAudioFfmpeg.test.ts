/**
 * 原版皮肤 A3：ffmpeg 参数确定性、WAV 解析、输出目录守卫、合成素材上的 buildAudio。
 * 只用合成数据；本机没有 ffmpeg 时相关用例 skip。
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DERIVED_MARKERS } from '@rich4/shared/assets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  audioEncodeArgs,
  buildAudio,
  DERIVED_MARKER,
  detectFfmpeg,
  encodeAudio,
  type FfmpegTools,
  hashedPath,
  mapPool,
  parseWav,
  probeDurationMs,
  resolveOutputDir,
} from '../../src/assets/audio';
import { videoEncodeArgs } from '../../src/assets/video';
import { ExitCode, ExtractContext, ExtractError } from '../../src/context';
import { buildMkf } from '../helpers/buildMkf';

const quiet = { out: () => {}, err: () => {} };

/** 合成 u8 单声道 PCM WAV（带一个无关的 LIST 块，模拟原版） */
function synthWav(ms: number, rate = 22050, seed = 1): Uint8Array {
  const n = Math.round((rate * ms) / 1000);
  const data = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    // 方波 + 少量噪声，避免被编码器当成静音
    data[i] = (i % 50 < 25 ? 170 : 86) + ((x >>> 28) - 8);
  }
  const list = new TextEncoder().encode('LIST\x04\x00\x00\x00INFO');
  const size = 12 + 24 + 8 + n + (n & 1) + list.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  const put = (o: number, s: string) => out.set(new TextEncoder().encode(s), o);
  put(0, 'RIFF');
  dv.setUint32(4, size - 8, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate, true);
  dv.setUint16(32, 1, true);
  dv.setUint16(34, 8, true);
  put(36, 'data');
  dv.setUint32(40, n, true);
  out.set(data, 44);
  out.set(list, 44 + n + (n & 1));
  return out;
}

describe('WAV 与命名', () => {
  it('parseWav 读出 fmt 与 data，按 data 长度算时长', () => {
    const w = parseWav(synthWav(300));
    expect(w).toMatchObject({ format: 1, channels: 1, rate: 22050, bits: 8 });
    expect(w.durationMs).toBe(300);
    expect(() => parseWav(new Uint8Array(20))).toThrow(ExtractError);
  });

  it('hashedPath 把哈希前 8 位插到扩展名前', () => {
    expect(hashedPath('audio/voice/0234.opus', 'abcdef0123456789')).toBe('audio/voice/0234.abcdef01.opus');
    expect(hashedPath('data/voice-map.json', '0011223344')).toBe('data/voice-map.00112233.json');
  });

  it('mapPool 保持顺序并传播第一个错误', async () => {
    expect(await mapPool([3, 1, 2], 2, async (x) => x * 2)).toEqual([6, 2, 4]);
    await expect(
      mapPool([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error('boom');
        return x;
      }),
    ).rejects.toThrow('boom');
  });
});

describe('ffmpeg 参数', () => {
  it('音频参数：去元数据、bitexact、派生标记，格式显式', () => {
    for (const fmt of ['opus', 'm4a'] as const) {
      const a = audioEncodeArgs('speech', fmt);
      expect(a.join(' ')).toContain('-map_metadata -1');
      expect(a.join(' ')).toContain('-fflags +bitexact');
      expect(a.join(' ')).toContain('-flags:a +bitexact');
      expect(a).toContain(`comment=${DERIVED_MARKER}`);
      expect(a.at(-1)).toBe(fmt === 'opus' ? 'opus' : 'ipod');
    }
    expect(audioEncodeArgs('music', 'opus', { startMs: 250, endMs: 19601 }).join(' ')).toContain(
      'atrim=start=0.250:end=19.601',
    );
  });

  it('视频参数：固定线程数与 bitexact', () => {
    const v = videoEncodeArgs().join(' ');
    expect(v).toContain('-threads 4');
    expect(v).toContain('-flags:v +bitexact');
    expect(v).toContain('+faststart');
  });

  it('派生标记与契约常量一致：音频、视频的 comment 都是 DERIVED_MARKERS 里的值', () => {
    expect(DERIVED_MARKER).toBe(DERIVED_MARKERS.audioComment);
    expect(DERIVED_MARKERS.videoComment).toBe('RICH4_DERIVED=1');
    expect(audioEncodeArgs('speech', 'opus').join(' ')).toContain(`comment=${DERIVED_MARKERS.audioComment}`);
    expect(videoEncodeArgs().join(' ')).toContain(`comment=${DERIVED_MARKERS.videoComment}`);
  });
});

describe('输出目录守卫', () => {
  const ctx = new ExtractContext({ logger: quiet });

  it('拒绝 original/、apps/*/public/、未被 git 忽略的路径与仓库根', () => {
    expect(() => resolveOutputDir(ctx, path.join(ctx.root, 'original', 'x'))).toThrow(/E_READONLY_SOURCE/);
    expect(() => resolveOutputDir(ctx, path.join(ctx.root, 'apps', 'client', 'public', 'pack'))).toThrow(
      /E_ASSETS_OUT_PUBLIC/,
    );
    expect(() => resolveOutputDir(ctx, path.join(ctx.root, 'tools', 'extract', 'out'))).toThrow(
      /E_ASSETS_OUT_NOT_IGNORED/,
    );
    expect(() => resolveOutputDir(ctx, ctx.root)).toThrow(/E_ASSETS_OUT_ROOT/);
  });

  it('放行已忽略的 rich4-assets/、.cache/；仓库外目录须显式 allowOutsideRepo', () => {
    expect(resolveOutputDir(ctx, 'rich4-assets')).toMatch(/rich4-assets$/);
    expect(resolveOutputDir(ctx, path.join('.cache', 'assets-staging'))).toMatch(/assets-staging$/);
    const outside = path.join(os.tmpdir(), 'rich4-out');
    expect(() => resolveOutputDir(ctx, outside)).toThrow(/E_ASSETS_OUT_OUTSIDE/);
    expect(resolveOutputDir(ctx, outside, { allowOutsideRepo: true })).toMatch(/rich4-out$/);
  });

  it('A3 的 resolveOutputDir 与素材包同口径：被忽略但不在 rich4-assets/、.cache/ 下的目录（dist、.vitest）一律拒绝', () => {
    for (const d of ['apps/client/dist/pack', 'apps/client/.vitest/pack', '.vitest/pack', 'node_modules/.x/pack']) {
      expect(() => resolveOutputDir(ctx, d), d).toThrow(/E_ASSETS_OUT_POLICY/);
    }
  });
});

const tools: FfmpegTools | null = await detectFfmpeg();
const haveCodecs = !!tools && tools.encoders.libopus && tools.encoders.aac;
let tmp = '';
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'rich4-a3-'));
});
afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('ffmpeg 确定性（本机无 ffmpeg 或缺编码器时 skip）', () => {
  it('缺 ffmpeg 时 buildAudio 以「缺少输入」退出', async () => {
    const ctx = new ExtractContext({ logger: quiet });
    const err = await buildAudio({
      ctx,
      outDir: path.join(tmp, 'x'),
      allowOutsideRepo: true,
      ffmpeg: path.join(tmp, 'no-such-ffmpeg'),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtractError);
    expect((err as ExtractError).exitCode).toBe(ExitCode.MISSING_INPUT);
  });

  it.skipIf(!haveCodecs)('同一段合成 WAV 转码两次字节相同，时长在 ±25ms 内', async () => {
    if (!tools) return;
    const wav = synthWav(300);
    for (const fmt of ['opus', 'm4a'] as const) {
      const a = await encodeAudio(tools, { bytes: wav, format: 'wav' }, 'speech', fmt, path.join(tmp, `a.${fmt}`));
      const b = await encodeAudio(tools, { bytes: wav, format: 'wav' }, 'speech', fmt, path.join(tmp, `b.${fmt}`));
      expect(Buffer.compare(Buffer.from(a), Buffer.from(b)), fmt).toBe(0);
      expect(Buffer.from(a).includes(Buffer.from(DERIVED_MARKER)), fmt).toBe(true);
      expect(Buffer.from(a).includes(Buffer.from('LIST')), fmt).toBe(false);
      const ms = await probeDurationMs(tools, path.join(tmp, `a.${fmt}`));
      expect(Math.abs(ms - 300), fmt).toBeLessThanOrEqual(25);
    }
  });

  it.skipIf(!haveCodecs)(
    '合成 Speaking/Effect.mkf 上跑 buildAudio：命名、清单、映射表、空占位',
    async () => {
      if (!tools) return;
      const src = path.join(tmp, 'src');
      await mkdir(path.join(src, 'Game'), { recursive: true });
      const speaking = Array.from({ length: 1374 }, (_, i) => ({ body: synthWav(20 + (i % 7), 22050, i) }));
      const effect = Array.from({ length: 115 }, (_, i) =>
        i >= 64 && i <= 79 ? { body: new Uint8Array(0) } : { body: synthWav(30 + (i % 5), 22050, 7 + i) },
      );
      await writeFile(path.join(src, 'Game', 'Speaking.mkf'), buildMkf(speaking));
      await writeFile(path.join(src, 'Game', 'Effect.mkf'), buildMkf(effect));
      const outDir = path.join(tmp, 'out');
      const ctx = new ExtractContext({ logger: quiet });
      const run = () =>
        buildAudio({
          ctx,
          srcDir: src,
          outDir,
          allowOutsideRepo: true,
          only: ['voice', 'sfx'],
          ids: { voice: [0, 1373], sfx: [9, 64, 114] },
        });
      const r = await run();
      expect(r.tools.ffmpeg).toBe(tools.version);
      const keys = r.files.map((f) => f.key);
      expect(keys).toEqual([
        'audio/sfx/009.m4a',
        'audio/sfx/009.opus',
        'audio/sfx/114.m4a',
        'audio/sfx/114.opus',
        'audio/voice/0000.m4a',
        'audio/voice/0000.opus',
        'audio/voice/1373.m4a',
        'audio/voice/1373.opus',
        'data/sfx-sets.json',
        'data/voice-map.json',
      ]);
      for (const f of r.files) {
        expect(f.path).toMatch(/\.[0-9a-f]{8}\.(opus|m4a|json)$/);
        expect(f.path.slice(-4)).toBe(f.key.slice(-4));
        const bytes = await readFile(path.join(outDir, ...f.path.split('/')));
        expect(bytes.length).toBe(f.bytes);
      }
      const v = r.files.find((f) => f.key === 'audio/voice/1373.opus')!;
      expect(v.contentType).toBe('audio/ogg; codecs=opus');
      expect(v.source).toEqual({ file: 'Game/Speaking.mkf', res: 1373, durationMs: 20 + (1373 % 7) });
      expect(r.maps.voiceMap?.durationsMs).toHaveLength(1374);
      expect(r.maps.sfxSets?.durationsMs?.[64]).toBe(0);
      expect(r.sources.map((s) => s.file)).toEqual(['Game/Effect.mkf', 'Game/Speaking.mkf']);
      // 同输入再跑一次：清单完全相同；临时目录已清理
      const r2 = await run();
      expect(r2.files).toEqual(r.files);
      expect((await readdir(outDir)).filter((n) => n.startsWith('.rich4-tmp'))).toEqual([]);
    },
    60_000,
  );
});
