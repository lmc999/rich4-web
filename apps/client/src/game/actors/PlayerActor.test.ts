import { buildTestMapAllKinds } from '@rich4/shared/data';
import { describe, expect, it } from 'vitest';
import { AnimClock } from '../anim/AnimClock';
import { BoardGeometry } from '../board/BoardGeometry';
import { DepthBias, depthOfCell } from '../iso/depth';
import { PlayerActor, planWalk, STEP_MS } from './PlayerActor';

const def = buildTestMapAllKinds();

function setup() {
  const geo = new BoardGeometry(def, 0);
  const clock = new AnimClock();
  // 名牌需要 Canvas 测量文字，node 下不设名字
  const actor = new PlayerActor({ seat: 1, geo, clock });
  return { geo, clock, actor };
}

/** 以 16ms 步长推进，直到 promise 完成（最多 n 步） */
async function run(clock: AnimClock, p: Promise<void>, maxSteps = 1000): Promise<number> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  let real = 0;
  for (let i = 0; i < maxSteps && !done; i++) {
    clock.advance(16);
    real += 16;
    // 让 walk 在子段之间的 await 续体跑完，再推进下一帧
    for (let k = 0; k < 6; k++) await Promise.resolve();
  }
  await p;
  return real;
}

describe('planWalk', () => {
  it('via 长边展开为逐格子段，时长仍为一步', () => {
    const geo = new BoardGeometry(def, 0);
    const steps = planWalk(geo, [21, 22, 23, 24]);
    expect(steps.map((s) => `${s.to.x},${s.to.y}`)).toEqual(['10,3', '11,3', '12,3', '13,3', '14,3']);
    expect(steps.filter((s) => s.arrive).map((s) => s.pathIndex)).toEqual([1, 2, 3]);
    const share22to23 = steps.filter((s) => s.pathIndex === 2).reduce((a, s) => a + s.share, 0);
    expect(share22to23).toBeCloseTo(1, 9);
  });
});

describe('PlayerActor 销毁', () => {
  it('行走中销毁：共享时钟继续推进不抛错，中止后 walk 正常结束', async () => {
    const { clock, actor } = setup();
    const errors: unknown[] = [];
    clock.onError = (e) => errors.push(e);
    actor.teleport(8);
    const ac = new AbortController();
    let done = false;
    void actor.walk([8, 9, 10, 11], { signal: ac.signal }).then(() => {
      done = true;
    });
    clock.advance(16);
    actor.destroy();
    expect(actor.destroyed).toBe(true);
    for (let i = 0; i < 5; i++) clock.advance(16);
    ac.abort();
    for (let k = 0; k < 6; k++) await Promise.resolve();
    expect(done).toBe(true);
    expect(errors).toEqual([]);
    // 重复 destroy 无害；销毁后的 teleport / setPose 是空操作
    actor.destroy();
    actor.teleport(9);
    actor.setPose('walk1');
  });
});

describe('PlayerActor.walk', () => {
  it('逐格行走：onStep 按顺序回调、终点在格中心、深度随格更新', async () => {
    const { clock, actor, geo } = setup();
    actor.teleport(8);
    const seen: number[] = [];
    const real = await run(
      clock,
      actor.walk([8, 9, 10, 11], {
        onStep: (t) => {
          seen.push(t);
        },
      }),
    );
    expect(seen).toEqual([9, 10, 11]);
    expect(actor.tile).toBe(11);
    expect(actor.isWalking).toBe(false);
    const c = geo.tileCell(11);
    expect(actor.logicalPos).toEqual({ x: c.x + 0.5, y: c.y + 0.5 });
    expect(actor.root.zIndex).toBeCloseTo(depthOfCell(geo.viewCell(c), DepthBias.Actor) + 0.01, 9);
    expect(real).toBeGreaterThanOrEqual(3 * STEP_MS);
    expect(real).toBeLessThan(3 * STEP_MS + 100);
    expect(actor.currentPose).toBe('idle0');
  });

  it('经过 via 连接格', async () => {
    const { clock, actor } = setup();
    actor.teleport(21);
    const seen: number[] = [];
    await run(clock, actor.walk([21, 22, 23, 24], { onStep: (t) => void seen.push(t) }));
    expect(seen).toEqual([22, 23, 24]);
    expect(actor.tile).toBe(24);
  });

  it('时长与预算一致：经过 via 连接格、帧间隔很粗时也不会逐段累积误差', async () => {
    const { clock, actor } = setup();
    actor.teleport(21);
    const seen: number[] = [];
    let done = false;
    const p = actor.walk([21, 22, 23, 24], { onStep: (t) => void seen.push(t) }).then(() => {
      done = true;
    });
    let real = 0;
    while (!done && real < 5000) {
      clock.advance(100);
      real += 100;
      for (let k = 0; k < 6; k++) await Promise.resolve();
    }
    await p;
    expect(seen).toEqual([22, 23, 24]);
    // 3 步 × 180ms = 540ms：粗帧下最多多出一帧
    expect(real).toBeLessThanOrEqual(3 * STEP_MS + 100);
  });

  it('中止：立即落到终点并 resolve', async () => {
    const { clock, actor } = setup();
    actor.teleport(1);
    const ac = new AbortController();
    const p = actor.walk([1, 2, 3, 4, 5, 6], { signal: ac.signal });
    clock.advance(STEP_MS + 10);
    await Promise.resolve();
    ac.abort();
    await p;
    expect(actor.tile).toBe(6);
    expect(actor.isWalking).toBe(false);
    expect(clock.activeFrames).toBe(1); // 只剩待机动画的帧回调
  });

  it('倍速 2：一半真实时间走完', async () => {
    const { clock, actor } = setup();
    clock.speed = 2;
    actor.teleport(1);
    const real = await run(clock, actor.walk([1, 2, 3, 4, 5]));
    expect(real).toBeLessThan(4 * STEP_MS * 0.5 + 64);
    expect(actor.tile).toBe(5);
  });

  it('朝向：视图 +x 为 SE；旋转后 relayout 位置随之变化', async () => {
    const { clock, actor, geo } = setup();
    actor.teleport(1);
    const p = actor.walk([1, 2]);
    clock.advance(20);
    expect(actor.facing).toBe('SE');
    await run(clock, p);
    const before = actor.screenPos();
    geo.setRotation(1);
    actor.relayout();
    expect(actor.screenPos()).not.toEqual(before);
    expect(actor.screenPos()).toEqual(geo.tileScreenPos(2));
  });

  it('teleport 与 hop', async () => {
    const { clock, actor, geo } = setup();
    actor.teleport(15);
    expect(actor.screenPos()).toEqual(geo.tileScreenPos(15));
    await run(clock, actor.hop());
    expect(actor.screenPos()).toEqual(geo.tileScreenPos(15));
    actor.destroy();
    expect(clock.activeFrames).toBe(0);
  });
});
