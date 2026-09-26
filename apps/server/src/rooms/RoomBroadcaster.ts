/**
 * 按观察者投影并分组发送（design/net.md §6.1）：payload 按 (viewerClassKey, 是否为决策者) 分组，
 * 每组只组装、序列化一次。只依赖 Emitter 接口，换传输层只需替换 Emitter 的实现。
 */
import type { ChatMessage, EmoteMsg, GameOverMsg, RoomClosedReason, S2CEventName, S2CPayload } from '@rich4/shared/net';
import type { Viewer } from '@rich4/shared/view';
import type { GameRunner, RawBatch } from '../game/GameRunner';
import type { Room } from './Room';

export interface Emitter {
  emit<E extends S2CEventName>(socketIds: readonly string[], event: E, payload: S2CPayload<E>): void;
}

interface Group {
  viewer: Viewer;
  ids: string[];
}

export class RoomBroadcaster {
  constructor(private readonly em: Emitter) {}

  toSocket<E extends S2CEventName>(socketId: string, event: E, payload: S2CPayload<E>): void {
    this.em.emit([socketId], event, payload);
  }

  /** 房间任何变化都发全量；you/isYou 因人而异，逐个发送 */
  roomState(room: Room): void {
    for (const m of room.connectedMembers()) this.em.emit([m.socketId], 'room:state', room.viewFor(m.tokenHash));
  }

  private groups(room: Room, runner: GameRunner): Group[] {
    const byKey = new Map<string, Group>();
    for (const m of room.connectedMembers()) {
      const deciding = m.viewer.kind === 'seat' && runner.decisionFor(m.viewer.seat) !== undefined;
      const key = `${runner.classKey(m.viewer)}|${deciding && m.viewer.kind === 'seat' ? m.viewer.seat : '-'}`;
      const g = byKey.get(key);
      if (g) g.ids.push(m.socketId);
      else byKey.set(key, { viewer: m.viewer, ids: [m.socketId] });
    }
    return [...byKey.values()];
  }

  gameBatch(room: Room, runner: GameRunner, raw: RawBatch): void {
    const compose = runner.composeBatch(raw);
    for (const g of this.groups(room, runner)) this.em.emit(g.ids, 'game:batch', compose(g.viewer));
  }

  gamePending(room: Room, runner: GameRunner): void {
    for (const g of this.groups(room, runner)) this.em.emit(g.ids, 'game:pending', runner.pendingMsg(g.viewer));
  }

  gameOver(room: Room, msg: GameOverMsg): void {
    const ids = room.connectedMembers().map((m) => m.socketId);
    if (ids.length > 0) this.em.emit(ids, 'game:over', msg);
  }

  chat(room: Room, msg: ChatMessage): void {
    const ids = room
      .connectedMembers()
      .filter((m) => msg.audience === 'all' || m.viewer.kind === 'spectator')
      .map((m) => m.socketId);
    if (ids.length > 0) this.em.emit(ids, 'chat:message', msg);
  }

  emote(room: Room, msg: EmoteMsg): void {
    const ids = room.connectedMembers().map((m) => m.socketId);
    if (ids.length > 0) this.em.emit(ids, 'chat:emote', msg);
  }

  closed(socketIds: readonly string[], reason: RoomClosedReason): void {
    if (socketIds.length > 0) this.em.emit(socketIds, 'room:closed', { reason });
  }
}
