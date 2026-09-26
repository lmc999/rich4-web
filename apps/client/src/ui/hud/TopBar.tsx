// 顶栏（design/client.md §5.1）：日历牌（年月日 星期）、回合数、股市跑马灯、日志 / 聊天 / 菜单按钮
import type { MapIndex } from '@rich4/shared/data';
import type { RoomView } from '@rich4/shared/net';
import type { GameView } from '@rich4/shared/view';
import type { ReactNode } from 'react';
import { useTx } from '../../i18n/tx';
import { formatDate, holidayName, weekdayName } from '../../presentation/names';
import { useChatStore } from '../../store/chatStore';
import { useUiStore } from '../../store/uiStore';
import h from './hud.module.css';
import { StockTicker } from './StockTicker';

export function TopBar({
  view,
  map,
  room,
  onMenu,
}: {
  view: GameView;
  map: MapIndex | null;
  room: RoomView;
  onMenu(): void;
}): ReactNode {
  const t = useTx();
  const unread = useChatStore((s) => s.unread);
  const chatOpen = useUiStore((s) => s.chatOpen);
  const logOpen = useUiStore((s) => s.logOpen);
  const c = view.clock;
  const holiday = c.holiday ? holidayName(t, view.dataRef.mapId, c.holiday) : null;
  return (
    <header className={h.topBar} data-testid="top-bar">
      <div className={h.calendar} data-testid="hud-date" data-date={c.date}>
        <span className={h.calDate}>{formatDate(c.date)}</span>
        <span className={h.calWeek}>{weekdayName(c.weekday)}</span>
        {holiday && <span className={h.calHoliday}>{holiday}</span>}
      </div>
      <div className={h.turnNo} data-testid="hud-turn" data-turn={c.turnNo}>
        {t('hud:top.turn', { n: c.turnNo })}
      </div>
      <StockTicker view={view} map={map} />
      <div className={h.topButtons}>
        {room.you.role === 'spectator' && <span className={h.specBadge}>👁 {t('hud:top.spectating')}</span>}
        <span className={h.roomCode}>
          {t('hud:top.room')} <span className="num">{room.code}</span>
        </span>
        <button
          type="button"
          className="btn btn--sm btn--cream"
          aria-pressed={logOpen}
          onClick={() => useUiStore.getState().setLogOpen(!logOpen)}
          data-testid="top-log"
        >
          {t('hud:top.log')}
        </button>
        <button
          type="button"
          className="btn btn--sm btn--cream"
          aria-pressed={chatOpen}
          onClick={() => useUiStore.getState().setChatOpen(!chatOpen)}
          data-testid="top-chat"
        >
          {t('hud:top.chat')}
          {unread > 0 && <span className={h.unread}>{unread}</span>}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={onMenu}
          data-testid="top-menu"
          aria-label={t('hud:top.menu')}
        >
          ≡
        </button>
      </div>
    </header>
  );
}
