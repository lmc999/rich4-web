/**
 * 原版皮肤 A2：`rich4-extract assets build`（docs/design/original-skin.md §5 A2；design-draft §2.1、§2.5、§2.7）。
 *
 * 流程：指纹与结构核对 → A3 音频（Opus/m4a）→ 图像（按 catalog.v206 逐项解码、装箱、PNG）→ FLIC → 地面与地图皮肤 →
 * 映射表（契约版 + A3 详表）→（可选）视频 → manifest（zod 校验 + 交叉引用）→ 清理旧产物 → 覆盖率与构建报告（.cache）。
 *
 * - 只读原版文件；所有产物写入已被 git 忽略的输出目录（默认 rich4-assets/），报告写 .cache/extract/assets/。
 * - 同输入同字节：输入按 (mkf, 资源号) 排序；PNG 固定 filter 与 zlib 级别；JSON 规范化；文件名带内容哈希。
 *   音视频由 A3 以 bitexact 参数调用 ffmpeg，同一 ffmpeg 版本下字节相同（manifest.tools.ffmpeg 记录版本）。
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  type AssetEntry,
  type AtlasV1,
  type ContractIssue,
  checkAtlasRefs,
  checkFlicMapRefs,
  checkMapSkinRefs,
  checkMusicMapRefs,
  checkSfxSetsRefs,
  checkSpriteFrames,
  checkVoiceMapRefs,
  type FlicInfo,
  type MapSkinV1,
  type PackManifestV1,
} from '@rich4/shared/assets';
import { type MapDef, parseMapDef } from '@rich4/shared/data';
import { ExitCode, ExtractContext, ExtractError, type Logger } from '../context';
import { extractEditions, readCachedTables } from '../exe/extract';
import { type KnownFiles, loadKnownFiles } from '../fingerprint/identify';
import { parseFlc } from '../gfx/flc';
import { parseSmp } from '../gfx/smp';
import { countOwnerPixels, parseSpr } from '../gfx/spr';
import { parseWave } from '../gfx/wave';
import { sha256Hex } from '../io/hash';
import { findCaseInsensitive, isFile, readFileRO } from '../io/readOnly';
import { writeCanonicalJson } from '../io/writeCanonicalJson';
import { loadRawSource, sourceDef } from '../map/sources';
import { MkfArchive } from '../mkf/container';
import {
  type AudioFormat,
  type AudioKind,
  type BuiltFile,
  buildAudio,
  buildMusicMap,
  buildSfxSets,
  buildVoiceMap,
  type MusicTrackState,
  type SourceRecord,
} from './audio';
import {
  CATALOG_MKF_FILES,
  CATALOG_MKFS,
  type Catalog,
  type CatalogItem,
  type CatalogMkf,
  type CoverageReport,
  catalogCoverage,
  catalogV206,
  type FlicItem,
  frameBase,
  IMAGE_TOKENS,
  type ImageToken,
  itemSrc,
  mkfDir,
  type SpriteItem,
  TAIWAN,
  TAIWAN_COMPANY_SPRITES,
  TAIWAN_SCENERY_SPRITES,
  validateCatalog,
} from './catalog.v206';
import { MUSIC_TRACKS } from './data/music';
import { EFFECT_COUNT, EFFECT_EMPTY_IDS } from './data/sfx';
import { VIDEOS } from './data/video';
import { SPEAKING_COUNT } from './data/voice';
import { loadFlicMap } from './flicMap';
import { buildAtlasPages, groundChunks, maskPng, raw16Png, smpFrameSet, sprFrameSet } from './images';
import { DEFAULT_PACK_DIR, PackWriter, pruneStalePack, resolvePackOutputDir } from './manifest';
import {
  type AudioSourceInfo,
  audioEntries,
  flicInfo,
  sfxKey,
  toFlicMapV1,
  toMusicMapV1,
  toSfxSetsV1,
  toVoiceMapV1,
  videoKey,
  voiceCharIndex,
} from './mediaMaps';
import { checkClaimable, claimOutputDir, resolveOutputDir } from './outputDir';
import { buildOriginalSkin, type ViewTablesInput } from './skin';
import { buildVideo } from './video';

/** `--only` 的取值：图像四类 + audio（语音与音效）+ music + video */
export type BuildPart = ImageToken | 'audio' | 'music' | 'video';
export const BUILD_PARTS: readonly BuildPart[] = [...IMAGE_TOKENS, 'audio', 'music', 'video'];
/** 默认构建的部分（视频需显式开启） */
export const DEFAULT_PARTS: readonly BuildPart[] = [...IMAGE_TOKENS, 'audio', 'music'];

/** 默认 MapDef（map build / pack 的输出，已被 git 忽略） */
export const DEFAULT_MAP_DATA = path.join('rich4-data', 'maps', 'taiwan.map.json');

export interface PackBuildOptions {
  ctx?: ExtractContext;
  /** Steam Media 目录；默认 <srcDir>/Media */
  mediaDir?: string;
  /** 输出目录；默认 rich4-assets/（必须是已被 git 忽略的 rich4-assets/ 或 .cache/ 下的目录，见 ./outputDir） */
  outDir?: string;
  /** 允许输出到仓库外（CLI --allow-outside-repo）；默认 false */
  allowOutsideRepo?: boolean;
  only?: readonly BuildPart[];
  formats?: readonly AudioFormat[];
  jobs?: number;
  /** 指纹不在 known-files 时仍继续（manifest 照常写，exeSha256 可为 null） */
  allowUnknown?: boolean;
  /** 测试注入：资源目录 */
  catalog?: Catalog;
  /** 台湾 MapDef（默认 rich4-data/maps/taiwan.map.json） */
  mapData?: string;
  /** 测试注入：exe 视角表；缺省从 .cache/extract/tables.v206.json 读取（与 exe 哈希不符时现场抽取） */
  viewTables?: ViewTablesInput;
  /** 默认 true：写出 manifest 后删除不再引用的旧产物 */
  prune?: boolean;
  /** 报告目录；默认 <cacheDir>/assets */
  reportDir?: string;
  ffmpeg?: string;
  ffprobe?: string;
  log?: Logger;
}

export interface PackBuildResult {
  outDir: string;
  manifest: PackManifestV1;
  manifestSha256: string;
  manifestBytes: number;
  totalBytes: number;
  groupBytes: Record<string, number>;
  coverage: CoverageReport & { audio: AudioCoverage | null };
  warnings: string[];
  pruned: string[];
  reportFiles: string[];
}

export interface AudioCoverage {
  voice: { total: number; built: number };
  sfx: { total: number; empty: number; built: number };
  music: { total: number; built: number };
}

interface LoadedMkf {
  mkf: CatalogMkf;
  rel: string;
  archive: MkfArchive;
  sha256: string;
  bytes: number;
}

async function locateOriginal(srcDir: string, rel: string): Promise<string | null> {
  return findCaseInsensitive(srcDir, rel);
}

function missing(what: string): ExtractError {
  return new ExtractError('E_ASSETS_SOURCE_MISSING', `缺少${what}`, ExitCode.MISSING_INPUT);
}

/** 解析 --only（逗号分隔）；空或未给出时用默认部分，--video 另加 video */
export function parseParts(only: string | undefined, video = false): BuildPart[] {
  const raw =
    only === undefined
      ? [...DEFAULT_PARTS]
      : only
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
  const alias: Readonly<Record<string, BuildPart>> = {
    minigames: 'minigame',
    mg: 'minigame',
    voice: 'audio',
    sfx: 'audio',
  };
  const out = new Set<BuildPart>();
  for (const s of raw) {
    const p = (alias[s] ?? s) as BuildPart;
    if (!BUILD_PARTS.includes(p)) {
      throw new ExtractError('E_ARGS', `--only 只接受 ${BUILD_PARTS.join(',')}：${s}`);
    }
    out.add(p);
  }
  if (video) out.add('video');
  return BUILD_PARTS.filter((p) => out.has(p));
}

function vorbisInfo(bytes: Uint8Array): AudioSourceInfo | null {
  const sig = [1, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73];
  const lim = Math.min(bytes.length - 16, 512);
  for (let i = 0; i < lim; i++) {
    if (sig.every((b, k) => bytes[i + k] === b)) {
      const ch = bytes[i + 11]!;
      const rate = (bytes[i + 12]! | (bytes[i + 13]! << 8) | (bytes[i + 14]! << 16) | (bytes[i + 15]! << 24)) >>> 0;
      if ((ch === 1 || ch === 2) && rate > 0) return { channels: ch as 1 | 2, sampleRate: rate };
    }
  }
  return null;
}

/** 视角表：优先读 .cache/extract/tables.v206.json（exe 哈希须一致），否则现场从 exe 抽取 */
async function loadViewTables(ctx: ExtractContext, exeSha: string | null, log: Logger): Promise<ViewTablesInput> {
  const cached = await readCachedTables(ctx, 'v206');
  if (cached?.view && (exeSha === null || cached.exe.sha256 === exeSha)) return cached.view;
  log.out('  视角表缓存缺失或与 exe 不符，现场抽取 v2.06 exe 表');
  const t = (await extractEditions(ctx, ['v206'])).v206;
  if (!t?.view) throw new ExtractError('E_ASSETS_VIEW', 'exe 表抽取未得到视角表（view）');
  return t.view;
}

/**
 * 构建素材包。缺少原版文件、ffmpeg（指定 audio/music/video 时）抛 ExtractError（exit 2）；
 * 指纹未知且未 allowUnknown 抛 exit 3；结构/帧数与目录不符、契约校验失败抛 exit 1。
 */
export async function buildPack(opts: PackBuildOptions = {}): Promise<PackBuildResult> {
  const ctx = opts.ctx ?? new ExtractContext();
  const log = opts.log ?? ctx.log;
  const cat = opts.catalog ?? catalogV206();
  const parts = new Set(opts.only ?? DEFAULT_PARTS);
  const tokens = new Set(IMAGE_TOKENS.filter((t) => parts.has(t)));
  const srcDir = ctx.srcDir;
  const mediaDir = opts.mediaDir ? path.resolve(ctx.root, opts.mediaDir) : path.join(srcDir, 'Media');
  const guard = { allowOutsideRepo: opts.allowOutsideRepo === true };
  const outDir = resolvePackOutputDir(ctx, opts.outDir ?? DEFAULT_PACK_DIR, guard);
  const reportDir = resolveOutputDir(ctx, opts.reportDir ?? ctx.cachePath('assets'), guard);
  await checkClaimable(ctx, outDir);
  const warnings: string[] = [];
  const catIssues = validateCatalog(cat);
  if (catIssues.length > 0) throw new ExtractError('E_ASSETS_CATALOG', catIssues.slice(0, 10).join('；'));
  log.out(`素材包：输出 ${ctx.displayPath(outDir)}，部分 ${[...parts].join(',')}`);

  // ── 指纹：exe 与 map.mkf 必须是登记过的 v2.06 文件 ──
  let known: KnownFiles | null = null;
  try {
    known = await loadKnownFiles(ctx.packageDir);
  } catch {
    known = null;
  }
  const sourceFiles: Record<string, { sha256: string; bytes: number }> = {};
  const addSource = (r: SourceRecord | { file: string; sha256: string; bytes: number }) => {
    sourceFiles[r.file] = { sha256: r.sha256, bytes: r.bytes };
  };
  const relOf = (abs: string) => path.relative(srcDir, abs).split(path.sep).join('/');
  let exeSha: string | null = null;
  const exePath = await locateOriginal(srcDir, 'Game/RICH4.EXE');
  if (exePath) {
    const b = await readFileRO(exePath);
    exeSha = sha256Hex(b);
    addSource({ file: relOf(exePath), sha256: exeSha, bytes: b.length });
    const hit = known?.files.find((f) => f.sha256 === exeSha && f.role === 'exe' && f.edition === 'v206');
    if (!hit && !opts.allowUnknown) {
      throw new ExtractError(
        'E_ASSETS_FINGERPRINT',
        `${relOf(exePath)} 的指纹 ${exeSha.slice(0, 12)}… 不是登记过的 v2.06 exe（可加 --allow-unknown）`,
        ExitCode.UNKNOWN_FINGERPRINT,
      );
    }
    if (!hit) warnings.push(`exe 指纹未登记：${exeSha}`);
  } else if (!opts.allowUnknown) {
    throw missing(`原版 exe：${ctx.displayPath(path.join(srcDir, 'Game/RICH4.EXE'))}`);
  }

  // ── 读取图像 MKF ──
  const needed = new Set<CatalogMkf>();
  for (const it of cat.items) if (tokens.has(it.token)) needed.add(it.mkf);
  const archives = new Map<CatalogMkf, LoadedMkf>();
  for (const m of CATALOG_MKFS) {
    if (!needed.has(m)) continue;
    const p = await locateOriginal(srcDir, CATALOG_MKF_FILES[m]);
    if (!p) throw missing(`原版文件：${ctx.displayPath(path.join(srcDir, CATALOG_MKF_FILES[m]))}`);
    const bytes = await readFileRO(p);
    const rel = relOf(p);
    const sha = sha256Hex(bytes);
    const archive = MkfArchive.open(bytes, rel);
    if (archive.count !== cat.counts[m]) {
      throw new ExtractError(
        'E_ASSETS_STRUCTURE',
        `${rel}: 资源数 ${archive.count}，目录期望 ${cat.counts[m]}（不是 v2.06？）`,
      );
    }
    if (m === 'map') {
      const hit = known?.files.find((f) => f.sha256 === sha && f.role === 'mapmkf' && f.edition === 'v206');
      if (!hit && !opts.allowUnknown) {
        throw new ExtractError(
          'E_ASSETS_FINGERPRINT',
          `${rel} 的指纹不是登记过的 v2.06 map.mkf（可加 --allow-unknown）`,
          ExitCode.UNKNOWN_FINGERPRINT,
        );
      }
    }
    archives.set(m, { mkf: m, rel, archive, sha256: sha, bytes: bytes.length });
    addSource({ file: rel, sha256: sha, bytes: bytes.length });
  }

  // 认领输出目录（写入归属标记）；非空且不是 rich4-extract 生成的目录直接拒绝，清理旧产物只在认领过的目录里进行
  await claimOutputDir(ctx, outDir);
  const writer = new PackWriter(ctx, outDir, 'original');
  let ffmpegVersion: string | null = null;

  // ── 音频（A3）：先做，FLIC 条目的同步音效要引用 sfx 条目 ──
  const audioKinds: AudioKind[] = [];
  if (parts.has('audio')) audioKinds.push('voice', 'sfx');
  if (parts.has('music')) audioKinds.push('music');
  let audioCov: AudioCoverage | null = null;
  const dataMaps: {
    voice?: ReturnType<typeof toVoiceMapV1>;
    sfx?: ReturnType<typeof toSfxSetsV1>;
    music?: ReturnType<typeof toMusicMapV1>;
  } = {};
  if (audioKinds.length > 0) {
    const res = await buildAudio({
      ctx,
      srcDir,
      mediaDir,
      outDir,
      ...guard,
      ...(opts.formats ? { formats: opts.formats } : {}),
      only: audioKinds,
      ...(opts.jobs ? { jobs: opts.jobs } : {}),
      ...(opts.ffmpeg ? { ffmpeg: opts.ffmpeg } : {}),
      ...(opts.ffprobe ? { ffprobe: opts.ffprobe } : {}),
      prune: true,
      writeMaps: false,
      log,
    });
    ffmpegVersion = res.tools.ffmpeg;
    warnings.push(...res.warnings);
    for (const s of res.sources) addSource(s);
    const formats = [...new Set(res.files.map((f) => f.format))].filter(
      (f): f is AudioFormat => f === 'opus' || f === 'm4a',
    );
    // 源信息（采样率、声道）
    const wavInfo = new Map<string, AudioSourceInfo>();
    for (const kind of ['voice', 'sfx'] as const) {
      if (!audioKinds.includes(kind)) continue;
      const rel = kind === 'voice' ? 'Game/Speaking.mkf' : 'Game/Effect.mkf';
      const p = await locateOriginal(srcDir, rel);
      if (!p) throw missing(`原版文件：${rel}`);
      const a = MkfArchive.open(await readFileRO(p), rel);
      for (const e of a.entries()) {
        if (e.rawSize === 0) continue;
        const w = parseWave(a.read(e.index), `${rel}#${e.index}`, { exactLength: false });
        wavInfo.set(`${kind}:${e.index}`, { sampleRate: w.sampleRate, channels: w.channels === 2 ? 2 : 1 });
      }
    }
    const musicInfo = new Map<number, AudioSourceInfo>();
    for (const t of MUSIC_TRACKS) {
      if (!audioKinds.includes('music')) break;
      const p = await findCaseInsensitive(mediaDir, `Music/track${String(t.track).padStart(2, '0')}.ogg`);
      if (!p) continue;
      const fh = await readFileRO(p);
      const vi = vorbisInfo(fh.subarray(0, 1024));
      if (vi) musicInfo.set(t.track, vi);
    }
    // A3 详表（与 A3 writeMaps 的内容相同，只是放到 data/detail/）
    const voiceFiles = res.files.filter((f) => f.kind === 'voice');
    const sfxFiles = res.files.filter((f) => f.kind === 'sfx');
    const musicFiles = res.files.filter((f) => f.kind === 'music');
    const durations = (n: number, files: BuiltFile[]) => {
      const d = new Array<number>(n).fill(0);
      for (const f of files) if (f.source?.res !== undefined) d[f.source.res] = f.source.durationMs ?? 0;
      return d;
    };
    const vm = audioKinds.includes('voice')
      ? buildVoiceMap({ formats, durationsMs: durations(SPEAKING_COUNT, voiceFiles) })
      : null;
    const sm = audioKinds.includes('sfx')
      ? buildSfxSets({ formats, durationsMs: durations(EFFECT_COUNT, sfxFiles) })
      : null;
    let mm: ReturnType<typeof buildMusicMap> | null = null;
    if (audioKinds.includes('music')) {
      const states: MusicTrackState[] = [];
      for (const t of MUSIC_TRACKS) {
        const f = musicFiles.find((x) => x.key.startsWith(`audio/music/track${String(t.track).padStart(2, '0')}.`));
        const srcMs = f?.source?.durationMs ?? t.srcDurationMs;
        const trim = srcMs === t.srcDurationMs ? t.loop : null;
        const eff = trim && (trim.startMs > 0 || trim.endMs < srcMs) ? trim : null;
        states.push({ track: t.track, trim: eff, srcDurationMs: srcMs });
      }
      mm = buildMusicMap({ formats, tracks: states });
    }
    const charOf = vm ? voiceCharIndex(vm) : new Map<number, number>();
    const info = (kind: 'voice' | 'sfx' | 'music', id: number): AudioSourceInfo => {
      if (kind === 'music') return musicInfo.get(id) ?? { sampleRate: 44100, channels: 2 };
      const w = wavInfo.get(`${kind}:${id}`);
      if (!w) throw new ExtractError('E_ASSETS_AUDIO', `找不到 ${kind} ${id} 的源 WAV 信息`);
      return w;
    };
    for (const a of audioEntries(res.files, info, (id) => charOf.get(id))) {
      for (const f of a.files) writer.adoptFile(f.key, f, 'audio', a.group);
      writer.addEntry(a.key, a.entry);
    }
    const has = (k: string) => writer.hasEntry(k);
    if (vm) {
      await writer.writeJson('data/detail/voice-map.json', vm, 'data', 'data');
      dataMaps.voice = toVoiceMapV1(vm);
    }
    if (sm) {
      await writer.writeJson('data/detail/sfx-sets.json', sm, 'data', 'data');
      dataMaps.sfx = toSfxSetsV1(sm, has);
    }
    if (mm) {
      await writer.writeJson('data/detail/music-map.json', mm, 'data', 'data');
      dataMaps.music = toMusicMapV1(mm, has);
    }
    audioCov = {
      voice: { total: SPEAKING_COUNT, built: new Set(voiceFiles.map((f) => f.source?.res)).size },
      sfx: {
        total: EFFECT_COUNT,
        empty: EFFECT_EMPTY_IDS.length,
        built: new Set(sfxFiles.map((f) => f.source?.res)).size,
      },
      music: {
        total: MUSIC_TRACKS.length,
        built: new Set(musicFiles.map((f) => f.key.replace(/\.[a-z0-9]+$/, ''))).size,
      },
    };
  }

  // ── 图像与 FLIC（按目录顺序）──
  const flicInfos: { key: string; info: FlicInfo }[] = [];
  const groundOut = new Map<
    string,
    {
      item: CatalogItem;
      world: { w: number; h: number };
      chunks: { file: string; x: number; y: number; w: number; h: number }[];
    }
  >();
  const atlasOf = new Map<string, AtlasV1[]>();
  let done = 0;
  const selected = cat.items.filter((it) => tokens.has(it.token));
  for (const it of selected) {
    const a = archives.get(it.mkf)!.archive;
    const e = a.entry(it.res);
    const label = `${it.mkf}#${it.res}`;
    if (e.kind !== it.kind)
      throw new ExtractError('E_ASSETS_KIND', `${label}（${it.key}）: 实际类型 ${e.kind}，目录期望 ${it.kind}`);
    const data = a.read(it.res);
    const src = itemSrc(it);
    switch (it.type) {
      case 'sprite':
        await buildSprite(writer, it, data, src, atlasOf, warnings);
        break;
      case 'image': {
        const logical = `images/${mkfDir(it.mkf)}/${it.res}.png`;
        await writer.writeFile(
          logical,
          raw16Png(data, { w: it.w, h: it.h }, it.transparency, label),
          'image',
          it.group,
        );
        writer.addEntry(it.key, {
          type: 'image',
          group: it.group,
          confidence: it.confidence,
          src,
          file: logical,
          w: it.w,
          h: it.h,
          transparency: it.transparency,
          anchor: null,
        });
        break;
      }
      case 'mask': {
        const logical = `masks/${mkfDir(it.mkf)}/${it.res}.png`;
        const m = maskPng(data, { w: it.w, h: it.h });
        if (m.maxRegion !== it.regions) {
          throw new ExtractError(
            'E_ASSETS_MASK',
            `${label}（${it.key}）: 最大区号 ${m.maxRegion}，目录期望 ${it.regions}`,
          );
        }
        await writer.writeFile(logical, m.bytes, 'mask', it.group);
        writer.addEntry(it.key, {
          type: 'mask',
          group: it.group,
          confidence: it.confidence,
          src,
          file: logical,
          w: it.w,
          h: it.h,
          regions: m.maxRegion,
        });
        break;
      }
      case 'flic': {
        const d = it.def;
        const flc = parseFlc(data, label);
        if (flc.width !== d.w || flc.height !== d.h || flc.frames !== d.frames || flc.speed !== d.frameMs) {
          throw new ExtractError(
            'E_ASSETS_FLIC',
            `${label}: 头部 ${flc.width}×${flc.height} n=${flc.frames} ms=${flc.speed} 与 flic 表 ${d.w}×${d.h} n=${d.frames} ms=${d.frameMs} 不符`,
          );
        }
        const logical = `flic/${mkfDir(it.mkf)}/${it.res}.flc`;
        await writer.writeFile(logical, data, 'flic', it.group);
        const sfx = d.sfx !== null && writer.hasEntry(sfxKey(d.sfx)) ? sfxKey(d.sfx) : null;
        writer.addEntry(it.key, {
          type: 'flic',
          group: it.group,
          confidence: it.confidence,
          src,
          file: logical,
          w: d.w,
          h: d.h,
          frames: d.frames,
          frameMs: d.frameMs,
          durationMs: d.frames * d.frameMs,
          transparency: d.opaque ? 'opaque' : 'index0',
          sfx,
        });
        flicInfos.push({ key: it.key, info: flicInfo(it as FlicItem, sfx) });
        break;
      }
      case 'ground': {
        const g = groundChunks(data, it.mapId, it.cols, it.rows, 1, label);
        const chunks = [];
        for (const c of g.chunks) {
          await writer.writeFile(c.path, c.bytes, 'image', it.group);
          chunks.push({ file: c.path, x: c.x, y: c.y, w: c.w, h: c.h });
        }
        groundOut.set(it.mapId, { item: it, world: g.world, chunks });
        break;
      }
    }
    done++;
    if (done % 100 === 0) log.out(`  图像：${done}/${selected.length}`);
  }
  if (selected.length > 0) log.out(`  图像：${selected.length} 项完成`);

  // ── 地图皮肤 ──
  const skins: MapSkinV1[] = [];
  for (const [mapId, g] of groundOut) {
    if (mapId !== TAIWAN.mapId) throw new ExtractError('E_ASSETS_MAP', `不支持的地图皮肤：${mapId}`);
    const mapPath = path.resolve(ctx.root, opts.mapData ?? DEFAULT_MAP_DATA);
    if (!(await isFile(mapPath))) {
      throw missing(`台湾 MapDef：${ctx.displayPath(mapPath)}（先运行 map build --map taiwan 与 pack）`);
    }
    const def: MapDef = parseMapDef(JSON.parse(await readFile(mapPath, 'utf8')));
    const srcId = 'id' in def.meta.source ? String((def.meta.source as { id?: string }).id) : 'v206-mapdat';
    const { raw } = await loadRawSource(ctx, sourceDef(srcId), TAIWAN.gm, known);
    const rawStat = await stat(path.join(srcDir, ...raw.source.file.split('/')));
    addSource({ file: raw.source.file, sha256: raw.source.fileSha256, bytes: rawStat.size });
    const view = opts.viewTables ?? (await loadViewTables(ctx, exeSha, log));
    const decorEntry = writer.entry('board.decor');
    const skin = buildOriginalSkin({
      mapDef: def,
      raw,
      view,
      world: g.world,
      ground: { chunks: g.chunks, overlap: 1 },
      decorFrames: decorEntry?.type === 'sprite' ? decorEntry.frames.count : 17,
      keys: {
        minimap: writer.hasEntry('map.taiwan.minimap') ? 'map.taiwan.minimap' : null,
        decor: 'board.decor',
        houses: [1, 2, 3, 4, 5].map((L) => `map.taiwan.house.${L}`),
        chain: 'board.chain',
        ownerMark: 'board.ownerMark',
        lotHighlight: 'board.lotHighlight',
      },
      src: [`${raw.source.file}#${raw.source.resource}`, 'exe 视角表拟合（dy 外层、(sy,sx)）', 'render.md'],
      expectSprites: { companies: TAIWAN_COMPANY_SPRITES, scenery: TAIWAN_SCENERY_SPRITES },
    });
    const logical = `maps/${mapId}.skin.json`;
    await writer.writeJson(logical, skin, 'mapskin', g.item.group);
    writer.addMap(mapId, { skin: logical, group: g.item.group, binding: skin.binding });
    skins.push(skin);
  }

  // ── 映射表 ──
  const dataEntry = (
    file: string,
    schema: 'rich4.voicemap/1' | 'rich4.sfxsets/1' | 'rich4.musicmap/1' | 'rich4.flicmap/1',
    src: string[],
  ): AssetEntry => ({
    type: 'data',
    group: 'data',
    confidence: 'exe',
    src,
    file,
    schema,
  });
  let flicMap: ReturnType<typeof toFlicMapV1> | null = null;
  if (flicInfos.length > 0) {
    await writer.writeJson('data/detail/flic-map.json', loadFlicMap(), 'data', 'data');
    flicMap = toFlicMapV1(flicInfos);
    await writer.writeJson('data/flic-map.json', flicMap, 'data', 'data');
    writer.addEntry('data.flic-map', dataEntry('data/flic-map.json', 'rich4.flicmap/1', ['data/detail/flic-map.json']));
  }
  if (dataMaps.voice) {
    await writer.writeJson('data/voice-map.json', dataMaps.voice, 'data', 'data');
    writer.addEntry(
      'data.voice-map',
      dataEntry('data/voice-map.json', 'rich4.voicemap/1', ['data/detail/voice-map.json']),
    );
  }
  if (dataMaps.sfx) {
    await writer.writeJson('data/sfx-sets.json', dataMaps.sfx, 'data', 'data');
    writer.addEntry('data.sfx-sets', dataEntry('data/sfx-sets.json', 'rich4.sfxsets/1', ['data/detail/sfx-sets.json']));
  }
  if (dataMaps.music) {
    await writer.writeJson('data/music-map.json', dataMaps.music, 'data', 'data');
    writer.addEntry(
      'data.music-map',
      dataEntry('data/music-map.json', 'rich4.musicmap/1', ['data/detail/music-map.json']),
    );
  }

  // ── 视频（A3，可选）──
  if (parts.has('video')) {
    const res = await buildVideo({
      ctx,
      srcDir,
      mediaDir,
      outDir,
      ...guard,
      set: 'v206',
      ...(opts.ffmpeg ? { ffmpeg: opts.ffmpeg } : {}),
      ...(opts.ffprobe ? { ffprobe: opts.ffprobe } : {}),
      log,
    });
    ffmpegVersion = res.tools.ffmpeg;
    warnings.push(...res.warnings);
    for (const s of res.sources) addSource(s);
    for (const f of res.files) {
      if (f.kind === 'data') {
        writer.adoptFile(f.key, f, 'data', 'data');
        continue;
      }
      const name = /^video\/([a-z0-9]+)\.mp4$/.exec(f.key)?.[1];
      const def = VIDEOS.find((v) => v.key === name);
      if (!name || !def) throw new ExtractError('E_ASSETS_VIDEO', `无法识别的视频产物 ${f.key}`);
      writer.adoptFile(f.key, f, 'video', 'video');
      writer.addEntry(videoKey(name), {
        type: 'video',
        group: 'video',
        confidence: def.confidence,
        src: [f.source?.file ?? `Media/${def.file}`],
        files: { mp4: f.key },
        w: def.w,
        h: def.h,
        durationMs: Math.max(1, f.durationMs ?? def.srcDurationMs),
      });
    }
  }

  // ── manifest ──
  const byCp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const sortedSource: Record<string, { sha256: string; bytes: number }> = {};
  for (const k of Object.keys(sourceFiles).sort(byCp)) sortedSource[k] = sourceFiles[k]!;
  const built = (tok: ImageToken) => selected.some((it) => it.token === tok);
  const manifest = writer.manifest({
    edition: 'v206',
    source: { files: sortedSource, exeSha256: exeSha },
    tools: { ffmpeg: ffmpegVersion },
    features: {
      board: built('board'),
      ui: built('ui'),
      fx: built('fx'),
      minigames: built('minigame'),
      audio: parts.has('audio'),
      voice: parts.has('audio'),
      music: parts.has('music'),
      video: parts.has('video'),
    },
  });
  const issues: ContractIssue[] = [];
  for (const [lp, pages] of atlasOf) {
    pages.forEach((p, i) => {
      issues.push(...checkAtlasRefs(manifest, pageJsonPath(lp, i), p));
    });
  }
  for (const [key, e] of Object.entries(manifest.entries)) {
    if (e.type !== 'sprite') continue;
    const pages = atlasOf.get(e.atlas[0]!) ?? [];
    for (const i of checkSpriteFrames(e, pages)) issues.push({ path: [key, ...i.path], message: i.message });
  }
  for (const s of skins) issues.push(...checkMapSkinRefs(manifest, s));
  if (flicMap) issues.push(...checkFlicMapRefs(manifest, flicMap));
  if (dataMaps.voice) issues.push(...checkVoiceMapRefs(manifest, dataMaps.voice));
  if (dataMaps.sfx) issues.push(...checkSfxSetsRefs(manifest, dataMaps.sfx));
  if (dataMaps.music) issues.push(...checkMusicMapRefs(manifest, dataMaps.music));
  if (issues.length > 0) {
    throw new ExtractError(
      'E_ASSETS_CROSSREF',
      issues
        .slice(0, 10)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('；'),
    );
  }
  const written = await writer.writeManifest(manifest);
  const pruned = (opts.prune ?? true) ? await pruneStalePack(ctx, outDir, manifest) : [];

  // ── 报告（.cache，不进素材包）──
  const groupBytes: Record<string, number> = {};
  for (const [g, grp] of Object.entries(manifest.groups)) groupBytes[g] = grp.bytes;
  const totalBytes = Object.values(manifest.files).reduce((s, f) => s + f.bytes, 0);
  const coverage = { ...catalogCoverage(cat), audio: audioCov };
  const reportFiles = [
    await writeCanonicalJson(ctx, path.join(reportDir, `coverage.${cat.edition}.json`), coverage),
    await writeCanonicalJson(ctx, path.join(reportDir, `uncataloged.${cat.edition}.json`), {
      schema: 'rich4.assets-uncataloged/1',
      edition: cat.edition,
      uncataloged: CATALOG_MKFS.flatMap((m) =>
        coverage.archives[m].uncataloged.map((res) => ({
          mkf: m,
          res,
          kind: archives.get(m)?.archive.entry(res).kind ?? null,
        })),
      ),
      exclusions: coverage.exclusions,
    }),
    await writeCanonicalJson(ctx, path.join(reportDir, `build.${cat.edition}.json`), {
      schema: 'rich4.assets-build/1',
      packId: manifest.packId,
      manifestSha256: written.sha256,
      tools: { ffmpeg: ffmpegVersion, node: process.versions.node, zlib: process.versions.zlib },
      files: Object.keys(manifest.files).length,
      entries: Object.keys(manifest.entries).length,
      totalBytes,
      groups: groupBytes,
      features: manifest.features,
      warnings,
    }),
  ];
  log.out(
    `素材包完成：${Object.keys(manifest.files).length} 个文件、${Object.keys(manifest.entries).length} 个条目，` +
      `合计 ${(totalBytes / 1048576).toFixed(2)} MB；packId ${manifest.packId}；manifest sha256 ${written.sha256}`,
  );
  if (pruned.length > 0) log.out(`  清理旧产物 ${pruned.length} 个`);
  return {
    outDir,
    manifest,
    manifestSha256: written.sha256,
    manifestBytes: written.bytes,
    totalBytes,
    groupBytes,
    coverage,
    warnings,
    pruned,
    reportFiles,
  };
}

/** 图集第 i 页的 JSON 逻辑路径（与 images.ts 的命名一致） */
function pageJsonPath(first: string, i: number): string {
  return i === 0 ? first : first.replace(/\.json$/, `-${i}.json`);
}

async function buildSprite(
  writer: PackWriter,
  it: SpriteItem,
  data: Uint8Array,
  src: string[],
  atlasOf: Map<string, AtlasV1[]>,
  warnings: string[],
): Promise<void> {
  const label = `${it.mkf}#${it.res}`;
  const sheet = it.kind === 'SPR' ? parseSpr(data, label) : parseSmp(data, label);
  const n = sheet.count;
  const okFrames = it.frames === 'x8' ? n > 0 && n % 8 === 0 : n === it.frames;
  if (!okFrames) {
    throw new ExtractError('E_ASSETS_FRAMES', `${label}（${it.key}）: 帧数 ${n}，目录期望 ${it.frames}`);
  }
  if (it.ownerMask && sheet.kind === 'SPR' && countOwnerPixels(sheet) === 0) {
    warnings.push(`${label}（${it.key}）: 标为建筑类但没有索引 255 像素`);
  }
  const set = sheet.kind === 'SPR' ? sprFrameSet(sheet, it.ownerMask) : smpFrameSet(sheet);
  const pages = buildAtlasPages({
    dir: `sprites/${mkfDir(it.mkf)}`,
    name: String(it.res),
    base: frameBase(it),
    set,
    transparency: it.transparency,
    src,
  });
  for (const p of pages) {
    await writer.writeFile(p.imagePath, p.imageBytes, 'image', it.group);
    if (p.maskPath && p.maskBytes) await writer.writeFile(p.maskPath, p.maskBytes, 'image', it.group);
    await writer.writeFile(p.jsonPath, p.jsonBytes, 'atlas', it.group);
  }
  atlasOf.set(
    pages[0]!.jsonPath,
    pages.map((p) => p.atlas),
  );
  writer.addEntry(it.key, {
    type: 'sprite',
    group: it.group,
    confidence: it.confidence,
    src,
    atlas: pages.map((p) => p.jsonPath),
    frames: { base: frameBase(it), start: 0, count: n },
    dirs: it.dirs,
    frameMs: null,
    transparency: it.transparency,
    ownerMask: it.ownerMask,
    anchor: it.anchor,
  });
}
