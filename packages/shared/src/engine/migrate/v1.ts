/**
 * state 结构 v1（STATE_SCHEMA_VERSION = 1）：M1 的基线，没有更早的版本需要迁移。
 * 以后 state 结构变化时：STATE_SCHEMA_VERSION 加 1，新建 v{n}.ts 导出 migrateV{n-1}ToV{n}，
 * 在 migrate/index.ts 的 MIGRATIONS 登记，并为每一步补一个 fixture 测试（design/engine.md §15）。
 *
 * v1 之内只做「向后兼容的加字段」：新字段有一个与旧行为等价的缺省值时不升 STATE_SCHEMA_VERSION，由 identityV1 给旧快照补上
 * （服务器读档与重启恢复都先经 migrateState，见 apps/server SaveService / RoomManager）。已补的字段：
 * - 0.6.0 PlayerState.parked（梦游卡停放的座驾）→ null：0.5.x 中梦游卡时座驾没有停放，梦游结束不装回，等价于 null；
 * - 0.6.0 EngineerState.dice（工程车到期换回时恢复的骰子数）→ 换回座驾的上限（步行 1、机车 2、汽车 3）：0.5.x 到期时
 *   就按上限设骰子数，等价（PlayerState.engineer 与 parked.engineer 都补）
 */
import { VEHICLE_MAX_DICE } from '../../data/tables/setup';

export const V1 = 1;

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);

/** 工程车状态缺 dice 时按换回座驾的上限补（restore 不认识时不补，留给结构校验去报） */
function fillEngineer(e: unknown): void {
  if (!isObj(e) || Object.hasOwn(e, 'dice')) return;
  const r = e.restore;
  if (r === 'walk' || r === 'moto' || r === 'car') e.dice = VEHICLE_MAX_DICE[r];
}

/** 给一组玩家补上后来新增的字段（缺省值见文件头）；不是数组或元素不是对象时原样留给结构校验去报 */
function fillPlayers(players: unknown): void {
  if (!Array.isArray(players)) return;
  for (const p of players) {
    if (!isObj(p)) continue;
    if (!Object.hasOwn(p, 'parked')) p.parked = null;
    fillEngineer(p.engineer);
    if (isObj(p.parked)) fillEngineer(p.parked.engineer);
  }
}

/** v1 → v1：深拷贝，补上 v1 之内新增的字段（含时光机锚点里的世界）；调用方随后做结构校验 */
export function identityV1(state: unknown): unknown {
  const s = structuredClone(state);
  if (!isObj(s)) return s;
  fillPlayers(s.players);
  const secret = s.secret;
  if (isObj(secret)) {
    const anchors = [secret.timeAnchor, ...(Array.isArray(secret.timeAnchors) ? secret.timeAnchors : [])];
    for (const a of anchors) if (isObj(a) && isObj(a.world)) fillPlayers(a.world.players);
  }
  return s;
}
