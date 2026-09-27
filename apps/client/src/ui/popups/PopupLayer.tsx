// 演出弹窗层（design/client.md §2 ui/popups）：渲染当前演出弹窗（新闻、命运、出卡、神明、乐透、魔法屋、终局）
// 与公开竞价横幅。由对局页挂载一次（GameScreen，叠在棋盘与 HUD 之上、决策层之下）。
// 最短展示时间过后出现「跳过」按钮，可以提前结束演出（只缩短演出，不影响规则与计时）。
import type { MapIndex } from '@rich4/shared/data';
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { useTx } from '../../i18n/tx';
import { AuctionBanner } from './AuctionBanner';
import { CardCastPopup } from './CardCastPopup';
import { FatePopup } from './FatePopup';
import { GameOverScreen } from './GameOverScreen';
import { GodArrivePopup } from './GodArrivePopup';
import { LotteryDrawPopup } from './LotteryDrawPopup';
import { MagicPopup } from './MagicPopup';
import { NewsPopup } from './NewsPopup';
import { type OpenPopup, usePopupStore } from './popupStore';
import s from './popups.module.css';

export function PopupBody({ p }: { p: OpenPopup }): ReactNode {
  switch (p.kind) {
    case 'news':
      return <NewsPopup spec={p} ms={p.realMs} />;
    case 'fate':
      return <FatePopup spec={p} />;
    case 'cardCast':
      return <CardCastPopup spec={p} />;
    case 'god':
      return <GodArrivePopup spec={p} ms={p.realMs} />;
    case 'lottery':
      return <LotteryDrawPopup spec={p} ms={p.realMs} />;
    case 'magic':
      return <MagicPopup spec={p} />;
    case 'gameOver':
      return <GameOverScreen spec={p} />;
  }
}

function Current({ p }: { p: OpenPopup }): ReactNode {
  const t = useTx();
  const [skippable, setSkippable] = useState(false);
  useEffect(() => {
    setSkippable(false);
    const id = setTimeout(() => setSkippable(true), p.minMs);
    return () => clearTimeout(id);
  }, [p.minMs]);
  const skip = (): void => {
    if (skippable) usePopupStore.getState().skip(p.popupId);
  };
  return (
    <div className={s.backdrop} data-testid="popup" data-kind={p.kind} data-skippable={skippable ? 'true' : 'false'}>
      <PopupBody p={p} />
      {skippable && (
        <button
          type="button"
          className={`btn btn--sm btn--cream ${s.skipHint}`}
          onClick={skip}
          data-testid="popup-skip"
        >
          {t('events:popup.skip')}
        </button>
      )}
    </div>
  );
}

export interface PopupLayerProps {
  map?: MapIndex | null;
  /**
   * screen（缺省）：叠在整个页面中央；board：放进所在容器（原版皮肤经典布局的棋盘视窗叠层）的下部并按 scale 缩放，
   * 棋盘中央的原版 FLIC 演出（神明降临、警车救护车等）不被弹窗挡住。终局画面始终居中。
   */
  placement?: 'screen' | 'board';
  /** placement 为 board 时的缩放（按视窗大小算，缺省 1） */
  scale?: number;
  /** 是否同时渲染公开竞价横幅（缺省是；经典布局把横幅放在叠层之外） */
  auction?: boolean;
}

export function PopupLayer({
  map = null,
  placement = 'screen',
  scale = 1,
  auction = true,
}: PopupLayerProps): ReactNode {
  const current = usePopupStore((st) => st.current);
  const inline = placement === 'board';
  return (
    <>
      {auction && <AuctionBanner map={map} />}
      {current && (
        <div
          className={inline ? s.layerInline : s.layer}
          data-testid="popup-layer"
          data-placement={placement}
          data-center={inline && current.kind === 'gameOver' ? 'true' : undefined}
          style={inline ? ({ '--popup-scale': String(scale) } as CSSProperties) : undefined}
        >
          <Current key={current.popupId} p={current} />
        </div>
      )}
    </>
  );
}

export default PopupLayer;
