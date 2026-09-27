/**
 * M9 台湾图终验 golden（architecture §24.3）：本机有 RICH4_DATA_DIR（从正版提取的数据包：manifest.json + maps/taiwan.map.json，
 * 不入库）时，在台湾图上用固定种子跑几局 4 人对局——四个座位都由原版电脑 AI（OriginalAiPolicy，rng 派生与服务器 AiDriver
 * 相同：座位视角的 projectState + makeAiContext）代打——把整局事件序列压成快照，与 __golden__/taiwan.json 比对。
 * 缺数据（CI、没有提取过台湾图）时整组 skip。
 *
 * 快照只含哈希、计数与事件类型名，不含原版数据本身（check-no-original 可放行）：
 *   events       事件总数；types 各事件类型的次数；head 前 160 个事件的类型序列（定位分歧）；
 *   checkpoints  每 400 个事件一段的链式哈希（fnv1a64(上一段 | canonicalJson(本段事件))，最后一段不足 400 也算）；
 *   final        终局状态哈希；另有 actions、days、reason 与每局的配置。
 * 台湾图的 mapHash 与快照记录的不一致（数据包换了版本）时跳过并提示重新生成。
 * 每一步还检查一次引擎不变量（checkInvariants），每 50 步做一次结构校验（explainState），作为台湾图整局的终验。
 *
 * 规则有意变更（刷新 golden）：
 *   RICH4_UPDATE_GOLDEN=1 RICH4_DATA_DIR=./rich4-data npx vitest run --project shared src/engine/golden/taiwan
 * 并在变更说明里写明原因（同 minigames/golden.test.ts）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeAiContext, OriginalAiPolicy } from '../../ai';
import { buildFixtureMaps, createRegistry, type DataRegistry, parseMapDef, TABLES } from '../../data';
import { canonicalJson } from '../../util/canonicalJson';
import { fnv1a64 } from '../../util/hash';
import { projectState } from '../../view';
import { internal } from '../api';
import { isIntentAllowed } from '../decisions/allowed';
import { EngineRuleError } from '../errors';
import { DEFAULT_CHARACTERS, decisionForSeat, makeConfig, stateHash } from '../testing';
import type { GameEvent } from '../types/events';
import type { SeatIndex, TimeLimitDays } from '../types/ids';
import { type GameAction, type PlayerIntent, PlayerIntentSchema } from '../types/intent';
import type { GameState } from '../types/state';
import { ENGINE_VERSION } from '../version';

const UPDATE = process.env.RICH4_UPDATE_GOLDEN === '1';
const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../..');
const GOLDEN_FILE = new URL('./__golden__/taiwan.json', import.meta.url);

/** 固定的对局：种子、限时（天）、角色；四个座位都是电脑 */
interface GoldenGame {
  name: string;
  seed: string;
  timeLimitDays: TimeLimitDays;
  characters: readonly number[];
}

const GAMES: readonly GoldenGame[] = [
  { name: '一个月（默认角色）', seed: '7a1a0001', timeLimitDays: 30, characters: DEFAULT_CHARACTERS },
  { name: '三个月', seed: '7a1a0002', timeLimitDays: 91, characters: [0, 5, 7, 11] },
  { name: '半年', seed: '7a1a0003', timeLimitDays: 182, characters: [1, 2, 6, 10] },
  { name: '一年', seed: '7a1a0004', timeLimitDays: 365, characters: [3, 4, 8, 9] },
];

/** 单局上限（远大于实际：一年局约 2000 个 action） */
const MAX_ACTIONS = 60_000;
const CHECKPOINT_EVERY = 400;
const HEAD = 160;

interface GameDigest {
  name: string;
  seed: string;
  timeLimitDays: number;
  characters: number[];
  actions: number;
  /** AI 给出的 intent 被拒、改用 defaultIntent 的次数（应为 0） */
  rejects: number;
  days: number;
  reason: string;
  events: number;
  types: Record<string, number>;
  head: string[];
  checkpoints: string[];
  final: string;
}

interface GoldenFile {
  /** 生成快照时的 ENGINE_VERSION（规则变更升版本时要一起刷新快照） */
  engineVersion: string;
  map: string;
  mapHash: string;
  games: GameDigest[];
}

/** RICH4_DATA_DIR（相对路径先按当前目录、再按仓库根解析）；没有台湾图时 null */
function taiwanDataDir(): string | null {
  const raw = process.env.RICH4_DATA_DIR;
  if (!raw) return null;
  const cands = isAbsolute(raw) ? [raw] : [resolve(process.cwd(), raw), resolve(REPO_ROOT, raw)];
  for (const dir of cands) {
    const manifest = resolve(dir, 'manifest.json');
    if (!existsSync(manifest)) continue;
    const m = JSON.parse(readFileSync(manifest, 'utf8')) as { maps?: { id: string; file: string }[] };
    const entry = m.maps?.find((x) => x.id === 'taiwan');
    if (entry && existsSync(resolve(dir, entry.file))) return dir;
  }
  return null;
}

function loadTaiwan(dir: string): { registry: DataRegistry; mapHash: string } {
  const m = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8')) as {
    maps: { id: string; file: string; mapHash: string }[];
  };
  const entry = m.maps.find((x) => x.id === 'taiwan')!;
  const def = parseMapDef(JSON.parse(readFileSync(resolve(dir, entry.file), 'utf8')));
  const maps = buildFixtureMaps().filter((x) => x.id !== def.id);
  return { registry: createRegistry([...maps, def], { tables: TABLES }), mapHash: entry.mapHash };
}

function playGolden(registry: DataRegistry, g: GoldenGame): GameDigest {
  const engine = internal.createEngine(registry, { devChecks: false });
  const map = registry.getMap('taiwan');
  const config = makeConfig({ map: 'taiwan', config: { timeLimitDays: g.timeLimitDays }, debug: false });
  const setups = g.characters.map((character, i) => ({
    seat: i as SeatIndex,
    character: character as never,
    controller: 'ai' as const,
  }));
  const created = engine.createGameWithEvents(config, setups, g.seed);
  let s: GameState = created.state;
  const all: GameEvent[] = [...created.events];
  let actions = 0;
  let rejects = 0;
  while (s.status === 'playing' && actions < MAX_ACTIONS) {
    const d = s.pending[0];
    if (!d) throw new Error(`action ${actions}: 对局进行中却没有待决策`);
    const player = s.players.find((p) => p.seat === d.seat)!;
    const view = structuredClone(projectState(s, { kind: 'seat', seat: d.seat }, { handVisibility: 'public' }));
    const ctx = makeAiContext({
      aiSeed: s.secret.aiSeed,
      seat: d.seat,
      decisionId: d.id,
      turnNo: s.clock.turnNo,
      traits: { ...player.aiTraits },
      map,
      handVisibility: 'public',
    });
    const fallback = { ...d.defaultIntent, seat: d.seat, decisionId: d.id } as GameAction;
    const raw = OriginalAiPolicy.decide(view, decisionForSeat(d) as never, ctx) as PlayerIntent;
    let action = fallback;
    if (PlayerIntentSchema.safeParse(raw).success && isIntentAllowed(d.kind, raw.type)) {
      action = { ...raw, seat: d.seat, decisionId: d.id } as GameAction;
    } else rejects++;
    let r: ReturnType<typeof engine.applyAction>;
    try {
      r = engine.applyAction(s, action);
    } catch (e) {
      if (!(e instanceof EngineRuleError) || action === fallback) throw e;
      rejects++;
      r = engine.applyAction(s, fallback);
    }
    s = r.state;
    all.push(...r.events);
    actions++;
    const bad = actions % 50 === 0 ? engine.explainState(s) : engine.checkInvariants(s);
    if (bad.length > 0) throw new Error(`action ${actions}: ${bad.slice(0, 3).join('; ')}`);
  }
  const types: Record<string, number> = {};
  for (const e of all) types[e.type] = (types[e.type] ?? 0) + 1;
  const checkpoints: string[] = [];
  let chain = '';
  for (let i = 0; i < all.length; i += CHECKPOINT_EVERY) {
    chain = fnv1a64(`${chain}|${canonicalJson(all.slice(i, i + CHECKPOINT_EVERY))}`);
    checkpoints.push(chain);
  }
  return {
    name: g.name,
    seed: g.seed,
    timeLimitDays: g.timeLimitDays,
    characters: [...g.characters],
    actions,
    rejects,
    days: s.clock.elapsedDays,
    reason: s.result?.reason ?? 'unfinished',
    events: all.length,
    types: Object.fromEntries(Object.entries(types).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    head: all.slice(0, HEAD).map((e) => e.type),
    checkpoints,
    final: stateHash(s),
  };
}

/** 第一处分歧的事件段（便于定位） */
function firstDivergence(a: GameDigest, b: GameDigest): string {
  const n = Math.min(a.checkpoints.length, b.checkpoints.length);
  for (let i = 0; i < n; i++) {
    if (a.checkpoints[i] !== b.checkpoints[i]) {
      return `事件 ${i * CHECKPOINT_EVERY}–${(i + 1) * CHECKPOINT_EVERY - 1} 段开始不同`;
    }
  }
  return a.checkpoints.length === b.checkpoints.length
    ? '段哈希相同'
    : `事件段数不同（${a.checkpoints.length} / ${b.checkpoints.length}）`;
}

const DATA_DIR = taiwanDataDir();

describe.skipIf(DATA_DIR === null)('台湾图 golden（需要 RICH4_DATA_DIR）', () => {
  it('固定种子的电脑对局：事件序列、终局与快照一致；整局不变量成立', { timeout: 300_000 }, (ctx) => {
    const { registry, mapHash } = loadTaiwan(DATA_DIR!);
    const golden: GoldenFile | null = existsSync(GOLDEN_FILE)
      ? (JSON.parse(readFileSync(GOLDEN_FILE, 'utf8')) as GoldenFile)
      : null;
    if (!UPDATE && golden && golden.mapHash !== mapHash) {
      ctx.skip(
        `台湾图 mapHash ${mapHash.slice(0, 12)}… 与快照的 ${golden.mapHash.slice(0, 12)}… 不同：数据包换了版本，请重新生成快照`,
      );
      return;
    }
    const digests = GAMES.map((g) => playGolden(registry, g));
    for (const d of digests) {
      expect(d.rejects, `${d.name}：AI intent 被拒`).toBe(0);
      expect(d.reason, `${d.name}：没有打完`).not.toBe('unfinished');
    }
    // 同一种子再跑一遍：完全相同（确定性）
    const again = playGolden(registry, GAMES[0]!);
    expect(again).toEqual(digests[0]);

    if (UPDATE || !golden) {
      if (!UPDATE) throw new Error(`缺少快照 ${fileURLToPath(GOLDEN_FILE)}：用 RICH4_UPDATE_GOLDEN=1 生成`);
      const file: GoldenFile = { engineVersion: ENGINE_VERSION, map: 'taiwan', mapHash, games: digests };
      writeFileSync(GOLDEN_FILE, `${JSON.stringify(file, null, 2)}\n`);
      return;
    }
    expect(ENGINE_VERSION, 'ENGINE_VERSION 变了：确认规则变更后用 RICH4_UPDATE_GOLDEN=1 刷新快照').toBe(
      golden.engineVersion,
    );
    expect(digests.map((d) => d.name)).toEqual(golden.games.map((d) => d.name));
    digests.forEach((d, i) => {
      const want = golden.games[i]!;
      expect(d, `${d.name}：${firstDivergence(d, want)}`).toEqual(want);
    });
  });
});
