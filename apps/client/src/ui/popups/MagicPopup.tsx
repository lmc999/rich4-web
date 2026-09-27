// 魔法屋结果条（design/client.md §4.5 magicHouseCast）：女巫立绘 + 条件 / 效果说明 + 名单上的玩家。
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useTx } from '../../i18n/tx';
import { figureUrl } from './figureUrls';
import { Person } from './parts';
import type { MagicPopupSpec } from './popupStore';
import s from './popups.module.css';

export function MagicPopup({ spec }: { spec: MagicPopupSpec }): ReactNode {
  const t = useTx();
  return (
    <section className={clsx(s.card, s.magic)} data-testid="magic-popup" aria-label={spec.title}>
      <img className={s.witch} src={figureUrl('npc:witch', 'cast')} alt={t('gods:npc.witch')} />
      <div>
        <h2 className={s.title}>🔮 {spec.title}</h2>
        <p className={s.line}>{spec.line}</p>
        <div className={s.targets}>
          {spec.targets.length === 0 ? (
            <small>{t('events:popup.magicNobody')}</small>
          ) : (
            spec.targets.map((p) => <Person key={p.seat} p={p} size={24} />)
          )}
        </div>
      </div>
    </section>
  );
}
