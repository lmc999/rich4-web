import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'wouter';
import { ScreenShell, shellStyles as s } from './ScreenShell';

export function NotFound(): ReactNode {
  const { t } = useTranslation();
  const [path] = useLocation();
  return (
    <ScreenShell testId="screen-not-found">
      <h1 className={s.title}>{t('notFound.title')}</h1>
      <p className={s.tagline}>{t('notFound.body', { path })}</p>
      <Link href="/" className="btn">
        {t('common.backHome')}
      </Link>
    </ScreenShell>
  );
}
