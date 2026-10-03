// 调试（AI lookbehind 按原版改动）：比较改动前后四张图 golden 的概况与放置物件（只读）
// 输入：.cache/lookbehind/golden-before-<图>.json（改动前的快照副本）、packages/shared/src/engine/golden/__golden__/<图>.json、
//       .cache/lookbehind/places-before.json / places-after.json（test/lookbehind-golden-places.ts 的输出）
// 用法：npx tsx test/lookbehind-golden-diff.ts
import { readFileSync } from 'node:fs';

interface Place {
  game: string;
  day: number;
  seat: number;
  kind: string;
  node: number;
  me: number;
  prev: number;
  back: number | '?' | null;
  ahead: number | '?' | null;
}
type Places = Record<string, { places: Place[] }>;
const read = <T>(f: string): T => JSON.parse(readFileSync(f, 'utf8')) as T;
const before = read<Places>('.cache/lookbehind/places-before.json');
const after = read<Places>('.cache/lookbehind/places-after.json');
const KINDS = ['roadblock', 'mine', 'bomb'] as const;
const NAMES = { roadblock: '路障', mine: '地雷', bomb: '炸弹' } as const;

/** 往回第几格的分布（路障只算不在前方 4 格里的，即阶段二） */
function backHist(ps: Place[], kind: string): string {
  const h: Record<string, number> = {};
  for (const p of ps) {
    if (p.kind !== kind || p.seat < 0) continue;
    if (kind === 'roadblock' && typeof p.ahead === 'number' && p.ahead <= 4) continue;
    const k = String(p.back);
    h[k] = (h[k] ?? 0) + 1;
  }
  return Object.entries(h)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, n]) => `${k}:${n}`)
    .join(' ');
}

for (const m of ['taiwan', 'china', 'japan', 'usa']) {
  const a = read<{ engineVersion: string; mapHash: string; games: { name: string; events: number; actions: number; days: number; reason: string; rejects: number; types: Record<string, number>; final: string }[] }>(`.cache/lookbehind/golden-before-${m}.json`);
  const b = read<typeof a>(`packages/shared/src/engine/golden/__golden__/${m}.json`);
  console.log(`## ${m}  engine ${a.engineVersion} → ${b.engineVersion}  mapHash 不变: ${a.mapHash === b.mapHash}`);
  for (let i = 0; i < a.games.length; i++) {
    const x = a.games[i]!;
    const y = b.games[i]!;
    const pb = before[m]!.places.filter((p) => p.game === x.name);
    const pa = after[m]!.places.filter((p) => p.game === x.name);
    const cnt = (ps: Place[], k: string) => ps.filter((p) => p.kind === k).length;
    const rb1 = (ps: Place[]) => ps.filter((p) => p.kind === 'roadblock' && typeof p.ahead === 'number' && p.ahead <= 4).length;
    console.log(
      `- ${x.name}: events ${x.events}→${y.events}, days ${x.days}→${y.days}, reason ${x.reason}→${y.reason}, rejects ${y.rejects}, final ${x.final === y.final ? '同' : '变'}`,
    );
    console.log(
      `    ${KINDS.map((k) => `${NAMES[k]} ${cnt(pb, k)}→${cnt(pa, k)}`).join('，')}（路障里前方 4 格内的阶段一 ${rb1(pb)}→${rb1(pa)}）；` +
        `BOMB_ATTACHED ${x.types.BOMB_ATTACHED ?? 0}→${y.types.BOMB_ATTACHED ?? 0}，BOMB_EXPLODED ${x.types.BOMB_EXPLODED ?? 0}→${y.types.BOMB_EXPLODED ?? 0}，ROADBLOCK_HIT ${x.types.ROADBLOCK_HIT ?? 0}→${y.types.ROADBLOCK_HIT ?? 0}`,
    );
  }
  for (const k of KINDS) {
    console.log(`  ${NAMES[k]}往回第几格（来路格 = 1）：前 ${backHist(before[m]!.places, k)} | 后 ${backHist(after[m]!.places, k)}`);
  }
  // 同一局同一座位放置的格前后对照（前 6 次）
  const sample = (ps: Place[]) => ps.slice(0, 6).map((p) => `d${p.day}/s${p.seat}/${NAMES[p.kind as 'mine']}@${p.node}(回${p.back})`).join(' ');
  console.log(`  一个月局前 6 次放置：前 ${sample(before[m]!.places.filter((p) => p.game === a.games[0]!.name))}`);
  console.log(`                      后 ${sample(after[m]!.places.filter((p) => p.game === a.games[0]!.name))}`);
}
