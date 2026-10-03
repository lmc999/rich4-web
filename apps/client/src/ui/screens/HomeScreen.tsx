// 首页 / 大厅（design/client.md §5.5）：昵称、创建房间、输入房间号加入（或观战）、读取存档、单机、公开房间、设置。
// 读取存档：列出本人拥有的服务器存档（也可导入 .r4save），选中后新建私密房间并 room:loadSave，随即进入该房间大厅。
// 经房间邀请链接进入的会话（访问 cookie kind g，architecture §35）只能加入邀请的那个房间：建房、加入别的房间、读档、单机、
// 公开房间都不显示，改为一行说明（home-guest-note）、「回到房间」（home-guest-room）与「我有口令」（home-guest-passcode：
// 打开门禁页输入口令或邀请码，成功后换成完整权限）；邀请的房间已经结束时不给「回到房间」，说明换成 home-guest-closed。
// 用带到期时间的邀请码登录时显示有效期（home-access-until）。
import { ROOM_CODE_RE } from '@rich4/shared/net';
import { type FormEvent, lazy, type ReactNode, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'wouter';
import { useTx } from '../../i18n/tx';
import { useRoomStore } from '../../store/roomStore';
import { normalizeNickname, useSettingsStore } from '../../store/settingsStore';
import {
  accessDeadlineOf,
  requireAccess,
  useAccessStore,
  useGuestRoom,
  useGuestRoomClosed,
} from '../access/accessStore';
import { formatAccessDeadline } from '../access/accessTime';
import c from '../common/common.module.css';
import { CreateRoomForm } from '../lobby/CreateRoomForm';
import { PublicRooms } from '../lobby/PublicRooms';
import { ReconnectOverlay } from '../system/ReconnectOverlay';
import { SettingsDialog } from '../system/SettingsDialog';
import { ScreenShell, shellStyles as s } from './ScreenShell';

type Mode = 'none' | 'create' | 'join' | 'load';

// 存档面板按需加载（首屏不含存档、导入导出与 HUD toast 的代码）
const HomeSaves = lazy(() => import('./HomeSaves'));

export function HomeScreen(): ReactNode {
  const { t } = useTranslation('lobby');
  const tx = useTx();
  const nickname = useSettingsStore((st) => st.nickname);
  const setNickname = useSettingsStore((st) => st.setNickname);
  const closed = useRoomStore((st) => st.closed);
  const [nick, setNick] = useState(nickname);
  const [mode, setMode] = useState<Mode>('none');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [closedNote, setClosedNote] = useState<string | null>(null);
  const [, navigate] = useLocation();
  const guestRoom = useGuestRoom();
  const guestClosed = useGuestRoomClosed();
  const deadline = useAccessStore((st) => accessDeadlineOf(st.status));

  // 邀请链接会话：进首页时重新看一次绑定的房间是否还在（房间可能刚结束）
  useEffect(() => {
    if (guestRoom) void useAccessStore.getState().refresh();
  }, [guestRoom]);

  // 从房间被踢或房间关闭后回到首页：提示一次
  useEffect(() => {
    if (!closed) return;
    setClosedNote(t(`closed.${closed.reason}`, { code: closed.code }));
    useRoomStore.getState().clear();
  }, [closed, t]);

  const commitNick = (): boolean => {
    const v = normalizeNickname(nick);
    if (!v) {
      setError(t('home.nickEmpty'));
      return false;
    }
    setNickname(v);
    setNick(v);
    return true;
  };

  const onJoin = (e: FormEvent, watch: boolean): void => {
    e.preventDefault();
    setError(null);
    if (!commitNick()) return;
    const c6 = code.trim();
    if (!ROOM_CODE_RE.test(c6)) {
      setError(t('home.codeInvalid'));
      return;
    }
    navigate(`/r/${c6}${watch ? '?watch=1' : ''}`);
  };

  return (
    <ScreenShell testId="screen-home">
      <div className={s.logo} aria-hidden="true">
        4
      </div>
      <h1 className={s.title}>{t('home.title')}</h1>
      <p className={s.tagline}>{t('home.tagline')}</p>

      {closedNote && (
        <p className={c.error} role="status" data-testid="home-closed-note">
          {closedNote}
        </p>
      )}
      {guestRoom && (
        <p className={c.muted} role="note" data-testid={guestClosed ? 'home-guest-closed' : 'home-guest-note'}>
          {guestClosed ? t('home.guestClosed') : t('home.guestNote')}
        </p>
      )}
      {deadline !== null && (
        <p className={c.muted} data-testid="home-access-until">
          {t('home.accessUntil', { time: formatAccessDeadline(deadline) })}
        </p>
      )}

      <label className={c.field} style={{ maxWidth: 320, margin: '0 auto' }}>
        <span>{t('home.nickname')}</span>
        <input
          className="input"
          value={nick}
          maxLength={24}
          onChange={(e) => setNick(e.target.value)}
          onBlur={commitNick}
          data-testid="home-nickname"
          autoComplete="nickname"
        />
      </label>

      <div className={s.actions}>
        {guestRoom ? (
          <>
            {!guestClosed && (
              <Link
                href={`/r/${guestRoom}`}
                className="btn btn--green"
                data-testid="home-guest-room"
                onClick={() => commitNick()}
              >
                {t('home.guestBack', { code: guestRoom })}
              </Link>
            )}
            <button
              type="button"
              className={guestClosed ? 'btn btn--blue' : 'btn btn--cream'}
              onClick={() => requireAccess('manual')}
              data-testid="home-guest-passcode"
            >
              {t('home.havePasscode')}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setError(null);
                if (commitNick()) setMode(mode === 'create' ? 'none' : 'create');
              }}
              aria-expanded={mode === 'create'}
              data-testid="home-create"
            >
              {t('home.createRoom')}
            </button>
            <button
              type="button"
              className="btn btn--cream"
              onClick={() => setMode(mode === 'join' ? 'none' : 'join')}
              aria-expanded={mode === 'join'}
              data-testid="home-join-open"
            >
              {t('home.joinRoom')}
            </button>
            <button
              type="button"
              className="btn btn--cream"
              onClick={() => {
                setError(null);
                if (commitNick()) setMode(mode === 'load' ? 'none' : 'load');
              }}
              aria-expanded={mode === 'load'}
              data-testid="home-load-open"
            >
              {t('home.loadSave')}
            </button>
            <Link href="/solo" className="btn btn--green" data-testid="home-solo" onClick={() => commitNick()}>
              {t('home.solo')}
            </Link>
          </>
        )}
        <button
          type="button"
          className="btn btn--sm btn--cream"
          onClick={() => setSettingsOpen(true)}
          data-testid="home-settings"
        >
          {t('home.settings')}
        </button>
      </div>

      {mode === 'join' && !guestRoom && (
        <form className={c.row} style={{ justifyContent: 'center' }} onSubmit={(e) => onJoin(e, false)}>
          <input
            className="input num"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            placeholder={t('home.codePlaceholder')}
            aria-label={t('home.codePlaceholder')}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            data-testid="home-join-code"
            style={{ width: 140, fontSize: 20, textAlign: 'center' }}
          />
          <button type="submit" className="btn btn--blue" data-testid="home-join">
            {t('home.join')}
          </button>
          <button type="button" className="btn btn--cream" onClick={(e) => onJoin(e, true)} data-testid="home-watch">
            {t('home.watch')}
          </button>
        </form>
      )}

      {mode === 'create' && !guestRoom && <CreateRoomForm onCreated={(c6) => navigate(`/r/${c6}`)} />}

      {mode === 'load' && !guestRoom && (
        <Suspense fallback={<p className={c.muted}>{tx('ui:common.loading')}</p>}>
          <HomeSaves onEnter={(c6) => navigate(`/r/${c6}`)} />
        </Suspense>
      )}

      {error && (
        <p className={c.error} role="alert" data-testid="home-error">
          {error}
        </p>
      )}

      {!guestRoom && <PublicRooms onJoin={(c6, watch) => navigate(`/r/${c6}${watch ? '?watch=1' : ''}`)} />}

      <nav className={s.devLinks} aria-label="dev">
        <Link href="/dev/map" className="btn btn--sm btn--blue">
          {t('home.devMap')}
        </Link>
        <Link href="/dev/gallery" className="btn btn--sm btn--blue">
          {t('home.devGallery')}
        </Link>
        <Link href="/dev/decisions" className="btn btn--sm btn--blue">
          {t('home.devDecisions')}
        </Link>
      </nav>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} inGame={false} />
      <ReconnectOverlay essentialOnly />
    </ScreenShell>
  );
}
