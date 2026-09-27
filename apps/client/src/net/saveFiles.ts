// 存档导出 / 导入（HTTP，architecture §5.8、§5.12；design/net.md §8.3）：
// - GET  /api/saves/:id/export  → .r4save 文本 `R4S1.<b64url(gzip)>.<sig>`（请求头 X-Player-Token，必须是 owner）；
// - POST /api/saves/import      → text/plain 的 R4S1 文本（≤ 2MB），返回 {ok, data: SaveSummary}；
//   签名无效的存档照样入库，verified=false（前端显示「非官方存档」）。
// 响应体统一为 {ok, data | error}；网络失败归为 INTERNAL{reason:'network'}。
import {
  type AppError,
  appError,
  isErrorCode,
  type Result,
  SAVE_IMPORT_MAX_BYTES,
  type SaveSummary,
} from '@rich4/shared/net';
import { type KeyValueStorage, loadToken, safeStorage } from './identity';

export const SAVE_FILE_EXT = '.r4save';
/** 导出文件的格式前缀（与服务器 SAVE_EXPORT_PREFIX 一致；只用于导入前的快速识别） */
export const SAVE_FILE_PREFIX = 'R4S1.';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SaveHttpOptions {
  fetch?: FetchLike;
  storage?: KeyValueStorage;
  /** 缺省同源（开发与 E2E 由 Vite 代理 /api） */
  base?: string;
}

function networkError(): AppError {
  return appError('INTERNAL', { reason: 'network' });
}

function fetchOf(o: SaveHttpOptions): FetchLike {
  return o.fetch ?? ((input, init) => globalThis.fetch(input, init));
}

/** 读出 {ok:false, error} 响应体；格式不对时按 HTTP 状态归类 */
async function errorOf(res: Response): Promise<AppError> {
  try {
    const body = (await res.json()) as {
      ok?: unknown;
      error?: { code?: unknown; details?: unknown; message?: unknown };
    };
    const e = body.error;
    if (e && isErrorCode(e.code)) {
      return appError(e.code, e.details, typeof e.message === 'string' ? e.message : undefined);
    }
  } catch {
    // 非 JSON（代理错误页等）
  }
  return res.status === 404 ? appError('SAVE_NOT_FOUND') : appError('INTERNAL', { status: res.status });
}

/** Content-Disposition 里的文件名（优先 RFC 5987 的 filename*） */
export function filenameFromDisposition(h: string | null, fallback: string): string {
  if (h) {
    const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(h);
    if (star?.[1]) {
      try {
        return decodeURIComponent(star[1].trim());
      } catch {
        // 编码坏了，退回普通 filename
      }
    }
    const plain = /filename\s*=\s*"([^"]+)"/i.exec(h) ?? /filename\s*=\s*([^;]+)/i.exec(h);
    if (plain?.[1]) return plain[1].trim();
  }
  return fallback;
}

/** 导出：取回 .r4save 文本与建议文件名 */
export async function exportSaveText(
  saveId: string,
  o: SaveHttpOptions = {},
): Promise<Result<{ text: string; filename: string }>> {
  const token = loadToken(o.storage ?? safeStorage());
  let res: Response;
  try {
    res = await fetchOf(o)(`${o.base ?? ''}/api/saves/${encodeURIComponent(saveId)}/export`, {
      method: 'GET',
      headers: { 'X-Player-Token': token },
      cache: 'no-store',
    });
  } catch {
    return { ok: false, error: networkError() };
  }
  if (!res.ok) return { ok: false, error: await errorOf(res) };
  let text: string;
  try {
    // 读响应体时网络中断也按网络错误返回（不让拒绝冒泡成未处理的 Promise）
    text = await res.text();
  } catch {
    return { ok: false, error: networkError() };
  }
  const filename = filenameFromDisposition(res.headers.get('Content-Disposition'), `${saveId}${SAVE_FILE_EXT}`);
  return { ok: true, data: { text, filename } };
}

/** 导入：上传 .r4save 文本，成功返回入库后的摘要（verified=false 即「非官方存档」） */
export async function importSaveText(text: string, o: SaveHttpOptions = {}): Promise<Result<SaveSummary>> {
  const body = text.trim();
  if (body.length === 0) return { ok: false, error: appError('BAD_REQUEST', { reason: 'emptyBody' }) };
  if (new TextEncoder().encode(body).length > SAVE_IMPORT_MAX_BYTES) {
    return { ok: false, error: appError('BAD_REQUEST', { reason: 'tooLarge', maxBytes: SAVE_IMPORT_MAX_BYTES }) };
  }
  if (!body.startsWith(SAVE_FILE_PREFIX)) {
    return { ok: false, error: appError('SAVE_INCOMPATIBLE', { reason: 'badEncoding' }) };
  }
  const token = loadToken(o.storage ?? safeStorage());
  let res: Response;
  try {
    res = await fetchOf(o)(`${o.base ?? ''}/api/saves/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Player-Token': token },
      body,
      cache: 'no-store',
    });
  } catch {
    return { ok: false, error: networkError() };
  }
  if (!res.ok) return { ok: false, error: await errorOf(res) };
  try {
    const r = (await res.json()) as Result<SaveSummary>;
    if (r && typeof r === 'object' && 'ok' in r) return r;
  } catch {
    // 落到下面
  }
  return { ok: false, error: appError('INTERNAL', { reason: 'badResponse' }) };
}

/** 读取用户选的文件（超过上限直接拒绝，不读进内存） */
export async function readSaveFile(file: Blob): Promise<Result<string>> {
  if (file.size > SAVE_IMPORT_MAX_BYTES) {
    return { ok: false, error: appError('BAD_REQUEST', { reason: 'tooLarge', maxBytes: SAVE_IMPORT_MAX_BYTES }) };
  }
  try {
    return { ok: true, data: await file.text() };
  } catch {
    return { ok: false, error: appError('BAD_REQUEST', { reason: 'unreadable' }) };
  }
}

/** 把文本存成本地文件（<a download>；不支持时返回 false） */
export function downloadText(text: string, filename: string): boolean {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 给浏览器一点时间开始下载再回收
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
