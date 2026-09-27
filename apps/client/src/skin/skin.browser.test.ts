// client-browser：程序化棋盘经 BoardSurface 接口工作（工厂创建、旋转口径、锚点、视口、测试钩子、轻点回调替换），
// 以及 FLIC 播放器画到真实画布（CanvasFrameSink，索引 0 透明）
import { buildTestMap } from '@rich4/shared/data';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnimClock } from '../game/anim/AnimClock';
import { selfPlay } from '../test/selfPlay';
import type { BoardSurface } from './BoardSurface';
import { createBoard, createProceduralBoard } from './boards';
import { CanvasFrameSink, FlicPlayer } from './flic/FlicPlayer';
import { buildFlc, randomPalette } from './flic/testing/flcBuilder';

let host: HTMLDivElement;
let surface: BoardSurface | null = null;
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

const controllerOpts = { nameOf: (s: number) => `P${s + 1}`, autoFollow: () => true };

describe('BoardSurface（程序化，Chromium + WebGL）', () => {
  it('工厂创建：加载地图、控制器同步角色；旋转按 90° 一档走统一口径 0/2/4/6；锚点、视口与测试钩子', async () => {
    const clock = new AnimClock();
    const created = await createProceduralBoard({
      host,
      clock,
      quality: 'low',
      def: buildTestMap(),
      insets: { top: 40, right: 200, bottom: 60, left: 0 },
      controller: controllerOpts,
    });
    surface = created.surface;
    expect(surface.kind).toBe('procedural');
    expect(surface.loaded).toBe(true);
    expect(surface.rotationStep).toBe(2);
    const view = selfPlay({ seed: 5, steps: 20 }).batches.at(-1)!.view;
    created.controller.syncView(view);

    // 测试钩子（E2E 读的形状）
    const actors = surface.board.allActors();
    expect(actors).toHaveLength(view.players.length);
    const a0 = surface.board.actor(0)!;
    expect(a0.seat).toBe(0);
    expect(typeof a0.isWalking).toBe('boolean');
    expect(Array.isArray(a0.root.children)).toBe(true);
    expect(surface.board.roads.counts()).toMatchObject({ objects: expect.any(Number) });

    // 锚点与画布坐标
    const p0 = view.players.find((p) => p.placed)!;
    const anchor = surface.anchorPos({ seat: p0.seat });
    expect(anchor).not.toBeNull();
    expect(surface.anchorPos({ seat: p0.seat }, true)!.y).toBeLessThan(anchor!.y);
    expect(surface.anchorPos({ tile: 1 })).not.toBeNull();
    expect(surface.anchorPos({ tile: 99_999 })).toBeNull();
    expect(surface.tileCanvasPos(1)).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    const corners = surface.viewportCorners()!;
    expect(corners).toHaveLength(4);
    expect(surface.viewportSize()).toEqual({ w: 960, h: 640 });
    const mid = surface.camera.screenToWorld({ x: 480, y: 320 });
    const back = surface.camera.worldToScreen(mid);
    expect(back.x).toBeCloseTo(480);
    expect(back.y).toBeCloseTo(320);

    // 旋转：一档 90°，统一口径只出现偶数；镜头保持对准同一点，四次回到原位
    expect(surface.rotation).toBe(0);
    const seen = [surface.rotate(1), surface.rotate(1), surface.rotate(1), surface.rotate(1)];
    expect(seen).toEqual([2, 4, 6, 0]);
    expect(surface.rotate(-1)).toBe(6);
    expect(surface.rotation).toBe(6);

    // 镜头门面
    surface.camera.onUserGesture();
    expect(surface.camera.followPaused).toBe(true);
    await surface.camera.zoomTo(surface.camera.maxZoom * 2, 0);
    expect(surface.camera.zoom).toBeCloseTo(surface.camera.maxZoom);
    await surface.camera.fitAll(0);
    expect(surface.camera.zoom).toBeLessThanOrEqual(surface.camera.maxZoom + 1e-9);

    // 轻点回调可随时替换
    const tap = vi.fn();
    surface.onTap = tap;
    expect(surface.onTap).toBe(tap);
    surface.onDoubleTap = null;
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('createBoard：想要原版但没有注册原版渲染器 → 回退程序化并说明原因；中止时销毁并抛 AbortError', async () => {
    const clock = new AnimClock();
    const b = await createBoard('original', {
      host,
      clock,
      quality: 'low',
      def: buildTestMap(),
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      controller: controllerOpts,
    });
    surface = b.surface;
    expect(b).toMatchObject({ kind: 'procedural', fallback: 'renderer-unavailable' });
    expect(host.querySelectorAll('canvas')).toHaveLength(1);

    const ac = new AbortController();
    const p = createProceduralBoard({
      host,
      clock,
      quality: 'low',
      def: buildTestMap(),
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      controller: controllerOpts,
      signal: ac.signal,
    });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    // 中止的棋盘已销毁：只剩第一张画布
    expect(host.querySelectorAll('canvas')).toHaveLength(1);
  });
});

describe('FlicPlayer 画到真实画布', () => {
  it('默认 CanvasFrameSink：索引 0 透明、其余按调色板；逐帧复用同一张画布', async () => {
    const pal = randomPalette(11);
    const px0 = new Uint8Array(16 * 8);
    px0.fill(5, 0, 64);
    const px1 = new Uint8Array(16 * 8).fill(9);
    const bytes = buildFlc({
      width: 16,
      height: 8,
      speed: 40,
      frames: [
        { pixels: px0, palette: pal, encoding: 'byterun' },
        { pixels: px1, encoding: 'delta' },
      ],
    });
    const clock = new AnimClock();
    const player = new FlicPlayer(bytes, { clock });
    const canvas = player.canvas as HTMLCanvasElement;
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect([canvas.width, canvas.height]).toEqual([16, 8]);
    const ctx = canvas.getContext('2d')!;
    player.show(0);
    const top = ctx.getImageData(0, 0, 1, 1).data;
    expect([...top]).toEqual([pal[15], pal[16], pal[17], 255]);
    expect(ctx.getImageData(0, 7, 1, 1).data[3]).toBe(0);
    player.show(1);
    expect([...ctx.getImageData(0, 7, 1, 1).data]).toEqual([pal[27], pal[28], pal[29], 255]);
    expect(player.canvas).toBe(canvas);
    // 自带画布的 sink
    const own = document.createElement('canvas');
    const p2 = new FlicPlayer(bytes, { clock, sink: new CanvasFrameSink(16, 8, own) });
    p2.show(1);
    expect(own.getContext('2d')!.getImageData(3, 3, 1, 1).data[3]).toBe(255);
  });
});
