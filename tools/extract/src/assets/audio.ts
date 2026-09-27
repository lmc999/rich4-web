/**
 * 原版皮肤 A3：语音 / 音效 / 音乐转码，生成 voice-map、sfx-sets、music-map
 * （docs/design/original-skin.md §5 A3；docs/research/original-assets/design-draft.md §2.6；audio_video.md 为细节依据）。
 *
 * - 语音 Speaking.mkf 1374 段、音效 Effect.mkf 99 段（#64..#79 为空）：资源体就是完整 WAV，直接经 stdin 交给 ffmpeg。
 * - 音乐 Media/Music/track02..26.ogg：重编码（Opus 96k 约 28 MB / AAC 128k 约 34 MB）；场景曲按 data/music.ts 的循环区间裁掉首尾静音。
 * - 输出：Opus（主）与 AAC/m4a（回退），参数固定并带 -map_metadata -1、bitexact 与 RICH4_DERIVED 注释标记；
 *   同一 ffmpeg 版本下同输入同字节（参数级确定），不同版本只保证时长误差 ±25 ms。
 * - 文件名带内容哈希前 8 位：<outDir>/audio/{voice,sfx,music}/<name>.<h8>.<fmt>；映射表 <outDir>/data/<name>.<h8>.json。
 * - 输出目录守卫见 ./outputDir：只写入已被 git 忽略的 rich4-assets/ 或 .cache/ 下（仓库外须显式 allowOutsideRepo），
 *   拒绝任何位置的 apps/<app>/public/；清理旧产物只在带归属标记的目录里进行。
 *
 * 做法移植自 test/ar_export_audio.py、test/ar_audio_convert.py、test/ar_build_manifest.py（本项目调研原型）。
 */
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DERIVED_MARKERS } from '@rich4/shared/assets';
import { ExitCode, ExtractContext, ExtractError, type Logger } from '../context';
import { sha256Hex } from '../io/hash';
import { findCaseInsensitive, readFileRO } from '../io/readOnly';
import { canonicalJson, safeWriteFile } from '../io/writeCanonicalJson';
import { MkfArchive } from '../mkf/container';
import { FLIC_DEFS } from './data/flic';
import {
  BOARD_TRACK_OFFSET,
  MUSIC_SCENES,
  MUSIC_TRACKS,
  type MusicRole,
  SCENE_NO_RESUME_BIT,
  sceneTrack,
} from './data/music';
import {
  EFFECT_COUNT,
  EFFECT_EMPTY_IDS,
  SFX_CUES,
  SFX_DEAD_SET,
  SFX_DYNAMIC_FLIC,
  SFX_SETS,
  SFX_UNUSED,
  type SfxCueDef,
  type SfxSetDef,
} from './data/sfx';
import { CHARACTER_COUNT, type Confidence } from './data/types';
import {
  CARD_COUNT,
  CARD_LINE_BASE,
  CARD_LINE_MODE_CONFIDENCE,
  CARD_LINE_SLOTS,
  CARD_LINE_STRIDE,
  CARD_LINE_TABLE_PER_CHAR,
  CARD_LINE_TABLE_VA,
  type CardLineMode,
  cardLineVoice,
  EVENT_LINE_BASE,
  EVENT_LINE_STRIDE,
  EVENT_LINE_TABLE_VA,
  EVENT_SLOTS,
  type EventSlotDef,
  eventLineVoice,
  FATE_COUNT,
  FATE_VOICE_BASE,
  ITEM_COUNT,
  ITEM_LINE_BASE,
  ITEM_LINE_STRIDE,
  ITEM_LINE_TABLE_PER_CHAR,
  ITEM_LINE_TABLE_VA,
  ITEM_REACTIONS,
  itemLineIndex,
  itemLineVoice,
  NAME_CALLS,
  NEWS_COUNT,
  NEWS_VOICE_BASE,
  NPC_LINES,
  type NpcLineDef,
  SPEAKING_COUNT,
  VOICE_IDS_WITHOUT_TEXT,
} from './data/voice';
import { assertOwnedOutputDir, claimOutputDir, resolveOutputDir } from './outputDir';

// ───────────────────────── 公共类型与常量 ─────────────────────────

export type AudioFormat = 'opus' | 'm4a';
export const AUDIO_FORMATS: readonly AudioFormat[] = ['opus', 'm4a'];
export type AudioKind = 'voice' | 'sfx' | 'music';
export const AUDIO_KINDS: readonly AudioKind[] = ['voice', 'sfx', 'music'];
export type BuiltKind = AudioKind | 'video' | 'data';
export type BuiltFormat = AudioFormat | 'mp4' | 'json';

/** 写进每个 ffmpeg 产物（Ogg 注释 / MP4 comment）的派生标记，供守卫识别；常量，不影响确定性（取自契约 DERIVED_MARKERS） */
export const DERIVED_MARKER: string = DERIVED_MARKERS.audioComment;

export const CONTENT_TYPES: Readonly<Record<BuiltFormat, string>> = {
  opus: 'audio/ogg; codecs=opus',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  json: 'application/json',
};

/** 时长容差（ms）：输出与源（或裁剪后的期望值）之差 */
export const DURATION_TOLERANCE_MS = 25;

/** 默认暂存目录（相对仓库根；.cache/ 已被 git 忽略） */
export const DEFAULT_STAGING_DIR = path.join('.cache', 'assets-staging');

/** 构建产物清单中的一项 */
export interface BuiltFile {
  /** 逻辑键 = 不含哈希的相对路径，如 'audio/voice/0234.opus'、'data/voice-map.json' */
  key: string;
  /** 相对 outDir 的 posix 路径（文件名含内容 sha256 前 8 位），如 'audio/voice/0234.1a2b3c4d.opus' */
  path: string;
  sha256: string;
  bytes: number;
  kind: BuiltKind;
  format: BuiltFormat;
  contentType: string;
  /** 媒体时长（ms，ffprobe 实测）；JSON 为 null */
  durationMs: number | null;
  /** 来源（相对 srcDir / mediaDir 的 posix 路径与资源号） */
  source: { file: string; res?: number; durationMs?: number } | null;
}

/** 读取过的原版文件（供 manifest.source 记录） */
export interface SourceRecord {
  /** 相对 srcDir 的 posix 路径，如 'Game/Speaking.mkf'、'Media/Music/track02.ogg' */
  file: string;
  sha256: string;
  bytes: number;
}

// ───────────────────────── 输出目录守卫 ─────────────────────────

// 规则见 ./outputDir（所有派生物共用）；这里保留导出，兼容既有调用方
export { type OutputDirOptions, resolveOutputDir } from './outputDir';

// ───────────────────────── ffmpeg ─────────────────────────

export interface FfmpegTools {
  ffmpeg: string;
  ffprobe: string;
  /** 版本号，如 '8.1.1'（写进 manifest.tools.ffmpeg） */
  version: string;
  /** 可用的编码器 */
  encoders: { libopus: boolean; aac: boolean; libx264: boolean };
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

const OUTPUT_CAP = 1 << 20;

/** 运行子进程；input 经 stdin 写入。进程无法启动时 reject（ENOENT 等）。 */
export function runProcess(cmd: string, args: readonly string[], input?: Uint8Array): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (s: string) => {
      if (stdout.length < OUTPUT_CAP) stdout += s;
    });
    child.stderr?.on('data', (s: string) => {
      if (stderr.length < OUTPUT_CAP) stderr += s;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (input && child.stdin) {
      child.stdin.on('error', () => {
        // ffmpeg 提前退出时写管道会 EPIPE；以退出码为准
      });
      child.stdin.end(input);
    }
  });
}

/** 探测 ffmpeg / ffprobe；任一不可用返回 null。 */
export async function detectFfmpeg(opts: { ffmpeg?: string; ffprobe?: string } = {}): Promise<FfmpegTools | null> {
  const ffmpeg = opts.ffmpeg ?? process.env.RICH4_FFMPEG ?? 'ffmpeg';
  const ffprobe = opts.ffprobe ?? process.env.RICH4_FFPROBE ?? 'ffprobe';
  try {
    const v = await runProcess(ffmpeg, ['-hide_banner', '-version']);
    const p = await runProcess(ffprobe, ['-hide_banner', '-version']);
    if (v.code !== 0 || p.code !== 0) return null;
    const m = /ffmpeg version (\S+)/.exec(v.stdout);
    const enc = await runProcess(ffmpeg, ['-hide_banner', '-encoders']);
    const has = (name: string) => new RegExp(`^\\s*[A-Z.]{6}\\s+${name}\\s`, 'm').test(enc.stdout);
    return {
      ffmpeg,
      ffprobe,
      version: m?.[1] ?? 'unknown',
      encoders: { libopus: has('libopus'), aac: has('aac'), libx264: has('libx264') },
    };
  } catch {
    return null;
  }
}

async function requireFfmpeg(
  opts: { ffmpeg?: string; ffprobe?: string },
  need: readonly (keyof FfmpegTools['encoders'])[],
) {
  const tools = await detectFfmpeg(opts);
  if (!tools) {
    throw new ExtractError(
      'E_FFMPEG_MISSING',
      '找不到可用的 ffmpeg / ffprobe（可用 RICH4_FFMPEG / RICH4_FFPROBE 指定）',
      ExitCode.MISSING_INPUT,
    );
  }
  const missing = need.filter((e) => !tools.encoders[e]);
  if (missing.length > 0) {
    throw new ExtractError(
      'E_FFMPEG_CODEC',
      `ffmpeg ${tools.version} 缺少编码器：${missing.join(', ')}`,
      ExitCode.MISSING_INPUT,
    );
  }
  return tools;
}

const FF_BASE = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'] as const;

/** 确定性与派生标记参数（输出侧）：去掉源元数据与章节、bitexact（不写版本号与时间戳）、写 RICH4_DERIVED 注释 */
export function determinismArgs(streams: 'a' | 'av'): string[] {
  const out = ['-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact'];
  if (streams === 'av') out.push('-flags:v', '+bitexact');
  out.push('-metadata', `comment=${streams === 'av' ? DERIVED_MARKERS.videoComment : DERIVED_MARKERS.audioComment}`);
  return out;
}

export type AudioPreset = 'speech' | 'music';

/**
 * 编码参数（不含输入与输出路径）。speech：单声道 Opus 32k VBR / AAC 48k；music：立体声 Opus 96k VBR / AAC 128k。
 * 音乐 Opus 实测：112k 时 25 轨合计 32.7 MB（VBR 平均码率高于标称约 14%），96k 约 28 MB，符合 ~29 MB 目标。
 */
export function audioEncodeArgs(
  preset: AudioPreset,
  fmt: AudioFormat,
  trim?: { startMs: number; endMs: number },
): string[] {
  const out = ['-map', '0:a:0'];
  if (trim) {
    const s = (trim.startMs / 1000).toFixed(3);
    const e = (trim.endMs / 1000).toFixed(3);
    out.push('-af', `atrim=start=${s}:end=${e},asetpts=N/SR/TB`);
  }
  const ch = preset === 'speech' ? '1' : '2';
  if (fmt === 'opus') {
    out.push('-ac', ch, '-c:a', 'libopus', '-b:a', preset === 'speech' ? '32k' : '96k', '-vbr', 'on');
    out.push('-application', 'audio');
  } else {
    out.push('-ac', ch, '-c:a', 'aac', '-b:a', preset === 'speech' ? '48k' : '128k', '-movflags', '+faststart');
  }
  out.push(...determinismArgs('a'), '-f', fmt === 'opus' ? 'opus' : 'ipod');
  return out;
}

export type EncodeInput = { bytes: Uint8Array; format: 'wav' } | { file: string };

/**
 * 转码一段音频，产物写到 tmpFile 并返回其字节。bytes 输入经 stdin（不落盘）；file 输入只读打开。
 * 失败抛 ExtractError('E_FFMPEG')。
 */
export async function encodeAudio(
  tools: FfmpegTools,
  input: EncodeInput,
  preset: AudioPreset,
  fmt: AudioFormat,
  tmpFile: string,
  trim?: { startMs: number; endMs: number },
): Promise<Uint8Array> {
  const inArgs = 'bytes' in input ? ['-f', input.format, '-i', 'pipe:0'] : ['-i', input.file];
  const args = [...FF_BASE, ...inArgs, ...audioEncodeArgs(preset, fmt, trim), tmpFile];
  const r = await runProcess(tools.ffmpeg, args, 'bytes' in input ? input.bytes : undefined);
  if (r.code !== 0) {
    throw new ExtractError(
      'E_FFMPEG',
      `ffmpeg 转码失败（${path.basename(tmpFile)}）：${r.stderr.trim().slice(0, 400)}`,
    );
  }
  return new Uint8Array(await readFile(tmpFile));
}

/** ffprobe 取容器时长（ms，四舍五入） */
export async function probeDurationMs(tools: FfmpegTools, file: string): Promise<number> {
  const r = await runProcess(tools.ffprobe, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  const v = Number.parseFloat(r.stdout.trim());
  if (r.code !== 0 || !Number.isFinite(v)) {
    throw new ExtractError('E_FFPROBE', `ffprobe 读不出时长：${path.basename(file)}：${r.stderr.trim().slice(0, 200)}`);
  }
  return Math.round(v * 1000);
}

// ───────────────────────── WAV ─────────────────────────

export interface WavInfo {
  /** fmt tag（1 = PCM） */
  format: number;
  channels: number;
  rate: number;
  bits: number;
  dataBytes: number;
  /** 由 data 块长度算出的时长（ms，四舍五入） */
  durationMs: number;
}

function ascii4(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
}

/** 解析 RIFF/WAVE 头（fmt 与 data 块；其余块跳过） */
export function parseWav(b: Uint8Array, where = 'WAV'): WavInfo {
  if (b.length < 12 || ascii4(b, 0) !== 'RIFF' || ascii4(b, 8) !== 'WAVE') {
    throw new ExtractError('E_WAV_HEADER', `${where}: 不是 RIFF/WAVE`);
  }
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let fmt: Omit<WavInfo, 'dataBytes' | 'durationMs'> | null = null;
  let dataBytes = -1;
  for (let o = 12; o + 8 <= b.length; ) {
    const id = ascii4(b, o);
    const size = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= b.length) {
      fmt = {
        format: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        rate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataBytes = Math.min(size, b.length - body);
    }
    o = body + size + (size & 1);
  }
  if (!fmt || dataBytes < 0) throw new ExtractError('E_WAV_HEADER', `${where}: 缺少 fmt 或 data 块`);
  const bytesPerSec = fmt.rate * fmt.channels * Math.max(1, fmt.bits >> 3);
  if (bytesPerSec <= 0) throw new ExtractError('E_WAV_HEADER', `${where}: 非法的采样参数`);
  return { ...fmt, dataBytes, durationMs: Math.round((dataBytes * 1000) / bytesPerSec) };
}

// ───────────────────────── 写文件（带哈希名）与并发 ─────────────────────────

/** 'audio/voice/0234.opus' + sha256 → 'audio/voice/0234.<h8>.opus' */
export function hashedPath(key: string, sha256: string): string {
  const dot = key.lastIndexOf('.');
  const slash = key.lastIndexOf('/');
  const h8 = sha256.slice(0, 8);
  return dot > slash ? `${key.slice(0, dot)}.${h8}${key.slice(dot)}` : `${key}.${h8}`;
}

/** 按输入顺序返回结果；jobs 个并发；任一失败则停止派发并抛出第一个错误 */
export async function mapPool<T, R>(
  items: readonly T[],
  jobs: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let error: { e: unknown } | null = null;
  const worker = async (): Promise<void> => {
    while (error === null) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i]!, i);
      } catch (e) {
        error ??= { e };
      }
    }
  };
  const n = Math.max(1, Math.min(jobs, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  if (error !== null) throw (error as { e: unknown }).e;
  return out;
}

export function defaultJobs(): number {
  return Math.max(1, Math.min(8, os.availableParallelism()));
}

/** outDir 下的临时区（.rich4-tmp-<pid>/），结束时整体删除 */
export class TmpArea {
  readonly dir: string;
  private seq = 0;
  constructor(
    private readonly ctx: ExtractContext,
    outDir: string,
  ) {
    this.dir = path.join(outDir, `.rich4-tmp-${process.pid}`);
  }
  async file(ext: string): Promise<string> {
    const p = path.join(this.dir, `t${this.seq++}.${ext}`);
    this.ctx.assertWritable(p);
    await mkdir(this.dir, { recursive: true });
    return p;
  }
  async dispose(): Promise<void> {
    this.ctx.assertWritable(this.dir);
    await rm(this.dir, { recursive: true, force: true });
  }
}

/** 把已写好的临时文件按内容哈希改名到最终位置 */
export async function placeFile(
  ctx: ExtractContext,
  outDir: string,
  key: string,
  tmpFile: string,
  bytes: Uint8Array,
): Promise<{ path: string; sha256: string; bytes: number }> {
  const sha = sha256Hex(bytes);
  const rel = hashedPath(key, sha);
  const dest = ctx.assertWritable(path.join(outDir, ...rel.split('/')));
  await mkdir(path.dirname(dest), { recursive: true });
  await rename(tmpFile, dest);
  return { path: rel, sha256: sha, bytes: bytes.length };
}

/** 写规范化 JSON（带哈希名），返回清单项 */
export async function writeJsonFile(
  ctx: ExtractContext,
  outDir: string,
  key: string,
  value: unknown,
): Promise<BuiltFile> {
  const text = canonicalJson(value);
  const bytes = new TextEncoder().encode(text);
  const sha = sha256Hex(bytes);
  const rel = hashedPath(key, sha);
  await safeWriteFile(ctx, path.join(outDir, ...rel.split('/')), bytes);
  return {
    key,
    path: rel,
    sha256: sha,
    bytes: bytes.length,
    kind: 'data',
    format: 'json',
    contentType: CONTENT_TYPES.json,
    durationMs: null,
    source: null,
  };
}

/**
 * 删除 outDir/subdir 下符合本模块命名规则、但不在本次清单里的旧产物（只删匹配 pattern 的文件，不递归）。
 */
export async function pruneStale(
  ctx: ExtractContext,
  outDir: string,
  subdir: string,
  pattern: RegExp,
  keep: ReadonlySet<string>,
): Promise<string[]> {
  const dir = path.join(outDir, ...subdir.split('/'));
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  assertOwnedOutputDir(ctx, outDir);
  const removed: string[] = [];
  for (const n of names.sort()) {
    const rel = subdir ? `${subdir}/${n}` : n;
    if (!pattern.test(n) || keep.has(rel)) continue;
    const abs = ctx.assertWritable(path.join(dir, n));
    if (!(await stat(abs)).isFile()) continue;
    await rm(abs, { force: true });
    removed.push(rel);
  }
  return removed;
}

// ───────────────────────── 源文件 ─────────────────────────

interface WaveSource {
  record: SourceRecord;
  /** 按资源号；空资源为 null */
  clips: (null | { bytes: Uint8Array; info: WavInfo })[];
}

async function locate(base: string, rel: string, what: string): Promise<string> {
  const p = await findCaseInsensitive(base, rel);
  if (!p)
    throw new ExtractError('E_ASSETS_SOURCE_MISSING', `缺少${what}：${path.join(base, rel)}`, ExitCode.MISSING_INPUT);
  return p;
}

async function loadWaveMkf(srcDir: string, rel: string, expectCount: number): Promise<WaveSource> {
  const file = await locate(srcDir, rel, '原版文件');
  const bytes = await readFileRO(file);
  const archive = MkfArchive.open(bytes, rel);
  if (archive.count !== expectCount) {
    throw new ExtractError('E_AUDIO_SOURCE', `${rel}: 资源数 ${archive.count}，应为 ${expectCount}`);
  }
  const clips: WaveSource['clips'] = [];
  for (const e of archive.entries()) {
    if (e.rawSize === 0) {
      clips.push(null);
      continue;
    }
    const body = archive.read(e.index);
    clips.push({ bytes: body, info: parseWav(body, `${rel}#${e.index}`) });
  }
  return { record: { file: rel, sha256: sha256Hex(bytes), bytes: bytes.length }, clips };
}

// ───────────────────────── 映射表 JSON ─────────────────────────

export interface VoiceMapJson {
  schema: 'rich4.voice-map/1';
  edition: 'v206';
  count: number;
  characters: number;
  /** 文件逻辑键模板：{id4} = 4 位补零的语音号，{fmt} ∈ formats */
  keyPattern: 'audio/voice/{id4}.{fmt}';
  formats: AudioFormat[];
  events: { base: number; stride: number; tableVa: string; slots: EventSlotDef[]; byChar: number[][] };
  items: {
    base: number;
    stride: number;
    tableVa: string;
    tablePerChar: number;
    /** byChar[c][道具号 − 1] */
    byChar: number[][];
    reactions: { key: string; j: number; desc: string; confidence: Confidence; evidence: string; byChar: number[] }[];
  };
  cards: {
    base: number;
    stride: number;
    tableVa: string;
    tablePerChar: number;
    modeConfidence: Record<CardLineMode, Confidence>;
    /** use[c][卡号 − 1] */
    use: number[][];
    /** 对自己使用时的台词（只有部分卡有） */
    self: { cardId: number; byChar: number[] }[];
    /** 被施用者的反应台词（只有部分卡有） */
    target: { cardId: number; byChar: number[] }[];
  };
  npc: NpcLineDef[];
  names: { key: string; desc: string; confidence: Confidence; byChar: number[] }[];
  /** news[新闻号] → 语音号 */
  news: number[];
  /** fate[命运号 0..48] → 语音号 */
  fate: number[];
  /** exe 里没有 '#NNNN' 文本的语音号（按位置归类） */
  noText: number[];
  /** durationsMs[语音号]（源 WAV 实长，四舍五入）；未读源文件时为 null */
  durationsMs: number[] | null;
}

export function buildVoiceMap(
  opts: { formats?: readonly AudioFormat[]; durationsMs?: readonly number[] | null } = {},
): VoiceMapJson {
  const chars = Array.from({ length: CHARACTER_COUNT }, (_, c) => c);
  const cardSlotsOfMode = (mode: number) =>
    CARD_LINE_SLOTS.filter((j) => Math.trunc(j / CARD_COUNT) === mode).map((j) => (j % CARD_COUNT) + 1);
  const cardByChar = (mode: number, cardId: number) =>
    chars.map((c) => cardLineVoice(c, mode * CARD_COUNT + cardId - 1)!);
  return {
    schema: 'rich4.voice-map/1',
    edition: 'v206',
    count: SPEAKING_COUNT,
    characters: CHARACTER_COUNT,
    keyPattern: 'audio/voice/{id4}.{fmt}',
    formats: [...(opts.formats ?? AUDIO_FORMATS)],
    events: {
      base: EVENT_LINE_BASE,
      stride: EVENT_LINE_STRIDE,
      tableVa: EVENT_LINE_TABLE_VA,
      slots: EVENT_SLOTS.map((s) => ({ ...s })),
      byChar: chars.map((c) => EVENT_SLOTS.map((s) => eventLineVoice(c, s.slot))),
    },
    items: {
      base: ITEM_LINE_BASE,
      stride: ITEM_LINE_STRIDE,
      tableVa: ITEM_LINE_TABLE_VA,
      tablePerChar: ITEM_LINE_TABLE_PER_CHAR,
      byChar: chars.map((c) => Array.from({ length: ITEM_COUNT }, (_, i) => itemLineVoice(c, itemLineIndex(i + 1))!)),
      reactions: ITEM_REACTIONS.map((r) => ({ ...r, byChar: chars.map((c) => itemLineVoice(c, r.j)!) })),
    },
    cards: {
      base: CARD_LINE_BASE,
      stride: CARD_LINE_STRIDE,
      tableVa: CARD_LINE_TABLE_VA,
      tablePerChar: CARD_LINE_TABLE_PER_CHAR,
      modeConfidence: { ...CARD_LINE_MODE_CONFIDENCE },
      use: chars.map((c) => Array.from({ length: CARD_COUNT }, (_, i) => cardLineVoice(c, i)!)),
      self: cardSlotsOfMode(1).map((cardId) => ({ cardId, byChar: cardByChar(1, cardId) })),
      target: cardSlotsOfMode(2).map((cardId) => ({ cardId, byChar: cardByChar(2, cardId) })),
    },
    npc: NPC_LINES.map((n) => ({ ...n, ids: [...n.ids] })),
    names: NAME_CALLS.map((n) => ({
      key: n.key,
      desc: n.desc,
      confidence: n.confidence,
      byChar: chars.map((c) => n.base + c),
    })),
    news: Array.from({ length: NEWS_COUNT }, (_, n) => NEWS_VOICE_BASE + n),
    fate: Array.from({ length: FATE_COUNT }, (_, n) => FATE_VOICE_BASE + n),
    noText: [...VOICE_IDS_WITHOUT_TEXT],
    durationsMs: opts.durationsMs ? [...opts.durationsMs] : null,
  };
}

/** voice-map 里出现的全部语音号（含重复，便于检查「无重复」） */
export function voiceMapIds(m: VoiceMapJson): number[] {
  const out: number[] = [];
  for (const row of m.events.byChar) out.push(...row);
  for (const row of m.items.byChar) out.push(...row);
  for (const r of m.items.reactions) out.push(...r.byChar);
  for (const row of m.cards.use) out.push(...row);
  for (const s of m.cards.self) out.push(...s.byChar);
  for (const s of m.cards.target) out.push(...s.byChar);
  for (const n of m.npc) out.push(...n.ids);
  for (const n of m.names) out.push(...n.byChar);
  out.push(...m.news, ...m.fate);
  return out;
}

/** 结构检查：27 槽 × 12 角色齐全、编号不越界、每个语音号恰好出现一次（覆盖 0..count−1）。返回问题列表 */
export function validateVoiceMap(m: VoiceMapJson): string[] {
  const issues: string[] = [];
  if (m.events.byChar.length !== CHARACTER_COUNT) issues.push(`events: 角色数 ${m.events.byChar.length}`);
  m.events.byChar.forEach((row, c) => {
    if (row.length !== EVENT_LINE_STRIDE) issues.push(`events[${c}]: 槽数 ${row.length}`);
  });
  if (m.items.byChar.some((row) => row.length !== ITEM_COUNT)) issues.push('items: 每角色应有 13 条道具台词');
  if (m.cards.use.some((row) => row.length !== CARD_COUNT)) issues.push('cards.use: 每角色应有 30 条');
  const ids = voiceMapIds(m);
  const seen = new Map<number, number>();
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 0 || id >= m.count) issues.push(`编号越界：${id}`);
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  for (const [id, n] of seen) if (n > 1) issues.push(`编号重复：${id} ×${n}`);
  for (let i = 0; i < m.count; i++) if (!seen.has(i)) issues.push(`编号未归类：${i}`);
  if (m.durationsMs && m.durationsMs.length !== m.count) issues.push(`durationsMs 长度 ${m.durationsMs.length}`);
  return issues;
}

export interface SfxSetsJson {
  schema: 'rich4.sfx-sets/1';
  edition: 'v206';
  count: number;
  keyPattern: 'audio/sfx/{id3}.{fmt}';
  formats: AudioFormat[];
  /** 0 字节空占位（不输出文件） */
  empty: number[];
  sets: SfxSetDef[];
  deadSet: { va: string; ids: number[] };
  cues: SfxCueDef[];
  /** FLIC 同步音效（首帧播放）：来自 flic-map */
  flicSync: { sfx: number; flic: string; use: string; confidence: Confidence }[];
  dynamicFlic: number[];
  unused: number[];
  /** durationsMs[音效号]（源 WAV 实长）；空占位为 0；未读源文件时为 null */
  durationsMs: number[] | null;
}

export function buildSfxSets(
  opts: { formats?: readonly AudioFormat[]; durationsMs?: readonly number[] | null } = {},
): SfxSetsJson {
  const flicSync = FLIC_DEFS.filter((f) => f.sfx !== null)
    .map((f) => ({ sfx: f.sfx!, flic: `${f.mkf}#${f.res}`, use: f.use, confidence: f.confidence }))
    .sort((a, b) => a.sfx - b.sfx || (a.flic < b.flic ? -1 : a.flic > b.flic ? 1 : 0));
  return {
    schema: 'rich4.sfx-sets/1',
    edition: 'v206',
    count: EFFECT_COUNT,
    keyPattern: 'audio/sfx/{id3}.{fmt}',
    formats: [...(opts.formats ?? AUDIO_FORMATS)],
    empty: [...EFFECT_EMPTY_IDS],
    sets: SFX_SETS.map((s) => ({ ...s, ids: [...s.ids], loadedAt: [...s.loadedAt] })),
    deadSet: { va: SFX_DEAD_SET.va, ids: [...SFX_DEAD_SET.ids] },
    cues: SFX_CUES.map((c) => ({ ...c, ids: [...c.ids], evidence: [...c.evidence] })),
    flicSync,
    dynamicFlic: [...SFX_DYNAMIC_FLIC],
    unused: [...SFX_UNUSED],
    durationsMs: opts.durationsMs ? [...opts.durationsMs] : null,
  };
}

/** 结构检查：编号不越界、不落在空占位、每个非空音效号都有归属（集、FLIC 同步、动态或未用） */
export function validateSfxSets(m: SfxSetsJson): string[] {
  const issues: string[] = [];
  const empty = new Set(m.empty);
  const check = (where: string, id: number) => {
    if (!Number.isInteger(id) || id < 0 || id >= m.count) issues.push(`${where}: 编号越界 ${id}`);
    else if (empty.has(id)) issues.push(`${where}: ${id} 是空占位`);
  };
  const setKeys = new Set<string>();
  for (const s of m.sets) {
    if (setKeys.has(s.key)) issues.push(`音效集键重复：${s.key}`);
    setKeys.add(s.key);
    for (const id of s.ids) check(`set ${s.key}`, id);
  }
  const cueKeys = new Set<string>();
  for (const c of m.cues) {
    if (cueKeys.has(c.key)) issues.push(`cue 键重复：${c.key}`);
    cueKeys.add(c.key);
    for (const id of c.ids) check(`cue ${c.key}`, id);
  }
  for (const f of m.flicSync) check(`flic ${f.flic}`, f.sfx);
  const covered = new Set<number>([
    ...m.sets.flatMap((s) => s.ids),
    ...m.flicSync.map((f) => f.sfx),
    ...m.dynamicFlic,
    ...m.unused,
  ]);
  const cued = new Set(m.cues.flatMap((c) => c.ids));
  for (let i = 0; i < m.count; i++) {
    if (empty.has(i)) continue;
    if (!covered.has(i)) issues.push(`音效 ${i} 没有归属`);
    if (i < 80 && !cued.has(i) && !m.unused.includes(i) && !m.dynamicFlic.includes(i))
      issues.push(`音效 ${i} 没有用途标注`);
  }
  if (m.durationsMs && m.durationsMs.length !== m.count) issues.push(`durationsMs 长度 ${m.durationsMs.length}`);
  return issues;
}

export interface MusicMapJson {
  schema: 'rich4.music-map/1';
  edition: 'v206';
  keyPattern: 'audio/music/track{nn}.{fmt}';
  formats: AudioFormat[];
  tracks: {
    track: number;
    midi: string;
    role: MusicRole;
    boardIdx: number | null;
    /** 场景曲：播完从头循环（文件已裁到循环区间）；棋盘曲：播完接下一首 */
    loop: boolean;
    /** 相对源文件的裁剪区间（ms）；没裁为 null */
    trim: { startMs: number; endMs: number } | null;
    /** 输出（裁剪后）时长，ms */
    durationMs: number;
    srcDurationMs: number;
  }[];
  board: { tracks: number[]; trackOffset: number; rotation: string; loop: false };
  scenes: {
    key: string;
    desc: string;
    arg: number;
    track: number;
    /** bit15：进入时不记录棋盘曲续播点 */
    noResume: boolean;
    callSites: string[];
    confidence: Confidence;
  }[];
  sceneTrackOffset: number;
  /** 场景曲打断棋盘曲时的规则 */
  resume: string;
  unused: number[];
}

export interface MusicTrackState {
  track: number;
  trim: { startMs: number; endMs: number } | null;
  srcDurationMs: number;
}

/** 由 data/music.ts 与各轨实际状态（是否裁剪、源时长）生成 music-map；tracks 缺省时用表中值 */
export function buildMusicMap(
  opts: { formats?: readonly AudioFormat[]; tracks?: readonly MusicTrackState[] } = {},
): MusicMapJson {
  const state = new Map((opts.tracks ?? []).map((t) => [t.track, t]));
  const tracks = MUSIC_TRACKS.map((t) => {
    const s = state.get(t.track);
    const trim = s ? s.trim : t.loop;
    const src = s ? s.srcDurationMs : t.srcDurationMs;
    return {
      track: t.track,
      midi: t.midi,
      role: t.role,
      boardIdx: t.boardIdx ?? null,
      loop: t.role === 'scene',
      trim: trim ? { ...trim } : null,
      durationMs: trim ? trim.endMs - trim.startMs : src,
      srcDurationMs: src,
    };
  });
  return {
    schema: 'rich4.music-map/1',
    edition: 'v206',
    keyPattern: 'audio/music/track{nn}.{fmt}',
    formats: [...(opts.formats ?? AUDIO_FORMATS)],
    tracks,
    board: {
      tracks: MUSIC_TRACKS.filter((t) => t.role === 'board').map((t) => t.track),
      trackOffset: BOARD_TRACK_OFFSET,
      rotation: 'idx = (cur + 1) & 7；track = idx + 2；一曲播完接下一首',
      loop: false,
    },
    scenes: MUSIC_SCENES.map((s) => ({
      key: s.key,
      desc: s.desc,
      arg: s.arg,
      track: sceneTrack(s.arg),
      noResume: (s.arg & SCENE_NO_RESUME_BIT) !== 0,
      callSites: [...s.callSites],
      confidence: s.confidence,
    })),
    sceneTrackOffset: 10,
    resume: '场景曲打断棋盘曲时记录棋盘曲播放位置（noResume 的场景除外），离开场景后从断点续播',
    unused: MUSIC_TRACKS.filter((t) => t.role === 'unused').map((t) => t.track),
  };
}

// ───────────────────────── buildAudio ─────────────────────────

/** 相对路径一律按仓库根（ctx.root）解析；CLI 应先用 ctx.resolveUserPath 转成绝对路径再传入 */
export interface AudioBuildOptions {
  ctx?: ExtractContext;
  /** 原版目录（含 Game/）；默认 ctx.srcDir（original/） */
  srcDir?: string;
  /** Steam Media 目录（含 Music/）；默认 <srcDir>/Media */
  mediaDir?: string;
  /** 输出根目录；默认 <root>/.cache/assets-staging（必须是已被 git 忽略的 rich4-assets/ 或 .cache/ 下的目录） */
  outDir?: string;
  /** 允许输出到仓库外（见 ./outputDir）；默认 false */
  allowOutsideRepo?: boolean;
  formats?: readonly AudioFormat[];
  only?: readonly AudioKind[];
  /** 只转码这些编号（本机抽检用）；给出时不做过期文件清理 */
  ids?: { voice?: readonly number[]; sfx?: readonly number[]; music?: readonly number[] };
  jobs?: number;
  ffmpeg?: string;
  ffprobe?: string;
  /** 默认 true：删除同目录下本命名规则、但不在本次清单里的旧产物 */
  prune?: boolean;
  /** 默认 true：写 data/{voice-map,sfx-sets,music-map}.<h8>.json */
  writeMaps?: boolean;
  log?: Logger;
}

export interface AudioBuildResult {
  outDir: string;
  /** 按 key 排序 */
  files: BuiltFile[];
  sources: SourceRecord[];
  tools: { ffmpeg: string };
  warnings: string[];
  maps: { voiceMap: VoiceMapJson | null; sfxSets: SfxSetsJson | null; musicMap: MusicMapJson | null };
}

interface ClipJob {
  kind: AudioKind;
  key: string;
  fmt: AudioFormat;
  preset: AudioPreset;
  input: EncodeInput;
  /** 期望时长（ms）：源实长或裁剪后长度 */
  expectMs: number;
  trim?: { startMs: number; endMs: number };
  source: BuiltFile['source'];
}

const PAD = (n: number, w: number) => String(n).padStart(w, '0');

function pickFormats(f: readonly AudioFormat[] | undefined): AudioFormat[] {
  const set = new Set(f ?? AUDIO_FORMATS);
  const out = AUDIO_FORMATS.filter((x) => set.has(x));
  if (out.length === 0) throw new ExtractError('E_ASSETS_ARGS', '至少要指定一种音频格式（opus / m4a）');
  return out;
}

async function runClipJobs(
  ctx: ExtractContext,
  tools: FfmpegTools,
  outDir: string,
  tmp: TmpArea,
  jobs: readonly ClipJob[],
  concurrency: number,
  log: Logger,
): Promise<BuiltFile[]> {
  let done = 0;
  return mapPool(jobs, concurrency, async (j) => {
    const tmpFile = await tmp.file(j.fmt);
    const bytes = await encodeAudio(tools, j.input, j.preset, j.fmt, tmpFile, j.trim);
    const durationMs = await probeDurationMs(tools, tmpFile);
    if (Math.abs(durationMs - j.expectMs) > DURATION_TOLERANCE_MS) {
      throw new ExtractError(
        'E_AUDIO_DURATION',
        `${j.key}: 输出时长 ${durationMs} ms，期望 ${j.expectMs} ms（容差 ±${DURATION_TOLERANCE_MS} ms）`,
      );
    }
    const placed = await placeFile(ctx, outDir, j.key, tmpFile, bytes);
    done++;
    if (done % 500 === 0) log.out(`  已转码 ${done}/${jobs.length}`);
    return {
      key: j.key,
      ...placed,
      kind: j.kind,
      format: j.fmt,
      contentType: CONTENT_TYPES[j.fmt],
      durationMs,
      source: j.source,
    };
  });
}

function selectIds(all: number, subset: readonly number[] | undefined): number[] {
  const ids = subset ? [...new Set(subset)].sort((a, b) => a - b) : Array.from({ length: all }, (_, i) => i);
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 0 || id >= all) throw new ExtractError('E_ASSETS_ARGS', `编号越界：${id}`);
  }
  return ids;
}

/**
 * 转码语音 / 音效 / 音乐并写映射表。只读原版文件；所有产物写到 outDir 下。
 * 缺 ffmpeg 或源文件时抛 ExtractError（exitCode 2）。
 */
export async function buildAudio(opts: AudioBuildOptions = {}): Promise<AudioBuildResult> {
  const ctx = opts.ctx ?? new ExtractContext();
  const log = opts.log ?? ctx.log;
  const formats = pickFormats(opts.formats);
  const only = new Set(opts.only ?? AUDIO_KINDS);
  const outDir = resolveOutputDir(ctx, opts.outDir ?? DEFAULT_STAGING_DIR, {
    allowOutsideRepo: opts.allowOutsideRepo === true,
  });
  const srcDir = opts.srcDir ? path.resolve(ctx.root, opts.srcDir) : ctx.srcDir;
  const mediaDir = opts.mediaDir ? path.resolve(ctx.root, opts.mediaDir) : path.join(srcDir, 'Media');
  const need: (keyof FfmpegTools['encoders'])[] = [];
  if (formats.includes('opus')) need.push('libopus');
  if (formats.includes('m4a')) need.push('aac');
  const tools = await requireFfmpeg(opts, need);
  await claimOutputDir(ctx, outDir);
  const jobsN = opts.jobs ?? defaultJobs();
  const prune = (opts.prune ?? true) && !opts.ids;
  const writeMaps = opts.writeMaps ?? true;
  const tmp = new TmpArea(ctx, outDir);
  const files: BuiltFile[] = [];
  const sources: SourceRecord[] = [];
  const warnings: string[] = [];
  const maps: AudioBuildResult['maps'] = { voiceMap: null, sfxSets: null, musicMap: null };
  log.out(`音频：ffmpeg ${tools.version}，格式 ${formats.join('/')}，输出 ${ctx.displayPath(outDir)}`);
  try {
    // 语音与音效：MKF 资源体即 WAV
    for (const kind of ['voice', 'sfx'] as const) {
      if (!only.has(kind)) continue;
      const rel = kind === 'voice' ? 'Game/Speaking.mkf' : 'Game/Effect.mkf';
      const count = kind === 'voice' ? SPEAKING_COUNT : EFFECT_COUNT;
      const src = await loadWaveMkf(srcDir, rel, count);
      sources.push(src.record);
      const durations = src.clips.map((c) => (c ? c.info.durationMs : 0));
      const width = kind === 'voice' ? 4 : 3;
      const clipJobs: ClipJob[] = [];
      for (const id of selectIds(count, opts.ids?.[kind])) {
        const clip = src.clips[id];
        if (!clip) continue;
        for (const fmt of formats) {
          clipJobs.push({
            kind,
            key: `audio/${kind}/${PAD(id, width)}.${fmt}`,
            fmt,
            preset: 'speech',
            input: { bytes: clip.bytes, format: 'wav' },
            expectMs: clip.info.durationMs,
            source: { file: rel, res: id, durationMs: clip.info.durationMs },
          });
        }
      }
      log.out(`  ${kind}：${clipJobs.length} 个转码任务`);
      const built = await runClipJobs(ctx, tools, outDir, tmp, clipJobs, jobsN, log);
      files.push(...built);
      if (prune) {
        const keep = new Set(built.map((b) => b.path));
        const re = new RegExp(`^\\d{${width}}\\.[0-9a-f]{8}\\.(?:opus|m4a)$`);
        await pruneStale(ctx, outDir, `audio/${kind}`, re, keep);
      }
      if (writeMaps) {
        if (kind === 'voice') {
          maps.voiceMap = buildVoiceMap({ formats, durationsMs: durations });
          const issues = validateVoiceMap(maps.voiceMap);
          if (issues.length > 0) throw new ExtractError('E_VOICE_MAP', issues.slice(0, 10).join('；'));
          files.push(await writeJsonFile(ctx, outDir, 'data/voice-map.json', maps.voiceMap));
        } else {
          maps.sfxSets = buildSfxSets({ formats, durationsMs: durations });
          const issues = validateSfxSets(maps.sfxSets);
          if (issues.length > 0) throw new ExtractError('E_SFX_SETS', issues.slice(0, 10).join('；'));
          files.push(await writeJsonFile(ctx, outDir, 'data/sfx-sets.json', maps.sfxSets));
        }
      }
    }

    // 音乐：Media/Music/trackNN.ogg
    if (only.has('music')) {
      const midiNames = await readMidiNames(srcDir, warnings);
      const wanted = new Set(opts.ids?.music ?? MUSIC_TRACKS.map((t) => t.track));
      const states: MusicTrackState[] = [];
      const clipJobs: ClipJob[] = [];
      for (const t of MUSIC_TRACKS) {
        const rel = `Music/track${PAD(t.track, 2)}.ogg`;
        const file = await locate(mediaDir, rel, 'Steam 音乐文件');
        const bytes = await readFileRO(file);
        sources.push({ file: `Media/${rel}`, sha256: sha256Hex(bytes), bytes: bytes.length });
        const probed = await probeDurationMs(tools, file);
        let trim = t.loop;
        // 与表一致（±50 ms）时用表中值，music-map 不随 ffprobe 版本抖动；不一致时用实测值且不裁剪
        let srcMs = t.srcDurationMs;
        if (Math.abs(probed - t.srcDurationMs) > 50) {
          warnings.push(`track${PAD(t.track, 2)}: 源时长 ${probed} ms 与表中 ${t.srcDurationMs} ms 不符，不裁剪`);
          trim = null;
          srcMs = probed;
        }
        const midi = midiNames?.[t.track - BOARD_TRACK_OFFSET];
        if (midiNames && midi !== t.midi)
          warnings.push(`Midi.txt 第 ${t.track - 2} 行为 ${midi ?? '（缺）'}，表中为 ${t.midi}`);
        // 区间覆盖整段时不裁
        const effTrim = trim && (trim.startMs > 0 || trim.endMs < srcMs) ? trim : null;
        states.push({ track: t.track, trim: effTrim, srcDurationMs: srcMs });
        if (!wanted.has(t.track)) continue;
        for (const fmt of formats) {
          clipJobs.push({
            kind: 'music',
            key: `audio/music/track${PAD(t.track, 2)}.${fmt}`,
            fmt,
            preset: 'music',
            input: { file },
            expectMs: effTrim ? effTrim.endMs - effTrim.startMs : srcMs,
            ...(effTrim ? { trim: effTrim } : {}),
            source: { file: `Media/${rel}`, durationMs: srcMs },
          });
        }
      }
      log.out(`  music：${clipJobs.length} 个转码任务`);
      const built = await runClipJobs(ctx, tools, outDir, tmp, clipJobs, jobsN, log);
      files.push(...built);
      if (prune) {
        const keep = new Set(built.map((b) => b.path));
        await pruneStale(ctx, outDir, 'audio/music', /^track\d{2}\.[0-9a-f]{8}\.(?:opus|m4a)$/, keep);
      }
      if (writeMaps) {
        maps.musicMap = buildMusicMap({ formats, tracks: states });
        files.push(await writeJsonFile(ctx, outDir, 'data/music-map.json', maps.musicMap));
      }
    }
    if (prune && writeMaps) {
      const keep = new Set(files.filter((f) => f.kind === 'data').map((f) => f.path));
      const names = [
        only.has('voice') && 'voice-map',
        only.has('sfx') && 'sfx-sets',
        only.has('music') && 'music-map',
      ].filter((x): x is string => typeof x === 'string');
      if (names.length > 0) {
        await pruneStale(ctx, outDir, 'data', new RegExp(`^(?:${names.join('|')})\\.[0-9a-f]{8}\\.json$`), keep);
      }
    }
  } finally {
    await tmp.dispose();
  }
  files.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  sources.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  for (const w of warnings) log.err(`警告：${w}`);
  const total = files.reduce((s, f) => s + f.bytes, 0);
  log.out(`音频完成：${files.length} 个文件，合计 ${(total / 1048576).toFixed(2)} MB`);
  return { outDir, files, sources, tools: { ffmpeg: tools.version }, warnings, maps };
}

async function readMidiNames(srcDir: string, warnings: string[]): Promise<string[] | null> {
  const p = await findCaseInsensitive(srcDir, 'Game/Midi.txt');
  if (!p) {
    warnings.push('找不到 Game/Midi.txt，跳过轨号核对');
    return null;
  }
  const text = new TextDecoder('latin1').decode(await readFileRO(p));
  return text
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/\.mid$/i, '').toUpperCase());
}

// ───────────────────────── 懒加载分组建议（供 A2 写 manifest.groups） ─────────────────────────

/**
 * 按原版的载入粒度给音频产物分组（逻辑键列表，已排序）：
 * - audio.voice.system：0..233（NPC、系统、新闻、命运）；audio.voice.char.<c>：角色 c 的道具 / 卡片 / 事件台词
 * - audio.sfx：全部音效（Opus 合计约 0.76 MB，整组预载）
 * - audio.music.track<nn>：每轨一组（长曲流式播放）；audio.data：映射表
 * 两种格式放在同一组里，由客户端按 canPlayType 只取一种。
 */
export function suggestAudioGroups(
  files: readonly BuiltFile[],
  voiceMap: VoiceMapJson | null,
): Record<string, string[]> {
  const charOf = new Map<number, number>();
  if (voiceMap) {
    voiceMap.events.byChar.forEach((row, c) => {
      for (const id of row) charOf.set(id, c);
    });
    voiceMap.items.byChar.forEach((row, c) => {
      for (const id of row) charOf.set(id, c);
    });
    for (const r of voiceMap.items.reactions) {
      r.byChar.forEach((id, c) => {
        charOf.set(id, c);
      });
    }
    voiceMap.cards.use.forEach((row, c) => {
      for (const id of row) charOf.set(id, c);
    });
    for (const s of [...voiceMap.cards.self, ...voiceMap.cards.target]) {
      s.byChar.forEach((id, c) => {
        charOf.set(id, c);
      });
    }
  }
  const groups: Record<string, string[]> = {};
  const add = (g: string, key: string) => {
    groups[g] ??= [];
    groups[g].push(key);
  };
  for (const f of files) {
    if (f.kind === 'voice') {
      const id = Number(/(\d{4})\.[a-z0-9]+$/.exec(f.key)?.[1] ?? -1);
      const c = charOf.get(id);
      add(c === undefined ? 'audio.voice.system' : `audio.voice.char.${c}`, f.key);
    } else if (f.kind === 'sfx') add('audio.sfx', f.key);
    else if (f.kind === 'music') add(`audio.music.${/track\d{2}/.exec(f.key)?.[0] ?? 'misc'}`, f.key);
    else if (f.kind === 'data') add('audio.data', f.key);
  }
  for (const k of Object.keys(groups)) groups[k]!.sort();
  return groups;
}
