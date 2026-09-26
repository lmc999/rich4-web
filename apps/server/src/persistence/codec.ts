/**
 * 编码工具（design/net.md §8.3）：gzip(JSON)、sha256、HMAC-SHA256 签名与校验、R4S1 导出文本。
 *
 * - 数据库存 blob = gzip(JSON)，sig = base64url(HMAC-SHA256(secret, blob))。
 * - 导出文件 .r4save 是一行文本 `R4S1.<b64url(gzip)>.<b64url(sig)>`；未验证的存档 sig 段为空（重新导入仍是非官方存档）。
 * - 解压设上限（SAVE_MAX_JSON_BYTES），防止压缩炸弹。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { SAVE_EXPORT_PREFIX } from '@rich4/shared/save';

/** 解压后的 JSON 上限（一个 GameState 约 50–150KB，时光机锚点翻倍；留足余量） */
export const SAVE_MAX_JSON_BYTES = 16 * 1024 * 1024;
/** HMAC 密钥的最短长度（字节） */
export const HMAC_MIN_BYTES = 32;

export class CodecError extends Error {
  override name = 'CodecError';
  constructor(
    readonly reason: 'badEncoding' | 'tooLarge' | 'badJson',
    message: string,
  ) {
    super(message);
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function gzipJson(value: unknown): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(JSON.stringify(value), 'utf8'), { level: 6 }));
}

/** gunzip + JSON.parse；超过 maxBytes、数据损坏、不是 JSON 都抛 CodecError */
export function gunzipJson(blob: Uint8Array, maxBytes = SAVE_MAX_JSON_BYTES): unknown {
  let buf: Buffer;
  try {
    buf = gunzipSync(blob, { maxOutputLength: maxBytes });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ERR_BUFFER_TOO_LARGE') throw new CodecError('tooLarge', 'decompressed save is too large');
    throw new CodecError('badEncoding', 'not gzip data');
  }
  try {
    return JSON.parse(buf.toString('utf8')) as unknown;
  } catch {
    throw new CodecError('badJson', 'not JSON');
  }
}

export function b64url(data: Uint8Array): string {
  return Buffer.from(data).toString('base64url');
}

/** 严格的 base64url 解码：含非法字符时抛 CodecError */
export function fromB64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new CodecError('badEncoding', 'bad base64url');
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

/** 签名器：持有 HMAC 密钥 */
export class Signer {
  private readonly key: Buffer;

  constructor(secret: string | Uint8Array) {
    this.key = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
    if (this.key.length < HMAC_MIN_BYTES) throw new Error(`HMAC secret must be at least ${HMAC_MIN_BYTES} bytes`);
  }

  /** base64url(HMAC-SHA256(key, blob)) */
  sign(blob: Uint8Array): string {
    return createHmac('sha256', this.key).update(blob).digest('base64url');
  }

  /** 常量时间比较；sig 为空或格式不对一律 false */
  verify(blob: Uint8Array, sig: string): boolean {
    if (sig === '' || !/^[A-Za-z0-9_-]+$/.test(sig)) return false;
    const expect = createHmac('sha256', this.key).update(blob).digest();
    const got = Buffer.from(sig, 'base64url');
    return got.length === expect.length && timingSafeEqual(got, expect);
  }
}

/** 随机密钥（开发环境未配置 SAVE_HMAC_SECRET 时持久化到存储的 meta 里） */
export function randomSecret(): string {
  return randomBytes(48).toString('base64url');
}

/** 导出文本：`R4S1.<b64url(blob)>.<sig>`（sig 本身已是 base64url；未验证时为空串） */
export function encodeR4S1(blob: Uint8Array, sig: string): string {
  return `${SAVE_EXPORT_PREFIX}.${b64url(blob)}.${sig}`;
}

/** 解析导出文本（首尾空白忽略）；格式不对抛 CodecError */
export function decodeR4S1(text: string): { blob: Uint8Array; sig: string } {
  const t = text.trim();
  const parts = t.split('.');
  if (parts.length !== 3 || parts[0] !== SAVE_EXPORT_PREFIX) throw new CodecError('badEncoding', 'not an R4S1 file');
  const blob = fromB64url(parts[1]!);
  const sig = parts[2]!;
  if (!/^[A-Za-z0-9_-]*$/.test(sig)) throw new CodecError('badEncoding', 'bad signature encoding');
  if (blob.length === 0) throw new CodecError('badEncoding', 'empty payload');
  return { blob, sig };
}
