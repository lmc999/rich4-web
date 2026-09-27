/**
 * 原版皮肤 A3（本机）：需要用户正版文件（original/）；文件不存在时整组 skip，没有 ffmpeg 时转码用例 skip。
 * - 数量与时长：语音 1374、音效 99（+16 空占位）、音乐 25。
 * - voice-map / sfx-sets 与 exe 的台词指针表、音效集表逐项核对（只比编号，不读出台词）。
 * - FLIC 映射表与 MKF 里的 FLC 头逐项核对。
 * - 抽检转码：时长误差 ±25 ms；同输入两次转码字节相同（含视频）。
 * - 设 RICH4_A3_FULL=1 时做全量转码（约 1 分钟），核对 1374 / 99 / 25 的文件数。
 * 转码产物（原版派生）只写 <仓库>/.cache/test-tmp/ 下的临时目录（已被 git 忽略），不写系统临时目录。
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { DERIVED_MARKERS } from '@rich4/shared/assets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAudio, buildVoiceMap, detectFfmpeg, parseWav, probeDurationMs, runProcess } from '../../src/assets/audio';
import { MUSIC_TRACKS } from '../../src/assets/data/music';
import { EFFECT_EMPTY_IDS, SFX_DEAD_SET, SFX_SETS } from '../../src/assets/data/sfx';
import {
  CARD_LINE_SLOTS,
  CARD_LINE_TABLE_PER_CHAR,
  CARD_LINE_TABLE_VA,
  cardLineVoice,
  EVENT_LINE_TABLE_VA,
  eventLineVoice,
  ITEM_LINE_TABLE_PER_CHAR,
  ITEM_LINE_TABLE_VA,
  itemLineVoice,
  VOICE_44K_RANGES,
  VOICE_IDS_WITHOUT_TEXT,
} from '../../src/assets/data/voice';
import { verifyFlicMap } from '../../src/assets/flicMap';
import { buildVideo } from '../../src/assets/video';
import { ExtractContext } from '../../src/context';
import { readFileRO } from '../../src/io/readOnly';
import { MkfArchive } from '../../src/mkf/container';
import { parsePe, vaToOffset } from '../../src/pe/pe';
import { makeRepoTmpDir, REPO_TEST_TMP, repoIgnores } from '../helpers/repoTmp';

const quiet = { out: () => {}, err: () => {} };
const ctx = new ExtractContext({ logger: quiet });
const G = (rel: string) => path.join(ctx.srcDir, 'Game', rel);
const haveGame = ['Speaking.mkf', 'Effect.mkf', 'rich4.exe', 'Data.mkf', 'Panel.mkf', 'jump.mkf'].every((f) =>
  existsSync(G(f)),
);
const haveMusic = existsSync(path.join(ctx.srcDir, 'Media', 'Music', 'track02.ogg'));
const haveVideo = existsSync(path.join(ctx.srcDir, 'Media', 'Flytw.avi'));
const tools = haveGame ? await detectFfmpeg() : null;
const canEncode = !!tools && tools.encoders.libopus && tools.encoders.aac;
const full = process.env.RICH4_A3_FULL === '1';

let tmp = '';
beforeAll(async () => {
  expect(repoIgnores(path.join(REPO_TEST_TMP, 'probe'))).not.toBe(false);
  tmp = makeRepoTmpDir('rich4-a3-local-');
});
afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

async function waves(rel: string) {
  const mkf = MkfArchive.open(await readFileRO(G(rel)), rel);
  return mkf.entries().map((e) => (e.rawSize === 0 ? null : parseWav(mkf.read(e.index), `${rel}#${e.index}`)));
}

describe.skipIf(!haveGame)('语音与音效源（本机原版文件）', () => {
  it('Speaking.mkf：1374 段 u8 单声道 WAV，190 段 44.1 kHz 恰为忍太郎与宫本宝藏，总长约 2283.9 s', async () => {
    const w = await waves('Speaking.mkf');
    expect(w).toHaveLength(1374);
    expect(w.every((x) => x && x.format === 1 && x.channels === 1 && x.bits === 8)).toBe(true);
    const hi = w.flatMap((x, i) => (x!.rate === 44100 ? [i] : []));
    const expectHi = VOICE_44K_RANGES.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, k) => a + k));
    expect(hi).toEqual(expectHi);
    expect(w.filter((x) => x!.rate === 22050)).toHaveLength(1184);
    const total = w.reduce((s, x) => s + x!.durationMs, 0) / 1000;
    expect(Math.abs(total - 2283.9)).toBeLessThan(1);
  });

  it('Effect.mkf：115 项，99 段 WAV，#64..#79 为空，总长约 176.0 s', async () => {
    const w = await waves('Effect.mkf');
    expect(w).toHaveLength(115);
    expect(w.flatMap((x, i) => (x ? [] : [i]))).toEqual(EFFECT_EMPTY_IDS);
    expect(w.filter((x) => x)).toHaveLength(99);
    expect(w.every((x) => !x || (x.rate === 22050 && x.bits === 8 && x.channels === 1))).toBe(true);
    const total = w.reduce((s, x) => s + (x?.durationMs ?? 0), 0) / 1000;
    expect(Math.abs(total - 176.0)).toBeLessThan(0.5);
  });
});

describe.skipIf(!haveGame)('与 exe v2.06 的表逐项核对（只比编号）', () => {
  let exe: Uint8Array;
  let pe: ReturnType<typeof parsePe>;
  beforeAll(async () => {
    exe = await readFileRO(G('rich4.exe'));
    pe = parsePe(exe, 'rich4.exe');
  });
  const u32 = (va: number) => {
    const o = vaToOffset(pe, va)!;
    return (exe[o]! | (exe[o + 1]! << 8) | (exe[o + 2]! << 16) | (exe[o + 3]! << 24)) >>> 0;
  };
  /** 指针指向的字符串若以 '#NNNN' 开头，返回 NNNN；空指针或其他字符串返回 null */
  const voiceAt = (ptrVa: number): number | null => {
    const p = u32(ptrVa);
    if (p === 0) return null;
    const o = vaToOffset(pe, p);
    if (o === null || exe[o] !== 0x23) return null;
    const digits = String.fromCharCode(...exe.subarray(o + 1, o + 5));
    return /^\d{4}$/.test(digits) ? Number(digits) : null;
  };

  it('事件槽表 [12][27] 连续：slot → 1050 + 27c + slot', () => {
    const base = Number(EVENT_LINE_TABLE_VA);
    for (let c = 0; c < 12; c++)
      for (let s = 0; s < 27; s++) expect(voiceAt(base + 4 * (27 * c + s))).toBe(eventLineVoice(c, s));
  });

  it('道具台词表 [12][26]：每个下标的语音号与 voice-map 一致，空位也一致', () => {
    const base = Number(ITEM_LINE_TABLE_VA);
    for (let c = 0; c < 12; c++) {
      for (let j = 0; j < ITEM_LINE_TABLE_PER_CHAR; j++) {
        expect(voiceAt(base + 4 * (ITEM_LINE_TABLE_PER_CHAR * c + j)), `c${c} j${j}`).toBe(itemLineVoice(c, j));
      }
    }
  });

  it('卡片台词表 [12][90]：52 个有效下标与 voice-map 一致', () => {
    const base = Number(CARD_LINE_TABLE_VA);
    for (let c = 0; c < 12; c++) {
      for (let j = 0; j < CARD_LINE_TABLE_PER_CHAR; j++) {
        expect(voiceAt(base + 4 * (CARD_LINE_TABLE_PER_CHAR * c + j)), `c${c} j${j}`).toBe(cardLineVoice(c, j));
      }
    }
    expect(CARD_LINE_SLOTS).toHaveLength(52);
  });

  it('exe 中没有 #NNNN 文本的语音号与表一致（33 个）', () => {
    const seen = new Set<number>();
    // 只扫非代码节（IMAGE_SCN_CNT_CODE = 0x20），与调研脚本 test/ar_voice_text.py 相同
    for (const s of pe.sections.filter((x) => (x.characteristics & 0x20) === 0)) {
      const end = Math.min(exe.length, s.rawPointer + s.rawSize);
      for (let o = s.rawPointer + 1; o + 5 < end; o++) {
        if (exe[o] !== 0x23 || exe[o - 1] !== 0) continue;
        const d = String.fromCharCode(...exe.subarray(o + 1, o + 5));
        if (/^\d{4}$/.test(d) && exe[o + 5] !== 0) seen.add(Number(d));
      }
    }
    const missing = Array.from({ length: 1374 }, (_, i) => i).filter((i) => !seen.has(i));
    expect(missing).toEqual([...VOICE_IDS_WITHOUT_TEXT]);
  });

  it('音效集表：每张表的内容与 0xFFFFFFFF 结尾一致', () => {
    for (const s of [...SFX_SETS, { key: 'dead', ...SFX_DEAD_SET }]) {
      const base = Number(s.va);
      const ids: number[] = [];
      for (let k = 0; u32(base + 8 * k) !== 0xffffffff; k++) {
        expect(u32(base + 8 * k + 4), `${s.key} 运行时指针位`).toBe(0);
        ids.push(u32(base + 8 * k));
        expect(k).toBeLessThan(64);
      }
      expect(ids, s.key).toEqual([...s.ids]);
    }
  });

  it('voice-map 覆盖全部 1374 段', () => {
    expect(buildVoiceMap().count).toBe(1374);
  });
});

describe.skipIf(!haveGame)('FLIC 映射表与本机 MKF', () => {
  it('105 段的 magic / 宽高 / 帧数 / 帧间隔 / 大小全部一致，没有未收录的 FLIC', async () => {
    const r = await verifyFlicMap({ ctx });
    expect(r.checked).toBe(105);
    expect(r.issues).toEqual([]);
    expect(r.unlisted).toEqual([]);
  }, 60_000);
});

describe.skipIf(!haveMusic || !tools)('音乐源（Media/Music）', () => {
  it('25 轨 OGG 存在，时长与表一致（±50 ms）', async () => {
    for (const t of MUSIC_TRACKS) {
      const f = path.join(ctx.srcDir, 'Media', 'Music', `track${String(t.track).padStart(2, '0')}.ogg`);
      expect(existsSync(f), f).toBe(true);
      const ms = await probeDurationMs(tools!, f);
      expect(Math.abs(ms - t.srcDurationMs), `track${t.track}`).toBeLessThanOrEqual(50);
    }
  }, 60_000);
});

describe.skipIf(!haveGame || !haveMusic || !canEncode)('抽检转码（本机 ffmpeg）', () => {
  it('语音 / 音效 / 音乐抽样：时长 ±25 ms（buildAudio 内部强制），两次结果字节相同', async () => {
    const opts = {
      ctx,
      outDir: path.join(tmp, 'sample'),
      ids: { voice: [0, 1, 266, 1074, 1373], sfx: [0, 9, 82, 102, 114], music: [2, 12, 24] },
    };
    const a = await buildAudio(opts);
    expect(a.files.filter((f) => f.kind === 'voice')).toHaveLength(10);
    expect(a.files.filter((f) => f.kind === 'sfx')).toHaveLength(10);
    expect(a.files.filter((f) => f.kind === 'music')).toHaveLength(6);
    for (const f of a.files.filter((x) => x.kind !== 'data')) {
      const expectMs =
        f.kind === 'music'
          ? a.maps.musicMap!.tracks.find((t) => f.key.includes(`track${String(t.track).padStart(2, '0')}`))!.durationMs
          : f.source!.durationMs!;
      expect(Math.abs(f.durationMs! - expectMs), f.key).toBeLessThanOrEqual(25);
    }
    expect(a.warnings).toEqual([]);
    expect(a.maps.voiceMap?.durationsMs?.[1074]).toBeGreaterThan(0);
    const b = await buildAudio(opts);
    expect(b.files).toEqual(a.files);
  }, 120_000);

  it.skipIf(!full)(
    '全量转码：语音 1374、音效 99、音乐 25（各两种格式）',
    async () => {
      const r = await buildAudio({ ctx, outDir: path.join(tmp, 'full') });
      const count = (k: string) => r.files.filter((f) => f.kind === k).length;
      expect(count('voice')).toBe(1374 * 2);
      expect(count('sfx')).toBe(99 * 2);
      expect(count('music')).toBe(25 * 2);
      expect(r.warnings).toEqual([]);
    },
    600_000,
  );
});

describe.skipIf(!haveVideo || !tools?.encoders.libx264)('视频抽检（本机 ffmpeg）', () => {
  it('Flytw.avi → MP4：时长约 6.67 s，两次转码字节相同', async () => {
    const opts = { ctx, outDir: path.join(tmp, 'video'), keys: ['flytw'] };
    const a = await buildVideo(opts);
    const v = a.files.find((f) => f.key === 'video/flytw.mp4')!;
    expect(Math.abs(v.durationMs! - 6667)).toBeLessThanOrEqual(100);
    expect(v.contentType).toBe('video/mp4');
    const b = await buildVideo(opts);
    expect(b.files.find((f) => f.key === 'video/flytw.mp4')!.sha256).toBe(v.sha256);
    // 容器 comment 与契约常量 DERIVED_MARKERS.videoComment 一致（审查：常量曾与产物不符）
    const probe = await runProcess(tools!.ffprobe, [
      '-v',
      'error',
      '-show_entries',
      'format_tags=comment',
      '-of',
      'default=nw=1:nk=1',
      path.join(opts.outDir, ...v.path.split('/')),
    ]);
    expect(probe.stdout.trim()).toBe(DERIVED_MARKERS.videoComment);
  }, 120_000);
});
