/**
 * 不变量（design/engine.md §15）。checkInvariants 返回违反项的说明（空数组表示全部成立），
 * validateState 在结构校验通过后调用它；fuzz 与模拟脚本每步都会检查。
 *
 * 1 只含 JSON 值（可往返）；金额、天数都是安全整数（momentum 除外）
 * 2 牌堆守恒：每种卡 pools.cards[c] + Σ手牌 == 初始张数（合计 100）
 * 3 道具池守恒（1..8）：库存 + Σ背包 + 装备中的机车 / 汽车 + 地面路障 / 地雷 / 炸弹 + 身上的炸弹 == 10
 * 4 股本守恒：有公司的股票 Σ持股 + float + reserved == 10000；其余 Σ持股 + float == 地图流通股
 * 5 资金台账：Σ(cash + deposit) + 公库 + Σ公司本月盈余 == 开局总额 + minted − burned
 * 6 地产合法：地主是在场座位或 null（对局已结束时允许出局者）；等级不超过上限；连锁店 ≤1 级；0 级设施为公园
 * 7 每格至多 1 个物件；每对神明搭档至多 1 个在场；附身的神明与玩家的 god 字段一致
 * 8 坐牢 / 住院中的玩家位于对应关押格
 * 9 进行中时 pending 非空、每个 pending 的 frameId 都在栈中、每座位至多 1 个；ROOT 在栈底且只有一个
 * 10 经济（M4，进行中时）：董事长与持股一致（严格最多、平手保留现任）；乐透号码只属于在场座位；
 *    贷款 ≥ 0 且有贷款 ⇔ 有到期日；融资 ≥ 0；研发只挂在已建成、等级 ≥ 项目的研究所上
 */
import { CARDS } from '../../data/tables/cards';
import { ECON } from '../../data/tables/economy';
import { GOD, ITEM, POOL_ITEM_IDS } from '../../data/tables/ids';
import { VEHICLE_ITEM } from '../../data/tables/setup';
import { decisionNumber } from '../core/ids';
import type { EngineMap } from '../core/mapCache';
import { FACILITY_LEVEL_CAP } from '../rules/landMutation';
import { chairmanFor } from '../rules/stock';
import type { GameState } from '../types/state';

function pathText(path: readonly (string | number)[]): string {
  return `s${path.map((x) => (typeof x === 'number' ? `[${x}]` : `.${x}`)).join('')}`;
}

/**
 * 只含 JSON 值：普通对象、数组、字符串、布尔、null 与有限数；数字必须是安全整数（floatKey 命名的字段除外）；不得有 undefined。
 * 路径只在出错时拼接（fuzz 与模拟每步都跑，避免逐节点构造字符串或闭包）。
 */
function checkJsonValues(v: unknown, path: (string | number)[], out: string[], floatKey: string): void {
  const t = typeof v;
  if (t === 'number') {
    const n = v as number;
    if (Number.isSafeInteger(n)) return;
    if (!Number.isFinite(n)) out.push(`${pathText(path)}: non-finite number`);
    else if (path[path.length - 1] !== floatKey) out.push(`${pathText(path)}: not a safe integer (${n})`);
    return;
  }
  if (t === 'string' || t === 'boolean' || v === null) return;
  if (t !== 'object') {
    out.push(`${pathText(path)}: ${t} is not JSON`);
    return;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      path.push(i);
      checkJsonValues(v[i], path, out, floatKey);
      path.pop();
    }
    return;
  }
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) {
    out.push(`${pathText(path)}: not a plain object`);
    return;
  }
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    path.push(k);
    if (o[k] === undefined) out.push(`${pathText(path)}: undefined`);
    else checkJsonValues(o[k], path, out, floatKey);
    path.pop();
  }
}

const GOD_PAIRS: readonly (readonly [number, number])[] = [
  [GOD.SMALL_WEALTH, GOD.BIG_WEALTH],
  [GOD.SMALL_FORTUNE, GOD.BIG_FORTUNE],
  [GOD.SMALL_POOR, GOD.BIG_POOR],
  [GOD.SMALL_MISFORTUNE, GOD.BIG_MISFORTUNE],
  [GOD.ANGEL, GOD.DEVIL],
  [GOD.DOG, GOD.EARTH_GOD],
];

export function checkInvariants(s: GameState, em: EngineMap): string[] {
  const out: string[] = [];
  const idx = em.index;

  // 1（唯一允许的浮点字段是股价动量 momentum）
  checkJsonValues(s, [], out, 'momentum');

  // 基本形状
  for (let i = 1; i < s.players.length; i++) {
    if (s.players[i]!.seat <= s.players[i - 1]!.seat) out.push('players are not sorted by unique seat');
  }
  if (s.lands.length !== em.lands.length) out.push('lands length does not match the map');
  if (s.facilities.length !== em.facilities.length) out.push('facilities length does not match the map');
  if (s.companies.length !== em.companies.length) out.push('companies length does not match the map');
  if (s.stocks.length !== em.def.stocks.length) out.push('stocks length does not match the map');

  // 2 牌堆守恒
  let deckTotal = 0;
  for (const def of CARDS) {
    let n = s.pools.cards[def.id] ?? 0;
    for (const p of s.players) for (const c of p.cards) if (c === def.id) n++;
    deckTotal += n;
    if (n !== def.deckCount) out.push(`card ${def.id}: deck + hands = ${n}, want ${def.deckCount}`);
  }
  if (deckTotal !== 100) out.push(`card total ${deckTotal}, want 100`);
  for (const p of s.players)
    if (p.cards.length > ECON.HAND_MAX) out.push(`seat ${p.seat} holds ${p.cards.length} cards`);

  // 3 道具池守恒
  for (const it of POOL_ITEM_IDS) {
    let n = s.pools.items[it] ?? 0;
    for (const p of s.players) {
      n += p.items[it] ?? 0;
      if (VEHICLE_ITEM[p.vehicle] === it) n += 1;
      if (it === ITEM.TIME_BOMB && p.bomb !== null) n += 1;
    }
    for (const o of s.objects) {
      if (
        (it === ITEM.ROADBLOCK && o.kind === 'roadblock') ||
        (it === ITEM.MINE && o.kind === 'mine') ||
        (it === ITEM.TIME_BOMB && o.kind === 'bomb')
      ) {
        n++;
      }
    }
    if (n !== ECON.ITEM_POOL_INIT) out.push(`item ${it}: pool + held + placed = ${n}, want ${ECON.ITEM_POOL_INIT}`);
  }
  for (const p of s.players) {
    p.items.forEach((n, it) => {
      if (n > ECON.ITEM_MAX) out.push(`seat ${p.seat} holds ${n} of item ${it}`);
    });
  }

  // 4 股本守恒
  s.stocks.forEach((st, i) => {
    let held = 0;
    for (const p of s.players) held += p.holdings[i]?.shares ?? 0;
    const company = s.companies.find((c) => c.stock === i);
    const def = em.def.stocks[i];
    if (company) {
      const total = held + st.float + company.reserved;
      if (total !== ECON.STOCK_TOTAL_SHARES) out.push(`stock ${i}: shares ${total}, want ${ECON.STOCK_TOTAL_SHARES}`);
    } else if (def && held + st.float !== def.float) {
      out.push(`stock ${i}: held + float = ${held + st.float}, want ${def.float}`);
    }
  });

  // 5 资金台账
  let money = s.econ.pool;
  for (const p of s.players) money += p.cash + p.deposit;
  for (const c of s.companies) money += c.surplusMonth;
  const expected = s.econ.initialFund * s.players.length + s.econ.ledger.minted - s.econ.ledger.burned;
  if (money !== expected) out.push(`ledger: money ${money} != expected ${expected}`);

  // 6 地产合法
  const aliveSeats = new Set(s.players.filter((p) => p.alive).map((p) => p.seat));
  const allSeats = new Set(s.players.map((p) => p.seat));
  const ownerOk = (o: number | null) =>
    o === null || (s.status === 'over' ? allSeats.has(o as never) : aliveSeats.has(o as never));
  for (const l of s.lands) {
    if (!ownerOk(l.owner)) out.push(`${l.id}: bad owner ${l.owner}`);
    if (l.chain && l.level > 1) out.push(`${l.id}: chain store at level ${l.level}`);
  }
  for (const f of s.facilities) {
    if (!ownerOk(f.owner)) out.push(`${f.id}: bad owner ${f.owner}`);
    if (f.level > FACILITY_LEVEL_CAP[f.type]) out.push(`${f.id}: level ${f.level} > cap of ${f.type}`);
    if (f.level === 0 && f.type !== 'park') out.push(`${f.id}: level 0 facility of type ${f.type}`);
  }

  // 7 物件与神明
  const objNodes = new Set<number>();
  for (const o of s.objects) {
    if (objNodes.has(o.node)) out.push(`tile ${o.node} has more than one object`);
    objNodes.add(o.node);
    if (!em.hasTile(o.node)) out.push(`object on unknown tile ${o.node}`);
  }
  for (const [a, b] of GOD_PAIRS) {
    const present = s.gods.filter((g) => (g.kind === a || g.kind === b) && g.where.t !== 'absent').length;
    if (present > 1) out.push(`god pair ${a}/${b} has ${present} on board`);
  }
  for (const g of s.gods) {
    if (g.where.t !== 'attached') continue;
    const seat = g.where.seat;
    const p = s.players.find((x) => x.seat === seat);
    if (!p || p.god?.kind !== g.kind) out.push(`god slot ${g.slot} attached to seat ${seat} inconsistently`);
  }

  // 8 关押位置
  for (const p of s.players) {
    if (!p.alive) continue;
    if (p.placed && !em.hasTile(p.node)) out.push(`seat ${p.seat} on unknown tile ${p.node}`);
    if (p.st.jail !== 0 && p.node !== idx.jailHold) out.push(`seat ${p.seat} is jailed but not at ${idx.jailHold}`);
    if (p.st.hospital !== 0 && p.node !== idx.hospitalHold) {
      out.push(`seat ${p.seat} is hospitalized but not at ${idx.hospitalHold}`);
    }
  }

  // 10 经济
  if (s.status === 'playing') {
    s.stocks.forEach((st, i) => {
      const want = chairmanFor(s.players, i, st.chairman);
      if (want !== st.chairman) out.push(`stock ${i}: chairman ${st.chairman}, want ${want}`);
    });
    s.lottery.owners.forEach((o, i) => {
      if (o !== null && !aliveSeats.has(o)) out.push(`lottery number ${i + 1} owned by ${o} who is out`);
    });
  }
  for (const p of s.players) {
    if (p.loan < 0) out.push(`seat ${p.seat}: negative loan ${p.loan}`);
    if (p.alive && p.loan > 0 !== (p.loanDue !== 0)) out.push(`seat ${p.seat}: loan ${p.loan} with due ${p.loanDue}`);
    if (p.finance < 0) out.push(`seat ${p.seat}: negative finance ${p.finance}`);
  }
  for (const f of s.facilities) {
    const r = f.research;
    if (r === null) continue;
    if (f.type !== 'lab' || f.level < r.project || f.owner === null) {
      out.push(`${f.id}: research ${r.project} on ${f.type} level ${f.level}`);
    }
  }

  // 9 帧栈与待决策
  if (s.flow[0]?.k !== 'ROOT') out.push('ROOT is not at the bottom of the flow');
  if (s.flow.filter((f) => f.k === 'ROOT').length !== 1) out.push('flow must contain exactly one ROOT');
  const fids = new Set<number>();
  for (const f of s.flow) {
    if (fids.has(f.fid)) out.push(`duplicate frame id ${f.fid}`);
    fids.add(f.fid);
    if (f.fid > s.counters.frame) out.push(`frame id ${f.fid} > counters.frame`);
  }
  if (s.status === 'playing') {
    if (s.pending.length === 0) out.push('playing but no pending decision');
    if (s.result !== null) out.push('playing but result is set');
  } else {
    if (s.pending.length > 0) out.push('game over but pending decisions remain');
    if (s.result === null) out.push('game over without result');
  }
  const pendingSeats = new Set<number>();
  const ids = new Set<string>();
  for (const d of s.pending) {
    if (!fids.has(d.frameId)) out.push(`pending ${d.id} refers to missing frame ${d.frameId}`);
    if (pendingSeats.has(d.seat)) out.push(`seat ${d.seat} has more than one pending decision`);
    pendingSeats.add(d.seat);
    if (ids.has(d.id)) out.push(`duplicate decision id ${d.id}`);
    ids.add(d.id);
    const n = decisionNumber(d.id);
    if (n === null || n > s.counters.decision) out.push(`decision id ${d.id} is ahead of counters.decision`);
    const p = s.players.find((x) => x.seat === d.seat);
    if (!p?.alive) out.push(`pending ${d.id} belongs to a player who is out`);
  }
  return out;
}
