/**
 * 公开世界、实体级 diff 与 post 折叠（architecture §5.6；design/engine.md §12.1）。
 *
 * - publicWorld(s)：去掉 secret / flow / pending / counters 的世界（引用原对象，不拷贝）。
 * - diffPublic(prev, cur)：实体级比较，字段级 set（数组、对象字段整体替换；objects/gods/beggars/pools/lottery/noticeBoard
 *   整表替换）；set 里的值都是深拷贝，之后再改 cur 不会影响已生成的 post。
 * - applyPostPatch(view, post)：客户端 viewReducer 直接复用；不修改入参，返回新对象（未变的实体保持引用）。
 *
 * 结构保证：fold(applyPostPatch, publicWorld(prev), events.map(e => e.post)) ≡ publicWorld(next)。
 */
import type { PostPatch } from '../types/events';
import type { PublicWorld } from '../types/state';
import { cloneJson, jsonEqual } from './clone';

export function publicWorld(s: PublicWorld): PublicWorld {
  return {
    v: s.v,
    engine: s.engine,
    dataRef: s.dataRef,
    config: s.config,
    status: s.status,
    result: s.result,
    clock: s.clock,
    econ: s.econ,
    players: s.players,
    villains: s.villains,
    lands: s.lands,
    facilities: s.facilities,
    companies: s.companies,
    objects: s.objects,
    gods: s.gods,
    beggars: s.beggars,
    stocks: s.stocks,
    pools: s.pools,
    lottery: s.lottery,
    noticeBoard: s.noticeBoard,
  };
}

type Rec = Record<string, unknown>;

/** b 相对 a 变化了的字段（值深拷贝）；没有变化返回 null */
function diffFields(a: object, b: object): Rec | null {
  const x = a as Rec;
  const y = b as Rec;
  let set: Rec | null = null;
  for (const k of Object.keys(y)) {
    const v = y[k];
    if (!jsonEqual(x[k], v)) {
      set ??= {};
      set[k] = cloneJson(v);
    }
  }
  return set;
}

function diffEntities<E extends object, K extends keyof E & string>(
  prev: readonly E[],
  cur: readonly E[],
  key: K,
): { key: E[K]; set: Rec }[] {
  const out: { key: E[K]; set: Rec }[] = [];
  for (let i = 0; i < cur.length; i++) {
    const c = cur[i]!;
    const p = prev[i] !== undefined && prev[i]![key] === c[key] ? prev[i]! : prev.find((e) => e[key] === c[key]);
    const set = p === undefined ? diffFields({}, c) : diffFields(p, c);
    if (set) out.push({ key: c[key], set });
  }
  return out;
}

/** 世界里参与 diff 的部分（GameState 与 PublicWorld 都满足） */
export type DiffableWorld = Pick<
  PublicWorld,
  | 'status'
  | 'result'
  | 'clock'
  | 'econ'
  | 'players'
  | 'villains'
  | 'lands'
  | 'facilities'
  | 'companies'
  | 'objects'
  | 'gods'
  | 'beggars'
  | 'stocks'
  | 'pools'
  | 'lottery'
  | 'noticeBoard'
>;

/** 实体级 diff；没有任何变化时返回 undefined */
export function diffPublic(prev: DiffableWorld, cur: DiffableWorld): PostPatch | undefined {
  const p: PostPatch = {};
  let any = false;

  const players = diffEntities(prev.players, cur.players, 'seat');
  if (players.length > 0) {
    p.players = players.map((x) => ({ seat: x.key, set: x.set }));
    any = true;
  }
  const villains = diffEntities(prev.villains, cur.villains, 'kind');
  if (villains.length > 0) {
    p.villains = villains.map((x) => ({ kind: x.key, set: x.set }));
    any = true;
  }
  const lands = diffEntities(prev.lands, cur.lands, 'id');
  if (lands.length > 0) {
    p.lands = lands.map((x) => ({ id: x.key, set: x.set }));
    any = true;
  }
  const facilities = diffEntities(prev.facilities, cur.facilities, 'id');
  if (facilities.length > 0) {
    p.facilities = facilities.map((x) => ({ id: x.key, set: x.set }));
    any = true;
  }
  const companies = diffEntities(prev.companies, cur.companies, 'id');
  if (companies.length > 0) {
    p.companies = companies.map((x) => ({ id: x.key, set: x.set }));
    any = true;
  }
  const stocks = diffEntities(prev.stocks, cur.stocks, 'idx');
  if (stocks.length > 0) {
    p.stocks = stocks.map((x) => ({ idx: x.key, set: x.set }));
    any = true;
  }
  if (!jsonEqual(prev.objects, cur.objects)) {
    p.objects = cloneJson(cur.objects);
    any = true;
  }
  if (!jsonEqual(prev.gods, cur.gods)) {
    p.gods = cloneJson(cur.gods);
    any = true;
  }
  if (!jsonEqual(prev.beggars, cur.beggars)) {
    p.beggars = cloneJson(cur.beggars);
    any = true;
  }
  const clock = diffFields(prev.clock, cur.clock);
  if (clock) {
    p.clock = clock;
    any = true;
  }
  const econ = diffFields(prev.econ, cur.econ);
  if (econ) {
    p.econ = econ;
    any = true;
  }
  if (!jsonEqual(prev.pools, cur.pools)) {
    p.pools = cloneJson(cur.pools);
    any = true;
  }
  if (!jsonEqual(prev.lottery, cur.lottery)) {
    p.lottery = cloneJson(cur.lottery);
    any = true;
  }
  if (!jsonEqual(prev.noticeBoard, cur.noticeBoard)) {
    p.noticeBoard = cloneJson(cur.noticeBoard);
    any = true;
  }
  if (prev.status !== cur.status) {
    p.status = cur.status;
    any = true;
  }
  if (!jsonEqual(prev.result, cur.result)) {
    p.result = cloneJson(cur.result);
    any = true;
  }
  return any ? p : undefined;
}

/** 能接受 PostPatch 的世界：引擎的 PublicWorld 与客户端的 GameView 都满足 */
export interface PatchableWorld {
  status: PublicWorld['status'];
  result: PublicWorld['result'];
  clock: PublicWorld['clock'];
  econ: PublicWorld['econ'];
  players: readonly { seat: number }[];
  villains: readonly { kind: string }[];
  lands: readonly { id: string }[];
  facilities: readonly { id: string }[];
  companies: readonly { id: string }[];
  stocks: readonly { idx: number }[];
  objects: PublicWorld['objects'];
  gods: PublicWorld['gods'];
  beggars: PublicWorld['beggars'];
  pools: PublicWorld['pools'];
  lottery: PublicWorld['lottery'];
  noticeBoard: PublicWorld['noticeBoard'];
}

function patchList<E extends object>(
  list: readonly E[],
  patches: readonly { set: object }[],
  match: (e: E, i: number) => number,
): E[] {
  const out = list.slice();
  for (let i = 0; i < out.length; i++) {
    const j = match(out[i]!, i);
    if (j >= 0) out[i] = { ...out[i]!, ...(patches[j]!.set as Partial<E>) };
  }
  return out;
}

/**
 * 客户端 viewReducer：把一个事件的 post 折叠进视图（不修改入参）。
 * post 为 undefined 时原样返回。实体按 seat / kind / id / idx 匹配，set 覆盖同名字段。
 */
export function applyPostPatch<V extends PatchableWorld>(view: V, post: PostPatch | undefined): V {
  if (!post) return view;
  const out: Rec = { ...(view as unknown as Rec) };
  if (post.players) {
    const ps = post.players;
    out.players = patchList(view.players, ps, (e) => ps.findIndex((x) => x.seat === e.seat));
  }
  if (post.villains) {
    const vs = post.villains;
    out.villains = patchList(view.villains, vs, (e) => vs.findIndex((x) => x.kind === e.kind));
  }
  if (post.lands) {
    const ls = post.lands;
    out.lands = patchList(view.lands, ls, (e) => ls.findIndex((x) => x.id === e.id));
  }
  if (post.facilities) {
    const fs = post.facilities;
    out.facilities = patchList(view.facilities, fs, (e) => fs.findIndex((x) => x.id === e.id));
  }
  if (post.companies) {
    const cs = post.companies;
    out.companies = patchList(view.companies, cs, (e) => cs.findIndex((x) => x.id === e.id));
  }
  if (post.stocks) {
    const ss = post.stocks;
    out.stocks = patchList(view.stocks, ss, (e) => ss.findIndex((x) => x.idx === e.idx));
  }
  if (post.objects) out.objects = post.objects;
  if (post.gods) out.gods = post.gods;
  if (post.beggars) out.beggars = post.beggars;
  if (post.clock) out.clock = { ...view.clock, ...post.clock };
  if (post.econ) out.econ = { ...view.econ, ...post.econ };
  if (post.pools) out.pools = post.pools;
  if (post.lottery) out.lottery = post.lottery;
  if (post.noticeBoard) out.noticeBoard = post.noticeBoard;
  if (post.status !== undefined) out.status = post.status;
  if (post.result !== undefined) out.result = post.result;
  return out as unknown as V;
}

/** 依次折叠一批事件的 post */
export function foldPosts<V extends PatchableWorld>(view: V, events: readonly { post?: PostPatch }[]): V {
  let v = view;
  for (const e of events) v = applyPostPatch(v, e.post);
  return v;
}
