// 调试脚本（随机事件审查修复）：真实引擎里 37 条命运各自的 FATE 事件 post 带了什么、效果又落在之后哪些事件里——
// 判断命运板关掉之后「效果当场可见」能不能在 FATE 自己的 handler 里做到（多数效果在随后的 MONEY / CONFINED / LOT_MUTATED…）。
// 用法：npx tsx test/evcard-fate-posts.ts
import { fixtureRegistry } from '@rich4/shared/data';
import { FATE_IDS, type FateId, type GameEvent, type SeatIndex } from '@rich4/shared/engine';
import { scenario } from '@rich4/shared/engine-testing';

const MAP_ID = 'test-allkinds';
fixtureRegistry.getMap(MAP_ID);
// test-allkinds：1 银行 → 2 新闻 → 3 命运 → 4 卡片 → 5 L1 → 6 L2 → 7 L3 …
const FATE_TILE = 3;
const NEWS_TILE = 2;

const vehicleOf = (id: FateId): 5 | 6 | null => ([10, 13, 15].includes(id) ? 5 : [11, 16].includes(id) ? 6 : null);

for (const id of FATE_IDS) {
  const sc = scenario({ players: ['human', 'human', 'ai', 'ai'], map: MAP_ID }).untilMenu(0);
  sc.edit((s) => {
    const land = (lid: string, owner: SeatIndex | null, level: number) => {
      const l = s.lands.find((x) => x.id === lid)!;
      l.owner = owner;
      l.level = level as 0;
    };
    land('L1', 0, 2);
    land('L3', 0, 0);
  });
  const v = vehicleOf(id);
  if (v !== null) {
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'give', seat: 0, cards: [], items: [{ item: v, qty: 1 }] } });
    const d = sc.pending(0);
    sc.apply({ type: 'USE_ITEM', item: v, target: { t: 'none' }, seat: 0, decisionId: d.id } as never);
  }
  sc.apply({ type: 'SYS_DEBUG', op: { op: 'stackDeck', deck: 'fate', ids: [id] } });
  sc.untilMenu(0);
  const n0 = sc.events.length;
  sc.apply({ type: 'SYS_DEBUG', op: { op: 'teleport', seat: 0, node: FATE_TILE - 1, prev: NEWS_TILE - 1 } });
  sc.apply({ type: 'SYS_DEBUG', op: { op: 'forceNext', purpose: 'dice', values: [1] } });
  const d = sc.pending(0);
  sc.apply({ type: 'ROLL', dice: 1, seat: 0, decisionId: d.id } as never);
  const evs = sc.events.slice(n0) as GameEvent[];
  const i = evs.findIndex((e) => e.type === 'FATE');
  if (i < 0) {
    console.log(`fate ${id}: 没有 FATE（${evs.map((e) => e.type).join(',')}）`);
    continue;
  }
  const f = evs[i] as Extract<GameEvent, { type: 'FATE' }>;
  const post = f.post ?? {};
  const keys = Object.entries(post)
    .filter(([, v]) => Array.isArray(v) && v.length > 0)
    .map(([k, v]) => `${k}:${(v as { set?: object }[]).map((x) => Object.keys(x.set ?? x).join('+')).join('|')}`);
  const after = evs
    .slice(i + 1, i + 6)
    .map((e) => e.type)
    .join(',');
  // 不可行时引擎改抽别的（持股、对手手牌等前提这里没布置）
  console.log(`fate ${String(id).padStart(2)} → 抽到 ${f.id}: post {${keys.join(' ')}}  then ${after}`);
}
