// FlicPlayer 与 playFit：由动画时钟驱动、逐帧呈现到复用缓冲、按预算加速 / 截取 / 跳帧、循环、中止落终态、instant 直达终态
import { describe, expect, it, vi } from 'vitest';
import { AnimClock } from '../../game/anim/AnimClock';
import { CanvasFrameSink, type FlicFrameSink, FlicPlayer } from './FlicPlayer';
import { evenFrames, planFit } from './fit';
import { buildFlc, randomPalette, type SynthFrame } from './testing/flcBuilder';

const W = 8;
const H = 6;

/** n 帧、帧 i 全部像素为 i+1（索引 0 留给透明） */
function flcBytes(n: number, speed = 100): Uint8Array {
  const pal = randomPalette(5);
  const frames: SynthFrame[] = Array.from({ length: n }, (_, i) => ({
    pixels: new Uint8Array(W * H).fill(i + 1),
    ...(i === 0 ? { palette: pal } : {}),
    encoding: i === 0 ? 'byterun' : 'delta',
  }));
  return buildFlc({ width: W, height: H, speed, frames, ring: true });
}

class RecordingSink implements FlicFrameSink {
  readonly frames: number[] = [];
  readonly times: number[] = [];
  lastRgba: Uint8ClampedArray | null = null;
  constructor(private readonly clock: AnimClock) {}
  present(rgba: Uint8ClampedArray, _w: number, _h: number, frame: number): void {
    this.frames.push(frame);
    this.times.push(this.clock.now());
    this.lastRgba = rgba;
  }
}

/** 以固定步长推进时钟直到 promise 完成 */
async function drive(clock: AnimClock, p: Promise<unknown>, step = 10, max = 100_000): Promise<void> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  for (let t = 0; t < max && !done; t += step) {
    clock.advance(step);
    await Promise.resolve();
    await Promise.resolve();
  }
  await p;
}

describe('planFit（design-draft §3.5）', () => {
  it('原长不超过预算：原速全部帧', () => {
    const p = planFit({ frames: 10, frameMs: 100 }, 1000);
    expect(p).toMatchObject({ speed: 1, frameMs: 100, trimmed: false, skipped: false, durationMs: 1000 });
    expect(p.frames).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('超出预算：加速，上限 2×', () => {
    const p = planFit({ frames: 10, frameMs: 100 }, 800);
    expect(p.speed).toBeCloseTo(1.25);
    expect(p.frameMs).toBeCloseTo(80);
    expect(p.frames).toHaveLength(10);
    expect(p.durationMs).toBeCloseTo(800);
    expect(planFit({ frames: 10, frameMs: 100 }, 500).speed).toBe(2);
  });

  it('2× 仍超出：按 trim 截取（截取段再加速）', () => {
    const p = planFit({ frames: 62, frameMs: 100, trim: { startFrame: 0, endFrame: 20 } }, 1500);
    expect(p.trimmed).toBe(true);
    expect(p.skipped).toBe(false);
    expect(p.frames).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(p.durationMs).toBeCloseTo(1500);
    const q = planFit({ frames: 62, frameMs: 100, trim: { startFrame: 10, endFrame: 20 } }, 1500);
    expect(q).toMatchObject({ trimmed: true, speed: 1, frameMs: 100 });
    expect(q.frames[0]).toBe(10);
  });

  it('截取后仍超出（或没有 trim）：均匀跳帧，保留首尾，恰好摊满预算', () => {
    const p = planFit({ frames: 62, frameMs: 100 }, 1500);
    expect(p.skipped).toBe(true);
    expect(p.frames).toHaveLength(30);
    expect(p.frames[0]).toBe(0);
    expect(p.frames.at(-1)).toBe(61);
    expect(p.durationMs).toBeCloseTo(1500);
    expect(p.frameMs).toBeCloseTo(50);
    const q = planFit({ frames: 62, frameMs: 100, trim: { startFrame: 5, endFrame: 45 } }, 1000);
    expect(q).toMatchObject({ trimmed: true, skipped: true });
    expect(q.frames[0]).toBe(5);
    expect(q.frames.at(-1)).toBe(44);
    expect(q.frames).toHaveLength(20);
  });

  it('预算为 0：只落终帧；maxSpeed 可调；非法 trim 忽略', () => {
    expect(planFit({ frames: 5, frameMs: 100 }, 0)).toMatchObject({ frames: [4], durationMs: 0 });
    expect(planFit({ frames: 10, frameMs: 100 }, 300, { maxSpeed: 4 }).speed).toBeCloseTo(10 / 3);
    const p = planFit({ frames: 10, frameMs: 100, trim: { startFrame: 8, endFrame: 3 } }, 200);
    expect(p.trimmed).toBe(false);
    expect(p.skipped).toBe(true);
    expect(evenFrames(0, 10, 1)).toEqual([9]);
    expect(evenFrames(3, 5, 9)).toEqual([3, 4]);
  });
});

describe('FlicPlayer', () => {
  it('play：按帧间隔逐帧呈现到同一块 RGBA 缓冲；首帧触发 onStart；结束停在末帧', async () => {
    const clock = new AnimClock();
    const sink = new RecordingSink(clock);
    let starts = 0;
    const presented: number[] = [];
    const p = new FlicPlayer(flcBytes(5), { clock, sink, onStart: () => starts++, onFrame: (f) => presented.push(f) });
    expect(p.frames).toBe(5);
    expect(p.durationMs).toBe(500);
    await drive(clock, p.play());
    expect(sink.frames).toEqual([0, 1, 2, 3, 4]);
    expect(presented).toEqual([0, 1, 2, 3, 4]);
    expect(sink.times).toEqual([0, 100, 200, 300, 400]);
    expect(starts).toBe(1);
    expect(p.currentFrame).toBe(4);
    // 帧 4 的像素是索引 5，不透明
    const rgba = sink.lastRgba!;
    expect(rgba).toBe(p.pixels);
    expect(rgba[3]).toBe(255);
  });

  it('loop：循环播放直到中止', async () => {
    const clock = new AnimClock();
    const sink = new RecordingSink(clock);
    const p = new FlicPlayer(flcBytes(3), { clock, sink });
    const ac = new AbortController();
    const run = p.play({ loop: true, signal: ac.signal });
    for (let i = 0; i < 80; i++) {
      clock.advance(10);
      await Promise.resolve();
      await Promise.resolve();
    }
    ac.abort();
    await run;
    expect(sink.frames.slice(0, 7)).toEqual([0, 1, 2, 0, 1, 2, 0]);
  });

  it('playFit：超预算时加速到恰好预算，中止时直接落到终态', async () => {
    const clock = new AnimClock();
    const sink = new RecordingSink(clock);
    const p = new FlicPlayer(flcBytes(10), { clock, sink });
    const run = p.playFit(800);
    await drive(clock, run, 5);
    const plan = await run;
    expect(plan.speed).toBeCloseTo(1.25);
    expect(sink.frames).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(sink.times[9]).toBeCloseTo(720, 0);

    const sink2 = new RecordingSink(clock);
    const q = new FlicPlayer(flcBytes(10), { clock, sink: sink2 });
    const ac = new AbortController();
    const run2 = q.playFit(10_000, { signal: ac.signal });
    clock.advance(150);
    await Promise.resolve();
    ac.abort();
    await run2;
    expect(sink2.frames.at(-1)).toBe(9);
    expect(q.currentFrame).toBe(9);
  });

  it('instant 时钟：不播放、不发同步音效，直接落到终态', async () => {
    const clock = new AnimClock();
    clock.instant = true;
    const sink = new RecordingSink(clock);
    let starts = 0;
    const p = new FlicPlayer(flcBytes(6), { clock, sink, onStart: () => starts++ });
    await p.playFit(300);
    expect(sink.frames).toEqual([5]);
    expect(starts).toBe(0);
    await p.play({ loop: true });
    expect(p.currentFrame).toBe(5);
  });

  it('opaque：索引 0 也按调色板不透明；缺省 sink 在无 DOM 环境报错', () => {
    const clock = new AnimClock();
    const sink = new RecordingSink(clock);
    const frames: SynthFrame[] = [{ pixels: new Uint8Array(W * H), palette: randomPalette(2), encoding: 'byterun' }];
    const bytes = buildFlc({ width: W, height: H, speed: 50, frames });
    const t = new FlicPlayer(bytes, { clock, sink });
    t.show(0);
    expect(sink.lastRgba![3]).toBe(0);
    const o = new FlicPlayer(bytes, { clock, sink, opaque: true });
    o.show(0);
    expect(sink.lastRgba![3]).toBe(255);
    expect(() => new FlicPlayer(bytes, { clock })).toThrow();
  });
});

describe('FlicPlayer.destroy：释放内存', () => {
  class FakeCanvas {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext() {
      return { putImageData: () => {} };
    }
  }

  it('释放 RGBA 与解码器；播放器自己建的画布宽高置 0；之后的 show 不做事', () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    vi.stubGlobal(
      'ImageData',
      class {
        constructor(
          public data: Uint8ClampedArray,
          public width: number,
          public height: number,
        ) {}
      },
    );
    try {
      const p = new FlicPlayer(flcBytes(3), { clock: new AnimClock() });
      p.show(1);
      const canvas = p.canvas as unknown as FakeCanvas;
      expect([canvas.width, canvas.height]).toEqual([W, H]);
      expect(p.pixels.length).toBe(W * H * 4);
      p.destroy();
      expect(p.isDestroyed).toBe(true);
      expect([canvas.width, canvas.height]).toEqual([0, 0]);
      expect(p.pixels.length).toBe(0);
      p.show(2);
      expect(p.currentFrame).toBe(1);
      p.destroy(); // 幂等

      // 调用方传入的画布由调用方负责：release 不改它的尺寸
      const own = new FakeCanvas(1, 1);
      const sink = new CanvasFrameSink(W, H, own as unknown as OffscreenCanvas);
      sink.release();
      expect([own.width, own.height]).toEqual([W, H]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('自定义 sink：destroy 不碰 sink，只释放播放器自己的缓冲', async () => {
    const frames: number[] = [];
    const sink: FlicFrameSink = { present: (_rgba, _w, _h, f) => void frames.push(f) };
    const p = new FlicPlayer(flcBytes(3), { clock: new AnimClock(), sink });
    p.show(0);
    p.destroy();
    expect(p.pixels.length).toBe(0);
    await p.play();
    expect(frames).toEqual([0]);
  });
});
