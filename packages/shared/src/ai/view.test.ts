import { describe, expect, it } from 'vitest';
import { fixtureRegistry } from '../data/maps/registry';
import { editState, newGame, simpleView } from '../engine/testing/index';
import type { TileId } from '../engine/types/index';
import type { GameView } from '../view/types';
import type { AiRng } from './types';
import { AiView } from './view';

/**
 * AiView 的前瞻 / 后瞻（v3.11 0x40b221 / 0x40b343，r2 复核；architecture §31）。
 * test 图：环路 1 → 2 → … → 18 → 1；4 → 19 静态封路；13 的岔路 [20, 12]（槽序）；19 ↔ 20 连到 4 与 13；14 = 监狱关押格。
 * test-allkinds 图另有 8 → 21 → 22 → 23 → 24 → 25 → 26 的死路支线（26 是尽头）。
 */
type Scripted = AiRng & { calls: number[] };

/** rng.mod 按脚本依次给出结果并记下每次的 n；脚本用完或用到其他取数方法就报错（证明「1 个候选不取随机数」） */
function scripted(picks: readonly number[]): Scripted {
  const calls: number[] = [];
  let i = 0;
  const fail = (): never => {
    throw new Error('意外的随机数');
  };
  return {
    calls,
    mod(n) {
      calls.push(n);
      const r = picks[i++];
      if (r === undefined || r >= n) throw new Error(`rng.mod(${n}) 超出脚本`);
      return r;
    },
    next15: fail,
    bit: fail,
    scale: fail,
  };
}

function viewAt(node: TileId, prevNode: TileId, map = 'test'): AiView {
  const s = editState(newGame({ map, players: ['ai', 'human'] }).state, (x) => {
    Object.assign(x.players[0]!, { placed: true, node, prevNode });
  });
  return new AiView(simpleView(s) as GameView, 0, fixtureRegistry.getMap(map));
}

describe('AiView.lookbehind（v3.11 0x40b343）', () => {
  it('一般情形：从来路格出发、排除当前格外推，输出从往回第 2 格开始（来路格本身不在里面）', () => {
    const rng = scripted([]);
    // 5 号格、来路 4：往回第 1 格是 4（不输出），之后 3、2、1、18、17、16；4 → 19 静态封路不是候选、不取随机数
    expect(viewAt(5, 4).lookbehind(6, rng)).toEqual({ nodes: [3, 2, 1, 18, 17, 16], forked: false });
    expect(rng.calls).toEqual([]);
    // 原版缓冲 8 格：n > 8 截成 8
    expect(viewAt(5, 4).lookbehind(10, scripted([])).nodes).toEqual([3, 2, 1, 18, 17, 16, 15, 14]);
  });

  it('岔路：每个 ≥2 候选的岔口按槽序取一次 rng.mod(n) 并记下遇到过岔路', () => {
    // 14 号格、来路 13：从 13 出发、排除 14，候选 [20, 12]
    const toLoop = scripted([1]);
    expect(viewAt(14, 13).lookbehind(6, toLoop)).toEqual({ nodes: [12, 11, 10, 9, 8, 7], forked: true });
    expect(toLoop.calls).toEqual([2]);
    // 走 20 → 19 → 4，4 排除 19 后候选 [5, 3] 是第二个岔口
    const viaBalloon = scripted([0, 1]);
    expect(viewAt(14, 13).lookbehind(6, viaBalloon)).toEqual({ nodes: [20, 19, 4, 3, 2, 1], forked: true });
    expect(viaBalloon.calls).toEqual([2, 2]);
    expect(viewAt(14, 13).lookbehind(6, scripted([0, 0])).nodes).toEqual([20, 19, 4, 5, 6, 7]);
  });

  it('获释：来路 = 节点 = 关押格（原版来路 0）→ [关押格, 未封邻格…]，第二格起才在全部邻格里随机', () => {
    // 原版从全 0 哨兵出发：0 个候选回落为当前格（关押格 14），之后从 14 出发、排除 0，候选 [13, 15]
    const out = scripted([1]);
    expect(viewAt(14, 14).lookbehind(6, out)).toEqual({ nodes: [14, 15, 16, 17, 18, 1], forked: true });
    expect(out.calls).toEqual([2]);
    const back = scripted([0, 1]);
    expect(viewAt(14, 14).lookbehind(6, back)).toEqual({ nodes: [14, 13, 12, 11, 10, 9], forked: true });
    expect(back.calls).toEqual([2, 2]);
  });

  it('0 个候选：来路格是死路时第一格回落为当前格；外推途中遇到死路原路返回（同一格可能出现两次）', () => {
    const rng = scripted([]);
    // 25 号格、来路 26（尽头）：26 排除 25 后没有候选 → 第一格是 25 自己，之后 24、23、22、21、8
    expect(viewAt(25, 26, 'test-allkinds').lookbehind(6, rng)).toEqual({
      nodes: [25, 24, 23, 22, 21, 8],
      forked: false,
    });
    // 22 号格、来路 23：23 → 24 → 25 → 26 到尽头，原路返回 25、24
    expect(viewAt(22, 23, 'test-allkinds').lookbehind(6, rng)).toEqual({
      nodes: [24, 25, 26, 25, 24, 23],
      forked: false,
    });
    expect(rng.calls).toEqual([]);
  });

  it('lookahead 与 lookbehind 是同一段循环、起点与排除格对调；没落地时都为空', () => {
    expect(viewAt(4, 3).lookahead(3, scripted([])).nodes).toEqual([5, 6, 7]);
    // 获释：前瞻从关押格出发、排除 0，即在全部未封邻格里随机
    const rng = scripted([0, 1]);
    expect(viewAt(14, 14).lookahead(2, rng)).toEqual({ nodes: [13, 12], forked: true });
    expect(rng.calls).toEqual([2, 2]);
    const s = editState(newGame({ players: ['ai', 'human'] }).state, (x) => {
      Object.assign(x.players[0]!, { placed: false, node: 0, prevNode: 0 });
    });
    const unplaced = new AiView(simpleView(s) as GameView, 0, fixtureRegistry.getMap('test'));
    expect(unplaced.lookbehind(6, scripted([]))).toEqual({ nodes: [], forked: false });
    expect(unplaced.lookahead(6, scripted([]))).toEqual({ nodes: [], forked: false });
  });
});

describe('AiView.tilesInView', () => {
  it('只留视野内的格，按视角 0 投影后的屏幕行序（sy = 25·y − 11·x，再按 sx = 34·x + 14·y）', () => {
    // 0 号在 26 号格 (512,96)：视窗 x ∈ [292, 732)，1–21 号格都在左侧窗外；同一条横街在视角 0 里右高左低，x 大的先扫到
    expect(viewAt(26, 25, 'test-allkinds').tilesInView([26, 1, 25, 22, 24, 23, 9])).toEqual([26, 25, 24, 23, 22]);
    // sy：7 (256,64) −1216、5 (192,64) −512、9 (256,128) 384、18 (64,96) 1696、12 (192,160) 1888
    expect(viewAt(9, 8).tilesInView([12, 7, 9, 5, 18])).toEqual([7, 5, 9, 18, 12]);
  });
});
