// 首页 / 大厅（design/client.md §5.5）：昵称、创建房间、输入房间号加入（或观战）、单机、公开房间、设置。
import { ROOM_CODE_RE } from '@rich4/shared/net';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'wouter';
import { useRoomStore } from '../../store/roomStore';
import { normalizeNickname, useSettingsStore } from '../../store/settingsStore';
import c from '../common/common.module.css';
import { CreateRoomForm } from '../lobby/CreateRoomForm';
import { PublicRooms } from '../lobby/PublicRooms';
import { ReconnectOverlay } from '../system/ReconnectOverlay';
import { SettingsDialog } from '../system/SettingsDialog';
import { ScreenShell, shellStyles as s } from './ScreenShell';

type Mode = 'none' | 'create' | 'join';

export function HomeScreen(): ReactNode {
  const { t } = useTranslation('lobby');
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
        <Link href="/solo" className="btn btn--green" data-testid="home-solo" onClick={() => commitNick()}>
          {t('home.solo')}
        </Link>
        <button
          type="button"
          className="btn btn--sm btn--cream"
          onClick={() => setSettingsOpen(true)}
          data-testid="home-settings"
        >
          {t('home.settings')}
        </button>
      </div>

      {mode === 'join' && (
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

      {mode === 'create' && <CreateRoomForm onCreated={(c6) => navigate(`/r/${c6}`)} />}

      {error && (
        <p className={c.error} role="alert" data-testid="home-error">
          {error}
        </p>
      )}

      <PublicRooms onJoin={(c6, watch) => navigate(`/r/${c6}${watch ? '?watch=1' : ''}`)} />

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
