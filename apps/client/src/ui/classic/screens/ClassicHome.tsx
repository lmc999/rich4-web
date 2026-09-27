// 原版标题画面（original-skin.md §4.3；ui.md §2.3：Data#1 图0 底图，图1–6 START / LOAD / OPTION 常态 / 悬停，图7–8 EXIT）。
// 按钮映射：START → 开局设置（建房）；LOAD → 读取存档；OPTION → 设置（系统设置、重播片头）；底部按钮带：昵称、加入房间号
// （可观战）、单机对战、公开房间。标题音乐由音频接线按「没有房间 = 标题」播放（app/audioWiring）。
// 首次进入播放片头（素材包 video.start，可跳过）。程序化首页（ui/screens/HomeScreen）的逻辑与 testid 照搬：
// home-nickname、home-create、home-join-open / home-join-code / home-join / home-watch、home-load-open（home-saves）、
// home-solo、home-settings、home-error、home-closed-note，E2E 在两种皮肤下用同一组选择器。
import { ROOM_CODE_RE } from '@rich4/shared/net';
import clsx from 'clsx';
import { type FormEvent, lazy, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useTx } from '../../../i18n/tx';
import { currentPackClient } from '../../../skin/skinStore';
import { useRoomStore } from '../../../store/roomStore';
import { normalizeNickname, useSettingsStore } from '../../../store/settingsStore';
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

  if (panel === 'create') {
    return (
      <>
        <ClassicCreate onCancel={() => setPanel('none')} onCreated={(c6) => navigate(`/r/${c6}`)} />
        <ReconnectOverlay essentialOnly />
      </>
    );
  }

  const press = (id: TitleButtonId): void => {
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
      {TITLE_BUTTONS.map((b) => (
        <HotButton
          key={b.id}
          rect={b.hit}
          label={t(`classicScreens:title.${b.id}`)}
          testId={BUTTON_TEST_IDS[b.id]}
          cue={b.id === 'option' ? 'open' : 'click'}
          sprite={{ sheet: TITLE_SHEET, normal: b.normal, hover: b.hover, x: b.x, y: b.y, baked: true }}
          onPress={() => press(b.id)}
          attrs={{
            'aria-expanded': b.id === 'start' ? undefined : panel === (b.id === 'load' ? 'load' : 'options'),
          }}
        />
      ))}

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

      {panel === 'join' && (
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
      {closedNote && (
        <p
          className={s.note}
          style={regionStyle({ x: 120, y: 6, w: 400, h: 44 })}
          role="status"
          data-testid="home-closed-note"
        >
          {closedNote}
        </p>
      )}
      {error && panel !== 'join' && (
        <p
          className={s.note}
          style={regionStyle({ x: 120, y: closedNote ? 54 : 6, w: 400, h: 40 })}
          role="alert"
          data-testid="home-error"
        >
          {error}
        </p>
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
