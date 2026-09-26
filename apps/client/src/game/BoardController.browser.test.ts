// client-browser：真实 WebGL 下的对局棋盘控制器冒烟——按 GameView 同步地块与角色，跑一遍演出原语（行走、飘字、金币、插旗、升级弹跳）
import { buildTestMap } from '@rich4/shared/data';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selfPlay } from '../test/selfPlay';
import { AnimClock } from './anim/AnimClock';
import { BoardController } from './BoardController';
import { GameRenderer } from './GameRenderer';

let host: HTMLDivElement;
let r: GameRenderer | null = null;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;top:0;width:960px;height:640px';
  document.body.appendChild(host);
  consoleError = vi.spyOn(console, 'error');
});

afterEach(() => {
  r?.destroy();
  r = null;
  host.remove();
  consoleError.mockRestore();
});

/** 手动推进外部时钟直到 promise 完成 */
async function drive(clock: AnimClock, p: Promise<unknown>, maxMs = 10_000): Promise<void> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  for (let t = 0; t < maxMs && !done; t += 16) {
    clock.advance(16);
    await new Promise((res) => setTimeout(res, 0));
  }
  await p;
}

describe('BoardController（Chromium + WebGL）', () => {
  it('syncView 同步地块与角色；演出原语不报错，clearFx 清空特效', async () => {
    const clock = new AnimClock();
    r = await GameRenderer.create({ host, quality: 'low', clock });
    await r.loadMap(buildTestMap());
    const ctrl = new BoardController(r, { nameOf: (s) => `P${s + 1}`, autoFollow: () => true });
    const sp = selfPlay({ seed: 13, steps: 60 });
    const view = sp.batches.at(-1)!.view;
    ctrl.syncView(view);
    const actors = r.board.allActors();
    expect(actors).toHaveLength(view.players.length);
    for (const p of view.players) {
      const a = r.board.actor(p.seat)!;
      expect(a.root.visible).toBe(p.placed);
      if (p.placed) expect(a.tile).toBe(p.node);
    }

    const signal = new AbortController().signal;
    const p0 = view.players[0]!;
    const next = r.board.def.tiles.find((t) => t.id === p0.node + 1)?.id ?? p0.node;
    await drive(clock, ctrl.walk(0, [p0.node, next], signal));
    expect(r.board.actor(0)!.tile).toBe(next);

    ctrl.setLot('L1', { owner: 1, level: 2 });
    ctrl.floatText({ seat: 0 }, '+1,200', 'gain');
    const flight = ctrl.coinFlight({ seat: 0 }, { seat: 1 }, signal);
    expect(ctrl.fx.count).toBeGreaterThan(1);
    await drive(clock, flight);
    await drive(clock, ctrl.plantFlag('L1', 1, signal));
    await drive(clock, ctrl.popBuilding('L1', signal));
    ctrl.pulseTile(5);
    ctrl.highlight([5, 6], 5);
    expect(ctrl.highlightedTiles).toEqual([5, 6]);
    ctrl.clearFx();
    expect(ctrl.fx.count).toBe(0);
    expect(ctrl.tileCanvasPos(5)).not.toBeNull();
    r.app.render();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
