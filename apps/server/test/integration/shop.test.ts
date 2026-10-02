/**
 * 百货公司道具的服务器校验（按原版：一次买 1 个、每种每次进店只能买一次；真人货架只列进店时有库存的道具）。
 * 真实引擎（不论 RICH4_TEST_ENGINE），2 个真人 bot，fixture 地图 9 → 10（百货公司）：
 * 改过的客户端直接发 SHOP_BUY_ITEM{qty: 2} 或重复购买同一种道具，服务器以 INVALID_ACTION{rule} 拒绝，state 不变；
 * 下发给本人的 SHOP options 里 maxQty 只有 0 / 1，买过的一行 bought=true。
 * @source v2.06 0x42d869 call fcn.0042c64b(座位, 道具)（无数量参数）；0x42d9cf 买后货架行 0x489070[行] 清零。
 */
import type { ShopOptions } from '@rich4/shared/engine';
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

async function debug(host: BotClient, op: unknown): Promise<void> {
  const r = await host.req('debug:act', { op } as never);
  expect(r.ok, JSON.stringify(r)).toBe(true);
}

function shopOf(b: BotClient): ShopOptions {
  expect(b.yourDecision?.kind).toBe('SHOP');
  return b.yourDecision!.options as ShopOptions;
}

function myItems(b: BotClient, item: number): number {
  const me = b.view!.players.find((p) => p.seat === 0)!;
  return me.items?.[item] ?? 0;
}

describe('integration/shop', () => {
  it('SHOP_BUY_ITEM：qty ≠ 1 与同一次进店重复购买都被服务器拒绝（INVALID_ACTION），换一种道具照常能买', async () => {
    srv = await startTestServer({ engine: 'real', rateLimitScale: 0 });
    const s = await setupRoom(srv.url, { humans: 2, settings: { timerPreset: 'off' } });
    bots.push(...s.bots);
    await startGame(s);
    const host = s.host;
    await host.until(() => host.yourDecision?.kind === 'TURN_MENU', 5000, 'menu');
    // 收走开局随机摆在路上的神明、礼物、宝箱：否则 10 号格上偶尔有宝箱（+500 点券）或别的决策插在 SHOP 之前
    await debug(host, { op: 'clearBoard' });
    await host.until(() => host.yourDecision?.kind === 'TURN_MENU', 3000, 'menu after clearBoard');
    await debug(host, { op: 'setPoints', seat: 0, points: 500 });
    await debug(host, { op: 'teleport', seat: 0, node: 9, prev: 8 });
    await debug(host, { op: 'forceNext', purpose: 'dice', values: [1] });
    await host.until(() => host.yourDecision?.kind === 'TURN_MENU', 3000, 'menu');
    expect((await host.act(host.yourDecision!.decisionId, { type: 'ROLL' })).ok).toBe(true);
    await host.until(() => host.yourDecision?.kind === 'SHOP', 5000, 'SHOP');

    const o = shopOf(host);
    expect(o.fullDeck).toBe(false);
    expect(o.items.every((r) => r.maxQty === 0 || r.maxQty === 1)).toBe(true);
    // 2 名真人 → 开局锁定私密手牌：下发的共享库存只留有没有货（view/project.ts projectDecisionOptions），
    // 否则拿 10 减去自己的持有数与剩余数就能推出别人手上的道具；服务器内部仍是真实库存
    expect(srv.app.rooms.get(s.code)!.settings.handVisibility).toBe('private');
    expect(o.items.every((r) => r.pool === 0 || r.pool === 1)).toBe(true);
    expect(o.items.find((r) => r.item === 8)!.pool).toBe(1);
    expect(o.items.find((r) => r.item === 8)).toMatchObject({ maxQty: 1, bought: false, listed: true });
    const own8 = myItems(host, 8);

    // 改过的客户端：一次买 2 个 → 拒绝，决策不变
    const d1 = host.yourDecision!.decisionId;
    expect(await host.act(d1, { type: 'SHOP_BUY_ITEM', item: 8, qty: 2 })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ACTION', details: { rule: 'OUT_OF_RANGE' } },
    });
    expect(host.yourDecision!.decisionId).toBe(d1);
    expect(host.view!.players.find((p) => p.seat === 0)!.points).toBe(500);

    // 买 1 个：成功，以新 decisionId 重发 SHOP，这一种 bought=true、maxQty=0
    expect((await host.act(d1, { type: 'SHOP_BUY_ITEM', item: 8, qty: 1 })).ok).toBe(true);
    await host.until(() => host.yourDecision?.kind === 'SHOP' && host.yourDecision.decisionId !== d1, 3000, 're-ask');
    expect(myItems(host, 8)).toBe(own8 + 1);
    expect(host.view!.players.find((p) => p.seat === 0)!.points).toBe(470);
    expect(shopOf(host).items.find((r) => r.item === 8)).toMatchObject({ maxQty: 0, bought: true });

    // 改过的客户端：同一次进店再买同一种 → 拒绝
    const d2 = host.yourDecision!.decisionId;
    expect(await host.act(d2, { type: 'SHOP_BUY_ITEM', item: 8, qty: 1 })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ACTION', details: { rule: 'NOT_ALLOWED' } },
    });
    expect(myItems(host, 8)).toBe(own8 + 1);

    // 别的道具照常能买，然后离开
    expect((await host.act(d2, { type: 'SHOP_BUY_ITEM', item: 2, qty: 1 })).ok).toBe(true);
    await host.until(() => host.yourDecision?.kind === 'SHOP' && host.yourDecision.decisionId !== d2, 3000, 're-ask');
    expect((await host.act(host.yourDecision!.decisionId, { type: 'LEAVE' })).ok).toBe(true);
  }, 30_000);
});
