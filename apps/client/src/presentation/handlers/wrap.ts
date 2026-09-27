// handler 的统一包装（handlers/index.ts 对全部事件使用）：
// 1) 舞台同步：事件前按提交前显示态、事件后按「提交前显示态 + post」同步路面物件 / 神明 / 恶人 / 乞丐 / 角色状态外观，
//    reset、跳过或棋盘晚挂载之后，下一个事件就能追上（整合后 BoardController.syncView 也会同步舞台）；
//    原版舞台另在事件前收到 beginEvent（事件、预算、ctx.audio），据此安排原版 FLIC 的可用时长与同步音效；
// 2) 时长封顶：handler 最多运行当前房间演出节奏下的 EVENT_BUDGET_MS[pacing]（服务器按同一张表算截止时间，见 ./budget），
//    到点中止其余演出（补间直接落到终态），保证客户端永远不会比服务器的预算更慢。handler 自然结束时不中止：不阻塞的尾巴（回合横幅、离场动画、金币）照常播完；
// 3) 外层（EventPlayer 的 reset / skipAll / dispose）中止后，GameClient 给的上下文失效（board 变成 NULL_BOARD），
//    这里的事件后同步随之跳过，被中止的 handler 收尾时不会用旧时间线的状态覆盖刚同步好的棋盘。
import type { GameEvent, GameEventType, PostPatch } from '@rich4/shared/engine';
import { applyPostPatch } from '@rich4/shared/view';
import type { EventHandler, PresentationContext } from '../types';
import { budgetMs } from './budget';
import { stageOf } from './stage';

/** post 是否改到了舞台关心的字段 */
export function touchesStage(post: PostPatch | undefined): boolean {
  if (!post) return false;
  if (post.objects || post.gods || post.beggars || post.villains) return true;
  for (const p of post.players ?? []) {
    const s = p.set;
    if (
      s.god !== undefined ||
      s.st !== undefined ||
      s.vehicle !== undefined ||
      s.bomb !== undefined ||
      s.alive !== undefined ||
      s.node !== undefined
    ) {
      return true;
    }
  }
  return false;
}

/** 以新的中止信号派生上下文（其余字段沿用原型，包括实时取值的 board） */
function derive(ctx: PresentationContext, signal: AbortSignal, aborted: Promise<void>): PresentationContext {
  return Object.create(ctx, {
    signal: { value: signal, enumerable: true },
    wait: { value: (ms: number) => Promise.race([ctx.wait(ms), aborted]), enumerable: true },
  }) as PresentationContext;
}

export function wrapHandler<T extends GameEventType>(h: EventHandler<T>): EventHandler<T> {
  return async (e, ctx) => {
    const budget = budgetMs(e as GameEvent);
    const before = stageOf(ctx);
    if (before.ready) {
      before.syncWorld(ctx.view());
      // 原版舞台：按本事件与预算安排原版 FLIC、接上 FLIC 同步音效（程序化舞台没有这个钩子）
      before.beginEvent?.(e as GameEvent, { audio: ctx.audio, budgetMs: budget });
    }
    const ac = new AbortController();
    const relay = (): void => ac.abort();
    if (ctx.signal.aborted) ac.abort();
    else ctx.signal.addEventListener('abort', relay, { once: true });
    const aborted = new Promise<void>((resolve) => {
      if (ac.signal.aborted) resolve();
      else ac.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    let capped = false;
    try {
      const run = h(e, derive(ctx, ac.signal, aborted));
      const cap = ctx.wait(budget).then(() => {
        capped = true;
      });
      await Promise.race([run, cap]);
      // 到点：中止剩余演出，等 handler 在终态收尾（自然结束的不中止，保留不阻塞的尾巴）
      if (capped) ac.abort();
      await run;
    } finally {
      // 自然结束时保留转发：尾巴还在播时外层中止，照样传给它们
      if (capped || ac.signal.aborted) ctx.signal.removeEventListener('abort', relay);
      const post = (e as GameEvent).post;
      if (!ctx.signal.aborted && touchesStage(post)) {
        const after = stageOf(ctx);
        if (after.ready) after.syncWorld(applyPostPatch(ctx.view(), post));
      }
    }
  };
}
