/**
 * 联机时对手与观战者看不到别人手上的卡片与道具（用户反馈；shared view/project.ts、net/room.ts effectiveHandVisibility）。
 * 真实引擎（不论 RICH4_TEST_ENGINE：stubEngine 不会发道具事件），不传 handVisibility，全靠开局时按真人座位数锁定：
 * - 2 名真人 + 电脑 + 观战者：开局锁定 private；1 号与观战者只看到 0 号的张数与总数；0 号出抢夺卡抢 1 号的道具，
 *   被抢的种类只有 0 号与 1 号看得到，被抢人对出卡人的敌意增量（= 被抢物标价）观战者也看不到；1 号断线重连（catchup）
 *   照样脱敏；之后自动打到终局，深度扫描每个人收到的全部 S2C 消息（findHandLeaks：卡号、道具号、牌堆张数、别人的敌意
 *   出现在任何未脱敏的位置都算泄漏）。
 * - 1 名真人 + 电脑：保持 public（和原版单机一样可以查看电脑的资产）。
 * - 重启恢复（房间快照）后仍是 private（快照里还是 public 的旧对局恢复时重新锁定：test/unit/restore.test.ts）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CARD, type GameEvent, ITEM, itemDef, type SeatIndex } from '@rich4/shared/engine';
import { findHandLeaks, type GameView } from '@rich4/shared/view';
import { afterEach, describe, expect, it } from 'vitest';
import { type BotClient, connectBot } from '../helpers/botClient';
import { closeAll, setupRoom, startGame } from '../helpers/scenario';
import { startTestServer, type TestServer } from '../helpers/startTestServer';

const servers: TestServer[] = [];
const bots: BotClient[] = [];
const dirs: string[] = [];

afterEach(async () => {
  closeAll(bots.splice(0));
  for (const s of servers.splice(0)) await s.close({ flush: false });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function serve(o: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const s = await startTestServer({ engine: 'real', rateLimitScale: 0, ...o });
  servers.push(s);
  return s;
}

async function spectator(url: string, code: string): Promise<BotClient> {
  const w = await connectBot(url, { nickname: 'W' });
  bots.push(w);
  const r = await w.req('room:join', { code, role: 'spectator' });
  if (!r.ok) throw new Error(r.error.code);
  return w;
}

async function debug(host: BotClient, op: unknown): Promise<void> {
  const r = await host.req('debug:act', { op } as never);
  expect(r.ok, JSON.stringify(r)).toBe(true);
}

function eventsOf(b: BotClient): GameEvent[] {
  const out: GameEvent[] = [];
  for (const m of b.received) {
    const p = m.payload as { events?: GameEvent[]; batches?: { events: GameEvent[] }[] };
    if (m.event === 'game:batch' && p.events) out.push(...p.events);
    if (m.event === 'game:catchup' && p.batches) for (const x of p.batches) out.push(...x.events);
  }
  return out;
}

const playerOf = (v: GameView | undefined, seat: SeatIndex) => v?.players.find((p) => p.seat === seat);
/** 本人视角下自己的背包合计（开局自带道具，按本人看到的算） */
const ownItems = (b: BotClient, seat: SeatIndex) => (playerOf(b.view, seat)!.items ?? []).reduce((x, y) => x + y, 0);

/** 这个观察者收到的全部 S2C 消息：没有别人手牌的泄漏；yourDecision 只属于本人 */
function assertNoLeaks(b: BotClient, own: SeatIndex | null): void {
  expect(b.received.length).toBeGreaterThan(0);
  const leaks = b.received.flatMap((m) => findHandLeaks(m.payload, own).map((l) => `${m.event} ${l}`));
  expect(leaks).toEqual([]);
  for (const m of b.received) {
    const yd = (m.payload as { yourDecision?: { seat: number } } | null)?.yourDecision;
    if (yd) expect(yd.seat).toBe(own);
  }
}

describe('integration/hand-privacy', () => {
  it('2 名真人：开局锁定私密；对手与观战者只看到张数与总数；抢夺卡的种类只给双方；重连与整局深度扫描无泄漏', async () => {
    const srv = await serve();
    const s = await setupRoom(srv.url, {
      humans: 2,
      ais: [{ seat: 2, ai: { preset: 'cunning' } }],
      settings: { timerPreset: 'off', game: { timeLimitDays: 30, initialFund: 10000 } },
    });
    bots.push(...s.bots);
    const w = await spectator(srv.url, s.code);
    expect(s.host.room?.settings.handVisibility).toBe('public');
    await startGame(s, [w]);
    const [a, b] = s.bots as [BotClient, BotClient];
    const room = srv.app.rooms.get(s.code)!;
    expect(room.settings.handVisibility).toBe('private');
    await a.until(() => a.room?.settings.handVisibility === 'private', 3000, 'room:state private');

    await a.until(() => a.yourDecision?.kind === 'TURN_MENU', 5000, 'menu');
    await debug(a, { op: 'clearBoard' });
    // 两人站在同一格（抢夺卡的范围内）；最后改 0 号（当前行动者），它的回合菜单才按新局面重算
    await debug(a, { op: 'give', seat: 1, cards: [CARD.FREE], items: [{ item: ITEM.MINE, qty: 1 }] });
    await debug(a, { op: 'teleport', seat: 1, node: 12, prev: 11 });
    await debug(a, {
      op: 'give',
      seat: 0,
      cards: [CARD.ROB, CARD.REVENGE, CARD.EQUAL_WEALTH],
      items: [
        { item: ITEM.REMOTE_DICE, qty: 3 },
        { item: ITEM.ROADBLOCK, qty: 1 },
      ],
    });
    await debug(a, { op: 'teleport', seat: 0, node: 12, prev: 11 });
    const seq = room.runner!.seq;
    for (const x of [a, b, w]) await x.until(() => x.lastSeq >= seq, 3000, 'debug batches');

    // 本人看得到自己的；1 号与观战者只看到张数与总数，牌堆为 null
    expect(playerOf(a.view, 0)).toMatchObject({ cards: [CARD.ROB, CARD.REVENGE, CARD.EQUAL_WEALTH], cardCount: 3 });
    expect(playerOf(a.view, 0)!.items![ITEM.REMOTE_DICE]).toBeGreaterThanOrEqual(3);
    const items0 = ownItems(a, 0);
    const items1 = ownItems(b, 1);
    expect(playerOf(a.view, 0)!.itemCount).toBe(items0);
    for (const x of [b, w]) {
      expect(playerOf(x.view, 0)).toMatchObject({ cards: null, items: null, cardCount: 3, itemCount: items0 });
      expect(x.view!.pools).toBeNull();
    }
    expect(a.view!.pools).toBeNull();
    expect(playerOf(b.view, 1)).toMatchObject({ cards: [CARD.FREE], cardCount: 1, itemCount: items1 });
    expect(playerOf(a.view, 1)).toMatchObject({ cards: null, items: null, cardCount: 1, itemCount: items1 });
    expect(playerOf(w.view, 1)).toMatchObject({ cards: null, items: null, cardCount: 1, itemCount: items1 });

    // 0 号的回合菜单：抢夺卡的对手清单只在 0 号自己的决策里（原版出抢夺卡时先看清单、可以取消）
    const robRow = () =>
      (a.yourDecision?.kind === 'TURN_MENU'
        ? (a.yourDecision.options as { cards: { slot: number; card: number; usable: boolean; targets: unknown }[] })
            .cards
        : []
      ).find((r) => r.card === CARD.ROB && r.usable);
    await a.until(() => robRow() !== undefined, 3000, 'rob usable');
    const row = robRow()!;
    const hate1before = playerOf(b.view, 1)!.hostility[0];
    expect(row.targets).toMatchObject({
      t: 'rob',
      victims: [
        {
          seat: 1,
          cards: [{ card: CARD.FREE }],
          items: expect.arrayContaining([expect.objectContaining({ item: ITEM.MINE })]),
        },
      ],
    });
    const r = await a.act(a.yourDecision!.decisionId, {
      type: 'USE_CARD',
      slot: row.slot,
      card: CARD.ROB,
      target: { t: 'rob', seat: 1, take: { k: 'item', item: ITEM.MINE } },
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const used = (x: BotClient) => eventsOf(x).find((e) => e.type === 'CARD_USED' && e.card === CARD.ROB);
    for (const x of [a, b, w]) await x.until(() => used(x) !== undefined, 3000, 'CARD_USED');
    const take = (x: BotClient) => (used(x) as Extract<GameEvent, { type: 'CARD_USED' }>).target;
    expect(take(a)).toEqual({ t: 'rob', seat: 1, take: { k: 'item', item: ITEM.MINE } });
    expect(take(b)).toEqual({ t: 'rob', seat: 1, take: { k: 'item', item: ITEM.MINE } });
    expect(take(w)).toEqual({ t: 'rob', seat: 1, take: { k: 'item', item: null } });
    const lost = (x: BotClient) => eventsOf(x).find((e) => e.type === 'ITEM_LOST' && e.cause === 'robbed');
    const gained = (x: BotClient) => eventsOf(x).find((e) => e.type === 'ITEM_GAINED' && e.source === 'rob');
    expect(lost(b)).toMatchObject({ seat: 1, item: ITEM.MINE, qty: 1 });
    expect(lost(w)).toMatchObject({ seat: 1, item: null, qty: 1 });
    expect(gained(a)).toMatchObject({ seat: 0, item: ITEM.MINE, qty: 1 });
    expect(gained(b)).toMatchObject({ seat: 0, item: null, qty: 1 });
    expect(gained(w)).toMatchObject({ seat: 0, item: null, qty: 1 });
    // 被抢人对出卡人的敌意正好加上被抢物的标价（effects/cards/money.ts rob → addHostility）：第三方看得到这个增量就能按价格
    // 反推出被抢的种类。私密模式下别人的敌意只留「对观察者本人」那一项（view/project.ts hideHostility）：
    // 被抢人看自己完整，出卡人看到对自己的一项（他本来就知道抢了什么），观战者全为 0；同一事件 post 里的也一样
    const robSeq = room.runner!.seq;
    for (const x of [a, b, w]) await x.until(() => x.lastSeq >= robSeq, 3000, 'rob batches');
    const hate = (x: BotClient) => playerOf(x.view, 1)!.hostility;
    const price = itemDef(ITEM.MINE).price;
    expect(hate(b)[0]).toBe(hate1before + price);
    expect(hate(a)).toEqual([hate1before + price, 0, 0, 0]);
    expect(hate(w)).toEqual([0, 0, 0, 0]);
    const lostHate = (x: BotClient) => lost(x)!.post?.players?.find((pp) => pp.seat === 1)?.set.hostility;
    expect(lostHate(b)?.[0]).toBe(hate1before + price);
    expect(lostHate(w)).toEqual([0, 0, 0, 0]);

    // 1 号断线，期间 0 号再拿道具；重连走 catchup，补发的事件与视图同样脱敏
    b.drop();
    await a.until(() => a.room?.seats[1]?.occupant?.kind === 'human' && !a.room.seats[1].occupant.connected, 3000);
    await debug(a, { op: 'give', seat: 0, cards: [], items: [{ item: ITEM.TIME_MACHINE, qty: 1 }] });
    const res = await b.reconnect(s.code);
    expect(res.ok).toBe(true);
    expect(b.received.some((m) => m.event === 'game:catchup' || m.event === 'game:snapshot')).toBe(true);
    await a.until(() => a.lastSeq === room.runner!.seq, 3000, 'a caught up');
    // 抢来 1 个地雷 + 时光机 1 台
    expect(ownItems(a, 0)).toBe(items0 + 2);
    expect(playerOf(b.view, 0)).toMatchObject({ cards: null, items: null, itemCount: items0 + 2 });

    // 自动打到终局（电脑按全量视图决策，真人 bot 按自己的视图），再深度扫描所有人收到的全部消息
    a.autoPlay();
    b.autoPlay();
    await w.until(() => w.over !== undefined, 90_000, 'game over');
    await new Promise((res) => setTimeout(res, 50));
    assertNoLeaks(a, 0);
    assertNoLeaks(b, 1);
    assertNoLeaks(w, null);
    // 确实覆盖到了事件脱敏（整局里观战者至少见过一次被隐藏的卡片得失）
    expect(eventsOf(w).some((e) => (e.type === 'CARD_GAINED' || e.type === 'CARD_LOST') && e.card === null)).toBe(true);
  }, 120_000);

  it('1 名真人 + 电脑：保持公开，可以查看电脑的卡片与道具（原版单机）', async () => {
    const srv = await serve();
    const s = await setupRoom(srv.url, {
      humans: 1,
      ais: [
        { seat: 1, ai: { preset: 'cunning' } },
        { seat: 2, ai: { preset: 'normal' } },
      ],
      settings: { timerPreset: 'off' },
    });
    bots.push(...s.bots);
    await startGame(s);
    const a = s.host;
    expect(srv.app.rooms.get(s.code)!.settings.handVisibility).toBe('public');
    await a.until(() => a.view !== undefined, 3000, 'view');
    const mines = playerOf(a.view, 1)!.items![ITEM.MINE]!;
    await debug(a, { op: 'give', seat: 1, cards: [CARD.ROB], items: [{ item: ITEM.MINE, qty: 2 }] });
    await a.until(() => (playerOf(a.view, 1)?.cardCount ?? 0) >= 1, 3000, 'give');
    expect(playerOf(a.view, 1)!.cards).toContain(CARD.ROB);
    expect(playerOf(a.view, 1)!.items![ITEM.MINE]).toBe(mines + 2);
    expect(a.view!.pools).not.toBeNull();
  }, 30_000);

  it('重启恢复后仍是私密（锁定值随房间快照保存）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rich4-privacy-'));
    dirs.push(dir);
    const srv1 = await serve({ dataDir: dir, roomDefaults: { reconnectGraceSec: 30 } });
    const s = await setupRoom(srv1.url, { humans: 2, settings: { timerPreset: 'off' } });
    bots.push(...s.bots);
    await startGame(s);
    const [a, b] = s.bots as [BotClient, BotClient];
    await debug(a, { op: 'give', seat: 0, cards: [CARD.ROB], items: [{ item: ITEM.MINE, qty: 1 }] });
    await b.until(() => (playerOf(b.view, 0)?.cardCount ?? 0) >= 1, 3000, 'give');
    await a.until(() => (playerOf(a.view, 0)?.cardCount ?? 0) >= 1, 3000, 'give (a)');
    const items0 = ownItems(a, 0);
    await srv1.close();
    servers.splice(servers.indexOf(srv1), 1);

    const srv2 = await serve({ dataDir: dir, roomDefaults: { reconnectGraceSec: 30 } });
    expect(srv2.app.rooms.get(s.code)!.settings.handVisibility).toBe('private');
    const b2 = await connectBot(srv2.url, { token: b.token, nickname: 'P1', seed: 12 });
    bots.push(b2);
    expect((await b2.req('room:resume', { code: s.code, lastSeq: b.lastSeq, epoch: b.epoch })).ok).toBe(true);
    await b2.until(() => b2.view !== undefined && b2.epoch > b.epoch, 3000, 'snapshot');
    expect(playerOf(b2.view, 0)).toMatchObject({ cards: null, items: null, cardCount: 1, itemCount: items0 });
    expect(playerOf(b2.view, 1)!.cards).not.toBeNull();
    assertNoLeaks(b2, 1);
  }, 60_000);
});
