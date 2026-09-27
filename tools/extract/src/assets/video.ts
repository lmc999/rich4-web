/**
 * 原版皮肤 A3（可选）：Steam Media/*.avi（Indeo 5）→ H.264 + AAC 的 MP4（+faststart，浏览器通用）。
 *
 * - 默认只转 v2.06 用到的 7 个（set 'v206'）；set 'all' 另转 END01..12、THANKS、AIRPLANE。
 * - 参数固定：x264 preset slow、CRF 20、yuv420p、固定 4 线程（x264 在线程数固定时输出确定）、AAC 128k；
 *   另带 -map_metadata -1、bitexact 与 RICH4_DERIVED 注释。保持原分辨率（End.avi 为 320×240，由播放端缩放）。
 * - 找不到的 AVI 只警告并跳过（需要先把 Steam 的 Media/*.avi 只读拷到 original/Media/）；一个都没有时报缺少输入。
 * - 另写 data/video-map.<h8>.json：key → 用途、尺寸、源时长。
 *
 * 做法移植自 test/ar_video_convert.py（本项目调研原型）。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ExitCode, ExtractContext, ExtractError, type Logger } from '../context';
import { sha256Hex } from '../io/hash';
import { findCaseInsensitive, readFileRO } from '../io/readOnly';
import {
  type BuiltFile,
  CONTENT_TYPES,
  DEFAULT_STAGING_DIR,
  detectFfmpeg,
  determinismArgs,
  type FfmpegTools,
  mapPool,
  placeFile,
  probeDurationMs,
  pruneStale,
  runProcess,
  type SourceRecord,
  TmpArea,
  writeJsonFile,
} from './audio';
import type { Confidence } from './data/types';
import { VIDEOS, type VideoDef, type VideoSet } from './data/video';
import { claimOutputDir, resolveOutputDir } from './outputDir';

/** data/video-map.<h8>.json 的 schema（在 shared DERIVED_DETAIL_JSON_SCHEMAS 里，check-no-original 据此拦截入库） */
export const VIDEO_MAP_SCHEMA = 'rich4.video-map/1';

/** 视频输出与源时长允许的差（ms）；超出只警告 */
export const VIDEO_DURATION_TOLERANCE_MS = 100;

/** 编码参数（不含输入与输出路径） */
export function videoEncodeArgs(): string[] {
  return [
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-fps_mode',
    'passthrough',
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-threads',
    '4',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    ...determinismArgs('av'),
    '-f',
    'mp4',
  ];
}

export async function encodeVideo(tools: FfmpegTools, inFile: string, tmpFile: string): Promise<void> {
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', inFile, ...videoEncodeArgs(), tmpFile];
  const r = await runProcess(tools.ffmpeg, args);
  if (r.code !== 0) {
    throw new ExtractError('E_FFMPEG', `视频转码失败（${path.basename(inFile)}）：${r.stderr.trim().slice(0, 400)}`);
  }
}

export interface VideoMapJson {
  schema: typeof VIDEO_MAP_SCHEMA;
  keyPattern: 'video/{key}.mp4';
  entries: {
    key: string;
    use: string;
    desc: string;
    v206: boolean;
    w: number;
    h: number;
    srcDurationMs: number;
    confidence: Confidence;
    /** 本次是否输出了文件 */
    built: boolean;
  }[];
}

export interface VideoBuildOptions {
  ctx?: ExtractContext;
  srcDir?: string;
  /** Steam Media 目录；默认 <srcDir>/Media */
  mediaDir?: string;
  /** 输出根目录；默认 <root>/.cache/assets-staging（守卫见 ./outputDir） */
  outDir?: string;
  /** 允许输出到仓库外；默认 false */
  allowOutsideRepo?: boolean;
  /** 默认 'v206' */
  set?: VideoSet;
  /** 只转这些 key（本机抽检用）；给出时不清理旧产物 */
  keys?: readonly string[];
  /** 并发数（每个 x264 进程固定 4 线程）；默认 2 */
  jobs?: number;
  ffmpeg?: string;
  ffprobe?: string;
  prune?: boolean;
  log?: Logger;
}

export interface VideoBuildResult {
  outDir: string;
  files: BuiltFile[];
  sources: SourceRecord[];
  tools: { ffmpeg: string };
  warnings: string[];
  map: VideoMapJson;
}

export async function buildVideo(opts: VideoBuildOptions = {}): Promise<VideoBuildResult> {
  const ctx = opts.ctx ?? new ExtractContext();
  const log = opts.log ?? ctx.log;
  const outDir = resolveOutputDir(ctx, opts.outDir ?? DEFAULT_STAGING_DIR, {
    allowOutsideRepo: opts.allowOutsideRepo === true,
  });
  const srcDir = opts.srcDir ? path.resolve(ctx.root, opts.srcDir) : ctx.srcDir;
  const mediaDir = opts.mediaDir ? path.resolve(ctx.root, opts.mediaDir) : path.join(srcDir, 'Media');
  const tools = await detectFfmpeg(opts);
  if (!tools) {
    throw new ExtractError('E_FFMPEG_MISSING', '找不到可用的 ffmpeg / ffprobe', ExitCode.MISSING_INPUT);
  }
  if (!tools.encoders.libx264 || !tools.encoders.aac) {
    throw new ExtractError(
      'E_FFMPEG_CODEC',
      `ffmpeg ${tools.version} 缺少 libx264 或 aac 编码器`,
      ExitCode.MISSING_INPUT,
    );
  }
  const set = opts.set ?? 'v206';
  const wanted = VIDEOS.filter((v) => (set === 'all' || v.v206) && (!opts.keys || opts.keys.includes(v.key)));
  if (opts.keys) {
    const unknown = opts.keys.filter((k) => !VIDEOS.some((v) => v.key === k));
    if (unknown.length > 0) throw new ExtractError('E_ASSETS_ARGS', `未知的视频 key：${unknown.join(', ')}`);
  }
  const warnings: string[] = [];
  const sources: SourceRecord[] = [];
  const found: { def: VideoDef; file: string }[] = [];
  for (const def of wanted) {
    const file = await findCaseInsensitive(mediaDir, def.file);
    if (!file) {
      warnings.push(`缺少 ${def.file}（跳过）`);
      continue;
    }
    const bytes = await readFileRO(file);
    sources.push({ file: `Media/${path.basename(file)}`, sha256: sha256Hex(bytes), bytes: bytes.length });
    found.push({ def, file });
  }
  if (wanted.length > 0 && found.length === 0) {
    throw new ExtractError('E_ASSETS_SOURCE_MISSING', `在 ${mediaDir} 找不到任何 AVI`, ExitCode.MISSING_INPUT);
  }
  log.out(`视频：ffmpeg ${tools.version}，${found.length} 个 AVI → MP4`);
  await claimOutputDir(ctx, outDir);
  const tmp = new TmpArea(ctx, outDir);
  const files: BuiltFile[] = [];
  try {
    const built = await mapPool(found, opts.jobs ?? 2, async ({ def, file }) => {
      const tmpFile = await tmp.file('mp4');
      await encodeVideo(tools, file, tmpFile);
      const durationMs = await probeDurationMs(tools, tmpFile);
      const srcMs = await probeDurationMs(tools, file);
      if (Math.abs(durationMs - srcMs) > VIDEO_DURATION_TOLERANCE_MS) {
        warnings.push(`${def.key}: 输出 ${durationMs} ms，源 ${srcMs} ms`);
      }
      if (Math.abs(srcMs - def.srcDurationMs) > VIDEO_DURATION_TOLERANCE_MS) {
        warnings.push(`${def.key}: 源时长 ${srcMs} ms 与表中 ${def.srcDurationMs} ms 不符`);
      }
      const bytes = new Uint8Array(await readFile(tmpFile));
      const key = `video/${def.key}.mp4`;
      const placed = await placeFile(ctx, outDir, key, tmpFile, bytes);
      log.out(`  ${def.key}：${(placed.bytes / 1048576).toFixed(2)} MB，${durationMs} ms`);
      const out: BuiltFile = {
        key,
        ...placed,
        kind: 'video',
        format: 'mp4',
        contentType: CONTENT_TYPES.mp4,
        durationMs,
        source: { file: `Media/${path.basename(file)}`, durationMs: srcMs },
      };
      return out;
    });
    files.push(...built);
    const builtKeys = new Set(built.map((b) => b.key));
    const map: VideoMapJson = {
      schema: VIDEO_MAP_SCHEMA,
      keyPattern: 'video/{key}.mp4',
      entries: VIDEOS.map((v) => ({
        key: v.key,
        use: v.use,
        desc: v.desc,
        v206: v.v206,
        w: v.w,
        h: v.h,
        srcDurationMs: v.srcDurationMs,
        confidence: v.confidence,
        built: builtKeys.has(`video/${v.key}.mp4`),
      })),
    };
    const prune = (opts.prune ?? true) && !opts.keys;
    const mapFile = await writeJsonFile(ctx, outDir, 'data/video-map.json', map);
    files.push(mapFile);
    if (prune) {
      await pruneStale(ctx, outDir, 'video', /^[a-z0-9]+\.[0-9a-f]{8}\.mp4$/, new Set(built.map((b) => b.path)));
      await pruneStale(ctx, outDir, 'data', /^video-map\.[0-9a-f]{8}\.json$/, new Set([mapFile.path]));
    }
    files.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    sources.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    for (const w of warnings) log.err(`警告：${w}`);
    return { outDir, files, sources, tools: { ffmpeg: tools.version }, warnings, map };
  } finally {
    await tmp.dispose();
  }
}
