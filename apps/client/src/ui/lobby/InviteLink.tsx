// 邀请链接（design/client.md §5.5、net.md §3.1）：/r/<code>（观战加 ?watch=1），复制按钮 + 二维码。
// 链接以当前页面的 origin 拼出（开发期 Vite 端口与服务器 PUBLIC_URL 不同）。
import QRCode from 'qrcode';
import { type ReactNode, useEffect, useState } from 'react';
import { useTx } from '../../i18n/tx';
import { useUiStore } from '../../store/uiStore';
import c from '../common/common.module.css';
import l from './lobby.module.css';

export function inviteUrl(
  code: string,
  watch = false,
  origin = typeof location === 'undefined' ? '' : location.origin,
): string {
  return `${origin}/r/${code}${watch ? '?watch=1' : ''}`;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function InviteLink({ code, allowWatch }: { code: string; allowWatch: boolean }): ReactNode {
  const t = useTx();
  const url = inviteUrl(code);
  const watchUrl = inviteUrl(code, true);
  const [qr, setQr] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);

  useEffect(() => {
    if (!showQr) return;
    let stale = false;
    QRCode.toString(url, { type: 'svg', margin: 1, width: 168, errorCorrectionLevel: 'M' }).then(
      (svg) => !stale && setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`),
      () => !stale && setQr(null),
    );
    return () => {
      stale = true;
    };
  }, [showQr, url]);

  const onCopy = async (u: string): Promise<void> => {
    const ok = await copy(u);
    useUiStore.getState().toast(ok ? t('lobby:invite.copied') : t('lobby:invite.copyFailed'), ok ? 'success' : 'warn');
  };

  return (
    <div className={l.invite} data-testid="invite">
      <div className={c.row}>
        <span className={c.muted}>{t('lobby:invite.code')}</span>
        <strong className={`num ${l.code}`} data-testid="room-code">
          {code}
        </strong>
      </div>
      <div className={c.row}>
        <input
          className="input"
          readOnly
          value={url}
          aria-label={t('lobby:invite.link')}
          data-testid="invite-url"
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          type="button"
          className="btn btn--sm btn--blue"
          onClick={() => void onCopy(url)}
          data-testid="invite-copy"
        >
          {t('lobby:invite.copy')}
        </button>
        {allowWatch && (
          <button
            type="button"
            className="btn btn--sm btn--cream"
            onClick={() => void onCopy(watchUrl)}
            data-testid="invite-copy-watch"
          >
            {t('lobby:invite.copyWatch')}
          </button>
        )}
        <button
          type="button"
          className="btn btn--sm btn--cream"
          onClick={() => setShowQr((v) => !v)}
          aria-expanded={showQr}
          data-testid="invite-qr-toggle"
        >
          {t('lobby:invite.qr')}
        </button>
      </div>
      {showQr && qr && (
        <img className={l.qr} src={qr} width={168} height={168} alt={t('lobby:invite.qrAlt')} data-testid="invite-qr" />
      )}
    </div>
  );
}
