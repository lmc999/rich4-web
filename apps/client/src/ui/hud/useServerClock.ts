// HUD 用的服务器时间：Date.now() + time:ping 校准的偏移
import { useCallback } from 'react';
import { useConnectionStore } from '../../store/connectionStore';

export function useServerNow(): () => number {
  const offset = useConnectionStore((s) => s.clockOffsetMs);
  return useCallback(() => Date.now() + offset, [offset]);
}
