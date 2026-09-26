import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'wouter';
import { ScreenShell, shellStyles as s } from './ScreenShell';

/** 首页占位：大厅（建房、加入、单机、读档）在 M3 后续实现 */
export function HomeScreen(): ReactNode {
  const { t } = useTranslation();
  return (
    <ScreenShell testId="screen-home">
      <div className={s.logo} aria-hidden="true">
        4
      </div>
      <h1 className={s.title}>{t('home.title')}</h1>
      <p className={s.tagline}>{t('app.tagline')}</p>
      <div className={s.actions}>
        <button type="button" className="btn" disabled>
          {t('home.createRoom')}
        </button>
        <button type="button" className="btn btn--cream" disabled>
          {t('home.joinRoom')}
        </button>
        <Link href="/solo" className="btn btn--green">
          {t('home.solo')}
        </Link>
      </div>
      <p className={s.note}>{t('home.wip')}</p>
      <nav className={s.devLinks} aria-label="dev">
        <Link href="/dev/map" className="btn btn--sm btn--blue">
          {t('nav.devMap')}
        </Link>
        <Link href="/dev/gallery" className="btn btn--sm btn--blue">
          {t('nav.devGallery')}
        </Link>
      </nav>
    </ScreenShell>
  );
}
