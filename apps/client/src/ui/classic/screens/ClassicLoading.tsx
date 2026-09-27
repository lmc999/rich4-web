// 原版 Loading 画面（ui.md §2.3：Data#560 640×480 整图，逻辑键 title.loading）：
// - 单机建房、进入对局（对局页懒加载、地图与棋盘创建）期间全屏显示，按容器等比缩放（object-fit: contain）；
// - 不接收指针（叠在对局页上时不挡操作，E2E 与读屏照常可用），棋盘创建完成（skinStore.boardInUse）或最长
//   LOADING_MAX_MS 之后淡出；
// - 条目不可用时只显示黑底文字。
import { type ReactNode, useEffect, useState } from 'react';
import { useTx } from '../../../i18n/tx';
import { useSkinStore } from '../../../skin/skinStore';
import { ensureClassicImage, useClassicAssets } from '../assets';
import { ensureScreensI18n } from './i18n';
import { LOADING_IMAGE } from './layout';
import s from './screens.module.css';

export const LOADING_MAX_MS = 12_000;
const FADE_MS = 300;

export function LoadingScreen({
  done = false,
  testId = 'classic-loading',
}: {
  done?: boolean;
  testId?: string;
}): ReactNode {
  ensureScreensI18n();
  const t = useTx();
  const packId = useClassicAssets((st) => st.packId);
  const img = useClassicAssets((st) => st.images[LOADING_IMAGE] ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 换素材包时重新取
  useEffect(() => {
    ensureClassicImage(LOADING_IMAGE);
  }, [packId]);
  return (
    <div
      className={`${s.overlay} ${s.loading}`}
      role="status"
      aria-live="polite"
      data-testid={testId}
      data-state={done ? 'done' : 'loading'}
      data-art={img ? 'true' : 'false'}
    >
      {img && <img src={img.url} alt="" aria-hidden="true" draggable={false} />}
      <span className={`${s.loadingText} ${s.outline}`}>{t('classicScreens:loading.label')}</span>
    </div>
  );
}

/** 对局页之上的 Loading：棋盘建好（或超时）后淡出并卸载 */
export function GameLoading(): ReactNode {
  const board = useSkinStore((st) => st.boardInUse);
  const [expired, setExpired] = useState(false);
  const [gone, setGone] = useState(false);
  const done = board !== null || expired;

  useEffect(() => {
    const id = setTimeout(() => setExpired(true), LOADING_MAX_MS);
    return () => clearTimeout(id);
  }, []);
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => setGone(true), FADE_MS);
    return () => clearTimeout(id);
  }, [done]);

  if (gone) return null;
  return <LoadingScreen done={done} />;
}
