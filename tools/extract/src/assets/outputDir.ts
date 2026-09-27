/**
 * 原版皮肤派生物的输出目录守卫（docs/design/original-skin.md §3 修正 5：素材包与所有派生物只写入 rich4-assets/ 或 .cache/**，
 * 拒绝未被 git 忽略的路径与 apps/*\/public/**）。素材包（A2）、A3 暂存、预览、构建报告共用这一个入口，写入口径一致。
 *
 * resolveOutputDir 的判定：
 * 1. 不得位于 original/（或 --src）之下（ExtractContext 只读守卫）；
 * 2. 真实绝对路径的任何位置出现 `apps/<x>/public` 一律拒绝（Vite 会把它原样打进 dist 与镜像）；
 * 3. 本仓库内：不能是仓库根；必须已被 git 忽略（git 不可用时只认 rich4-assets/ 与 .cache/）；必须位于 rich4-assets/ 或 .cache/ 下；
 *    若途经本仓库里嵌套的另一个 git 仓库，按那个仓库再判定一次；
 * 4. 仓库外：必须显式 allowOutsideRepo（CLI `--allow-outside-repo`，供测试等特殊用途）；
 *    若落在任何 git 工作树内（另一份检出、git worktree），按那个工作树再做一次 3 的判定。
 *
 * 删除（清理旧产物、预览重建）只在带归属标记的目录里执行：构建开始时 claimOutputDir 认领目录
 * （不存在或为空 → 写标记；已有标记、rich4-extract 的 manifest 或旧版产物 → 补标记；否则拒绝），
 * 删除前 assertOwnedOutputDir 再确认标记存在。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { assetOutputViolation } from '@rich4/shared/assets';
import { type ExtractContext, ExtractError, isInside, realpathLoose } from '../context';
import { safeWriteFile } from '../io/writeCanonicalJson';

export interface OutputDirOptions {
  /** 允许输出到本仓库之外（仍然拒绝其他 git 工作树里未被忽略的路径与 apps/*\/public/**）；默认 false */
  allowOutsideRepo?: boolean;
}

/** 目录归属标记（点号开头：PACK_PATH_RE 天然排除，不会被当作素材包文件托管） */
export const OUTPUT_OWNER_MARKER = '.rich4-extract.json';
const OWNER_GENERATOR = 'rich4-extract';
const MARKER_TEXT = `${JSON.stringify({
  generator: OWNER_GENERATOR,
  note: '本目录由 rich4-extract 生成：原版派生素材，仅供私人与朋友游玩，不得入库、不得进镜像、不得公开',
})}\n`;

const APPS_PUBLIC_RE = /(?:^|[\\/])apps[\\/][^\\/]+[\\/]public(?:[\\/]|$)/i;
const PROBE = '__rich4_output_probe__';
/** 旧版预览页（归属标记出现之前生成）的标题 */
const LEGACY_PREVIEW_TITLE = '<title>素材包预览（本机私用）</title>';
/** 旧版 A3 暂存目录的映射表文件名 */
const LEGACY_STAGING_MAP_RE = /^(?:voice-map|sfx-sets|music-map|flic-map|video-map)\.[0-9a-f]{8}\.json$/;
/** 判断「空目录」时忽略的系统杂项 */
const IGNORABLE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** git check-ignore：true 已忽略、false 未忽略、null 无法判断（git 不可用或不在仓库内） */
export function gitIgnored(cwd: string, probe: string): boolean | null {
  const r = spawnSync('git', ['check-ignore', '-q', '--', probe], { cwd, encoding: 'utf8' });
  if (r.error || (r.status !== 0 && r.status !== 1)) return null;
  return r.status === 0;
}

function nearestExisting(p: string): string | null {
  let cur = path.resolve(p);
  while (!existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return cur;
}

/** 路径所在的 git 工作树根（真实路径）；不在任何工作树内返回 null。先查祖先链上的 .git（目录或文件），再问 git */
export function gitWorktreeOf(p: string): string | null {
  let cur = path.resolve(p);
  for (;;) {
    if (existsSync(path.join(cur, '.git'))) return realpathLoose(cur);
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  const anc = nearestExisting(p);
  if (anc === null) return null;
  const r = spawnSync('git', ['-C', anc, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const top = r.stdout.trim();
  if (!top) return null;
  const real = realpathLoose(top);
  return isInside(p, real) ? real : null;
}

type TreeCheck = 'full' | 'ignoredOnly';

/** 按工作树 top 判定 real：不能是根；必须已被忽略；full 时还必须位于 rich4-assets/ 或 .cache/ 下 */
function checkInTree(ctx: ExtractContext, top: string, real: string, mode: TreeCheck, where: string): void {
  const segs = path
    .relative(top, real)
    .split(path.sep)
    .filter((s) => s.length > 0);
  const shown = ctx.displayPath(real);
  if (segs.length === 0) throw new ExtractError('E_ASSETS_OUT_ROOT', `素材输出目录不能是仓库根目录${where}`);
  const ignored = gitIgnored(top, path.join(real, PROBE));
  if (ignored === null) {
    const first = segs[0]!.toLowerCase();
    if (first !== 'rich4-assets' && first !== '.cache') {
      throw new ExtractError('E_ASSETS_OUT_NOT_IGNORED', `无法确认 ${shown} 已被 git 忽略（git 不可用）${where}`);
    }
  } else if (!ignored) {
    throw new ExtractError(
      'E_ASSETS_OUT_NOT_IGNORED',
      `拒绝输出到未被 git 忽略的路径：${shown}${where}（改用 rich4-assets/ 或 .cache/ 下的目录）`,
    );
  }
  if (mode === 'full') {
    const why = assetOutputViolation(segs.join('/'));
    if (why !== null) throw new ExtractError('E_ASSETS_OUT_POLICY', `${shown}：${why}${where}`);
  }
}

/** 解析并检查派生物输出目录，返回真实绝对路径（规则见文件头）。不创建任何目录。 */
export function resolveOutputDir(ctx: ExtractContext, dir: string, opts: OutputDirOptions = {}): string {
  const abs = path.isAbsolute(dir) ? dir : path.resolve(ctx.root, dir);
  const real = ctx.assertWritable(abs);
  if (APPS_PUBLIC_RE.test(real)) {
    throw new ExtractError(
      'E_ASSETS_OUT_PUBLIC',
      `拒绝输出到前端静态目录：${ctx.displayPath(real)}（任何位置的 apps/*/public/** 都会被 Vite 打进 dist 与镜像）`,
    );
  }
  const root = realpathLoose(ctx.root);
  const tree = gitWorktreeOf(real);
  const other = (t: string) => `（位于另一个 git 工作树 ${t}）`;
  if (isInside(real, root)) {
    checkInTree(ctx, root, real, 'full', '');
    if (tree !== null && !isInside(root, tree)) {
      // 本仓库里嵌套的另一个仓库（如 .cache/ 下的某份检出）：它自己也必须忽略这个路径，且同样只能是 rich4-assets/ 或 .cache/
      checkInTree(ctx, tree, real, 'full', other(tree));
    } else if (tree !== null && !isInside(tree, root)) {
      // 本仓库被包在更大的仓库里：外层仓库也必须忽略它
      checkInTree(ctx, tree, real, 'ignoredOnly', other(tree));
    }
    return real;
  }
  if (!opts.allowOutsideRepo) {
    throw new ExtractError(
      'E_ASSETS_OUT_OUTSIDE',
      `拒绝输出到仓库外：${real}（素材包与派生物只写入 rich4-assets/ 或 .cache/；确需输出到仓库外请加 --allow-outside-repo）`,
    );
  }
  if (tree !== null) checkInTree(ctx, tree, real, 'full', other(tree));
  return real;
}

// ───────────────────────── 目录归属 ─────────────────────────

export type OutputDirState = 'fresh' | 'owned' | 'foreign';

function isOwnerMarker(text: string): boolean {
  try {
    const j = JSON.parse(text) as { generator?: unknown };
    return typeof j.generator === 'string' && j.generator.startsWith(OWNER_GENERATOR);
  } catch {
    return false;
  }
}

async function readText(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/** 标记出现之前由 rich4-extract 生成的目录：素材包 manifest、预览页、A3 暂存映射表 */
async function legacyOwned(dir: string, names: readonly string[]): Promise<boolean> {
  if (names.includes('manifest.json')) {
    const t = await readText(path.join(dir, 'manifest.json'));
    if (t !== null && isOwnerMarker(t)) return true;
  }
  if (names.includes('index.html')) {
    const t = await readText(path.join(dir, 'index.html'));
    if (t?.includes(LEGACY_PREVIEW_TITLE)) return true;
  }
  if (names.includes('data')) {
    let data: string[] = [];
    try {
      data = await readdir(path.join(dir, 'data'));
    } catch {
      data = [];
    }
    for (const n of data.filter((x) => LEGACY_STAGING_MAP_RE.test(x)).sort()) {
      const t = await readText(path.join(dir, 'data', n));
      if (t !== null && /"schema"\s*:\s*"rich4\.(?:voice-map|sfx-sets|music-map|flic-map|video-map)\/\d+"/.test(t)) {
        return true;
      }
    }
  }
  return false;
}

/** 目录状态：不存在或为空 = fresh；有归属标记或旧版 rich4-extract 产物 = owned；其余 = foreign */
export async function outputDirState(dir: string): Promise<OutputDirState> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'fresh';
    if (code === 'ENOTDIR') throw new ExtractError('E_ASSETS_OUT_NOT_DIR', `输出路径不是目录：${dir}`);
    throw e;
  }
  if (names.every((n) => IGNORABLE_NAMES.has(n))) return 'fresh';
  if (names.includes(OUTPUT_OWNER_MARKER)) {
    const t = await readText(path.join(dir, OUTPUT_OWNER_MARKER));
    if (t !== null && isOwnerMarker(t)) return 'owned';
  }
  return (await legacyOwned(dir, names)) ? 'owned' : 'foreign';
}

/** 只读检查：目录可以认领时返回状态（fresh / owned）；foreign（非空且不是 rich4-extract 生成）时抛 E_ASSETS_OUT_FOREIGN */
export async function checkClaimable(ctx: ExtractContext, dir: string): Promise<'fresh' | 'owned'> {
  const state = await outputDirState(dir);
  if (state === 'foreign') {
    throw new ExtractError(
      'E_ASSETS_OUT_FOREIGN',
      `${ctx.displayPath(dir)} 非空，且不是 rich4-extract 生成的目录（没有 ${OUTPUT_OWNER_MARKER} 标记或 rich4-extract 的 manifest）；` +
        '为免覆盖或误删其中的文件，请换一个空目录',
    );
  }
  return state;
}

/**
 * 构建开始、写任何文件之前调用：fresh / owned 时写入（或补上）归属标记；foreign 时拒绝（见 checkClaimable），
 * 以免覆盖或清理他人的文件。
 */
export async function claimOutputDir(ctx: ExtractContext, dir: string): Promise<'fresh' | 'owned'> {
  const state = await checkClaimable(ctx, dir);
  const marker = path.join(dir, OUTPUT_OWNER_MARKER);
  if ((await readText(marker)) !== MARKER_TEXT) await safeWriteFile(ctx, marker, MARKER_TEXT);
  return state;
}

/** 目录是否带有效的归属标记（同步；删除前检查） */
export function hasOwnerMarker(dir: string): boolean {
  try {
    return isOwnerMarker(readFileSync(path.join(dir, OUTPUT_OWNER_MARKER), 'utf8'));
  } catch {
    return false;
  }
}

/** 删除前的归属检查：没有标记（不是 claimOutputDir 认领过的目录）时抛 E_ASSETS_OUT_NOT_OWNED */
export function assertOwnedOutputDir(ctx: ExtractContext, dir: string): void {
  if (!hasOwnerMarker(dir)) {
    throw new ExtractError(
      'E_ASSETS_OUT_NOT_OWNED',
      `拒绝在 ${ctx.displayPath(dir)} 里删除文件：该目录没有 rich4-extract 的归属标记 ${OUTPUT_OWNER_MARKER}`,
    );
  }
}
