import { describe, expect, it } from 'vitest';
import { newGame, stateHash } from './testing/builders';
import { intentRng, randomAction } from './testing/randomIntent';
import type { GameEvent } from './types/events';

/** 同种子、同 action 序列 → 每一步的状态哈希与事件完全相同（architecture §8「确定性」） */
function play(seed: string, intents: string, steps: number): { hashes: string[]; events: GameEvent[][] } {
  const g = newGame({ players: ['human', 'ai', 'ai', 'human'], seed, config: { timeLimitDays: 0 } });
  const rng = intentRng(intents);
  let state = g.state;
  const hashes = [stateHash(state)];
  const events: GameEvent[][] = [g.events];
  for (let i = 0; i < steps && state.status === 'playing'; i++) {
    const r = g.engine.applyAction(state, randomAction(state, rng)!);
    state = r.state;
    hashes.push(stateHash(state));
    events.push(r.events);
  }
  return { hashes, events };
}

describe('确定性', () => {
  it('同一种子与 intent 序列跑两次，逐步哈希与事件一致', { timeout: 120_000 }, () => {
    const a = play('5eed01', '1a2b', 400);
    const b = play('5eed01', '1a2b', 400);
    expect(b.hashes).toEqual(a.hashes);
    expect(b.events).toEqual(a.events);
  });

  it('不同种子得到不同的对局', () => {
    const a = play('5eed01', '1a2b', 60);
    const b = play('5eed02', '1a2b', 60);
    expect(b.hashes[b.hashes.length - 1]).not.toBe(a.hashes[a.hashes.length - 1]);
  });

  it('JSON 往返不改变哈希（state 只含 JSON 值）', () => {
    const g = newGame({ seed: 'abcdef' });
    expect(stateHash(JSON.parse(JSON.stringify(g.state)))).toBe(stateHash(g.state));
  });
});
