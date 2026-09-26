import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WriteGuard } from '../context';

/**
 * 规范化：对象键按码点排序、递归；丢弃值为 undefined 的对象属性（同 JSON.stringify）。
 * 数组里的 undefined、非有限数、bigint、函数、Map/Set 一律报错，保证同输入同字节。
 */
export function canonicalize(value: unknown, where = '$'): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: ${where} 不是有限数`);
      return Object.is(value, -0) ? 0 : value;
    case 'object': {
      if (Array.isArray(value)) {
        return value.map((v, i) => {
          if (v === undefined) throw new TypeError(`canonicalJson: ${where}[${i}] 为 undefined`);
          return canonicalize(v, `${where}[${i}]`);
        });
      }
      if (value instanceof Map || value instanceof Set) throw new TypeError(`canonicalJson: ${where} 不能是 Map/Set`);
      if (ArrayBuffer.isView(value)) throw new TypeError(`canonicalJson: ${where} 不能是二进制数组`);
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) {
        const v = obj[k];
        if (v === undefined) continue;
        out[k] = canonicalize(v, `${where}.${k}`);
      }
      return out;
    }
    default:
      throw new TypeError(`canonicalJson: ${where} 的类型 ${typeof value} 不能序列化`);
  }
}

/** 键排序、2 空格缩进、LF、末尾换行。 */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

/** 经只读守卫后写文件（自动建目录）。返回实际写入的路径。 */
export async function safeWriteFile(guard: WriteGuard, target: string, data: string | Uint8Array): Promise<string> {
  const real = guard.assertWritable(target);
  guard.assertWritable(path.dirname(real));
  await mkdir(path.dirname(real), { recursive: true });
  await writeFile(real, data, { flag: 'w' });
  return real;
}

export async function writeCanonicalJson(guard: WriteGuard, target: string, value: unknown): Promise<string> {
  return safeWriteFile(guard, target, canonicalJson(value));
}
