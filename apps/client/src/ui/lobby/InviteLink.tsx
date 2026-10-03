// 邀请链接（design/client.md §5.5、net.md §3.1）：/r/<code>（观战加 ?watch=1），复制按钮 + 二维码。
// 链接以当前页面的 origin 拼出（开发期 Vite 端口与服务器 PUBLIC_URL 不同）。程序化大厅、原版选人大厅与对局侧栏共用本组件。
// 访问门禁开启、且本会话可以生成授权时（口令或邀请码进入的玩家），邀请框、复制与二维码改用带授权片段的链接
// `/r/<code>#g=<token>`（POST /api/access/grant；片段不发给服务器）。授权**只能兑换一次、30 分钟内有效**
// （architecture §35：一个链接给一个人），所以：
// - 邀请框里是一条「备用」链接：已生成、还没交给任何人（data-grant="true"，E2E 夹具据此读取）；离到期不足 5 分钟时自动换新；
// - 交出去一次（点「复制链接」「复制观战链接」、打开二维码、或在邀请框里手动复制）就把这条用掉：复制 / 二维码拿到的是
//   这条备用链接，邀请框随即换成新生成的一条——被复制过的链接不会留在框里给第二个人；
// - 二维码显示的是交出去的那条，给下一个人要重新打开二维码（又换一条）。
// 备用链接按房间号存在模块级 store 里（同页的多个邀请框共用、重新挂载复用）；门禁状态变化（通过与否、来源、模式）时清空。
// 经授权进入的访客（kind g）不能生成授权：普通链接 + 提示。
import { ACCESS_GRANT_FRAGMENT_KEY, ACCESS_GRANT_TTL_MS } from '@rich4/shared/net';
import QRCode from 'qrcode';
import { type ReactNode, useEffect, useState } from 'react';
import { create } from 'zustand';
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

/** 备用链接离到期不足这个时长时换新（交出去之后对方至少还有这么久可以打开） */
export const GRANT_REUSE_MARGIN_MS = 5 * 60_000;
/** 授权有效分钟数（界面文案） */
const GRANT_MINUTES = Math.round(ACCESS_GRANT_TTL_MS / 60_000);

interface Grant {
  room: string;
  token: string;
  expiresAt: number;
}

/** 每个房间的备用链接（已生成、还没交出去） */
const useSpareGrants = create<{ spares: Readonly<Record<string, Grant>> }>()(() => ({ spares: {} }));
/** 进行中的生成请求（并发合并为一次） */
const inflight = new Map<string, Promise<Grant | null>>();
/** 清空计数：清空之前发出、之后才返回的请求结果作废（旧 cookie 生成的授权可能已随 epoch 失效） */
let generation = 0;
/** 已经交出去的链接（并发的两次交出——例如连点「复制」「复制观战」——不会拿到同一条） */
const handedOut = new WeakSet<Grant>();

function usable(g: Grant | null | undefined, room: string): g is Grant {
  return !!g && g.room === room && !handedOut.has(g) && g.expiresAt - Date.now() > GRANT_REUSE_MARGIN_MS;
}

function setSpare(room: string, g: Grant | null): void {
  useSpareGrants.setState((st) => {
    const spares = { ...st.spares };
    if (g) spares[room] = g;
    else delete spares[room];
    return { spares };
  });
}

/** 确保有一条可用的备用链接（没有或快到期时生成）；失败返回 null */
function ensureSpare(room: string): Promise<Grant | null> {
  const cur = useSpareGrants.getState().spares[room];
  if (usable(cur, room)) return Promise.resolve(cur);
  let p = inflight.get(room);
  if (!p) {
    const gen = generation;
    p = createAccessGrant(room).then((r) => {
      if (!r.ok || gen !== generation) return null;
      const g: Grant = { room: r.data.room, token: r.data.token, expiresAt: r.data.expiresAt };
      setSpare(room, g);
      return g;
    });
    inflight.set(room, p);
    void p.finally(() => {
      if (inflight.get(room) === p) inflight.delete(room);
    });
  }
  return p;
}

/** 把这条备用链接标为已交出：从邀请框撤下并在后台生成下一条 */
function consumeSpare(room: string, g: Grant): void {
  handedOut.add(g);
  if (useSpareGrants.getState().spares[room] === g) setSpare(room, null);
  void ensureSpare(room);
}

/** 交出一条链接（复制 / 二维码）：拿到备用链接并用掉它；等待期间被别的交出抢先用掉就再要一条；生成失败返回 null */
async function takeGrant(room: string): Promise<Grant | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const g = await ensureSpare(room);
    if (!g) return null;
    if (handedOut.has(g)) continue;
    consumeSpare(room, g);
    return g;
  }
  return null;
}

/** 清空本页的备用链接（门禁状态变化时；测试） */
export function clearGrantCache(): void {
  generation++;
  inflight.clear();
  useSpareGrants.setState({ spares: {} });
}

// 门禁状态变化（登出 / 重新登录、吊销后换了 cookie、来源或模式改变）：旧授权可能已随 epoch 失效，不再使用
useAccessStore.subscribe((s, prev) => {
  const a = s.status;
  const b = prev.status;
  if (a?.granted !== b?.granted || a?.kind !== b?.kind || a?.mode !== b?.mode || a?.canGrant !== b?.canGrant) {
    clearGrantCache();
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
  const spare = useSpareGrants((st) => st.spares[code] ?? null);
  /** 二维码：交出去的那条（null 且 qrUrl 非空时是普通链接） */
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrGrant, setQrGrant] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const canGrant = access?.canGrant === true;
  const guest = access?.grants === true && access.granted && access.kind === 'g';
  const live = canGrant && usable(spare, code) ? spare : null;
  const url = live ? grantInviteUrl(code, live.token) : inviteUrl(code);

  // 门禁状态（GET /api/access；门禁关闭或旧服务器时维持普通链接）
  useEffect(() => {
    void useAccessStore.getState().ensureStatus();
  }, []);

  // 可以生成授权时邀请框直接放一条备用的授权链接（玩家常常手动复制输入框里的地址）；门禁状态变化（已清空）时换新
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只随房间号、授权能力与门禁状态变化
  useEffect(() => {
    if (canGrant) void ensureSpare(code);
  }, [canGrant, code, access]);

  // 备用链接快到期时换新（邀请框开着很久没人用）
  useEffect(() => {
    if (!live) return;
    const ms = Math.max(0, live.expiresAt - GRANT_REUSE_MARGIN_MS - Date.now()) + 50;
    const id = setTimeout(() => void ensureSpare(code), ms);
    return () => clearTimeout(id);
  }, [live, code]);

  useEffect(() => {
    if (!showQr || !qrUrl) {
      setQr(null);
      return;
    }
    let stale = false;
    QRCode.toString(qrUrl, { type: 'svg', margin: 1, width: 168, errorCorrectionLevel: 'M' }).then(
      (svg) => !stale && setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`),
      () => !stale && setQr(null),
    );
    return () => {
      stale = true;
    };
  }, [showQr, qrUrl]);

  /** 交出一条链接；不能生成授权时返回 null（普通链接），生成失败时提示并返回 null */
  const handOut = async (): Promise<string | null> => {
    if (!canGrant) return null;
    const g = await takeGrant(code);
    if (!g) useUiStore.getState().toast(t('lobby:invite.grantFailed'), 'warn');
    return g ? g.token : null;
  };

  const onCopy = async (watch: boolean): Promise<void> => {
    const token = await handOut();
    const u = token ? grantInviteUrl(code, token, watch) : inviteUrl(code, watch);
    const ok = await copy(u);
    const text = !ok
      ? t('lobby:invite.copyFailed')
      : token
        ? t('lobby:invite.copiedGrant', { minutes: GRANT_MINUTES })
        : t('lobby:invite.copied');
    useUiStore.getState().toast(text, ok ? 'success' : 'warn');
  };

  // 在邀请框里手动复制了授权链接：这条算交出去了，换一条新的
  const onManualCopy = (): void => {
    if (!live) return;
    consumeSpare(code, live);
    useUiStore.getState().toast(t('lobby:invite.copiedGrant', { minutes: GRANT_MINUTES }), 'success');
  };

  const onToggleQr = async (): Promise<void> => {
    if (showQr) {
      setShowQr(false);
      setQrUrl(null);
      return;
    }
    setShowQr(true);
    setQrUrl(null);
    const token = await handOut();
    setQrGrant(token !== null);
    setQrUrl(token ? grantInviteUrl(code, token) : inviteUrl(code));
  };

  return (
    <div className={l.invite} data-testid="invite">
      <div className={c.row}>
        <span className={l.inviteNote}>{t('lobby:invite.code')}</span>
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
          onCopy={onManualCopy}
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
          onClick={() => void onToggleQr()}
          aria-expanded={showQr}
          data-testid="invite-qr-toggle"
        >
          {t('lobby:invite.qr')}
        </button>
      </div>
      {canGrant && (
        <p className={l.inviteNote} data-testid="invite-grant-note">
          {t('lobby:invite.grantNote', { minutes: GRANT_MINUTES })}
        </p>
      )}
      {guest && (
        <p className={l.inviteNote} data-testid="invite-guest-note">
          {t('lobby:invite.guestNoGrant')}
        </p>
      )}
      {showQr && qr && (
        <>
          <img
            className={l.qr}
            src={qr}
            width={168}
            height={168}
            alt={t('lobby:invite.qrAlt')}
            data-testid="invite-qr"
            data-url={qrUrl ?? ''}
          />
          {qrGrant && (
            <p className={l.inviteNote} data-testid="invite-qr-note">
              {t('lobby:invite.qrNote')}
            </p>
          )}
        </>
      )}
    </div>
  );
}
