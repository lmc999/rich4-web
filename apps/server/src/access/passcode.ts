/**
 * 共享口令的 scrypt 哈希（docs/design/original-skin.md U4；design-draft §5.1）。
 *
 * 格式：`scrypt:<N>:<r>:<p>:<salt b64url>:<hash b64url>`。
 * 不用设计稿里的 `$` 分隔：docker compose 的 env_file / .env 会对 `$` 做变量插值，`$16384$8$1$…` 会被悄悄改写。
 * 解析时仍接受 `$` 分隔（兼容手写）。明文口令只在内存里出现，不写日志、不落盘。
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export interface ScryptParams {
  /** CPU/内存代价，2 的幂 */
  N: number;
  r: number;
  p: number;
}

export interface PasscodeHash extends ScryptParams {
  salt: Buffer;
  hash: Buffer;
}

/**
 * 默认参数：N=2^15、r=8、p=3——OWASP 口令存储建议表里与 N=2^17、r=8、p=1 并列的一档，
 * 每次验证只占约 32 MiB（128·N·r），4 个 libuv 线程并发验证也只有约 128 MiB。
 */
export const DEFAULT_SCRYPT: Readonly<ScryptParams> = Object.freeze({ N: 1 << 15, r: 8, p: 3 });
/** 建议参数（启动提醒里给出） */
export const RECOMMENDED_SCRYPT: Readonly<ScryptParams> = DEFAULT_SCRYPT;
/**
 * 建议的最低计算量 N·r·p：OWASP 建议表（2^17/8/1、2^16/8/2、2^15/8/3、2^14/8/5、2^13/8/10）里最低的一档；
 * 低于它的哈希照样能用，但启动时提醒重新生成。
 */
export const RECOMMENDED_MIN_WORK = (1 << 14) * 8 * 5;
/**
 * 允许的范围（配置解析时校验）：下限防止误用过弱的参数；上限按资源算——每次验证的内存 128·N·r ≤ maxMemBytes
 * （全局突发 6 个、libuv 线程池 4 个同时验证也不至于 OOM），计算量 128·N·r·p ≤ maxWorkBytes（单次验证不超过约 1 秒量级）。
 */
export const SCRYPT_LIMITS = Object.freeze({
  minN: 1 << 14,
  maxN: 1 << 20,
  maxR: 32,
  maxP: 16,
  maxMemBytes: 256 * 1024 * 1024,
  maxWorkBytes: 1024 * 1024 * 1024,
});
const KEY_LEN = 32;
const SALT_LEN = 16;
/** 建议的最短口令（CLI 对更短的口令给出警告） */
export const PASSCODE_MIN_RECOMMENDED = 10;

/** Node 的 maxmem 按 128·N·r 判定（p 顺序计算，不叠加内存）；留出余量 */
function maxmemOf(o: ScryptParams): number {
  return 128 * o.N * o.r + 32 * 1024 * 1024;
}

function derive(passcode: string, salt: Buffer, o: ScryptParams, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passcode.normalize('NFC'), salt, keyLen, { N: o.N, r: o.r, p: o.p, maxmem: maxmemOf(o) }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function checkParams(o: ScryptParams): string | null {
  if (!Number.isInteger(o.N) || o.N < SCRYPT_LIMITS.minN || o.N > SCRYPT_LIMITS.maxN || (o.N & (o.N - 1)) !== 0) {
    return `N 必须是 2 的幂，范围 [${SCRYPT_LIMITS.minN}, ${SCRYPT_LIMITS.maxN}]`;
  }
  if (!Number.isInteger(o.r) || o.r < 1 || o.r > SCRYPT_LIMITS.maxR) return `r 必须在 [1, ${SCRYPT_LIMITS.maxR}]`;
  if (!Number.isInteger(o.p) || o.p < 1 || o.p > SCRYPT_LIMITS.maxP) return `p 必须在 [1, ${SCRYPT_LIMITS.maxP}]`;
  const mem = 128 * o.N * o.r;
  if (mem > SCRYPT_LIMITS.maxMemBytes) {
    return `每次验证的内存 128·N·r = ${mem / 1024 / 1024} MiB 超过上限 ${SCRYPT_LIMITS.maxMemBytes / 1024 / 1024} MiB`;
  }
  if (mem * o.p > SCRYPT_LIMITS.maxWorkBytes) {
    return `计算量 128·N·r·p 超过上限（${SCRYPT_LIMITS.maxWorkBytes / 1024 / 1024} MiB 量级）；请减小 N、r 或 p`;
  }
  return null;
}

/** 计算量（N·r·p）是否低于建议值 */
export function belowRecommendedScrypt(o: ScryptParams): boolean {
  return o.N * o.r * o.p < RECOMMENDED_MIN_WORK;
}

/** 生成口令哈希字符串（scripts/access.ts hash 调用） */
export async function hashPasscode(passcode: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<string> {
  if (passcode.length === 0) throw new Error('口令不能为空');
  const bad = checkParams(params);
  if (bad) throw new Error(`scrypt 参数无效：${bad}`);
  const salt = randomBytes(SALT_LEN);
  const hash = await derive(passcode, salt, params, KEY_LEN);
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64url'), hash.toString('base64url')].join(':');
}

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/** 解析哈希字符串；格式或参数不对时返回错误说明 */
export function parsePasscodeHash(s: string): { ok: true; value: PasscodeHash } | { ok: false; reason: string } {
  const parts = s.trim().split(/[:$]/);
  if (parts[0] === '') parts.shift(); // 兼容 `$scrypt$…`
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return { ok: false, reason: '应为 scrypt:<N>:<r>:<p>:<salt>:<hash>（用 scripts/access.ts hash 生成）' };
  }
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  const bad = checkParams(params);
  if (bad) return { ok: false, reason: bad };
  if (!B64URL_RE.test(salt) || !B64URL_RE.test(hash)) return { ok: false, reason: 'salt 与 hash 必须是 base64url' };
  const saltBuf = Buffer.from(salt, 'base64url');
  const hashBuf = Buffer.from(hash, 'base64url');
  if (saltBuf.length < 16) return { ok: false, reason: 'salt 至少 16 字节' };
  if (hashBuf.length < 16 || hashBuf.length > 64) return { ok: false, reason: 'hash 长度应为 16–64 字节' };
  return { ok: true, value: { ...params, salt: saltBuf, hash: hashBuf } };
}

/** 常数时间比对（scrypt 本身在线程池里算，不阻塞事件循环） */
export async function verifyPasscode(passcode: string, h: PasscodeHash): Promise<boolean> {
  if (passcode.length === 0) return false;
  const key = await derive(passcode, h.salt, h, h.hash.length);
  return key.length === h.hash.length && timingSafeEqual(key, h.hash);
}
