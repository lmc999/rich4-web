/**
 * 并发拍卖的联机流程（design/engine.md §9.5；architecture §5.9 AUCTION_BID「每人独立计时」、M7 验证 2）。
 * 真实引擎（不论 RICH4_TEST_ENGINE），4 个真人 bot：
 *   0 号停到新闻格、抽到新闻 7（无主地公开拍卖，无卖方，4 人都能出价）→ 4 个 AUCTION_BID 同时待答、各自有截止时间；
 *   4 个 bot 同时出价：先到的成交为领先者，其余 3 个请求因待答已被清掉而收到 STALE_DECISION；
 *   之后每个待答各自计时：有人 PASS 不影响别人的截止时间；到期的按 defaultIntent（PASS）代答，拍卖以领先者成交。
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

describe('integration/auction', () => {
  it('4 个 bot 同时出价：先到者领先，落后的请求 STALE_DECISION；每个待答各自计时，超时按 PASS 结算', async () => {
    // 计时缩到 10%：AUCTION_BID 的 15 秒约 1.5 秒
    srv = await startTestServer({ engine: 'real', rateLimitScale: 0, timing: { timerScale: 0.1 } });
    const s = await setupRoom(srv.url, { humans: 4, settings: { timerPreset: 'normal' } });
    bots.push(...s.bots);
    await startGame(s);
    const host = s.host;
    await host.until(() => host.yourDecision?.kind === 'TURN_MENU', 5000, 'menu');
    await debug(host, { op: 'clearBoard' });
    await debug(host, { op: 'stackDeck', deck: 'news', ids: [7] });
    await debug(host, { op: 'teleport', seat: 0, node: 1, prev: 18 });
    await debug(host, { op: 'forceNext', purpose: 'dice', values: [1] });
    await debug(host, { op: 'forceNext', purpose: 'news', values: [0] });
    await host.until(() => host.yourDecision?.kind === 'TURN_MENU', 3000, 'menu');
    expect((await host.act(host.yourDecision!.decisionId, { type: 'ROLL' })).ok).toBe(true);

    // 4 个竞拍者同时待答，各有自己的截止时间
    for (const b of s.bots) await b.until(() => b.yourDecision?.kind === 'AUCTION_BID', 3000, 'AUCTION_BID');
    const started = eventsOf(host).find((e) => e.type === 'AUCTION_STARTED');
    expect(started).toMatchObject({ lot: 'L1', seller: null, source: 'news', bidders: [0, 1, 2, 3] });
    const bidPending = host.pending.filter((p) => p.kind === 'AUCTION_BID');
    expect(bidPending.map((p) => p.seat)).toEqual([0, 1, 2, 3]);
    expect(bidPending.every((p) => p.timing === 'auction' && p.deadlineAt !== null)).toBe(true);

    // 同时出价：只有一个请求被接受
    const firstIds = s.bots.map((b) => b.yourDecision!.decisionId);
    const results = await Promise.all(s.bots.map((b, i) => b.act(firstIds[i]!, { type: 'BID', inc: 100 })));
    const ok = results.map((r, i) => (r.ok ? i : -1)).filter((i) => i >= 0);
    expect(ok).toHaveLength(1);
    const leader = ok[0]!;
    for (const [i, r] of results.entries()) {
      if (i !== leader) expect(r).toMatchObject({ ok: false, error: { code: 'STALE_DECISION' } });
    }

    // 其余 3 人按新价格重新被问（新 id、新截止时间）；领先者不再被问
    const others = s.bots.filter((_, i) => i !== leader);
    for (const b of others) {
      await b.until(
        () => b.yourDecision?.kind === 'AUCTION_BID' && !firstIds.includes(b.yourDecision.decisionId),
        3000,
        're-ask',
      );
    }
    await host.until(() => host.pending.filter((p) => p.kind === 'AUCTION_BID').length === 3, 3000, '3 pending');
    const before = new Map(host.pending.map((p) => [p.seat, p.deadlineAt]));
    expect(before.has(leader as 0)).toBe(false);

    // 一人 PASS：不影响另外两人的截止时间（各自独立计时）
    const passer = others[0]!;
    expect((await passer.act(passer.yourDecision!.decisionId, { type: 'PASS' })).ok).toBe(true);
    await host.until(() => host.pending.filter((p) => p.kind === 'AUCTION_BID').length === 2, 3000, '2 pending');
    for (const p of host.pending.filter((x) => x.kind === 'AUCTION_BID')) {
      expect(p.deadlineAt).toBe(before.get(p.seat));
    }

    // 剩下两人不答：各自到期按 PASS 代答，拍卖以领先者成交
    await host.until(() => eventsOf(host).some((e) => e.type === 'AUCTION_ENDED'), 10000, 'AUCTION_ENDED');
    const ended = eventsOf(host).find((e) => e.type === 'AUCTION_ENDED');
    expect(ended).toMatchObject({ lot: 'L1', winner: leader, price: 2100 });
    expect(host.view?.lands.find((l) => l.id === 'L1')?.owner).toBe(leader);
    for (const b of s.bots) expect(b.gaps).toEqual([]);
  });
});
