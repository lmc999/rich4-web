// 调试：复现 server 集成测试 full-game-4p（stubEngine、4 名真人 bot 自动打到终局）在高负载下偶发的
// 「bots.acts 里出现 ok=false 且不是 STALE_DECISION」——打印这些 act 的错误码与 intent，判断是负载时序还是投影改动导致。
// 用法：npx tsx test/verify-fullgame4p-acts.ts [轮数=6] [并发=4]
import { closeAll, setupRoom, startGame } from '../apps/server/test/helpers/scenario';
import { startTestServer } from '../apps/server/test/helpers/startTestServer';

const rounds = Number(process.argv[2] ?? 6);
const par = Number(process.argv[3] ?? 4);

async function once(tag: string): Promise<string[]> {
  const srv = await startTestServer({ rateLimitScale: 0 });
  const s = await setupRoom(srv.url, { humans: 4, settings: { game: { timeLimitDays: 30, initialFund: 10000 } } });
  try {
    await startGame(s);
    for (const b of s.bots) b.autoPlay();
    for (const b of s.bots) await b.until(() => b.over !== undefined, 120_000, 'game over');
    const bad: string[] = [];
    for (const [i, b] of s.bots.entries()) {
      for (const a of b.acts) {
        if (a.result.ok || a.result.error.code === 'STALE_DECISION') continue;
        bad.push(`${tag} seat${i} ${JSON.stringify(a).slice(0, 400)}`);
      }
    }
    return bad;
  } finally {
    closeAll(s.bots);
    await srv.close();
  }
}

let total = 0;
const all: string[] = [];
for (let r = 0; r < rounds; r++) {
  const res = await Promise.all(Array.from({ length: par }, (_, k) => once(`r${r}k${k}`).catch((e) => [`r${r}k${k} ERROR ${e}`])));
  for (const x of res) {
    total++;
    all.push(...x);
  }
  console.log(`round ${r}: bad so far ${all.length}`);
}
console.log(`games ${total}, bad acts ${all.length}`);
for (const l of all.slice(0, 20)) console.log(l);
process.exit(0);
