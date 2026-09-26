import { describe, expect, it } from 'vitest';
import { fixtureRegistry } from '../../data/maps/registry';
import { scenario } from '../testing/scenario';
import type { GameEvent } from '../types/events';
import type { SeatIndex } from '../types/ids';
import {
  addCounterDays,
  COUNTER_PENDING,
  displayRemaining,
  emptyCounters,
  mainBlockOf,
  tick2,
  tickActorCounters,
} from './counters';

describe('两段式计数器（g_arbitration §3.2）', () => {
  it('N → … → 1 → 0x80 → 释放 → 0', () => {
    const seq: number[] = [];
    let c = 3;
    let released = false;
    while (!released) {
      const r = tick2(c);
      seq.push(r.next);
      released = r.released;
      c = r.next;
    }
    expect(seq).toEqual([2, 1, COUNTER_PENDING, 0]);
    expect(tick2(0)).toEqual({ next: 0, released: false });
    expect(tick2(1)).toEqual({ next: COUNTER_PENDING, released: false });
  });

  it('显示剩余天数 = (raw & 0x7f) + 1；加刑 (旧 + 新) & 0x7f', () => {
    expect(displayRemaining(3)).toBe(4);
    expect(displayRemaining(COUNTER_PENDING)).toBe(1);
    expect(addCounterDays(COUNTER_PENDING, 3)).toBe(3);
    expect(addCounterDays(125, 5)).toBe(2);
  });

  it('关押期间冬眠、梦游、乌龟不倒数；停留总是倒数', () => {
    const st = emptyCounters();
    st.jail = 2;
    st.hibernate = 3;
    st.sleepwalk = 3;
    st.tortoise = 3;
    st.stay = 1;
    expect(tickActorCounters(st)).toEqual([]);
    expect(st).toMatchObject({ jail: 1, hibernate: 3, sleepwalk: 3, tortoise: 3, stay: COUNTER_PENDING });
    tickActorCounters(st);
    expect(st.jail).toBe(COUNTER_PENDING);
    expect(mainBlockOf(st)).toBe('jail');
    // 释放当回合主阻碍已为 0，其他计数恢复倒数
    expect(tickActorCounters(st)).toEqual(['jail']);
    expect(st).toMatchObject({ jail: 0, hibernate: 2, sleepwalk: 2, tortoise: 2, stay: 0 });
  });
});

/** seat 在自己的回合里是否掷了骰：按 TURN_STARTED 切分事件流 */
function turnsOf(
  log: readonly GameEvent[],
  seat: SeatIndex,
): { rolled: boolean; blocked: boolean; returned: boolean }[] {
  const out: { rolled: boolean; blocked: boolean; returned: boolean }[] = [];
  let cur: (typeof out)[number] | null = null;
  for (const e of log) {
    if (e.type === 'TURN_STARTED') {
      cur = e.actor.t === 'seat' && e.actor.seat === seat ? { rolled: false, blocked: false, returned: false } : null;
      if (cur) out.push(cur);
    } else if (cur) {
      if (e.type === 'DICE_ROLLED') cur.rolled = true;
      if (e.type === 'TURN_BLOCKED') cur.blocked = true;
      if (e.type === 'RETURNED') cur.returned = true;
    }
  }
  return out;
}

describe('回合数（architecture M1 验证：坐牢 N 天 = N+1 个不掷骰回合）', () => {
  const jail = fixtureRegistry.getMap('test').jailHold;

  for (const n of [1, 3, 5]) {
    it(`坐牢 ${n} 天：${n} 个 TURN_BLOCKED + 1 个走回棋盘（RETURNED），之后正常掷骰`, () => {
      const sc = scenario({ players: ['human', 'human'] })
        .untilMenu(0)
        .edit((s) => {
          const p = s.players[1]!;
          p.st.jail = n;
          p.node = jail;
          p.prevNode = jail;
          p.placed = true;
        });
      const start = sc.log.length;
      sc.until((s) => {
        const seen = turnsOf(sc.log.slice(start), 1);
        return seen.some((t) => t.rolled) && s.pending[0]?.seat === 0;
      });
      const turns = turnsOf(sc.log.slice(start), 1);
      const firstRoll = turns.findIndex((t) => t.rolled);
      expect(firstRoll).toBe(n + 1);
      expect(turns.slice(0, n).every((t) => t.blocked && !t.rolled)).toBe(true);
      expect(turns[n]).toEqual({ rolled: false, blocked: false, returned: true });
      expect(sc.player(1).st.jail).toBe(0);
    });
  }

  it('停留卡：对自己写 0x80 本回合生效；对别人写 1 下回合生效；两者都只停 1 次', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    const node0 = sc.player(0).node;
    sc.edit((s) => {
      s.players[0]!.st.stay = COUNTER_PENDING;
      s.players[1]!.st.stay = 1;
    });
    sc.roll(0).expect((s) => expect(s.players[0]!.node).toBe(node0));
    expect(sc.event('DICE_ROLLED').steps).toBe(0);
    sc.untilMenu(1);
    expect(sc.pending(1).options).toMatchObject({ dice: { locked: 'stay' } });
    const node1 = sc.player(1).node;
    sc.roll(1);
    expect(sc.event('DICE_ROLLED').steps).toBe(0);
    expect(sc.player(1).node).toBe(node1);
    sc.untilMenu(0);
    expect(sc.pending(0).options).toMatchObject({ dice: { locked: null } });
    sc.untilMenu(1);
    expect(sc.pending(1).options).toMatchObject({ dice: { locked: null } });
  });

  it('乌龟卡：自己 2、别人 3，都是 3 次只走 1 步', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.edit((s) => {
      s.players[0]!.st.tortoise = 2;
      s.players[1]!.st.tortoise = 3;
    });
    const steps: Record<number, number[]> = { 0: [], 1: [] };
    for (let round = 0; round < 4; round++) {
      for (const seat of [0, 1] as const) {
        sc.untilMenu(seat).roll(seat);
        steps[seat]!.push(sc.event('DICE_ROLLED').steps);
      }
    }
    expect(steps[0]!.slice(0, 3)).toEqual([1, 1, 1]);
    expect(steps[1]!.slice(0, 3)).toEqual([1, 1, 1]);
    expect(steps[0]![3]).toBeGreaterThanOrEqual(1);
    expect(sc.player(0).st.tortoise).toBe(0);
    expect(sc.player(1).st.tortoise).toBe(0);
  });

  it('冬眠 5 天：跳过 5 个回合', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.edit((s) => {
      s.players[1]!.st.hibernate = 5;
    });
    const start = sc.log.length;
    sc.until(() => turnsOf(sc.log.slice(start), 1).some((t) => t.rolled));
    const turns = turnsOf(sc.log.slice(start), 1);
    expect(turns.findIndex((t) => t.rolled)).toBe(5);
    expect(turns.slice(0, 5).every((t) => t.blocked)).toBe(true);
  });
});
