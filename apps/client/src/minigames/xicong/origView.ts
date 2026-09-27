// 喜从天降的原版视图（原版皮肤 A13；design-draft §3.6；帧号见 orig/frames.ts）：
// Panel#92 南天门底图（RAW16 整图，HUD 条在 y ≥ 387 盖在掉落物之上）；财神 Panel#93 按状态机查表画在 (x, 126)，
// x 在相邻 tick 间插值；捣蛋鬼预警 Panel#94 第 warn 帧画在 (warnX, 125)；宝箱 / 钱袋 / 元宝 / 金币 / 炸弹 Panel#95–99
// 按摆动帧旋转、按 0.5 + (y − 130)/250 放大；玩家角色的接物动作 Panel#100+角色（站立、左右走、被炸、结算表情）；
// 被炸时在角色处播 fx.godLeave（Data#485，110×110）爆炸；HUD 条贴时间、四种宝物件数与得分；结算中央画大号分数。
import { type SimFx, XICONG_SIM, type XicongState, xicong, xicongPose } from '@rich4/shared/minigames';
import { Container, Sprite } from 'pixi.js';
import type { SpriteSheet } from '../../game/orig/OrigAssets';
import { lerp } from '../draw';
import {
  catcherFrame,
  GOD_DRAW_Y,
  godFrame,
  HUD_PAIR_X,
  HUD_SCORE3_X,
  HUD_TIME_X,
  HUD_TOP,
  padDigits,
  timeDigits,
  WARN_DRAW_Y,
  XICONG_BOOM_DX,
  XICONG_BOOM_KEY,
  XICONG_BOOM_Y,
  XICONG_HUD_KINDS,
  xicongItemScale,
  xicongTimeTenths,
} from '../orig/frames';
import { BigScore, LcdRow } from '../orig/hud';
import { HUD_KEY, xicongCharKey } from '../orig/keys';
import { type FlcSprite, FrameSprite } from '../orig/kit';
import type { MinigameView, OrigViewContext, Pt, ViewPhase, ViewResult } from '../types';

const { ITEM_SLOTS, CATCHER_Y, itemPx } = xicong;

function need(kit: OrigViewContext['kit'], key: string): SpriteSheet {
  const s = kit.sheet(key);
  if (!s) throw new Error(`[minigame] 缺少原版精灵 ${key}`);
  return s;
}

export class XicongOrigView implements MinigameView<XicongState> {
  readonly root = new Container();
  readonly look = 'original' as const;
  private readonly godSheet: SpriteSheet;
  private readonly warnSheet: SpriteSheet;
  private readonly itemSheets: SpriteSheet[];
  private readonly charSheet: SpriteSheet;
  private readonly god: FrameSprite;
  private readonly warn: FrameSprite;
  private readonly items: FrameSprite[] = [];
  private readonly catcher: FrameSprite;
  private readonly time: LcdRow;
  private readonly pairs: LcdRow[];
  private readonly scoreRow: LcdRow;
  private readonly big: BigScore;
  private readonly fxLayer = new Container();
  private boom: FlcSprite | null = null;
  private boomAt: number | null = null;
  private boomX = 0;
  private phase: ViewPhase = 'loading';
  private result: ViewResult | null = null;
  private dead = false;

  constructor(readonly ctx: OrigViewContext) {
    const kit = ctx.kit;
    const bgTex = kit.image('mg.xicong.bg');
    if (!bgTex || ctx.characterId === null) throw new Error('[minigame] 喜从天降原版素材不全');
    this.godSheet = need(kit, 'mg.xicong.93');
    this.warnSheet = need(kit, 'mg.xicong.94');
    this.itemSheets = [95, 96, 97, 98, 99].map((n) => need(kit, `mg.xicong.${n}`));
    this.charSheet = need(kit, xicongCharKey(ctx.characterId));
    const hud = need(kit, HUD_KEY);
    const bg = new Sprite(bgTex);
    this.warn = new FrameSprite(this.warnSheet, 0);
    this.warn.visible = false;
    this.god = new FrameSprite(this.godSheet, godFrame(xicong.GOD_INIT_STATE, xicong.GOD_INIT_FRAME));
    const itemLayer = new Container();
    for (let i = 0; i < ITEM_SLOTS; i++) {
      const s = new FrameSprite(this.itemSheets[0]!, 0);
      s.visible = false;
      itemLayer.addChild(s);
      this.items.push(s);
    }
    this.catcher = new FrameSprite(this.charSheet, 0);
    const strip = new Sprite(kit.imageStrip(bgTex, HUD_TOP.xicong));
    strip.position.set(0, HUD_TOP.xicong);
    this.time = new LcdRow(hud, HUD_TIME_X);
    this.pairs = HUD_PAIR_X.map((xs) => new LcdRow(hud, xs));
    this.scoreRow = new LcdRow(hud, HUD_SCORE3_X);
    this.big = new BigScore(hud);
    // 原版的绘制顺序：掉落物 → 预警 → 财神 → 接物者（0x412b66）
    this.root.addChild(
      bg,
      itemLayer,
      this.warn,
      this.god,
      this.catcher,
      strip,
      this.fxLayer,
      this.time,
      ...this.pairs,
      this.scoreRow,
      this.big,
    );
    this.root.label = 'xicong-orig';
    void kit.flc(XICONG_BOOM_KEY).then((f) => {
      if (!f) return;
      if (this.dead) {
        f.destroy();
        return;
      }
      this.boom = f;
      this.fxLayer.addChild(f.sprite);
    });
  }

  setPointer(_p: Pt | null): void {
    // 游玩时隐藏指针（原版同）；接物者本身就是光标反馈
  }

  setPhase(phase: ViewPhase): void {
    this.phase = phase;
  }

  setResult(r: ViewResult | null): void {
    this.result = r;
  }

  render(
    prev: Readonly<XicongState>,
    s: Readonly<XicongState>,
    alpha: number,
    fx: readonly SimFx[],
    now: number,
  ): void {
    // 财神
    const gx = Math.abs(s.godX - prev.godX) <= xicong.GOD_STEP ? lerp(prev.godX, s.godX, alpha) : s.godX;
    this.god.show(this.godSheet, godFrame(s.godState, s.godFrame));
    this.god.position.set(Math.round(gx), GOD_DRAW_Y);
    // 预警（捣蛋鬼抱着炸弹冒出来，第 8 帧扔下）
    if (s.warn >= 0 && s.warn < this.warnSheet.count) {
      this.warn.show(this.warnSheet, s.warn);
      this.warn.position.set(s.warnX, WARN_DRAW_Y);
      this.warn.visible = true;
    } else this.warn.visible = false;
    // 掉落物
    for (let i = 0; i < ITEM_SLOTS; i++) {
      const spr = this.items[i]!;
      if (s.ix[i] === 0) {
        spr.visible = false;
        continue;
      }
      const k = s.ikind[i]!;
      const same = prev.ix[i] === s.ix[i] && prev.ikind[i] === k && prev.iy[i]! <= s.iy[i]! + 16;
      const y = same ? lerp(prev.iy[i]!, s.iy[i]!, alpha) : s.iy[i]!;
      const px0 = same ? itemPx(prev.ix[i]!, prev.iy[i]!, prev.iframe[i]!) : itemPx(s.ix[i]!, s.iy[i]!, s.iframe[i]!);
      const px1 = itemPx(s.ix[i]!, s.iy[i]!, s.iframe[i]!);
      spr.show(this.itemSheets[Math.min(4, k)]!, s.iframe[i]!);
      spr.scale.set(xicongItemScale(y));
      spr.position.set(Math.round(lerp(px0, px1, same ? alpha : 1)), Math.round(y));
      spr.visible = true;
    }
    // 接物者
    const cx = Math.abs(s.catcherX - prev.catcherX) <= 20 ? lerp(prev.catcherX, s.catcherX, alpha) : s.catcherX;
    const score = this.result?.score ?? XICONG_SIM.score(s as XicongState);
    const pose = this.phase === 'result' && !s.hitBomb ? xicongPose(score) : null;
    this.catcher.show(this.charSheet, catcherFrame(this.charSheet.count, s, s.tick, pose));
    this.catcher.position.set(Math.round(cx), CATCHER_Y);
    // 音效与爆炸
    for (const f of fx) {
      if (f.t === 'bombDrop') this.ctx.sound.play(22);
      else if (f.t === 'boom') {
        this.ctx.sound.play(15);
        this.boomAt = now;
        this.boomX = Math.round(cx);
      }
    }
    const boom = this.boom;
    if (boom) {
      if (this.boomAt === null) boom.showAt(-1);
      else {
        boom.sprite.position.set(this.boomX + XICONG_BOOM_DX, XICONG_BOOM_Y);
        boom.showAt(Math.floor((now - this.boomAt) / boom.frameMs));
      }
    }
    // HUD
    this.time.set(timeDigits(xicongTimeTenths(s.timeLeft)));
    XICONG_HUD_KINDS.forEach((k, i) => {
      this.pairs[i]!.set(padDigits(s.counts[k] ?? 0, 2));
    });
    this.scoreRow.set(padDigits(XICONG_SIM.score(s as XicongState), 3));
    if (this.phase === 'result') {
      if (this.big.value === null) this.ctx.sound.play(25);
      this.big.set(score);
    } else this.big.set(null);
  }

  debug(): Record<string, unknown> {
    return {
      look: this.look,
      phase: this.phase,
      god: this.god.frameIndex,
      warn: this.warn.visible ? this.warn.frameIndex : -1,
      items: this.items.filter((x) => x.visible).length,
      catcher: `${this.charSheet.key}#${this.catcher.frameIndex}`,
      boom: this.boom?.current ?? null,
      hud: [this.time.value, ...this.pairs.map((p) => p.value), this.scoreRow.value],
      bigScore: this.big.value,
    };
  }

  destroy(): void {
    this.dead = true;
    if (this.boom) this.fxLayer.removeChild(this.boom.sprite);
    this.root.destroy({ children: true });
  }
}

export async function createXicongOrigView(ctx: OrigViewContext): Promise<XicongOrigView> {
  return new XicongOrigView(ctx);
}
