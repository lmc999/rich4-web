import { describe, expect, it } from 'vitest';
import { AnimClock } from './AnimClock';
import { backOut, EASINGS, hopArc, linear, quadOut } from './easing';
import { tween, tweenValue } from './tween';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('AnimClock / tween：帧回调出错不拖垮时钟', () => {
  it('抛错的帧回调只注销自己并报告；其他回调与到期的 wait 照常执行', async () => {
    const c = new AnimClock();
    const errors: unknown[] = [];
    c.onError = (e) => errors.push(e);
    let ok = 0;
    c.onFrame(() => {
      throw new TypeError("Cannot read properties of null (reading 'set')");
    });
    c.onFrame(() => {
      ok++;
    });
    let waited = false;
    void c.wait(10).then(() => {
      waited = true;
    });
    expect(() => c.advance(16)).not.toThrow();
    await flush();
    expect(waited).toBe(true);
    expect(errors).toHaveLength(1);
    expect(c.activeFrames).toBe(1);
    c.advance(16);
    expect(ok).toBe(2);
    expect(errors).toHaveLength(1);
  });

  it('补间写入抛错（目标已销毁）：补间结束并 resolve，等待者不会挂起', async () => {
    const c = new AnimClock();
    c.onError = () => {};
    let destroyed = false;
    let settled = false;
    void tweenValue(
      0,
      1,
      100,
      () => {
        if (destroyed) throw new Error('missing frame tangtang/walk3/back');
      },
      { clock: c },
    ).then(() => {
      settled = true;
    });
    c.advance(16);
    destroyed = true;
    c.advance(16);
    await flush();
    expect(settled).toBe(true);
    expect(c.activeFrames).toBe(0);
  });

  it('中止时写终值抛错也照样 resolve', async () => {
    const c = new AnimClock();
    const ac = new AbortController();
    let settled = false;
    let destroyed = false;
    const errSpy = console.error;
    console.error = () => {};
    try {
      void tweenValue(
        0,
        1,
        100,
        () => {
          if (destroyed) throw new Error('destroyed');
        },
        { clock: c, signal: ac.signal },
      ).then(() => {
        settled = true;
      });
      c.advance(16);
      destroyed = true;
      ac.abort();
      await flush();
    } finally {
      console.error = errSpy;
    }
    expect(settled).toBe(true);
    expect(c.activeFrames).toBe(0);
  });
});

describe('AnimClock', () => {
  it('wait 在时钟推进到期后 resolve，按到期先后', async () => {
    const c = new AnimClock();
    const order: string[] = [];
    void c.wait(200).then(() => order.push('b'));
    void c.wait(100).then(() => order.push('a'));
    c.advance(150);
    await flush();
    expect(order).toEqual(['a']);
    c.advance(60);
    await flush();
    expect(order).toEqual(['a', 'b']);
    expect(c.pendingWaits).toBe(0);
  });

  it('倍速：speed=3 时 300ms 的等待只需 100ms 真实时间', async () => {
    const c = new AnimClock();
    c.speed = 3;
    let done = false;
    void c.wait(300).then(() => {
      done = true;
    });
    c.advance(99);
    await flush();
    expect(done).toBe(false);
    c.advance(1);
    await flush();
    expect(done).toBe(true);
    expect(c.now()).toBe(300);
  });

  it('中止与 instant 立即 resolve（不 reject）', async () => {
    const c = new AnimClock();
    const ac = new AbortController();
    const p = c.wait(10_000, ac.signal);
    ac.abort();
    await expect(p).resolves.toBeUndefined();
    expect(c.pendingWaits).toBe(0);
    c.instant = true;
    await expect(c.wait(10_000)).resolves.toBeUndefined();
  });

  it('flushAll 完成所有等待', async () => {
    const c = new AnimClock();
    const ps = [c.wait(100), c.wait(5000)];
    c.flushAll();
    await Promise.all(ps);
    expect(c.pendingWaits).toBe(0);
  });

  it('非法倍速抛错；非正 dt 不推进', () => {
    const c = new AnimClock();
    expect(() => {
      c.speed = 0;
    }).toThrow(RangeError);
    expect(c.advance(-5)).toBe(0);
    expect(c.now()).toBe(0);
  });
});

describe('tween', () => {
  it('线性补间到终值并注销帧回调', async () => {
    const c = new AnimClock();
    const o = { x: 0, y: 10 };
    const p = tween(o, { x: 100, y: 20 }, 200, { clock: c });
    c.advance(100);
    expect(o.x).toBeCloseTo(50, 6);
    expect(o.y).toBeCloseTo(15, 6);
    c.advance(100);
    await p;
    expect(o).toEqual({ x: 100, y: 20 });
    expect(c.activeFrames).toBe(0);
  });

  it('中止时直接跳到终值', async () => {
    const c = new AnimClock();
    const o = { x: 0 };
    const ac = new AbortController();
    const p = tween(o, { x: 42 }, 1000, { clock: c, signal: ac.signal });
    c.advance(10);
    ac.abort();
    await p;
    expect(o.x).toBe(42);
    expect(c.activeFrames).toBe(0);
  });

  it('已中止的 signal 与 instant 模式同步落到终值', async () => {
    const c = new AnimClock();
    const ac = new AbortController();
    ac.abort();
    const o = { x: 0 };
    await tween(o, { x: 5 }, 500, { clock: c, signal: ac.signal });
    expect(o.x).toBe(5);
    c.instant = true;
    const vals: number[] = [];
    await tweenValue(0, 9, 500, (v) => vals.push(v), { clock: c });
    expect(vals).toEqual([9]);
  });

  it('倍速 2：一半真实时间完成', async () => {
    const c = new AnimClock();
    c.speed = 2;
    const o = { x: 0 };
    let done = false;
    const p = tween(o, { x: 1 }, 400, { clock: c }).then(() => {
      done = true;
    });
    c.advance(150);
    await flush();
    expect(done).toBe(false);
    c.advance(50);
    await p;
    expect(done).toBe(true);
  });

  it('缓动函数端点正确', () => {
    for (const [name, e] of Object.entries(EASINGS)) {
      expect(e(0), name).toBeCloseTo(0, 6);
      expect(e(1), name).toBeCloseTo(1, 6);
    }
    expect(hopArc(0.5)).toBe(1);
    expect(hopArc(0)).toBe(0);
    expect(quadOut(0.5)).toBeGreaterThan(linear(0.5));
    // backOut 中途冲过终点
    expect(Math.max(...[0.6, 0.7, 0.8, 0.9].map(backOut))).toBeGreaterThan(1);
  });
});
