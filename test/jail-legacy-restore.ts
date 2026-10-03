// 调试（获释位置，ENGINE_VERSION 0.4 → 0.5）：模拟旧版本快照——在押的人带着旧的 savedPrevNode、刚获释的人站在保释格上——
// 经 migrateState + validateState（服务器 RoomManager 的 migrated 路径）后继续推进，确认能恢复、获释后留在关押格、旧值被清掉（只读）
// 用法：npx tsx test/jail-legacy-restore.ts
import { buildFixtureMaps, buildTestMapIndustries, createRegistry, TABLES } from '../packages/shared/src/data';
import { createEngine } from '../packages/shared/src/engine/api';
import { scenario } from '../packages/shared/src/engine/testing/scenario';

const registry = createRegistry([...buildFixtureMaps(), buildTestMapIndustries()], { tables: TABLES });
const engine = createEngine(registry);
const sc = scenario({ map: 'test-industries', registry, players: ['human', 'human', 'human'] }).untilMenu(0);
sc.edit((s) => {
  s.engine = '0.4.0';
  // 1 号：0.4.0 时被关进台湾式监狱 26，关押前来路 12（旧版本会写 savedPrevNode）
  const a = s.players[1]!;
  a.st.jail = 2;
  a.node = 26;
  a.prevNode = 26;
  a.savedPrevNode = 12;
  a.placed = true;
  // 2 号：0.4.0 时刚获释，已被搬到保释格 16、来路 15
  const b = s.players[2]!;
  b.node = 16;
  b.prevNode = 15;
  b.placed = true;
});
const migrated = engine.migrateState(JSON.parse(JSON.stringify(sc.state)), 1);
console.log('validateState', engine.validateState(migrated), 'explain', sc.engine.explainState(migrated));
sc.state = migrated;
const from = sc.log.length;
sc.until((s) => sc.log.slice(from).some((e) => e.type === 'RETURNED' && e.seat === 1) && s.pending[0]?.kind === 'TURN_MENU' && s.pending[0]?.seat === 1);
const p1 = sc.state.players[1]!;
const p2 = sc.state.players[2]!;
console.log('seat1 after release', { node: p1.node, prevNode: p1.prevNode, savedPrevNode: p1.savedPrevNode, jail: p1.st.jail });
console.log('seat2 moved on from gate', { node: p2.node, prevNode: p2.prevNode });
const ok = p1.node === 26 && p1.prevNode === 26 && p1.savedPrevNode === null && p1.st.jail === 0;
console.log(ok ? 'OK' : 'UNEXPECTED');
