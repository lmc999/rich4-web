// 真实引擎载荷 × 前端演出（M6 / M7 整合）：原版 AI 在 test-allkinds 上自对弈（卡片、道具、神明、路面物件、关押、保释都会出现），
// 按座位 0 的视角投影出事件，逐个交给 handler：
// - 不抛错；日志行、toast、飘字、气泡、弹窗文案里没有 undefined / NaN / 残留的 {{…}} / 未命中的 i18n 键；
// - 接上计时舞台（按 game/fx/timings 的真实特效时长等待）时，未封顶的自然用时 ≤ EVENT_BUDGET_MS（同 EventPlayer 容差）。
// handler 按设计稿载荷开发、而引擎实际载荷不同（字段缺失、取值范围、事件顺序）时，这里会先失败。
import { fixtureRegistry } from '@rich4/shared/data';
import type { GameEvent, GameState } from '@rich4/shared/engine';
import { newGame } from '@rich4/shared/engine-testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../../i18n';
import {
  aiAction,
  BAD_TEXT,
  defaultAction,
  logLine,
  playAll,
  type Sample,
  samplesOf,
  tagOf,
  viewOf,
} from '../../test/realEngineHarness';
import { usePopupStore } from '../../ui/popups/popupStore';

beforeAll(() => {
  initI18n('original');
});

const MAP_ID = 'test-allkinds';
const map = fixtureRegistry.getMap(MAP_ID);

/** 本测试关注的 M6 / M7 事件（其余类型也会跑，但每种只抽前几条） */
const FOCUS_TYPES = new Set<string>([
  'CARD_USED',
  'CARD_NO_EFFECT',
  'PASSIVE',
  'ITEM_USED',
  'VEHICLE',
  'VEHICLE_DESTROYED',
  'OBJECT_PLACED',
  'OBJECT_REMOVED',
  'DOLL_WALK',
  'BOMB_ATTACHED',
  'BOMB_TRANSFERRED',
  'BOMB_EXPLODED',
  'STRIKE',
  'TELEPORTED',
  'GOD_ATTACHED',
  'GOD_POWER',
  'GOD_LEFT',
  'GOD_SPAWNED',
  'GOD_MANIFEST',
  'DOG_BITE',
  'DOG_KNOCKED',
  'DEATH_GOD_SUMMONED',
  'CONFINED',
  'RELEASED',
  'BAIL',
  'BLESSING',
  'STATUS_SET',
  'ALLIANCE_FORMED',
  'ALLIANCE_BROKEN',
  'ALLIANCE_EXPIRED',
  'BEGGAR_ALMS',
  'CARD_GAINED',
  'CARD_LOST',
  'ITEM_GAINED',
  'ITEM_LOST',
  'LOT_LEVEL',
  'LOT_MUTATED',
  'MONEY',
  'TOLL_PAID',
  'TOLL_EXEMPT',
  'STOCK_FLAG',
  'MARK_SET',
  'OBJECTS_RESPAWNED',
  'BANKRUPT',
  // M7
  'NEWS',
  'FATE',
  'MAGIC_CONDITION',
  'MAGIC_CAST',
  'AUCTION_STARTED',
  'AUCTION_BID',
  'AUCTION_PASS',
  'AUCTION_QUIT',
  'AUCTION_ENDED',
  'VILLAIN_HIRED',
  'VILLAIN_ACTION',
  'VILLAIN_HOME',
  'LIQUIDATION',
  'BECAME_BEGGAR',
  'INSURANCE_PAYOUT',
  'SUSPENDED',
  'RESUMED',
  'LISTING_ADDED',
  'LISTING_REMOVED',
  'LISTING_SOLD',
]);
/** 每种关注的事件最多测多少条（载荷多样性）；其他事件每种只测前 3 条 */
const PER_TYPE = 40;
const PER_OTHER = 3;

/** 原版 AI 自对弈一局，按座位 0 的视角收集事件样本（每个事件带提交前的显示态） */
function collect(seed: number, maxActions: number, out: Sample[], counts: Map<string, number>): void {
  const g = newGame({
    players: ['ai', 'ai', 'ai', 'ai'],
    seed: (0xa11 + seed).toString(16),
    map: MAP_ID,
    config: { timeLimitDays: 365 },
    board: 'random',
  });
  let s: GameState = g.state;
  let view = viewOf(s);
  const keep = (e: GameEvent): boolean => {
    const c = counts.get(e.type) ?? 0;
    counts.set(e.type, c + 1);
    return c < (FOCUS_TYPES.has(e.type) ? PER_TYPE : PER_OTHER);
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

describe('真实引擎事件 × handler（M6 / M7 载荷对齐）', () => {
  const samples: Sample[] = [];
  const counts = new Map<string, number>();

  // 单独运行约 3 秒；全量并行时 CPU 紧张，给足时间
  beforeAll(() => {
    for (const seed of [1, 2, 3]) collect(seed, 2500, samples, counts);
  }, 120_000);

  it('自对弈覆盖到主要的对抗与事件格', () => {
    if (process.env.RICH4_DEBUG_COUNTS) console.log([...counts].sort((a, b) => b[1] - a[1]));
    for (const t of ['CARD_USED', 'ITEM_USED', 'OBJECT_PLACED', 'GOD_ATTACHED', 'GOD_SPAWNED', 'CONFINED']) {
      expect(counts.get(t) ?? 0, t).toBeGreaterThan(0);
    }
    for (const t of ['NEWS', 'FATE', 'MAGIC_CONDITION', 'MAGIC_CAST']) expect(counts.get(t) ?? 0, t).toBeGreaterThan(0);
  });

  it('日志行完整（formatEvent 对每个样本）', () => {
    for (const s of samples) {
      const line = logLine(s, map);
      if (line === null) continue;
      expect(line, tagOf(s.e)).not.toMatch(BAD_TEXT);
    }
  });

  it('handler 不抛错、文案完整、自然用时 ≤ 预算', { timeout: 120_000 }, async () => {
    usePopupStore.getState().clear();
    const { over, total } = await playAll(samples, map, (tag, t) => expect(t, tag).not.toMatch(BAD_TEXT));
    usePopupStore.getState().clear();
    expect(over).toEqual([]);
    expect(samples.length).toBeGreaterThan(100);
    // 编排确实在跑（不是空转通过）：样本的总用时应有数十秒
    if (process.env.RICH4_DEBUG_COUNTS) console.log({ samples: samples.length, total });
    expect(total).toBeGreaterThan(samples.length * 300);
  });
});
