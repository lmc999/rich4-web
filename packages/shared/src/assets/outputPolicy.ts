/**
 * 素材包输出位置规则（docs/design/original-skin.md §3 修正 5）：
 * 素材包与所有派生物只能写入仓库根下的 rich4-assets/ 或 .cache/（二者都已被 .gitignore 与 .dockerignore 忽略），
 * 绝不写入 apps/*\/public/**（Vite 会把它原样拷进 dist，进而进入镜像）。
 * 这里只做纯路径判定；tools/extract 还必须用 `git check-ignore` 确认目标路径确实被忽略，未被忽略时拒绝输出。
 */

/** 允许的输出根目录（仓库根相对） */
export const ASSET_OUTPUT_ROOTS = ['rich4-assets', '.cache'] as const;

/** 规范化仓库根相对的 posix 路径；越出仓库根或为绝对路径时返回 null */
export function normalizeRepoPath(p: string): string | null {
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.includes('\\')) return null;
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.join('/');
}

/**
 * 检查 extract 的输出目录（仓库根相对 posix 路径）。允许时返回 null，否则返回中文原因。
 * 例：`rich4-assets`、`.cache/rich4-assets`、`.cache/assets-preview` 允许；`apps/client/public/pack`、`packages/x`、`../out` 拒绝。
 */
export function assetOutputViolation(repoRelPath: string): string | null {
  const norm = normalizeRepoPath(repoRelPath);
  if (norm === null) return '输出目录必须位于仓库内且使用仓库根相对的 posix 路径';
  if (norm === '') return '不能直接输出到仓库根目录';
  const segs = norm.split('/');
  if (segs[0] === 'apps' && segs[2] === 'public')
    return 'apps/*/public/** 会被 Vite 原样打进 dist 与镜像，禁止输出到这里';
  if (!(ASSET_OUTPUT_ROOTS as readonly string[]).includes(segs[0]!)) {
    return `素材包只能输出到 ${ASSET_OUTPUT_ROOTS.map((r) => `${r}/`).join(' 或 ')} 下`;
  }
  return null;
}
