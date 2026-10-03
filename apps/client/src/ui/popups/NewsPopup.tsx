// 新闻快报（design/client.md §5.4 NewsPopup）：电视框，左侧新闻主播（NPC rig），右侧分类标签 + 打字机标题（原版原文，
// 可能两行），下方列出受影响玩家的头像与金额变化（税 / 储金红利另写原版的逐人行）。
import type { ReactNode } from 'react';
import { useTx } from '../../i18n/tx';
import { figureUrl } from './figureUrls';
import { useTypewriter } from './hooks';
import { Deltas, Person } from './parts';
import type { NewsPopupSpec } from './popupStore';
import s from './popups.module.css';

export function NewsPopup({ spec, ms = 3400 }: { spec: NewsPopupSpec; ms?: number }): ReactNode {
  const t = useTx();
  const typed = useTypewriter(spec.headline, Math.min(1400, ms * 0.4));
  const done = typed.length >= [...spec.headline].length;
  return (
    <section className={s.tv} data-testid="news-popup" data-news={spec.id} aria-label={t('events:popup.news')}>
      <div className={s.tvScreen}>
        <img className={s.anchor} src={figureUrl('npc:anchor', done ? 'idle0' : 'idle1')} alt={t('gods:npc.anchor')} />
        <div className={s.newsText}>
          <span className={s.newsTag} data-category={spec.category}>
            {t('events:popup.news')} · {spec.categoryLabel}
          </span>
          <h2 className={s.srOnly} data-testid="news-headline">
            {spec.headline}
          </h2>
          <div className={s.headline} aria-hidden="true">
            {typed}
            {!done && <span className={s.caret}>▌</span>}
          </div>
        </div>
      </div>
      {spec.affected.length > 0 && (
        <ul className={s.affected} aria-label={t('events:popup.newsAffected')} data-testid="news-affected">
          {spec.affected.map((r) => (
            <li key={r.seat} data-seat={r.seat}>
              {/* 税 / 储金红利：原版的逐人行（「<人>繳交<n>元」）代替名字与金额变化 */}
              <Person p={r.line ? { ...r, name: r.line } : r} size={24}>
                {!r.line && <Deltas deltas={r.deltas} />}
              </Person>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
