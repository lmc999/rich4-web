// 邀请链接（design/client.md §5.5、net.md §3.1）：/r/<code>（观战加 ?watch=1），复制按钮 + 二维码。
// 链接以当前页面的 origin 拼出（开发期 Vite 端口与服务器 PUBLIC_URL 不同）。
// 访问门禁开启、且本会话可以生成授权时（原版皮肤 U4：口令或邀请码进入的玩家），邀请框、复制与二维码改用带授权片段的链接
// `/r/<code>#g=<token>`（POST /api/access/grant；24 小时、限 8 次；片段不发给服务器）。授权链接就绪时邀请框带
// data-grant="true"（E2E 夹具据此读取）。
// 授权的复用：邀请框自动填入的授权按房间缓存（离到期 10 分钟以上就复用）；**复制与打开二维码时要新鲜的授权**
// （30 秒内生成的才复用，否则重新生成——服务器端很便宜），用满 8 次或被吊销（epoch+1）的旧授权不会再被复制出去；
// 门禁状态变化（通过与否、来源、模式）时清空缓存。
import { ACCESS_GRANT_FRAGMENT_KEY } from '@rich4/shared/net';
import QRCode from 'qrcode';
import { type ReactNode, useEffect, useState } from 'react';
import { useTx } from '../../i18n/tx';
import { useUiStore } from '../../store/uiStore';
import { createAccessGrant } from '../access/accessApi';
import { useAccessStore } from '../access/accessStore';
import c from '../common/common.module.css';
import l from './lobby.module.css';

export function inviteUrl(
  code: string,
  watch = false,
  origin = typeof location === 'undefined' ? '' : location.origin,
): string {
  return `${origin}/r/${code}${watch ? '?watch=1' : ''}`;
}

/** 带授权片段的邀请链接 */
export function grantInviteUrl(
  code: string,
  token: string,
  watch = false,
  origin = typeof location === 'undefined' ? '' : location.origin,
): string {
  return `${inviteUrl(code, watch, origin)}#${ACCESS_GRANT_FRAGMENT_KEY}=${token}`;
}

/** 授权离到期不足这个时长时重新生成 */
const GRANT_REUSE_MARGIN_MS = 10 * 60_000;
/** 复制 / 二维码只复用这么久之内生成的授权（连续点「复制」「复制观战」不重复生成） */
export const GRANT_FRESH_MS = 30_000;

interface Grant {
  room: string;
  token: string;
  uses: number;
  expiresAt: number;
  /** 本页拿到它的时间 */
  createdAt: number;
}

/** 本页生成过的授权（按房间号；重新挂载邀请框时复用）与进行中的请求（并发调用合并为一次） */
const grantCache = new Map<string, Grant>();
const grantInflight = new Map<string, Promise<Grant | null>>();

function reusable(g: Grant | null | undefined, room: string): g is Grant {
  return !!g && g.room === room && g.expiresAt - Date.now() > GRANT_REUSE_MARGIN_MS;
}

function freshEnough(g: Grant | null | undefined, room: string): g is Grant {
  return reusable(g, room) && Date.now() - g.createdAt < GRANT_FRESH_MS;
}

/** 清空本页缓存的授权（门禁状态变化时；测试） */
export function clearGrantCache(): void {
  grantCache.clear();
}

// 门禁状态变化（登出 / 重新登录、吊销后换了 cookie、来源或模式改变）：旧授权可能已随 epoch 失效，不再复用
useAccessStore.subscribe((s, prev) => {
  const a = s.status;
  const b = prev.status;
  if (a?.granted !== b?.granted || a?.kind !== b?.kind || a?.mode !== b?.mode || a?.canGrant !== b?.canGrant) {
    grantCache.clear();
  }
});

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
  const access = useAccessStore((s) => s.status);
  const [grant, setGrant] = useState<Grant | null>(() => grantCache.get(code) ?? null);
  const [qr, setQr] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const canGrant = access?.canGrant === true;
  const guest = access?.grants === true && access.granted && access.kind === 'g';
  // 缓存已清空（门禁状态变化）的旧授权不再显示
  const live = canGrant && reusable(grant, code) && grantCache.get(code) === grant ? grant : null;
  const url = live ? grantInviteUrl(code, live.token) : inviteUrl(code);

  // 门禁状态（GET /api/access；门禁关闭或旧服务器时维持普通链接）
  useEffect(() => {
    void useAccessStore.getState().ensureStatus();
  }, []);

  /**
   * 需要时生成（或复用）授权；失败退回普通链接（silent 时不提示）。
   * fresh：复制与二维码用——只复用 GRANT_FRESH_MS 之内生成的，否则重新生成（旧授权可能已用满或被吊销）。
   */
  const ensureGrant = async (o: { silent?: boolean; fresh?: boolean } = {}): Promise<Grant | null> => {
    if (!canGrant) return null;
    const cached = grantCache.get(code);
    if (cached && (o.fresh ? freshEnough(cached, code) : reusable(cached, code))) {
      if (cached !== grant) setGrant(cached);
      return cached;
    }
    let pending = grantInflight.get(code);
    if (!pending) {
      pending = createAccessGrant(code).then((r) => {
        if (!r.ok) return null;
        const g: Grant = {
          room: r.data.room,
          token: r.data.token,
          uses: r.data.uses,
          expiresAt: r.data.expiresAt,
          createdAt: Date.now(),
        };
        grantCache.set(code, g);
        return g;
      });
      grantInflight.set(code, pending);
      void pending.finally(() => grantInflight.delete(code));
    }
    const g = await pending;
    if (!g) {
      if (!o.silent) useUiStore.getState().toast(t('lobby:invite.grantFailed'), 'warn');
      return null;
    }
    setGrant(g);
    return g;
  };

  // 可以生成授权时直接把邀请框换成授权链接（玩家常常手动复制输入框里的地址）；门禁状态变化（缓存被清空）时换新
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只随房间号、授权能力与门禁状态变化
  useEffect(() => {
    if (canGrant) void ensureGrant({ silent: true });
  }, [canGrant, code, access]);

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

  const onCopy = async (watch: boolean): Promise<void> => {
    const g = await ensureGrant({ fresh: true });
    const u = g ? grantInviteUrl(code, g.token, watch) : inviteUrl(code, watch);
    const ok = await copy(u);
    useUiStore.getState().toast(ok ? t('lobby:invite.copied') : t('lobby:invite.copyFailed'), ok ? 'success' : 'warn');
  };

  const onToggleQr = (): void => {
    // 打开二维码（给别人扫）时同样换成新鲜的授权
    if (!showQr && canGrant) void ensureGrant({ fresh: true });
    setShowQr((v) => !v);
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
          data-grant={live ? 'true' : 'false'}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          type="button"
          className="btn btn--sm btn--blue"
          onClick={() => void onCopy(false)}
          data-testid="invite-copy"
        >
          {t('lobby:invite.copy')}
        </button>
        {allowWatch && (
          <button
            type="button"
            className="btn btn--sm btn--cream"
            onClick={() => void onCopy(true)}
            data-testid="invite-copy-watch"
          >
            {t('lobby:invite.copyWatch')}
          </button>
        )}
        <button
          type="button"
          className="btn btn--sm btn--cream"
          onClick={onToggleQr}
          aria-expanded={showQr}
          data-testid="invite-qr-toggle"
        >
          {t('lobby:invite.qr')}
        </button>
      </div>
      {live && (
        <p className={c.muted} data-testid="invite-grant-note">
          {t('lobby:invite.grantNote', { uses: live.uses })}
        </p>
      )}
      {guest && (
        <p className={c.muted} data-testid="invite-guest-note">
          {t('lobby:invite.guestNoGrant')}
        </p>
      )}
      {showQr && qr && (
        <img className={l.qr} src={qr} width={168} height={168} alt={t('lobby:invite.qrAlt')} data-testid="invite-qr" />
      )}
    </div>
  );
}
