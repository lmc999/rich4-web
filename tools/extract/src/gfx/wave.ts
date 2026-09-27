/**
 * WAVE：Speaking.mkf / Effect.mkf 的资源体本身就是完整的 RIFF/WAVE 文件（PCM u8 单声道 22050/44100 Hz）。
 * 移植自 test/ar_wav_chunks.py、test/ar_wav_stats.py 的解析思路（本项目调研原型）；规格：audio_video.md §1–§2。
 * 块顺序通常为 fmt → data → LIST，部分带 smpl。RIFF 块按偶数对齐（奇数大小后有 1 字节填充）。
 */
import { GfxError } from './errors';

export interface WaveChunk {
  id: string;
  /** 块头（id）的绝对偏移 */
  offset: number;
  /** 数据大小（不含 8 字节头与填充） */
  size: number;
}

export interface WaveInfo {
  /** RIFF 头里的大小；完整文件长度 = riffSize + 8 */
  riffSize: number;
  /** fmt 块 wFormatTag（1 = PCM） */
  format: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
  /** 采样帧数 = dataBytes / blockAlign */
  sampleFrames: number;
  /** 时长（秒）= sampleFrames / sampleRate */
  durationSec: number;
  chunks: WaveChunk[];
}

const u16 = (d: Uint8Array, o: number): number => d[o]! | (d[o + 1]! << 8);
const u32 = (d: Uint8Array, o: number): number =>
  (d[o]! | (d[o + 1]! << 8) | (d[o + 2]! << 16) | (d[o + 3]! << 24)) >>> 0;
const id4 = (d: Uint8Array, o: number): string => String.fromCharCode(d[o]!, d[o + 1]!, d[o + 2]!, d[o + 3]!);

export interface ParseWaveOptions {
  /** 要求 riffSize + 8 == 资源长度（默认 true；原版 1473 段全部满足） */
  exactLength?: boolean;
}

export function parseWave(data: Uint8Array, label = 'WAVE', opts: ParseWaveOptions = {}): WaveInfo {
  if (data.length < 12 || id4(data, 0) !== 'RIFF' || id4(data, 8) !== 'WAVE') {
    throw new GfxError('E_WAVE_MAGIC', `${label}: 不是 RIFF/WAVE`);
  }
  const riffSize = u32(data, 4);
  const total = riffSize + 8;
  if (total > data.length || ((opts.exactLength ?? true) && total !== data.length)) {
    throw new GfxError('E_WAVE_SIZE', `${label}: riffSize+8=${total}，资源长度 ${data.length}`);
  }
  const chunks: WaveChunk[] = [];
  let fmt: WaveChunk | null = null;
  let dat: WaveChunk | null = null;
  let p = 12;
  while (p < total) {
    if (p + 8 > total) throw new GfxError('E_WAVE_CHUNK', `${label}: 偏移 ${p} 的块头越过 RIFF 末尾`);
    const id = id4(data, p);
    const size = u32(data, p + 4);
    if (p + 8 + size > total) {
      throw new GfxError('E_WAVE_CHUNK', `${label}: 块 ${JSON.stringify(id)}@${p} 大小 ${size} 越过 RIFF 末尾`);
    }
    const c = { id, offset: p, size };
    chunks.push(c);
    if (id === 'fmt ' && fmt === null) fmt = c;
    else if (id === 'data' && dat === null) {
      if (fmt === null) throw new GfxError('E_WAVE_ORDER', `${label}: data 块出现在 fmt 块之前`);
      dat = c;
    }
    // 偶数对齐；最后一块允许省略填充字节
    p += 8 + size;
    if (size & 1 && p < total) p++;
  }
  if (!fmt || fmt.size < 16) throw new GfxError('E_WAVE_FMT', `${label}: 缺少 fmt 块或 fmt 过短`);
  if (!dat) throw new GfxError('E_WAVE_DATA', `${label}: 缺少 data 块`);
  const f = fmt.offset + 8;
  const format = u16(data, f);
  const channels = u16(data, f + 2);
  const sampleRate = u32(data, f + 4);
  const byteRate = u32(data, f + 8);
  const blockAlign = u16(data, f + 12);
  const bitsPerSample = u16(data, f + 14);
  if (channels === 0 || sampleRate === 0 || blockAlign === 0) {
    throw new GfxError('E_WAVE_FMT', `${label}: 声道 ${channels} 采样率 ${sampleRate} 块对齐 ${blockAlign} 非法`);
  }
  if (format === 1 && blockAlign !== channels * Math.ceil(bitsPerSample / 8)) {
    throw new GfxError(
      'E_WAVE_FMT',
      `${label}: PCM blockAlign=${blockAlign} 与 ${channels} 声道 ${bitsPerSample} 位不符`,
    );
  }
  const sampleFrames = Math.floor(dat.size / blockAlign);
  return {
    riffSize,
    format,
    channels,
    sampleRate,
    byteRate,
    blockAlign,
    bitsPerSample,
    dataOffset: dat.offset + 8,
    dataBytes: dat.size,
    sampleFrames,
    durationSec: sampleFrames / sampleRate,
    chunks,
  };
}

/** 完整的 RIFF 文件字节（零拷贝），可直接交给 ffmpeg 或浏览器 decodeAudioData */
export function sliceWave(data: Uint8Array, label = 'WAVE'): { bytes: Uint8Array; info: WaveInfo } {
  const info = parseWave(data, label, { exactLength: false });
  return { bytes: data.subarray(0, info.riffSize + 8), info };
}
