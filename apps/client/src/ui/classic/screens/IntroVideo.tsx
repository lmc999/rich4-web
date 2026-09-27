// 片头（original-skin.md「默认项」：Steam 版 Media/Start.avi 转码为素材包 video 条目 video.start）：
// - 首次进入原版标题画面时播放一次（本浏览器记在 localStorage），?anim=instant（E2E、只提交不播放）时不播；
// - 可跳过（按钮、Esc / Enter / 空格）；播完、出错、迟迟不开始（STALL_MS）都直接进入标题画面；
// - 浏览器不许有声自动播放时改为静音播放并给出「打开声音」钮；
// - 素材包没有 video.start（或不可用）时跳过；设置里可重播（标题画面「设置」面板）；
// - 播放期间 uiStore.introPlaying 为 true：音频导演层暂不放标题曲。
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { appFlags } from '../../../app/flags';
import { useTx } from '../../../i18n/tx';
import type { PackClient } from '../../../skin/pack/PackClient';
import { useUiStore } from '../../../store/uiStore';
import { INTRO_VIDEO } from './layout';
import s from './screens.module.css';

export const INTRO_SEEN_KEY = 'rich4.introSeen';
/** 这么久还没开始播放（加载卡住）就跳过 */
export const STALL_MS = 10_000;

/** 片头视频的地址（按浏览器能力选 mp4 / webm）；条目不可用时 null */
export function introUrl(
  client: Pick<PackClient, 'usableEntry' | 'fileUrl'> | null,
  canPlay: (mime: string) => string = defaultCanPlay,
): string | null {
  const e = client?.usableEntry(INTRO_VIDEO);
  if (!client || e?.type !== 'video') return null;
  const mp4 = e.files.mp4 && canPlay('video/mp4') !== '' ? e.files.mp4 : undefined;
  const webm = e.files.webm && canPlay('video/webm') !== '' ? e.files.webm : undefined;
  const file = mp4 ?? webm ?? e.files.mp4 ?? e.files.webm;
  return file ? client.fileUrl(file) : null;
}

function defaultCanPlay(mime: string): string {
  try {
    return typeof document === 'undefined' ? 'maybe' : document.createElement('video').canPlayType(mime);
  } catch {
    return '';
  }
}

export function introSeen(): boolean {
  try {
    return globalThis.localStorage?.getItem(INTRO_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markIntroSeen(): void {
  try {
    globalThis.localStorage?.setItem(INTRO_SEEN_KEY, '1');
  } catch {
    // 隐私模式：下次还会播
  }
}

/** 进入标题画面时是否自动播放片头 */
export function shouldAutoPlayIntro(url: string | null): boolean {
  return url !== null && !appFlags().animInstant && !introSeen();
}

export interface IntroVideoProps {
  url: string;
  onDone(): void;
}

export function IntroVideo({ url, onDone }: IntroVideoProps): ReactNode {
  const t = useTx();
  const ref = useRef<HTMLVideoElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const [muted, setMuted] = useState(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const finished = useRef(false);
  const finish = (): void => {
    if (finished.current) return;
    finished.current = true;
    markIntroSeen();
    doneRef.current();
  };

  // 片头期间音频导演层不放标题曲（app/audioWiring 读 uiStore.introPlaying）
  useEffect(() => {
    useUiStore.getState().setIntroPlaying(true);
    return () => useUiStore.getState().setIntroPlaying(false);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时开始播放
  useEffect(() => {
    const v = ref.current;
    skipRef.current?.focus({ preventScroll: true });
    if (!v) return;
    let started = false;
    const onPlaying = (): void => {
      started = true;
    };
    v.addEventListener('playing', onPlaying);
    const stall = setTimeout(() => {
      if (!started) finish();
    }, STALL_MS);
    const p = v.play();
    if (p && typeof p.catch === 'function') {
      p.catch((e: unknown) => {
        // 不许有声自动播放：静音再试；仍不行就交给「跳过」或卡住超时
        if (e instanceof DOMException && e.name === 'NotAllowedError') {
          v.muted = true;
          setMuted(true);
          void v.play().catch(() => undefined);
        }
      });
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        finish();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(stall);
      v.removeEventListener('playing', onPlaying);
      window.removeEventListener('keydown', onKey);
      v.pause();
    };
  }, []);

  return (
    <div className={s.overlay} role="dialog" aria-label={t('classicScreens:intro.label')} data-testid="intro">
      {/* biome-ignore lint/a11y/useMediaCaption: 原版片头没有对白字幕 */}
      <video
        ref={ref}
        src={url}
        playsInline
        preload="auto"
        onEnded={finish}
        onError={finish}
        data-testid="intro-video"
      />
      <div className={s.introBtns}>
        {muted && (
          <button
            type="button"
            className={s.introBtn}
            onClick={() => {
              const v = ref.current;
              if (v) {
                v.muted = false;
                void v.play().catch(() => undefined);
              }
              setMuted(false);
            }}
            data-testid="intro-unmute"
          >
            {t('classicScreens:intro.unmute')}
          </button>
        )}
        <button type="button" className={s.introBtn} ref={skipRef} onClick={finish} data-testid="intro-skip">
          {t('classicScreens:intro.skip')}
        </button>
      </div>
    </div>
  );
}
