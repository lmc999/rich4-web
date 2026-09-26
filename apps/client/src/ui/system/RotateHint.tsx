// 竖屏旋转遮罩（architecture conflicts_resolved「手机竖屏」）：对局页竖屏时阻断式提示横屏，纯 CSS 媒体查询控制显示。
import type { ReactNode } from 'react';
import { useTx } from '../../i18n/tx';
import sy from './system.module.css';

export function RotateHint(): ReactNode {
  const t = useTx();
  return (
    <div
      className={sy.rotate}
      role="alertdialog"
      aria-modal="true"
      aria-label={t('hud:rotate.title')}
      data-testid="rotate-hint"
    >
      <div className={sy.rotateIcon} aria-hidden="true">
        📱
      </div>
      <h2>{t('hud:rotate.title')}</h2>
      <p>{t('hud:rotate.body')}</p>
    </div>
  );
}
