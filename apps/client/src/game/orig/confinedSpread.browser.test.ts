// client-browser：环路上的关押格（原版另外 3 张图：大陆医院 63、日本医院 55、美国医院 85 与监狱 118 都是保释格 = 关押格）。
// 被关的棋子站在关押格上（p.node = 关押格），路过的玩家经常停在同一格：同格多人的座位错开对被关的棋子同样生效，
// 两人不会完全重叠。被关玩家原版画在哪里（是否贴到医院 / 监狱景观坐标上）属于 VERIFY V-M7，核实前锁定现状：
// 画在关押格上、按座位错开。fixture 'test' 的 14 / 15 就是这种结构（监狱 / 医院的保释格兼关押格）。
import { buildTestMap } from '@rich4/shared/data';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selfPlay } from '../../test/selfPlay';
import { AnimClock } from '../anim/AnimClock';
import { createOrigBoard } from './createOrigBoard';
import { ORIG_SEAT_OFFSETS } from './OrigActor';
import type { OrigBoardController } from './OrigBoardController';
import type { OrigRenderer } from './OrigRenderer';
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
  const created = await createOrigBoard(
    {
      host,
      clock: new AnimClock(),
      quality: 'low',
      def,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      controller: { nameOf: (s: number) => `P${s + 1}`, autoFollow: () => true },
    },
    buildFakePack(def),
  );
  surface = created.surface as OrigRenderer;
  return { def, surface, ctrl: created.controller as OrigBoardController };
}

describe('环路上的关押格：被关的棋子与路过的棋子同格（⚑V-M7 锁定现状）', () => {
  it('医院 15 = 保释格 = 关押格：1 号住院、0 号停在同一格 → 两人都在 15、按座位错开，不完全重叠', async () => {
    const { def, surface: s, ctrl } = await create();
    const hold = def.landmarks.find((l) => l.kind === 'hospital')!.holdTile!;
    expect(hold).toBe(15);
    expect(def.tiles.find((t) => t.id === hold)!.landingCode).toBe(5);
    const base = selfPlay({ seed: 5, steps: 1 }).initial.view;
    const view = {
      ...base,
      players: base.players.map((p) => {
        if (p.seat === 0) return { ...p, placed: true, node: hold, prevNode: 14 };
        if (p.seat === 1) return { ...p, placed: true, node: hold, prevNode: hold, st: { ...p.st, hospital: 3 } };
        return { ...p, placed: true, node: 3 + p.seat, prevNode: 2 + p.seat };
      }),
    };
    ctrl.syncView(view);
    const a0 = s.actor(0)!;
    const a1 = s.actor(1)!;
    expect(a1.currentStatus.confined).toMatchObject({ where: 'hospital' });
    expect(a0.currentStatus.confined).toBeNull();
    expect(a0.tile).toBe(hold);
    expect(a1.tile).toBe(hold);
    expect(a0.root.visible && a1.root.visible).toBe(true);
    // 同格多人：各按座位偏移（与路过的普通同格相同），两人的棋盘坐标不同
    const p0 = a0.boardPos();
    const p1 = a1.boardPos();
    expect(p0.x !== p1.x || p0.y !== p1.y).toBe(true);
    expect(ORIG_SEAT_OFFSETS[0]).not.toEqual(ORIG_SEAT_OFFSETS[1]);
    // 名牌互不遮挡
    const b0 = a0.root.getChildByLabel('tag')!.getBounds();
    const b1 = a1.root.getChildByLabel('tag')!.getBounds();
    expect(b0.y + b0.height <= b1.y + 0.5 || b1.y + b1.height <= b0.y + 0.5).toBe(true);
    // 0 号离开后，被关的 1 号回到格子正中（没有偏移）
    const alone = { ...view, players: view.players.map((p) => (p.seat === 0 ? { ...p, node: 16, prevNode: 15 } : p)) };
    ctrl.syncView(alone);
    const tileCenter = s.boardView!.tilePos(hold)!;
    const q1 = a1.boardPos();
    expect(Math.round(q1.x)).toBe(tileCenter.x);
    expect(Math.round(q1.y)).toBe(tileCenter.y);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
