/**
 * time:ping：客户端用 offset = serverNow + rtt/2 − Date.now() 校准倒计时（design/net.md §4.7）。
 */
import { ok } from '@rich4/shared/net';
import { type AppSocket, type HandlerCtx, handle } from '../guard';

export function registerTimeHandlers(ctx: HandlerCtx, socket: AppSocket): void {
  handle(ctx, socket, 'time:ping', (p) => ok({ t0: p.t0, serverNow: ctx.clock.now() }));
}
