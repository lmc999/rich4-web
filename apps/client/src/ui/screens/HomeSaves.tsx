// 首页「读取存档」面板（按需加载，不进首屏包）：列出本人拥有的服务器存档、导入 .r4save；
// 读取时由 SaveLoadMenu（mode='home'）新建私密房间并 room:loadSave，成功后回调房间号。
// 首页没有 HUD，这里自带 toast 容器显示读档失败等提示。
import type { ReactNode } from 'react';
import { useTx } from '../../i18n/tx';
import c from '../common/common.module.css';
import { Toasts } from '../hud/Overlays';
import { SaveLoadMenu } from '../system/SaveLoadMenu';
import { shellStyles as s } from './ScreenShell';

export default function HomeSaves({ onEnter }: { onEnter(code: string): void }): ReactNode {
  const t = useTx();
  return (
    <section className={`panel ${s.homeSaves}`} data-testid="home-saves" aria-label={t('lobby:home.loadTitle')}>
      <h2>{t('lobby:home.loadTitle')}</h2>
      <p className={c.muted}>{t('lobby:home.loadHint')}</p>
      <SaveLoadMenu
        mode="home"
        isHost
        onLoaded={(_saveId, code) => {
          if (code) onEnter(code);
        }}
      />
      <Toasts />
    </section>
  );
}
