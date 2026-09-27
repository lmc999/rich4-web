/**
 * 访问门禁的 HTTP 契约（docs/design/original-skin.md U4、§3 修正 3/4；design-draft §5.3）。
 * 服务器 apps/server/src/http/access.ts 实现，前端 AccessGate（A5）与 E2E 夹具使用同一份常量与 schema。
 *
 * - ACCESS_MODE != off 时，`/pack/*`、`/api/*`（`/api/access*` 除外）与 Socket.IO 握手都要求访问 cookie；
 *   缺少或失效时 HTTP 返回 401 `{ ok:false, error:{ code:'ACCESS_REQUIRED' } }`，握手失败的 connect_error.data 同样是
 *   `ACCESS_REQUIRED`。`/healthz`、`/readyz`、SPA 外壳页与 `/robots.txt` 保持公开。
 * - cookie `r4_access=v1.<exp>.<epoch>.<kind>.<HMAC>`：HttpOnly、SameSite=Lax、Path=/，PUBLIC_URL 为 https 时 Secure；
 *   滑动续期（GET /api/access、其他 /api/* 与 /pack/manifest.json 的响应、Socket.IO 握手响应都可能带新的 Set-Cookie）。
 *   前端应在对局期间定期（≤ ACCESS_RENEW_HINT_MS）调用 GET /api/access，保证长局中 cookie 不过期。
 * - 房间邀请授权：已通过口令或邀请码的玩家 POST /api/access/grant {room} 得到 token，链接为 `/r/<room>#g=<token>`
 *   （片段不会发给服务器，也不进 Referer 与访问日志）；受邀者的门禁页读出片段，POST /api/access/redeem {token} 换取 cookie。
 *   经授权进入的会话（kind 'g'）不能再生成授权。
 * - 所有 POST 必须是 `Content-Type: application/json`（跨站表单无法伪造，配合 SameSite=Lax 防 CSRF）。
 */
import { z } from 'zod';
import { ROOM_CODE_RE } from './limits';

/** 门禁模式：off 不设门禁；passcode 共享口令（也接受管理员生成的邀请码）；invite 只接受邀请码 */
export const ACCESS_MODES = ['off', 'passcode', 'invite'] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

/** 访问 cookie 的名字 */
export const ACCESS_COOKIE = 'r4_access';

/** cookie 的来源：p = 口令，i = 邀请码，g = 房间邀请授权 */
export const ACCESS_KINDS = ['p', 'i', 'g'] as const;
export type AccessKind = (typeof ACCESS_KINDS)[number];

/** 房间邀请授权：24 小时内有效、最多兑换 8 次 */
export const ACCESS_GRANT_TTL_MS = 24 * 60 * 60_000;
export const ACCESS_GRANT_MAX_USES = 8;
/** 经授权得到的 cookie（kind 'g'）有效期 24 小时，活跃期间滑动续期 */
export const ACCESS_GRANT_COOKIE_TTL_MS = 24 * 60 * 60_000;
/** 前端续期提示：对局中至少每小时调用一次 GET /api/access */
export const ACCESS_RENEW_HINT_MS = 60 * 60_000;

/** 邀请链接的 URL 片段键：`/r/<room>#g=<token>` */
export const ACCESS_GRANT_FRAGMENT_KEY = 'g';
/** 授权 token：32 字节 CSPRNG 的 base64url（43 字符） */
export const ACCESS_GRANT_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** 口令或邀请码的输入长度上限（按 UTF-16 码元） */
export const ACCESS_PASSCODE_MAX = 256;

/** 素材包路由前缀（不用 /assets/：那是 Vite 构建产物的路径） */
export const PACK_PREFIX = '/pack/';
/** 素材包清单的地址 */
export const PACK_MANIFEST_URL = '/pack/manifest.json';

// ───────────────────────── 请求体 ─────────────────────────

/** POST /api/access：口令模式下为口令（也可以填邀请码），邀请模式下为邀请码 */
export const AccessLoginBodySchema = z.strictObject({
  passcode: z.string().min(1).max(ACCESS_PASSCODE_MAX),
});
export type AccessLoginBody = z.output<typeof AccessLoginBodySchema>;

/** POST /api/access/grant */
export const AccessGrantBodySchema = z.strictObject({
  room: z.string().regex(ROOM_CODE_RE),
});
export type AccessGrantBody = z.output<typeof AccessGrantBodySchema>;

/** POST /api/access/redeem */
export const AccessRedeemBodySchema = z.strictObject({
  token: z.string().regex(ACCESS_GRANT_TOKEN_RE),
});
export type AccessRedeemBody = z.output<typeof AccessRedeemBodySchema>;

// ───────────────────────── 响应（包在 { ok:true, data } 里） ─────────────────────────

/** GET /api/access、POST /api/access、POST /api/access/redeem 的 data */
export interface AccessStatus {
  mode: AccessMode;
  /** 当前请求是否已通过门禁（mode 为 off 时恒为 true） */
  granted: boolean;
  /** cookie 来源；未通过或 mode 为 off 时为 null */
  kind: AccessKind | null;
  /** cookie 到期时间（毫秒时间戳）；未通过或 mode 为 off 时为 null */
  expiresAt: number | null;
  /** 服务器是否开启房间邀请授权（ACCESS_GRANTS=1 且 mode 不为 off） */
  grants: boolean;
  /** 当前会话能否生成授权（grants 为 true，且 kind 为 p 或 i） */
  canGrant: boolean;
}

/**
 * 服务器实际返回的状态（GET /api/access、POST /api/access、POST /api/access/redeem 的 data 都带这个字段）。
 * pack：原版皮肤素材包的 packId（= /pack/manifest.json 的 ETag）；没有启用素材包，或门禁开启而当前请求尚未通过时为 null
 * （不向未授权的人透露素材包是否存在）。前端据此决定是否请求 manifest，避免没有素材包时每次产生一个 404。
 */
export interface AccessStatusWithPack extends AccessStatus {
  pack: string | null;
}

/** POST /api/access/redeem 的 data：兑换成功后前端跳到 `/r/<room>` */
export interface AccessRedeemResult extends AccessStatus {
  room: string | null;
}

/** POST /api/access/grant 的 data */
export interface AccessGrantResult {
  room: string;
  token: string;
  /** 毫秒时间戳 */
  expiresAt: number;
  uses: number;
  /** 站内路径 `/r/<room>#g=<token>`（前端拼上 location.origin 或 PUBLIC_URL） */
  path: string;
}

// ───────────────────────── 邀请链接 ─────────────────────────

/** `/r/<room>#g=<token>` */
export function accessGrantPath(room: string, token: string): string {
  return `/r/${room}#${ACCESS_GRANT_FRAGMENT_KEY}=${token}`;
}

/** 从 location.hash（带或不带 #）读出授权 token；没有或格式不对时返回 null */
export function parseAccessGrantFragment(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of h.split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0 || part.slice(0, eq) !== ACCESS_GRANT_FRAGMENT_KEY) continue;
    const token = part.slice(eq + 1);
    return ACCESS_GRANT_TOKEN_RE.test(token) ? token : null;
  }
  return null;
}
