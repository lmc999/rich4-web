// crossEngine（architecture M8 验证 2；design/minigames-ai.md §10.1）：在浏览器引擎里逐条重放 shared 的 golden
// （packages/shared/src/minigames/__golden__/*.json，node 下由 golden.test.ts 生成与校验），score / endTick / hash 必须与 node 完全一致。
// client-browser 当前只有 Chromium 实例；WebKit / Firefox 的实例在 vitest.projects.ts 里按本机是否装有浏览器加入（见报告）。
// 另做三个 Pixi 场景与宿主的冒烟：真实 WebGL 下创建、渲染若干帧、销毁不报错。
import {
  InputCode,
  type InputEvent,
  MINIGAME_IDS,
  MINIGAME_SIMS,
  type MinigameId,
  type MinigameSim,
  type MinigameTicket,
  replay,
  type SimBase,
} from '@rich4/shared/minigames';
import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import balloonGolden from '../../../../packages/shared/src/minigames/__golden__/balloon.json';
import penguinGolden from '../../../../packages/shared/src/minigames/__golden__/penguin.json';
import xicongGolden from '../../../../packages/shared/src/minigames/__golden__/xicong.json';
import { MiniGameHost } from './host/MiniGameHost';
import { loadMinigameModule } from './registry';

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

describe('crossEngine：golden 重放与 node 一致', () => {
  for (const id of MINIGAME_IDS) {
    it(`crossEngine ${id}`, () => {
      const cases = GOLDEN[id];
      expect(cases.length).toBeGreaterThanOrEqual(10);
      const sim = MINIGAME_SIMS[id] as MinigameSim<SimBase>;
      for (const c of cases) {
        const r = replay(sim, c.seed, P, c.log);
        expect({ name: c.name, ...r }).toEqual({ name: c.name, score: c.score, endTick: c.endTick, hash: c.hash });
      }
    });
  }
});

describe('Pixi 场景冒烟', () => {
  for (const id of MINIGAME_IDS) {
    it(`${id}：创建场景、按 bot 日志渲染 60 帧、销毁`, async () => {
      const app = new Application();
      await app.init({ width: 640, height: 480, preference: 'webgl', background: 0x000000 });
      document.body.append(app.canvas);
      const mod = await loadMinigameModule(id);
      const view = await mod.createView({ app, characterId: 0, mode: 'play' });
      app.stage.addChild(view.root);
      const sim = mod.sim;
      const c = GOLDEN[id][1]!;
      const s = sim.init(c.seed, P);
      let prev = sim.clone(s);
      let i = 0;
      for (let f = 0; f < 60 && !sim.isOver(s); f++) {
        prev = sim.clone(s);
        const inputs: InputEvent[] = [];
        while (i < c.log.length && c.log[i]![0] === s.tick) inputs.push(c.log[i++]!);
        sim.step(s, inputs);
        view.setPointer({ x: 320, y: 240 });
        view.render(prev, s, 0.5, s.fx, f * 16);
        app.render();
      }
      expect(view.root.children.length).toBeGreaterThan(0);
      view.destroy();
      app.destroy(true, { children: true });
    });
  }

  it('宿主（play，真实 Pixi）：倒计时 → 开局 → 点击 → 关闭', async () => {
    const t0 = Date.now();
    const ticket: MinigameTicket = {
      sessionId: 'mg-browser',
      decisionId: 'd1',
      seat: 0,
      minigameId: 'balloon',
      seed: 99,
      params: { ...P },
      tickMs: 100,
      introTicks: 5,
      maxTicks: 300,
      startsAt: t0 + 300,
      deadlineAt: t0 + 300 + 30_000 + 5000,
      role: 'player',
    };
    const sent: unknown[] = [];
    const host = MiniGameHost.open({
      ticket,
      mode: 'play',
      now: () => Date.now(),
      playerName: 'P1',
      characterId: 3,
      sendInput: async (m) => {
        sent.push(m);
        return { ok: true, data: undefined };
      },
      submit: async () => ({ ok: true, data: { score: 0 } }),
    });
    await expect.poll(() => host.isReady, { timeout: 10_000 }).toBe(true);
    expect(document.querySelector('[data-testid="minigame-host"] canvas')).not.toBeNull();
    await expect.poll(() => host.getSnapshot().phase, { timeout: 5000 }).toBe('playing');
    await expect.poll(() => host.loop.curr.tick, { timeout: 5000 }).toBeGreaterThan(8);
    host.sink.click({ x: 40, y: 400 });
    host.sink.click({ x: 120, y: 380 });
    await expect.poll(() => sent.length, { timeout: 5000 }).toBeGreaterThan(1);
    expect(sent[0]).toMatchObject({ seq: 0, events: [] });
    const rec = host.recorder!;
    expect(rec.log.every((e) => e[1] === InputCode.Click)).toBe(true);
    host.close();
    expect(document.querySelector('[data-testid="minigame-host"]')).toBeNull();
  });

  it('宿主关闭不释放全局资源：同页另一个 Pixi 应用（棋盘）照常渲染', async () => {
    // 模拟棋盘：独立渲染组（标记层）、cacheAsTexture 的地面块、文字与图形，与小游戏共用页面级的 Batch 池
    const errors: string[] = [];
    const board = new Application();
    await board.init({ width: 320, height: 240, preference: 'webgl', background: 0x8fd3f4 });
    document.body.append(board.canvas);
    board.ticker.stop();
    const marks = new Container({ isRenderGroup: true });
    board.stage.addChild(marks);
    const ground = new Container();
    for (let i = 0; i < 5; i++) ground.addChild(new Graphics().rect(i * 20, 0, 15, 15).fill(0x333333));
    board.stage.addChild(ground);
    ground.cacheAsTexture(true);
    for (let i = 0; i < 20; i++) {
      (i % 2 ? marks : board.stage).addChild(new Graphics().rect(i * 10, i * 5, 30, 20).fill(0xff0000 + i * 64));
      const sp = new Sprite(Texture.WHITE);
      sp.position.set(i * 12, 100);
      board.stage.addChild(sp, new Text({ text: `t${i}` }));
    }
    const frame = (): void => {
      try {
        board.render();
      } catch (err) {
        errors.push(String(err));
      }
    };
    for (let i = 0; i < 3; i++) frame();
    const t0 = Date.now();
    const ticket: MinigameTicket = {
      sessionId: 'mg-global',
      decisionId: 'd2',
      seat: 1,
      minigameId: 'xicong',
      seed: 7,
      params: { ...P },
      tickMs: 100,
      introTicks: 5,
      maxTicks: 300,
      startsAt: t0 + 100,
      deadlineAt: t0 + 100 + 30_000,
      role: 'spectator',
    };
    const host = MiniGameHost.open({
      ticket,
      mode: 'spectate',
      now: () => Date.now(),
      playerName: 'P2',
      characterId: 1,
      sendInput: async () => ({ ok: true, data: undefined }),
      submit: async () => ({ ok: true, data: { score: 0 } }),
    });
    await expect.poll(() => host.isReady, { timeout: 10_000 }).toBe(true);
    await expect.poll(() => document.querySelector('[data-testid="minigame-host"] canvas') !== null).toBe(true);
    board.stage.addChild(new Graphics().rect(0, 0, 5, 5).fill(0));
    frame();
    host.close();
    // 旧写法 app.destroy(true) 会经 GlobalResourceRegistry.release() 清空页面级的 Batch 池，
    // 棋盘随后改结构再渲染时抛「Cannot read properties of null (reading 'geometry' / 'clear')」
    for (let i = 0; i < 5; i++) {
      if (i === 2) board.stage.removeChildAt(3);
      marks.addChild(new Graphics().rect(i, i, 3, 3).fill(0xffffff));
      frame();
    }
    expect(errors).toEqual([]);
    board.destroy({ removeView: true }, { children: true });
  });
});
