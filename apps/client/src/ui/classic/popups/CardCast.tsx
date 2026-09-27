// 原版出卡弹窗（original-skin.md §4.2 通用；ui.md §2.2 卡片插画 Data#530–559 = card.<k>）：卡片插画 165×256 摆在棋盘视窗
// 上部居中、翻面入场，下方宝石消息框写标题（使用卡片 / 被动卡生效 / 没有效果）、出卡人与目标、卡片说明；没有效果时插画置灰。
// 与程序化 CardCastPopup 同一份 spec；data-testid 同名（card-cast-popup[data-card][data-variant]）。
import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { useTx } from '../../../i18n/tx';
import type { CardCastPopupSpec } from '../../popups/popupStore';
import { TEXT } from '../common/textStyles';
import { CARD_ART, MessageBox, useSceneImage } from '../dialogs/parts';
import { REGION } from '../layout';
import pp from './popups.module.css';

/** 卡片插画的左上角（棋盘视窗上部居中） */
export const CAST_CARD_AT = { x: REGION.board.x + (REGION.board.w - CARD_ART.w) / 2, y: REGION.board.y + 24 } as const;

export function CardCast({ spec }: { spec: CardCastPopupSpec }): ReactNode {
  const t = useTx();
  const reduce = useReducedMotion();
  const img = useSceneImage(`card.${spec.card}`);
  return (
    <section
      className={pp.layer}
      style={{ left: 0, top: 0, width: 640, height: 480 }}
      data-testid="card-cast-popup"
      data-card={spec.card}
      data-variant={spec.variant}
      aria-label={spec.title}
    >
      <motion.span
        className={pp.art}
        style={{
          left: CAST_CARD_AT.x,
          top: CAST_CARD_AT.y,
          width: CARD_ART.w,
          height: CARD_ART.h,
          backgroundImage: img ? `url("${img.url}")` : undefined,
          filter: spec.variant === 'fizzle' ? 'grayscale(1) brightness(0.8)' : undefined,
        }}
        initial={reduce ? false : { scaleX: 0 }}
        animate={{ scaleX: 1 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        data-testid="card-cast-art"
        aria-hidden="true"
      />
      <MessageBox
        x={REGION.board.x + REGION.board.w / 2}
        y={CAST_CARD_AT.y + CARD_ART.h + 6 + 81}
        lines={4}
        testId="card-cast-box"
      >
        <p style={TEXT.title}>
          {spec.title} · {spec.cardName}
        </p>
        <p>
          {spec.player.name}
          {spec.targetText ? ` → ${t('events:popup.target', { target: spec.targetText })}` : ''}
        </p>
        {spec.desc && <p>{spec.desc}</p>}
      </MessageBox>
    </section>
  );
}
