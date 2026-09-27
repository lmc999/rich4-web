// 门禁页宿主：accessStore.required 非空时显示 AccessGate；通过后按原因收尾——
// 素材包 401（reason 'pack'）只刷新状态，由 skinStore 重新请求素材包；其他原因（握手、/api 401）重新载入页面，
// 让 Socket.IO 带着新 cookie 重新握手（兑换了房间授权时直接进那个房间）。
// 对局期间门禁开启时按 ACCESS_RENEW_HINT_MS 的一半定期 GET /api/access，给 cookie 滑动续期。
import { ACCESS_RENEW_HINT_MS, type AccessStatus } from '@rich4/shared/net';
import { type ReactNode, useCallback, useEffect } from 'react';
import { AccessGate } from './AccessGate';
import { accessEnabled, registerAccessHost, useAccessStore } from './accessStore';

export const ACCESS_RENEW_INTERVAL_MS = ACCESS_RENEW_HINT_MS / 2;

function reloadInto(room: string | null): void {
  if (typeof location === 'undefined') return;
  const target = room ? `/r/${room}${location.search}` : `${location.pathname}${location.search}`;
  location.replace(target);
}

export interface AccessGateHostProps {
  /** 通过门禁后的页面跳转（测试注入；缺省重新载入） */
  reload?(room: string | null): void;
  /** 定期续期（对局页开启） */
  renew?: boolean;
}

export function AccessGateHost({ reload = reloadInto, renew = false }: AccessGateHostProps): ReactNode {
  const required = useAccessStore((s) => s.required);
  const status = useAccessStore((s) => s.status);

  useEffect(() => registerAccessHost(), []);

  const enabled = accessEnabled(status) && status?.granted === true;
  useEffect(() => {
    if (!renew || !enabled) return;
    const id = setInterval(() => void useAccessStore.getState().refresh(), ACCESS_RENEW_INTERVAL_MS);
    return () => clearInterval(id);
  }, [renew, enabled]);

  const onGranted = useCallback(
    (s: AccessStatus, room: string | null) => {
      const reason = useAccessStore.getState().required;
      if (reason !== 'pack' || room !== null) {
        // 要重新载入：门禁页保持显示直到新页面接手（不先露出旧页面，也不让旧页面在导航途中继续请求）
        useAccessStore.setState({ status: s, statusError: false });
        reload(room);
        return;
      }
      useAccessStore.getState().granted(s);
    },
    [reload],
  );

  if (required === null) return null;
  return <AccessGate reason={required} onGranted={onGranted} />;
}
