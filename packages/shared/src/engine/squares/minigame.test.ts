import { describe, expect, it } from 'vitest';
import { MINIGAME_SPECS } from '../../minigames/index';
import { MINIGAME_IDS } from '../../minigames/types';
import { scenario } from '../testing/scenario';
import { MINIGAME_MAX_SCORE, MINIGAME_SCORE_CAP, MINIGAME_SEED_MASK } from './minigame';

/**
 * 小游戏格（落点码 6/7/8；architecture §5.10；design/minigames-ai.md §2.1）。
 * fixture 'test'：15 → 16（企鹅挖宝）；20 → 19（七彩气球，prev=13）；19 → 20（喜从天降，prev=4）。
 */
const TILES = { penguin: [16, 15, 14], balloon: [19, 20, 13], xicong: [20, 19, 4] } as const;

function landOn(sc: ReturnType<typeof scenario>, seat: 0 | 1, id: keyof typeof TILES) {
  const [, node, prev] = TILES[id];
  return sc.untilMenu(seat).teleport(seat, node, prev).force('dice', 1).roll(seat);
}

describe('minigame square', () => {
  it('分数上限与 sim 的 spec 一致', () => {
    for (const id of MINIGAME_IDS) expect(MINIGAME_SCORE_CAP[id]).toBe(MINIGAME_SPECS[id].scoreSanityMax);
    expect(MINIGAME_MAX_SCORE).toEqual({ penguin: 188, balloon: null, xicong: null });
  });

  it('电脑座位：直接走不玩分支（50 + rand%20 点券，台词槽 rand&1），不产生决策', () => {
    const sc = scenario({ players: ['human', 'ai'] });
    const pts = () => sc.player(1).points;
    landOn(sc, 1, 'penguin');
    // 没有强制值：分数落在 50..69
    const e = sc.event('MINIGAME_ENDED');
    expect(e).toMatchObject({ seat: 1, minigameId: 'penguin', mode: 'skipped' });
    expect(e.score).toBeGreaterThanOrEqual(50);
    expect(e.score).toBeLessThanOrEqual(69);
    expect(sc.events.some((x) => x.type === 'MINIGAME_STARTED')).toBe(false);
    expect(sc.state.pending.some((d) => d.kind === 'MINIGAME')).toBe(false);
    // 强制两次 minigameSkip：7 → 57 分，33 → 台词槽 1
    const before = pts();
    sc.untilMenu(1).force('minigameSkip', 7, 33).teleport(1, 19, 4).force('dice', 1).roll(1);
    expect(sc.event('MINIGAME_ENDED')).toMatchObject({
      minigameId: 'xicong',
      mode: 'skipped',
      score: 57,
      speechSlot: 1,
    });
    expect(pts()).toBe(before + 57);
    // 恰好消耗 2 次：多给的强制值还留在队列里
    sc.untilMenu(1).force('minigameSkip', 0, 0, 5).teleport(1, 20, 13).force('dice', 1).roll(1);
    expect(sc.event('MINIGAME_ENDED')).toMatchObject({ minigameId: 'balloon', score: 50, speechSlot: 0 });
    expect(sc.state.secret.debugQueue).toEqual([{ purpose: 'minigameSkip', values: [5] }]);
  });

  it('config.minigames=skip：真人也直接走不玩分支', () => {
    const sc = scenario({ players: ['human', 'ai'], config: { minigames: 'skip' } });
    landOn(sc, 0, 'balloon');
    expect(sc.event('MINIGAME_ENDED')).toMatchObject({ seat: 0, minigameId: 'balloon', mode: 'skipped' });
    sc.expectNoAsk(0, 'MINIGAME');
  });

  it('真人：MINIGAME_STARTED + MINIGAME 决策（种子 31 位，只在 pending 里），MINIGAME_DECLINE 走不玩分支', () => {
    const sc = scenario({ players: ['human', 'ai'] });
    sc.untilMenu(0).force('minigameSeed', 0x5eadbeef);
    landOn(sc, 0, 'penguin').expectAsk(0, 'MINIGAME');
    expect(sc.event('MINIGAME_STARTED')).toEqual({ type: 'MINIGAME_STARTED', seat: 0, minigameId: 'penguin' });
    const d = sc.pending(0);
    expect(d.options).toEqual({ minigameId: 'penguin', maxScore: 188 });
    expect(d.minigame).toEqual({ minigameId: 'penguin', seed: 0x5eadbeef, params: { ruleset: 'exe311' } });
    expect(d.defaultIntent).toEqual({ type: 'MINIGAME_DECLINE' });
    expect(d.timing).toBe('minigame');
    // 事件里不带种子
    expect(JSON.stringify(sc.events)).not.toContain(String(0x5eadbeef));
    const before = sc.player(0).points;
    sc.force('minigameSkip', 19, 1).act(0, { type: 'MINIGAME_DECLINE' });
    expect(sc.event('MINIGAME_ENDED')).toMatchObject({ mode: 'skipped', score: 69, speechSlot: 1 });
    expect(sc.player(0).points).toBe(before + 69);
    sc.expectNoAsk(0, 'MINIGAME');
  });

  it('随机种子不超过 31 位', () => {
    const sc = scenario({ players: ['human', 'ai'] });
    for (const id of ['penguin', 'balloon', 'xicong'] as const) {
      landOn(sc, 0, id).expectAsk(0, 'MINIGAME');
      const seed = sc.pending(0).minigame!.seed;
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(MINIGAME_SEED_MASK);
      expect(sc.pending(0).options).toMatchObject({ minigameId: id });
      sc.act(0, { type: 'MINIGAME_DECLINE' });
    }
  });

  it('MINIGAME_RESULT：点券 += score（截断、夹到上限、u16 饱和），帧栈继续推进', () => {
    const sc = scenario({ players: ['human', 'ai'] });
    landOn(sc, 0, 'xicong').expectAsk(0, 'MINIGAME');
    const d = sc.pending(0);
    const before = sc.player(0).points;
    sc.apply({ type: 'MINIGAME_RESULT', seat: 0, decisionId: d.id, score: 37.9, logHash: 123 });
    expect(sc.event('MINIGAME_ENDED')).toEqual(
      expect.objectContaining({ seat: 0, minigameId: 'xicong', mode: 'played', score: 37, speechSlot: null }),
    );
    expect(sc.player(0).points).toBe(before + 37);
    sc.expectNoAsk(0, 'MINIGAME');
    // 回合继续：下一个待决策属于电脑座位
    expect(sc.state.pending.length).toBeGreaterThan(0);

    // 超出上限夹到 999；点券饱和到 65535
    sc.untilMenu(0).debug({ op: 'setPoints', seat: 0, points: 65000 });
    landOn(sc, 0, 'xicong');
    sc.apply({ type: 'MINIGAME_RESULT', seat: 0, decisionId: sc.pending(0).id, score: 5000, logHash: 0 });
    expect(sc.event('MINIGAME_ENDED')).toMatchObject({ score: 999 });
    expect(sc.player(0).points).toBe(65535);

    // 负分记 0
    landOn(sc, 0, 'penguin');
    sc.apply({ type: 'MINIGAME_RESULT', seat: 0, decisionId: sc.pending(0).id, score: -5, logHash: 0 });
    expect(sc.event('MINIGAME_ENDED')).toMatchObject({ minigameId: 'penguin', score: 0 });
  });

  it('MINIGAME_RESULT 的校验：过期决策、别人的座位、非小游戏决策', () => {
    const sc = scenario({ players: ['human', 'human'] });
    landOn(sc, 0, 'penguin').expectAsk(0, 'MINIGAME');
    const d = sc.pending(0);
    const bad = (a: object) => () => sc.apply({ type: 'MINIGAME_RESULT', ...a } as never);
    expect(bad({ seat: 0, decisionId: 'd999999', score: 1, logHash: 0 })).toThrow(/STALE_DECISION/);
    expect(bad({ seat: 1, decisionId: d.id, score: 1, logHash: 0 })).toThrow(/NOT_YOUR_DECISION/);
    expect(bad({ seat: 0, decisionId: d.id, score: Number.NaN, logHash: 0 })).toThrow(/BAD_ACTION/);
    // 客户端 intent 不能直接提交分数
    expect(() => sc.act(0, { type: 'CONFIRM' })).toThrow(/INTENT_NOT_ALLOWED/);
    sc.act(0, { type: 'MINIGAME_DECLINE' });
    sc.untilMenu(1);
    const menu = sc.pending(1);
    expect(bad({ seat: 1, decisionId: menu.id, score: 1, logHash: 0 })).toThrow(/INTENT_NOT_ALLOWED/);
  });

  it('梦游者不触发', () => {
    const sc = scenario({ players: ['human', 'ai'] });
    sc.untilMenu(0).edit((s) => {
      s.players[0]!.st.sleepwalk = 2;
    });
    sc.teleport(0, 15, 14).force('dice', 1).roll(0);
    expect(sc.events.some((e) => e.type === 'MINIGAME_STARTED' || e.type === 'MINIGAME_ENDED')).toBe(false);
    sc.expectNoAsk(0, 'MINIGAME');
  });
});
