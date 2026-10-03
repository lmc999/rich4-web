// 调试（梦游卡停放座驾，ENGINE_VERSION 0.5 → 0.6，architecture §34）：模拟 0.5.0 写下的快照——PlayerState 还没有 parked，
// 1 号在 0.5.0 时中了梦游卡（汽车退回背包、步行、不停放，下一回合梦游结束），2 号开着工程车（EngineerState 还没有 dice），
// 时光机锚点里同样没有这两个字段——
// 经 migrateState + validateState（服务器 RoomManager 的 migrated 路径；读档同样先经 migrateState）后继续推进：
// 补上 parked = null、engineer.dice = 换回座驾的上限，不变量通过、1 号醒来仍步行（0.5.0 中卡时没有停放，等价于 null）、
// 2 号的工程车照常倒数（只读）
// 用法：npx tsx test/vehstow-legacy-restore.ts
import { buildFixtureMaps, createRegistry, TABLES } from '../packages/shared/src/data';
import { createEngine } from '../packages/shared/src/engine/api';
import { publicWorld } from '../packages/shared/src/engine/core/postPatch';
import { scenario } from '../packages/shared/src/engine/testing/scenario';
import type { GameState } from '../packages/shared/src/engine/types/state';

const registry = createRegistry(buildFixtureMaps(), { tables: TABLES });
const engine = createEngine(registry);
const sc = scenario({ registry, players: ['human', 'human', 'human'], config: { vehicle: 'car' } }).untilMenu(0);
sc.edit((s) => {
  s.engine = '0.5.0';
  // 1 号：0.5.0 中梦游卡——汽车退回背包、步行、1 颗骰子，没有停放；计数 0x80 = 下一回合梦游结束
  const a = s.players[1]!;
  a.placed = true;
  a.node = 6;
  a.prevNode = 5;
  a.vehicle = 'walk';
  a.diceCount = 1;
  a.items[6] = (a.items[6] ?? 0) + 1;
  a.st.sleepwalk = 0x80;
  // 2 号：开着工程车，还剩 3 个回合，到期换回汽车（开工程车时汽车已收进背包）
  const b = s.players[2]!;
  b.placed = true;
  b.node = 11;
  b.prevNode = 10;
  b.vehicle = 'engineer';
  b.diceCount = 1;
  b.engineer = { days: 3, restore: 'car', dice: 3 };
  b.items[6] = (b.items[6] ?? 0) + 1;
  // 时光机锚点（全局模式）：取当前公开世界
  const world = structuredClone(publicWorld(s)) as unknown as NonNullable<GameState['secret']['timeAnchor']>['world'];
  world.flow = structuredClone(s.flow);
  world.decks = {
    newsOrder: s.secret.newsOrder.slice(),
    newsCursor: s.secret.newsCursor,
    fateOrder: s.secret.fateOrder.slice(),
    fateCursor: s.secret.fateCursor,
  };
  s.secret.timeAnchor = { takenAtTurn: s.clock.turnNo, seat: 0, world };
});
const legacy = JSON.parse(JSON.stringify(sc.state)) as GameState & { players: Record<string, unknown>[] };
// 0.5.0 还没有 parked 与 EngineerState.dice
const strip = (ps: Record<string, unknown>[]): void => {
  for (const p of ps) {
    delete p.parked;
    if (p.engineer) delete (p.engineer as Record<string, unknown>).dice;
  }
};
strip(legacy.players);
strip(legacy.secret.timeAnchor!.world.players as unknown as Record<string, unknown>[]);

console.log('0.5.0 快照直接校验（应为 false：缺 parked）', engine.validateState(legacy));
const migrated = engine.migrateState(legacy, 1);
console.log('migrateState 后 validateState', engine.validateState(migrated), 'explain', sc.engine.explainState(migrated));
console.log('engineer after migrate', migrated.players[2]!.engineer);
console.log(
  'parked',
  migrated.players.map((p) => p.parked),
  'anchor',
  migrated.secret.timeAnchor!.world.players.map((p) => p.parked),
);
sc.state = migrated;
const from = sc.log.length;
// 推进到 1 号醒来那一回合的回合菜单
sc.until((s) => s.pending[0]?.kind === 'TURN_MENU' && s.pending[0]?.seat === 1);
const after = sc.log.slice(from);
const p1 = sc.state.players[1]!;
const wake1 = after.filter((e) => e.type === 'VEHICLE' && e.seat === 1);
console.log('seat1 woke', { vehicle: p1.vehicle, parked: p1.parked, sleepwalk: p1.st.sleepwalk, car: p1.items[6], wake1 });
// 再推进到 2 号的回合菜单：工程车照常倒数一天
sc.until((s) => s.pending[0]?.kind === 'TURN_MENU' && s.pending[0]?.seat === 2);
const p2 = sc.state.players[2]!;
console.log('seat2 engineer', { vehicle: p2.vehicle, engineer: p2.engineer });
const ok =
  !engine.validateState(legacy) &&
  engine.validateState(migrated) &&
  p1.vehicle === 'walk' &&
  p1.parked === null &&
  p1.st.sleepwalk === 0 &&
  wake1.length === 0 &&
  migrated.players[2]!.engineer?.dice === 3 &&
  p2.engineer !== null &&
  p2.engineer.days === 2;
console.log(ok ? 'OK' : 'UNEXPECTED');
