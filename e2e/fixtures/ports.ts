// 本机 E2E 的端口（两份 Playwright 配置共用）：环境变量 E2E_SERVER_PORT / E2E_CLIENT_PORT 覆盖各自的缺省值。
// 本机非 CI 时 webServer 的 reuseExistingServer 为 true：同一台机器上另一个工作目录同时跑 E2E 时必须换一组端口，
// 否则会接到对方已经起好的服务器上（跑的是别处的代码）。

/** 环境变量里的端口（1–65535 的整数）；没设或不合法时用缺省值 */
export function envPort(name: 'E2E_SERVER_PORT' | 'E2E_CLIENT_PORT', fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 && v < 65536 ? v : fallback;
}
