import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'wouter';
import { ScreenShell, shellStyles as s } from './ScreenShell';

/** 房间页占位：/r/:code（邀请链接），连接与选座在 M3 后续实现 */
export function RoomScreen({ code }: { code: string }): ReactNode {
  const { t } = useTranslation();
  const safeCode = code.toUpperCase().slice(0, 12);
  return (
    <ScreenShell testId="screen-room">
      <h1 className={s.title}>{t('room.title', { code: safeCode })}</h1>
      <p className={s.note}>{t('room.wip')}</p>
      <div className={s.actions}>
        <Link href="/" className="btn btn--cream">
          {t('common.backHome')}
        </Link>
      </div>
    </ScreenShell>
  );
}
