// 出卡（design/client.md §4.5 cardUsed，CardCastPopup 1.2s）：卡片放大翻面，卡框按类别配色，
// 下方写出卡人与目标；被动卡生效、没有效果也用它（variant）。得卡（gain）的弹窗只在原版皮肤打开，原版画面来不及就绪时
// 才落到这里；私密手牌下别人的得卡没有卡号，卡面只画问号。
import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import { useTx } from '../../i18n/tx';
import { CARD_ICON, CATEGORY_COLOR, cardCategory } from '../components/cardVisuals';
import { Person } from './parts';
import type { CardCastPopupSpec } from './popupStore';
import s from './popups.module.css';

export function CardCastPopup({ spec }: { spec: CardCastPopupSpec }): ReactNode {
  const t = useTx();
  const frame = (spec.card === null ? {} : { '--frame': CATEGORY_COLOR[cardCategory(spec.card)] }) as CSSProperties;
  return (
    <section
      className={clsx(s.flipScene, spec.variant === 'fizzle' && s.fizzle)}
      data-testid="card-cast-popup"
      data-card={spec.card ?? undefined}
      data-variant={spec.variant}
      aria-label={spec.title}
    >
      <div className={s.caption}>{spec.title}</div>
      <div className={s.flip}>
        <div className={s.flipBack} aria-hidden="true">
          🃏
        </div>
        <div className={s.flipFace}>
          <div className={s.cardFace} style={frame}>
            <span className={s.cardIcon} aria-hidden="true">
              {spec.card === null ? '？' : CARD_ICON[spec.card]}
            </span>
            <span className={s.cardName}>{spec.cardName}</span>
            {spec.desc && <p className={s.cardDesc}>{spec.desc}</p>}
          </div>
        </div>
      </div>
      <div className={s.caption}>
        <Person p={spec.player} />
        {spec.targetText && <span>{t('events:popup.target', { target: spec.targetText })}</span>}
      </div>
    </section>
  );
}
