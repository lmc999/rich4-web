// /solo 的原版画面：单机建房（私密、不限时、补 3 个电脑、开局，逻辑同 ui/screens/SoloScreen）期间显示原版 Loading；
// 失败时在 Loading 之上给出错误与「回到首页」（testid 与程序化相同：solo-error）。
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useClient } from '../../../app/services';
import { useTx } from '../../../i18n/tx';
import { ReconnectOverlay } from '../../system/ReconnectOverlay';
import { LoadingScreen } from './ClassicLoading';
import { ensureScreensI18n } from './i18n';
import s from './screens.module.css';

export default function ClassicSolo(): ReactNode {
  ensureScreensI18n();
  const t = useTx();
  const client = useClient();
  const [, navigate] = useLocation();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // StrictMode 下 effect 会跑两次：只建一次房
    if (started.current) return;
    started.current = true;
    void client.startSolo().then((r) => {
      if (r.ok) navigate(`/r/${r.data.code}${location.search}`, { replace: true });
      else setError(client.errorText(r.error));
    });
  }, [client, navigate]);

  return (
    <main data-testid="screen-solo" data-layout="classic">
      <LoadingScreen testId="classic-solo-loading" />
      {error && (
        <div className={s.pending} style={{ zIndex: 210, background: 'rgb(0 0 0 / 0.7)' }}>
          <div className={s.panel} style={{ position: 'relative', maxWidth: 420 }}>
            <p className={s.error} role="alert" data-testid="solo-error">
              {error}
            </p>
            <Link href="/" className={s.panelBtn}>
              {t('common.backHome')}
            </Link>
          </div>
        </div>
      )}
      <ReconnectOverlay essentialOnly />
    </main>
  );
}
