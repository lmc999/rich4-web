import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export type HashAlgo = 'sha256' | 'sha1';

export function hashHex(bytes: Uint8Array, algo: HashAlgo = 'sha256'): string {
  return createHash(algo).update(bytes).digest('hex');
}

export function sha256Hex(bytes: Uint8Array): string {
  return hashHex(bytes, 'sha256');
}

/** 流式计算文件哈希（只读打开），一次读盘同时算多个算法。 */
export async function hashFileRO<A extends HashAlgo>(p: string, algos: readonly A[]): Promise<Record<A, string>> {
  const hashers = algos.map((a) => [a, createHash(a)] as const);
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(p, { flags: 'r' });
    stream.on('data', (chunk) => {
      for (const [, h] of hashers) h.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  const out = {} as Record<A, string>;
  for (const [a, h] of hashers) out[a] = h.digest('hex');
  return out;
}
