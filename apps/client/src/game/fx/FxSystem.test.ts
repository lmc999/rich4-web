// FxSystem（node，不渲染）：粒子上限按画质档封顶、棋盘层与屏幕层共用预算、clear() 全部回收；
// 爆炸 / 飞弹 / 核弹 / 光柱 / 光束 / 倒带的阻塞时长与 timings.ts 一致。
import { Container } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { AnimClock } from '../anim/AnimClock';
import { FxSystem } from './FxSystem';
import { radial } from './Particles';
import {
  FX_BEAM_MS,
  FX_EXPLODE_MS,
  FX_MISSILE_MS,
  FX_NUKE_MS,
  FX_PILLAR_MS,
  FX_REWIND_MS,
  PARTICLE_LIMITS,
} from './timings';

function setup(particles?: number) {
  const clock = new AnimClock();
  const overlay = new Container();
  const fxLayer = new Container();
  const fx = new FxSystem(overlay, fxLayer, clock, particles === undefined ? {} : { particles });
  return { clock, overlay, fxLayer, fx };
}

/** 以 16ms 步长推进时钟直到 promise 完成，返回用掉的时钟毫秒 */
async function drive(clock: AnimClock, p: Promise<unknown>, maxMs = 10_000): Promise<number> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  const t0 = clock.now();
  for (let t = 0; t < maxMs && !done; t += 16) {
    clock.advance(16);
    for (let k = 0; k < 6; k++) await Promise.resolve();
  }
  await p;
  return clock.now() - t0;
}

const many = (n: number) => radial(0, 0, n, { speed: [10, 20], life: [5000, 5000], size: [4, 4], colors: [0xffffff] });

describe('FxSystem 粒子上限', () => {
  it('高画质 400：超出的粒子不发', () => {
    const { fx } = setup();
    expect(fx.particleLimit).toBe(PARTICLE_LIMITS.high);
    expect(fx.particles.emit(many(300))).toBe(300);
    expect(fx.particles.emit(many(300))).toBe(100);
    expect(fx.particleCount).toBe(400);
    expect(fx.particles.emit(many(10))).toBe(0);
  });

  it('中画质 150、低画质 0（只保留关键闪光：爆炸仍然结束，但不发粒子）', async () => {
    const mid = setup(PARTICLE_LIMITS.mid);
    mid.fx.particles.emit(many(500));
    expect(mid.fx.particleCount).toBe(150);
    const low = setup(PARTICLE_LIMITS.low);
    const used = await drive(low.clock, low.fx.explosion({ x: 0, y: 0 }, 'big'));
    expect(low.fx.particleCount).toBe(0);
    expect(used).toBeGreaterThanOrEqual(FX_EXPLODE_MS - 16);
  });

  it('下调上限时立即回收超出的粒子；棋盘层与屏幕层共用同一个预算', () => {
    const { fx, clock } = setup();
    const screen = new Container();
    fx.attachScreen(screen, () => ({ width: 800, height: 600 }));
    fx.particles.emit(many(300));
    expect(fx.screenParticles?.emit(many(300))).toBe(100);
    expect(fx.particleCount).toBe(400);
    fx.setParticleLimit(PARTICLE_LIMITS.mid);
    expect(fx.particleCount).toBeLessThanOrEqual(PARTICLE_LIMITS.mid);
    // 寿命到了自动回收
    for (let i = 0; i < 400; i++) clock.advance(16);
    expect(fx.particleCount).toBe(0);
  });

  it('clear() 立即销毁全部特效与粒子', async () => {
    const { fx, clock, fxLayer } = setup();
    void fx.explosion({ x: 10, y: 10 }, 'small');
    void fx.lightPillar({ x: 0, y: 0 }, 0xffd84d, 600);
    clock.advance(16);
    expect(fx.count).toBeGreaterThan(0);
    expect(fx.particleCount).toBeGreaterThan(0);
    fx.clear();
    expect(fx.count).toBe(0);
    expect(fx.particleCount).toBe(0);
    expect(fxLayer.children.length).toBe(0);
  });

  it('中止 + clear() 之后，被中止的飞弹 / 核弹收尾不再新建闪白、粒子与节点', async () => {
    for (const kind of ['nuke', 'missile'] as const) {
      const { fx, clock } = setup();
      const screen = new Container();
      fx.attachScreen(screen, () => ({ width: 800, height: 600 }));
      const ac = new AbortController();
      const p = kind === 'nuke' ? fx.nuke({ x: 0, y: 0 }, 400, ac.signal) : fx.missile({ x: 0, y: 0 }, 180, ac.signal);
      for (let i = 0; i < 6; i++) clock.advance(16);
      // skipAll / reset 的顺序：abort → flushAll → clear()，handler 在之后的微任务里收尾
      ac.abort();
      clock.flushAll();
      fx.clear();
      await p;
      for (let k = 0; k < 10; k++) await Promise.resolve();
      expect(fx.count).toBe(0);
      expect(fx.particleCount).toBe(0);
      expect(screen.children.length).toBe(0);
    }
  });

  it('金币飞行中途中止并 clear()：不抛错（节点已销毁时直接收尾）', async () => {
    const { fx, clock } = setup();
    const ac = new AbortController();
    const p = fx.coinFlight({ x: 0, y: 0 }, { x: 200, y: 0 }, ac.signal);
    clock.advance(40);
    ac.abort();
    clock.flushAll();
    fx.clear();
    await expect(p).resolves.toBeUndefined();
    expect(fx.count).toBe(0);
  });

  it('instant 模式不发粒子，特效立即完成', async () => {
    const { fx, clock } = setup();
    clock.instant = true;
    await fx.missile({ x: 0, y: 0 }, 150);
    expect(fx.particleCount).toBe(0);
  });
});

describe('FxSystem 阻塞时长', () => {
  it('爆炸、飞弹、核弹、光柱、光束、倒带按 timings.ts', async () => {
    const cases: [number, (fx: FxSystem) => Promise<void>][] = [
      [FX_EXPLODE_MS, (fx) => fx.explosion({ x: 0, y: 0 }, 'small')],
      [FX_MISSILE_MS, (fx) => fx.missile({ x: 0, y: 0 }, 180)],
      [FX_NUKE_MS, (fx) => fx.nuke({ x: 0, y: 0 }, 400)],
      [FX_PILLAR_MS, (fx) => fx.lightPillar({ x: 0, y: 0 }, 0xffffff, FX_PILLAR_MS)],
      [FX_BEAM_MS, (fx) => fx.beam({ x: 0, y: 0 }, { x: 100, y: 50 }, 0xf2545b, FX_BEAM_MS)],
      [FX_REWIND_MS, (fx) => fx.rewind(FX_REWIND_MS, null)],
    ];
    for (const [ms, run] of cases) {
      const { fx, clock } = setup();
      const used = await drive(clock, run(fx));
      expect(used).toBeGreaterThanOrEqual(ms - 16);
      expect(used).toBeLessThanOrEqual(ms + 48);
      expect(fx.count).toBe(0);
    }
  });

  it('中止时立即结束（跳过演出直达终态）', async () => {
    const { fx, clock } = setup();
    const ac = new AbortController();
    const p = fx.nuke({ x: 0, y: 0 }, 400, ac.signal);
    clock.advance(16);
    ac.abort();
    const used = await drive(clock, p);
    expect(used).toBeLessThan(200);
  });
});
