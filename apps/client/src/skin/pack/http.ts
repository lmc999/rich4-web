// 素材包与门禁接口共用的 HTTP 小工具：错误码解析（兼容 {ok:false,error:{code}}、{error:'X'}、{code:'X'}）、
// JSON 响应判定、超时与中止信号合并。不依赖 shared/assets，门禁页也可以用。

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 缺省 fetch（绑定到全局，避免「Illegal invocation」）；环境没有 fetch 时返回 null */
export function defaultFetch(): FetchLike | null {
  if (typeof globalThis.fetch !== 'function') return null;
  return (input, init) => globalThis.fetch(input, init);
}

export class HttpError extends Error {
  override name = 'HttpError';

  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly url: string,
    message = `HTTP ${status}${code ? ` ${code}` : ''}：${url}`,
  ) {
    super(message);
  }

  /** 401 一律视为需要门禁（服务器约定错误码 ACCESS_REQUIRED；缺码时也按门禁处理） */
  get accessRequired(): boolean {
    return this.status === 401 || this.code === 'ACCESS_REQUIRED';
  }
}

/** 从响应体里读错误码（读取失败返回 null；会消费响应体） */
export async function readErrorCode(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    if (!text) return null;
    return errorCodeOf(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

export function errorCodeOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const err = b.error;
  if (typeof err === 'object' && err !== null && typeof (err as Record<string, unknown>).code === 'string') {
    return (err as Record<string, string>).code ?? null;
  }
  if (typeof err === 'string') return err;
  if (typeof b.code === 'string') return b.code;
  return null;
}

/** Content-Type 是否是 JSON */
export function isJsonResponse(res: Response): boolean {
  const ct = res.headers.get('content-type') ?? '';
  return /\bjson\b/i.test(ct);
}

/** 合并外部中止信号与超时（环境不支持 AbortSignal.any / timeout 时退化为外部信号） */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal | undefined {
  const S = AbortSignal as typeof AbortSignal & {
    any?: (signals: AbortSignal[]) => AbortSignal;
    timeout?: (ms: number) => AbortSignal;
  };
  if (!(ms > 0) || typeof S.timeout !== 'function') return signal;
  const t = S.timeout(ms);
  if (!signal) return t;
  return typeof S.any === 'function' ? S.any([signal, t]) : signal;
}
