// 身份与本地记忆（design/net.md §5.1）：token 存 localStorage 'rich4.token'（16 字节 CSPRNG 转 base64url），
// 上次所在房间存 'rich4.lastRoom' = {code, epoch, lastSeq}。不用 crypto.randomUUID：局域网 http 访问不是安全上下文。
import { TOKEN_RE } from '@rich4/shared/net';

export const TOKEN_KEY = 'rich4.token';
export const LAST_ROOM_KEY = 'rich4.lastRoom';

/** localStorage 的最小接口（隐私模式、测试环境可替换为内存实现） */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function memoryStorage(): KeyValueStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

let fallback: KeyValueStorage | null = null;

/** 浏览器 localStorage；不可用时退回进程内存 */
export function safeStorage(): KeyValueStorage {
  try {
    const ls = globalThis.localStorage;
    if (ls) {
      const probe = '__rich4_probe__';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      return ls;
    }
  } catch {
    // 隐私模式或禁用存储
  }
  fallback ??= memoryStorage();
  return fallback;
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 字节 → base64url（无填充） */
export function base64url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
  }
  return out;
}

export type RandomFill = (buf: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;

const defaultFill: RandomFill = (buf) => globalThis.crypto.getRandomValues(buf);

/** 新 token：16 字节 CSPRNG → 22 字符 base64url */
export function generateToken(fill: RandomFill = defaultFill): string {
  return base64url(fill(new Uint8Array(16)));
}

/** 读取或生成 token（格式不合法时重新生成） */
export function loadToken(storage: KeyValueStorage = safeStorage(), fill: RandomFill = defaultFill): string {
  const cur = storage.getItem(TOKEN_KEY);
  if (cur && TOKEN_RE.test(cur)) return cur;
  const t = generateToken(fill);
  storage.setItem(TOKEN_KEY, t);
  return t;
}

export interface LastRoom {
  code: string;
  epoch: number;
  lastSeq: number;
}

export function loadLastRoom(storage: KeyValueStorage = safeStorage()): LastRoom | null {
  try {
    const raw = storage.getItem(LAST_ROOM_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LastRoom>;
    if (typeof v.code !== 'string' || !Number.isInteger(v.epoch) || !Number.isInteger(v.lastSeq)) return null;
    return { code: v.code, epoch: v.epoch!, lastSeq: v.lastSeq! };
  } catch {
    return null;
  }
}

export function saveLastRoom(r: LastRoom, storage: KeyValueStorage = safeStorage()): void {
  try {
    storage.setItem(LAST_ROOM_KEY, JSON.stringify(r));
  } catch {
    // 忽略存储失败
  }
}

export function clearLastRoom(storage: KeyValueStorage = safeStorage()): void {
  try {
    storage.removeItem(LAST_ROOM_KEY);
  } catch {
    // 忽略
  }
}

/** 默认昵称：「玩家」+ 4 位数字 */
export function defaultNickname(fill: RandomFill = defaultFill): string {
  const b = fill(new Uint8Array(2));
  const n = ((b[0]! << 8) | b[1]!) % 10000;
  return `玩家${String(n).padStart(4, '0')}`;
}
