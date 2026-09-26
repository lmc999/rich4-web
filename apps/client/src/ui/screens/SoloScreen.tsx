// /solo：单机（architecture §5.8）——自动建私密房（不限时、不许观战）、补 3 个电脑、开局，然后进入 /r/<code>。
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import c from '../common/common.module.css';
import { ReconnectOverlay } from '../system/ReconnectOverlay';
import { ScreenShell, shellStyles as s } from './ScreenShell';

export default function SoloScreen(): ReactNode {
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
    <ScreenShell testId="screen-solo">
      <h1 className={s.title}>{t('lobby:solo.title')}</h1>
      {error ? (
        <p className={c.error} role="alert" data-testid="solo-error">
          {error}
        </p>
      ) : (
        <p className={s.tagline} role="status">
          {t('lobby:solo.starting')}
        </p>
      )}
      <div className={s.actions}>
        <Link href="/" className="btn btn--cream">
          {t('common.backHome')}
        </Link>
      </div>
      <ReconnectOverlay essentialOnly />
    </ScreenShell>
  );
}
