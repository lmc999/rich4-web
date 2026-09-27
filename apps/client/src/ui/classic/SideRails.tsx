// 联机侧栏（original-skin.md §4.1）：原版没有对应物的联机信息放在舞台两侧——
//   左栏：房间号与邀请、当前回合与决策倒计时、座位（在线 / 托管 / 电脑、现金 / 存款 / 点券）、观战者、速度与镜头；
//   右栏：聊天（含表情）与事件日志。
// 外观用原版消息框（Data#476 图5，深棕底金边）装饰；素材缺失时同色系 CSS。座位条沿用程序化玩家条的测试钩子
// （chip-<seat> / p<seat>-cash 等 data-value），E2E 在两种布局下读同一套数值；座位条同样带紧凑的神明与状态徽章
// （StatusBadges compact）和头顶气泡的 DOM 副本（bubble-<seat>）。
// 抽屉模式（手机、多数笔电）下倒计时与等待条（RailStatus）不放在抽屉里，由 ClassicStage 叠在棋盘视窗左上角。
import { characterDef, type MapIndex } from '@rich4/shared/data';
import { CHARACTER_KEYS } from '@rich4/shared/engine';
import type { RoomView } from '@rich4/shared/net';
import { type GameView, isAutopilot, type PlayerView } from '@rich4/shared/view';
import clsx from 'clsx';
import { type ReactNode, useState } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import { useChatStore } from '../../store/chatStore';
import { currentSeat, useGameStore } from '../../store/gameStore';
import { mySeat } from '../../store/roomStore';
import { type AnimSpeed, useSettingsStore } from '../../store/settingsStore';
import { useUiStore } from '../../store/uiStore';
import { portraitUrl } from '../common/Avatar';
import { useRemainingMs } from '../components/Countdown';
import { EventLogPanel } from '../hud/EventLogPanel';
import { seatName } from '../hud/PlayerChips';
import { StatusBadges } from '../hud/StatusBadges';
import { useServerNow } from '../hud/useServerClock';
import { WaitingBanner } from '../hud/WaitingBanner';
import { InviteLink } from '../lobby/InviteLink';
import { ChatPanel } from '../social/ChatPanel';
import { SpectatorList } from '../social/SpectatorList';
import { useHeadBubble } from '../social/socialStore';
import c from './classic.module.css';
import { formatShort } from './format';
import { Sprite, useSpriteFrame } from './Sprite';

/** 消息框（Data#476 图5 195×133）：侧栏顶部的房间信息牌，按侧栏宽度等比缩放 */
function MessageBoxHead({ width, children }: { width: number; children: ReactNode }): ReactNode {
  const f = useSpriteFrame('ui.common', 5);
  const scale = f ? Math.min(1.6, Math.max(0.5, width / f.w)) : 1;
  return (
    <div
      className={clsx(c.box, c.boxHead)}
      data-art={f ? 'true' : 'false'}
      style={f ? { height: Math.round(f.h * scale), width: Math.round(f.w * scale), alignSelf: 'center' } : undefined}
    >
      {f && <Sprite sheet="ui.common" frame={5} x={0} y={0} scale={scale} origin="topLeft" />}
      <div
        className={c.boxHeadInner}
        style={f ? { padding: `${Math.round(40 * scale)}px ${Math.round(16 * scale)}px 0` } : undefined}
      >
        {children}
      </div>
    </div>
  );
}

/** 我自己的决策倒计时（等别人的决策由 WaitingBanner 显示） */
function MyCountdown(): ReactNode {
  const t = useTx();
  const decision = useGameStore((s) => s.decision);
  const now = useServerNow();
  const { remainingMs } = useRemainingMs(decision?.deadlineAt ?? null, now, decision?.decisionId ?? '');
  if (!decision) return null;
  const secs = remainingMs === null ? null : Math.ceil(remainingMs / 1000);
  return (
    <div
      className={c.countdown}
      role="timer"
      data-testid="classic-my-countdown"
      data-kind={decision.kind}
      data-urgent={secs !== null && secs <= 5 ? 'true' : 'false'}
    >
      <span>{decision.kind === 'TURN_MENU' ? t('classic:rail.myTurn') : t('classic:rail.myDecision')}</span>
      <span className={`${c.secs} ${c.num}`}>
        {secs === null ? t('classic:rail.unlimited') : t('classic:rail.secs', { n: secs })}
      </span>
    </div>
  );
}

function SeatRow({ p, room, current }: { p: PlayerView; room: RoomView; current: boolean }): ReactNode {
  const t = useTx();
  const inspect = useUiStore((s) => s.inspectSeat);
  const sv = room.seats[p.seat];
  const control = sv?.control ?? 'human';
  const occ = sv?.occupant ?? null;
  const human = occ?.kind === 'human';
  const offline = occ?.kind === 'human' && !occ.connected;
  const mine = room.you.role === 'player' && room.you.seat === p.seat;
  const face = useSpriteFrame('portrait.face72', p.character);
  // 头顶气泡总线（表情 2 秒、聊天 3 秒；棋盘角色头顶同步显示）：座位条上放一份 DOM 副本（读屏与 E2E）
  const bubble = useHeadBubble(p.seat);
  return (
    <li className={c.seatItem}>
      {bubble && (
        <span className={c.seatBubble} data-testid={`bubble-${p.seat}`} aria-live="polite">
          {bubble.kind === 'emote' ? bubble.glyph : bubble.text}
        </span>
      )}
      <button
        type="button"
        className={c.seat}
        onClick={() => useUiStore.getState().setInspectSeat(inspect === p.seat ? null : p.seat)}
        aria-pressed={inspect === p.seat}
        data-testid={`chip-${p.seat}`}
        data-current={current ? 'true' : 'false'}
        data-alive={p.alive ? 'true' : 'false'}
      >
        <span className={c.seatAvatar}>
          {face ? (
            <Sprite sheet="portrait.face72" frame={p.character} x={0} y={0} scale={0.5} />
          ) : (
            <img src={portraitUrl(p.character, p.alive ? 'normal' : 'sad')} alt="" draggable={false} />
          )}
        </span>
        <span className={c.seatBody}>
          <span className={c.seatName}>
            <span className={c.seatColor} style={{ background: characterDef(p.character).color }} aria-hidden="true" />
            {t(`characters:${CHARACTER_KEYS[p.character]}.name`)}
            {mine && <em>（{t('classic:profile.you')}）</em>}
          </span>
          <span className={c.seatNick}>{seatName(room, p.seat)}</span>
          <span className={c.seatStats}>
            <span title={t('hud:stat.cash')}>
              <em>{t('hud:stat.cash')}</em>{' '}
              <span className={c.num} data-testid={`p${p.seat}-cash`} data-value={p.cash}>
                {formatShort(t, p.cash)}
              </span>
            </span>
            <span title={t('hud:stat.deposit')}>
              <em>{t('hud:stat.deposit')}</em>{' '}
              <span className={c.num} data-testid={`p${p.seat}-deposit`} data-value={p.deposit}>
                {formatShort(t, p.deposit)}
              </span>
            </span>
            <span title={t('hud:stat.points')}>
              <em>{t('hud:stat.points')}</em>{' '}
              <span className={c.num} data-testid={`p${p.seat}-points`} data-value={p.points}>
                {p.points}
              </span>
            </span>
          </span>
          <span className={c.tags}>
            {current && (
              <span className={c.tag} data-kind="auto">
                {t('classic:rail.current')}
              </span>
            )}
            {human && !offline && (
              <span className={c.tag} data-kind="online">
                {t('classic:rail.online')}
              </span>
            )}
            {offline && (
              <span className={c.tag} data-kind="offline">
                {t('classic:rail.offline')}
              </span>
            )}
            {isAutopilot(control) && (
              <span className={c.tag} data-kind="auto" data-testid={`chip-${p.seat}-autopilot`}>
                {t('classic:rail.autopilot')}
              </span>
            )}
            {control === 'ai' && (
              <span className={c.tag} data-kind="ai">
                {t('classic:rail.ai')}
              </span>
            )}
            {!p.alive && (
              <span className={c.tag} data-kind="out">
                {t('classic:profile.out')}
              </span>
            )}
          </span>
          <StatusBadges player={p} compact testId={`chip-status-${p.seat}`} />
        </span>
      </button>
    </li>
  );
}

export interface LeftRailProps {
  room: RoomView;
  view: GameView;
  map: MapIndex | null;
  width: number;
  onFocusMe(): void;
  /** 在房间信息牌里显示倒计时与等待条（整栏模式；抽屉模式由舞台叠层显示，这里不重复） */
  showStatus?: boolean;
}

/** 本人倒计时 + 等待条（整栏时在左栏信息牌里，抽屉模式时叠在棋盘视窗左上角） */
export function RailStatus({ room, view, map }: { room: RoomView; view: GameView; map: MapIndex | null }): ReactNode {
  return (
    <>
      <MyCountdown />
      <WaitingBanner view={view} room={room} map={map} />
    </>
  );
}

/**
 * 侧栏的邀请链接：展开时才挂载 InviteLink。门禁开启时 InviteLink 一挂载就生成房间授权（写库、每 IP 限次），
 * 对局页每次载入 / 重连都生成一个没人用的授权没有意义。
 */
function InviteDetails({ room }: { room: RoomView }): ReactNode {
  const t = useTx();
  const [open, setOpen] = useState(false);
  return (
    <details
      className={clsx(c.box, c.inviteDetails)}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      data-testid="classic-invite"
    >
      <summary>{t('classic:rail.invite')}</summary>
      {open && <InviteLink code={room.code} allowWatch={room.settings.allowSpectators} />}
    </details>
  );
}

export function LeftRail({ room, view, map, width, onFocusMe, showStatus = true }: LeftRailProps): ReactNode {
  const t = useTx();
  const client = useClient();
  const speed = useSettingsStore((s) => s.speed);
  const playing = useGameStore((s) => s.anim.playing);
  const decision = useGameStore((s) => s.decision);
  const submitting = useGameStore((s) => s.submitting);
  const cur = currentSeat(view);
  const me = mySeat(room);
  const next: AnimSpeed = speed === 3 ? 1 : ((speed + 1) as AnimSpeed);
  const menuReady = decision?.kind === 'TURN_MENU' && submitting !== decision.decisionId;
  return (
    <>
      <MessageBoxHead width={Math.max(120, width - 16)}>
        <div className={clsx(c.roomLine, c.outline)}>
          <span data-testid="classic-room-code">{t('classic:rail.room', { code: room.code })}</span>
          <span data-testid="hud-turn" data-turn={view.clock.turnNo}>
            {t('classic:rail.turn', { n: view.clock.turnNo })}
          </span>
        </div>
        {me === null && <div className={c.outline}>👁 {t('classic:rail.spectating')}</div>}
        {showStatus && (
          <div className={c.headStatus}>
            <RailStatus room={room} view={view} map={map} />
          </div>
        )}
      </MessageBoxHead>
      <InviteDetails room={room} />
      <div className={c.box}>
        <h3>{t('classic:rail.seats')}</h3>
        <ul className={c.seats} data-testid="player-chips">
          {view.players.map((p) => (
            <SeatRow key={p.seat} p={p} room={room} current={cur === p.seat} />
          ))}
        </ul>
      </div>
      <div className={c.controls}>
        <button
          type="button"
          className={c.ctrlBtn}
          onClick={() => useSettingsStore.getState().setSpeed(next)}
          title={t('hud:action.speed')}
          data-testid="action-speed"
        >
          ⏩ <span className={c.num}>{speed}x</span>
        </button>
        {playing && (
          <button type="button" className={c.ctrlBtn} onClick={() => client.player.skipAll()} data-testid="action-skip">
            ⏭ {t('hud:action.skip')}
          </button>
        )}
        <button
          type="button"
          className={c.ctrlBtn}
          onClick={onFocusMe}
          title={t('classic:rail.focus')}
          data-testid="action-focus"
        >
          🎯
        </button>
        {me !== null && (
          <button
            type="button"
            className={c.ctrlBtn}
            disabled={!menuReady}
            onClick={() => useUiStore.getState().openMenu(null)}
            title={t('hud:action.moreTitle')}
            data-testid="action-menu"
          >
            ⋯ {t('classic:rail.menu')}
          </button>
        )}
      </div>
      <div className={c.box}>
        <SpectatorList room={room} />
      </div>
    </>
  );
}

export function RightRail({ room, visible }: { room: RoomView; visible: boolean }): ReactNode {
  const t = useTx();
  const [tab, setTab] = useState<'chat' | 'log'>('chat');
  const unread = useChatStore((s) => s.unread);
  return (
    <>
      <div className={c.tabs}>
        <button type="button" aria-pressed={tab === 'chat'} onClick={() => setTab('chat')} data-testid="top-chat">
          {t('classic:rail.chat')}
          {tab !== 'chat' && unread > 0 && <span className={c.badge}>{unread}</span>}
        </button>
        <button type="button" aria-pressed={tab === 'log'} onClick={() => setTab('log')} data-testid="top-log">
          {t('classic:rail.log')}
        </button>
      </div>
      <div className={c.railFill}>
        {tab === 'chat' ? <ChatPanel room={room} visible={visible} /> : <EventLogPanel />}
      </div>
    </>
  );
}

/** 未读聊天数（抽屉按钮角标） */
export function useUnreadChat(): number {
  return useChatStore((s) => s.unread);
}
