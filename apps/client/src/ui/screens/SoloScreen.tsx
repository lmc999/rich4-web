import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'wouter';
import { ScreenShell, shellStyles as s } from './ScreenShell';

/** 单机页占位：v1 自动建私密房间、补 3 个电脑后开局（architecture conflicts_resolved「单机模式」） */
export function SoloScreen(): ReactNode {
  const { t } = useTranslation();
  return (
    <ScreenShell testId="screen-solo">
      <h1 className={s.title}>{t('solo.title')}</h1>
      <p className={s.note}>{t('solo.wip')}</p>
      <div className={s.actions}>
        <Link href="/" className="btn btn--cream">
          {t('common.backHome')}
        </Link>
      </div>
    </ScreenShell>
  );
}
