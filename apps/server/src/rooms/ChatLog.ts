/**
 * 房间聊天记录（design/net.md §9）：最近 CHAT_HISTORY_SIZE 条的环形缓冲，加入或恢复时经 chat:history 下发。
 * 文本清洗在 shared/net/schemas 的 sanitizeChatText；随房间快照持久化（all / restore）。
 */
import { CHAT_HISTORY_SIZE, type ChatMessage, type ChatSender, type SystemMsgKey } from '@rich4/shared/net';

export class ChatLog {
  private readonly items: ChatMessage[] = [];
  private n = 0;

  constructor(
    private readonly now: () => number,
    private readonly capacity = CHAT_HISTORY_SIZE,
  ) {}

  private nextId(): string {
    this.n++;
    return `m${this.now().toString(36)}-${this.n}`;
  }

  push(m: ChatMessage): ChatMessage {
    this.items.push(m);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
    return m;
  }

  text(from: ChatSender, text: string, audience: ChatMessage['audience']): ChatMessage {
    return this.push({ id: this.nextId(), ts: this.now(), from, text, audience });
  }

  system(key: SystemMsgKey, params: Record<string, string | number> = {}): ChatMessage {
    return this.push({
      id: this.nextId(),
      ts: this.now(),
      from: { kind: 'system' },
      system: { key, params },
      audience: 'all',
    });
  }

  /** 观战者能看到全部；玩家只能看到 audience='all' 的消息 */
  historyFor(isSpectator: boolean): ChatMessage[] {
    return isSpectator ? [...this.items] : this.items.filter((m) => m.audience === 'all');
  }

  get size(): number {
    return this.items.length;
  }

  /** 全部记录（快照与存档用；返回副本） */
  all(): ChatMessage[] {
    return [...this.items];
  }

  /** 从快照恢复（保留最近 capacity 条）；之后的 id 仍按时间戳 + 计数生成，不会与旧 id 冲突 */
  restore(items: readonly ChatMessage[]): void {
    this.items.length = 0;
    for (const m of items.slice(-this.capacity)) this.items.push(m);
    this.n = Math.max(this.n, this.items.length);
  }

  clear(): void {
    this.items.length = 0;
  }
}
