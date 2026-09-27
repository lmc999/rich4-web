/**
 * 落点码 2：新闻格（design/engine.md §8、§10.6）。停下才触发；梦游中跳过（squares/index.ts）。
 * 游标取下一张可行的新闻并压 NEWS 帧（effects/news）。
 */
import { drawNews } from '../effects/news/index';
import type { SquareHandler } from './index';

export const newsSquare: SquareHandler = (ctx) => {
  drawNews(ctx);
};
