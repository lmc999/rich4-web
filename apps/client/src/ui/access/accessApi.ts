// 访问门禁的前端接口（契约见 @rich4/shared/net 的 access.ts；服务器 apps/server/src/http/access.ts）：
// GET /api/access 状态、POST /api/access 口令、POST /api/access/redeem 兑换房间授权、POST /api/access/grant 生成授权。
// 所有 POST 都是 application/json（服务器据此防 CSRF）；口令与 token 不写日志、不进 URL。
import type { AccessGrantResult, AccessRedeemResult, AccessStatus } from '@rich4/shared/net';
import { defaultFetch, errorCodeOf, type FetchLike } from '../../skin/pack/http';

export const ACCESS_API = '/api/access';

export type AccessResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      /** 服务器错误码（ACCESS_REQUIRED、RATE_LIMITED、BAD_REQUEST…）；网络错误为 'NETWORK' */
      code: string;
      status: number;
      /** 细节里的原因（badPasscode、expired、used…） */
      reason: string | null;
      /** 429 时建议的等待毫秒数 */
      retryAfterMs: number | null;
    };

let fetchImpl: FetchLike | null = null;

/** 测试注入 fetch（null 恢复全局 fetch） */
export function setAccessFetch(f: FetchLike | null): void {
  fetchImpl = f;
}

function doFetch(): FetchLike | null {
  return fetchImpl ?? defaultFetch();
}

function reasonOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const err = (body as { error?: { details?: { reason?: unknown } } }).error;
  const r = err?.details?.reason;
  return typeof r === 'string' ? r : null;
}

function retryOf(res: Response, body: unknown): number | null {
  const h = res.headers.get('retry-after');
  if (h && /^\d+$/.test(h.trim())) return Number(h.trim()) * 1000;
  const d = (body as { error?: { details?: { retryAfterMs?: unknown } } } | null)?.error?.details?.retryAfterMs;
  return typeof d === 'number' && d > 0 ? d : null;
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<AccessResult<T>> {
  const f = doFetch();
  if (!f) return { ok: false, code: 'NETWORK', status: 0, reason: null, retryAfterMs: null };
  let res: Response;
  try {
    res = await f(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, code: 'NETWORK', status: 0, reason: null, retryAfterMs: null };
  }
  let json: unknown = null;
  try {
    const text = await res.text();
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    json = null;
  }
  const payload = json as { ok?: unknown; data?: unknown } | null;
  if (res.ok && payload && payload.ok === true && payload.data !== undefined)
    return { ok: true, data: payload.data as T };
  return {
    ok: false,
    code: errorCodeOf(json) ?? (res.ok ? 'BAD_RESPONSE' : `HTTP_${res.status}`),
    status: res.status,
    reason: reasonOf(json),
    retryAfterMs: retryOf(res, json),
  };
}

/** 当前门禁状态；接口不存在（旧服务器）或网络错误时返回失败结果 */
export function fetchAccessStatus(): Promise<AccessResult<AccessStatus>> {
  return call<AccessStatus>('GET', ACCESS_API);
}

/** 口令（或管理员邀请码）换取访问 cookie */
export function loginAccess(passcode: string): Promise<AccessResult<AccessStatus>> {
  return call<AccessStatus>('POST', ACCESS_API, { passcode });
}

/** 兑换房间邀请授权（URL 片段 #g=<token>） */
export function redeemAccessGrant(token: string): Promise<AccessResult<AccessRedeemResult>> {
  return call<AccessRedeemResult>('POST', `${ACCESS_API}/redeem`, { token });
}

/** 为房间生成邀请授权（已通过口令或邀请码的玩家） */
export function createAccessGrant(room: string): Promise<AccessResult<AccessGrantResult>> {
  return call<AccessGrantResult>('POST', `${ACCESS_API}/grant`, { room });
}
