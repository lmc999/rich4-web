// 调试：apps/server/test/integration/shop.test.ts 偶发「点券 expected 1000 to be 500」——
// 复现同一流程（真实引擎、2 名真人 bot、fixture 地图 9 → 10 百货），点券不是 500 时打印 setPoints 之后到 SHOP 之间的事件。
// 用法：npx tsx test/verify-shop-points-flake.ts [次数=20] [clearBoard=0|1]
import type { GameEvent } from '@rich4/shared/engine';
import { closeAll, setupRoom, startGame } from '../apps/server/test/helpers/scenario';
import { startTestServer } from '../apps/server/test/helpers/startTestServer';

const n = Number(process.argv[2] ?? 20);
const clear = process.argv[3] === '1';
let bad = 0;
for (let i = 0; i < n; i++) {
  const srv = await startTestServer({ engine: 'real', rateLimitScale: 0 });
  const s = await setupRoom(srv.url, { humans: 2, settings: { timerPreset: 'off' } });
  try {
    await startGame(s);
    const host = s.host;
    const dbg = async (op: unknown) => {
      const r = await host.req('debug:act', { op } as never);
      if (!r.ok) throw new Error(JSON.stringify(r));
    };
    await host.until(() => host.yourDecision?.kind === 'TURN_MENU', 5000, 'menu');
    if (clear) await dbg({ op: 'clearBoard' });
    const mark = host.received.length;
    await dbg({ op: 'setPoints', seat: 0, points: 500 });
    await dbg({ op: 'teleport', seat: 0, node: 9, prev: 8 });
    await dbg({ op: 'forceNext', purpose: 'dice', values: [1] });
    await host.until(() => host.yourDecision?.kind === 'TURN_MENU', 3000, 'menu');
    await host.act(host.yourDecision!.decisionId, { type: 'ROLL' });
    await host.until(() => host.yourDecision?.kind === 'SHOP', 5000, 'SHOP');
    const pts = host.view!.players.find((p) => p.seat === 0)!.points;
    const room = srv.app.rooms.get(s.code)!;
    const statePts = room.runner!.state.players.find((p) => p.seat === 0)!.points;
    if (pts !== 500) {
      bad++;
      const evs: string[] = [];
      for (const m of host.received.slice(mark)) {
        const p = m.payload as { events?: GameEvent[] };
        if (m.event === 'game:batch' && p.events) for (const e of p.events) evs.push(JSON.stringify(e).slice(0, 220));
      }
      console.log(`#${i} view points ${pts} state points ${statePts} objects@start?`);
      for (const e of evs) console.log(`   ${e}`);
    }
  } catch (e) {
    console.log(`#${i} ERROR ${(e as Error).message}`);
  } finally {
    closeAll(s.bots);
    await srv.close();
  }
}
console.log(`runs ${n} bad ${bad} clearBoard=${clear}`);
process.exit(0);
