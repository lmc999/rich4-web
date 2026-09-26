/**
 * 联机冒烟：N 个 bot 连到运行中的服务器，建房、入座、开局、自动玩到 game:over，
 * 校验每个 bot 收到的 seq 连续无缺口、没有 app:error。
 *
 * 用法：npx tsx apps/server/scripts/botplay.ts --url http://localhost:3000 --bots 4 --map test [--days 30] [--timeout 180]
 * （真实引擎完成前可用 RICH4_TEST_ENGINE=stub 启动服务器）
 */
import { parseArgs } from 'node:util';
import type { CharacterId, TimeLimitDays } from '@rich4/shared/engine';
import { type BotClient, connectBot } from '../test/helpers/botClient';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:3000' },
    bots: { type: 'string', default: '4' },
    map: { type: 'string', default: 'test' },
    days: { type: 'string', default: '30' },
    timeout: { type: 'string', default: '180' },
    delay: { type: 'string', default: '40' },
  },
});

const DAYS = new Set([0, 730, 365, 182, 91, 30]);

async function main(): Promise<number> {
  const n = Number(values.bots);
  const days = Number(values.days);
  if (!Number.isInteger(n) || n < 2 || n > 4) throw new Error('--bots 必须是 2..4');
  if (!DAYS.has(days)) throw new Error('--days 必须是 0/730/365/182/91/30 之一');
  const url = values.url!;
  const t0 = Date.now();
  const bots: BotClient[] = [];
  for (let i = 0; i < n; i++) bots.push(await connectBot(url, { nickname: `bot${i}`, seed: i + 1 }));
  const host = bots[0]!;
  const created = await host.req('room:create', {
    settings: { game: { mapId: values.map!, timeLimitDays: days as TimeLimitDays } },
  });
  if (!created.ok) throw new Error(`room:create: ${created.error.code}`);
  const code = created.data.code;
  console.log(`room ${code} (${values.map}, ${days} 天) ← ${url}`);
  for (const b of bots.slice(1)) {
    const r = await b.req('room:join', { code, role: 'player' });
    if (!r.ok) throw new Error(`room:join: ${r.error.code}`);
  }
  for (const [i, b] of bots.entries()) {
    const r = await b.req('room:selectCharacter', { characterId: i as CharacterId });
    if (!r.ok) throw new Error(`selectCharacter: ${r.error.code}`);
    if (i > 0) await b.req('room:setReady', { ready: true });
  }
  const started = await host.req('room:start', {});
  if (!started.ok) throw new Error(`room:start: ${started.error.code} ${JSON.stringify(started.error.details ?? {})}`);
  for (const b of bots) b.autoPlay(undefined, { delayMs: Number(values.delay) });

  const deadline = Number(values.timeout) * 1000;
  let lastLog = Date.now();
  for (const b of bots) {
    await b.until(
      () => {
        if (Date.now() - lastLog > 5000) {
          lastLog = Date.now();
          console.log(`  … seq ${host.lastSeq}，第 ${host.view?.clock.elapsedDays ?? 0} 天`);
        }
        return b.over !== undefined;
      },
      deadline,
      'game:over',
    );
  }
  await new Promise((r) => setTimeout(r, 300));
  let ok = true;
  for (const b of bots) {
    const seqs = b.batches.map((x) => x.seq);
    const contiguous = seqs.every((s, i) => s === i + 1);
    const status = b.gaps.length === 0 && contiguous && b.errors.length === 0 ? 'ok' : 'FAIL';
    if (status !== 'ok') ok = false;
    console.log(
      `${b.nickname}: batches=${b.batches.length} lastSeq=${b.lastSeq} gaps=${b.gaps.length} errors=${b.errors.length} ${status}`,
    );
  }
  const r = host.over!.result;
  console.log(`game:over reason=${r.reason} winner=${r.winner} days=${r.elapsedDays} (${Date.now() - t0}ms)`);
  for (const b of bots) b.close();
  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
