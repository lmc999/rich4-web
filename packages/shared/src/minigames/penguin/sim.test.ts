import { describe, expect, it } from 'vitest';
import { createWatcomState, watcomRand } from '../../util/rng/watcom';
import { replay } from '../replay';
import { DEFAULT_MINIGAME_PARAMS, InputCode, type InputEvent, MINIGAME_TIMING } from '../types';
import { BURY_COUNTS, IGLOO_CELL, ITEM_SCORE, PENGUIN_MAX_SCORE, START_CELL, VALID_CELL_COUNT } from './constants';
import { cellAt, VALID, VALID_CELLS } from './geometry';
import { PENGUIN_SPEC, type PenguinState, penguinPose, PENGUIN_SIM as sim } from './sim';

const P = DEFAULT_MINIGAME_PARAMS;
const pick = (tick: number, cell: number): InputEvent => [tick, InputCode.PickCell, cell];

/** 推进到 s.tick === until；byTick 给出各 tick 的输入 */
function runTo(s: PenguinState, until: number, byTick: Record<number, InputEvent[]> = {}): void {
  while (s.tick < until && !sim.isOver(s)) sim.step(s, byTick[s.tick] ?? []);
}

/** 进入游玩（tick 10）并把棋盘换成指定布局（state 是纯 JSON，测试可直接改） */
function playWith(layout: Record<number, number>, seed = 1): PenguinState {
  const s = sim.init(seed, P);
  s.board.fill(0);
  for (const [cell, kind] of Object.entries(layout)) s.board[Number(cell)] = kind;
  runTo(s, 10);
  expect(s.phase).toBe('play');
  return s;
}

/** 参照实现：按文档公式独立重算埋藏（pick = rand()*free>>15，按格号序取第 pick 个空的有效格） */
function referenceBury(seed: number): number[] {
  const rng = createWatcomState(seed);
  const board = new Array<number>(81).fill(0);
  let free = 64;
  const counts = [3, 12, 3, 9, 1];
  for (let t = 0; t < 5; t++) {
    for (let n = 0; n < counts[t]!; n++) {
      const target = (watcomRand(rng) * free) >> 15;
      const empties = VALID_CELLS.filter((c) => board[c] === 0);
      board[empties[target]!] = t + 1;
      free--;
    }
  }
  return board;
}

describe('企鹅挖宝 sim', () => {
  it('spec 与计时契约一致', () => {
    expect(PENGUIN_SPEC).toMatchObject({
      id: 'penguin',
      tickMs: 100,
      introTicks: 10,
      playTicks: 150,
      maxTicks: MINIGAME_TIMING.penguin.maxTicks,
      scoreSanityMax: 188,
      acceptedCodes: [InputCode.PickCell],
      rollbackAttribution: false,
    });
  });

  it('埋藏：件数 3/12/3/9/1，28 个不同有效格，不落冰屋，土堆 = 开局埋藏格；与文档公式逐格一致', () => {
    for (let seed = 0; seed < 300; seed++) {
      const s = sim.init(seed * 7919 + 1, P);
      const counts = [0, 0, 0, 0, 0, 0];
      for (let c = 0; c < 81; c++) {
        const k = s.board[c]!;
        if (k !== 0) {
          expect(VALID[c]).toBe(true);
          counts[k]!++;
        }
        expect(s.mound[c]).toBe(k !== 0 ? 1 : 0);
      }
      expect(counts).toEqual([...BURY_COUNTS]);
      expect(s.board[IGLOO_CELL]).toBe(0);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(28);
      if (seed < 50) expect(s.board).toEqual(referenceBury(seed * 7919 + 1));
    }
    expect(VALID_CELL_COUNT - 28).toBe(36);
  });

  it('埋藏恰好消耗 28 次 rand', () => {
    const s = sim.init(12345, P);
    const rng = createWatcomState(12345);
    for (let i = 0; i < 28; i++) watcomRand(rng);
    expect(s.rng).toBe(rng.next);
  });

  it('intro 10 tick 不接受点击；第 10 tick 开始可点', () => {
    const a = sim.init(7, P);
    const b = sim.init(7, P);
    for (let t = 0; t < 10; t++) {
      expect(sim.accepting(a)).toBe(false);
      expect(a.phase).toBe('intro');
      sim.step(a, [pick(t, cellAt(5, 2))]);
      sim.step(b, []);
    }
    expect(sim.hash(a)).toBe(sim.hash(b));
    expect(a.phase).toBe('play');
    expect(sim.accepting(a)).toBe(true);
    expect(a.cell).toBe(START_CELL);
  });

  it('走一格 4 tick、到达后挖 4 tick 再揭晓；之后立刻可以再点', () => {
    const target = cellAt(5, 2);
    const s = playWith({ [target]: 2 });
    runTo(s, 13, { 10: [pick(10, target)] });
    expect(s.cell).toBe(START_CELL);
    expect(s.walk?.sub).toBe(3);
    expect(sim.accepting(s)).toBe(false);
    sim.step(s, []); // tick 13：到达
    expect(s.cell).toBe(target);
    expect(s.walk).toBeNull();
    expect(s.digLeft).toBe(4);
    expect(s.fx).toEqual([
      { t: 'arrive', cell: target },
      { t: 'dig', cell: target },
    ]);
    runTo(s, 17);
    expect(s.digLeft).toBe(1);
    expect(s.dug[target]).toBe(0);
    sim.step(s, []); // tick 17：揭晓
    expect(s.dug[target]).toBe(1);
    expect(s.found[target]).toBe(2);
    expect(s.board[target]).toBe(0);
    expect(s.fx).toEqual([{ t: 'reveal', cell: target, item: 2 }]);
    expect(sim.score(s)).toBe(5);
    expect(s.tick).toBe(18);
    expect(sim.accepting(s)).toBe(true);
  });

  it('途经的格子不挖；走路、挖掘中的点击无效（状态哈希与不点完全相同）', () => {
    const path = [47, 39, 30, 22];
    const layout: Record<number, number> = { 13: 5 };
    for (const c of path) layout[c] = 4;
    const a = playWith(layout);
    const b = playWith(layout);
    const noise: Record<number, InputEvent[]> = { 10: [pick(10, 13)] };
    // 走路中（10..29）与挖掘中（30..33）乱点，包括点冰屋、点当前格
    for (const t of [11, 12, 15, 20, 28, 29, 30, 31, 33]) noise[t] = [pick(t, t % 2 === 0 ? 47 : IGLOO_CELL)];
    runTo(a, 34, noise);
    runTo(b, 34, { 10: [pick(10, 13)] });
    expect(sim.hash(a)).toBe(sim.hash(b));
    expect(a.cell).toBe(13);
    expect(a.dug[13]).toBe(1);
    for (const c of path) {
      expect(a.dug[c]).toBe(0);
      expect(a.board[c]).toBe(4);
    }
    expect(sim.score(a)).toBe(20);
    // 5 格 × 4 tick 走到（tick 29 到达），再挖 4 tick（tick 33 揭晓）
    expect(sim.accepting(a)).toBe(true);
  });

  it('重挖已挖过的格：不再得分，found 保留第一次揭晓的结果', () => {
    const gem = cellAt(5, 2);
    const s = playWith({ [gem]: 3 });
    runTo(s, 34, { 10: [pick(10, gem)], 18: [pick(18, START_CELL)], 26: [pick(26, gem)] });
    expect(s.cell).toBe(gem);
    expect(s.fx).toEqual([{ t: 'reveal', cell: gem, item: 0 }]);
    expect(s.found[gem]).toBe(3);
    expect(s.dug[START_CELL]).toBe(1);
    expect(sim.score(s)).toBe(12);
  });

  it('点当前格、冰屋、无效格不生效', () => {
    const a = playWith({});
    const b = playWith({});
    runTo(a, 13, { 10: [pick(10, START_CELL)], 11: [pick(11, IGLOO_CELL)], 12: [pick(12, 0)] });
    runTo(b, 13);
    expect(sim.hash(a)).toBe(sim.hash(b));
    expect(sim.accepting(a)).toBe(true);
  });

  it('第一步就无路可走时原地挖当前格（点击当拍算挖掘第 1 拍，再 3 个 step 后揭晓）', () => {
    const from = cellAt(5, 4);
    const s = playWith({ [from]: 3 });
    s.cell = from;
    runTo(s, 11, { 10: [pick(10, cellAt(3, 4))] });
    expect(s.walk).toBeNull();
    expect(s.digLeft).toBe(3);
    runTo(s, 13);
    expect(s.dug[from]).toBe(0);
    runTo(s, 14);
    expect(s.dug[from]).toBe(1);
    expect(sim.score(s)).toBe(12);
  });

  it('挖到炸弹立即结束，已得分数保留', () => {
    const gem = cellAt(5, 2);
    const bomb = cellAt(4, 2);
    const s = playWith({ [gem]: 5, [bomb]: 1 });
    runTo(s, 26, { 10: [pick(10, gem)], 18: [pick(18, bomb)] });
    expect(s.phase).toBe('over');
    expect(s.endReason).toBe('bomb');
    expect(sim.isOver(s)).toBe(true);
    expect(s.tick).toBe(26);
    expect(sim.score(s)).toBe(20);
    expect(s.fx).toEqual([{ t: 'reveal', cell: bomb, item: 1 }, { t: 'bomb' }]);
    // over 之后 step 不改变状态（除 tick）
    const h = sim.hash(s);
    expect(sim.accepting(s)).toBe(false);
    expect(h).toBe(sim.hash(sim.clone(s)));
  });

  it('不操作：15 秒后时间到，endTick = 160，0 分', () => {
    const r = replay(sim, 99, P, []);
    expect(r.score).toBe(0);
    expect(r.endTick).toBe(160);
    const s = sim.init(99, P);
    runTo(s, 200);
    expect(s.endReason).toBe('time');
    expect(s.timeLeft).toBe(0);
  });

  it('计分：5×金 + 12×红 + 8×蓝 + 20×钻，满分 188', () => {
    const s = sim.init(1, P);
    s.counts = [0, 3, 12, 3, 9, 1];
    expect(sim.score(s)).toBe(PENGUIN_MAX_SCORE);
    expect(BURY_COUNTS.reduce((a, n, k) => a + n * ITEM_SCORE[k]!, 0)).toBe(188);
    expect(penguinPose(39)).toBe(0);
    expect(penguinPose(40)).toBe(1);
    expect(penguinPose(55)).toBe(1);
    expect(penguinPose(56)).toBe(2);
  });

  it('clone 独立、hash 相同；fx 不参与哈希', () => {
    const s = playWith({ 47: 2 });
    runTo(s, 12, { 10: [pick(10, 47)] });
    const c = sim.clone(s);
    expect(c).toEqual(s);
    expect(sim.hash(c)).toBe(sim.hash(s));
    sim.step(c, []);
    expect(c.walk?.sub).toBe(3);
    expect(s.walk?.sub).toBe(2);
    const d = sim.clone(s);
    d.fx = [{ t: 'bomb' }];
    expect(sim.hash(d)).toBe(sim.hash(s));
  });

  it('validateInput：只收 PickCell、格号 0..80 的整数、不带第 4 项', () => {
    expect(sim.validateInput([0, InputCode.PickCell, 0])).toBe(true);
    expect(sim.validateInput([0, InputCode.PickCell, 80])).toBe(true);
    expect(sim.validateInput([0, InputCode.PickCell, 81])).toBe(false);
    expect(sim.validateInput([0, InputCode.PickCell, -1])).toBe(false);
    expect(sim.validateInput([0, InputCode.PickCell, 1.5])).toBe(false);
    expect(sim.validateInput([0, InputCode.PickCell, 3, 4])).toBe(false);
    expect(sim.validateInput([0, InputCode.Click, 3, 4])).toBe(false);
    expect(sim.validateInput([-1, InputCode.PickCell, 3])).toBe(false);
  });
});
