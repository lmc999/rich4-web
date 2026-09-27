// 对局棋盘控制器：用 GameView 驱动 BoardView（地块归属/等级/设施、企业董事长、角色位置与可见性），
// 并实现演出端口 BoardPort（行走、镜头、飘字、金币、插旗、升级弹跳）。只 import Pixi 侧代码，不依赖 React。

import { CHARACTER_KEYS } from '@rich4/shared/data';
import type { LotId, SeatIndex, TileId } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import type { StagePort } from '../presentation/handlers/stage';
import { STEP_MS } from './actors/PlayerActor';
import { backOut } from './anim/easing';
import { tweenValue } from './anim/tween';
import { Fx } from './fx/Fx';
import { POP_MS } from './fx/timings';
import type { GameRenderer } from './GameRenderer';
import type { FacilityStyle } from './procedural/building/styles';
import type { Pose } from './procedural/character/rig';

export type Anchor = { seat: SeatIndex } | { tile: TileId } | { lot: LotId };
export type ActorPose = 'idle' | 'cheer' | 'sad' | 'hurt' | 'sleep' | 'cast';

export interface LotLookInput {
  owner: SeatIndex | null;
  level: number;
  facility?: FacilityStyle;
}

export interface BoardControllerOptions {
  /** 头顶名牌 */
  nameOf(seat: SeatIndex, view: GameView): string;
  /** 镜头是否自动跟随（设置里可关） */
  autoFollow(): boolean;
  /** 手动锁定跟随的座位（观战栏的「跟随」；非 null 时镜头一直跟它，不随行动者切换） */
  pinned?(): SeatIndex | null;
}

/** 角色头顶飘字的高度（像素） */
const HEAD_Y = 92;

export class BoardController {
  readonly fx: Fx;
  private readonly looks = new Map<string, string>();
  private readonly characters = new Map<number, number>();
  private readonly names = new Map<number, string>();
  private followSeat: SeatIndex | null = null;
  private highlighted: TileId[] = [];

  constructor(
    readonly renderer: GameRenderer,
    private readonly o: BoardControllerOptions,
  ) {
    this.fx = new Fx(renderer.layers.overlay, renderer.layers.fx, renderer.clock);
  }

  get ready(): boolean {
    return this.renderer.board.loaded;
  }

  private get board() {
    return this.renderer.board;
  }

  /**
   * M6/M7 棋盘舞台（路面物件、神明、恶人、乞丐与角色状态外观；fx 懒创建，同一棋盘只建一次）。
   * handlers 的 stageOf(ctx) 优先读它。
   */
  get stage(): StagePort | null {
    return this.ready ? this.fx.stageFor(this) : null;
  }

  // ───────────────────────── 同步 ─────────────────────────

  syncView(view: GameView): void {
    if (!this.ready) return;
    for (const l of view.lands) this.setLot(l.id, { owner: l.owner, level: l.level });
    for (const f of view.facilities) {
      this.setLot(f.id, { owner: f.owner, level: f.level, facility: f.level > 0 ? f.type : 'vacant' });
    }
    for (const c of view.companies) this.setLot(c.id, { owner: view.stocks[c.stock]?.chairman ?? null, level: 1 });
    for (const p of view.players) {
      const a = this.ensureActor(p.seat, p.character, this.o.nameOf(p.seat, view), p.node);
      if (!a) continue;
      a.root.visible = p.placed && p.node > 0;
      a.root.alpha = p.alive ? 1 : 0.45;
      // 正在走（被 reset 中止、还没收尾）时记下落点，收尾时落到快照位置而不是旧路径的终点
      if (a.root.visible) a.settleAt(p.node);
    }
    this.board.spreadActors();
    // 舞台（路面物件 / 神明 / 恶人 / 状态外观）随显示态一起同步：reset、快照、instant 模式与 TIME_REWOUND 之后立即追上
    this.stage?.syncWorld(view);
  }

  setLot(lot: LotId, look: LotLookInput): void {
    if (!this.ready) return;
    const key = `${look.owner}|${look.level}|${look.facility ?? ''}`;
    if (this.looks.get(lot) === key) return;
    this.looks.set(lot, key);
    this.board.setLotState(lot, {
      owner: look.owner,
      level: look.level,
      ...(look.facility ? { facility: look.facility } : {}),
    });
  }

  private ensureActor(seat: SeatIndex, character: number, name: string, node: TileId) {
    const board = this.board;
    let a = board.actor(seat);
    if (a && this.characters.get(seat) === character) {
      if (this.names.get(seat) !== name) {
        a.setName(name);
        this.names.set(seat, name);
      }
      return a;
    }
    const tile = node > 0 ? node : (board.def.tiles[0]?.id ?? 1);
    a = board.addActor(seat, null, name, tile);
    this.characters.set(seat, character);
    this.names.set(seat, name);
    const key = CHARACTER_KEYS[character as keyof typeof CHARACTER_KEYS];
    if (key) {
      this.renderer.loadCharacter(key).then(
        (frames) => {
          if (this.board.actor(seat) === a && this.characters.get(seat) === character) a.setFrames(frames);
        },
        () => {
          // 栅格化失败时保留占位棋子
        },
      );
    }
    return a;
  }

  // ───────────────────────── 演出端口 ─────────────────────────

  async walk(seat: SeatIndex, path: readonly TileId[], signal: AbortSignal, onStep?: (t: TileId, i: number) => void) {
    const a = this.board.actor(seat);
    if (!a || path.length === 0) return;
    a.root.visible = true;
    await a.walk(path, { stepMs: STEP_MS, signal, ...(onStep ? { onStep } : {}) });
    this.board.spreadActors();
  }

  placeActor(seat: SeatIndex, tile: TileId): void {
    const a = this.board.actor(seat);
    if (!a || !this.ready) return;
    a.root.visible = true;
    a.teleport(tile);
    this.board.spreadActors();
  }

  async hop(seat: SeatIndex, signal: AbortSignal): Promise<void> {
    await this.board.actor(seat)?.hop(signal);
  }

  setActorPose(seat: SeatIndex, pose: ActorPose): void {
    const p: Pose = pose === 'idle' ? 'idle0' : pose;
    this.board.actor(seat)?.setPose(p);
  }

  /** 锚点的 world 坐标（飘字位置按对象类型抬高） */
  anchorPos(at: Anchor, lift = false): { x: number; y: number } | null {
    if (!this.ready) return null;
    if ('seat' in at) {
      const a = this.board.actor(at.seat);
      if (!a) return null;
      const p = a.screenPos();
      return { x: p.x, y: p.y - (lift ? HEAD_Y : 30) };
    }
    if ('tile' in at) {
      try {
        const p = this.board.tileScreenPos(at.tile);
        return { x: p.x, y: p.y - (lift ? 40 : 0) };
      } catch {
        return null;
      }
    }
    const p = this.board.lotScreenPos(at.lot);
    if (!p) return null;
    const h = this.board.footprint(at.lot)?.heightPx ?? 0;
    return { x: p.x, y: p.y - (lift ? Math.max(40, h) : 0) };
  }

  async focus(at: Anchor, ms: number, signal: AbortSignal): Promise<void> {
    if (!this.o.autoFollow()) return;
    const p = this.anchorPos(at);
    if (!p) return;
    const cam = this.renderer.camera;
    if (cam.followPaused) return;
    await cam.panTo({ x: p.x, y: p.y - 30 }, ms, signal);
  }

  follow(seat: SeatIndex | null): void {
    this.followSeat = seat;
    const pin = this.o.pinned?.() ?? null;
    this.renderer.follow(pin !== null ? pin : this.o.autoFollow() ? seat : null);
  }

  /** 跟随设置变化后重新应用（锁定座位切换、自动跟随开关） */
  refollow(): void {
    this.follow(this.followSeat);
  }

  get followed(): SeatIndex | null {
    return this.followSeat;
  }

  floatText(at: Anchor, text: string, tone: 'gain' | 'loss' | 'info' | 'points'): void {
    const p = this.anchorPos(at, true);
    if (p) this.fx.floatText(p, text, tone);
  }

  async coinFlight(from: Anchor, to: Anchor, signal: AbortSignal): Promise<void> {
    const a = this.anchorPos(from);
    const b = this.anchorPos(to);
    if (!a || !b) return;
    await this.fx.coinFlight(a, b, signal);
  }

  async plantFlag(lot: LotId, seat: SeatIndex, signal: AbortSignal): Promise<void> {
    const p = this.anchorPos({ lot });
    if (p) await this.fx.plantFlag(p, seat, signal);
  }

  async popBuilding(lot: LotId, signal: AbortSignal): Promise<void> {
    const v = this.board.footprint(lot);
    if (!v?.building.visible) return;
    const s = v.building.scale;
    await tweenValue(
      0.25,
      1,
      POP_MS,
      (y) => {
        if (!v.building.destroyed) s.set(1, y);
      },
      { clock: this.renderer.clock, signal, ease: backOut },
    );
    if (!v.building.destroyed) s.set(1, 1);
  }

  pulseTile(tile: TileId): void {
    if (!this.ready) return;
    try {
      this.fx.pulse(this.board.tileScreenPos(tile));
    } catch {
      // 未知格
    }
  }

  /** 角色头顶的聊天 / 表情气泡（ui/social 的头顶气泡总线经 BoardCanvas 转发） */
  say(seat: SeatIndex, text: string, ms: number, emote = false): void {
    if (!this.ready) return;
    this.board.actor(seat)?.say(text, ms, emote);
  }

  shake(amp: number, ms: number): void {
    this.renderer.camera.shake(amp, ms);
  }

  clearFx(): void {
    this.fx.clear();
  }

  // ───────────────────────── 目标高亮（对话框代理的 BoardBridge 用） ─────────────────────────

  highlight(tiles: readonly TileId[], selected: TileId | null): void {
    if (!this.ready) return;
    const valid = tiles.filter((t) => this.board.geometry.hasTile(t));
    this.highlighted = valid;
    this.board.markers.setHighlight(valid);
    this.board.markers.select(selected !== null && this.board.geometry.hasTile(selected) ? selected : null);
  }

  get highlightedTiles(): readonly TileId[] {
    return this.highlighted;
  }

  /** 格中心的画布坐标（testHooks.tileScreenPos） */
  tileCanvasPos(id: TileId): { x: number; y: number } | null {
    if (!this.ready) return null;
    try {
      return this.renderer.camera.worldToScreen(this.board.tileScreenPos(id));
    } catch {
      return null;
    }
  }
}
