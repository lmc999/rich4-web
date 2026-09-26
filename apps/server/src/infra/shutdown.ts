/**
 * 优雅停机（design/net.md §8.5）：/readyz 转 503 → 广播 server:notice{shutdown} → 暂停对局（M5 写快照与自动存档）
 * → 关闭 io 与 HTTP → 退出。超过 timeoutMs 强制退出。
 */
import type { Logger } from './logger';

export interface Stoppable {
  shutdown(reason: string): Promise<void>;
}

export function installShutdown(app: Stoppable, log: Logger, o: { timeoutMs?: number } = {}): () => void {
  let stopping = false;
  const onSignal = (sig: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    log.info({ sig }, 'shutting down');
    const force = setTimeout(() => {
      log.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, o.timeoutMs ?? 25_000);
    force.unref();
    app
      .shutdown(sig)
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        log.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  return () => {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  };
}
