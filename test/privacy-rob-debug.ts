// 调试：debug give / teleport 之后 0 号的 TURN_MENU 里抢夺卡是否可用（npx tsx test/privacy-rob-debug.ts）
import { CARD, ITEM } from '@rich4/shared/engine';
import { setupRoom, startGame } from '../apps/server/test/helpers/scenario';
import { startTestServer } from '../apps/server/test/helpers/startTestServer';

const srv = await startTestServer({ engine: 'real', rateLimitScale: 0 });
const s = await setupRoom(srv.url, { humans: 2, settings: { timerPreset: 'off' } });
await startGame(s);
const a = s.bots[0]!;
await a.until(() => a.yourDecision?.kind === 'TURN_MENU', 5000, 'menu');
const room = srv.app.rooms.get(s.code)!;
const show = (tag: string) =>
  console.log(
    tag,
    JSON.stringify(room.runner!.state.players.map((p) => ({ seat: p.seat, node: p.node, placed: p.placed }))),
    a.yourDecision?.decisionId,
    JSON.stringify((a.yourDecision?.options as { cards: unknown }).cards),
  );
show('start');
const dbg = async (op: unknown) => console.log(JSON.stringify(await a.req('debug:act', { op } as never)));
await dbg({ op: 'clearBoard' });
await dbg({ op: 'give', seat: 1, cards: [CARD.FREE], items: [{ item: ITEM.MINE, qty: 1 }] });
await dbg({ op: 'teleport', seat: 1, node: 12, prev: 11 });
await dbg({ op: 'give', seat: 0, cards: [CARD.ROB], items: [] });
await dbg({ op: 'teleport', seat: 0, node: 12, prev: 11 });
await new Promise((r) => setTimeout(r, 300));
show('after');
for (const b of s.bots) b.close();
await srv.close();
