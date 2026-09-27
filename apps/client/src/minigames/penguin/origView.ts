// 企鹅挖宝的原版视图（原版皮肤 A13；design-draft §3.6；帧号依据见 orig/frames.ts）：
// Panel#80 冰原底图（含 HUD 条）与冰屋；开局记忆的 1 秒里所有埋藏格露出埋藏物（原版 0x413f39(1)：按类型画图4–8），
// 进入游玩后收起；企鹅走路（Panel#82）与挖掘（#83）按 sim 朝向取 8 方向帧，两格之间按 (sub + α)/4 插值；
// 挖开的格留雪坑（图9）；揭晓时在格上播 6 帧（#86 爆炸、#87–90 宝物升起）；被炸焦黑（图2）；
// 结算按分数播姿势（>55 #84、<40 #85、其余站立）并在中央画大号分数；HUD 条的时间、四种宝物件数与得分贴液晶数字。
// 视图只读 sim 状态：输入命中仍走 sim 的 pickCell（Panel#81 掩膜只做诊断对拍，见 maskDiag.ts）。
import { PENGUIN_SIM, type PenguinState, penguin, type SimFx } from '@rich4/shared/minigames';
import { Container, Graphics, Sprite } from 'pixi.js';
import { testHooksEnabled } from '../../app/flags';
import type { SpriteSheet } from '../../game/orig/OrigAssets';
import { lerp } from '../draw';
import {
  HUD_PAIR_X,
  HUD_SCORE3_X,
  HUD_TIME_X,
  HUD_TOP,
  PENGUIN_BG,
  PENGUIN_HUD_KINDS,
  padDigits,
  penguinBuriedFrame,
  penguinDigFrame,
  penguinPoseKey,
  penguinRevealKey,
  penguinWalkFrame,
  timeDigits,
} from '../orig/frames';
import { BigScore, LcdRow } from '../orig/hud';
import { HUD_KEY, PENGUIN_REVEAL_SFX } from '../orig/keys';
import { FrameSprite } from '../orig/kit';
import type { MinigameView, OrigViewContext, Pt, ViewPhase, ViewResult } from '../types';
import { diagnosePenguinMask, type MaskDiag, regionFromRgba } from './maskDiag';

const { CELL_HALF_H: HH, CELL_HALF_W: HW, VALID_CELLS, cellCenter, pickCell, IGLOO_CELL, TICKS_PER_CELL } = penguin;

/** 揭晓动画与结算姿势的帧间隔（原版 100 ms 定时器每拍一帧） */
const ANIM_MS = 100;

function need(kit: OrigViewContext['kit'], key: string): SpriteSheet {
  const s = kit.sheet(key);
  if (!s) throw new Error(`[minigame] 缺少原版精灵 ${key}`);
  return s;
}

export class PenguinOrigView implements MinigameView<PenguinState> {
  readonly root = new Container();
  readonly look = 'original' as const;
  private readonly screen: SpriteSheet;
  private readonly walkSheet: SpriteSheet;
  private readonly digSheet: SpriteSheet;
  private readonly buried = new Container();
  private readonly holes = new Container();
  private readonly world = new Container();
  private readonly penguinSprite: FrameSprite;
  private readonly revealSprite = new FrameSprite();
  private readonly target = new Graphics();
  private readonly time: LcdRow;
  private readonly pairs: LcdRow[];
  private readonly scoreRow: LcdRow;
  private readonly big: BigScore;
  private phase: ViewPhase = 'loading';
  private result: ViewResult | null = null;
  private pointer: Pt | null = null;
  private targetCell = -2;
  private buriedShown: boolean | null = null;
  private dugKey = '';
  private reveal: { cell: number; kind: number; t0: number } | null = null;
  private lastStep = '';
  private resultAt: number | null = null;
  private poseSfx = false;
  private maskDiag: MaskDiag | null = null;
  private dead = false;

  constructor(readonly ctx: OrigViewContext) {
    const kit = ctx.kit;
    this.screen = need(kit, 'mg.penguin.screen');
    this.walkSheet = need(kit, 'mg.penguin.82');
    this.digSheet = need(kit, 'mg.penguin.83');
    const hud = need(kit, HUD_KEY);
    const bg = new FrameSprite(this.screen, PENGUIN_BG.screen);
    const igloo = new FrameSprite(this.screen, PENGUIN_BG.igloo);
    const ig = cellCenter(IGLOO_CELL);
    igloo.position.set(ig.x, ig.y);
    igloo.zIndex = ig.y;
    this.penguinSprite = new FrameSprite(this.screen, PENGUIN_BG.idle);
    this.world.sortableChildren = true;
    this.world.addChild(igloo, this.penguinSprite);
    this.revealSprite.visible = false;
    // HUD 条（y ≥ 387）盖在场景之上，数字贴在 HUD 条上
    const strip = new Sprite(kit.strip(this.screen, PENGUIN_BG.screen, HUD_TOP.penguin));
    strip.position.set(0, HUD_TOP.penguin);
    this.time = new LcdRow(hud, HUD_TIME_X);
    this.pairs = HUD_PAIR_X.map((xs) => new LcdRow(hud, xs));
    this.scoreRow = new LcdRow(hud, HUD_SCORE3_X);
    this.big = new BigScore(hud);
    this.root.addChild(
      bg,
      this.holes,
      this.buried,
      this.target,
      this.world,
      this.revealSprite,
      strip,
      this.time,
      ...this.pairs,
      this.scoreRow,
      this.big,
    );
    this.root.label = 'penguin-orig';
    if (testHooksEnabled()) void this.diagnoseMask();
  }

  /** Panel#81 掩膜与 pickCell 逐像素对拍（只在开发 / 测试模式下做，结果进 debug()） */
  private async diagnoseMask(): Promise<void> {
    const pack = this.ctx.kit.pack;
    const e = pack.usableEntry('mg.penguin.mask');
    if (e?.type !== 'mask' || typeof OffscreenCanvas === 'undefined') return;
    try {
      const bmp = await pack.loadImage(e.file);
      try {
        if (this.dead) return;
        const c = new OffscreenCanvas(e.w, e.h).getContext('2d');
        if (!c) return;
        c.drawImage(bmp, 0, 0);
        const px = c.getImageData(0, 0, e.w, e.h).data;
        this.maskDiag = diagnosePenguinMask(regionFromRgba(px, e.w), e.w, e.h);
        if (this.maskDiag.diff > 0) {
          console.info(`[minigame] 企鹅掩膜与 pickCell 不一致 ${this.maskDiag.diff} 像素（只诊断）`, this.maskDiag.top);
        }
      } finally {
        pack.releaseImage?.(e.file);
      }
    } catch (err) {
      console.warn('[minigame] 企鹅掩膜对拍失败', err);
    }
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

  private get started(): boolean {
    return this.phase === 'playing' || this.phase === 'waiting' || this.phase === 'result';
  }

  render(
    prev: Readonly<PenguinState>,
    s: Readonly<PenguinState>,
    alpha: number,
    fx: readonly SimFx[],
    now: number,
  ): void {
    const snd = this.ctx.sound;
    // 记忆阶段：埋藏物露头（开局前不亮出）
    const showBuried = s.phase === 'intro' && this.started;
    if (showBuried !== this.buriedShown) {
      this.buriedShown = showBuried;
      for (const c of this.buried.removeChildren()) c.destroy();
      if (showBuried) {
        for (const c of VALID_CELLS) {
          const k = s.board[c]!;
          if (k === 0) continue;
          const spr = new FrameSprite(this.screen, penguinBuriedFrame(k));
          const p = cellCenter(c);
          spr.position.set(p.x, p.y);
          this.buried.addChild(spr);
        }
      }
    }
    // 雪坑：已挖的格，以及正在挖的格
    const digging = s.digLeft > 0 ? s.cell : -1;
    const key = `${s.dug.join('')}|${digging}`;
    if (key !== this.dugKey) {
      this.dugKey = key;
      for (const c of this.holes.removeChildren()) c.destroy();
      for (const c of VALID_CELLS) {
        if (s.dug[c] !== 1 && c !== digging) continue;
        const spr = new FrameSprite(this.screen, PENGUIN_BG.hole);
        const p = cellCenter(c);
        spr.position.set(p.x, p.y);
        this.holes.addChild(spr);
      }
    }
    // 音效与揭晓动画
    for (const f of fx) {
      if (f.t === 'dig') snd.play(12);
      else if (f.t === 'reveal') {
        const sfx = PENGUIN_REVEAL_SFX[f.item] ?? 0;
        if (sfx > 0) snd.play(sfx);
        if (f.item > 0) this.reveal = { cell: f.cell, kind: f.item, t0: now };
      }
    }
    // 企鹅
    this.drawPenguin(prev, s, alpha, now);
    // 揭晓动画（6 帧）
    const rv = this.reveal;
    if (rv) {
      const sheet = this.ctx.kit.sheet(penguinRevealKey(rv.kind));
      const k = Math.floor((now - rv.t0) / ANIM_MS);
      if (!sheet || k >= sheet.count || k < 0) {
        this.revealSprite.visible = false;
        if (k >= (sheet?.count ?? 0)) this.reveal = null;
      } else {
        const p = cellCenter(rv.cell);
        this.revealSprite.show(sheet, k);
        this.revealSprite.position.set(p.x, p.y);
        this.revealSprite.visible = true;
      }
    } else this.revealSprite.visible = false;
    // 靶圈（原版为蓝色椭圆指针）
    const cell =
      this.pointer && s.phase === 'play' && this.ctx.mode === 'play' ? pickCell(this.pointer.x, this.pointer.y) : -1;
    if (cell !== this.targetCell) {
      this.targetCell = cell;
      this.target.clear();
      if (cell >= 0) {
        const { x, y } = cellCenter(cell);
        this.target.ellipse(x, y, HW * 0.62, HH * 0.62).stroke({ width: 3, color: 0x1f5fd8 });
        this.target.ellipse(x, y, HW * 0.36, HH * 0.36).stroke({ width: 2, color: 0x1f5fd8, alpha: 0.7 });
      }
    }
    this.target.alpha = 0.6 + 0.4 * Math.abs(Math.sin(now / 250));
    // HUD
    this.time.set(timeDigits(Math.max(0, s.timeLeft)));
    PENGUIN_HUD_KINDS.forEach((k, i) => {
      this.pairs[i]!.set(padDigits(s.counts[k] ?? 0, 2));
    });
    this.scoreRow.set(padDigits(PENGUIN_SIM.score(s as PenguinState), 3));
    // 结算：大号分数
    if (this.phase === 'result') {
      if (this.resultAt === null) this.resultAt = now;
      const score = this.result?.score ?? PENGUIN_SIM.score(s as PenguinState);
      if (this.big.value === null) snd.play(25);
      this.big.set(score);
    } else {
      this.resultAt = null;
      this.big.set(null);
    }
  }

  private drawPenguin(prev: Readonly<PenguinState>, s: Readonly<PenguinState>, alpha: number, now: number): void {
    const spr = this.penguinSprite;
    let pos = cellCenter(s.cell);
    if (s.endReason === 'bomb') {
      // 被炸：先站着（爆炸动画盖在上面），随后焦黑
      const t = this.reveal ? Math.floor((now - this.reveal.t0) / ANIM_MS) : 99;
      spr.show(this.screen, t < 3 ? PENGUIN_BG.idle : PENGUIN_BG.burnt);
    } else if (this.phase === 'result') {
      const score = this.result?.score ?? PENGUIN_SIM.score(s as PenguinState);
      const key = penguinPoseKey(score);
      const sheet = key ? this.ctx.kit.sheet(key) : null;
      if (sheet) {
        const t0 = this.resultAt ?? now;
        spr.show(sheet, Math.floor((now - t0) / ANIM_MS) % sheet.count);
        if (!this.poseSfx) {
          this.poseSfx = true;
          this.ctx.sound.play(key === 'mg.penguin.84' ? 13 : 14);
        }
      } else spr.show(this.screen, PENGUIN_BG.idle);
    } else if (s.digLeft > 0) {
      spr.show(this.digSheet, penguinDigFrame(s.dir, s.digLeft));
    } else if (s.walk !== null && s.walk.next >= 0) {
      const a = cellCenter(s.cell);
      const b = cellCenter(s.walk.next);
      const sub = s.walk.sub;
      const k = Math.min(1, (sub + alpha) / TICKS_PER_CELL);
      pos = { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) };
      spr.show(this.walkSheet, penguinWalkFrame(s.dir, Math.min(TICKS_PER_CELL - 1, Math.floor(sub + alpha))));
      const step = `${s.cell}>${s.walk.next}`;
      if (step !== this.lastStep) {
        this.lastStep = step;
        this.ctx.sound.play(11);
      }
    } else {
      spr.show(this.screen, PENGUIN_BG.idle);
      if (prev.cell !== s.cell) pos = cellCenter(s.cell);
    }
    if (s.walk === null) this.lastStep = '';
    spr.position.set(Math.round(pos.x), Math.round(pos.y));
    spr.zIndex = pos.y;
  }

  debug(): Record<string, unknown> {
    return {
      look: this.look,
      phase: this.phase,
      buried: this.buried.children.length,
      holes: this.holes.children.length,
      penguin: `${this.penguinSprite.sheet?.key ?? '?'}#${this.penguinSprite.frameIndex}`,
      hud: [this.time.value, ...this.pairs.map((p) => p.value), this.scoreRow.value],
      bigScore: this.big.value,
      maskDiag: this.maskDiag,
    };
  }

  destroy(): void {
    this.dead = true;
    this.root.destroy({ children: true });
  }
}

export async function createPenguinOrigView(ctx: OrigViewContext): Promise<PenguinOrigView> {
  return new PenguinOrigView(ctx);
}
