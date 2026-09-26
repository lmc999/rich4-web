import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** 只读方式读取整个文件（显式 'r' 标志）。 */
export async function readFileRO(p: string): Promise<Uint8Array> {
  const fh = await open(p, 'r');
  try {
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

export async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 按段大小写不敏感地查找 baseDir 下的相对路径（原版文件名大小写不一：MapDat.MKF / RICH4.EXE）。
 * 精确匹配优先；找不到返回 null。
 */
export async function findCaseInsensitive(baseDir: string, relPath: string): Promise<string | null> {
  let cur = baseDir;
  for (const seg of relPath.split(/[\\/]+/).filter((s) => s.length > 0)) {
    let names: string[];
    try {
      names = await readdir(cur);
    } catch {
      return null;
    }
    const hit = names.includes(seg) ? seg : names.find((n) => n.toLowerCase() === seg.toLowerCase());
    if (hit === undefined) return null;
    cur = path.join(cur, hit);
  }
  return (await isFile(cur)) ? cur : null;
}
