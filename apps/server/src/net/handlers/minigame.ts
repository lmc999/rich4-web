/**
 * 小游戏的网络层（architecture §5.8、§5.10；design/minigames-ai.md §6）：
 * - game:minigameInput / game:minigameSubmit 处理器：seat 只从 session 取，校验与重放在 GameRunner → MinigameReferee；
 * - MinigameRelay：观战票据与输入帧的投递。
 *   · live 模式：MINIGAME 会话开着时，房间里其他人（座位与观战者）的每条连接在收到任意对局消息
 *     （game:batch / pending / snapshot / catchup）之后补发一次 game:minigameWatch（观战票据）与已接受的全部帧；
 *     之后每条被接受的输入经 game:minigameFrames 实时转发。迟到者、重连者（新 socket）自动补发。
 *   · 玩家本人的新连接（刷新、重连）补发自己已被接受的帧，客户端据此续玩。
 *   · replay 模式：不直播；本批出现「玩过」的 MINIGAME_ENDED 时向其他人下发带完整日志的观战票据。
 *   投递挂在传输层（io.ts 的 emitter 在发出对局消息后调用 afterEmit），不经 Room / RoomBroadcaster。
 */
import type { GameEvent } from '@rich4/shared/engine';
import {
  fail,
  type MinigameFramesMsg,
  type MinigameWatchMsg,
  ok,
  type Result,
  type S2CEventName,
} from '@rich4/shared/net';
import type { GameRunner } from '../../game/GameRunner';
import type { RefereeSession, SettledSession } from '../../game/MinigameReferee';
import type { ConnectedMember, Room } from '../../rooms/Room';
import { type AppSocket, type HandlerCtx, handle } from '../guard';
import { currentRoom } from './room';

/** 直接按 socket id 发送（不再经过 afterEmit） */
export type RawEmit = (ids: readonly string[], event: S2CEventName, payload: unknown) => void;

/** 之后需要补发观战票据的对局消息 */
const GAME_MESSAGES: ReadonlySet<string> = new Set(['game:batch', 'game:pending', 'game:snapshot', 'game:catchup']);

function seatOf(room: Room, tokenHash: string): Result<number> {
  const role = room.roleOf(tokenHash);
  if (!role) return fail('NOT_IN_ROOM');
  if (role.kind !== 'seat') return fail('NOT_A_PLAYER');
  return ok(role.seat);
}

function liveRunner(room: Room): Result<GameRunner> {
  if (!room.runner || room.phase === 'lobby') return fail('BAD_REQUEST', { reason: 'noGame' });
  if (room.phase === 'ended') return fail('GAME_OVER');
  if (room.phase === 'paused') return fail('GAME_PAUSED');
  return ok(room.runner);
}

export class MinigameRelay {
  /** 会话（或已结算记录）→ 已送达观战票据与积压帧的 socket */
  private readonly sent = new WeakMap<object, Set<string>>();

  constructor(
    private readonly ctx: Pick<HandlerCtx, 'rooms' | 'sessions' | 'log'>,
    private readonly send: RawEmit,
  ) {}

  private sentTo(key: object): Set<string> {
    let s = this.sent.get(key);
    if (!s) {
      s = new Set();
      this.sent.set(key, s);
    }
    return s;
  }

  /**
   * 消息接收者所在的房间：先按会话的 roomCode；入房 / 恢复时的快照在会话登记 roomCode 之前发出，
   * 这时按连接成员反查（只有这两种消息会走到这里）。
   */
  private roomOf(ids: readonly string[], event: string): Room | undefined {
    for (const id of ids) {
      const code = this.ctx.sessions.bySocketId(id)?.roomCode;
      if (code) return this.ctx.rooms.get(code);
    }
    if (event !== 'game:snapshot' && event !== 'game:catchup') return undefined;
    const want = new Set(ids);
    for (const room of this.ctx.rooms.all()) {
      if (room.phase === 'closed' || !room.runner) continue;
      if (room.connectedMembers().some((m) => want.has(m.socketId))) return room;
    }
    return undefined;
  }

  /** emitter 发出一条消息之后（io.ts 调用）；异常只记日志，不影响原消息 */
  afterEmit(ids: readonly string[], event: string, payload: unknown): void {
    if (!GAME_MESSAGES.has(event) || ids.length === 0) return;
    try {
      const room = this.roomOf(ids, event);
      if (!room?.runner || room.phase === 'lobby') return;
      const events = event === 'game:batch' ? ((payload as { events?: GameEvent[] }).events ?? []) : [];
      this.deliver(room, room.runner, ids, events);
    } catch (err) {
      this.ctx.log.error({ err, event }, 'minigame relay failed');
    }
  }

  private deliver(room: Room, runner: GameRunner, ids: readonly string[], events: readonly GameEvent[]): void {
    const members = new Map(room.connectedMembers().map((m) => [m.socketId, m]));
    const live = room.settings.minigameSpectate === 'live';
    for (const s of runner.minigames.active()) {
      const sent = this.sentTo(s);
      for (const id of ids) {
        if (sent.has(id)) continue;
        const m = members.get(id);
        if (!m) continue;
        const isPlayer = m.viewer.kind === 'seat' && m.viewer.seat === s.ticket.seat;
        if (isPlayer) {
          // 玩家本人的新连接：已开局才补发自己的帧（未开局时客户端从头开始）
          if (s.frames.length === 0) continue;
          sent.add(id);
          for (const f of s.frames) this.send([id], 'game:minigameFrames', f);
          continue;
        }
        if (!live) continue;
        sent.add(id);
        this.sendWatch(id, runner, s);
      }
    }
    if (!live) this.deliverReplays(room, runner, ids, events, members);
  }

  private sendWatch(id: string, runner: GameRunner, s: RefereeSession): void {
    const msg: MinigameWatchMsg = { ticket: runner.minigames.spectatorTicket(s), mode: 'live', log: null };
    this.send([id], 'game:minigameWatch', msg);
    for (const f of s.frames) this.send([id], 'game:minigameFrames', f);
  }

  /** replay 模式：本批里「玩过」的结算 → 带完整日志的观战票据（每条连接一次） */
  private deliverReplays(
    room: Room,
    runner: GameRunner,
    ids: readonly string[],
    events: readonly GameEvent[],
    members: ReadonlyMap<string, ConnectedMember>,
  ): void {
    if (room.settings.minigameSpectate !== 'replay') return;
    for (const e of events) {
      if (e.type !== 'MINIGAME_ENDED' || e.mode !== 'played') continue;
      const rec = lastSettled(runner.minigames.recentSettled(), e.seat);
      if (!rec) continue;
      const sent = this.sentTo(rec);
      for (const id of ids) {
        const m = members.get(id);
        if (!m || sent.has(id) || (m.viewer.kind === 'seat' && m.viewer.seat === e.seat)) continue;
        sent.add(id);
        const msg: MinigameWatchMsg = {
          ticket: { ...rec.ticket, params: { ...rec.ticket.params }, role: 'spectator' },
          mode: 'replay',
          log: rec.log.slice(),
        };
        this.send([id], 'game:minigameWatch', msg);
      }
    }
  }

  /** 被接受的输入：live 模式实时转发给其他人（没收到票据的先补票据与积压帧） */
  forward(room: Room, runner: GameRunner, frame: MinigameFramesMsg, senderSocketId: string): void {
    const s = runner.minigames.sessionById(frame.sessionId);
    if (!s) return;
    const sent = this.sentTo(s);
    sent.add(senderSocketId);
    if (room.settings.minigameSpectate !== 'live') return;
    const plain: string[] = [];
    for (const m of room.connectedMembers()) {
      if (m.socketId === senderSocketId) continue;
      if (m.viewer.kind === 'seat' && m.viewer.seat === s.ticket.seat) continue;
      if (sent.has(m.socketId)) {
        plain.push(m.socketId);
        continue;
      }
      sent.add(m.socketId);
      this.sendWatch(m.socketId, runner, s);
    }
    if (plain.length > 0) this.send(plain, 'game:minigameFrames', frame);
  }
}

function lastSettled(list: readonly SettledSession[], seat: number): SettledSession | undefined {
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.ticket.seat === seat) return list[i];
  return undefined;
}

export function registerMinigameHandlers(ctx: HandlerCtx, socket: AppSocket, relay: MinigameRelay): void {
  handle(ctx, socket, 'game:minigameInput', (p, s, sock) => {
    const r = currentRoom(ctx, s);
    if (!r.ok) return r;
    const room = r.data;
    const seat = seatOf(room, s.tokenHash);
    if (!seat.ok) return seat;
    const run = liveRunner(room);
    if (!run.ok) return run;
    const res = run.data.minigameInput(seat.data as 0 | 1 | 2 | 3, p);
    if (!res.ok) return res;
    relay.forward(room, run.data, res.data, sock.id);
    return ok(undefined);
  });
  handle(ctx, socket, 'game:minigameSubmit', (p, s) => {
    const r = currentRoom(ctx, s);
    if (!r.ok) return r;
    const seat = seatOf(r.data, s.tokenHash);
    if (!seat.ok) return seat;
    const run = liveRunner(r.data);
    if (!run.ok) return run;
    return run.data.minigameSubmit(seat.data as 0 | 1 | 2 | 3, p);
  });
}
