// 系统消息（net SystemMsgKey）→ 本地化文案：chat 面板与 toast 共用
import type { ChatMessage, SystemMsgKey } from '@rich4/shared/net';
import type { LooseT } from './names';

export function systemText(t: LooseT, m: Pick<ChatMessage, 'system'>): string {
  const sys = m.system;
  if (!sys) return '';
  const params: Record<string, unknown> = { ...sys.params };
  if (typeof params.reason === 'string') {
    params.reason = t(`hud:systemReason.${params.reason}`, { defaultValue: params.reason });
  }
  if (typeof params.seat === 'number') params.seatNo = params.seat + 1;
  const text = t(`hud:system.${sys.key}`, { ...params, defaultValue: sys.key });
  // 读档时数据表与服务器不一致：只告警、仍可开局（net.md §8.3）
  if (sys.key === 'gameLoaded' && params.tablesMismatch === 1) return text + t('hud:saves.tablesMismatchNote');
  return text;
}

/** 除了进聊天记录，还要弹 toast 的系统消息 */
export const TOAST_SYSTEM_KEYS: ReadonlySet<SystemMsgKey> = new Set<SystemMsgKey>([
  'timeoutDefault',
  'autopilotOn',
  'autopilotOff',
  'hostChanged',
  'gamePaused',
  'gameResumed',
  'aiPaused',
  'internalError',
  'kicked',
  'serverRestored',
]);
