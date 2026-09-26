import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { hashFileRO } from '../io/hash';

export interface ScannedFile {
  /** 相对 original/ 的 POSIX 路径（保留实际大小写） */
  path: string;
  size: number;
  sha256: string;
  sha1: string;
}

/** 只关心这些扩展名（大小写不敏感）；图像、音频、视频一律不扫。 */
export const SCAN_EXTENSIONS: readonly string[] = ['.exe', '.mkf'];

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.isFile() && SCAN_EXTENSIONS.includes(path.extname(e.name).toLowerCase())) out.push(full);
  }
}

/** 递归扫描 srcDir，计算 sha256 与 sha1（只读打开），按路径排序返回。 */
export async function scanOriginal(srcDir: string): Promise<ScannedFile[]> {
  const files: string[] = [];
  await walk(srcDir, files);
  const out: ScannedFile[] = [];
  for (const f of files) {
    const { size } = await stat(f);
    const h = await hashFileRO(f, ['sha256', 'sha1'] as const);
    out.push({ path: path.relative(srcDir, f).split(path.sep).join('/'), size, sha256: h.sha256, sha1: h.sha1 });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
