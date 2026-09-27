// 测试用（client-unit）：原版舞台的假棋盘（OrigStageHost）。不渲染：棋子、路面物件、神明、乞丐、恶人、机器娃娃都是空的
// Pixi 容器，位置按格号排成一行（x = 40·格号）；行走、跳一下按动画时钟等待真实时长。配合 fakeFlics 的合成 FLIC 与
// 真的 OrigFlics / OrigStage，在 node 里测 handler 编排下的时长（budget.test、realEngine 样本）与 FLIC、音效的选择。
import type { GodKind, RoadObject, SeatIndex, TileId, VillainKind } from '@rich4/shared/engine';
import { STEP_MS } from '@rich4/shared/view';
import { Container } from 'pixi.js';
import type { AudioPort } from '../../../../presentation/types';
import { type ActorStatus, NO_STATUS } from '../../../actors/ActorStatus';
import type { AnimClock } from '../../../anim/AnimClock';
import type { RoadWorld } from '../../../board/RoadObjectView';
import { FxSystem } from '../../../fx/FxSystem';
import { HOP_MS } from '../../../fx/timings';
import type { Pt } from '../../../iso/projection';
import { OrigFlics } from '../OrigFlics';
import {
  OrigStage,
  type OrigStageActor,
  type OrigStageHost,
  type OrigStageRoads,
  type OrigStageWalker,
} from '../OrigStage';
import type { FlicSfxSwitch } from '../stageAudio';
import type { FakeFlicPack } from './fakeFlics';

export const tilePosOf = (id: TileId): Pt => ({ x: id * 40, y: 200 });

export class FakeActor implements OrigStageActor {
  readonly root = new Container({ label: 'actor' });
  tile: TileId | null;
  destroyed = false;
  currentStatus: ActorStatus = NO_STATUS;
  god: GodKind | null = null;
  hops = 0;

  constructor(
    readonly seat: SeatIndex,
    tile: TileId,
    private readonly clock: AnimClock,
  ) {
    this.tile = tile;
  }

  boardPos(): Pt {
    return tilePosOf(this.tile ?? 1);
  }

  headPos(): Pt {
    const p = this.boardPos();
    return { x: p.x, y: p.y - 40 };
  }

  setStatus(s: ActorStatus): void {
    this.currentStatus = s;
    this.god = s.god;
  }

  setGod(kind: GodKind | null): void {
    this.god = kind;
    this.currentStatus = { ...this.currentStatus, god: kind };
  }

  hop(signal?: AbortSignal): Promise<void> {
    this.hops++;
    return this.clock.wait(HOP_MS, signal);
  }
}

class FakeWalker implements OrigStageWalker {
  readonly root = new Container();
  node: TileId;
  destroyed = false;

  constructor(
    node: TileId,
    private readonly clock: AnimClock,
  ) {
    this.node = node;
  }

  async walk(
    path: readonly TileId[],
    o: { stepMs?: number; signal?: AbortSignal; onStep?: (tile: TileId, i: number) => void } = {},
  ): Promise<void> {
    for (let i = 1; i < path.length; i++) {
      await this.clock.wait(o.stepMs ?? STEP_MS, o.signal);
      this.node = path[i]!;
      o.onStep?.(this.node, i);
    }
    if (path.length > 0) this.node = path[path.length - 1]!;
  }

  destroy(): void {
    this.destroyed = true;
    if (!this.root.destroyed) this.root.destroy();
  }
}

export class FakeRoads implements OrigStageRoads {
  readonly objects = new Map<number, { obj: RoadObject; root: Container }>();
  readonly gods = new Map<string, { kind: GodKind; root: Container }>();
  readonly beggars = new Map<number, { node: TileId; root: Container }>();
  readonly villains = new Map<VillainKind, FakeWalker>();
  syncs = 0;

  constructor(
    private readonly layer: Container,
    private readonly clock: AnimClock,
  ) {}

  private at(node: TileId): Container {
    const c = new Container();
    const p = tilePosOf(node);
    c.position.set(p.x, p.y);
    this.layer.addChild(c);
    return c;
  }

  sync(w: RoadWorld): void {
    this.syncs++;
    const ids = new Set(w.objects.map((o) => o.id));
    for (const [id, e] of this.objects) {
      if (!ids.has(id)) {
        e.root.destroy();
        this.objects.delete(id);
      }
    }
    for (const o of w.objects) if (!this.objects.has(o.id)) this.addObject(o);
    const gods = new Set<string>();
    for (const g of w.gods) {
      if (g.where.t !== 'road') continue;
      gods.add(`${g.kind}@${g.where.node}`);
      this.addGod(g.kind, g.where.node);
    }
    for (const [k, e] of this.gods) {
      if (!gods.has(k)) {
        e.root.destroy();
        this.gods.delete(k);
      }
    }
    for (const b of w.beggars) {
      const cur = this.beggars.get(b.seat);
      if (!cur) this.beggars.set(b.seat, { node: b.node, root: this.at(b.node) });
      else cur.node = b.node;
    }
    for (const v of w.villains) {
      if (v.onBoard && v.node > 0) {
        const a = this.villains.get(v.kind) ?? new FakeWalker(v.node, this.clock);
        a.node = v.node;
        this.villains.set(v.kind, a);
      } else this.villains.delete(v.kind);
    }
  }

  addObject(obj: RoadObject): Container | null {
    const cur = this.objects.get(obj.id);
    if (cur) return cur.root;
    const root = this.at(obj.node);
    this.objects.set(obj.id, { obj, root });
    return root;
  }

  detachObject(id: number): Container | null {
    const e = this.objects.get(id);
    if (!e) return null;
    this.objects.delete(id);
    return e.root;
  }

  objectOf(id: number): RoadObject | undefined {
    return this.objects.get(id)?.obj;
  }

  addGod(kind: GodKind, node: TileId): Container | null {
    const key = `${kind}@${node}`;
    const cur = this.gods.get(key);
    if (cur) return cur.root;
    const root = this.at(node);
    this.gods.set(key, { kind, root });
    return root;
  }

  detachGod(kind: GodKind, near?: TileId): Container | null {
    let key = near === undefined ? null : `${kind}@${near}`;
    if (key === null || !this.gods.has(key)) key = [...this.gods].find(([, e]) => e.kind === kind)?.[0] ?? null;
    if (key === null) return null;
    const e = this.gods.get(key)!;
    this.gods.delete(key);
    return e.root;
  }

  moveBeggar(seat: number, node: TileId): { root: Container; from: Pt; to: Pt; settle: () => void } | null {
    const e = this.beggars.get(seat);
    if (!e) return null;
    const from = tilePosOf(e.node);
    e.node = node;
    return { root: e.root, from, to: tilePosOf(node), settle: () => e.root.position.set(tilePosOf(node).x, 200) };
  }

  ensureVillain(kind: VillainKind, node: TileId): OrigStageWalker | null {
    const a = this.villains.get(kind) ?? new FakeWalker(node, this.clock);
    this.villains.set(kind, a);
    return a;
  }

  villainNode(kind: VillainKind): TileId | null {
    return this.villains.get(kind)?.node ?? null;
  }
}

export interface FakeStageOptions {
  clock: AnimClock;
  /** 座位（缺省 0..3）；棋子站在 2 + 座位 号格 */
  seats?: readonly SeatIndex[];
  /** 座位 → 角色号（缺省 = 座位号） */
  characters?: readonly number[];
  /** 地图节日表 */
  holidays?: { slot: number; flagsRaw: number }[];
  /** objectSprite 是否可用（缺省 true） */
  sprites?: boolean;
  /** 原版 FLIC 素材（null = 没有 FLIC，全部走 FxSystem 回退） */
  flics?: FakeFlicPack | null;
  flicSfx?: FlicSfxSwitch | null;
}

export interface FakeStage {
  stage: OrigStage;
  fx: FxSystem;
  host: OrigStageHost;
  roads: FakeRoads;
  actors: Map<SeatIndex, FakeActor>;
  flics: OrigFlics | null;
  /** 经 audio 端口放出的声音键 */
  sounds: string[];
  /** node 下的头顶气泡文字 */
  bubbles: string[];
  audio: AudioPort;
  dolls: number;
  shakes: number;
}

/** 假棋盘 + 真 OrigStage（FxSystem 不渲染；FLIC 来自合成素材，node 下没有画布、只按时间播放） */
export function createFakeStage(o: FakeStageOptions): FakeStage {
  const clock = o.clock;
  const overlay = new Container();
  const fxLayer = new Container();
  const objects = new Container();
  const fx = new FxSystem(overlay, fxLayer, clock);
  // node 里 Text 量字需要画布：头顶气泡只记次数
  const bubbles: string[] = [];
  if (typeof document === 'undefined') fx.bubble = (_at, text) => void bubbles.push(text);
  const roads = new FakeRoads(objects, clock);
  const actors = new Map<SeatIndex, FakeActor>();
  const seats = o.seats ?? ([0, 1, 2, 3] as const);
  for (const s of seats) actors.set(s, new FakeActor(s, 2 + s, clock));
  const sounds: string[] = [];
  const audio: AudioPort = { play: (id) => void sounds.push(id) };
  const out = { dolls: 0, shakes: 0 };
  const host: OrigStageHost = {
    ready: true,
    roads,
    actor: (seat) => actors.get(seat),
    anchorPos: (at, lift) => {
      if ('seat' in at) {
        const a = actors.get(at.seat);
        if (!a) return null;
        const p = a.boardPos();
        return { x: p.x, y: p.y - (lift ? 48 : 16) };
      }
      if ('tile' in at) return tilePosOf(at.tile);
      return { x: 400, y: 120 };
    },
    tilePos: (node) => tilePosOf(node),
    shake: () => {
      out.shakes++;
    },
    world: objects,
    viewCenter: () => ({ x: 300, y: 200 }),
    mapDef: {
      holidays: (o.holidays ?? []).map((h) => ({ month: 1, day: 1, kind: 0, ...h })),
    },
    characterOf: (seat) => (actors.has(seat) ? (o.characters?.[seat] ?? seat) : null),
    spawnDoll: (node) => {
      out.dolls++;
      return new FakeWalker(node, clock);
    },
    objectSprite: () => (o.sprites === false ? null : new Container()),
  };
  const flics = o.flics
    ? new OrigFlics({ pack: o.flics, clock, track: (node, outer) => fx.track(node, overlay, outer) })
    : null;
  const stage = new OrigStage(host, fx, { flics, flicSfx: o.flicSfx ?? null });
  return {
    stage,
    fx,
    host,
    roads,
    actors,
    flics,
    sounds,
    bubbles,
    audio,
    get dolls() {
      return out.dolls;
    },
    get shakes() {
      return out.shakes;
    },
  };
}
