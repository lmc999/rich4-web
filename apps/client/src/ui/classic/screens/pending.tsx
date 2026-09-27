// 画面判定中 / 懒加载中 / 素材载入中的载入画面（首屏也会用到：只依赖 react-i18next 与本目录的样式）。
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import s from './screens.module.css';

export function ScreensPending({ testId }: { testId: string }): ReactNode {
  const { t } = useTranslation();
  return (
    <div className={s.pending} role="status" data-testid={testId} data-pending="true">
      {t('common.loading')}
    </div>
  );
}
