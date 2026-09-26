// 临时调试脚本：真实引擎 + 真实地图目录，1 个 bot 真人 + 3 个服务器 AI（BasicAiPolicy），
// 统计 AiDriver 的 warn/error（兜底 defaultIntent、intent 被拒、aiStuck 暂停）。
// 用法：npx tsx test/m2-ai-probe.ts [mapId=taiwan] [days=91]
import { BasicAiPolicy } from '@rich4/shared/ai';
import { createEngine, type TimeLimitDays } from '@rich4/shared/engine';
import { createApp } from '../apps/server/src/app';
import { loadConfig } from '../apps/server/src/config';
import { loadMapCatalog } from '../apps/server/src/data/DataRegistry';
import { createLogger, type LogLevel } from '../apps/server/src/infra/logger';
import { closeAll, setupRoom, startGame } from '../apps/server/test/helpers/scenario';

const mapId = process.argv[2] ?? 'taiwan';
const days = Number(process.argv[3] ?? '91') as TimeLimitDays;
const warns: string[] = [];
const log = createLogger({
  level: 'warn',
  sink: (line: string, level: LogLevel) => {
    if (level === 'warn' || level === 'error' || level === 'fatal') warns.push(line);
  },
});
const config = {
  ...loadConfig({ PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'warn', RICH4_TEST_MODE: '1' }),
  staticDir: null,
};
const catalog = await loadMapCatalog({ dataDir: config.rich4DataDir, defaultMap: config.defaultMap, log });
const engine = createEngine(catalog.registry, { devChecks: true });
const app = await createApp({
  config,
  catalog,
  engine,
  aiPolicy: BasicAiPolicy,
  log,
  timing: { timerScale: 0.05, animScale: 0 },
  aiThinkMs: [0, 0],
  rateLimitScale: 0,
});
const { url } = await app.listen(0, '127.0.0.1');
const t0 = Date.now();
const s = await setupRoom(url, {
  humans: 1,
  ais: [
    { seat: 1, ai: { preset: 'normal' } },
    { seat: 2, ai: { preset: 'cunning' } },
    { seat: 3, ai: { preset: 'character' } },
  ],
  settings: { game: { mapId, timeLimitDays: days } },
});
await startGame(s);
s.host.autoPlay();
await s.host.until(() => s.host.over !== undefined, 300_000, 'game over');
const runner = app.rooms.get(s.code)!.runner!;
await s.host.until(() => s.host.lastSeq === runner.seq, 5000, 'last batch');
const byAi = s.host.batches.filter((b) => b.cause.by === 'ai').length;
console.log(
  `map=${mapId} days=${days} seq=${runner.seq} gaps=${s.host.gaps.length} errors=${s.host.errors.length} ` +
    `aiBatches=${byAi} reason=${s.host.over!.result.reason} warns=${warns.length} ${Date.now() - t0}ms`,
);
for (const w of warns.slice(0, 20)) console.log(w);
closeAll(s.bots);
await app.close();
process.exit(warns.length === 0 && s.host.gaps.length === 0 && s.host.errors.length === 0 ? 0 : 1);
