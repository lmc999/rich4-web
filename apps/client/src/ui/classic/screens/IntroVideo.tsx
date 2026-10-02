// 片头（original-skin.md「默认项」：Steam 版 Media/Start.avi 转码为素材包 video 条目 video.start）：
// - 首次进入原版标题画面时播放一次（本浏览器记在 localStorage），?anim=instant（E2E、只提交不播放）时不播；
// - 可跳过（按钮、Esc / Enter / 空格）；播完、出错、迟迟不开始（STALL_MS）都直接进入标题画面；
// - 浏览器不许有声自动播放时改为静音播放并给出「打开声音」钮；
// - 素材包没有 video.start（或不可用）时跳过；设置里可重播（标题画面「设置」面板）；
// - 播放期间 uiStore.introPlaying 为 true：音频导演层暂不放标题曲。
// 全屏视频层（VideoOverlay）与取视频地址（videoUrl）也给开局飞行动画（FlyVideo）共用。
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

/** 素材包 video 条目的地址（按浏览器能力选 mp4 / webm）；条目不可用时 null */
export function videoUrl(
  client: Pick<PackClient, 'usableEntry' | 'fileUrl'> | null,
  key: string,
  canPlay: (mime: string) => string = defaultCanPlay,
): string | null {
  const e = client?.usableEntry(key);
  if (!client || e?.type !== 'video') return null;
  const mp4 = e.files.mp4 && canPlay('video/mp4') !== '' ? e.files.mp4 : undefined;
  const webm = e.files.webm && canPlay('video/webm') !== '' ? e.files.webm : undefined;
  const file = mp4 ?? webm ?? e.files.mp4 ?? e.files.webm;
  return file ? client.fileUrl(file) : null;
}

/** 片头视频的地址；条目不可用时 null */
export function introUrl(
  client: Pick<PackClient, 'usableEntry' | 'fileUrl'> | null,
  canPlay: (mime: string) => string = defaultCanPlay,
): string | null {
  return videoUrl(client, INTRO_VIDEO, canPlay);
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

export interface VideoOverlayProps {
  url: string;
  onDone(): void;
  /** 根的 testid；视频、跳过、打开声音依次为 <testId>-video / -skip / -unmute */
  testId: string;
  label: string;
  skipLabel: string;
  unmuteLabel: string;
  /** 跳过钮醒目（对局里轮到本人决策、服务器计时照走时） */
  urgent?: boolean;
  /** 这么久还没开始播放就结束 */
  stallMs?: number;
  /** 最长播放时间（毫秒，缺省不限）：卡在中途也能结束 */
  maxMs?: number;
  /**
   * 在捕获阶段接管 Esc / Enter / 空格（阻止继续传播）：对局页有全局快捷键（空格 = 掷骰），视频层之下的画面不能收到
   */
  captureKeys?: boolean;
  /** 附加在根上的类（层级等） */
  className?: string;
}

/** 全屏视频层：播放、跳过（按钮、Esc / Enter / 空格）、静音回退、卡住超时；期间 uiStore.introPlaying 为 true */
export function VideoOverlay({
  url,
  onDone,
  testId,
  label,
  skipLabel,
  unmuteLabel,
  urgent = false,
  stallMs = STALL_MS,
  maxMs,
  captureKeys = false,
  className,
}: VideoOverlayProps): ReactNode {
  const ref = useRef<HTMLVideoElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const [muted, setMuted] = useState(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const finished = useRef(false);
  const finish = (): void => {
    if (finished.current) return;
    finished.current = true;
    doneRef.current();
  };

  // 播放期间音频导演层不放场景曲（app/audioWiring 读 uiStore.introPlaying）
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
    }, stallMs);
    const cap = maxMs === undefined ? null : setTimeout(finish, maxMs);
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
        if (captureKeys) e.stopPropagation();
        finish();
      }
    };
    window.addEventListener('keydown', onKey, captureKeys);
    return () => {
      clearTimeout(stall);
      if (cap !== null) clearTimeout(cap);
      v.removeEventListener('playing', onPlaying);
      window.removeEventListener('keydown', onKey, captureKeys);
      v.pause();
    };
  }, []);

  return (
    <div
      className={className ? `${s.overlay} ${className}` : s.overlay}
      role="dialog"
      aria-label={label}
      data-testid={testId}
    >
      {/* biome-ignore lint/a11y/useMediaCaption: 原版片头与飞行动画没有对白字幕 */}
      <video
        ref={ref}
        src={url}
        playsInline
        preload="auto"
        onEnded={finish}
        onError={finish}
        data-testid={`${testId}-video`}
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
            data-testid={`${testId}-unmute`}
          >
            {unmuteLabel}
          </button>
        )}
        <button
          type="button"
          className={s.introBtn}
          ref={skipRef}
          onClick={finish}
          data-testid={`${testId}-skip`}
          data-urgent={urgent ? 'true' : 'false'}
        >
          {skipLabel}
        </button>
      </div>
    </div>
  );
}

export interface IntroVideoProps {
  url: string;
  onDone(): void;
}

export function IntroVideo({ url, onDone }: IntroVideoProps): ReactNode {
  const t = useTx();
  return (
    <VideoOverlay
      url={url}
      onDone={() => {
        markIntroSeen();
        onDone();
      }}
      testId="intro"
      label={t('classicScreens:intro.label')}
      skipLabel={t('classicScreens:intro.skip')}
      unmuteLabel={t('classicScreens:intro.unmute')}
    />
  );
}
