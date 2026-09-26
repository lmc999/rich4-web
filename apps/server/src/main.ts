/**
 * 服务端入口：读配置 → 加载地图目录 → 选择引擎与 AI 策略 → createApp → listen → 注册信号处理。
 * 用法：npx tsx apps/server/src/main.ts（RICH4_TEST_ENGINE=stub 可在真实引擎完成前联调）。
 */
import { createApp, resolveEngine } from './app';
import { ConfigError, loadConfig } from './config';
import { loadMapCatalog } from './data/DataRegistry';
import { createLogger } from './infra/logger';
import { installShutdown } from './infra/shutdown';

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
    process.exit(2);
  }
  const log = createLogger({ level: config.logLevel, pretty: config.logPretty });
  if (config.testMode) log.warn('RICH4_TEST_MODE=1：debug:act 已开启，不要在生产环境使用');
  const catalog = await loadMapCatalog({ dataDir: config.rich4DataDir, defaultMap: config.defaultMap, log });
  const { engine, policy } = await resolveEngine(config.testEngine, catalog, log, config.testMode, config.aiPolicy);
  log.info({ policy: policy.id }, 'ai policy');
  if (config.timerScale !== 1)
    log.warn({ timerScale: config.timerScale }, 'RICH4_TIMER_SCALE：决策计时已缩放（仅测试）');
  const app = await createApp({
    config,
    catalog,
    engine,
    aiPolicy: policy,
    log,
    ...(config.timerScale !== 1 ? { timing: { timerScale: config.timerScale } } : {}),
  });
  await app.listen();
  installShutdown(app, log);
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
