/**
 * 私密手牌模式下电脑读什么（GameRunner.aiAct）：电脑座位用全量视图（原版电脑与玩家同一进程、直接读内存），
 * 真人座位的托管 / 超时代打按房间设置降级，不替真人使用他看不到的信息。
 */
import type { AiPolicy } from '@rich4/shared/ai';
import type { SeatIndex } from '@rich4/shared/engine';
import { describe, expect, it } from 'vitest';
import { localPolicy } from '../helpers/localPolicy';
import { makeRunner } from '../helpers/runnerHarness';

interface Seen {
  seat: SeatIndex;
  vis: string;
  /** 视图里别人的 cards / items 是否被隐藏 */
  othersHidden: boolean;
}

function spyPolicy(seen: Seen[]): AiPolicy {
  return {
    id: localPolicy.id,
    decide(view, d, ctx) {
      const others = view.players.filter((p) => p.seat !== d.seat);
      seen.push({
        seat: d.seat,
        vis: ctx.handVisibility,
        othersHidden: others.every((p) => p.cards === null && p.items === null),
      });
      return localPolicy.decide(view, d, ctx);
    },
  };
}

describe('GameRunner：私密手牌模式下电脑的视图', () => {
  it('电脑座位按全量视图决策；真人断线托管时按私密视图', () => {
    const seen: Seen[] = [];
    const h = makeRunner({
      players: [
        { seat: 0, character: 0, controller: 'human' },
        { seat: 1, character: 1, controller: 'ai' },
      ],
      settings: { handVisibility: 'private' },
      policy: spyPolicy(seen),
      thinkMs: [100, 100],
    });
    // 0 号断线超过宽限 → autopilot:disconnect，由 AI 代打；之后轮到 1 号（电脑）
    h.runner.setConnected(0, false);
    h.sched.advance(60_000);
    const human = seen.filter((x) => x.seat === 0);
    const ai = seen.filter((x) => x.seat === 1);
    expect(human.length).toBeGreaterThan(0);
    expect(ai.length).toBeGreaterThan(0);
    expect(human.every((x) => x.vis === 'private' && x.othersHidden)).toBe(true);
    expect(ai.every((x) => x.vis === 'public' && !x.othersHidden)).toBe(true);
  });

  it('public 房间里托管同样是全量视图（单机与现状不变）', () => {
    const seen: Seen[] = [];
    const h = makeRunner({
      players: [
        { seat: 0, character: 0, controller: 'human' },
        { seat: 1, character: 1, controller: 'ai' },
      ],
      policy: spyPolicy(seen),
      thinkMs: [100, 100],
    });
    h.runner.setConnected(0, false);
    h.sched.advance(60_000);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((x) => x.vis === 'public' && !x.othersHidden)).toBe(true);
  });
});
