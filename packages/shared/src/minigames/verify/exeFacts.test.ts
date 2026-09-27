/**
 * 小游戏常量与 exe 抽取结果对照（D2；design/minigames-ai.md §11、§2.6 verify/exeFacts）。
 *
 * - tools/extract/anchors/constants.json：155 个已核实常量锚点（v3.11 人工复核 + v2.06 迁移地址，入库）；
 * - .cache/extract/tables.v206.json：用户本机从 v2.06 exe 抽取的表（派生数据，不入库，缺文件时 skip）。
 *
 * 每个锚点 id 对应 sim / 引擎里实际使用的常量；锚点或抽取值与代码不一致即失败（规则有意偏离时应改锚点说明并记 DEVIATIONS）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ECON } from '../../data/tables/economy';
import { MINIGAME_SCORE_CAP } from '../../engine/squares/minigame';
import { DIGIT_CAP_AT, DIGIT_CAP_TO, LANE_COUNT, LANES, SLOT_COUNT, SPECIAL_TABLE, SPEED } from '../balloon/constants';
import { BALLOON_SPEC } from '../balloon/sim';
import { BURY_COUNTS, ITEM_SCORE, PENGUIN_MAX_SCORE } from '../penguin/constants';
import { PENGUIN_SPEC } from '../penguin/sim';
import { FALL, WARN_PASS_BELOW, WARN_ROLL } from '../xicong/constants';
import { XICONG_SPEC } from '../xicong/sim';

type Value = number | readonly number[];

const repoRoot = new URL('../../../../../', import.meta.url);
const ANCHORS = new URL('tools/extract/anchors/constants.json', repoRoot);
const TABLES = new URL('.cache/extract/tables.v206.json', repoRoot);

const sum = (a: readonly number[]) => a.reduce((x, y) => x + y, 0);

/** 锚点 id → 代码里的值 */
const CODE: Readonly<Record<string, Value>> = {
  // 原版只有玩家类型 = 1（真人）才亲自玩：引擎按 controller === 'human' 判定
  'minigame.humanOnly': 1,
  'minigame.skipBase': ECON.MINIGAME_SKIP_BASE,
  'minigame.skipMod': ECON.MINIGAME_SKIP_RANGE,
  'penguin.tickMs': PENGUIN_SPEC.tickMs,
  'penguin.introTicks': PENGUIN_SPEC.introTicks,
  'penguin.playTicks': PENGUIN_SPEC.playTicks,
  'penguin.itemCounts': BURY_COUNTS.slice(1),
  'penguin.score2': ITEM_SCORE[2]!,
  'penguin.score3': ITEM_SCORE[3]!,
  'penguin.score4': ITEM_SCORE[4]!,
  'penguin.score5': ITEM_SCORE[5]!,
  'penguin.itemTotal': sum(BURY_COUNTS),
  'penguin.maxScore': PENGUIN_MAX_SCORE,
  'balloon.playTicks': BALLOON_SPEC.playTicks,
  'balloon.slots': SLOT_COUNT,
  'balloon.laneStart': LANES[0]!,
  'balloon.laneStep': LANES[1]! - LANES[0]!,
  // 原版循环 for (x = 40; x < 640; x += 80)：上界（不含）是舞台宽度
  'balloon.laneEnd': BALLOON_SPEC.stage.w,
  'balloon.lanes': LANE_COUNT,
  'balloon.scoreCap': DIGIT_CAP_AT,
  'balloon.scoreClamp': DIGIT_CAP_TO,
  'balloon.speed': SPEED,
  'balloon.special': SPECIAL_TABLE,
  'xicong.playTicks': XICONG_SPEC.playTicks,
  'xicong.bombMod': WARN_ROLL,
  'xicong.bombThreshold': WARN_PASS_BELOW,
  'xicong.bombPct': ((WARN_ROLL - WARN_PASS_BELOW) * 100) / WARN_ROLL,
  'xicong.fall': FALL,
};

const PREFIXES = ['minigame.', 'penguin.', 'balloon.', 'xicong.'];
const isMinigameId = (id: string) => PREFIXES.some((p) => id.startsWith(p));

interface Anchor {
  id: string;
  value: unknown;
  v206Value?: unknown;
  confirmed: boolean;
}

function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, 'utf8'));
}

describe('小游戏常量对照（代码内部）', () => {
  it('派生量自洽', () => {
    expect(PENGUIN_MAX_SCORE).toBe(BURY_COUNTS.reduce((acc, n, k) => acc + n * ITEM_SCORE[k]!, 0));
    expect(PENGUIN_SPEC.scoreSanityMax).toBe(PENGUIN_MAX_SCORE);
    expect(MINIGAME_SCORE_CAP.penguin).toBe(PENGUIN_MAX_SCORE);
    expect(LANES).toHaveLength(LANE_COUNT);
    const lanes: number[] = [];
    for (let x = LANES[0]!; x < BALLOON_SPEC.stage.w; x += LANES[1]! - LANES[0]!) lanes.push(x);
    expect(lanes).toEqual(LANES);
    expect(XICONG_SPEC.tickMs).toBe(50);
    expect(BALLOON_SPEC.tickMs).toBe(100);
  });
});

describe.skipIf(!existsSync(ANCHORS))('anchors/constants.json 的小游戏锚点', () => {
  const anchors = existsSync(ANCHORS)
    ? ((readJson(ANCHORS) as { constants: Anchor[] }).constants ?? []).filter((a) => isMinigameId(a.id))
    : [];

  it('每个小游戏锚点都有对应的代码常量，且锚点已核实', () => {
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      expect(CODE, `代码里没有锚点 ${a.id} 的对应常量`).toHaveProperty([a.id]);
      expect(a.confirmed, a.id).toBe(true);
    }
  });

  it('锚点值（v3.11，及 v2.06 若另有取值）与代码一致', () => {
    for (const a of anchors) {
      expect(a.value, a.id).toEqual(CODE[a.id]);
      if (a.v206Value !== undefined) expect(a.v206Value, `${a.id} (v2.06)`).toEqual(CODE[a.id]);
    }
  });
});

describe.skipIf(!existsSync(TABLES))('.cache/extract/tables.v206.json 的抽取值', () => {
  const constants = existsSync(TABLES)
    ? ((readJson(TABLES) as { constants?: Record<string, { ok: boolean; value: unknown }> }).constants ?? {})
    : {};

  it('v2.06 exe 抽出的小游戏常量与代码一致', () => {
    const ids = Object.keys(constants).filter(isMinigameId).sort();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const c = constants[id]!;
      expect(c.ok, `${id} 抽取失败`).toBe(true);
      if (!(id in CODE)) continue;
      expect(c.value, id).toEqual(CODE[id]);
    }
    // 代码里登记的锚点都应该被抽到
    for (const id of Object.keys(CODE)) expect(ids, id).toContain(id);
  });
});
