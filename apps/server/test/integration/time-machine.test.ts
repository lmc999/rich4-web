/**
 * 时光机与服务器的座位控制方（design/engine.md §9.2、§10.10；DEV-05）。
 * 真实引擎（不论 RICH4_TEST_ENGINE），3 个真人 bot：
 *   0 号掷骰（记下 global 锚点，此时 2 号还是真人）→ 房主踢掉 2 号（SYS_SET_CONTROLLER{ai}，服务器改由电脑代打）
 *   → 1 号用时光机回到 0 号掷骰之前。回滚不能把 2 号在引擎里变回真人：引擎与 GameRunner 的控制方必须一致，
 *   之后 2 号的回合照常由服务器的电脑代打。
 */
import type { GameEvent } from '@rich4/shared/engine';
import { afterEach, describe, expect, it } from 'vitest';
import type { BotClient } from '../helpers/botClient';
import { closeAll, setupRoom, startGame } from '../helpers/scenario';
import { startTestServer, type TestServer } from '../helpers/startTestServer';

let srv: TestServer | null = null;
const bots: BotClient[] = [];

afterEach(async () => {
  closeAll(bots.splice(0));
  await srv?.close();
  srv = null;
});

function eventsOf(b: BotClient): GameEvent[] {
  return b.batches.flatMap((x) => x.events);
}

async function debug(host: BotClient, op: unknown): Promise<void> {
  const r = await host.req('debug:act', { op } as never);
  expect(r.ok, JSON.stringify(r)).toBe(true);
}

describe('integration/time-machine', () => {
  it('踢人之后再回滚：被踢的座位在引擎里仍是电脑，服务器照常代打', async () => {
    srv = await startTestServer({ engine: 'real', rateLimitScale: 0 });
    const s = await setupRoom(srv.url, { humans: 3, settings: { timerPreset: 'off' } });
    bots.push(...s.bots);
    await startGame(s);
    const [host, p1] = s.bots as [BotClient, BotClient, BotClient];
    const room = srv.app.rooms.get(s.code)!;
    await host.until(() => host.yourDecision?.kind === 'TURN_MENU', 5000, 'menu');
    await debug(host, { op: 'clearBoard' });
    await debug(host, { op: 'give', seat: 1, cards: [], items: [{ item: 10, qty: 1 }] });
    // 0 号从 12 号格走 1 步停到 13 号（得 30 点，没有决策）
    await debug(host, { op: 'teleport', seat: 0, node: 12, prev: 11 });
    await debug(host, { op: 'forceNext', purpose: 'dice', values: [1] });
    await host.until(() => host.yourDecision?.kind === 'TURN_MENU', 3000, 'menu');
    const turnOfAnchor = room.runner!.state.clock.turnNo;
    expect((await host.act(host.yourDecision!.decisionId, { type: 'ROLL' })).ok).toBe(true);
    expect(room.runner!.state.secret.timeAnchor?.world.players[2]?.controller).toBe('human');

    // 锚点之后踢掉 2 号
    expect((await host.req('room:kick', { target: { seat: 2 } })).ok).toBe(true);
    expect(room.runner!.controlOf(2)).toBe('ai');
    expect(room.runner!.state.players[2]!.controller).toBe('ai');

    // 1 号用时光机
    await p1.until(() => p1.yourDecision?.kind === 'TURN_MENU', 5000, 'p1 menu');
    const r = await p1.act(p1.yourDecision!.decisionId, { type: 'USE_ITEM', item: 10, target: { t: 'none' } });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    await host.until(() => eventsOf(host).some((e) => e.type === 'TIME_REWOUND'), 3000, 'TIME_REWOUND');
    expect(eventsOf(host).find((e) => e.type === 'TIME_REWOUND')).toMatchObject({ bySeat: 1, toTurnNo: turnOfAnchor });
    expect(room.runner!.state.clock.turnNo).toBe(turnOfAnchor);
    // 引擎与服务器一致：2 号仍是电脑
    expect(room.runner!.state.players.map((p) => p.controller)).toEqual(['human', 'human', 'ai']);
    expect(room.runner!.controlOf(2)).toBe('ai');
    expect(host.view!.players[2]!.controller).toBe('ai');

    // 回到 0 号的回合菜单；0、1 号走完后 2 号的回合由服务器的电脑代打
    host.autoPlay();
    p1.autoPlay();
    await host.until(
      () => host.batches.some((b) => b.cause.seat === 2 && b.cause.by === 'ai' && b.cause.intentType === 'ROLL'),
      15_000,
      'seat 2 played by ai',
    );
    expect(room.runner!.state.players[2]!.controller).toBe('ai');
  }, 60_000);
});
