// client-browser：原版舞台冒烟（内存合成素材包 + 合成 FLIC，Chromium + WebGL）——
// - FLIC 画在棋盘 overlay 层（CanvasSource 纹理），按 flic-map 的摆放对准锚点，播完移除；同步音效经 ctx.audio；
// - 每个 StagePort 方法在真实渲染器上跑完不报错（有 FLIC / 全部回退两种）；
// - 开局棋盘伞按 PARACHUTE 预算播放（original 原速），机器娃娃用原版娃娃棋子，炸弹用原版炸弹精灵；
// - clearFx / 渲染器销毁后不留演出节点，flicSfx 开关撤销。
import { buildTestMap } from '@rich4/shared/data';
import type { GameEvent, RoadObject } from '@rich4/shared/engine';
import { eventBudgetMs, ORIGINAL_FLICS, PARACHUTE_FLICS } from '@rich4/shared/view';
import { type Container, Sprite } from 'pixi.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selfPlay } from '../../../test/selfPlay';
import { AnimClock } from '../../anim/AnimClock';
import { createOrigBoard } from '../createOrigBoard';
import type { OrigBoardController } from '../OrigBoardController';
import type { OrigRenderer } from '../OrigRenderer';
import { buildFakePack } from '../testing/fakePack';

let host: HTMLDivElement;
let surface: OrigRenderer | null = null;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;top:0;width:960px;height:640px';
  document.body.appendChild(host);
  consoleError = vi.spyOn(console, 'error');
});

afterEach(() => {
  surface?.destroy();
  surface = null;
  host.remove();
  consoleError.mockRestore();
});

async function drive(clock: AnimClock, p: Promise<unknown>, maxMs = 20_000): Promise<number> {
  let done = false;
  void p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  const t0 = clock.now();
  for (let t = 0; t < maxMs && !done; t += 16) {
    clock.advance(16);
    await new Promise((res) => setTimeout(res, 0));
  }
  await p;
  return clock.now() - t0;
}

async function create(withFlics: boolean) {
  const def = buildTestMap();
  const pack = buildFakePack(def, withFlics ? { flics: true } : {});
  const clock = new AnimClock();
  const created = await createOrigBoard(
    {
      host,
      clock,
      quality: 'low',
      def,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      controller: { nameOf: (s: number) => `P${s + 1}`, autoFollow: () => true },
    },
    pack,
  );
  surface = created.surface as OrigRenderer;
  const ctrl = created.controller as OrigBoardController;
  const stage = ctrl.stage!;
  await ctrl.flics?.ready;
  const view = selfPlay({ seed: 13, steps: 60 }).batches.at(-1)!.view;
  const placed = { ...view, players: view.players.map((p, i) => ({ ...p, placed: true, node: 3 + i })) };
  ctrl.syncView(placed);
  const sounds: string[] = [];
  const audio = { play: (id: string) => void sounds.push(id) };
  return { def, pack, clock, surface, ctrl, stage, view: placed, sounds, audio };
}

const flicSprites = (layer: Container): Sprite[] =>
  layer.children.filter((c): c is Sprite => c instanceof Sprite && (c.label ?? '').startsWith('flic:'));

describe('OrigStage（合成素材包 + 合成 FLIC，Chromium + WebGL）', () => {
  it('FLIC 画在 overlay 层、按摆放对准锚点，播完移除；同步音效经 ctx.audio', async () => {
    const { clock, surface: s, ctrl, stage, sounds, audio, pack } = await create(true);
    const jail = {
      type: 'CONFINED',
      actor: { t: 'seat', seat: 1 },
      where: 'jail',
      days: 3,
      total: 3,
      cause: { k: 'card', ref: 17, by: 0 },
    } as GameEvent;
    stage.beginEvent(jail, { audio, budgetMs: eventBudgetMs(jail, 'original') });
    const feet = s.actor(1)!.boardPos();
    const run = stage.escort(1, 'jail', new AbortController().signal);
    for (let i = 0; i < 10; i++) {
      clock.advance(16);
      await new Promise((r) => setTimeout(r, 0));
    }
    const overlay = s.layers.overlay;
    const sprites = flicSprites(overlay);
    expect(sprites).toHaveLength(1);
    const spr = sprites[0]!;
    expect(spr.label).toBe(`flic:flic.${ORIGINAL_FLICS.policeCar.use}`);
    // 棋盘视窗 440×440 的中心对准脚底
    expect(spr.position.x).toBe(Math.round(feet.x - 220));
    expect(spr.position.y).toBe(Math.round(feet.y - 220));
    expect(spr.width).toBeCloseTo(440);
    expect(spr.texture.source.resource).toBeInstanceOf(HTMLCanvasElement);
    expect(sounds).toEqual([pack.flics!.specs.find((x) => x.use === ORIGINAL_FLICS.policeCar.use)!.sfx]);
    const used = await drive(clock, run);
    // original：警车原长 35 × 71 ms 原速播完
    expect(used + 160).toBeGreaterThanOrEqual(ORIGINAL_FLICS.policeCar.frames * ORIGINAL_FLICS.policeCar.frameMs - 32);
    expect(flicSprites(overlay)).toHaveLength(0);
    expect(s.actor(1)!.root.alpha).toBe(1);
    expect(ctrl.fx.count).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('画面坐标摆放（得卡）与角色旁摆放（神明离身烟雾）', async () => {
    const { clock, surface: s, stage, audio } = await create(true);
    const card = { type: 'CARD_GAINED', seat: 0, card: 3, source: 'square' } as GameEvent;
    stage.beginEvent(card, { audio, budgetMs: eventBudgetMs(card, 'original') });
    const feet = s.actor(0)!.boardPos();
    const p = stage.eventFlic(card, new AbortController().signal);
    clock.advance(16);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const spr = flicSprites(s.layers.overlay)[0]!;
    // 合成 flic-map：得卡在画面 (200, 170)，棋盘视窗中心 (220, 260)
    expect(spr.position.x).toBe(Math.round(feet.x - 20));
    expect(spr.position.y).toBe(Math.round(feet.y - 90));
    await drive(clock, p);
    s.actor(2)!.setGod(4);
    const leave = { type: 'GOD_LEFT', seat: 2, kind: 4, reason: 'expired' } as GameEvent;
    stage.beginEvent(leave, { audio, budgetMs: eventBudgetMs(leave, 'original') });
    const q = stage.godLeave(2, 4, new AbortController().signal);
    clock.advance(16);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(flicSprites(s.layers.overlay)).toHaveLength(1);
    await drive(clock, q);
    expect(s.actor(2)!.currentStatus.god).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  for (const withFlics of [true, false]) {
    it(`每个方法在真实渲染器上跑完不报错（${withFlics ? '有 FLIC' : '全部回退'}）`, async () => {
      const { clock, surface: s, ctrl, stage, view } = await create(withFlics);
      const sig = new AbortController().signal;
      const obj: RoadObject = { id: 9001, kind: 'mine', node: 4, placedBy: 0 };
      await drive(clock, stage.dropObject(obj, sig));
      await drive(clock, stage.removeObject(obj, 'boom', sig));
      const block: RoadObject = { id: 9002, kind: 'roadblock', node: 5, placedBy: 0 };
      await drive(clock, stage.dropObject(block, sig));
      // 机器娃娃：走路时棋盘上有原版娃娃棋子，走完移除
      const walk = stage.dollWalk([2, 3, 4, 5, 6], [9002], sig);
      clock.advance(200);
      await new Promise((r) => setTimeout(r, 0));
      expect(s.layers.objects.children.some((c) => c.label === 'doll')).toBe(true);
      await drive(clock, walk);
      expect(s.layers.objects.children.some((c) => c.label === 'doll')).toBe(false);
      for (const size of ['small', 'big'] as const) await drive(clock, stage.explode({ tile: 6 }, size, sig));
      for (const k of ['missile', 'nuke', 'alien', 'typhoon', 'bomb3x3'] as const) {
        await drive(clock, stage.strike(k, 6, 100, sig));
      }
      await drive(clock, stage.pillar({ seat: 0 }, 0xffffff, sig));
      await drive(clock, stage.beam({ seat: 0 }, { seat: 1 }, 0xffffff, sig));
      stage.flash(0xffffff, 200);
      await drive(clock, stage.rewind(sig));
      stage.burst({ seat: 0 }, 0xffffff);
      stage.bubble({ seat: 0 }, '！', 500);
      await drive(clock, stage.teleport({ seat: 0 }, { tile: 9 }, sig));
      await drive(clock, stage.cast(0, sig));
      stage.fireworks();
      await drive(clock, stage.godSpawn(4, 7, sig));
      await drive(clock, stage.godArrive(0, 4, sig));
      await drive(clock, stage.godPower(0, 4, sig));
      await drive(clock, stage.godLeave(0, 4, sig));
      await drive(clock, stage.manifest(12, { lot: 'L1' }, 'levelUp', sig));
      await drive(clock, stage.godSpawn(11, 8, sig));
      await drive(clock, stage.dogBite(1, 8, false, sig));
      await drive(clock, stage.dogBite(1, 8, true, sig));
      await drive(clock, stage.escort(2, 'hospital', sig));
      await drive(clock, stage.release(2, sig));
      await drive(clock, stage.vehicle(0, 'car', sig));
      await drive(clock, stage.wreck(0, 'car', sig));
      // 炸弹：原版炸弹精灵从天而降
      const attach = stage.bombAttach(0, 30, sig);
      clock.advance(100);
      await new Promise((r) => setTimeout(r, 0));
      expect(s.layers.overlay.children.some((c) => c.label === 'object.bomb')).toBe(true);
      await drive(clock, attach);
      await drive(clock, stage.bombPass(0, 1, 20, sig));
      expect(s.actor(1)!.currentStatus.bomb).toBe(20);
      await drive(clock, stage.magic(0, [1, 2], sig));
      await drive(clock, stage.beggarMove(3, 9, sig));
      await drive(clock, stage.walkVillain('spy', [3, 4, 5], sig));
      for (const e of [
        { type: 'CARD_GAINED', seat: 0, card: 3, source: 'square' },
        { type: 'POINTS_GAINED', seat: 0, amount: 30, source: 'square' },
        { type: 'HOLIDAY', key: 'h0', giveCard: true },
        { type: 'BANKRUPT', seat: 2, cause: { k: 'toll', ref: null, by: 0 }, creditor: null },
      ] as GameEvent[]) {
        await drive(clock, stage.eventFlic(e, sig));
      }
      ctrl.syncView(view);
      ctrl.clearFx();
      expect(ctrl.fx.count).toBe(0);
      expect(flicSprites(s.layers.overlay)).toHaveLength(0);
      expect(consoleError).not.toHaveBeenCalled();
    });
  }

  it('开局跳伞：棋盘伞 FLIC 按 PARACHUTE 预算播放（original 原速），播完本体出现', async () => {
    const { clock, surface: s, ctrl, stage, audio, view } = await create(true);
    // 让 3 号座位回到「还没放上棋盘」
    ctrl.syncView({ ...view, players: view.players.map((p) => (p.seat === 3 ? { ...p, placed: false } : p)) });
    const para = { type: 'PARACHUTE', seat: 3, node: 6, prev: 5 } as GameEvent;
    stage.beginEvent(para, { audio, budgetMs: eventBudgetMs(para, 'original') });
    ctrl.placeActor(3, 6);
    const c = view.players.find((p) => p.seat === 3)!.character;
    const used = await drive(clock, ctrl.hop(3, new AbortController().signal));
    expect(used + 32).toBeGreaterThanOrEqual(PARACHUTE_FLICS[c]!.frames * PARACHUTE_FLICS[c]!.frameMs);
    expect(s.actor(3)!.root.visible).toBe(true);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('开局跳伞：放上棋盘后、棋盘伞开播前本体与名牌就藏着（不先站在落点上）；播放中旋转，棋盘伞跟着落点走', async () => {
    const { clock, surface: s, ctrl, stage, audio, view } = await create(true);
    ctrl.syncView({ ...view, players: view.players.map((p) => (p.seat === 3 ? { ...p, placed: false } : p)) });
    const para = { type: 'PARACHUTE', seat: 3, node: 6, prev: 5 } as GameEvent;
    stage.beginEvent(para, { audio, budgetMs: eventBudgetMs(para, 'original') });
    ctrl.placeActor(3, 6);
    const a = s.actor(3)!;
    const body = a.root.getChildByLabel('body')!;
    const tag = a.root.getChildByLabel('tag')!;
    // 镜头推移（focus 400ms）期间：本体、名牌都不显示
    expect(a.root.visible).toBe(true);
    expect(body.visible).toBe(false);
    expect(tag.visible).toBe(false);
    clock.advance(400);
    await new Promise((r) => setTimeout(r, 0));
    expect(body.visible).toBe(false);
    const hop = ctrl.hop(3, new AbortController().signal);
    for (let i = 0; i < 6; i++) {
      clock.advance(16);
      await new Promise((r) => setTimeout(r, 0));
    }
    const chute = s.layers.overlay.children.find((c) => c.label === 'parachute')!;
    expect(chute).toBeDefined();
    expect(body.visible).toBe(false);
    s.rotate(2);
    const feet = a.boardPos();
    expect([chute.position.x, chute.position.y]).toEqual([feet.x - 220, feet.y - 220]);
    await drive(clock, hop);
    expect(body.visible).toBe(true);
    expect(tag.visible).toBe(true);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('放上棋盘后没有接着 hop（批次结束的 syncView）：取消等待，直接出现在落点上', async () => {
    const { surface: s, ctrl, view } = await create(true);
    const unplaced = { ...view, players: view.players.map((p) => (p.seat === 2 ? { ...p, placed: false } : p)) };
    ctrl.syncView(unplaced);
    ctrl.placeActor(2, 7);
    const body = s.actor(2)!.root.getChildByLabel('body')!;
    expect(body.visible).toBe(false);
    ctrl.syncView({ ...view, players: view.players.map((p) => (p.seat === 2 ? { ...p, placed: true, node: 7 } : p)) });
    expect(body.visible).toBe(true);
    expect(s.actor(2)!.awaitingDrop).toBe(false);
  });

  it('FLIC 播放中旋转视角：FLIC 跟着锚点的世界坐标重新定位（不留在旧视角的棋盘坐标上）', async () => {
    const { clock, surface: s, stage, audio } = await create(true);
    const jail = {
      type: 'CONFINED',
      actor: { t: 'seat', seat: 1 },
      where: 'jail',
      days: 3,
      total: 3,
      cause: { k: 'card', ref: 17, by: 0 },
    } as GameEvent;
    stage.beginEvent(jail, { audio, budgetMs: eventBudgetMs(jail, 'original') });
    const run = stage.escort(1, 'jail', new AbortController().signal);
    for (let i = 0; i < 10; i++) {
      clock.advance(16);
      await new Promise((r) => setTimeout(r, 0));
    }
    const spr = flicSprites(s.layers.overlay)[0]!;
    s.rotate(2);
    const feet = s.actor(1)!.boardPos();
    expect(Math.abs(spr.position.x - (feet.x - 220))).toBeLessThanOrEqual(1);
    expect(Math.abs(spr.position.y - (feet.y - 220))).toBeLessThanOrEqual(1);
    await drive(clock, run);
    expect(flicSprites(s.layers.overlay)).toHaveLength(0);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('渲染器销毁：舞台失效', async () => {
    const { stage } = await create(true);
    expect(stage.ready).toBe(true);
    surface!.destroy();
    surface = null;
    expect(stage.ready).toBe(false);
  });
});
