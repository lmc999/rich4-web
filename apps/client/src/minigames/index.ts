// 小游戏的前端入口（architecture §5.10；design/minigames-ai.md §7）：
// - startPlayerMinigame：MinigameIntro 倒计时结束后开宿主（play）；同一会话只开一次；
// - installMinigames：挂到 GameClient 的传输层（先取走 GameClient 在安装前缓存的票据与帧），处理观战票据（game:minigameWatch，live 在开局前 3 秒弹出、replay 结算后回放）、
//   输入帧（game:minigameFrames：观战者转交宿主；自己的帧先缓存供续玩）、以及对局批次里的 MINIGAME_ENDED（权威分数、跳过即关）。
//   宿主是自带 React root 的全屏遮罩，不依赖对局页的组件树；对局页只需在进入时调用一次 installMinigames（幂等）。
import type { GameEvent, PlayerIntent, SeatIndex } from '@rich4/shared/engine';
import { isMinigameTicket, type MinigameTicket } from '@rich4/shared/minigames';
import type { C2SAckData, C2SEventName, C2SPayload, Result, S2CEventName, S2CPayload } from '@rich4/shared/net';
import { testHooksEnabled } from '../app/flags';
import { testHooks } from '../dev/testHooks';
import type { MinigameBacklogItem } from '../net/client';
import { useGameStore } from '../store/gameStore';
import { seatDisplayName, useRoomStore } from '../store/roomStore';
import { type HostOptions, MiniGameHost } from './host/MiniGameHost';
import type { FeedFrame } from './host/SpectatorFeed';

export { MiniGameHost } from './host/MiniGameHost';

/** 观战遮罩在开局前多久弹出 */
export const SPECTATE_LEAD_MS = 3000;
/** 每个会话最多缓存的帧 */
const MAX_BUFFERED_FRAMES = 600;

/** GameClient 的最小依赖（便于测试注入） */
export interface MinigameClientPort {
  transport: {
    request<E extends C2SEventName>(event: E, payload: C2SPayload<E>): Promise<Result<C2SAckData<E>>>;
    on<E extends S2CEventName>(event: E, cb: (p: S2CPayload<E>) => void): () => void;
  };
  clock: { serverNow(): number };
  /** 安装前已到达的票据与帧（刷新、中途加入时服务器只补发一次）；安装时取走并按顺序处理 */
  takeMinigameBacklog?(): MinigameBacklogItem[];
  /**
   * 回答本人的决策（GameClient.act：与决策对话框共用全局提交锁）。原版入场 FLC 提前盖住开局倒计时对话框时，
   * 遮罩上的「不玩了」经它发 MINIGAME_DECLINE；没有时不提供该按钮。
   */
  act?(intent: PlayerIntent, decisionId?: string): Promise<Result<unknown>>;
}

function seatInfo(seat: SeatIndex): { name: string; characterId: number | null } {
  const room = useRoomStore.getState().room;
  const view = useGameStore.getState().view;
  const p = view?.players.find((x) => x.seat === seat);
  return {
    name: seatDisplayName(room, seat) ?? `${seat + 1}P`,
    characterId: p ? p.character : (room?.seats[seat]?.characterId ?? null),
  };
}

export class MinigameSessions {
  private readonly hosts = new Map<string, MiniGameHost>();
  /** 已结束或已放弃的会话（不再重开） */
  private readonly finished = new Set<string>();
  /** 宿主还没开时收到的帧（观战提前到达、自己的帧用于续玩） */
  private readonly buffered = new Map<string, FeedFrame[]>();
  /** 等待弹出的观战票据 */
  private readonly timers = new Map<
    string,
    { tm: ReturnType<typeof setTimeout>; seat: SeatIndex; decisionId: string }
  >();
  private offs: (() => void)[] = [];

  constructor(
    private readonly client: MinigameClientPort,
    private readonly extra: Partial<Pick<HostOptions, 'container' | 'headless' | 'clock' | 'resultMs'>> = {},
  ) {}

  install(): () => void {
    if (this.offs.length > 0) return () => this.uninstall();
    const t = this.client.transport;
    this.offs.push(
      t.on('game:minigameWatch', (m) => this.onWatch(m)),
      t.on('game:minigameFrames', (f) => this.onFrames(f)),
      t.on('game:batch', (b) => {
        this.onEvents(b.events);
        this.onPending(b.pending.map((p) => p.decisionId));
      }),
      t.on('game:catchup', (c) => {
        for (const b of c.batches) this.onEvents(b.events);
        this.onPending(c.pending.map((p) => p.decisionId));
      }),
      t.on('game:snapshot', (p) => this.onPending(p.pending.map((x) => x.decisionId))),
    );
    for (const m of this.client.takeMinigameBacklog?.() ?? []) {
      if (m.event === 'game:minigameWatch') this.onWatch(m.payload);
      else this.onFrames(m.payload);
    }
    return () => this.uninstall();
  }

  uninstall(): void {
    for (const off of this.offs.splice(0)) off();
    for (const x of this.timers.values()) clearTimeout(x.tm);
    this.timers.clear();
    for (const h of [...this.hosts.values()]) h.close();
  }

  /** 当前的宿主（测试钩子） */
  active(): MiniGameHost[] {
    return [...this.hosts.values()].filter((h) => !h.isClosed);
  }

  isDone(sessionId: string): boolean {
    return this.finished.has(sessionId);
  }

  // ───────────────────────── 玩家 ─────────────────────────

  /** 本人开局（MinigameIntro 倒计时结束）；同一会话已开或已结束时返回已有宿主或 null */
  startPlayer(ticket: MinigameTicket, o: { revealAt?: number } = {}): MiniGameHost | null {
    const cur = this.hosts.get(ticket.sessionId);
    if (cur && !cur.isClosed) return cur;
    if (this.finished.has(ticket.sessionId)) return null;
    // 同一决策换了新窗口（暂停恢复后新 sessionId）：旧宿主作废
    for (const h of [...this.hosts.values()]) {
      if (h.mode === 'play' && h.ticket.decisionId === ticket.decisionId && h.sessionId !== ticket.sessionId) {
        this.abandon(h.sessionId);
      }
    }
    const info = seatInfo(ticket.seat);
    const resume = this.buffered.get(ticket.sessionId) ?? [];
    this.buffered.delete(ticket.sessionId);
    const act = this.client.act?.bind(this.client);
    const allowDecline = useRoomStore.getState().room?.settings.allowMinigameDecline ?? true;
    const host = MiniGameHost.open({
      ticket,
      mode: 'play',
      now: () => this.client.clock.serverNow(),
      playerName: info.name,
      characterId: info.characterId,
      sendInput: (msg) => this.client.transport.request('game:minigameInput', msg),
      submit: (msg) => this.client.transport.request('game:minigameSubmit', msg),
      resumeFrames: resume,
      paused: () => useRoomStore.getState().room?.phase === 'paused',
      ...(o.revealAt !== undefined ? { revealAt: o.revealAt } : {}),
      ...(act && allowDecline
        ? {
            decline: async () => {
              const r = await act({ type: 'MINIGAME_DECLINE' }, ticket.decisionId);
              if (r.ok) this.finished.add(ticket.sessionId);
              return r.ok;
            },
          }
        : {}),
      onClosed: (h) => this.onClosed(h),
      ...this.extra,
    });
    this.hosts.set(ticket.sessionId, host);
    return host;
  }

  /** 放弃本会话（玩家开局前点了「不玩了」）：关闭宿主，不再重开 */
  abandon(sessionId: string): void {
    this.finished.add(sessionId);
    this.hosts.get(sessionId)?.close();
  }

  // ───────────────────────── 观战 ─────────────────────────

  private onWatch(m: S2CPayload<'game:minigameWatch'>): void {
    const t = m.ticket;
    if (!isMinigameTicket(t) || this.finished.has(t.sessionId)) return;
    // 同一会话的票据可能收到两次（同页断线重连后服务器按新 socket 再补发一次）：已开或已在等待弹出就忽略
    if (this.hosts.has(t.sessionId) || this.timers.has(t.sessionId)) return;
    if (m.mode === 'replay') {
      this.openWatch(t, 'replay', m.log ?? []);
      return;
    }
    this.dropStaleWatch(t);
    const wait = t.startsAt - SPECTATE_LEAD_MS - this.client.clock.serverNow();
    if (wait <= 0) {
      this.openWatch(t, 'spectate', null);
      return;
    }
    const tm = setTimeout(() => {
      this.timers.delete(t.sessionId);
      if (!this.finished.has(t.sessionId)) this.openWatch(t, 'spectate', null);
    }, wait);
    this.timers.set(t.sessionId, { tm, seat: t.seat, decisionId: t.decisionId });
  }

  /** 同一决策换了新会话（暂停恢复后新 sessionId）：旧的观战遮罩与待弹出的旧票据作废 */
  private dropStaleWatch(t: MinigameTicket): void {
    for (const h of [...this.hosts.values()]) {
      if (h.mode === 'spectate' && h.ticket.decisionId === t.decisionId && h.sessionId !== t.sessionId) {
        this.abandon(h.sessionId);
      }
    }
    for (const [sid, x] of [...this.timers]) {
      if (x.decisionId !== t.decisionId || sid === t.sessionId) continue;
      clearTimeout(x.tm);
      this.timers.delete(sid);
      this.finished.add(sid);
    }
  }

  private openWatch(
    t: MinigameTicket,
    mode: 'spectate' | 'replay',
    log: readonly FeedFrame['events'][number][] | null,
  ): void {
    const cur = this.hosts.get(t.sessionId);
    if (cur && !cur.isClosed) return;
    const info = seatInfo(t.seat);
    const host = MiniGameHost.open({
      ticket: t,
      mode,
      now: () => this.client.clock.serverNow(),
      playerName: info.name,
      characterId: info.characterId,
      ...(log ? { log } : {}),
      onClosed: (h) => this.onClosed(h),
      ...this.extra,
    });
    this.hosts.set(t.sessionId, host);
    const early = this.buffered.get(t.sessionId);
    this.buffered.delete(t.sessionId);
    if (early) for (const f of early) host.pushFrame(f);
  }

  private onFrames(f: S2CPayload<'game:minigameFrames'>): void {
    const h = this.hosts.get(f.sessionId);
    if (h && !h.isClosed) {
      if (h.mode === 'spectate') h.pushFrame(f);
      return;
    }
    if (this.finished.has(f.sessionId)) return;
    const list = this.buffered.get(f.sessionId) ?? [];
    if (list.length < MAX_BUFFERED_FRAMES) list.push({ seq: f.seq, events: f.events.slice() });
    this.buffered.set(f.sessionId, list);
  }

  private onEvents(events: readonly GameEvent[]): void {
    for (const e of events) {
      if (e.type !== 'MINIGAME_ENDED') continue;
      for (const h of this.hosts.values()) {
        if (h.isClosed || h.ticket.seat !== e.seat || h.mode === 'replay') continue;
        this.finished.add(h.sessionId);
        h.authoritative(e.mode, e.score);
      }
      // 还没弹出的观战票据（玩家开局前就跳过了）：直接作废
      for (const [sid, x] of this.timers) {
        if (x.seat !== e.seat) continue;
        clearTimeout(x.tm);
        this.timers.delete(sid);
        this.finished.add(sid);
      }
    }
  }

  /** 决策已不在待决列表（快照重置、结算批次被跳过）：对应的观战遮罩关闭 */
  private onPending(live: readonly string[]): void {
    const set = new Set(live);
    for (const h of this.hosts.values()) {
      if (h.isClosed || h.mode !== 'spectate' || set.has(h.ticket.decisionId)) continue;
      const snap = h.getSnapshot();
      if (snap.phase === 'result') continue;
      this.finished.add(h.sessionId);
      h.close();
    }
  }

  private onClosed(h: MiniGameHost): void {
    if (h.mode !== 'replay') this.finished.add(h.sessionId);
    if (this.hosts.get(h.sessionId) === h) this.hosts.delete(h.sessionId);
  }
}

let shared: MinigameSessions | null = null;
let sharedClient: MinigameClientPort | null = null;

/** 挂到全局 GameClient（幂等）；返回会话管理器 */
export function installMinigames(client: MinigameClientPort): MinigameSessions {
  if (shared && sharedClient === client) return shared;
  shared?.uninstall();
  shared = new MinigameSessions(client);
  sharedClient = client;
  shared.install();
  exposeTestHooks(shared);
  return shared;
}

/**
 * 本人的小游戏（MinigameIntro 调用；未安装时先安装）：决策一出现就在后台创建宿主并加载画面，到 startsAt 才显示遮罩。
 */
export function startPlayerMinigame(client: MinigameClientPort, ticket: MinigameTicket): MiniGameHost | null {
  return installMinigames(client).startPlayer(ticket, { revealAt: ticket.startsAt });
}

/** 放弃本人的小游戏会话（开局前点了「不玩了」） */
export function abandonPlayerMinigame(sessionId: string): void {
  shared?.abandon(sessionId);
}

export function minigameSessions(): MinigameSessions | null {
  return shared;
}

/** 测试钩子：window.__rich4.minigame（开发模式或 ?test=1） */
function exposeTestHooks(s: MinigameSessions): void {
  if (!testHooksEnabled()) return;
  const h = testHooks() as unknown as Record<string, unknown> | null;
  if (!h) return;
  const current = (): MiniGameHost | null => s.active()[0] ?? null;
  h.minigame = {
    state: () => current()?.debugState() ?? null,
    all: () => s.active().map((x) => x.debugState()),
    pick: (cell: number) => current()?.sink.pick(cell),
    click: (x: number, y: number) => current()?.sink.click({ x, y }),
    cursor: (x: number) => current()?.sink.cursor(x),
    close: () => current()?.close(),
  };
}
