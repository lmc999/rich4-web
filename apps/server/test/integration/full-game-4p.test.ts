import type { GameState } from '@rich4/shared/engine';
import { canonicalJson } from '@rich4/shared/util';
import type { GameView } from '@rich4/shared/view';
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

function assertContinuous(b: BotClient): void {
  expect(b.gaps).toEqual([]);
  const seqs = b.batches.map((x) => x.seq);
  expect(seqs).toEqual(seqs.map((_, i) => i + 1));
}

/** 用内存 journal 从开局重放，状态必须与房间内存状态一致 */
function replayMatches(t: TestServer, code: string): void {
  const room = t.app.rooms.get(code)!;
  const runner = room.runner!;
  const journal = runner.journal();
  expect(journal.length).toBe(runner.seq);
  // 以开局时的状态（seq 0）为起点逐条重放 journal
  let s: GameState = initialStates.get(code)!;
  for (const j of journal) s = t.engine.applyAction(s, j.action).state;
  expect(canonicalJson(s)).toBe(canonicalJson(runner.state));
}

const initialStates = new Map<string, GameState>();

function captureInitial(t: TestServer, code: string): void {
  initialStates.set(code, t.app.rooms.get(code)!.runner!.state);
}

describe('integration/full-game-4p', () => {
  it('4 个 bot 自动玩到 game:over：seq 连续、终局视图除各自手牌外一致（联机自动私密）、journal 重放一致、没有 app:error', async () => {
    srv = await startTestServer({ rateLimitScale: 0 });
    const s = await setupRoom(srv.url, {
      humans: 4,
      settings: { game: { timeLimitDays: 30, initialFund: 10000 } },
    });
    bots.push(...s.bots);
    await startGame(s);
    captureInitial(srv, s.code);
    for (const b of s.bots) b.autoPlay();
    for (const b of s.bots) await b.until(() => b.over !== undefined, 60_000, 'game over');
    const final = srv.app.rooms.get(s.code)!.runner!;
    for (const b of s.bots) {
      await b.until(() => b.lastSeq === final.seq, 5000, 'last batch');
      assertContinuous(b);
      expect(b.errors).toEqual([]);
      expect(b.over!.epoch).toBe(1);
    }
    // 房间种子随机：资金 10000 时偶尔有人很早破产、以 lastStanding 提前结束（实测 89–96 批），
    // 只有打满 30 天的对局才要求批次数 > 100
    const reason = s.bots[0]!.over!.result.reason;
    expect(s.host.batches.length).toBeGreaterThan(reason === 'timeLimit' ? 100 : 40);
    // ≥ 2 名真人的联机对局开局锁定私密手牌（net/room.ts effectiveHandVisibility）：去掉只给本人看的 cards / items，
    // 以及按观察者裁剪的他人敌意（只保留「对观察者本人」一项，architecture §28.3）后四人的终局视图一致；
    // 各自只看得到自己的手牌与背包
    const strip = (v: GameView) => ({
      ...v,
      players: v.players.map(({ cards: _c, items: _i, hostility: _h, ...p }) => p),
    });
    const views = s.bots.map((b) => canonicalJson(strip(b.view!)));
    expect(new Set(views).size).toBe(1);
    for (const [i, b] of s.bots.entries()) {
      for (const p of b.view!.players) {
        expect(p.cards === null, `seat ${i} 看 ${p.seat}`).toBe(p.seat !== i);
        expect(p.items === null, `seat ${i} 看 ${p.seat}`).toBe(p.seat !== i);
      }
    }
    expect(s.bots[0]!.view!.status).toBe('over');
    expect(s.bots[0]!.over!.result.reason).toMatch(/timeLimit|lastStanding|noHumansLeft/);
    expect(s.bots.every((b) => b.acts.every((a) => a.result.ok || a.result.error.code === 'STALE_DECISION'))).toBe(
      true,
    );
    replayMatches(srv, s.code);
  }, 90_000);

  it('2 真人 + 2 AI：AI 座位由服务器代打，cause.by=ai', async () => {
    srv = await startTestServer({ rateLimitScale: 0 });
    const s = await setupRoom(srv.url, {
      humans: 2,
      ais: [
        { seat: 2, ai: { preset: 'normal' } },
        { seat: 3, ai: { preset: 'cunning' } },
      ],
      settings: { game: { timeLimitDays: 30, initialFund: 10000 } },
    });
    bots.push(...s.bots);
    await startGame(s);
    captureInitial(srv, s.code);
    for (const b of s.bots) b.autoPlay();
    for (const b of s.bots) await b.until(() => b.over !== undefined, 60_000, 'game over');
    const final = srv.app.rooms.get(s.code)!.runner!;
    for (const b of s.bots) {
      await b.until(() => b.lastSeq === final.seq, 5000, 'last batch');
      assertContinuous(b);
      expect(b.errors).toEqual([]);
    }
    const byAi = s.host.batches.filter((x) => x.cause.by === 'ai');
    expect(byAi.length).toBeGreaterThan(0);
    expect(new Set(byAi.map((x) => x.cause.seat))).toEqual(new Set([2, 3]));
    expect(s.host.room!.seats[2]!.control).toBe('ai');
    replayMatches(srv, s.code);
  }, 90_000);
});
