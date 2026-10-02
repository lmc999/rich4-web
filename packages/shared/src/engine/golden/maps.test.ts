/**
 * 原版四张图的 golden（architecture §24.3；M9 台湾图终验起步，另外 3 张图随地图接入加入）：本机有 RICH4_DATA_DIR
 * （从正版提取的数据包：manifest.json + maps/<id>.map.json，不入库）时，在每张图上用固定种子跑几局 4 人对局——四个座位
 * 都由原版电脑 AI（OriginalAiPolicy，rng 派生与服务器 AiDriver 相同：座位视角的 projectState + makeAiContext）代打——
 * 把整局事件序列压成快照，与 __golden__/<id>.json 比对。
 * 按 MAPS 表驱动：每张图各有一份快照和各自的 mapHash 守卫；数据包里没有这张图、或者还没有快照时，这张图单独 skip
 * （CI 没有提取过的数据，四张图都 skip）。
 *
 * 快照只含哈希、计数与事件类型名，不含原版数据本身（check-no-original 可放行）：
 *   events       事件总数；types 各事件类型的次数；head 前 160 个事件的类型序列（定位分歧）；
 *   checkpoints  每 400 个事件一段的链式哈希（fnv1a64(上一段 | canonicalJson(本段事件))，最后一段不足 400 也算）；
 *   final        终局状态哈希；另有 actions、days、reason 与每局的配置。
 * 某张图的 mapHash 与快照记录的不一致（数据包换了版本）时这张图跳过并提示重新生成。
 * 每一步还检查一次引擎不变量（checkInvariants），每 50 步做一次结构校验（explainState），作为各图整局的终验。
 *
 * 只跑其中几张图：RICH4_GOLDEN_MAPS=china,japan（逗号分隔；all 或不设为全部）。
 * 规则有意变更或新图首次生成快照（刷新 golden）——必须用 RICH4_GOLDEN_MAPS 点名要重写的图，不点名时直接失败，
 * 免得顺手改掉 taiwan.json（已部署的台湾存档与房间依赖它）：
 *   RICH4_UPDATE_GOLDEN=1 RICH4_GOLDEN_MAPS=china,japan,usa RICH4_DATA_DIR=./rich4-data \
 *     npx vitest run --project shared src/engine/golden
 * 刷新后不带 RICH4_UPDATE_GOLDEN 再跑一遍确认稳定，并在变更说明里写明原因（同 minigames/golden.test.ts）。
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

/** 原版四张图，顺序即 globalMapId（tools/extract MAP_KEYS、客户端 STAGE_MAPS 同序） */
const MAPS = ['taiwan', 'china', 'japan', 'usa'] as const;
type GoldenMapId = (typeof MAPS)[number];

const UPDATE = process.env.RICH4_UPDATE_GOLDEN === '1';
const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../..');

/** RICH4_GOLDEN_MAPS 解析：null = 没有点名（不设或 all 时全部参与比对，但不允许刷新） */
function parseSelection(raw: string | undefined): { selected: Set<GoldenMapId>; named: boolean; unknown: string[] } {
  const text = (raw ?? '').trim();
  if (text === '' || text === 'all') return { selected: new Set(MAPS), named: text === 'all', unknown: [] };
  const parts = text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const unknown = parts.filter((p) => !(MAPS as readonly string[]).includes(p));
  return { selected: new Set(parts.filter((p): p is GoldenMapId => !unknown.includes(p))), named: true, unknown };
}

const SELECTION = parseSelection(process.env.RICH4_GOLDEN_MAPS);

function goldenFile(id: GoldenMapId): URL {
  return new URL(`./__golden__/${id}.json`, import.meta.url);
}

/** 固定的对局：种子、限时（天）、角色；四个座位都是电脑（四张图共用同一组对局） */
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

/** 单局上限（远大于实际：一年局约 2000–3000 个 action） */
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

interface ManifestEntry {
  id: string;
  file: string;
  mapHash: string;
}

/** RICH4_DATA_DIR（相对路径先按当前目录、再按仓库根解析）里含这张图的数据包目录；没有时 null */
function dataDirFor(id: GoldenMapId): string | null {
  const raw = process.env.RICH4_DATA_DIR;
  if (!raw) return null;
  const cands = isAbsolute(raw) ? [raw] : [resolve(process.cwd(), raw), resolve(REPO_ROOT, raw)];
  for (const dir of cands) {
    const manifest = resolve(dir, 'manifest.json');
    if (!existsSync(manifest)) continue;
    const m = JSON.parse(readFileSync(manifest, 'utf8')) as { maps?: ManifestEntry[] };
    const entry = m.maps?.find((x) => x.id === id);
    if (entry && existsSync(resolve(dir, entry.file))) return dir;
  }
  return null;
}

/** fixture 地图 + 这一张原版图（其他原版图不加载，互不影响） */
function loadMap(dir: string, id: GoldenMapId): { registry: DataRegistry; mapHash: string } {
  const m = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8')) as { maps: ManifestEntry[] };
  const entry = m.maps.find((x) => x.id === id)!;
  const def = parseMapDef(JSON.parse(readFileSync(resolve(dir, entry.file), 'utf8')));
  const maps = buildFixtureMaps().filter((x) => x.id !== def.id);
  return { registry: createRegistry([...maps, def], { tables: TABLES }), mapHash: entry.mapHash };
}

function playGolden(registry: DataRegistry, mapId: GoldenMapId, g: GoldenGame): GameDigest {
  const engine = internal.createEngine(registry, { devChecks: false });
  const map = registry.getMap(mapId);
  const config = makeConfig({ map: mapId, config: { timeLimitDays: g.timeLimitDays }, debug: false });
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

describe('RICH4_GOLDEN_MAPS', () => {
  it('只接受原版四张图的 id（或 all）；刷新快照时必须点名', () => {
    expect(parseSelection(undefined)).toEqual({ selected: new Set(MAPS), named: false, unknown: [] });
    expect(parseSelection('all')).toEqual({ selected: new Set(MAPS), named: true, unknown: [] });
    expect(parseSelection(' china, usa ,')).toEqual({ selected: new Set(['china', 'usa']), named: true, unknown: [] });
    expect(parseSelection('china,korea').unknown).toEqual(['korea']);
    expect(SELECTION.unknown, `RICH4_GOLDEN_MAPS 里有未知的图（可选：${MAPS.join('、')}、all）`).toEqual([]);
  });
});

for (const id of MAPS) {
  const dataDir = SELECTION.selected.has(id) ? dataDirFor(id) : null;
  const file = goldenFile(id);

  describe.skipIf(dataDir === null)(`${id} 图 golden（需要 RICH4_DATA_DIR）`, () => {
    it('固定种子的电脑对局：事件序列、终局与快照一致；整局不变量成立', { timeout: 300_000 }, (ctx) => {
      if (UPDATE && !SELECTION.named) {
        throw new Error(
          'RICH4_UPDATE_GOLDEN=1 要同时用 RICH4_GOLDEN_MAPS 点名要重写的图（例如 china,japan,usa；全部重写写 all），免得顺手改掉 taiwan.json',
        );
      }
      const { registry, mapHash } = loadMap(dataDir!, id);
      const golden: GoldenFile | null = existsSync(file)
        ? (JSON.parse(readFileSync(file, 'utf8')) as GoldenFile)
        : null;
      if (!UPDATE && golden === null) {
        ctx.skip(`${id} 图还没有快照 __golden__/${id}.json：用 RICH4_UPDATE_GOLDEN=1 RICH4_GOLDEN_MAPS=${id} 生成`);
        return;
      }
      if (!UPDATE && golden !== null && golden.mapHash !== mapHash) {
        ctx.skip(
          `${id} 图 mapHash ${mapHash.slice(0, 12)}… 与快照的 ${golden.mapHash.slice(0, 12)}… 不同：数据包换了版本，请重新生成快照`,
        );
        return;
      }
      const digests = GAMES.map((g) => playGolden(registry, id, g));
      for (const d of digests) {
        expect(d.rejects, `${id} ${d.name}：AI intent 被拒`).toBe(0);
        expect(d.reason, `${id} ${d.name}：没有打完`).not.toBe('unfinished');
      }
      // 同一种子再跑一遍：完全相同（确定性）
      const again = playGolden(registry, id, GAMES[0]!);
      expect(again).toEqual(digests[0]);

      if (UPDATE) {
        const out: GoldenFile = { engineVersion: ENGINE_VERSION, map: id, mapHash, games: digests };
        writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
        return;
      }
      const want = golden!;
      expect(want.map, `__golden__/${id}.json 记录的图不是 ${id}`).toBe(id);
      expect(ENGINE_VERSION, 'ENGINE_VERSION 变了：确认规则变更后用 RICH4_UPDATE_GOLDEN=1 刷新快照').toBe(
        want.engineVersion,
      );
      expect(digests.map((d) => d.name)).toEqual(want.games.map((d) => d.name));
      digests.forEach((d, i) => {
        const w = want.games[i]!;
        expect(d, `${id} ${d.name}：${firstDivergence(d, w)}`).toEqual(w);
      });
    });
  });
}
