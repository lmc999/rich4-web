// 命运（design/client.md §4.5 fateDrawn）：命运卡从背面翻到正面，显示标题、内容、金额与神明加持结果。
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useTx } from '../../i18n/tx';
import { Person } from './parts';
import type { FatePopupSpec } from './popupStore';
import s from './popups.module.css';

export function FatePopup({ spec }: { spec: FatePopupSpec }): ReactNode {
  const t = useTx();
  return (
    <section
      className={clsx(s.flipScene, spec.tone === 'good' && s.fateGood, spec.tone === 'bad' && s.fateBad)}
      data-testid="fate-popup"
      data-fate={spec.id}
      data-tone={spec.tone}
      aria-label={t('events:popup.fate')}
    >
      <div className={s.flip}>
        <div className={s.flipBack} aria-hidden="true">
          ?
        </div>
        <div className={s.flipFace}>
          <span className={s.newsTag}>{t('events:popup.fate')}</span>
          <h2 className={s.title}>{spec.title}</h2>
          <p className={s.fateText} data-testid="fate-text">
            {spec.text}
          </p>
          {spec.amountText && (
            <span
              className={clsx(
                s.amount,
                (spec.amountTone ?? (spec.amountText.startsWith('-') ? 'loss' : 'gain')) === 'loss' && s.loss,
                (spec.amountTone ?? (spec.amountText.startsWith('-') ? 'loss' : 'gain')) === 'gain' && s.gain,
              )}
              data-testid="fate-amount"
              data-tone={spec.amountTone ?? null}
            >
              {spec.amountText}
            </span>
          )}
          {spec.blessingText && (
            <span className={s.blessing} data-testid="fate-blessing">
              {spec.blessingText}
            </span>
          )}
        </div>
      </div>
      <div className={s.caption}>
        <Person p={spec.player} />
      </div>
    </section>
  );
}
