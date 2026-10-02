/**
 * 原版皮肤 A2：`rich4-extract assets verify [--full]`（design-draft §2.7）。
 *
 * 默认：manifest 结构与一致性（zod）→ 逐文件复算 sha256（含预压缩变体）→ 图集 / 地图皮肤 / 映射表的 JSON 契约与交叉引用 →
 *       资源目录覆盖（原版包：各已构建部分的每个目录项都有条目；有地面但没有地图皮肤的图只告警）→
 *       列出受管目录里未被引用的杂散文件（只告警）。
 * --full：另外逐个解码 PNG（CRC、尺寸与图集/条目一致、原版派生标记）、解析 FLC 头（尺寸、帧数、帧间隔）、
 *        检查音视频文件头尾的派生标记（RICH4_DERIVED）、预压缩变体解压后与原文件一致。
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import {
  type AtlasV1,
  checkAtlasRefs,
  checkFlicMapRefs,
  checkMapSkinRefs,
  checkMusicMapRefs,
  checkSfxSetsRefs,
  checkSpriteFrames,
  checkVoiceMapRefs,
  DERIVED_MARKERS,
  type PackManifestV1,
  safeParseAtlas,
  safeParseFlicMap,
  safeParseMapSkin,
  safeParseMusicMap,
  safeParsePackManifest,
  safeParseSfxSets,
  safeParseVoiceMap,
} from '@rich4/shared/assets';
import { type ExtractContext, ExtractError, type Logger } from '../context';
import { parseFlc } from '../gfx/flc';
import { sha256Hex } from '../io/hash';
import { type Catalog, catalogV206, type ImageToken } from './catalog.v206';
import { listPackFiles, MANIFEST_FILE, referencedPaths } from './manifest';
import { readPng } from './pngRead';

export interface VerifyOptions {
  ctx: ExtractContext;
  /** 素材包目录（绝对路径） */
  packDir: string;
  full?: boolean;
  catalog?: Catalog;
  log?: Logger;
}

export interface VerifyResult {
  ok: boolean;
  issues: string[];
  warnings: string[];
  files: number;
  bytes: number;
  /** 未被 manifest 引用的杂散文件 */
  orphans: string[];
  packId: string | null;
}

const MEDIA_WINDOW = 1 << 20;

function hasMediaMarker(b: Uint8Array): boolean {
  const s = (x: Uint8Array) => Buffer.from(x.buffer, x.byteOffset, x.byteLength).toString('latin1');
  const re = /RICH4_DERIVED|rich4-derived/;
  if (b.length <= 2 * MEDIA_WINDOW) return re.test(s(b));
  return re.test(s(b.subarray(0, MEDIA_WINDOW))) || re.test(s(b.subarray(b.length - MEDIA_WINDOW)));
}

export async function verifyPack(opts: VerifyOptions): Promise<VerifyResult> {
  const { ctx, packDir } = opts;
  const log = opts.log ?? ctx.log;
  const issues: string[] = [];
  const warnings: string[] = [];
  const mfPath = path.join(packDir, MANIFEST_FILE);
  let json: unknown;
  try {
    json = JSON.parse(await readFile(mfPath, 'utf8'));
  } catch (e) {
    throw new ExtractError(
      'E_ASSETS_NO_MANIFEST',
      `读不到 ${ctx.displayPath(mfPath)}：${e instanceof Error ? e.message : String(e)}`,
      2,
    );
  }
  const parsed = safeParsePackManifest(json);
  if (!parsed.ok) {
    return {
      ok: false,
      issues: parsed.issues.map((i) => `manifest: ${i}`),
      warnings,
      files: 0,
      bytes: 0,
      orphans: [],
      packId: null,
    };
  }
  const m: PackManifestV1 = parsed.value;
  const readPack = async (rel: string): Promise<Uint8Array | null> => {
    try {
      return new Uint8Array(await readFile(path.join(packDir, ...rel.split('/'))));
    } catch {
      return null;
    }
  };

  // 逐文件：存在、大小、sha256（含变体）
  const content = new Map<string, Uint8Array>();
  let bytes = 0;
  let n = 0;
  for (const [lp, f] of Object.entries(m.files)) {
    const b = await readPack(f.path);
    n++;
    if (!b) {
      issues.push(`${lp}: 缺少文件 ${f.path}`);
      continue;
    }
    bytes += b.length;
    if (b.length !== f.bytes) issues.push(`${lp}: 大小 ${b.length} ≠ manifest ${f.bytes}`);
    else if (sha256Hex(b) !== f.sha256) issues.push(`${lp}: sha256 与 manifest 不符`);
    if (
      f.kind === 'atlas' ||
      f.kind === 'mapskin' ||
      f.kind === 'data' ||
      (opts.full && f.kind !== 'audio' && f.kind !== 'video')
    ) {
      content.set(lp, b);
    }
    for (const [enc, ext] of [
      ['br', '.br'],
      ['gzip', '.gz'],
    ] as const) {
      const v = f.variants?.[enc];
      if (!v) continue;
      const vb = await readPack(`${f.path}${ext}`);
      if (!vb) {
        issues.push(`${lp}: 缺少预压缩变体 ${f.path}${ext}`);
        continue;
      }
      if (vb.length !== v.bytes || sha256Hex(vb) !== v.sha256) issues.push(`${lp}: 变体 ${ext} 与 manifest 不符`);
      else if (opts.full && b) {
        const raw = enc === 'br' ? brotliDecompressSync(vb) : gunzipSync(vb);
        if (sha256Hex(new Uint8Array(raw)) !== f.sha256) issues.push(`${lp}: 变体 ${ext} 解压后与原文件不一致`);
      }
    }
    if (opts.full && (f.kind === 'audio' || f.kind === 'video') && b && !hasMediaMarker(b)) {
      issues.push(`${lp}: 音视频缺少派生标记 ${DERIVED_MARKERS.audioComment}`);
    }
  }
  const text = (lp: string): unknown => {
    const b = content.get(lp);
    return b ? JSON.parse(Buffer.from(b).toString('utf8')) : null;
  };

  // 图集
  const atlases = new Map<string, AtlasV1>();
  for (const [lp, f] of Object.entries(m.files)) {
    if (f.kind !== 'atlas' || !content.has(lp)) continue;
    const r = safeParseAtlas(text(lp));
    if (!r.ok) {
      issues.push(`${lp}: 图集不合契约：${r.issues.slice(0, 3).join('；')}`);
      continue;
    }
    atlases.set(lp, r.value);
    for (const i of checkAtlasRefs(m, lp, r.value)) issues.push(`${lp}: ${i.path.join('.')}: ${i.message}`);
  }
  for (const [key, e] of Object.entries(m.entries)) {
    if (e.type !== 'sprite') continue;
    const pages = e.atlas.map((a) => atlases.get(a)).filter((a): a is AtlasV1 => a !== undefined);
    if (pages.length !== e.atlas.length) continue;
    for (const i of checkSpriteFrames(e, pages)) issues.push(`entries.${key}: ${i.message}`);
  }
  // 地图皮肤
  for (const [id, mp] of Object.entries(m.maps)) {
    const r = safeParseMapSkin(text(mp.skin));
    if (!r.ok) {
      issues.push(`maps.${id}: 地图皮肤不合契约：${r.issues.slice(0, 3).join('；')}`);
      continue;
    }
    for (const i of checkMapSkinRefs(m, r.value)) issues.push(`maps.${id}: ${i.path.join('.')}: ${i.message}`);
  }
  // 映射表
  for (const [key, e] of Object.entries(m.entries)) {
    if (e.type !== 'data') continue;
    const j = text(e.file);
    const refs = (() => {
      switch (e.schema) {
        case 'rich4.voicemap/1': {
          const r = safeParseVoiceMap(j);
          return r.ok ? checkVoiceMapRefs(m, r.value).map((i) => i.message) : r.issues;
        }
        case 'rich4.sfxsets/1': {
          const r = safeParseSfxSets(j);
          return r.ok ? checkSfxSetsRefs(m, r.value).map((i) => i.message) : r.issues;
        }
        case 'rich4.musicmap/1': {
          const r = safeParseMusicMap(j);
          return r.ok ? checkMusicMapRefs(m, r.value).map((i) => i.message) : r.issues;
        }
        case 'rich4.flicmap/1': {
          const r = safeParseFlicMap(j);
          return r.ok ? checkFlicMapRefs(m, r.value).map((i) => i.message) : r.issues;
        }
      }
    })();
    for (const i of refs.slice(0, 5)) issues.push(`entries.${key}: ${i}`);
  }

  // 目录覆盖（原版包）
  if (m.license === 'private-personal-use' && m.generator.startsWith('rich4-extract/assets@') && m.edition === 'v206') {
    const cat = opts.catalog ?? catalogV206();
    const tokenBuilt: Record<ImageToken, boolean> = {
      board: m.features.board,
      ui: m.features.ui,
      fx: m.features.fx,
      minigame: m.features.minigames,
    };
    for (const it of cat.items) {
      if (!tokenBuilt[it.token]) continue;
      if (it.type === 'ground') {
        // 构建时缺该图的 MapDef 会只跳过它的皮肤（assets build 打警告，--strict 才失败）：这里同样只告警
        if (!m.maps[it.mapId]) warnings.push(`目录项 ${it.key}: manifest.maps 没有 ${it.mapId}（该图回退程序化棋盘）`);
      } else if (!m.entries[it.key]) issues.push(`目录项 ${it.key}（${it.mkf}#${it.res}）没有条目`);
    }
  }

  // --full：解码
  if (opts.full) {
    const derived = m.license === 'private-personal-use' && !m.generator.includes('synthetic');
    const pngDims = new Map<string, { w: number; h: number }>();
    for (const [lp, f] of Object.entries(m.files)) {
      const b = content.get(lp);
      if (!b) continue;
      if (f.contentType === 'image/png') {
        try {
          const p = readPng(b, lp);
          pngDims.set(lp, { w: p.w, h: p.h });
          if (derived && p.text[DERIVED_MARKERS.pngTextKeyword] !== DERIVED_MARKERS.pngTextValue) {
            issues.push(`${lp}: PNG 缺少派生标记 tEXt ${DERIVED_MARKERS.pngTextKeyword}`);
          }
        } catch (e) {
          issues.push(`${lp}: PNG 解码失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/') + 1);
    const byPath = new Map(Object.entries(m.files).map(([lp, f]) => [f.path, lp]));
    for (const [lp, a] of atlases) {
      const f = m.files[lp]!;
      for (const name of [a.meta.image, a.meta.r4.mask]) {
        if (name === null) continue;
        const img = byPath.get(dirOf(f.path) + name);
        const d = img ? pngDims.get(img) : undefined;
        if (d && (d.w !== a.meta.size.w || d.h !== a.meta.size.h)) {
          issues.push(`${lp}: 图集页 ${name} 尺寸 ${d.w}×${d.h} ≠ meta.size ${a.meta.size.w}×${a.meta.size.h}`);
        }
      }
    }
    for (const [key, e] of Object.entries(m.entries)) {
      if (e.type === 'image' || e.type === 'mask') {
        const d = pngDims.get(e.file);
        if (d && (d.w !== e.w || d.h !== e.h)) issues.push(`entries.${key}: 图像尺寸 ${d.w}×${d.h} ≠ ${e.w}×${e.h}`);
      }
      if (e.type === 'flic') {
        const b = content.get(e.file);
        if (!b) continue;
        try {
          const flc = parseFlc(b, e.file);
          if (flc.width !== e.w || flc.height !== e.h || flc.frames !== e.frames || flc.speed !== e.frameMs) {
            issues.push(`entries.${key}: FLC 头与条目不符`);
          }
        } catch (err) {
          issues.push(`entries.${key}: FLC 解析失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  // 杂散文件
  const keep = referencedPaths(m);
  const orphans = (await listPackFiles(packDir)).filter((p) => !keep.has(p));
  for (const o of orphans.slice(0, 20)) warnings.push(`未被 manifest 引用的文件：${o}`);
  const st = await stat(mfPath);
  log.out(
    `verify：${n} 个文件（${(bytes / 1048576).toFixed(2)} MB）、${Object.keys(m.entries).length} 个条目、manifest ${st.size} 字节；` +
      `${issues.length} 处不符${opts.full ? '（--full）' : ''}`,
  );
  return { ok: issues.length === 0, issues, warnings, files: n, bytes, orphans, packId: m.packId };
}
