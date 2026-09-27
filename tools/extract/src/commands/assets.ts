/**
 * `rich4-extract assets …` 子命令（docs/design/original-skin.md §5 A2；design-draft §2.1）：
 *   assets build   [--out rich4-assets/] [--only board,ui,fx,minigame,audio,music,video] [--video]
 *                  [--audio opus,m4a] [--media <Steam Media 目录>] [--map-data <taiwan.map.json>] [--jobs 4] [--allow-unknown]
 *   assets verify  [--out rich4-assets/] [--full] [--json]
 *   assets ls      [--out rich4-assets/] [--group board.common] [--json]
 *   assets preview [--pack rich4-assets/] [--out .cache/assets-preview/] [--group …] [--map-data …]
 *   assets synth   [--out .cache/synthetic-pack/]      fixture 地图的合成素材包（CI 用，不入库）
 * 素材包仅供私人与朋友游玩：只写入已被 git 忽略的目录（rich4-assets/ 或 .cache/），拒绝任何位置的 apps/*\/public/**；
 * build / preview / synth 输出到仓库外须显式 --allow-outside-repo（其他 git 工作树里仍按同样规则判定）。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type PackManifestV1, safeParsePackManifest } from '@rich4/shared/assets';
import { AUDIO_FORMATS, type AudioFormat } from '../assets/audio';
import { buildPack, parseParts } from '../assets/build';
import { catalogV206 } from '../assets/catalog.v206';
import { DEFAULT_PACK_DIR, MANIFEST_FILE } from '../assets/manifest';
import { buildPreview, DEFAULT_PREVIEW_DIR } from '../assets/preview';
import { buildSyntheticPack, DEFAULT_SYNTH_DIR } from '../assets/synthetic';
import { verifyPack } from '../assets/verify';
import { ExitCode, type ExtractContext, ExtractError } from '../context';
import { isFile } from '../io/readOnly';
import { ICON, renderTable } from '../report/table';

export interface AssetsArgs {
  out?: string | undefined;
  pack?: string | undefined;
  only?: string | undefined;
  video?: boolean | undefined;
  audio?: string | undefined;
  media?: string | undefined;
  'map-data'?: string | undefined;
  jobs?: string | undefined;
  'allow-unknown'?: boolean | undefined;
  'allow-outside-repo'?: boolean | undefined;
  full?: boolean | undefined;
  group?: string | undefined;
  json?: boolean | undefined;
  verbose?: boolean | undefined;
}

function packDir(ctx: ExtractContext, v: string | undefined): string {
  return path.resolve(ctx.cwd, v ?? path.join(ctx.root, DEFAULT_PACK_DIR));
}

function parseJobs(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v) || Number(v) < 1) throw new ExtractError('E_ARGS', `--jobs 必须是正整数：${v}`);
  return Number(v);
}

function parseFormats(v: string | undefined): AudioFormat[] | undefined {
  if (v === undefined) return undefined;
  const out = v.split(',').map((s) => s.trim());
  for (const f of out) {
    if (!AUDIO_FORMATS.includes(f as AudioFormat)) throw new ExtractError('E_ARGS', `--audio 只接受 opus,m4a：${f}`);
  }
  return out as AudioFormat[];
}

const mb = (n: number) => `${(n / 1048576).toFixed(2)} MB`;

export async function cmdAssetsBuild(ctx: ExtractContext, v: AssetsArgs): Promise<number> {
  const only = parseParts(v.only, v.video === true);
  const jobs = parseJobs(v.jobs);
  const formats = parseFormats(v.audio);
  const r = await buildPack({
    ctx,
    outDir: packDir(ctx, v.out),
    only,
    ...(jobs ? { jobs } : {}),
    ...(formats ? { formats } : {}),
    ...(v.media ? { mediaDir: ctx.resolveUserPath(v.media) } : {}),
    ...(v['map-data'] ? { mapData: ctx.resolveUserPath(v['map-data']) } : {}),
    allowUnknown: v['allow-unknown'] === true,
    allowOutsideRepo: v['allow-outside-repo'] === true,
  });
  if (v.json) {
    ctx.log.out(
      JSON.stringify(
        {
          outDir: ctx.displayPath(r.outDir),
          packId: r.manifest.packId,
          manifestSha256: r.manifestSha256,
          totalBytes: r.totalBytes,
          groups: r.groupBytes,
          coverage: r.coverage.totals,
          warnings: r.warnings,
        },
        null,
        2,
      ),
    );
    return ExitCode.OK;
  }
  const rows = Object.entries(r.groupBytes)
    .sort((a, b) => b[1] - a[1])
    .map(([g, b]) => [g, r.manifest.groups[g]!.category, String(r.manifest.groups[g]!.files.length), mb(b)]);
  for (const l of renderTable(['分组', '类别', '文件', '体积'], rows, '  rr')) ctx.log.out(l);
  const c = r.coverage;
  ctx.log.out(
    `覆盖率：图像资源 ${c.totals.total} 个，收录 ${c.totals.cataloged}（${c.catalogedPercent}%），明确排除 ${c.totals.excluded}，` +
      `未收录 ${c.totals.uncataloged}（合计覆盖 ${c.percent}%）`,
  );
  if (c.audio) {
    ctx.log.out(
      `音频：语音 ${c.audio.voice.built}/${c.audio.voice.total}、音效 ${c.audio.sfx.built}/${c.audio.sfx.total - c.audio.sfx.empty}` +
        `（另 ${c.audio.sfx.empty} 个空资源）、音乐 ${c.audio.music.built}/${c.audio.music.total}`,
    );
  }
  for (const f of r.reportFiles) ctx.log.out(`报告：${ctx.displayPath(f)}`);
  for (const w of r.warnings) ctx.log.out(`${ICON.warn} ${w}`);
  ctx.log.out(
    `${ICON.pass} ${ctx.displayPath(r.outDir)}：${Object.keys(r.manifest.files).length} 个文件，合计 ${mb(r.totalBytes)}；` +
      `manifest ${r.manifestBytes} 字节，sha256 ${r.manifestSha256}`,
  );
  return ExitCode.OK;
}

export async function cmdAssetsVerify(ctx: ExtractContext, v: AssetsArgs): Promise<number> {
  const r = await verifyPack({ ctx, packDir: packDir(ctx, v.out ?? v.pack), full: v.full === true });
  if (v.json) {
    ctx.log.out(JSON.stringify(r, null, 2));
    return r.ok ? ExitCode.OK : ExitCode.STRUCTURE;
  }
  for (const i of r.issues.slice(0, 50)) ctx.log.out(`${ICON.fail} ${i}`);
  if (r.issues.length > 50) ctx.log.out(`… 另有 ${r.issues.length - 50} 处`);
  for (const w of r.warnings) ctx.log.out(`${ICON.warn} ${w}`);
  ctx.log.out(
    r.ok
      ? `${ICON.pass} verify 通过：${r.files} 个文件、${mb(r.bytes)}，0 处不符（packId ${r.packId}）`
      : `${ICON.fail} verify 失败：${r.issues.length} 处不符`,
  );
  return r.ok ? ExitCode.OK : ExitCode.STRUCTURE;
}

async function loadManifest(dir: string): Promise<PackManifestV1 | null> {
  const p = path.join(dir, MANIFEST_FILE);
  if (!(await isFile(p))) return null;
  const r = safeParsePackManifest(JSON.parse(await readFile(p, 'utf8')));
  return r.ok ? r.value : null;
}

export async function cmdAssetsLs(ctx: ExtractContext, v: AssetsArgs): Promise<number> {
  const cat = catalogV206();
  const m = await loadManifest(packDir(ctx, v.out ?? v.pack));
  const want = (g: string) => !v.group || g === v.group || g.startsWith(`${v.group}.`);
  const rows: {
    key: string;
    type: string;
    res: string;
    group: string;
    confidence: string;
    frames: string;
    built: boolean;
    desc: string;
  }[] = [];
  const seen = new Set<string>();
  for (const it of cat.items) {
    if (!want(it.group)) continue;
    const e = m?.entries[it.key];
    seen.add(it.key);
    const frames =
      e?.type === 'sprite'
        ? String(e.frames.count)
        : e?.type === 'flic'
          ? String(e.frames)
          : it.type === 'sprite'
            ? String(it.frames)
            : it.type === 'flic'
              ? String(it.def.frames)
              : '';
    rows.push({
      key: it.key,
      type: it.type,
      res: `${it.mkf}#${it.res}`,
      group: it.group,
      confidence: it.confidence,
      frames,
      built: it.type === 'ground' ? m?.maps[it.mapId] !== undefined : e !== undefined,
      desc: it.desc,
    });
  }
  for (const [key, e] of Object.entries(m?.entries ?? {})) {
    if (seen.has(key) || !want(e.group)) continue;
    rows.push({
      key,
      type: e.type,
      res: e.src[0] ?? '',
      group: e.group,
      confidence: e.confidence,
      frames: '',
      built: true,
      desc: '',
    });
  }
  if (v.json) {
    ctx.log.out(JSON.stringify(rows, null, 2));
    return ExitCode.OK;
  }
  const table = rows.map((r) => [r.built ? ICON.pass : '·', r.key, r.type, r.res, r.group, r.confidence, r.frames]);
  for (const l of renderTable(['', '逻辑键', '类型', '资源', '分组', '置信度', '帧'], table, '      r')) ctx.log.out(l);
  ctx.log.out(
    `${rows.length} 项；${m ? `已构建 ${rows.filter((r) => r.built).length} 项（packId ${m.packId}）` : '没有找到素材包 manifest'}`,
  );
  return ExitCode.OK;
}

export async function cmdAssetsPreview(ctx: ExtractContext, v: AssetsArgs): Promise<number> {
  const r = await buildPreview({
    ctx,
    packDir: packDir(ctx, v.pack),
    outDir: path.resolve(ctx.cwd, v.out ?? path.join(ctx.root, DEFAULT_PREVIEW_DIR)),
    allowOutsideRepo: v['allow-outside-repo'] === true,
    ...(v.group ? { group: v.group } : {}),
    ...(v['map-data'] ? { mapData: ctx.resolveUserPath(v['map-data']) } : {}),
  });
  ctx.log.out(`${ICON.pass} 预览：${ctx.displayPath(r.index)}（本机浏览，勿上传）`);
  return ExitCode.OK;
}

export async function cmdAssetsSynth(ctx: ExtractContext, v: AssetsArgs): Promise<number> {
  const r = await buildSyntheticPack({
    ctx,
    outDir: path.resolve(ctx.cwd, v.out ?? path.join(ctx.root, DEFAULT_SYNTH_DIR)),
    allowOutsideRepo: v['allow-outside-repo'] === true,
  });
  ctx.log.out(`${ICON.pass} 合成素材包：${ctx.displayPath(r.outDir)}（packId ${r.manifest.packId}）`);
  return ExitCode.OK;
}
