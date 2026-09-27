// BoardSurface 接缝（original-skin.md §3 修正 7）：统一旋转口径 0..7 与程序化 0..3 的换算；镜头缩放上下限参数化；
// EventPlayer 的上下文带 {epoch, seq, eventIndex}（语音确定性选择）
import type { GameEvent } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { describe, expect, it } from 'vitest';
import { AnimClock } from '../game/anim/AnimClock';
import { Camera, MAX_ZOOM, MIN_ZOOM, type Transformable } from '../game/camera/Camera';
import { EventPlayer } from '../presentation/EventPlayer';
import type { EventStamp, HandlerMap, PresentationContext } from '../presentation/types';
import { fromProceduralRotation, normSurfaceRotation, toProceduralRotation } from './BoardSurface';

function target(): Transformable {
  const pt = () => {
    const p = { x: 0, y: 0, set: (x: number, y?: number) => Object.assign(p, { x, y: y ?? x }) };
    return p;
  };
  return { position: pt(), scale: pt() };
}

describe('旋转口径', () => {
  it('统一口径 0..7 归一化', () => {
    expect([-1, 0, 7, 8, 9, 15, -9].map(normSurfaceRotation)).toEqual([7, 0, 7, 0, 1, 7, 7]);
  });

  it('程序化 0..3 ↔ 统一口径 0/2/4/6；奇数向下取到相邻偶数方向', () => {
    expect([0, 1, 2, 3, 4, -1].map(fromProceduralRotation)).toEqual([0, 2, 4, 6, 0, 6]);
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(toProceduralRotation)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 0]);
    for (let r = 0; r < 4; r++) expect(toProceduralRotation(fromProceduralRotation(r))).toBe(r);
  });
});

describe('镜头缩放上下限参数化', () => {
  it('缺省沿用程序化的 MIN_ZOOM / MAX_ZOOM，且 fitAll 可临时放宽下限', async () => {
    const cam = new Camera(target(), { w: 400, h: 300 });
    expect([cam.minZoom, cam.maxZoom]).toEqual([MIN_ZOOM, MAX_ZOOM]);
    await cam.fitAll(0, { x: 0, y: 0, w: 10_000, h: 10_000 });
    expect(cam.zoom).toBeLessThan(MIN_ZOOM);
  });

  it('原版棋盘式的范围（1–3×、不放宽）：缩放夹在范围内，fitAll 不低于下限', async () => {
    const cam = new Camera(target(), { w: 400, h: 300 }, null, { minZoom: 1, maxZoom: 3, relaxMinToFit: false });
    cam.setZoom(10);
    expect(cam.zoom).toBe(3);
    cam.setZoom(0.2);
    expect(cam.zoom).toBe(1);
    cam.setBounds({ x: 0, y: 0, w: 2304, h: 2304 });
    await cam.fitAll(0);
    expect(cam.zoom).toBe(1);
    expect(cam.minZoom).toBe(1);
  });

  it('setZoomLimits 即时生效并夹紧当前缩放', () => {
    const cam = new Camera(target(), { w: 400, h: 300 });
    cam.setZoom(1.5);
    cam.setZoomLimits(0.5, 1.2);
    expect(cam.zoom).toBe(1.2);
    expect(cam.maxZoom).toBe(1.2);
    cam.setZoomLimits(2, 1);
    expect(cam.minZoom).toBe(2);
    expect(cam.maxZoom).toBe(2);
  });
});

describe('EventPlayer 上下文携带事件位置', () => {
  it('每个 handler 的 ctx.at = {epoch, seq, eventIndex}（工厂不给时由 EventPlayer 补上）', async () => {
    const clock = new AnimClock();
    const seen: (EventStamp | undefined)[] = [];
    const factoryArgs: EventStamp[] = [];
    const handlers = new Proxy({} as HandlerMap, {
      get: () => async (_e: GameEvent, ctx: PresentationContext) => {
        seen.push(ctx.at);
      },
    });
    const view = { v: 1 } as unknown as GameView;
    const player = new EventPlayer({
      handlers,
      clock,
      requestResync: () => {},
      sink: {
        reset: () => {},
        commitView: () => {},
        commitBatch: () => {},
        commitPending: () => {},
        setAnim: () => {},
      },
      context: (signal, _view, at) => {
        factoryArgs.push(at);
        return { signal, wait: (ms: number) => clock.wait(ms, signal) } as unknown as PresentationContext;
      },
    });
    player.reset({ epoch: 3, seq: 10, view, pending: [] });
    const ev = (type: string) => ({ type, post: {} }) as unknown as GameEvent;
    player.enqueue({ epoch: 3, seq: 11, events: [ev('TURN_STARTED'), ev('TURN_ENDED')], animMs: 0, view, pending: [] });
    player.enqueue({ epoch: 3, seq: 12, events: [ev('TURN_STARTED')], animMs: 0, view, pending: [] });
    await player.whenIdle();
    expect(seen).toEqual([
      { epoch: 3, seq: 11, eventIndex: 0 },
      { epoch: 3, seq: 11, eventIndex: 1 },
      { epoch: 3, seq: 12, eventIndex: 0 },
    ]);
    expect(factoryArgs).toEqual(seen);
  });
});
