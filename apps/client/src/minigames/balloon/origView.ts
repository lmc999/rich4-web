// 七彩气球的原版视图（原版皮肤 A13；design-draft §3.6；帧号见 orig/frames.ts）：
// Panel#91 游乐园底图（HUD 条在 y ≥ 387，盖在升起的气球之上）；16 个槽按 sim 的 (x, y) 画图1–12（数字 1–9 大小不同、
// ×2、÷2、?），y 在相邻 tick 之间插值；打中后图13 爆开停 3 tick；准星用 ui.cursor（Data#0 图6–8 三帧轮播，条目缺失时
// 画一个简单的十字）；HUD 条贴时间与四位得分；结算中央画大号分数。
import { type BalloonState, balloon, type SimFx } from '@rich4/shared/minigames';
import { Container, Graphics, Sprite } from 'pixi.js';
import type { SpriteSheet } from '../../game/orig/OrigAssets';
import { lerp } from '../draw';
import {
  BALLOON_POP_FRAME,
  balloonFrame,
  HUD_SCORE4_X,
  HUD_TIME_X,
  HUD_TOP,
  padDigits,
  RETICLE_FRAME_MS,
  RETICLE_FRAMES,
  timeDigits,
} from '../orig/frames';
import { BigScore, LcdRow } from '../orig/hud';
import { HUD_KEY } from '../orig/keys';
import { FrameSprite } from '../orig/kit';
import type { MinigameView, OrigViewContext, Pt, ViewPhase, ViewResult } from '../types';

const { SLOT_COUNT } = balloon;

function need(kit: OrigViewContext['kit'], key: string): SpriteSheet {
  const s = kit.sheet(key);
  if (!s) throw new Error(`[minigame] 缺少原版精灵 ${key}`);
  return s;
}

export class BalloonOrigView implements MinigameView<BalloonState> {
  readonly root = new Container();
  readonly look = 'original' as const;
  private readonly screen: SpriteSheet;
  private readonly cursor: SpriteSheet | null;
  private readonly slots: FrameSprite[] = [];
  private readonly reticle: FrameSprite | Graphics;
  private readonly time: LcdRow;
  private readonly scoreRow: LcdRow;
  private readonly big: BigScore;
  private phase: ViewPhase = 'loading';
  private result: ViewResult | null = null;
  private pointer: Pt | null = null;

  constructor(readonly ctx: OrigViewContext) {
    const kit = ctx.kit;
    this.screen = need(kit, 'mg.balloon.screen');
    this.cursor = kit.sheet('ui.cursor');
    const hud = need(kit, HUD_KEY);
    const bg = new FrameSprite(this.screen, 0);
    const layer = new Container();
    for (let i = 0; i < SLOT_COUNT; i++) {
      const s = new FrameSprite(this.screen, 1);
      s.visible = false;
      layer.addChild(s);
      this.slots.push(s);
    }
    const strip = new Sprite(kit.strip(this.screen, 0, HUD_TOP.balloon));
    strip.position.set(0, HUD_TOP.balloon);
    this.time = new LcdRow(hud, HUD_TIME_X);
    this.scoreRow = new LcdRow(hud, HUD_SCORE4_X);
    this.big = new BigScore(hud);
    if (this.cursor) {
      this.reticle = new FrameSprite(this.cursor, RETICLE_FRAMES[0]!);
    } else {
      const g = new Graphics();
      g.moveTo(-14, 0).lineTo(14, 0).moveTo(0, -14).lineTo(0, 14).stroke({ width: 2, color: 0xffffff });
      g.circle(0, 0, 9).stroke({ width: 2, color: 0xffffff });
      this.reticle = g;
    }
    this.reticle.visible = false;
    this.root.addChild(bg, layer, strip, this.time, this.scoreRow, this.big, this.reticle);
    this.root.label = 'balloon-orig';
  }

  setPointer(p: Pt | null): void {
    this.pointer = p;
  }

  setPhase(phase: ViewPhase): void {
    this.phase = phase;
  }

  setResult(r: ViewResult | null): void {
    this.result = r;
  }

  render(
    prev: Readonly<BalloonState>,
    s: Readonly<BalloonState>,
    alpha: number,
    fx: readonly SimFx[],
    now: number,
  ): void {
    for (let i = 0; i < SLOT_COUNT; i++) {
      const spr = this.slots[i]!;
      const x = s.x[i]!;
      if (x === 0) {
        spr.visible = false;
        continue;
      }
      const k = s.kind[i]!;
      const popping = s.pop[i]! > 0;
      spr.show(this.screen, balloonFrame(k, popping));
      // 同一个气球（上一 tick 同跑道、同类型、更低处）才插值；爆开后不再移动
      const same = !popping && prev.x[i] === x && prev.kind[i] === k && prev.y[i]! >= s.y[i]!;
      const y = same ? lerp(prev.y[i]!, s.y[i]!, alpha) : s.y[i]!;
      spr.position.set(x, Math.round(y));
      spr.visible = true;
    }
    for (const f of fx) {
      if (f.t === 'spawn') this.ctx.sound.play(19);
      else if (f.t === 'miss') this.ctx.sound.play(20);
      else if (f.t === 'pop') this.ctx.sound.play(21);
    }
    // 准星（本人游玩时）
    const p = this.pointer;
    const show = p !== null && this.ctx.mode === 'play' && this.phase !== 'result';
    this.reticle.visible = show;
    if (show && p) {
      this.reticle.position.set(p.x, p.y);
      if (this.cursor && this.reticle instanceof FrameSprite) {
        this.reticle.show(this.cursor, RETICLE_FRAMES[Math.floor(now / RETICLE_FRAME_MS) % RETICLE_FRAMES.length]!);
      }
    }
    // HUD
    this.time.set(timeDigits(Math.max(0, s.timeLeft)));
    this.scoreRow.set(padDigits(s.score, 4));
    if (this.phase === 'result') {
      if (this.big.value === null) this.ctx.sound.play(25);
      this.big.set(this.result?.score ?? s.score);
    } else this.big.set(null);
  }

  debug(): Record<string, unknown> {
    return {
      look: this.look,
      phase: this.phase,
      balloons: this.slots.filter((x) => x.visible).map((x) => x.frameIndex),
      popping: this.slots.filter((x) => x.visible && x.frameIndex === BALLOON_POP_FRAME).length,
      reticle: this.cursor ? 'sprite' : 'fallback',
      hud: [this.time.value, this.scoreRow.value],
      bigScore: this.big.value,
    };
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}

export async function createBalloonOrigView(ctx: OrigViewContext): Promise<BalloonOrigView> {
  return new BalloonOrigView(ctx);
}
