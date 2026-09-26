// 临时调试：用真实引擎起测试服务器，4 个 bot 自动对局，打印事件类型分布与结束原因。
// 用法：npx tsx test/m2-real-engine-probe.ts [stub|real]
import { setupRoom, startGame } from '../apps/server/test/helpers/scenario';
import { startTestServer } from '../apps/server/test/helpers/startTestServer';

const kind = (process.argv[2] === 'stub' ? 'stub' : 'real') as 'stub' | 'real';
const srv = await startTestServer({ engine: kind, rateLimitScale: 0 });
const s = await setupRoom(srv.url, { humans: 4, settings: { game: { timeLimitDays: 30, initialFund: 10000 } } });
await startGame(s);
for (const b of s.bots) b.autoPlay();
await s.host.until(() => s.host.over !== undefined, 60_000, 'game over');
const tally: Record<string, number> = {};
for (const b of s.host.batches) for (const e of b.events) tally[e.type] = (tally[e.type] ?? 0) + 1;
console.log('engine', srv.engineKind, srv.engine.ENGINE_VERSION, 'batches', s.host.batches.length);
console.log('result', s.host.over?.result.reason, 'winner', s.host.over?.result.winner);
console.log('kinds', [...new Set(s.host.acts.map((a) => a.intent.type))].join(','));
console.log(tally);
for (const b of s.bots) b.close();
await srv.close();
