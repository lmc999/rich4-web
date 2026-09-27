// 真实引擎载荷 × 原版舞台（A8；参照 presentation/handlers/realEngine.test.ts）：原版 AI 在 test-allkinds 上自对弈，
// 按座位 0 的视角投影出事件，逐个交给未封顶的 handler，棋盘舞台换成真的 OrigStage（假棋盘 + 合成 FLIC，帧数与帧间隔同原版）：
// - 两种演出节奏下逐事件执行都不抛错；
// - 自然用时 ≤ 当前节奏的 EVENT_BUDGET_MS（与 EventPlayer 同一容差）；
// - 确实播到了原版 FLIC（神明降临、警车 / 救护车、爆炸、得卡得点券……），同步音效经 ctx.audio 放出。
import { fixtureRegistry } from '@rich4/shared/data';
import type { GameEvent, GameState } from '@rich4/shared/engine';
import { newGame } from '@rich4/shared/engine-testing';
import { PACING_PROFILES } from '@rich4/shared/view';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../../../i18n';
import { BUDGET_TOLERANCE } from '../../../presentation/EventPlayer';
import { setPacingOverride } from '../../../presentation/handlers/budget';
import { aiAction, defaultAction, type Sample, samplesOf, tagOf, viewOf } from '../../../test/realEngineHarness';
import { usePopupStore } from '../../../ui/popups/popupStore';
import { buildFakeFlicPack } from './testing/fakeFlics';
import { StageBench } from './testing/stageBench';

beforeAll(() => {
  initI18n('original');
});

afterEach(() => {
  setPacingOverride(null);
  usePopupStore.getState().clear();
});

const MAP_ID = 'test-allkinds';
const map = fixtureRegistry.getMap(MAP_ID);

/** 有原版 FLIC 或原版精灵演出的事件多抽一些样本，其余每种只抽前几条 */
const FOCUS = new Set<string>([
  'GOD_ATTACHED',
  'GOD_LEFT',
  'GOD_SPAWNED',
  'GOD_POWER',
  'GOD_MANIFEST',
  'DOG_BITE',
  'DOG_KNOCKED',
  'CONFINED',
  'RELEASED',
  'BAIL',
  'BOMB_ATTACHED',
  'BOMB_TRANSFERRED',
  'BOMB_EXPLODED',
  'STRIKE',
  'OBJECT_PLACED',
  'OBJECT_REMOVED',
  'DOLL_WALK',
  'VEHICLE',
  'VEHICLE_DESTROYED',
  'CARD_GAINED',
  'POINTS_GAINED',
  'HOLIDAY',
  'BANKRUPT',
  'PARACHUTE',
  'TELEPORTED',
  'CARD_USED',
  'ITEM_USED',
  'MAGIC_CONDITION',
  'MAGIC_CAST',
  'VILLAIN_ACTION',
  'BEGGAR_ALMS',
  'MOVE_SEGMENT',
]);
const PER_FOCUS = 20;
const PER_OTHER = 3;

function collect(seed: number, maxActions: number, out: Sample[], counts: Map<string, number>): void {
  const g = newGame({
    players: ['ai', 'ai', 'ai', 'ai'],
    seed: (0xa8 + seed).toString(16),
    map: MAP_ID,
    config: { timeLimitDays: 365 },
    board: 'random',
  });
  let s: GameState = g.state;
  let view = viewOf(s);
  const keep = (e: GameEvent): boolean => {
    const c = counts.get(e.type) ?? 0;
    counts.set(e.type, c + 1);
    return c < (FOCUS.has(e.type) ? PER_FOCUS : PER_OTHER);
  };
  for (let n = 0; n < maxActions && s.status === 'playing'; n++) {
    const a = aiAction(s, map);
    if (!a) break;
    let r: ReturnType<typeof g.engine.applyAction>;
    try {
      r = g.engine.applyAction(s, a);
    } catch {
      r = g.engine.applyAction(s, defaultAction(s)!);
    }
    const got = samplesOf(r.events, view, r.state, keep);
    out.push(...got.samples);
    view = got.view;
    s = r.state;
  }
}

describe('真实引擎事件 × 原版舞台 OrigStage', () => {
  const samples: Sample[] = [];
  const counts = new Map<string, number>();

  beforeAll(() => {
    for (const seed of [1, 2]) collect(seed, 2000, samples, counts);
  }, 120_000);

  it('自对弈覆盖到有原版 FLIC 的事件', () => {
    for (const t of ['GOD_ATTACHED', 'CONFINED', 'OBJECT_REMOVED', 'PARACHUTE', 'CARD_GAINED']) {
      expect(counts.get(t) ?? 0, t).toBeGreaterThan(0);
    }
    expect(samples.length).toBeGreaterThan(100);
  });

  it.each(PACING_PROFILES)(
    '%s：逐事件执行无错，自然用时 ≤ 预算，播到了原版 FLIC',
    { timeout: 180_000 },
    async (profile) => {
      const pack = buildFakeFlicPack();
      const bench = new StageBench({
        profile,
        flics: pack,
        map,
        me: 0,
        holidays: map.def.holidays.map((h) => ({ slot: h.slot, flagsRaw: h.flagsRaw })),
      });
      await bench.fake.flics!.ready;
      const over: string[] = [];
      let total = 0;
      for (const s of samples) {
        const r = await bench.run(s.e, s.before).catch((x: unknown) => {
          throw new Error(`${tagOf(s.e)}: ${String(x)}`);
        });
        total += r.used;
        if (r.used > r.budget * BUDGET_TOLERANCE + 50) over.push(`${tagOf(s.e)}: ${r.used}ms > ${r.budget}ms`);
      }
      if (process.env.RICH4_DEBUG_COUNTS) {
        console.log(profile, { samples: samples.length, total, played: [...new Set(pack.loads)] }, [...counts]);
      }
      expect(over).toEqual([]);
      // 编排确实在跑（不是空转通过）
      expect(total).toBeGreaterThan(samples.length * 300);
      // 自对弈是确定性的：神明降临、警车救护车、爆炸、得卡得点券、开局棋盘伞都播到了
      const played = new Set(pack.loads.map((k) => k.replace(/^flic\./, '')));
      for (const use of [
        'fx.policeCar',
        'fx.ambulance',
        'fx.explosion.small',
        'fx.cardGain',
        'fx.pointsGain',
        'fx.godLeave',
      ]) {
        expect(played.has(use), use).toBe(true);
      }
      expect([...played].filter((u) => u.startsWith('god.arrive.')).length).toBeGreaterThan(5);
      expect([...played].some((u) => u.startsWith('char.parachuteBoard.'))).toBe(true);
      expect(bench.fake.sounds.some((k) => k.startsWith('sfx.'))).toBe(true);
    },
  );
});
