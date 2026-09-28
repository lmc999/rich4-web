// 远程模式（architecture M11 验证 3、4）：设置 E2E_BASE_URL 时 E2E 对着已部署的实例跑（两个 Playwright 配置都不启动
// webServer）。前端、/socket.io 与 /api 都挂在站点根路径（net.md §10.1），夹具与用例只用相对路径，从 baseURL 推导一切。
// 本模块只读环境变量、不依赖 @playwright/test：配置文件与夹具共用，配置文件引入它不会带出别的副作用。

/**
 * E2E_BASE_URL 规整成站点源（scheme://host[:port]）；未设置返回 null。
 * 只支持部署在站点根路径：带子路径、查询或片段的地址直接报错（相对路径 `/r/...` 会丢掉子路径）。
 */
export function remoteBaseUrl(raw: string | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`E2E_BASE_URL 不是合法的 URL：${s}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`E2E_BASE_URL 只支持 http / https：${s}`);
  if (u.pathname !== '/' || u.search || u.hash) {
    throw new Error(`E2E_BASE_URL 只支持部署在站点根路径（不带路径、查询与片段）：${s}`);
  }
  return u.origin;
}

/** 远程实例的站点源；null 表示本机模式（配置里的 webServer 起服务器） */
export const E2E_REMOTE: string | null = remoteBaseUrl(process.env.E2E_BASE_URL);
