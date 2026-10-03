// client-browser：关押期间不画棋子、获释时从景观走一步到关押格（原版皮肤，内存合成素材包，Chromium + WebGL）。
// - 原版被关时棋子坐标写成景观坐标，计数不为 0 时不画（exe v2.06 0x4082a5–0x4082c3），附身神明与身上炸弹也不画（0x408be6）：
//   棋子的画点在监狱 / 医院景观上，本体、名牌、附身物件、引信数字都不画；路过同格的人不为它错开；
// - 获释（0x40d184）走一步（fcn.0040bb40 bit4 分支）：起点景观、终点关押格，每 tick 8 px，tick 数 = trunc(距离 / 8)，
//   剩余 tick 少于一半时才画出来，朝向 = 景观 → 关押格，走到停在关押格；
// - 断线重连：获释后还没走（来路 = 关押格本身）的人朝向按景观 → 关押格。
// fixture 'test' 的 14 / 15 是监狱 / 医院的保释格兼关押格（环路上的关押格，同大陆医院 63）。
import { buildTestMap } from '@rich4/shared/data';
import type { GameView } from '@rich4/shared/view';
import { walkOutSwitchTick, walkOutTicks } from '@rich4/shared/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selfPlay } from '../../test/selfPlay';
import { AnimClock } from '../anim/AnimClock';
import { createOrigBoard } from './createOrigBoard';
import type { OrigActor } from './OrigActor';
import type { OrigBoardController } from './OrigBoardController';
import type { OrigRenderer } from './OrigRenderer';
import { dirOfWorldStep } from './poses';
import { buildFakePack } from './testing/fakePack';

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

async function create() {
  const def = buildTestMap();
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
    buildFakePack(def),
  );
  surface = created.surface as OrigRenderer;
  return { def, clock, surface, ctrl: created.controller as OrigBoardController };
}

/** 手动推进时钟直到 promise 完成，每帧之后调用 onFrame（让出事件循环，Pixi 可以渲染） */
async function drive(clock: AnimClock, p: Promise<unknown>, onFrame?: () => void, maxMs = 10_000): Promise<number> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  const t0 = clock.now();
  for (let t = 0; t < maxMs && !done; t += 16) {
    clock.advance(16);
    onFrame?.();
    await new Promise((res) => setTimeout(res, 0));
  }
  await p;
  return clock.now() - t0;
}

/** 本体（含附身神明、炸弹精灵）、名牌、引信数字是否画出来 */
function drawn(a: OrigActor): { body: boolean; tag: boolean; fuse: boolean | null } {
  const fuse = a.root.getChildByLabel('fuse', true);
  return {
    body: a.root.getChildByLabel('body')!.visible,
    tag: a.root.getChildByLabel('tag')!.visible,
    fuse: fuse ? fuse.visible : null,
  };
}

function baseView(): GameView {
  return selfPlay({ seed: 5, steps: 1 }).initial.view;
}

describe('关押期间不画棋子（原版 0x4082a5–0x4082c3）', () => {
  it('住院：本体、名牌、附身神明、身上炸弹都不画，画点在医院景观上，节点仍是关押格；路过同格的人不错开', async () => {
    const { def, surface: s, ctrl } = await create();
    const hold = def.landmarks.find((l) => l.kind === 'hospital')!.holdTile!;
    expect(hold).toBe(15);
    const base = baseView();
    const view: GameView = {
      ...base,
      players: base.players.map((p) => {
        if (p.seat === 0) return { ...p, placed: true, node: hold, prevNode: 14 };
        if (p.seat === 1) {
          return {
            ...p,
            placed: true,
            node: hold,
            prevNode: hold,
            st: { ...p.st, hospital: 3 },
            god: { kind: 2, days: 3 },
            bomb: { fuse: 9 },
          };
        }
        return { ...p, placed: true, node: 3 + p.seat, prevNode: 2 + p.seat };
      }),
    };
    ctrl.syncView(view);
    const a0 = s.actor(0)!;
    const a1 = s.actor(1)!;
    expect(a1.currentStatus.confined).toMatchObject({ where: 'hospital' });
    expect(a1.insideBuilding).toBe(true);
    expect(a1.offBoard).toBe(true);
    expect(a1.tile).toBe(hold);
    expect(drawn(a1)).toEqual({ body: false, tag: false, fuse: false });
    // 画点 = 医院景观（镜头跟随、气泡锚点都在这里）
    const lm = s.boardView!.landmarkWorld('hospital')!;
    const lmPos = s.proj.projectPx(lm);
    expect(a1.boardPos()).toEqual({ x: lmPos.x, y: lmPos.y });
    // 0 号独自站在 15 的正中（不为看不见的 1 号错开）
    const tile = s.boardView!.tilePos(hold)!;
    expect(a0.boardPos()).toEqual({ x: tile.x, y: tile.y });
    expect(drawn(a0).body).toBe(true);

    // 出院后（计数清掉）：回到 15，与 0 号同格错开
    const out: GameView = {
      ...view,
      players: view.players.map((p) => (p.seat === 1 ? { ...p, st: { ...p.st, hospital: 0 } } : p)),
    };
    ctrl.syncView(out);
    expect(a1.insideBuilding).toBe(false);
    expect(drawn(a1)).toEqual({ body: true, tag: true, fuse: true });
    const p0 = a0.boardPos();
    const p1 = a1.boardPos();
    expect(p0.x !== p1.x || p0.y !== p1.y).toBe(true);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('坐牢：画点在监狱景观上；住旅馆：在门前格所属的旅馆里，同样不画', async () => {
    const { def, surface: s, ctrl } = await create();
    const jail = def.landmarks.find((l) => l.kind === 'jail')!.holdTile!;
    const base = baseView();
    const hotelTile = def.tiles.find((t) => t.ref?.lot?.startsWith('F'))!;
    const hotelLot = hotelTile.ref!.lot!;
    const view: GameView = {
      ...base,
      facilities: base.facilities.map((f) => (f.id === hotelLot ? { ...f, type: 'hotel', level: 1, owner: 2 } : f)),
      players: base.players.map((p) => {
        if (p.seat === 0) return { ...p, placed: true, node: jail, prevNode: jail, st: { ...p.st, jail: 2 } };
        if (p.seat === 1) return { ...p, placed: true, node: hotelTile.id, prevNode: 1, st: { ...p.st, hotel: 2 } };
        return { ...p, placed: true, node: 3 + p.seat, prevNode: 2 + p.seat };
      }),
    };
    ctrl.syncView(view);
    const a0 = s.actor(0)!;
    const a1 = s.actor(1)!;
    expect(drawn(a0).body).toBe(false);
    expect(a0.boardPos()).toEqual(s.proj.projectPx(s.boardView!.landmarkWorld('jail')!));
    expect(a1.currentStatus.hotel).toBe(true);
    expect(drawn(a1).body).toBe(false);
    expect(a1.insideWorld).toEqual(s.boardView!.lotWorld(hotelLot));
    expect(a1.tile).toBe(hotelTile.id);
  });
});

describe('获释：从景观走一步到关押格（原版 fcn.0040bb40 bit4 分支）', () => {
  it('前半程不画、剩余 tick 少于一半时出现（onShow），朝向 = 景观 → 关押格，停在关押格；走回棋盘不再动', async () => {
    const { def, clock, surface: s, ctrl } = await create();
    const hold = def.landmarks.find((l) => l.kind === 'jail')!.holdTile!;
    const base = baseView();
    const jailed: GameView = {
      ...base,
      players: base.players.map((p) =>
        p.seat === 1
          ? { ...p, placed: true, node: hold, prevNode: hold, st: { ...p.st, jail: 0x80 } }
          : { ...p, placed: true, node: 3 + p.seat, prevNode: 2 + p.seat },
      ),
    };
    ctrl.syncView(jailed);
    const a1 = s.actor(1)!;
    const lm = s.boardView!.landmarkWorld('jail')!;
    const end = s.boardView!.tileWorld(hold)!;
    const ticks = walkOutTicks(Math.hypot(end.x - lm.x, end.y - lm.y));
    const tickMs = 80;
    let showAt = -1;
    const t0 = clock.now();
    const frames: { t: number; body: boolean }[] = [];
    const used = await drive(
      clock,
      ctrl.stage!.walkOut(
        1,
        'jail',
        {
          tickMs,
          onShow: () => {
            showAt = clock.now() - t0;
          },
        },
        new AbortController().signal,
      ),
      () => frames.push({ t: clock.now() - t0, body: drawn(a1).body }),
    );
    // 时长 = tick 数 × tick；第 switchTick 个 tick 走完时出现
    expect(used).toBeGreaterThanOrEqual(ticks * tickMs);
    expect(used).toBeLessThanOrEqual(ticks * tickMs + 32);
    const at = walkOutSwitchTick(ticks) * tickMs;
    expect(showAt).toBeGreaterThanOrEqual(at);
    expect(showAt).toBeLessThanOrEqual(at + 16);
    for (const f of frames) {
      if (f.t < at) expect(f.body, `${f.t}ms`).toBe(false);
      if (f.t > at + 16) expect(f.body, `${f.t}ms`).toBe(true);
    }
    expect(a1.facing).toBe(dirOfWorldStep(lm, end));
    expect(a1.insideBuilding).toBe(false);
    expect(a1.tile).toBe(hold);
    expect(a1.boardPos()).toEqual(s.boardView!.tilePos(hold));
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('中止（跳过动画 / reset）：直接停在关押格并画出来；断线重连后朝向按景观 → 关押格', async () => {
    const { def, clock, surface: s, ctrl } = await create();
    const hold = def.landmarks.find((l) => l.kind === 'hospital')!.holdTile!;
    const base = baseView();
    const jailed: GameView = {
      ...base,
      players: base.players.map((p) =>
        p.seat === 2
          ? { ...p, placed: true, node: hold, prevNode: hold, st: { ...p.st, hospital: 0x80 } }
          : { ...p, placed: true, node: 3 + p.seat, prevNode: 2 + p.seat },
      ),
    };
    const released: GameView = {
      ...jailed,
      players: jailed.players.map((p) => (p.seat === 2 ? { ...p, st: { ...p.st, hospital: 0 }, returning: true } : p)),
    };
    ctrl.syncView(jailed);
    const a2 = s.actor(2)!;
    const ac = new AbortController();
    const p = ctrl.stage!.walkOut(2, 'hospital', { tickMs: 80 }, ac.signal);
    clock.advance(16);
    ac.abort();
    await p;
    ctrl.syncView(released);
    expect(a2.insideBuilding).toBe(false);
    expect(drawn(a2).body).toBe(true);
    expect(a2.boardPos()).toEqual(s.boardView!.tilePos(hold));

    // 重新进房（新棋盘、快照）：获释后还没走的人（来路 = 关押格）朝向 = 医院景观 → 关押格
    surface?.destroy();
    surface = null;
    const again = await create();
    again.ctrl.syncView(released);
    const b2 = again.surface.actor(2)!;
    const lm = again.surface.boardView!.landmarkWorld('hospital')!;
    expect(b2.facing).toBe(dirOfWorldStep(lm, again.surface.boardView!.tileWorld(hold)!));
    expect(b2.insideBuilding).toBe(false);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
