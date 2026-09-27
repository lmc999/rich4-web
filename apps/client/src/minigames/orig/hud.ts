// 小游戏原版 HUD：底图上的白框里贴 Panel#79 图0–9 液晶数字（y = 421）；结算时场景中央画图10–19 大号彩色数字。

import { Container } from 'pixi.js';
import type { SpriteSheet } from '../../game/orig/OrigAssets';
import { bigScoreLayout, HUD_DIGIT_Y, lcdFrame } from './frames';
import { FrameSprite } from './kit';

/** 一行液晶数字（每个字位一个精灵，只在文字变化时换帧） */
export class LcdRow extends Container {
  private readonly cells: FrameSprite[];
  private text = '';

  constructor(
    private readonly sheet: SpriteSheet,
    xs: readonly number[],
    y = HUD_DIGIT_Y,
  ) {
    super();
    this.cells = xs.map((x) => {
      const s = new FrameSprite(sheet, 0);
      s.position.set(x, y);
      this.addChild(s);
      return s;
    });
  }

  set(text: string): void {
    if (text === this.text) return;
    this.text = text;
    this.cells.forEach((c, i) => {
      c.show(this.sheet, lcdFrame(text[i] ?? '0'));
    });
  }

  get value(): string {
    return this.text;
  }
}

/** 结算大号分数（null 隐藏） */
export class BigScore extends Container {
  private shown: number | null = null;

  constructor(private readonly sheet: SpriteSheet) {
    super();
    this.visible = false;
    this.label = 'big-score';
  }

  set(score: number | null): void {
    if (score === this.shown) return;
    this.shown = score;
    for (const c of this.removeChildren()) c.destroy();
    this.visible = score !== null;
    if (score === null) return;
    for (const d of bigScoreLayout(score)) {
      const s = new FrameSprite(this.sheet, d.frame);
      s.position.set(d.x, d.y);
      this.addChild(s);
    }
  }

  get value(): number | null {
    return this.shown;
  }
}
