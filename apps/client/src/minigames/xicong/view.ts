// 喜从天降的 Pixi 场景（design/minigames-ai.md §5；全部原创绘制）：
// 南天门云端背景；财神在 [110, 530] 来回走并撒下金币（1）、元宝（3）、钱袋（5）、宝箱（10）；
// 炸弹先出现红色预警（落点一侧的闪烁光柱），第 8 帧落下；玩家角色（复用棋盘角色 rig 的走路帧）在 y=380 左右移动接宝，
// 头顶托着聚宝盆；掉落物的横向摆动与 y 在相邻 tick 之间插值。
import { type SimFx, type XicongState, xicong } from '@rich4/shared/minigames';
import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import { buildCharacterFrames, type CharacterFrames } from '../../game/procedural/character/atlas';
import { characterByIndex } from '../../game/procedural/character/defs';
import { FOOT_Y, type Pose, VIEW_H } from '../../game/procedural/character/rig';
import { bands, bomb, chest, cloud, coin, FONT_TITLE, FxLayer, INK, ingot, label, lerp, moneyBag } from '../draw';
import { mgText } from '../text';
import type { MinigameView, Pt, ViewContext } from '../types';

const { ITEM_SLOTS, ITEM_BOMB, GOD_Y, CATCHER_Y, GOD_WALK_RIGHT, GOD_WALK_LEFT, ITEM_SCORE, itemPx, WARN_DROP_AT } =
  xicong;

/** 掉落物图形：0 宝箱、1 钱袋、2 元宝、3 金币、4 炸弹 */
export function drawDrop(g: Graphics, kind: number): void {
  g.clear();
  if (kind === 0) chest(g, 0, 0, 0.9);
  else if (kind === 1) moneyBag(g, 0, 0, 0.9);
  else if (kind === 2) ingot(g, 0, 0, 0.9);
  else if (kind === 3) coin(g, 0, 0, 10);
  else bomb(g, 0, 0, 12);
}

function drawGod(g: Graphics): void {
  // 以脚底为原点、面朝右；红袍、官帽、长须，怀抱元宝
  g.ellipse(0, 0, 26, 6).fill({ color: 0x000000, alpha: 0.15 });
  g.poly([-24, 0, -16, -44, 16, -44, 24, 0]).fill(0xe8453c).stroke({ width: 3, color: INK });
  g.rect(-16, -30, 32, 5).fill(0xffd84d);
  g.circle(0, -58, 16).fill(0xffe0c0).stroke({ width: 3, color: INK });
  g.poly([-8, -50, 8, -50, 5, -34, 0, -30, -5, -34]).fill(0x2a2a2a);
  g.circle(-5, -61, 2).fill(INK);
  g.circle(6, -61, 2).fill(INK);
  g.ellipse(-8, -55, 3, 2).fill({ color: 0xff8080, alpha: 0.6 });
  g.ellipse(9, -55, 3, 2).fill({ color: 0xff8080, alpha: 0.6 });
  g.roundRect(-18, -84, 36, 14, 4).fill(0x2a2a2a).stroke({ width: 2, color: INK });
  g.ellipse(-24, -78, 10, 4).fill(0x2a2a2a);
  g.ellipse(24, -78, 10, 4).fill(0x2a2a2a);
  g.circle(0, -80, 3).fill(0xffd84d);
  ingot(g, 12, -20, 0.7);
}

function drawGate(g: Graphics): void {
  // 南天门：两根红柱、琉璃瓦顶、牌匾
  for (const x of [118, 506]) {
    g.rect(x, 70, 18, 170).fill(0xd8453c).stroke({ width: 3, color: INK });
    g.rect(x - 6, 236, 30, 10)
      .fill(0xc9a14a)
      .stroke({ width: 2, color: INK });
  }
  g.rect(96, 60, 450, 16).fill(0xd8453c).stroke({ width: 3, color: INK });
  g.poly([70, 60, 320, 18, 570, 60]).fill(0x2e9e8a).stroke({ width: 3, color: INK });
  g.poly([70, 60, 90, 52, 550, 52, 570, 60]).fill(0xffd84d).stroke({ width: 2, color: INK });
  g.roundRect(262, 28, 116, 30, 6).fill(0x3a2a6a).stroke({ width: 3, color: 0xffd84d });
}

export class XicongView implements MinigameView<XicongState> {
  readonly root = new Container();
  private readonly god = new Container();
  private readonly godBody = new Graphics();
  private readonly drops: Graphics[] = [];
  private readonly dropKinds: number[] = [];
  private readonly warn = new Graphics();
  private readonly catcher = new Container();
  private readonly sprite = new Sprite();
  private readonly fallbackBody = new Graphics();
  private readonly basket = new Graphics();
  private readonly guide = new Graphics();
  private readonly fx = new FxLayer();
  private frames: CharacterFrames | null = null;
  private destroyed = false;
  private pointer: Pt | null = null;

  constructor(readonly ctx: ViewContext) {
    const bg = new Graphics();
    bands(bg, 0, 0, 640, 480, 0xffb86b, 0xfff1c9, 12);
    cloud(bg, 10, 120, 1.1, 0xffffff, 0.8);
    cloud(bg, 540, 110, 1, 0xffffff, 0.8);
    drawGate(bg);
    const plaque = label('南天门', 20, 0xffd84d, FONT_TITLE);
    plaque.position.set(320, 43);
    // 云海（接物者站在云上）
    const sea = new Graphics();
    for (let x = -20; x < 680; x += 60) cloud(sea, x, 402 + ((x / 60) % 2) * 8, 1.1, 0xffffff, 0.95);
    sea.rect(0, 410, 640, 70).fill(0xffffff);
    this.root.addChild(bg, plaque, this.warn, sea);
    drawGod(this.godBody);
    this.god.addChild(this.godBody);
    this.root.addChild(this.god);
    for (let i = 0; i < ITEM_SLOTS; i++) {
      const g = new Graphics();
      g.visible = false;
      this.drops.push(g);
      this.dropKinds.push(-1);
      this.root.addChild(g);
    }
    // 接物者：先画占位小人，角色帧就绪后换成 rig 精灵
    this.fallbackBody.roundRect(-16, -60, 32, 44, 12).fill(0x3d8bfd).stroke({ width: 3, color: INK });
    this.fallbackBody.circle(0, -66, 14).fill(0xffe0c0).stroke({ width: 3, color: INK });
    this.sprite.anchor.set(0.5, FOOT_Y / VIEW_H);
    this.sprite.scale.set(0.56);
    this.sprite.visible = false;
    this.basket
      .moveTo(-30, -44)
      .arc(0, -44, 30, 0, Math.PI)
      .closePath()
      .fill(0xc07a44)
      .stroke({ width: 3, color: INK });
    this.basket.rect(-32, -48, 64, 6).fill(0xffd84d).stroke({ width: 2, color: INK });
    this.catcher.addChild(this.fallbackBody, this.sprite, this.basket);
    this.root.addChild(this.guide, this.catcher, this.fx.root);
    if (ctx.characterId !== null) void this.loadCharacter(ctx.characterId);
  }

  private async loadCharacter(id: number): Promise<void> {
    try {
      const f = await buildCharacterFrames(characterByIndex(id), 2);
      if (this.destroyed) {
        f.destroy();
        return;
      }
      this.frames = f;
      this.fallbackBody.visible = false;
      this.sprite.visible = true;
      this.sprite.texture = f.get('idle0', 'front');
    } catch (err) {
      console.warn('[minigame] 角色帧加载失败，使用占位小人', err);
    }
  }

  setPointer(p: Pt | null): void {
    this.pointer = p;
  }

  private pose(s: Readonly<XicongState>, now: number): Texture | null {
    if (!this.frames) return null;
    let pose: Pose;
    if (s.hitBomb) pose = 'hurt';
    else if (s.phase === 'over' || s.phase === 'ending') pose = 'cheer';
    else if (s.catcherDir !== 0)
      pose = (['walk0', 'walk1', 'walk2', 'walk3'] as const)[Math.floor(s.catcherFrame / 2.5) % 4]!;
    else pose = Math.floor(now / 500) % 2 === 0 ? 'idle0' : 'idle1';
    return this.frames.get(pose, 'front');
  }

  render(
    prev: Readonly<XicongState>,
    s: Readonly<XicongState>,
    alpha: number,
    fx: readonly SimFx[],
    now: number,
  ): void {
    // 财神
    const gx = Math.abs(s.godX - prev.godX) <= 24 ? lerp(prev.godX, s.godX, alpha) : s.godX;
    const walking = s.godState === GOD_WALK_RIGHT || s.godState === GOD_WALK_LEFT;
    this.god.position.set(gx, GOD_Y + 40 + (walking ? -Math.abs(Math.sin((s.godFrame + alpha) * 1.2)) * 4 : 0));
    this.godBody.scale.x = s.godState === GOD_WALK_LEFT ? -1 : 1;
    // 掉落物
    for (let i = 0; i < ITEM_SLOTS; i++) {
      const g = this.drops[i]!;
      if (s.ix[i] === 0) {
        g.visible = false;
        continue;
      }
      const k = s.ikind[i]!;
      if (this.dropKinds[i] !== k) {
        this.dropKinds[i] = k;
        drawDrop(g, k);
      }
      const same = prev.ix[i] === s.ix[i] && prev.ikind[i] === k && prev.iy[i]! <= s.iy[i]! + 16;
      const y = same ? lerp(prev.iy[i]!, s.iy[i]!, alpha) : s.iy[i]!;
      const px0 = same ? itemPx(prev.ix[i]!, prev.iy[i]!, prev.iframe[i]!) : itemPx(s.ix[i]!, s.iy[i]!, s.iframe[i]!);
      const px1 = itemPx(s.ix[i]!, s.iy[i]!, s.iframe[i]!);
      g.visible = true;
      g.position.set(lerp(px0, px1, same ? alpha : 1), y);
      g.rotation = k === ITEM_BOMB ? Math.sin(now / 120) * 0.2 : Math.sin((now + i * 97) / 300) * 0.12;
    }
    // 预警：落点一侧闪烁的红色光柱与感叹号
    this.warn.clear();
    if (s.warn >= 0 && s.warn < WARN_DROP_AT + 2) {
      const on = Math.floor(now / 120) % 2 === 0;
      this.warn.rect(s.warnX - 22, 90, 44, 300).fill({ color: 0xf2545b, alpha: on ? 0.28 : 0.14 });
      this.warn
        .circle(s.warnX, 110, 18)
        .fill(on ? 0xf2545b : 0xffd84d)
        .stroke({ width: 3, color: INK });
      this.warn.rect(s.warnX - 3, 99, 6, 14).fill(0xffffff);
      this.warn.circle(s.warnX, 118, 3).fill(0xffffff);
    }
    // 接物者
    const cx = Math.abs(s.catcherX - prev.catcherX) <= 20 ? lerp(prev.catcherX, s.catcherX, alpha) : s.catcherX;
    this.catcher.position.set(cx, CATCHER_Y);
    const face = s.catcherDir === 1 ? -1 : s.catcherDir === 2 ? 1 : this.sprite.scale.x < 0 ? -1 : 1;
    this.sprite.scale.x = 0.56 * face;
    const tex = this.pose(s, now);
    if (tex) this.sprite.texture = tex;
    // 光标导引（玩家本人）
    this.guide.clear();
    const p = this.pointer;
    if (this.ctx.mode === 'play' && p && s.phase !== 'over') {
      this.guide.poly([p.x - 9, 452, p.x + 9, 452, p.x, 440]).fill({ color: 0xf2545b, alpha: 0.85 });
    }
    for (const f of fx) {
      if (f.t === 'catch') this.fx.text(`+${ITEM_SCORE[f.item] ?? 0}`, cx, CATCHER_Y - 90, now);
      else if (f.t === 'boom') this.fx.burst(cx, CATCHER_Y - 50, now, 56, 0xff6b3d, 700);
      else if (f.t === 'warn') this.fx.text(mgText('xicong.warn'), f.x, 150, now, 0xf2545b, 26, 700);
      else if (f.t === 'timeup') this.fx.text(mgText('balloon.effect.0'), 320, 220, now, 0xffe27a, 36, 1200);
    }
    this.fx.update(now);
  }

  destroy(): void {
    this.destroyed = true;
    this.fx.destroy();
    this.root.destroy({ children: true });
    this.frames?.destroy();
    this.frames = null;
  }
}
