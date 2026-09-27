// 访问门禁页（original-skin.md U4；design-draft §5.3）：
// - 打开时先看 URL 片段：`#g=<token>`（房间邀请授权）→ POST /api/access/redeem 换取 cookie，无论成败都立刻清掉片段；
// - 否则（或兑换失败）显示口令输入：POST /api/access {passcode}；
// - 通过后交给 onGranted：缺省跳到授权里的房间（或重新载入当前页），让 Socket.IO 带着新 cookie 重新握手。
// 口令输入框是 password 类型、autocomplete=current-password；口令与 token 不写进日志和 URL。
import type { AccessStatus } from '@rich4/shared/net';
import { parseAccessGrantFragment } from '@rich4/shared/net';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useTx } from '../../i18n/tx';
import c from '../common/common.module.css';
import a from './access.module.css';
import { type AccessResult, loginAccess, redeemAccessGrant } from './accessApi';
import type { AccessReason } from './accessStore';

export interface GateLocation {
  hash: string;
  pathname: string;
  search: string;
}

export interface AccessGateProps {
  reason: AccessReason | null;
  /** 通过门禁；room 为邀请授权对应的房间号 */
  onGranted(status: AccessStatus, room: string | null): void;
  /** 测试注入（缺省 window.location / history） */
  location?: GateLocation;
  replaceUrl?(url: string): void;
}

/** 清掉地址栏里的 #g= 片段（不新增历史记录，也不触发路由跳转） */
export function stripGrantFragment(loc: GateLocation, replace: (url: string) => void): void {
  if (parseAccessGrantFragment(loc.hash) === null && !/(^#|&)g=/.test(loc.hash)) return;
  replace(`${loc.pathname}${loc.search}`);
}

function defaultReplace(url: string): void {
  if (typeof history !== 'undefined') history.replaceState(history.state, '', url);
}

function errorKey(r: Extract<AccessResult<unknown>, { ok: false }>, redeem: boolean): string {
  if (r.code === 'RATE_LIMITED') return 'hud:access.error.rateLimited';
  if (r.code === 'NETWORK') return 'hud:access.error.network';
  if (redeem) return 'hud:access.error.grantInvalid';
  if (r.code === 'ACCESS_REQUIRED' || r.status === 401 || r.status === 403) return 'hud:access.error.badPasscode';
  return 'hud:access.error.generic';
}

export function AccessGate({ reason, onGranted, location, replaceUrl }: AccessGateProps): ReactNode {
  const t = useTx();
  const loc: GateLocation = location ?? globalThis.location ?? { hash: '', pathname: '/', search: '' };
  const replace = replaceUrl ?? defaultReplace;
  const [token] = useState(() => parseAccessGrantFragment(loc.hash));
  const [redeeming, setRedeeming] = useState(token !== null);
  const [busy, setBusy] = useState(false);
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState<{ key: string; seconds: number | null } | null>(null);
  const onGrantedRef = useRef(onGranted);
  onGrantedRef.current = onGranted;

  // 邀请授权：只尝试一次；片段立即从地址栏清除（刷新不会重复兑换、也不会被截图或复制带走）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时处理一次片段
  useEffect(() => {
    if (token === null) return;
    stripGrantFragment(loc, replace);
    let stale = false;
    redeemAccessGrant(token).then((r) => {
      if (stale) return;
      // 成功时保持「正在验证」直到宿主收起门禁页或页面跳转
      if (r.ok) onGrantedRef.current(r.data, r.data.room);
      else {
        setRedeeming(false);
        setError({ key: errorKey(r, true), seconds: null });
      }
    });
    return () => {
      stale = true;
    };
  }, []);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const code = passcode.trim();
    if (!code || busy) return;
    setBusy(true);
    setError(null);
    const r = await loginAccess(code);
    if (r.ok) {
      // 保持「验证中」直到宿主收起门禁页或页面跳转（重新载入期间不再显示可提交的表单）
      setPasscode('');
      onGrantedRef.current(r.data, null);
      return;
    }
    setBusy(false);
    setError({ key: errorKey(r, false), seconds: r.retryAfterMs ? Math.ceil(r.retryAfterMs / 1000) : null });
  };

  return (
    <div className={a.backdrop} data-testid="access-gate" data-reason={reason ?? ''}>
      <section className={`panel ${a.card}`} role="dialog" aria-modal="true" aria-labelledby="access-gate-title">
        <h2 id="access-gate-title" className={a.title}>
          {t('hud:access.title')}
        </h2>
        <p className={c.muted}>{t('hud:access.intro')}</p>
        {redeeming ? (
          <p role="status" data-testid="access-redeeming">
            {t('hud:access.redeeming')}
          </p>
        ) : (
          <form className={a.form} onSubmit={(e) => void submit(e)}>
            <label className={c.field}>
              <span>{t('hud:access.passcode')}</span>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={passcode}
                maxLength={256}
                onChange={(e) => setPasscode(e.target.value)}
                data-testid="access-passcode"
              />
            </label>
            <button
              type="submit"
              className="btn btn--blue"
              disabled={busy || passcode.trim() === ''}
              data-testid="access-submit"
            >
              {busy ? t('hud:access.checking') : t('hud:access.submit')}
            </button>
          </form>
        )}
        {error && (
          <p className={c.error} role="alert" data-testid="access-error">
            {t(error.key, { n: error.seconds ?? 0 })}
          </p>
        )}
        <p className={c.muted}>{t('hud:access.privateNote')}</p>
      </section>
    </div>
  );
}
