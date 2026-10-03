// 门禁状态（original-skin.md U4；design-draft §5.3「前端」）：
// - status：最近一次 GET /api/access 的结果（mode、granted、grants、canGrant）；接口不可用时 statusError=true；
// - required：需要显示门禁页的原因（素材包 401、Socket.IO 握手 ACCESS_REQUIRED、其他 /api 401、手动）；
// - requireAccess(reason)：置位并确保有门禁页可显示（对局页挂着 AccessGateHost；否则自行挂一个全屏浮层）。
import type { AccessStatus } from '@rich4/shared/net';
import { create } from 'zustand';
import { fetchAccessStatus } from './accessApi';

export type AccessReason = 'pack' | 'socket' | 'api' | 'startup' | 'manual';

export interface AccessState {
  status: AccessStatus | null;
  /** GET /api/access 失败（旧服务器没有该接口、网络错误） */
  statusError: boolean;
  required: AccessReason | null;
  /** 已挂载的门禁页宿主数（页面自带的宿主 + 自挂的全屏浮层） */
  hosts: number;
  /** 刷新状态（并发调用合并为一次请求） */
  refresh(): Promise<AccessStatus | null>;
  /** 已知状态直接用，否则刷新一次 */
  ensureStatus(): Promise<AccessStatus | null>;
  require(reason: AccessReason): void;
  dismiss(): void;
  /** 通过门禁（口令 / 兑换成功）后写入最新状态并收起门禁页 */
  granted(status: AccessStatus): void;
}

let inflight: Promise<AccessStatus | null> | null = null;

export const useAccessStore = create<AccessState>()((set, get) => ({
  status: null,
  statusError: false,
  required: null,
  hosts: 0,
  refresh: () => {
    if (inflight) return inflight;
    const p = fetchAccessStatus().then((r) => {
      if (r.ok) set({ status: r.data, statusError: false });
      else set({ statusError: true });
      return r.ok ? r.data : null;
    });
    inflight = p;
    void p.finally(() => {
      if (inflight === p) inflight = null;
    });
    return p;
  },
  ensureStatus: () => {
    const s = get().status;
    return s ? Promise.resolve(s) : get().refresh();
  },
  require: (reason) => set({ required: reason }),
  dismiss: () => set({ required: null }),
  granted: (status) => set({ status, statusError: false, required: null }),
}));

/** 门禁是否开启（状态未知时按关闭处理） */
export function accessEnabled(s: AccessStatus | null): boolean {
  return s !== null && s.mode !== 'off';
}

/**
 * 经房间邀请链接进入（kind g）的会话绑定的房间号：只能加入这个房间，建房、单机、读档、进别的房间都会被服务器拒绝
 * （ACCESS_SCOPE，architecture §35）。其他情况（口令 / 邀请码会话、门禁关闭、状态未知）为 null。
 */
export function guestRoomOf(s: AccessStatus | null): string | null {
  if (s === null || s.mode === 'off' || !s.granted || s.kind !== 'g') return null;
  return s.room ?? null;
}

/** 钩子：当前会话绑定的房间号（见 guestRoomOf）；状态由入口的 bootstrapAccess 取得 */
export function useGuestRoom(): string | null {
  return useAccessStore((s) => guestRoomOf(s.status));
}

/** 邀请链接会话绑定的房间是否已经结束（状态里 roomOpen 为 false；旧服务器没有这个字段时按还在） */
export function guestRoomClosedOf(s: AccessStatus | null): boolean {
  return guestRoomOf(s) !== null && s?.roomOpen === false;
}

/** 钩子：绑定的房间已经结束（见 guestRoomClosedOf） */
export function useGuestRoomClosed(): boolean {
  return useAccessStore((s) => guestRoomClosedOf(s.status));
}

/** 会话的硬性到期（毫秒时间戳；带到期时间的邀请码登录的会话），没有为 null */
export function accessDeadlineOf(s: AccessStatus | null): number | null {
  if (s === null || s.mode === 'off' || !s.granted) return null;
  return typeof s.deadline === 'number' ? s.deadline : null;
}

// ───────────────────────── 门禁页的挂载 ─────────────────────────

let hosts = 0;

/** AccessGateHost 挂载 / 卸载时登记（有宿主时不再自挂浮层；自挂的浮层在另有宿主时让位，见 AccessGateHost.standalone） */
export function registerAccessHost(): () => void {
  hosts++;
  useAccessStore.setState({ hosts });
  return () => {
    hosts--;
    useAccessStore.setState({ hosts });
  };
}

export function accessHostMounted(): boolean {
  return hosts > 0;
}

let standalone: Promise<void> | null = null;

/** 其他 /api 请求被门禁拒绝（HTTP 401）时显示门禁页；返回是否被拒 */
export function noteApiStatus(status: number): boolean {
  if (status !== 401) return false;
  requireAccess('api');
  return true;
}

/**
 * 需要门禁：置位 required；当前页面没有 AccessGateHost 时（首页、房间页），动态挂一个全屏门禁浮层。
 * Socket.IO 握手收到 ACCESS_REQUIRED、其他 /api 返回 401 时也调用它（接线见 net 层）。
 */
export function requireAccess(reason: AccessReason): void {
  useAccessStore.getState().require(reason);
  if (accessHostMounted() || typeof document === 'undefined' || standalone) return;
  standalone = import('./mountAccessGate')
    .then((m) => m.mountAccessGate())
    .catch((e: unknown) => {
      console.warn('[access] 门禁页挂载失败', e);
    })
    .finally(() => {
      standalone = null;
    });
}
