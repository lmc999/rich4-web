/**
 * 会话注册表（design/net.md §5.1）：按 tokenHash 索引；同一 tokenHash 的新连接顶替旧连接，
 * 新 session 接管旧 session 的 roomCode（房间内的座位按 tokenHash 认人）。
 * 服务端只处理 sha256(token)，token 本身不落地、不回显、不广播。
 */

export interface Session {
  tokenHash: string;
  nickname: string;
  socketId: string | null;
  ip: string;
  /** 当前所在房间（room:leave、被踢、房间关闭后清空） */
  roomCode: string | null;
}

export class SessionRegistry {
  private readonly byToken = new Map<string, Session>();
  private readonly bySocket = new Map<string, string>();

  /** 挂上新连接；返回被顶替的旧 socketId（如果有） */
  attach(
    tokenHash: string,
    nickname: string,
    socketId: string,
    ip: string,
  ): { session: Session; replaced: string | null } {
    let s = this.byToken.get(tokenHash);
    let replaced: string | null = null;
    if (s) {
      if (s.socketId && s.socketId !== socketId) {
        replaced = s.socketId;
        this.bySocket.delete(s.socketId);
      }
      s.socketId = socketId;
      s.nickname = nickname;
      s.ip = ip;
    } else {
      s = { tokenHash, nickname, socketId, ip, roomCode: null };
      this.byToken.set(tokenHash, s);
    }
    this.bySocket.set(socketId, tokenHash);
    return { session: s, replaced };
  }

  /** socket 断开；只有它仍是该会话的当前连接时才清空。没有房间的空闲会话直接删除 */
  detach(socketId: string): Session | null {
    const token = this.bySocket.get(socketId);
    if (token === undefined) return null;
    this.bySocket.delete(socketId);
    const s = this.byToken.get(token);
    if (!s || s.socketId !== socketId) return null;
    s.socketId = null;
    if (s.roomCode === null) this.byToken.delete(token);
    return s;
  }

  get(tokenHash: string): Session | undefined {
    return this.byToken.get(tokenHash);
  }

  bySocketId(socketId: string): Session | undefined {
    const t = this.bySocket.get(socketId);
    return t === undefined ? undefined : this.byToken.get(t);
  }

  /** 成员离开房间 code：清掉会话的 roomCode；离线且无房间的会话删除 */
  clearRoom(tokenHash: string, code: string): void {
    const s = this.byToken.get(tokenHash);
    if (!s || s.roomCode !== code) return;
    s.roomCode = null;
    if (s.socketId === null) this.byToken.delete(tokenHash);
  }

  get size(): number {
    return this.byToken.size;
  }

  get connected(): number {
    return this.bySocket.size;
  }
}
