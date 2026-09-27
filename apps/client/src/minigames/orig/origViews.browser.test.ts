// 小游戏原版视图冒烟（原版皮肤 A13；client-browser，真实 WebGL）：内存合成素材包（fakeMgPack，帧数与锚点同原版包）上
// - 三个原版视图：按 golden 日志推进 sim 渲染若干帧，画面只读 sim 状态（HUD 数字跟着 timeLeft / 分数走、企鹅开局前不亮出埋藏物、
//   记忆阶段亮出、结算画大号分数），销毁后借出的位图全部归还；
// - 宿主：原版皮肤（pack 注入）下回放一局 → 遮罩 data-view=original，入场 FLC 在 startsAt 之前按服务器时间逐帧播放、开局后隐藏；
// - 回退：必需条目缺失或置信度 guess → 程序化视图；图集加载失败 → 整局回退程序化（不拼接）。
import {
  type InputEvent,
  MINIGAME_IDS,
  type MinigameId,
  type MinigameTicket,
  type SimBase,
} from '@rich4/shared/minigames';
import { Application } from 'pixi.js';
import { afterEach, describe, expect, it } from 'vitest';
import balloonGolden from '../../../../../packages/shared/src/minigames/__golden__/balloon.json';
import penguinGolden from '../../../../../packages/shared/src/minigames/__golden__/penguin.json';
import xicongGolden from '../../../../../packages/shared/src/minigames/__golden__/xicong.json';
import { MiniGameHost } from '../host/MiniGameHost';
import { createMinigameView, loadMinigameModule } from '../registry';
import type { MinigameView } from '../types';
import { ORIG_OPTIONAL, origPlan, origRequiredKeys } from './keys';
import { OrigMgKit } from './kit';
import { buildFakeMgPack } from './testing/fakeMgPack';

interface GoldenCase {
  name: string;
  seed: number;
  score: number;
  endTick: number;
  hash: number;
  log: InputEvent[];
}

const GOLDEN: Readonly<Record<MinigameId, GoldenCase[]>> = {
  penguin: penguinGolden as unknown as GoldenCase[],
  balloon: balloonGolden as unknown as GoldenCase[],
  xicong: xicongGolden as unknown as GoldenCase[],
};

const P = { ruleset: 'exe311' } as const;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

async function newApp(): Promise<Application> {
  const app = new Application();
  await app.init({ width: 640, height: 480, preference: 'webgl', background: 0x000000 });
  document.body.append(app.canvas);
  cleanups.push(() => app.destroy({ removeView: true }, { children: true }));
  return app;
}

describe('原版视图：按 golden 推进 sim 渲染', () => {
  for (const id of MINIGAME_IDS) {
    it(`${id}：原版视图只读 sim 状态，HUD、记忆阶段与结算大号分数`, async () => {
      const app = await newApp();
      const pack = buildFakeMgPack();
      const mod = await loadMinigameModule(id);
      const kit = new OrigMgKit(pack);
      const keys = origRequiredKeys(id, 3)!;
      expect(await kit.preload(keys, ORIG_OPTIONAL[id])).toBe(true);
      const played: number[] = [];
      const view = (await mod.createOrigView!({
        app,
        characterId: 3,
        mode: 'play',
        kit,
        sound: { play: (n) => played.push(n) },
      })) as MinigameView<SimBase>;
      expect(view.look).toBe('original');
      app.stage.addChild(view.root);
      const sim = mod.sim;
      const c = GOLDEN[id][1]!;
      const s = sim.init(c.seed, P);
      // 开局前（countdown）：企鹅不亮出埋藏物
      view.setPhase?.('countdown');
      view.render(sim.clone(s), s, 1, [], 0);
      if (id === 'penguin') expect(view.debug?.().buried).toBe(0);
      view.setPhase?.('playing');
      view.render(sim.clone(s), s, 1, [], 16);
      if (id === 'penguin') expect(view.debug?.().buried).toBeGreaterThan(0);
      const hud0 = JSON.stringify(view.debug?.().hud);
      let i = 0;
      let f = 0;
      for (; f < 400 && !sim.isOver(s); f++) {
        const prev = sim.clone(s);
        const inputs: InputEvent[] = [];
        while (i < c.log.length && c.log[i]![0] === s.tick) inputs.push(c.log[i++]!);
        sim.step(s, inputs);
        view.setPointer({ x: 320, y: 240 });
        view.render(prev, s, 0.5, s.fx, f * 50);
        if (f % 20 === 0) app.render();
      }
      // 记忆阶段结束后埋藏物收起；HUD 跟着时间走
      if (id === 'penguin') expect(view.debug?.().buried).toBe(0);
      expect(JSON.stringify(view.debug?.().hud)).not.toBe(hud0);
      // 结算：大号分数
      const score = sim.score(s);
      view.setPhase?.('result');
      view.setResult?.({ score, final: true });
      view.render(sim.clone(s), s, 1, [], f * 50 + 100);
      app.render();
      expect(view.debug?.().bigScore).toBe(score);
      expect(played).toContain(25);
      view.destroy();
      kit.destroy();
      expect([...pack.borrowedImages.entries()]).toEqual([]);
    });
  }
});

function ticket(id: MinigameId, o: Partial<MinigameTicket> = {}): MinigameTicket {
  const tickMs = id === 'xicong' ? 50 : 100;
  return {
    sessionId: `mg-${id}`,
    decisionId: 'd1',
    seat: 0,
    minigameId: id,
    seed: GOLDEN[id][0]!.seed,
    params: { ...P },
    tickMs,
    introTicks: 10,
    maxTicks: 420,
    startsAt: 100_000,
    deadlineAt: 200_000,
    role: 'spectator',
    ...o,
  };
}

describe('宿主按皮肤选视图', () => {
  it('原版皮肤：回放遮罩用原版视图，入场 FLC 按服务器时间在开局前逐帧播放、开局后隐藏', async () => {
    let now = 50_000;
    const pack = buildFakeMgPack();
    const host = MiniGameHost.open({
      ticket: ticket('balloon'),
      mode: 'replay',
      now: () => now,
      playerName: 'P1',
      characterId: 2,
      log: GOLDEN.balloon[0]!.log,
      pack,
      resultMs: 50,
    });
    cleanups.push(() => host.close());
    await expect.poll(() => host.debugState().view, { timeout: 10_000 }).toBe('original');
    const overlay = document.querySelector('[data-testid="minigame-host"]') as HTMLElement;
    expect(overlay.dataset.view).toBe('original');
    // 回放：startsAt = 打开时刻 + max(1200ms, FLC 2280ms)——打开时就从第 0 帧播（回归：原先只留 1200ms，从第 9 帧起播）；
    // 开局前 1000ms 应在第 (2280 − 1000) / 114 ≈ 11 帧
    const startsAt = host.loop.startsAt;
    expect(startsAt - 50_000).toBe(2280);
    await expect
      .poll(
        () => {
          host.pump();
          return host.debugState().readyFrame;
        },
        { timeout: 10_000 },
      )
      .toBe(0);
    now = startsAt - 1000;
    await expect
      .poll(
        () => {
          host.pump();
          return host.debugState().readyFrame;
        },
        { timeout: 10_000 },
      )
      .toBe(Math.floor((2280 - 1000) / 114));
    now = startsAt + 500;
    host.pump();
    expect(host.debugState().readyFrame).toBe(-1);
    expect(host.debugState().phase).toBe('playing');
    // DOM 仍有 HUD（读屏），视觉上由原版画面画出
    expect(document.querySelector('[data-testid="minigame-hud"]')).not.toBeNull();
    // 快进到结算：原版视图画大号分数
    for (let k = 0; k < 400 && host.debugState().phase !== 'result'; k++) {
      now += 200;
      host.pump();
    }
    expect(host.debugState().phase).toBe('result');
    const dbg = host.debugState().viewDebug as { bigScore: number | null };
    expect(dbg.bigScore).toBe(host.debugState().localScore);
  });

  it('必需条目缺失或置信度 guess：宿主用程序化视图（不提前显示）', async () => {
    for (const pack of [buildFakeMgPack({ omit: ['mg.penguin.83'] }), buildFakeMgPack({ guess: ['mg.common.hud'] })]) {
      expect(origPlan(pack, 'penguin', 0)).toBeNull();
      const host = MiniGameHost.open({
        ticket: ticket('penguin', { role: 'player' }),
        mode: 'replay',
        now: () => 50_000,
        playerName: 'P1',
        characterId: 0,
        log: [],
        pack,
      });
      cleanups.push(() => host.close());
      await expect.poll(() => host.isReady, { timeout: 10_000 }).toBe(true);
      expect(host.debugState().view).toBe('procedural');
    }
    // 喜从天降：角色未知时不能用原版视图
    expect(origPlan(buildFakeMgPack(), 'xicong', null)).toBeNull();
    expect(origPlan(buildFakeMgPack(), 'xicong', 4)).not.toBeNull();
  });

  it('图集加载失败：整局回退程序化视图，借出的位图全部归还', async () => {
    const app = await newApp();
    const pack = buildFakeMgPack();
    const bad = {
      ...pack,
      loadAtlas: (lp: string) =>
        lp.includes('mg.penguin.85') ? Promise.reject(new Error('boom')) : pack.loadAtlas(lp),
    };
    const mod = await loadMinigameModule('penguin');
    const { view, kit } = await createMinigameView(
      mod,
      { app, characterId: 0, mode: 'play' },
      { pack: bad, keys: origRequiredKeys('penguin', 0)!, optional: [], sound: { play: () => {} } },
    );
    expect(kit).toBeNull();
    expect(view.look ?? 'procedural').toBe('procedural');
    view.destroy();
    expect([...pack.borrowedImages.entries()]).toEqual([]);
  });
});
