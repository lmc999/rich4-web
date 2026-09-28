/**
 * 只有一名真人时不限时（design/net.md §5.4 有效计时档位）：
 * - 一名真人 + 三个电脑：房间设置仍是 fast，但 room:state 的 effectiveTimerPreset 为 off，待决策没有截止时间，不会超时；
 * - 两名真人：按档位计时；一人 room:leave 后剩下那位收到 game:pending，当前决策的截止时间被取消、之后不再给；
 *   离开的人同一 token 回来后按档位重新计时；
 * - 读档：存档里两名真人、只有一人入座（另一座位补电脑）开局时不限时。
 */
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const AI = { preset: 'normal' } as const;

describe('integration/untimed-solo', () => {
  it('一名真人 + 三个电脑：有效档位 off，待决策没有截止时间，久等也不超时', async () => {
    // 计时缩到 2%：fast 档回合菜单 0.3 秒就会超时（如果计时的话）
    srv = await startTestServer();
    const s = await setupRoom(srv.url, {
      humans: 1,
      ais: [
        { seat: 1, ai: AI },
        { seat: 2, ai: AI },
        { seat: 3, ai: AI },
      ],
      settings: { timerPreset: 'fast' },
    });
    bots.push(...s.bots);
    const a = s.host;
    expect(a.room!.effectiveTimerPreset).toBe('off');
    await startGame(s);
    await a.until(() => a.yourDecision !== undefined, 10_000, 'my decision');
    expect(a.room!.settings.timerPreset).toBe('fast');
    expect(a.room!.effectiveTimerPreset).toBe('off');
    expect(a.yourDecision!.deadlineAt).toBeNull();
    expect(a.pending.every((p) => p.deadlineAt === null)).toBe(true);
    const seq = a.lastSeq;
    await sleep(1500);
    expect(a.lastSeq).toBe(seq);
    expect(a.batches.some((b) => b.cause.by === 'timeout')).toBe(false);
    expect(a.room!.seats[0]!.control).toBe('human');
  });

  it('两名真人：按档位计时；一人离开后当前决策的截止时间被取消，回来后重新计时', async () => {
    srv = await startTestServer({ timing: { timerScale: 1 } });
    const s = await setupRoom(srv.url, {
      humans: 2,
      ais: [
        { seat: 2, ai: AI },
        { seat: 3, ai: AI },
      ],
      settings: { timerPreset: 'normal' },
    });
    bots.push(...s.bots);
    const [a, b] = s.bots as [BotClient, BotClient];
    expect(a.room!.effectiveTimerPreset).toBe('normal');
    await startGame(s);
    await a.until(() => a.yourDecision !== undefined || b.yourDecision !== undefined, 10_000, 'a human decision');
    const [me, other] = a.yourDecision ? [a, b] : [b, a];
    const decisionId = me.yourDecision!.decisionId;
    expect(me.yourDecision!.deadlineAt).not.toBeNull();
    expect(me.room!.effectiveTimerPreset).toBe('normal');

    expect((await other.req('room:leave', {})).ok).toBe(true);
    await me.until(
      () => me.yourDecision?.deadlineAt === null && me.room?.effectiveTimerPreset === 'off',
      3000,
      'deadline cancelled',
    );
    expect(me.yourDecision!.decisionId).toBe(decisionId);
    expect(me.pending.every((p) => p.deadlineAt === null)).toBe(true);
    // 房间设置本身不变
    expect(me.room!.settings.timerPreset).toBe('normal');

    // 同一 token 回来：两名真人，从现在起按档位给截止时间
    expect((await other.reconnect(s.code)).ok).toBe(true);
    await me.until(
      () => me.yourDecision?.deadlineAt != null && me.room?.effectiveTimerPreset === 'normal',
      3000,
      'deadline restored',
    );
    const serverNow = me.room!.serverNow;
    expect(me.yourDecision!.deadlineAt!).toBeGreaterThan(serverNow + 20_000);
  });

  it('读档：存档里两名真人，只有房主入座、另一座位补电脑开局时不限时', async () => {
    srv = await startTestServer({ rateLimitScale: 0, timing: { timerScale: 1 } });
    const s = await setupRoom(srv.url, { humans: 2, settings: { timerPreset: 'fast' } });
    bots.push(...s.bots);
    const [host, p1] = s.bots as [BotClient, BotClient];
    await startGame(s);
    await host.until(() => host.pending.some((p) => p.deadlineAt !== null), 5000, 'timed');
    const sv = await host.req('game:save', { name: 'duo' });
    if (!sv.ok) throw new Error(sv.error.code);
    expect((await host.req('room:dissolve', {})).ok).toBe(true);
    await p1.until(() => p1.closedReason === 'dissolved', 3000, 'closed');

    const c = await host.req('room:create', { settings: {} });
    if (!c.ok) throw new Error(c.error.code);
    expect((await host.req('room:loadSave', { saveId: sv.data.saveId })).ok).toBe(true);
    await host.until(() => host.room?.loadedSave !== undefined, 3000, 'loaded');
    expect(host.room!.settings.timerPreset).toBe('fast');
    const seatOfP1 = (host.room!.seats.find((x) => x.savedSeat?.nickname === 'P1') ?? host.room!.seats[1]!).index;
    expect((await host.req('room:setSeatAi', { seat: seatOfP1, ai: AI })).ok).toBe(true);
    await host.until(() => host.room?.effectiveTimerPreset === 'off', 3000, 'lobby effective off');
    expect((await host.req('room:start', {})).ok).toBe(true);
    await host.until(() => host.room?.phase === 'playing' && host.view !== undefined, 5000, 'started');
    await host.until(() => host.pending.length > 0, 5000, 'pending');
    expect(host.room!.effectiveTimerPreset).toBe('off');
    expect(host.pending.every((p) => p.deadlineAt === null)).toBe(true);
  });
});
