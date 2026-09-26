import { describe, expect, it } from 'vitest';
import { AnimClock } from '../anim/AnimClock';
import { Camera, MAX_ZOOM, MIN_ZOOM, type Transformable, USER_PAUSE_MS } from './Camera';

function fakeTarget(): Transformable {
  const pt = () => {
    const p = {
      x: 0,
      y: 0,
      set(x: number, y?: number) {
        p.x = x;
        p.y = y ?? x;
      },
    };
    return p;
  };
  return { position: pt(), scale: pt() };
}

function setup(w = 800, h = 600) {
  const target = fakeTarget();
  const clock = new AnimClock();
  const cam = new Camera(target, { w, h }, clock);
  return { target, clock, cam };
}

describe('Camera 坐标换算', () => {
  it('center 显示在有效可视区中心（扣除 HUD insets），往返一致', () => {
    const { cam, target } = setup();
    cam.setInsets({ right: 200, top: 50 });
    cam.lookAt({ x: 100, y: 40 });
    const a = cam.screenAnchor();
    expect(a).toEqual({ x: 300, y: 325 });
    expect(cam.worldToScreen({ x: 100, y: 40 })).toEqual(a);
    cam.setZoom(1.5);
    const w = { x: 37, y: -12 };
    const back = cam.screenToWorld(cam.worldToScreen(w));
    expect(back.x).toBeCloseTo(w.x, 9);
    expect(back.y).toBeCloseTo(w.y, 9);
    // 目标容器变换与换算一致：screen = position + world * scale
    const s = cam.worldToScreen(w);
    expect(target.position.x + w.x * target.scale.x).toBeCloseTo(s.x, 9);
    expect(target.position.y + w.y * target.scale.y).toBeCloseTo(s.y, 9);
  });

  it('以指针为锚缩放：锚点下的世界点不动', () => {
    const { cam } = setup();
    cam.lookAt({ x: 0, y: 0 });
    const anchor = { x: 650, y: 120 };
    const before = cam.screenToWorld(anchor);
    cam.setZoom(1.6, anchor);
    const after = cam.screenToWorld(anchor);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('缩放夹在 [minZoom, maxZoom]', () => {
    const { cam } = setup();
    cam.setZoom(99);
    expect(cam.zoom).toBe(MAX_ZOOM);
    cam.setZoom(0.01);
    expect(cam.zoom).toBe(MIN_ZOOM);
  });

  it('大地图 fitAll 会放宽最小缩放并完整装入可视区', async () => {
    const { cam } = setup(1280, 720);
    cam.setInsets({ right: 260 });
    const bounds = { x: -3392, y: -160, w: 6272, h: 3296 };
    cam.setBounds(bounds);
    await cam.fitAll();
    expect(cam.zoom).toBeLessThan(MIN_ZOOM);
    expect(cam.minZoom).toBeLessThanOrEqual(cam.zoom);
    const tl = cam.worldToScreen({ x: bounds.x, y: bounds.y });
    const br = cam.worldToScreen({ x: bounds.x + bounds.w, y: bounds.y + bounds.h });
    const e = cam.effectiveViewport();
    expect(tl.x).toBeGreaterThanOrEqual(e.x);
    expect(tl.y).toBeGreaterThanOrEqual(e.y);
    expect(br.x).toBeLessThanOrEqual(e.x + e.w);
    expect(br.y).toBeLessThanOrEqual(e.y + e.h);
    expect(cam.center).toEqual({ x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 });
  });

  it('镜头中心被限制在 bounds 内', () => {
    const { cam } = setup();
    cam.setBounds({ x: 0, y: 0, w: 100, h: 100 });
    cam.lookAt({ x: 5000, y: -5000 });
    expect(cam.center).toEqual({ x: 100, y: 0 });
  });
});

describe('Camera 跟随、手势、惯性', () => {
  it('跟随与帧率无关：6×16.67ms ≈ 1×100ms', () => {
    const a = setup();
    const b = setup();
    const target = () => ({ x: 1000, y: 500 });
    a.cam.follow(target, 0.12);
    b.cam.follow(target, 0.12);
    for (let i = 0; i < 6; i++) a.cam.update(100 / 6);
    b.cam.update(100);
    expect(a.cam.center.x).toBeCloseTo(b.cam.center.x, 6);
    expect(a.cam.center.y).toBeCloseTo(b.cam.center.y, 6);
    expect(a.cam.center.x).toBeGreaterThan(0);
    expect(a.cam.center.x).toBeLessThan(1000);
  });

  it('手动拖动后暂停跟随 4 秒', () => {
    const { cam } = setup();
    cam.follow(() => ({ x: 1000, y: 0 }));
    cam.panBy(10, 0);
    const x0 = cam.center.x;
    cam.update(USER_PAUSE_MS - 100);
    expect(cam.followPaused).toBe(true);
    expect(cam.center.x).toBe(x0);
    cam.update(200);
    expect(cam.followPaused).toBe(false);
    cam.update(16);
    expect(cam.center.x).toBeGreaterThan(x0);
  });

  it('甩动产生惯性并逐渐停下', () => {
    const { cam } = setup();
    cam.fling(1, 0);
    const x0 = cam.center.x;
    cam.update(16);
    const x1 = cam.center.x;
    expect(x1).toBeLessThan(x0);
    for (let i = 0; i < 400; i++) cam.update(16);
    expect(cam.velocity).toEqual({ x: 0, y: 0 });
    const x2 = cam.center.x;
    cam.update(16);
    expect(cam.center.x).toBe(x2);
  });

  it('震屏结束后偏移归零', () => {
    const { cam, target } = setup();
    cam.lookAt({ x: 0, y: 0 });
    const p0 = { x: target.position.x, y: target.position.y };
    cam.shake(10, 200);
    cam.update(50);
    expect(target.position.x !== p0.x || target.position.y !== p0.y).toBe(true);
    cam.update(200);
    expect(target.position).toMatchObject(p0);
  });
});

describe('Camera 动画（AnimClock 驱动）', () => {
  it('panTo 按时钟推进，倍速 2 时一半真实时间完成', async () => {
    const { cam, clock } = setup();
    clock.speed = 2;
    let done = false;
    const p = cam.panTo({ x: 200, y: 100 }, 400).then(() => {
      done = true;
    });
    clock.advance(100);
    await Promise.resolve();
    expect(done).toBe(false);
    expect(cam.center.x).toBeGreaterThan(0);
    clock.advance(101);
    await p;
    expect(done).toBe(true);
    expect(cam.center).toEqual({ x: 200, y: 100 });
  });

  it('中止即直达终点', async () => {
    const { cam, clock } = setup();
    const ac = new AbortController();
    const p = cam.zoomTo(1.5, 1000, undefined, ac.signal);
    clock.advance(100);
    ac.abort();
    await p;
    expect(cam.zoom).toBe(1.5);
  });

  it('动画期间不被跟随抢镜头', async () => {
    const { cam, clock } = setup();
    cam.follow(() => ({ x: -1000, y: -1000 }));
    const p = cam.panTo({ x: 300, y: 0 }, 100);
    clock.advance(50);
    cam.update(50);
    const mid = cam.center.x;
    expect(mid).toBeGreaterThan(0);
    clock.advance(60);
    await p;
    expect(cam.center.x).toBe(300);
  });
});

describe('Camera.dispose', () => {
  it('棋盘销毁后共享时钟上的镜头补间不再写 target（target 已销毁时写入会抛错）', async () => {
    const { cam, clock, target } = setup();
    const errors: unknown[] = [];
    clock.onError = (e) => errors.push(e);
    let settled = false;
    void cam.zoomTo(2, 600).then(() => {
      settled = true;
    });
    clock.advance(16);
    cam.dispose();
    const boom = () => {
      throw new TypeError("Cannot read properties of null (reading 'set')");
    };
    target.scale.set = boom;
    target.position.set = boom;
    for (let i = 0; i < 50; i++) clock.advance(16);
    for (let k = 0; k < 6; k++) await Promise.resolve();
    expect(errors).toEqual([]);
    expect(settled).toBe(true);
    await expect(cam.panTo({ x: 1, y: 1 }, 300)).resolves.toBeUndefined();
  });
});
