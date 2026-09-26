// 调试：自对弈若干天，统计每天收盘时处于涨停 / 跌停的股票比例（观察行情是否过于剧烈）。用法：npx tsx test/integ-stock-limits.ts
import { intentRng, newGame, randomAction } from '@rich4/shared/engine-testing';

async function main(): Promise<void> {
  const g = newGame({ players: ['ai', 'ai', 'ai', 'ai'], seed: 'abc123', map: 'test', config: { timeLimitDays: 0 } });
  const rng = intentRng('beef');
  let s = g.state;
  let lastDate = s.clock.date;
  const days: { date: number; up: number; down: number; n: number; moves: number[] }[] = [];
  for (let i = 0; i < 20000 && s.status === 'playing' && days.length < 60; i++) {
    const a = randomAction(s, rng);
    if (!a) break;
    s = g.engine.applyAction(s, a).state;
    if (s.clock.date !== lastDate) {
      lastDate = s.clock.date;
      const st = s.stocks;
      const moves = st.map((x) =>
        x.prevCents > 0 ? Math.round(((x.priceCents - x.prevCents) * 1000) / x.prevCents) : 0,
      );
      days.push({
        date: s.clock.date,
        up: moves.filter((m) => m >= 95).length,
        down: moves.filter((m) => m <= -95).length,
        n: st.length,
        moves,
      });
    }
  }
  let up = 0;
  let down = 0;
  let n = 0;
  for (const d of days) {
    up += d.up;
    down += d.down;
    n += d.n;
  }
  console.log(
    `days=${days.length} limitUp=${((up / n) * 100).toFixed(1)}% limitDown=${((down / n) * 100).toFixed(1)}%`,
  );
  console.log(
    days
      .slice(0, 8)
      .map((d) => `${d.date}: ${d.moves.join(' ')}`)
      .join('\n'),
  );
}

main();
