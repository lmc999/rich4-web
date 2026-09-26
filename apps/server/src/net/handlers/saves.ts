/**
 * saves:list / saves:delete（design/net.md §8.3–§8.4）：只列出本人（tokenHash）是 owner 的存档；
 * 删除只移除本人的归属，没有 owner 的存档随之删除。不是 owner 与不存在一律 SAVE_NOT_FOUND。
 */
import { fail, ok } from '@rich4/shared/net';
import { type AppSocket, type HandlerCtx, handle } from '../guard';

export function registerSavesHandlers(ctx: HandlerCtx, socket: AppSocket): void {
  handle(ctx, socket, 'saves:list', (_p, s) => ok({ saves: ctx.saves ? ctx.saves.list(s.tokenHash) : [] }));
  handle(ctx, socket, 'saves:delete', (p, s) =>
    ctx.saves ? ctx.saves.remove(s.tokenHash, p.saveId) : fail('SAVE_NOT_FOUND'),
  );
}
