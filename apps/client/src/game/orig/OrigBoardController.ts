// 原版棋盘控制器（skin/BoardSurface 的 BoardControllerLike；presentation 的 BoardPort）：用 GameView 驱动原版棋盘
// （地块归属 / 等级 / 连锁店 / 设施 / 涨价查封、企业董事长、角色位置与可见性），并实现演出端口
// （掷骰动作、行走、跳伞降落、镜头、飘字、金币、插旗、升级弹跳、格子脉冲、气泡）。等待掷骰时人物静止站立，
// 收到掷骰结果（DICE_ROLLED）才播持骰动作（throwDice）。舞台为 stage/OrigStage（原版 FLIC、原版精灵与
// FxSystem 回退；A8），FLIC 来自素材包（stage/OrigFlics），同步音效经事件的 ctx.audio 播放。
// 地产主人色用原版角色代表色（shared/data CHARACTERS[c].color；与 ownerMark 按角色画好的旗子一致）。
import { CHARACTER_KEYS, CHARACTERS, type CharacterId, type LotId } from '@rich4/shared/data';
import type { SeatIndex, TileId } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { Graphics, Sprite } from 'pixi.js';
import type { Anchor, FloatTone, LotLook } from '../../presentation/types';
import type { BoardControllerLike, BoardControllerOptions } from '../../skin/BoardSurface';
import type { FlicPlayer } from '../../skin/flic/FlicPlayer';
import type { DiceAnchor } from '../../store/uiStore';
import { STEP_MS } from '../actors/PlayerActor';
import { backOut } from '../anim/easing';
import { FxSystem } from '../fx/FxSystem';
import { FLAG_MS, PARTICLE_LIMITS } from '../fx/timings';
import type { Pt } from '../iso/projection';
import { type OrigActor, PARACHUTE_FIT_MS } from './OrigActor';
import type { OrigLotLook } from './OrigBoardView';
import type { OrigRenderer } from './OrigRenderer';
import type { OrigRoads } from './OrigRoads';
import { defaultFacing } from './poses';
import { parachuteUse } from './stage/flicPlan';
import { OrigFlics } from './stage/OrigFlics';
import { OrigStage } from './stage/OrigStage';
import { appFlicSfx, type FlicSfxSwitch } from './stage/stageAudio';

export function characterColor(c: number | null | undefined): number {
  const def = c === null || c === undefined ? undefined : CHARACTERS[c as CharacterId];
  return def ? Number.parseInt(def.color.slice(1), 16) : 0xffffff;
}

/** 棋盘伞 FLIC 的来源（素材包的 loadFlic；合成包没有时为 null） */
export type ParachuteSource = (character: number, signal: AbortSignal) => Promise<FlicPlayer | null>;

export class OrigBoardController implements BoardControllerLike {
  readonly fx: FxSystem;
  private readonly stageObj: OrigStage;
  private readonly looks = new Map<string, string>();
  private readonly characters = new Map<number, number>();
  private readonly names = new Map<number, string>();
  private followSeat: SeatIndex | null = null;
  private highlighted: TileId[] = [];

  /** 原版 FLIC（素材包不支持 FLIC 时为 null） */
  readonly flics: OrigFlics | null;

  constructor(
    readonly renderer: OrigRenderer,
    private readonly o: BoardControllerOptions & {
      parachute?: ParachuteSource;
      /** 音频导演层的 flicSfx 开关（缺省接 app 的音频；null 不接） */
      flicSfx?: FlicSfxSwitch | null;
    },
  ) {
    const layers = renderer.layers;
    this.fx = new FxSystem(layers.overlay, layers.fx, renderer.clock);
    this.fx.attachScreen(layers.screenFx, () => ({
      width: renderer.app.screen.width,
      height: renderer.app.screen.height,
    }));
    const fps = renderer.app.ticker.maxFPS;
    this.fx.setParticleLimit(fps > 0 && fps <= 30 ? PARTICLE_LIMITS.low : PARTICLE_LIMITS.high);
    renderer.owners = {
      character: (seat) => this.characters.get(seat) ?? null,
      color: (seat) => characterColor(this.characters.get(seat)),
    };
    const self = this;
    const pack = renderer.assets.pack;
    this.flics = pack.loadFlic
      ? new OrigFlics({
          pack,
          clock: renderer.clock,
          track: (node, outer) => this.fx.track(node, this.fx.overlay, outer),
          smoothing: () => renderer.assets.smoothing.sprites,
          pin: (node, at) => renderer.pinToBoard(node, at),
        })
      : null;
    this.stageObj = new OrigStage(
      {
        get ready() {
          return self.ready;
        },
        get roads() {
          return self.roads;
        },
        actor: (seat) => this.actor(seat),
        anchorPos: (at, lift) => this.anchorPos(at, lift),
        tilePos: (node) => this.renderer.boardView?.tilePos(node) ?? null,
        tileWorld: (node) => this.renderer.boardView?.tileWorld(node) ?? null,
        insideWorld: (b) => {
          const v = this.renderer.boardView;
          if (!v) return null;
          if (b.t === 'landmark') return v.landmarkWorld(b.kind);
          return b.t === 'lot' ? v.lotWorld(b.lot) : null;
        },
        spreadActors: () => this.renderer.spreadActors(),
        shake: (amp, ms) => this.shake(amp, ms),
        get world() {
          return self.renderer.layers.world;
        },
        viewCenter: () => (this.ready ? { ...this.renderer.camera.center } : null),
        get mapDef() {
          return self.renderer.mapDef;
        },
        characterOf: (seat) => this.characters.get(seat) ?? null,
        spawnDoll: (node) => this.renderer.spawnDoll(node),
        objectSprite: (key) => this.renderer.objectSprite(key),
      },
      this.fx,
      { flics: this.flics, flicSfx: o.flicSfx === undefined ? appFlicSfx() : o.flicSfx },
    );
    // 演出里直接用到的原版精灵先取（炸弹贴上 / 转移、机器娃娃），免得第一次演出时还在下载
    for (const k of ['object.bomb', 'npc.doll.stand', 'npc.doll.walk']) void renderer.assets.sheet(k);
    renderer.onDestroy(() => {
      this.stageObj.dispose();
      this.flics?.clear();
    });
  }

  get ready(): boolean {
    return this.renderer.loaded && this.renderer.roads !== null;
  }

  get stage(): OrigStage | null {
    return this.ready ? this.stageObj : null;
  }

  get roads(): OrigRoads {
    return this.renderer.roads!;
  }

  actor(seat: number): OrigActor | undefined {
    return this.renderer.actor(seat);
  }

  // ───────────────────────── 同步 ─────────────────────────

  syncView(view: GameView): void {
    if (!this.ready) return;
    for (const p of view.players) this.characters.set(p.seat, p.character);
    for (const l of view.lands) {
      this.applyLot(l.id, { owner: l.owner, level: l.level, chain: l.chain, mark: l.mark?.kind ?? null });
    }
    for (const f of view.facilities) {
      this.applyLot(f.id, {
        owner: f.owner,
        level: f.level,
        facility: f.level > 0 ? f.type : 'vacant',
        mark: f.mark?.kind ?? null,
      });
    }
    for (const c of view.companies) this.applyLot(c.id, { owner: view.stocks[c.stock]?.chairman ?? null, level: 1 });
    const cur = view.clock.cursor.t === 'seat' ? view.clock.cursor.seat : null;
    const tileWorld = (id: TileId): Pt | null => this.renderer.boardView?.tileWorld(id) ?? null;
    for (const p of view.players) {
      const a = this.ensureActor(p.seat, p.character, this.o.nameOf(p.seat, view), p.node);
      if (!a) continue;
      const visible = p.placed && p.node > 0;
      if (visible && !a.root.visible && !a.isWalking) {
        // reset / 快照之后：朝向按来路，缺失时用确定性默认
        a.setFacing(defaultFacing(p.seat, this.facingFrom(p.node, p.prevNode), tileWorld(p.node)));
      }
      a.root.visible = visible;
      a.root.alpha = p.alive ? 1 : 0.45;
      // 批次结束（或快照）时还在等降落的（放上棋盘后没有接着 hop）：直接出现在落点上
      a.cancelDrop();
      if (visible) a.settleAt(p.node);
      a.setCurrent(cur === p.seat);
      // 批尾（或快照）：掷骰动作都已播完、行走也已结束，持骰姿态一律收起，等待掷骰时是静止的站姿
      a.clearThrow();
    }
    // 先同步状态外观（交通工具、冬眠 ZZZ 会改变身高与名牌要让开的高度），再按同格多人错开。
    // 批尾 / 快照：本回合获释的留置一律解除（演出都已播完或被跳过）
    this.stageObj.holdInside(null);
    this.stageObj.syncWorld(view);
    this.renderer.spreadActors();
  }

  /**
   * 快照后定朝向用的「来处」：来路格；获释后还没走（来路 = 关押格本身）时是监狱 / 医院景观——原版获释时朝向 = 景观 → 关押格
   * （exe v2.06 0x40d184），走出来以后不改朝向
   */
  private facingFrom(node: TileId, prev: TileId): Pt | null {
    const v = this.renderer.boardView;
    if (!v || prev <= 0) return null;
    if (prev !== node) return v.tileWorld(prev);
    const hold = this.renderer.mapDef?.tiles.find((t) => t.id === node)?.holdFor;
    return hold ? v.landmarkWorld(hold) : null;
  }

  private applyLot(lot: LotId, look: OrigLotLook): void {
    const key = `${look.owner}|${look.level}|${look.facility ?? ''}|${look.chain ?? ''}|${look.mark ?? ''}|${
      look.owner === null ? '' : (this.characters.get(look.owner) ?? '')
    }`;
    if (this.looks.get(lot) === key) return;
    this.looks.set(lot, key);
    this.renderer.boardView?.setLot(lot, look);
  }

  /** BoardPort.setLot（批次中途：连锁店与涨价查封标记保持上一次同步的值，见 critique 第 6 条） */
  setLot(lot: LotId, look: LotLook): void {
    if (!this.ready) return;
    const prev = this.renderer.boardView?.lotLook(lot);
    this.applyLot(lot, {
      owner: look.owner,
      level: look.level,
      ...(look.facility ? { facility: look.facility } : {}),
      chain: prev?.chain ?? false,
      mark: prev?.mark ?? null,
    });
  }

  private ensureActor(seat: SeatIndex, character: number, name: string, node: TileId): OrigActor | null {
    const r = this.renderer;
    let a = r.actor(seat);
    if (a && a.kind.t === 'player' && a.kind.character === character) {
      if (this.names.get(seat) !== name) {
        a.setName(name);
        this.names.set(seat, name);
      }
      return a;
    }
    const tile = node > 0 ? node : (r.mapDef?.tiles[0]?.id ?? 1);
    a = r.addActor(seat, character, name, tile, characterColor(character));
    a.root.visible = false;
    this.names.set(seat, name);
    // 棋盘伞 FLIC：先按 flic-map 的用途找（char.parachuteBoard.<c>），找不到再按条目键 char.<c>.parachute
    const para = this.o.parachute;
    const flics = this.flics;
    if (flics || para) {
      a.parachute = async (signal) => {
        const byUse = flics?.resolve(parachuteUse(character))
          ? await flics.player(parachuteUse(character), signal)
          : null;
        return byUse ?? (para ? para(character, signal) : null);
      };
    }
    // 棋盘伞 FLIC 的可用时长按当前节奏的 PARACHUTE 预算（original 节奏原速播完）
    a.dropFitMs = () => this.stageObj.parachuteFitMs(PARACHUTE_FIT_MS);
    // 姿态库懒加载：站 / 走 / 持骰先取（地图有快艇节点时连快艇的站 / 走 / 持骰一起取——快艇不是状态外观，OrigActor.preload
    // 不会因为进了快艇节点而预取，第一次在快艇上掷骰不能等现场下载；其余在状态变化时预取）
    const boat = r.skin.boatTiles.length > 0 ? ['boat.stand', 'boat.walk', 'boat.dice'] : [];
    const keys = ['stand', 'walk', 'dice', ...boat];
    for (const k of keys) void r.assets.sheet(`char.${character}.${k}`);
    return a;
  }

  // ───────────────────────── 演出端口 ─────────────────────────

  async walk(seat: SeatIndex, path: readonly TileId[], signal: AbortSignal, onStep?: (t: TileId, i: number) => void) {
    const a = this.actor(seat);
    if (!a || path.length === 0) return;
    a.root.visible = true;
    a.clearThrow();
    a.setOffset({ x: 0, y: 0 });
    await a.walk(path, { stepMs: STEP_MS, signal, ...(onStep ? { onStep } : {}) });
    this.renderer.spreadActors();
  }

  placeActor(seat: SeatIndex, tile: TileId): void {
    const a = this.actor(seat);
    if (!a || !this.ready) return;
    // 第一次放上棋盘（开局跳伞）：接下来的 hop 播降落；在那之前本体与名牌不显示（镜头推移、FLIC 载入期间
    // 不先站在落点上）。批次结束仍没有 hop 时 syncView 取消等待
    if (!a.root.visible) a.markDrop();
    a.root.visible = true;
    a.teleport(tile);
    this.renderer.spreadActors();
  }

  async hop(seat: SeatIndex, signal: AbortSignal): Promise<void> {
    await this.actor(seat)?.hop(signal);
  }

  /**
   * 掷骰动作（BoardPort.throwDice）：持骰库每方向的帧逐 tick 播一遍，停在最后一帧直到开始行走；返回人物的屏幕方向槽
   * （骰子 FLC 的画点按它取原版表 0x4730ac）。人物不在棋盘上时返回 null
   */
  async throwDice(seat: SeatIndex, tickMs: number, signal: AbortSignal): Promise<number | null> {
    const a = this.actor(seat);
    if (!a || !this.ready || !a.root.visible) return null;
    await a.throwDice(tickMs, signal);
    return a.destroyed ? null : a.screenDir;
  }

  /**
   * 人物脚下锚点（boardPos，含同格偏移）在棋盘画布上的位置、画布尺寸与镜头缩放（BoardPort.actorScreen）：原版每 tick 把镜头
   * 拉回行动者（0x40d35c–0x40d394 → fcn.00407ebd(p.x,p.y)），骰子 FLC 画点相对人物固定；我们的镜头跟随偏上 16、可以手动拖动、
   * 关闭跟随或 pin 别的座位，棋盘缩放也可能与舞台缩放不同，所以把人物实际的画面位置交给骰子覆盖层。人物不在棋盘上时为 null
   */
  actorScreen(seat: SeatIndex): DiceAnchor | null {
    const a = this.actor(seat);
    if (!a || !this.ready || !a.root.visible) return null;
    const cam = this.renderer.camera;
    const p = cam.worldToScreen(a.boardPos());
    const v = this.renderer.viewportSize();
    return { x: p.x, y: p.y, w: v.w, h: v.h, zoom: cam.zoom };
  }

  setActorPose(seat: SeatIndex, pose: 'idle' | 'cheer' | 'sad' | 'hurt' | 'sleep' | 'cast'): void {
    // 原版的欢呼 / 沮丧是角色表情 FLIC（Data#375–398，flic-map 置信度 guess，暂不取用）；这里只处理持骰姿态的收起
    if (pose !== 'idle') this.actor(seat)?.clearThrow();
  }

  anchorPos(at: Anchor, lift = false): Pt | null {
    return this.ready ? this.renderer.anchorPos(at, lift) : null;
  }

  async focus(at: Anchor, ms: number, signal: AbortSignal): Promise<void> {
    if (!this.o.autoFollow()) return;
    const p = this.anchorPos(at);
    if (!p) return;
    const cam = this.renderer.camera;
    if (cam.followPaused) return;
    await cam.panTo({ x: p.x, y: p.y - 16 }, ms, signal);
  }

  follow(seat: SeatIndex | null): void {
    this.followSeat = seat;
    const pin = this.o.pinned?.() ?? null;
    this.renderer.follow(pin !== null ? pin : this.o.autoFollow() ? seat : null);
  }

  refollow(): void {
    this.follow(this.followSeat);
  }

  get followed(): SeatIndex | null {
    return this.followSeat;
  }

  floatText(at: Anchor, text: string, tone: FloatTone): void {
    const p = this.anchorPos(at, true);
    if (p) this.fx.floatText(p, text, tone);
  }

  async coinFlight(from: Anchor, to: Anchor, signal: AbortSignal): Promise<void> {
    const a = this.anchorPos(from);
    const b = this.anchorPos(to);
    if (!a || !b) return;
    await this.fx.coinFlight(a, b, signal);
  }

  /**
   * 插旗：原版角色标记（ownerMark，帧 = 角色号）从上方落下。地块上已经画着静态标记（LAND_BOUGHT 先 setLot）时
   * 让这个静态标记本身落下，不另建副本；没有静态标记（拍卖成交、建筑上）时在 overlay 画一个落下后淡出；
   * 标记精灵不可用时用程序化小旗
   */
  async plantFlag(lot: LotId, seat: SeatIndex, signal: AbortSignal): Promise<void> {
    const p = this.anchorPos({ lot });
    if (!p) return;
    const view = this.renderer.boardView;
    if (view && (await view.dropOwnerMark(lot, FLAG_MS, signal, 48))) return;
    const key = this.renderer.skin.buildings.ownerMark;
    const sheet = key ? this.renderer.assets.sheetNow(key) : null;
    const ch = this.characters.get(seat);
    const tex = sheet && ch !== undefined ? sheet.frames[ch] : undefined;
    if (!sheet || ch === undefined || !tex) {
      await this.fx.plantFlag(p, seat, signal);
      return;
    }
    const [ax, ay] = sheet.anchors[ch] ?? [0, 0];
    const spr = new Sprite(tex);
    spr.pivot.set(ax, ay);
    const h = this.fx.track(spr, this.fx.overlay, signal);
    await this.fx.tween(
      FLAG_MS,
      (v) => {
        if (!spr.destroyed) spr.position.set(p.x, p.y - 48 * (1 - v));
      },
      h.signal,
      backOut,
    );
    void this.renderer.clock
      .wait(520, h.signal)
      .then(() =>
        this.fx.tween(
          260,
          (v) => {
            if (!spr.destroyed) spr.alpha = 1 - v;
          },
          h.signal,
        ),
      )
      .then(h.done);
  }

  async popBuilding(lot: LotId, signal: AbortSignal): Promise<void> {
    await this.renderer.boardView?.popBuilding(lot, signal);
  }

  /** 格子脉冲：投影后的格框放大淡出（不阻塞） */
  pulseTile(tile: TileId): void {
    const v = this.renderer.boardView;
    const w = v?.tileWorld(tile);
    if (!v || !w) return;
    const c = this.renderer.proj.project(w);
    const quad = this.renderer.proj.quad({ x: w.x - 14, y: w.y - 14, w: 28, h: 28 });
    const g = new Graphics()
      .poly(
        quad.flatMap((q) => [q.x - c.x, q.y - c.y]),
        true,
      )
      .stroke({ width: 2, color: 0xffffff });
    g.position.set(c.x, c.y);
    const h = this.fx.track(g, this.fx.fxLayer);
    void this.fx
      .tween(420, (t) => {
        if (g.destroyed) return;
        g.alpha = 1 - t;
        g.scale.set(1 + 0.35 * t);
      })
      .then(h.done);
  }

  say(seat: SeatIndex, text: string, ms: number, emote = false): void {
    if (!this.ready) return;
    this.actor(seat)?.say(text, ms, emote);
  }

  shake(amp: number, ms: number): void {
    this.renderer.camera.shake(amp, ms);
  }

  clearFx(): void {
    this.fx.clear();
    this.stageObj.clear();
  }

  // ───────────────────────── 目标高亮 ─────────────────────────

  highlight(tiles: readonly TileId[], selected: TileId | null): void {
    const v = this.renderer.boardView;
    if (!this.ready || !v) return;
    const valid = tiles.filter((t) => v.hasTile(t));
    this.highlighted = valid;
    v.setHighlight(valid);
    v.select(selected !== null && v.hasTile(selected) ? selected : null);
  }

  get highlightedTiles(): readonly TileId[] {
    return this.highlighted;
  }

  tileCanvasPos(id: TileId): Pt | null {
    return this.ready ? this.renderer.tileCanvasPos(id) : null;
  }

  /** 角色名键（测试） */
  characterKey(seat: number): string | null {
    const c = this.characters.get(seat);
    return c === undefined ? null : (CHARACTER_KEYS[c as CharacterId] ?? null);
  }
}
