// 测试用舞台（只在单测里使用）：记录调用；timed 模式下每个阻塞方法按 timings.ts 的常数在给定时钟上等待，
// 用来在假时钟下测 handler 的真实时长（handlers/budget.test.ts）。
import { STEP_MS, WALK_OUT, walkOutSwitchTick } from '@rich4/shared/view';
import type { AnimClock } from '../../game/anim/AnimClock';
import {
  FX_BEAM_MS,
  FX_BEGGAR_MOVE_MS,
  FX_BITE_MS,
  FX_BOMB_ATTACH_MS,
  FX_BOMB_PASS_MS,
  FX_CAST_MS,
  FX_DROP_MS,
  FX_ESCORT_MS,
  FX_EXPLODE_MS,
  FX_GOD_ARRIVE_MS,
  FX_GOD_LEAVE_MS,
  FX_GOD_POWER_MS,
  FX_GOD_SPAWN_MS,
  FX_MAGIC_MS,
  FX_MANIFEST_MS,
  FX_MISSILE_MS,
  FX_NUKE_MS,
  FX_PILLAR_MS,
  FX_RELEASE_MS,
  FX_REMOVE_MS,
  FX_REWIND_MS,
  FX_TELEPORT_MS,
  FX_VEHICLE_MS,
  FX_WRECK_MS,
  WALK_OUT_HOPS_MAX,
} from '../../game/fx/timings';
import type { StagePort, WalkOutOptions } from './stage';

export type StageCall = [string, ...unknown[]];

/** 记录调用的舞台；给出 clock 时阻塞方法按真实特效时长等待 */
export function recordingStage(calls: StageCall[], clock?: AnimClock): StagePort {
  const rec =
    (name: string, ms: number | ((...a: unknown[]) => number) = 0) =>
    (...a: unknown[]): Promise<void> => {
      const signal = a.find((x) => x instanceof AbortSignal) as AbortSignal | undefined;
      calls.push([name, ...a.filter((x) => !(x instanceof AbortSignal))]);
      const d = typeof ms === 'number' ? ms : ms(...a);
      return clock && d > 0 ? clock.wait(d, signal) : Promise.resolve();
    };
  const sync =
    (name: string) =>
    (...a: unknown[]): void => {
      calls.push([name, ...a]);
    };
  return {
    ready: true,
    syncWorld: (view) => {
      calls.push(['syncWorld', view.objects.length]);
    },
    clear: sync('clear'),
    dropObject: rec('dropObject', FX_DROP_MS),
    removeObject: rec('removeObject', FX_REMOVE_MS),
    dollWalk: rec('dollWalk', (path) => Math.max(0, (path as unknown[]).length - 1) * STEP_MS),
    explode: rec('explode', FX_EXPLODE_MS),
    strike: rec('strike', (kind) => (kind === 'nuke' ? FX_NUKE_MS : FX_MISSILE_MS)),
    pillar: rec('pillar', FX_PILLAR_MS),
    beam: rec('beam', FX_BEAM_MS),
    flash: sync('flash'),
    rewind: rec('rewind', FX_REWIND_MS),
    burst: sync('burst'),
    bubble: sync('bubble'),
    teleport: rec('teleport', FX_TELEPORT_MS),
    cast: rec('cast', FX_CAST_MS),
    fireworks: sync('fireworks'),
    godSpawn: rec('godSpawn', FX_GOD_SPAWN_MS),
    godArrive: rec('godArrive', FX_GOD_ARRIVE_MS),
    godLeave: rec('godLeave', FX_GOD_LEAVE_MS),
    godPower: rec('godPower', FX_GOD_POWER_MS),
    manifest: rec('manifest', FX_MANIFEST_MS),
    dogBite: rec('dogBite', FX_BITE_MS),
    escort: rec('escort', FX_ESCORT_MS),
    release: rec('release', FX_RELEASE_MS),
    // 走出建筑：按两种皮肤里较长的一种（原版皮肤最远的 tick 数 × tick，程序化最多跳 WALK_OUT_HOPS_MAX 下），过半时 onShow
    walkOut: async (seat, from, o, signal) => {
      calls.push(['walkOut', seat, from]);
      const ticks = from === 'hotel' ? WALK_OUT.hotelMaxTicks : WALK_OUT.maxTicks;
      const total = Math.max(ticks * o.tickMs, WALK_OUT_HOPS_MAX * STEP_MS);
      const at = Math.min(total, walkOutSwitchTick(ticks) * o.tickMs);
      if (clock && at > 0) await clock.wait(at, signal);
      o.onShow?.();
      if (clock && total > at) await clock.wait(total - at, signal);
    },
    holdInside: sync('holdInside'),
    walkIn: (seat, lot, o: WalkOutOptions, signal) => {
      calls.push(['walkIn', seat, lot]);
      const total = Math.max(WALK_OUT.hotelMaxTicks * o.tickMs, WALK_OUT_HOPS_MAX * STEP_MS);
      return clock ? clock.wait(total, signal) : Promise.resolve();
    },
    vehicle: rec('vehicle', FX_VEHICLE_MS),
    wreck: rec('wreck', FX_WRECK_MS),
    bombAttach: rec('bombAttach', FX_BOMB_ATTACH_MS),
    bombPass: rec('bombPass', FX_BOMB_PASS_MS),
    magic: rec('magic', FX_MAGIC_MS),
    beggarMove: rec('beggarMove', FX_BEGGAR_MOVE_MS),
    walkVillain: rec('walkVillain', (_k, path) => Math.max(0, (path as unknown[]).length - 1) * STEP_MS),
    villainAnchor: (kind) => ({ tile: kind === 'thief' ? 3 : 5 }),
  };
}
