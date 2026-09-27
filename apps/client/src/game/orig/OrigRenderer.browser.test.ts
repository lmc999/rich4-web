// client-browser：原版棋盘（合成素材包 + fixture 地图，Chromium + WebGL）——OrigRenderer 载入、BoardSurface 同形、
// 8 视角旋转（镜头对准同一世界点）、角色行走（8 方向帧、快艇段）、拾取、测试钩子计数、原版小地图登记，全程无报错。
import { buildTestMap } from '@rich4/shared/data';
import { Container } from 'pixi.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boardFactory, registerBoardFactory } from '../../skin/boardRegistry';
import { installBoardRenderers, originalBoardFactory } from '../../skin/renderers';
import { selfPlay } from '../../test/selfPlay';
import { AnimClock } from '../anim/AnimClock';
import { origMiniMapFor } from '../minimap/OrigMiniMap';
import { createOrigBoard } from './createOrigBoard';
import { smoothingFor } from './OrigAssets';
import type { OrigBoardController } from './OrigBoardController';
import type { OrigRenderer } from './OrigRenderer';
import { buildFakePack } from './testing/fakePack';

let host: HTMLDivElement;
let surface: OrigRenderer | null = null;
let consoleError: ReturnType<typeof vi.spyOn>;
let consoleWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;top:0;width:960px;height:640px';
  document.body.appendChild(host);
  consoleError = vi.spyOn(console, 'error');
  consoleWarn = vi.spyOn(console, 'warn');
});

afterEach(() => {
  surface?.destroy();
  surface = null;
  host.remove();
  consoleError.mockRestore();
  consoleWarn.mockRestore();
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

const controllerOpts = { nameOf: (s: number) => `P${s + 1}`, autoFollow: () => true };

/** 4 人都已放上棋盘（各站一格：3、4、5、6） */
function placedView() {
  const base = selfPlay({ seed: 5, steps: 1 }).initial.view;
  return {
    ...base,
    players: base.players.map((p) => ({ ...p, placed: true, node: 3 + p.seat, prevNode: 2 + p.seat })),
  };
}

async function create(boatTiles: number[] = [], quality: 'low' | 'mid' = 'low') {
  const def = buildTestMap();
  const pack = buildFakePack(def, { boatTiles });
  const clock = new AnimClock();
  const created = await createOrigBoard(
    { host, clock, quality, def, insets: { top: 0, right: 0, bottom: 0, left: 0 }, controller: controllerOpts },
    pack,
  );
  surface = created.surface as OrigRenderer;
  return { def, pack, clock, surface, ctrl: created.controller as OrigBoardController };
}

describe('OrigRenderer（合成素材包，Chromium + WebGL）', () => {
  it('载入：地面、装饰、企业与景观；BoardSurface 同形；测试钩子计数与显示态一致', async () => {
    const { def, pack, surface: s, ctrl } = await create();
    expect(s.kind).toBe('original');
    expect(s.loaded).toBe(true);
    expect(s.rotationStep).toBe(1);
    expect(s.rotation).toBe(0);
    const st = s.sceneStats();
    expect(st.ground).toBe(1);
    expect(st.decor).toBe(pack.skin.decor.nodes.length);
    expect(st.lots).toBe(def.lots.length + def.companies.length);
    expect(st.buildings).toBe(def.companies.length);
    expect(st.scenery).toBe(def.landmarks.length);
    // 角色姿态库按需加载：还没有同步角色，不应请求 char.* 组
    expect(pack.requested.some((p) => p.includes('/char.'))).toBe(false);

    const sp = selfPlay({ seed: 13, steps: 80 });
    const view = sp.batches.at(-1)!.view;
    ctrl.syncView(view);
    const actors = s.board.allActors();
    expect(actors).toHaveLength(view.players.length);
    for (const p of view.players) {
      const a = s.board.actor(p.seat)!;
      expect(a.seat).toBe(p.seat);
      expect(a.root.visible).toBe(p.placed && p.node > 0);
      if (p.placed) expect(a.tile).toBe(p.node);
      expect(typeof a.isWalking).toBe('boolean');
      expect(Array.isArray(a.root.children)).toBe(true);
      expect(a.currentStatus).toMatchObject({ vehicle: p.vehicle });
    }
    const counts = s.board.roads.counts();
    expect(counts.objects).toBe(view.objects.filter((o) => o.node > 0).length);
    expect(counts.gods).toBe(view.gods.filter((g) => g.where.t === 'road').length);
    expect(counts.villains).toBe(view.villains.filter((v) => v.onBoard && v.node > 0).length);
    expect(counts.beggars).toBe(view.beggars.length);
    // 住宅：有等级的地块画出建筑（企业之外），空地已有主画角色标记
    const built = view.lands.filter((l) => l.level > 0).length + view.facilities.filter((f) => f.level > 0).length;
    await new Promise((r) => setTimeout(r, 0));
    expect(s.sceneStats().buildings).toBe(def.companies.length + built);
    const owned0 = view.lands.filter((l) => l.level === 0 && l.owner !== null).length;
    expect(s.sceneStats().marks).toBe(owned0 + view.facilities.filter((f) => f.level === 0 && f.owner !== null).length);

    // 锚点、画布坐标、视口
    const p0 = view.players.find((p) => p.placed)!;
    const a = s.anchorPos({ seat: p0.seat })!;
    expect(s.anchorPos({ seat: p0.seat }, true)!.y).toBeLessThan(a.y);
    expect(s.anchorPos({ tile: 1 })).not.toBeNull();
    expect(s.anchorPos({ tile: 99_999 })).toBeNull();
    expect(s.anchorPos({ lot: def.lots[0]!.id })).not.toBeNull();
    expect(s.viewportCorners()).toHaveLength(4);
    expect(s.viewportSize()).toEqual({ w: 960, h: 640 });
    const mid = s.camera.screenToWorld({ x: 480, y: 320 });
    const back = s.camera.worldToScreen(mid);
    expect(back.x).toBeCloseTo(480);
    expect(back.y).toBeCloseTo(320);
    // 原版小地图已登记
    expect(origMiniMapFor(def)).not.toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('8 视角旋转：一档 45°，镜头保持对准同一个世界点；帧号随视角变化；8 次回到原位', async () => {
    const { surface: s, ctrl } = await create();
    const view = selfPlay({ seed: 5, steps: 30 }).batches.at(-1)!.view;
    ctrl.syncView(view);
    const seat = view.players.find((p) => p.placed)!.seat;
    await new Promise((r) => setTimeout(r, 50));
    const actor = s.actor(seat)!;
    const worldFocus = s.proj.unproject(s.camera.center);
    const frames: number[] = [];
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      seen.push(s.rotate(1));
      const w = s.proj.unproject(s.camera.center);
      expect(Math.hypot(w.x - worldFocus.x, w.y - worldFocus.y)).toBeLessThan(1.5);
      frames.push(actor.frameIndex);
      // 地面容器的变换就是当前视角的仿射
      const m = s.proj.affine();
      const groundRoot = s.layers.ground.children[0]!;
      groundRoot.updateLocalTransform();
      const gm = groundRoot.localTransform;
      expect(gm.a).toBeCloseTo(m.a, 6);
      expect(gm.c).toBeCloseTo(m.c, 6);
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 0]);
    expect(new Set(frames).size).toBe(8);
    expect(s.rotate(-1)).toBe(7);
    expect(s.setView(3)).toBe(3);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('行走：逐格插值、8 方向帧与走姿库；快艇节点段换快艇姿态；中止直接落到终点', async () => {
    const def = buildTestMap();
    const path = [1, 2, 3, 4, 5];
    const { clock, surface: s, ctrl } = await create([4, 5]);
    const view = selfPlay({ seed: 5, steps: 1 }).initial.view;
    ctrl.syncView(view);
    const seat = 0;
    const c = view.players[seat]!.character;
    // 姿态库懒加载：先取齐用到的几套，行走中的帧选择才是确定的
    for (const k of ['stand', 'walk', 'boat.stand', 'boat.walk']) await s.assets.sheet(`char.${c}.${k}`);
    ctrl.placeActor(seat, 1);
    const a = s.actor(seat)!;
    // 开局配置的交通工具可能是汽车：本用例测步行与快艇姿态
    a.setStatus({ ...a.currentStatus, vehicle: 'walk' });
    await drive(clock, a.hop());
    const keys = new Set<string>();
    const dirs = new Set<number>();
    const off = clock.onFrame(() => {
      if (a.poseKey) keys.add(a.poseKey);
      dirs.add(a.facing);
      // 行走中的深度层：玩家 0xC（当前行动者 0xD）
      if (a.isWalking) expect(((a.root.zIndex % 16) + 16) % 16).toBeGreaterThanOrEqual(0xc);
    });
    const steps: number[] = [];
    await drive(
      clock,
      ctrl.walk(seat, path, new AbortController().signal, (t) => steps.push(t)),
    );
    off();
    expect(dirs.size).toBeGreaterThanOrEqual(1);
    expect(a.tile).toBe(5);
    expect(steps).toEqual([2, 3, 4, 5]);
    expect(a.isWalking).toBe(false);
    expect([...keys]).toContain(`char.${c}.walk`);
    expect([...keys]).not.toContain(`char.${c}.car.walk`);
    expect(keys.has(`char.${c}.boat.walk`)).toBe(true);
    expect(a.inBoat).toBe(true);
    expect(a.poseKey).toMatch(new RegExp(`^char\\.${c}\\.(boat\\.stand|dice)$`));
    const w5 = def.tiles.find((t) => t.id === 5)!.world;
    expect(a.worldPos).toEqual(w5);
    // 中止：直接落到终点
    const ac = new AbortController();
    const p = ctrl.walk(seat, [5, 6, 7, 8], ac.signal);
    clock.advance(50);
    ac.abort();
    await p;
    expect(a.tile).toBe(8);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('拾取：点节点的画布坐标命中该节点；点空白为 null；轻点回调可替换', async () => {
    const { def, surface: s, ctrl } = await create();
    ctrl.syncView(selfPlay({ seed: 5, steps: 1 }).initial.view);
    for (const t of def.tiles.slice(0, 6)) {
      const c = s.tileCanvasPos(t.id)!;
      expect(s.pickScreen(c)?.tile).toBe(t.id);
    }
    const tap = vi.fn();
    s.onTap = tap;
    expect(s.onTap).toBe(tap);
    s.onDoubleTap = null;
    expect(s.pickScreen({ x: -5000, y: -5000 })).toBeNull();
  });

  it('演出端口与原版舞台：插旗、升级弹跳、飘字、物件落下 / 移除、恶人行走不报错；clearFx 清空', async () => {
    const { def, clock, surface: s, ctrl } = await create();
    const view = selfPlay({ seed: 13, steps: 60 }).batches.at(-1)!.view;
    ctrl.syncView(view);
    const signal = new AbortController().signal;
    const lot = def.lots[0]!.id;
    const seat = view.players[0]!.seat;
    await drive(clock, ctrl.plantFlag(lot, seat, signal));
    ctrl.setLot(lot, { owner: seat, level: 2 });
    await drive(clock, ctrl.popBuilding(lot, signal));
    ctrl.floatText({ lot }, '+100', 'gain');
    ctrl.pulseTile(1);
    ctrl.highlight([1, 2, 3], 2);
    expect(ctrl.highlightedTiles).toEqual([1, 2, 3]);
    const stage = ctrl.stage!;
    expect(stage.ready).toBe(true);
    const obj = { id: 9001, kind: 'roadblock' as const, node: 3, placedBy: seat };
    const before = s.board.roads.counts().objects;
    await drive(clock, stage.dropObject(obj, signal));
    expect(s.board.roads.counts().objects).toBe(before + 1);
    await drive(clock, stage.removeObject(obj, 'fade', signal));
    expect(s.board.roads.counts().objects).toBe(before);
    await drive(clock, stage.walkVillain('thief', [1, 2, 3], signal));
    expect(s.board.roads.counts().villains).toBeGreaterThanOrEqual(1);
    await drive(clock, stage.explode({ tile: 2 }, 'small', signal));
    ctrl.say(seat, '你好', 1000);
    expect(s.actor(seat)!.root.children.some((c) => c.label === 'speech')).toBe(true);
    ctrl.clearFx();
    expect(ctrl.fx.count).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('缩放：< 1 时地面 linear + mipmap，非整数倍时精灵平滑；销毁后撤销小地图登记', async () => {
    const { def, clock, surface: s } = await create();
    const frames = () => new Promise((r) => setTimeout(r, 120));
    await drive(clock, s.camera.zoomTo(0.6, 0));
    await frames();
    expect(s.assets.smoothing).toEqual({ sprites: true, ground: true });
    await drive(clock, s.camera.zoomTo(1.5, 0));
    await frames();
    expect(s.assets.smoothing).toEqual({ sprites: true, ground: false });
    await drive(clock, s.camera.zoomTo(2, 0));
    await frames();
    expect(s.assets.smoothing).toEqual({ sprites: false, ground: false });
    s.destroy();
    surface = null;
    expect(origMiniMapFor(def)).toBeNull();
  });

  it('销毁：借来的位图全部归还给素材包客户端（离开对局不再常驻）', async () => {
    const { pack, surface: s, ctrl } = await create();
    ctrl.syncView(selfPlay({ seed: 13, steps: 60 }).batches.at(-1)!.view);
    await new Promise((r) => setTimeout(r, 50));
    expect(pack.borrowedImages.size).toBeGreaterThan(0);
    s.destroy();
    surface = null;
    // 销毁后才完成的加载也立即归还
    await new Promise((r) => setTimeout(r, 50));
    expect([...pack.borrowedImages]).toEqual([]);
  });

  it('平滑按有效倍率（镜头缩放 × 画布分辨率）：DPR 1.5 时镜头 1 倍平滑、2 倍（= 3 倍设备像素）最近邻', async () => {
    expect(smoothingFor(1)).toEqual({ sprites: false, ground: false });
    expect(smoothingFor(1.25)).toEqual({ sprites: true, ground: false });
    expect(smoothingFor(3)).toEqual({ sprites: false, ground: false });
    expect(smoothingFor(0.75)).toEqual({ sprites: true, ground: true });
    const dpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', { value: 1.5, configurable: true });
    try {
      const { clock, surface: s } = await create([], 'mid');
      expect(s.app.renderer.resolution).toBe(1.5);
      const frames = () => new Promise((r) => setTimeout(r, 120));
      await drive(clock, s.camera.zoomTo(1, 0));
      await frames();
      expect(s.assets.smoothing.sprites).toBe(true);
      await drive(clock, s.camera.zoomTo(2, 0));
      await frames();
      expect(s.assets.smoothing.sprites).toBe(false);
    } finally {
      if (dpr) Object.defineProperty(window, 'devicePixelRatio', dpr);
      else Reflect.deleteProperty(window, 'devicePixelRatio');
    }
  });

  it('身上的炸弹：引信数字挂在名牌之后（最上层），画在炸弹精灵下部、不与名牌重叠', async () => {
    const { surface: s, ctrl } = await create();
    ctrl.syncView(placedView());
    await s.assets.sheet('object.bomb');
    const a = s.actor(0)!;
    a.setStatus({ ...a.currentStatus, bomb: 7 });
    await new Promise((r) => setTimeout(r, 20));
    const kids = a.root.children;
    const tag = a.root.getChildByLabel('tag')!;
    const fuse = a.root.getChildByLabel('fuse')!;
    expect(kids.indexOf(fuse)).toBeGreaterThan(kids.indexOf(tag));
    expect(fuse.visible).toBe(true);
    expect((fuse as unknown as { text: string }).text).toBe('7');
    const fb = fuse.getBounds();
    const tb = tag.getBounds();
    const overlap =
      fb.x < tb.x + tb.width && tb.x < fb.x + fb.width && fb.y < tb.y + tb.height && tb.y < fb.y + fb.height;
    expect(overlap).toBe(false);
    a.setStatus({ ...a.currentStatus, bomb: null });
    expect(a.root.getChildByLabel('fuse')).toBeNull();
  });

  it('冬眠 ZZZ 以脚底为画点（锚点已把它抬到头顶），不再重复加身高；名牌让到 ZZZ 上方', async () => {
    const { surface: s, ctrl } = await create();
    ctrl.syncView(placedView());
    const a = s.actor(1)!;
    const zzzSheet = await s.assets.sheet('object.zzz');
    a.setStatus({ ...a.currentStatus, hibernate: true });
    await new Promise((r) => setTimeout(r, 20));
    const body = a.root.getChildByLabel('body')!;
    const zzz = body.getChildByLabel('zzz')!;
    expect(zzz.parent).toBe(body);
    const [ax, ay] = zzzSheet!.anchors[0]!;
    expect([zzz.position.x, zzz.position.y]).toEqual([-ax, -ay]);
    const tag = a.root.getChildByLabel('tag')!;
    // 名牌下沿（名牌以下沿为原点）在 ZZZ 顶端之上
    expect(tag.position.y).toBeLessThanOrEqual(body.position.y + zzz.position.y);
  });

  it('同格 4 人：名牌居中、按名牌高度逐个抬高，互不遮挡；深度键计入座位偏移（前排画在后排之上）', async () => {
    const { surface: s, ctrl } = await create();
    const base = selfPlay({ seed: 5, steps: 1 }).initial.view;
    const view = { ...base, players: base.players.map((p) => ({ ...p, placed: true, node: 6, prevNode: 5 })) };
    ctrl.syncView(view);
    const actors = [0, 1, 2, 3].map((seat) => s.actor(seat)!);
    const tags = actors.map((a) => a.root.getChildByLabel('tag') as Container);
    for (const [i, t] of tags.entries()) {
      const a = actors[i]!;
      // 名牌居中（不跟座位的左右偏移）
      expect(a.root.position.x + t.position.x).toBe(actors[0]!.root.position.x + tags[0]!.position.x);
    }
    const disjoint = (): void => {
      const boxes = tags.map((t) => t.getBounds());
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const p = boxes[i]!;
          const q = boxes[j]!;
          expect(p.y + p.height <= q.y + 0.5 || q.y + q.height <= p.y + 0.5).toBe(true);
        }
      }
    };
    disjoint();
    // 其中一人冬眠：ZZZ 出现后整叠名牌让到 ZZZ 之上，仍互不遮挡
    await s.assets.sheet('object.zzz');
    actors[2]!.setStatus({ ...actors[2]!.currentStatus, hibernate: true });
    await new Promise((r) => setTimeout(r, 20));
    disjoint();
    const zzz = (actors[2]!.root.getChildByLabel('body') as Container).getChildByLabel('zzz')!;
    const zb = zzz.getBounds();
    for (const t of tags) expect(t.getBounds().y + t.getBounds().height).toBeLessThanOrEqual(zb.y + 0.5);
    // 后排 0 号（偏移 y −4）即使是当前行动者（层 0xD），前排 2、3 号（偏移 y +5）仍画在它之上
    for (const a of actors) a.setCurrent(a.seat === 0);
    const back = actors.filter((a) => a.boardPos().y < actors[2]!.boardPos().y);
    expect(back.map((a) => a.seat)).toEqual([0, 1]);
    for (const b of back) {
      expect(actors[2]!.root.zIndex).toBeGreaterThan(b.root.zIndex);
      expect(actors[3]!.root.zIndex).toBeGreaterThan(b.root.zIndex);
    }
  });

  it('插旗：地块上已画着静态角色标记时让它自己落下，不另建一个副本', async () => {
    const { clock, def, surface: s, ctrl } = await create();
    const view = selfPlay({ seed: 5, steps: 1 }).initial.view;
    ctrl.syncView(view);
    await s.assets.sheet('board.ownerMark');
    const lot = def.lots.find((l) => l.kind === 'land')!.id;
    const seat = view.players[0]!.seat;
    ctrl.setLot(lot, { owner: seat, level: 0 });
    expect(s.boardView!.markLiftOf(lot)).toBe(0);
    const overlayBefore = s.layers.overlay.children.length;
    const p = ctrl.plantFlag(lot, seat, new AbortController().signal);
    clock.advance(60);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.boardView!.markLiftOf(lot)!).toBeGreaterThan(0);
    expect(s.layers.overlay.children.length).toBe(overlayBefore);
    await drive(clock, p);
    expect(s.boardView!.markLiftOf(lot)).toBe(0);
    expect(s.sceneStats().marks).toBeGreaterThanOrEqual(1);
  });

  it('换视角时按锚点登记的演出节点跟着锚点的世界坐标重新投影', async () => {
    const { surface: s, ctrl } = await create();
    ctrl.syncView(selfPlay({ seed: 5, steps: 1 }).initial.view);
    const at = s.anchorPos({ tile: 6 })!;
    const node = new Container();
    node.position.set(at.x - 220, at.y - 220);
    s.layers.overlay.addChild(node);
    const unpin = s.pinToBoard(node, at);
    s.rotate(3);
    const now = s.anchorPos({ tile: 6 })!;
    // 锚点的棋盘坐标是取整后的投影：反投影回世界再投影到新视角，误差不超过 1 像素
    expect(Math.abs(node.position.x - (now.x - 220))).toBeLessThanOrEqual(1);
    expect(Math.abs(node.position.y - (now.y - 220))).toBeLessThanOrEqual(1);
    const pinned = { x: node.position.x, y: node.position.y };
    unpin();
    s.rotate(1);
    expect({ x: node.position.x, y: node.position.y }).toEqual(pinned);
  });

  it('渲染器注册：skin/renderers 把原版棋盘工厂注册为 original（可注销后重新安装）', () => {
    expect(boardFactory('original')).toBe(originalBoardFactory);
    registerBoardFactory('original', null);
    expect(boardFactory('original')).toBeNull();
    installBoardRenderers();
    expect(boardFactory('original')).toBe(originalBoardFactory);
  });
});
