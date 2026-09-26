/**
 * room:* 处理器（design/net.md §3、§4.5）。同一 token 同时只能在一个进行中的房间里：
 * 加入新房间前，原房间在大厅或已结束则自动离开；原房间正在对局且本人有座位时返回 ALREADY_IN_ROOM。
 */
import { fail, ok, type Result } from '@rich4/shared/net';
import type { Identity, Room } from '../../rooms/Room';
import { type AppSocket, type HandlerCtx, handle } from '../guard';
import type { Session } from '../sessions';

export function identityOf(s: Session, socket: AppSocket): Identity {
  return { tokenHash: s.tokenHash, nickname: s.nickname, socketId: socket.id };
}

export function currentRoom(ctx: HandlerCtx, s: Session): Result<Room> {
  const room = s.roomCode ? ctx.rooms.get(s.roomCode) : undefined;
  if (!room) {
    s.roomCode = null;
    return fail('NOT_IN_ROOM');
  }
  return ok(room);
}

/** 能否离开其他房间去 code（只读）：原房间正在对局且本人有座位时 ALREADY_IN_ROOM */
function canLeaveOthers(ctx: HandlerCtx, s: Session, code: string | null): Result<void> {
  if (!s.roomCode || s.roomCode === code) return ok(undefined);
  const prev = ctx.rooms.get(s.roomCode);
  if (prev?.inGame && prev.roleOf(s.tokenHash)?.kind === 'seat') return fail('ALREADY_IN_ROOM');
  return ok(undefined);
}

/** 进入 code 之前离开其他房间；调用前应先通过 canLeaveOthers 与目标房间的只读检查 */
function leaveOthers(ctx: HandlerCtx, s: Session, code: string | null): Result<void> {
  const can = canLeaveOthers(ctx, s, code);
  if (!can.ok) return can;
  if (!s.roomCode || s.roomCode === code) return ok(undefined);
  const prev = ctx.rooms.get(s.roomCode);
  if (prev?.roleOf(s.tokenHash)) prev.leave(s.tokenHash);
  s.roomCode = null;
  return ok(undefined);
}

/** join / resume 找不到房间或不是成员：统一记一次 IP 失败并返回 ROOM_NOT_FOUND（不泄露房间是否存在） */
function joinFailed(ctx: HandlerCtx, s: Session): Result<never> {
  ctx.limiter.takeIp(s.ip, 'joinFail');
  return fail('ROOM_NOT_FOUND');
}

export function registerRoomHandlers(ctx: HandlerCtx, socket: AppSocket): void {
  // 所有只读检查（原房间能否离开、限额、容量、设置）都通过后，才离开原大厅房间并建房
  handle(ctx, socket, 'room:create', (p, s) => {
    const can = canLeaveOthers(ctx, s, null);
    if (!can.ok) return can;
    if (!ctx.limiter.takeIp(s.ip, 'create')) return fail('RATE_LIMITED');
    const prep = ctx.rooms.prepareCreate(p.settings);
    if (!prep.ok) return prep;
    const left = leaveOthers(ctx, s, null);
    if (!left.ok) return left;
    const r = ctx.rooms.create(identityOf(s, socket), p.settings);
    if (!r.ok) return r;
    const room = r.data.room;
    s.roomCode = room.code;
    room.resume(identityOf(s, socket), 0, 0);
    return ok({ code: room.code, inviteUrl: room.inviteUrl });
  });

  handle(ctx, socket, 'room:join', (p, s) => {
    if (!ctx.limiter.peekIp(s.ip, 'joinFail')) return fail('RATE_LIMITED');
    const room = ctx.rooms.get(p.code);
    if (!room) return joinFailed(ctx, s);
    const can = canLeaveOthers(ctx, s, p.code);
    if (!can.ok) return can;
    const chk = room.canJoin(s.tokenHash, p.role);
    if (!chk.ok) return chk;
    const left = leaveOthers(ctx, s, p.code);
    if (!left.ok) return left;
    const r = room.join(identityOf(s, socket), p.role);
    if (r.ok) s.roomCode = room.code;
    return r;
  });

  // resume 与 join 共用按 IP 的失败额度；房间不存在与不是成员返回同一个错误码，防止借 resume 扫房间号
  handle(ctx, socket, 'room:resume', (p, s) => {
    if (!ctx.limiter.peekIp(s.ip, 'joinFail')) return fail('RATE_LIMITED');
    const room = ctx.rooms.get(p.code);
    if (!room?.roleOf(s.tokenHash)) return joinFailed(ctx, s);
    const left = leaveOthers(ctx, s, p.code);
    if (!left.ok) return left;
    const r = room.resume(identityOf(s, socket), p.lastSeq, p.epoch);
    if (r.ok) s.roomCode = room.code;
    return r;
  });

  const withRoom =
    <T>(fn: (room: Room, s: Session) => Result<T>) =>
    (_p: unknown, s: Session): Result<T> => {
      const r = currentRoom(ctx, s);
      return r.ok ? fn(r.data, s) : r;
    };

  handle(
    ctx,
    socket,
    'room:leave',
    withRoom((room, s) => room.leave(s.tokenHash)),
  );
  handle(
    ctx,
    socket,
    'room:dissolve',
    withRoom((room, s) => room.dissolve(s.tokenHash)),
  );
  handle(ctx, socket, 'room:updateSettings', (p, s) => {
    const r = currentRoom(ctx, s);
    return r.ok ? r.data.updateSettings(s.tokenHash, p.patch) : r;
  });
  handle(ctx, socket, 'room:takeSeat', (p, s) => {
    const r = currentRoom(ctx, s);
    return r.ok ? r.data.takeSeat(s.tokenHash, p.seat) : r;
  });
  handle(
    ctx,
    socket,
    'room:toSpectator',
    withRoom((room, s) => room.toSpectator(s.tokenHash)),
  );
  handle(ctx, socket, 'room:selectCharacter', (p, s) => {
    const r = currentRoom(ctx, s);
    return r.ok ? r.data.selectCharacter(s.tokenHash, p.characterId) : r;
  });
  handle(ctx, socket, 'room:setReady', (p, s) => {
    const r = currentRoom(ctx, s);
    return r.ok ? r.data.setReady(s.tokenHash, p.ready) : r;
  });
  handle(ctx, socket, 'room:setSeatAi', (p, s) => {
    const r = currentRoom(ctx, s);
    return r.ok ? r.data.setSeatAi(s.tokenHash, p.seat, p.ai) : r;
  });
  handle(ctx, socket, 'room:kick', (p, s) => {
    const r = currentRoom(ctx, s);
    return r.ok ? r.data.kick(s.tokenHash, p.target) : r;
  });
  handle(ctx, socket, 'room:transferHost', (p, s) => {
    const r = currentRoom(ctx, s);
    return r.ok ? r.data.transferHost(s.tokenHash, p.seat) : r;
  });
  handle(
    ctx,
    socket,
    'room:start',
    withRoom((room, s) => room.start(s.tokenHash)),
  );
  handle(
    ctx,
    socket,
    'room:rematch',
    withRoom((room, s) => room.rematch(s.tokenHash)),
  );
  // 存档读档与座位认领在 M5 实现；先给出明确的错误而不是让请求挂起
  handle(ctx, socket, 'room:loadSave', (_p, s) => {
    const r = currentRoom(ctx, s);
    return r.ok ? fail('SAVE_NOT_FOUND') : r;
  });
  handle(ctx, socket, 'room:claimSeat', (_p, s) => {
    const r = currentRoom(ctx, s);
    return r.ok ? fail('BAD_REQUEST', { reason: 'noLoadedSave' }) : r;
  });
}
