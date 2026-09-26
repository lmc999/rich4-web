// 连接状态（design/client.md §10.1）：status / 重连次数 / RTT / 时钟偏移 / 握手错误 / 被顶替
import type { AppError } from '@rich4/shared/net';
import { create } from 'zustand';
import type { ConnStatus } from '../net/transport';

export interface ConnectionState {
  status: ConnStatus;
  attempt: number;
  rttMs: number | null;
  clockOffsetMs: number;
  /** 握手被拒等致命错误 */
  error: AppError | null;
  /** 同一 token 在别处登录（session:replaced） */
  replaced: boolean;
  /** 最近一次状态变化的本地时间（ReconnectOverlay 延迟 1 秒出现） */
  since: number;
  setStatus(status: ConnStatus, attempt: number, error?: AppError | null): void;
  setClock(offset: number, rtt: number | null): void;
  setReplaced(b: boolean): void;
  reset(): void;
}

const initial = {
  status: 'idle' as ConnStatus,
  attempt: 0,
  rttMs: null,
  clockOffsetMs: 0,
  error: null,
  replaced: false,
  since: 0,
};

export const useConnectionStore = create<ConnectionState>()((set, get) => ({
  ...initial,
  setStatus: (status, attempt, error) =>
    set({
      status,
      attempt,
      error: error === undefined ? get().error : error,
      since: get().status === status ? get().since : Date.now(),
    }),
  setClock: (clockOffsetMs, rttMs) => set({ clockOffsetMs, rttMs }),
  setReplaced: (replaced) => set({ replaced }),
  reset: () => set({ ...initial }),
}));
