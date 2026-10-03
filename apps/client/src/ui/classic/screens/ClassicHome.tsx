// 原版标题画面（original-skin.md §4.3；ui.md §2.3：Data#1 图0 底图，图1–6 START / LOAD / OPTION 常态 / 悬停，图7–8 EXIT）。
// 按钮映射：START → 开局设置（建房）；LOAD → 读取存档；OPTION → 设置（系统设置、重播片头）；底部按钮带：昵称、加入房间号
// （可观战）、单机对战、公开房间。标题音乐由音频接线按「没有房间 = 标题」播放（app/audioWiring）。
// 首次进入播放片头（素材包 video.start，可跳过）。程序化首页（ui/screens/HomeScreen）的逻辑与 testid 照搬：
// home-nickname、home-create、home-join-open / home-join-code / home-join / home-watch、home-load-open（home-saves）、
// home-solo、home-settings、home-error、home-closed-note、home-guest-note / home-guest-closed / home-guest-room /
// home-guest-passcode、home-access-until，
// E2E 在两种皮肤下用同一组选择器。
// 经房间邀请链接进入的会话（kind g，architecture §35）只能加入邀请的那个房间：START / LOAD 变暗禁用，按钮带的加入 / 单机 /
// 公开房间换成「回到房间」与「我有口令」（打开门禁页输入口令或邀请码），画面上方一行说明；邀请的房间已经结束时只剩
// 「我有口令」，说明换成「请向朋友要新的邀请链接，或输入口令」。
import { ROOM_CODE_RE } from '@rich4/shared/net';
import clsx from 'clsx';
import { type FormEvent, lazy, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useTx } from '../../../i18n/tx';
import { currentPackClient } from '../../../skin/skinStore';
import { useRoomStore } from '../../../store/roomStore';
import { normalizeNickname, useSettingsStore } from '../../../store/settingsStore';
import {
  accessDeadlineOf,
  requireAccess,
  useAccessStore,
  useGuestRoom,
  useGuestRoomClosed,
} from '../../access/accessStore';
import { formatAccessDeadline } from '../../access/accessTime';
import { Modal } from '../../components/Modal';
import { PublicRooms } from '../../lobby/PublicRooms';
import { ReconnectOverlay } from '../../system/ReconnectOverlay';
import { SettingsDialog } from '../../system/SettingsDialog';
import { ensureClassicImage, useClassicAssets } from '../assets';
import { useEnsureSceneSprites } from '../common/sceneAssets';
import { regionStyle } from '../layout';
import { Sprite, useSheetStatus } from '../Sprite';
import ClassicCreate from './ClassicCreate';
import { IntroVideo, introUrl, shouldAutoPlayIntro } from './IntroVideo';
import { ensureScreensI18n } from './i18n';
import {
  SETUP_BG,
  SETUP_SHEET,
  TITLE_BAND,
  TITLE_BUTTONS,
  TITLE_GUEST,
  TITLE_PANEL,
  TITLE_SHEET,
  type TitleButtonId,
} from './layout';
import { ClassicScreenFrame, ExitButton, HotButton } from './parts';
import { ScreensPending } from './pending';
import s from './screens.module.css';
import { playScreenCue } from './uiSound';

const HomeSaves = lazy(() => import('../../screens/HomeSaves'));

type Panel = 'none' | 'create' | 'join' | 'options' | 'load' | 'public';

const BUTTON_TEST_IDS: Readonly<Record<TitleButtonId, string>> = {
  start: 'home-create',
  load: 'home-load-open',
  option: 'title-option',
};

export default function ClassicHome(): ReactNode {
  ensureScreensI18n();
  const t = useTx();
  const nickname = useSettingsStore((st) => st.nickname);
  const setNickname = useSettingsStore((st) => st.setNickname);
  const closed = useRoomStore((st) => st.closed);
  const [nick, setNick] = useState(nickname);
  const [panel, setPanel] = useState<Panel>('none');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [closedNote, setClosedNote] = useState<string | null>(null);
  const [, navigate] = useLocation();
  const guestRoom = useGuestRoom();
  const guestClosed = useGuestRoomClosed();
  // 邀请链接会话：进标题时重新看一次绑定的房间是否还在（房间可能刚结束）
  useEffect(() => {
    if (guestRoom) void useAccessStore.getState().refresh();
  }, [guestRoom]);
  const deadline = useAccessStore((st) => accessDeadlineOf(st.status));
  const intro = useMemo(() => introUrl(currentPackClient()), []);
  // 标题底图先载入（载入中显示载入画面，不先露出只有按钮的黑底舞台）；开局设置的部件与背景顺手预取
  useEnsureSceneSprites([TITLE_SHEET, SETUP_SHEET]);
  const titleStatus = useSheetStatus(TITLE_SHEET);
  const [introOn, setIntroOn] = useState(() => shouldAutoPlayIntro(intro));
  const setupBg = useClassicAssets((st) => st.images[SETUP_BG] ?? null);
  useEffect(() => {
    ensureClassicImage(SETUP_BG);
  }, []);
  useEffect(() => {
    if (!setupBg || typeof Image === 'undefined') return;
    const img = new Image();
    img.src = setupBg.url;
  }, [setupBg]);

  // 从房间被踢或房间关闭后回到首页：提示一次
  useEffect(() => {
    if (!closed) return;
    setClosedNote(t(`lobby:closed.${closed.reason}`, { code: closed.code }));
    useRoomStore.getState().clear();
  }, [closed, t]);

  const commitNick = (): boolean => {
    const v = normalizeNickname(nick);
    if (!v) {
      setError(t('lobby:home.nickEmpty'));
      return false;
    }
    setNickname(v);
    setNick(v);
    return true;
  };

  const open = (p: Panel, needNick: boolean): void => {
    setError(null);
    if (needNick && !commitNick()) return;
    setPanel((cur) => (cur === p ? 'none' : p));
  };

  const onJoin = (e: FormEvent | null, watch: boolean): void => {
    e?.preventDefault();
    setError(null);
    if (!commitNick()) return;
    const c6 = code.trim();
    if (!ROOM_CODE_RE.test(c6)) {
      setError(t('lobby:home.codeInvalid'));
      return;
    }
    navigate(`/r/${c6}${watch ? '?watch=1' : ''}`);
  };

  if (titleStatus === 'loading') return <ScreensPending testId="screen-home-pending" />;

  // 画面上方的提示条（自上而下叠放）：房间关闭、邀请链接会话的说明、登录有效期、错误
  const topNotes: { testId: string; role: 'status' | 'note' | 'alert'; text: string }[] = [];
  if (closedNote) topNotes.push({ testId: 'home-closed-note', role: 'status', text: closedNote });
  if (guestRoom) {
    topNotes.push(
      guestClosed
        ? { testId: 'home-guest-closed', role: 'note', text: t('lobby:home.guestClosed') }
        : { testId: 'home-guest-note', role: 'note', text: t('lobby:home.guestNote') },
    );
  }
  if (deadline !== null) {
    topNotes.push({
      testId: 'home-access-until',
      role: 'note',
      text: t('lobby:home.accessUntil', { time: formatAccessDeadline(deadline) }),
    });
  }
  if (error && panel !== 'join') topNotes.push({ testId: 'home-error', role: 'alert', text: error });

  if (panel === 'create') {
    return (
      <>
        <ClassicCreate onCancel={() => setPanel('none')} onCreated={(c6) => navigate(`/r/${c6}`)} />
        <ReconnectOverlay essentialOnly />
      </>
    );
  }

  const press = (id: TitleButtonId): void => {
    if (guestRoom && id !== 'option') return;
    if (id === 'start') open('create', true);
    else if (id === 'load') open('load', true);
    else open('options', false);
  };

  return (
    <ClassicScreenFrame
      testId="screen-home"
      label={t('classicScreens:title.label')}
      attrs={{ 'data-screen': 'title' }}
      after={
        <>
          <Modal
            open={panel === 'load'}
            onOpenChange={(o) => !o && setPanel('none')}
            title={t('lobby:home.loadTitle')}
            width={560}
            testId="title-load"
          >
            {panel === 'load' && (
              <Suspense fallback={<p>{t('ui:common.loading')}</p>}>
                <HomeSaves onEnter={(c6) => navigate(`/r/${c6}`)} />
              </Suspense>
            )}
          </Modal>
          <Modal
            open={panel === 'public'}
            onOpenChange={(o) => !o && setPanel('none')}
            title={t('lobby:public.title')}
            width={560}
            testId="title-public"
          >
            {panel === 'public' && <PublicRoomsOpen onJoin={(c6, w) => navigate(`/r/${c6}${w ? '?watch=1' : ''}`)} />}
          </Modal>
          <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} inGame={false} />
          <ReconnectOverlay essentialOnly />
          {introOn && intro && <IntroVideo url={intro} onDone={() => setIntroOn(false)} />}
        </>
      }
    >
      <Sprite sheet={TITLE_SHEET} frame={0} x={0} y={0} origin="topLeft" testId="title-bg" />
      <h1 className={s.srOnly}>{t('lobby:home.title')}</h1>
      {TITLE_BUTTONS.map((b) => {
        const locked = guestRoom !== null && b.id !== 'option';
        return (
          <HotButton
            key={b.id}
            rect={b.hit}
            label={t(`classicScreens:title.${b.id}`)}
            testId={BUTTON_TEST_IDS[b.id]}
            cue={b.id === 'option' ? 'open' : 'click'}
            sprite={{ sheet: TITLE_SHEET, normal: b.normal, hover: b.hover, x: b.x, y: b.y, baked: true }}
            onPress={() => press(b.id)}
            disabled={locked}
            attrs={{
              'aria-expanded': b.id === 'start' ? undefined : panel === (b.id === 'load' ? 'load' : 'options'),
              'data-locked': locked ? 'true' : undefined,
            }}
          />
        );
      })}

      <label className={s.plate} style={regionStyle(TITLE_BAND.nickname)}>
        <span className={clsx(s.plateLabel, s.outline)}>{t('classicScreens:title.nickname')}</span>
        <input
          className={s.plateInput}
          value={nick}
          maxLength={24}
          onChange={(e) => setNick(e.target.value)}
          onBlur={commitNick}
          aria-label={t('lobby:home.nickname')}
          data-testid="home-nickname"
          autoComplete="nickname"
        />
      </label>
      {guestRoom ? (
        <>
          {!guestClosed && (
            <Link
              href={`/r/${guestRoom}`}
              className={s.band}
              style={regionStyle(TITLE_GUEST.back)}
              data-testid="home-guest-room"
              onClick={() => {
                playScreenCue('click');
                commitNick();
              }}
            >
              <span className={s.bandFace}>{t('lobby:home.guestBack', { code: guestRoom })}</span>
            </Link>
          )}
          <button
            type="button"
            className={s.band}
            style={regionStyle(guestClosed ? TITLE_GUEST.passcodeWide : TITLE_GUEST.passcode)}
            onClick={() => {
              playScreenCue('open');
              requireAccess('manual');
            }}
            data-testid="home-guest-passcode"
          >
            <span className={s.bandFace}>{t('lobby:home.havePasscode')}</span>
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className={s.band}
            style={regionStyle(TITLE_BAND.join)}
            aria-expanded={panel === 'join'}
            onClick={() => {
              playScreenCue('open');
              open('join', false);
            }}
            data-testid="home-join-open"
          >
            <span className={s.bandFace}>{t('classicScreens:title.join')}</span>
          </button>
          <Link
            href="/solo"
            className={s.band}
            style={regionStyle(TITLE_BAND.solo)}
            data-testid="home-solo"
            onClick={() => {
              playScreenCue('click');
              commitNick();
            }}
          >
            <span className={s.bandFace}>{t('classicScreens:title.solo')}</span>
          </Link>
          <button
            type="button"
            className={s.band}
            style={regionStyle(TITLE_BAND.public)}
            aria-expanded={panel === 'public'}
            onClick={() => {
              playScreenCue('open');
              open('public', false);
            }}
            data-testid="title-public-open"
          >
            <span className={s.bandFace}>{t('classicScreens:title.public')}</span>
          </button>
        </>
      )}

      {panel === 'join' && !guestRoom && (
        <JoinPanel
          code={code}
          onCode={setCode}
          onJoin={onJoin}
          onClose={() => setPanel('none')}
          error={error}
          label={t('classicScreens:title.joinTitle')}
        />
      )}
      {panel === 'options' && (
        <OptionsPanel
          onSystem={() => setSettingsOpen(true)}
          onReplay={intro ? () => setIntroOn(true) : null}
          onClose={() => setPanel('none')}
        />
      )}
      {topNotes.length > 0 && (
        <div className={s.noteStack} style={{ left: 120, top: 6, width: 400 }}>
          {topNotes.map((n) => (
            <p key={n.testId} className={s.note} role={n.role} data-testid={n.testId}>
              {n.text}
            </p>
          ))}
        </div>
      )}
    </ClassicScreenFrame>
  );
}

function JoinPanel({
  code,
  onCode,
  onJoin,
  onClose,
  error,
  label,
}: {
  code: string;
  onCode(c: string): void;
  onJoin(e: FormEvent | null, watch: boolean): void;
  onClose(): void;
  error: string | null;
  label: string;
}): ReactNode {
  const t = useTx();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);
  return (
    <form
      className={s.panel}
      style={regionStyle({ ...TITLE_PANEL, h: TITLE_PANEL.h + 30 })}
      onSubmit={(e) => onJoin(e, false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      data-testid="title-join"
      aria-label={label}
    >
      <h2 className={s.outline}>{label}</h2>
      <input
        ref={input}
        className={s.panelInput}
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={6}
        placeholder={t('lobby:home.codePlaceholder')}
        aria-label={t('lobby:home.codePlaceholder')}
        value={code}
        onChange={(e) => onCode(e.target.value.replace(/\D/g, ''))}
        data-testid="home-join-code"
      />
      <div className={s.panelRow}>
        <button type="submit" className={s.panelBtn} data-tone="blue" data-testid="home-join">
          {t('lobby:home.join')}
        </button>
        <button type="button" className={s.panelBtn} onClick={(e) => onJoin(e, true)} data-testid="home-watch">
          {t('lobby:home.watch')}
        </button>
      </div>
      {error && (
        <p className={s.error} role="alert" data-testid="home-error">
          {error}
        </p>
      )}
      <ExitButton onClick={onClose} label={t('classicScreens:title.close')} testId="title-panel-close" />
    </form>
  );
}

function OptionsPanel({
  onSystem,
  onReplay,
  onClose,
}: {
  onSystem(): void;
  onReplay: (() => void) | null;
  onClose(): void;
}): ReactNode {
  const t = useTx();
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section
      className={s.panel}
      style={regionStyle(TITLE_PANEL)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      data-testid="title-options"
      aria-label={t('classicScreens:options.title')}
    >
      <h2 className={s.outline}>{t('classicScreens:options.title')}</h2>
      <div className={s.panelRow}>
        <button
          ref={first}
          type="button"
          className={s.panelBtn}
          onClick={() => {
            playScreenCue('open');
            onSystem();
          }}
          data-testid="home-settings"
        >
          {t('classicScreens:options.system')}
        </button>
        {onReplay && (
          <button
            type="button"
            className={s.panelBtn}
            onClick={() => {
              playScreenCue('click');
              onClose();
              onReplay();
            }}
            data-testid="intro-replay"
          >
            {t('classicScreens:options.replay')}
          </button>
        )}
      </div>
      <ExitButton onClick={onClose} label={t('classicScreens:options.back')} testId="title-panel-close" />
    </section>
  );
}

/** 公开房间列表：打开面板即展开并刷新一次 */
function PublicRoomsOpen({ onJoin }: { onJoin(code: string, watch: boolean): void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const d = ref.current?.querySelector('details');
    if (d && !d.open) d.open = true;
  }, []);
  return (
    <div ref={ref}>
      <PublicRooms onJoin={onJoin} />
    </div>
  );
}
