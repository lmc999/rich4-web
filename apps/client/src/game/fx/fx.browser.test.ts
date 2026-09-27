// client-browser：真实 WebGL 下的 M6/M7 特效冒烟——爆炸、飞弹、核弹（全屏白闪 + 震屏）、倒带、烟花，
// 以及舞台同步（路面物件、路上神明、恶人、乞丐、角色状态外观）与神明降临、警车接走、女巫魔法阵，不报错、不留残余节点。
import { buildTestMap } from '@rich4/shared/data';
import type { GameView } from '@rich4/shared/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selfPlay } from '../../test/selfPlay';
import { AnimClock } from '../anim/AnimClock';
import { BoardController } from '../BoardController';
import { GameRenderer } from '../GameRenderer';
import type { BoardStage } from './BoardStage';
import { FX_MISSILE_MS, FX_NUKE_MS } from './timings';

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

/** 手动推进外部时钟直到 promise 完成（每步让出一次事件循环，Pixi 可以渲染） */
async function drive(clock: AnimClock, p: Promise<unknown>, maxMs = 10_000): Promise<number> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  const t0 = clock.now();
  for (let t = 0; t < maxMs && !done; t += 16) {
    clock.advance(16);
    await new Promise((res) => setTimeout(res, 0));
  }
  await p;
  return clock.now() - t0;
}

async function setup(): Promise<{ clock: AnimClock; ctrl: BoardController; stage: BoardStage; view: GameView }> {
  const clock = new AnimClock();
  r = await GameRenderer.create({ host, quality: 'high', clock });
  await r.loadMap(buildTestMap());
  const ctrl = new BoardController(r, { nameOf: (s) => `P${s + 1}`, autoFollow: () => true });
  const base = selfPlay({ seed: 13, steps: 30 }).batches.at(-1)!.view;
  const view: GameView = {
    ...base,
    objects: [
      { id: 1, kind: 'roadblock', node: 5, placedBy: 0 },
      { id: 2, kind: 'mine', node: 6, placedBy: 1 },
      { id: 3, kind: 'bomb', node: 7, placedBy: null },
      { id: 4, kind: 'gift', node: 11, placedBy: null },
      { id: 5, kind: 'chest', node: 12, placedBy: null },
    ],
    gods: [
      { slot: 0, kind: 1, where: { t: 'road', node: 8 } },
      { slot: 10, kind: 11, where: { t: 'road', node: 9 } },
    ],
    beggars: [{ seat: 3, node: 16 }],
    villains: base.villains.map((v, i) => (i === 0 ? { ...v, onBoard: true, node: 13 } : v)),
    players: base.players.map((p) =>
      p.seat === 1 ? { ...p, placed: true, node: p.node > 0 ? p.node : 2, vehicle: 'car', bomb: { fuse: 20 } } : p,
    ),
  };
  ctrl.syncView(view);
  const stage = ctrl.fx.stageFor(ctrl) as BoardStage;
  expect(stage).not.toBeNull();
  stage.syncWorld(view);
  return { clock, ctrl, stage, view };
}

describe('M6/M7 特效与舞台（Chromium + WebGL）', () => {
  it('舞台同步路面物件、路上神明、恶人与乞丐', async () => {
    const { stage } = await setup();
    expect(stage.ready).toBe(true);
    expect(r!.board.roads.counts()).toEqual({ objects: 5, gods: 2, beggars: 1, villains: 1 });
    expect(r!.board.actor(1)?.currentStatus).toMatchObject({ vehicle: 'car', bomb: 20 });
  });

  it('爆炸、飞弹、核弹、倒带、烟花都不报错，结束后不留特效节点', async () => {
    const { clock, ctrl, stage } = await setup();
    const signal = new AbortController().signal;
    await drive(clock, stage.explode({ tile: 6 }, 'big', signal));
    const missile = await drive(clock, stage.strike('missile', 6, 100, signal));
    expect(missile).toBeGreaterThanOrEqual(FX_MISSILE_MS - 16);
    const nuke = await drive(clock, stage.strike('nuke', 9, 220, signal));
    expect(nuke).toBeGreaterThanOrEqual(FX_NUKE_MS - 16);
    await drive(clock, stage.strike('typhoon', 9, 100, signal));
    await drive(clock, stage.strike('alien', 9, 100, signal));
    await drive(clock, stage.rewind(signal));
    expect(r!.layers.world.filters ?? []).toHaveLength(0);
    stage.fireworks();
    stage.flash(0xffffff, 300);
    await drive(clock, clock.wait(2600));
    // 让粒子寿命走完
    await drive(clock, clock.wait(1500));
    expect(ctrl.fx.count).toBe(0);
    expect(ctrl.fx.particleCount).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('物件落下 / 弹飞、机器娃娃、神明降临与离身、警车接走、魔法阵、恶人行走', async () => {
    const { clock, ctrl, stage } = await setup();
    const signal = new AbortController().signal;
    await drive(clock, stage.dropObject({ id: 9, kind: 'mine', node: 3, placedBy: 0 }, signal));
    expect(r!.board.roads.objectView(9)).toBeDefined();
    await drive(clock, stage.removeObject({ id: 9, kind: 'mine', node: 3, placedBy: 0 }, 'boom', signal));
    expect(r!.board.roads.objectView(9)).toBeUndefined();
    await drive(clock, stage.dollWalk([4, 5, 6, 7], [1, 2], signal));
    expect(r!.board.roads.counts().objects).toBe(3);
    const seat = 0;
    const node = r!.board.actor(seat)?.tile ?? 2;
    await drive(clock, stage.godArrive(seat, 1, signal));
    expect(r!.board.actor(seat)?.currentStatus.god).toBe(1);
    await drive(clock, stage.godPower(seat, 1, signal));
    await drive(clock, stage.godLeave(seat, 1, signal));
    expect(r!.board.actor(seat)?.currentStatus.god).toBeNull();
    await drive(clock, stage.dogBite(seat, node, false, signal));
    await drive(clock, stage.magic(seat, [1, 2], signal));
    await drive(clock, stage.escort(1, 'jail', signal));
    await drive(clock, stage.bombPass(1, 2, 19, signal));
    expect(r!.board.actor(2)?.currentStatus.bomb).toBe(19);
    await drive(clock, stage.walkVillain('thief', [13, 12, 11], signal));
    expect(r!.board.roads.villain('thief')?.tile).toBe(11);
    await drive(clock, stage.teleport({ seat: 2 }, { tile: 10 }, signal));
    await drive(clock, clock.wait(1500));
    ctrl.clearFx();
    expect(ctrl.fx.count).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('整合：syncView 同步舞台（无需事件）；头顶聊天气泡跟随角色、按时消失；关押时窗口气泡画在建筑之上', async () => {
    const { ctrl, view } = await setup();
    // BoardController.stage 与 fx.stageFor 是同一个舞台；syncView 末尾同步路面物件
    expect(ctrl.stage).toBe(ctrl.fx.stageFor(ctrl));
    const noObjects: GameView = { ...view, objects: [] };
    ctrl.syncView(noObjects);
    expect(ctrl.renderer.board.roads.counts().objects).toBe(0);
    ctrl.syncView(view);
    expect(ctrl.renderer.board.roads.counts().objects).toBe(view.objects.length);

    const seat = view.players.find((p) => p.placed && p.node > 0)!.seat;
    const actor = ctrl.renderer.board.actor(seat)!;
    ctrl.say(seat, '大家好，这是一句很长很长很长很长很长很长的聊天内容', 200);
    const speech = actor.root.children.find((c) => c.label === 'speech');
    expect(speech).toBeDefined();
    ctrl.say(seat, '😂', 150, true);
    expect(actor.root.children.filter((c) => c.label === 'speech')).toHaveLength(1);
    await new Promise((res) => setTimeout(res, 250));
    expect(actor.root.children.some((c) => c.label === 'speech')).toBe(false);

    const z0 = actor.root.zIndex;
    const jailed: GameView = {
      ...view,
      players: view.players.map((p) => (p.seat === seat ? { ...p, st: { ...p.st, jail: 3 } } : p)),
    };
    ctrl.syncView(jailed);
    expect(actor.root.children.some((c) => String(c.label).startsWith('confine:'))).toBe(true);
    expect(actor.root.zIndex).toBeGreaterThan(z0 + 100_000);
    ctrl.syncView(view);
    expect(actor.root.zIndex).toBe(z0);
  });
});
