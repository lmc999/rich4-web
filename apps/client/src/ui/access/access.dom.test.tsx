// 门禁页（口令、#g= 房间邀请授权兑换、错误提示、兑换失败时回到原房间）、门禁宿主（按原因收尾）与邀请链接
// （门禁开启时生成授权链接：一个链接只给一个人，每次复制 / 二维码都换新链接）

import type { AccessStatus } from '@rich4/shared/net';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../../skin/pack/http';
import { useUiStore } from '../../store/uiStore';
import { clearGrantCache, GRANT_REUSE_MARGIN_MS, InviteLink } from '../lobby/InviteLink';
import { AccessGate } from './AccessGate';
import { AccessGateHost } from './AccessGateHost';
import { setAccessFetch } from './accessApi';
import { requireAccess, useAccessStore } from './accessStore';
import { bootstrapAccess } from './bootstrap';

const TOKEN = 'A'.repeat(43);
const STATUS: AccessStatus = {
  mode: 'passcode',
  granted: true,
  kind: 'p',
  expiresAt: 1,
  deadline: null,
  room: null,
  roomOpen: null,
  grants: true,
  canGrant: true,
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

interface Call {
  url: string;
  method: string;
  body: unknown;
  contentType: string | null;
}

function mockFetch(handler: (c: Call) => Response): Call[] {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers);
    const c: Call = {
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      contentType: headers.get('content-type'),
    };
    calls.push(c);
    return handler(c);
  };
  setAccessFetch(f);
  return calls;
}

beforeEach(() => {
  useAccessStore.setState({ status: null, statusError: false, required: null });
});

afterEach(() => {
  setAccessFetch(null);
});

describe('AccessGate', () => {
  it('口令：POST /api/access {passcode}（JSON），通过后回调状态', async () => {
    const calls = mockFetch(() => json({ ok: true, data: STATUS }));
    const onGranted = vi.fn();
    render(<AccessGate reason="pack" onGranted={onGranted} location={{ hash: '', pathname: '/', search: '' }} />);
    expect(screen.getByTestId('access-submit')).toBeDisabled();
    await userEvent.type(screen.getByTestId('access-passcode'), ' secret ');
    await userEvent.click(screen.getByTestId('access-submit'));
    await waitFor(() => expect(onGranted).toHaveBeenCalledWith(STATUS, null));
    expect(calls).toEqual([
      { url: '/api/access', method: 'POST', body: { passcode: 'secret' }, contentType: 'application/json' },
    ]);
    expect(screen.getByTestId('access-passcode')).toHaveAttribute('type', 'password');
  });

  it('口令错误 → 提示；限流 → 提示等待秒数', async () => {
    let n = 0;
    mockFetch(() =>
      n++ === 0
        ? json({ ok: false, error: { code: 'ACCESS_REQUIRED', details: { reason: 'badPasscode' } } }, 401)
        : json({ ok: false, error: { code: 'RATE_LIMITED', details: { retryAfterMs: 4200 } } }, 429, {
            'retry-after': '5',
          }),
    );
    const onGranted = vi.fn();
    render(<AccessGate reason="pack" onGranted={onGranted} location={{ hash: '', pathname: '/', search: '' }} />);
    await userEvent.type(screen.getByTestId('access-passcode'), 'nope');
    await userEvent.click(screen.getByTestId('access-submit'));
    expect(await screen.findByTestId('access-error')).toHaveTextContent('口令不正确');
    await userEvent.click(screen.getByTestId('access-submit'));
    await waitFor(() => expect(screen.getByTestId('access-error')).toHaveTextContent('请 5 秒后再试'));
    expect(onGranted).not.toHaveBeenCalled();
  });

  it('#g= 授权：挂载即兑换，先清掉片段；成功回调链接对应的房间号（target）', async () => {
    const calls = mockFetch(() =>
      json({ ok: true, data: { ...STATUS, kind: 'g', canGrant: false, room: '123456', target: '123456' } }),
    );
    const replaced: string[] = [];
    const onGranted = vi.fn();
    render(
      <AccessGate
        reason="socket"
        onGranted={onGranted}
        location={{ hash: `#g=${TOKEN}`, pathname: '/r/123456', search: '?watch=1' }}
        replaceUrl={(u) => replaced.push(u)}
      />,
    );
    expect(screen.getByTestId('access-redeeming')).toBeInTheDocument();
    expect(replaced).toEqual(['/r/123456?watch=1']);
    await waitFor(() => expect(onGranted).toHaveBeenCalledWith(expect.objectContaining({ kind: 'g' }), '123456'));
    expect(calls[0]).toMatchObject({ url: '/api/access/redeem', method: 'POST', body: { token: TOKEN } });
  });

  it('授权失效：提示并显示口令输入；格式不对的片段不兑换', async () => {
    mockFetch(() => json({ ok: false, error: { code: 'ACCESS_REQUIRED', details: { reason: 'expired' } } }, 401));
    const { unmount } = render(
      <AccessGate
        reason="socket"
        onGranted={() => {}}
        location={{ hash: `#g=${TOKEN}`, pathname: '/r/1', search: '' }}
        replaceUrl={() => {}}
      />,
    );
    expect(await screen.findByTestId('access-error')).toHaveTextContent('邀请链接已失效');
    expect(screen.getByTestId('access-passcode')).toBeInTheDocument();
    unmount();
    const calls = mockFetch(() => json({ ok: true, data: STATUS }));
    const replaced: string[] = [];
    render(
      <AccessGate
        reason="socket"
        onGranted={() => {}}
        location={{ hash: '#g=short', pathname: '/r/1', search: '' }}
        replaceUrl={(u) => replaced.push(u)}
      />,
    );
    expect(screen.queryByTestId('access-redeeming')).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('AccessGate：兑换失败时已有访问', () => {
  it('g 会话打开已用过的链接：提示失效，并给「回到房间」（不必输入口令）', async () => {
    const guest: AccessStatus = { ...STATUS, kind: 'g', canGrant: false, room: '654321' };
    mockFetch((c) =>
      c.url === '/api/access/redeem'
        ? json({ ok: false, error: { code: 'ACCESS_REQUIRED', details: { reason: 'grantInvalid' } } }, 401)
        : json({ ok: true, data: guest }),
    );
    const onGranted = vi.fn();
    render(
      <AccessGate
        reason="startup"
        onGranted={onGranted}
        location={{ hash: `#g=${TOKEN}`, pathname: '/r/123456', search: '' }}
        replaceUrl={() => {}}
      />,
    );
    expect(await screen.findByTestId('access-error')).toHaveTextContent('已被别人用过');
    const back = await screen.findByTestId('access-continue');
    expect(back).toHaveTextContent('回到房间 654321');
    await userEvent.click(back);
    expect(onGranted).toHaveBeenCalledWith(guest, '654321');
  });

  it('房间已关闭（ROOM_NOT_FOUND）：单独的提示；没有有效访问时只显示口令输入', async () => {
    mockFetch((c) =>
      c.url === '/api/access/redeem'
        ? json({ ok: false, error: { code: 'ROOM_NOT_FOUND', details: { reason: 'roomClosed' } } }, 404)
        : json({ ok: true, data: { ...STATUS, granted: false, kind: null, canGrant: false } }),
    );
    render(
      <AccessGate
        reason="startup"
        onGranted={() => {}}
        location={{ hash: `#g=${TOKEN}`, pathname: '/r/123456', search: '' }}
        replaceUrl={() => {}}
      />,
    );
    expect(await screen.findByTestId('access-error')).toHaveTextContent('邀请你的房间已经关闭');
    expect(screen.getByTestId('access-passcode')).toBeInTheDocument();
    await waitFor(() => expect(useAccessStore.getState().status?.granted).toBe(false));
    expect(screen.queryByTestId('access-continue')).toBeNull();
  });
});

describe('AccessGateHost', () => {
  it('requireAccess 显示门禁页；素材包原因通过后只收起，不重新载入', async () => {
    mockFetch(() => json({ ok: true, data: STATUS }));
    const reload = vi.fn();
    render(<AccessGateHost reload={reload} />);
    expect(screen.queryByTestId('access-gate')).toBeNull();
    act(() => requireAccess('pack'));
    expect(screen.getByTestId('access-gate')).toHaveAttribute('data-reason', 'pack');
    await userEvent.type(screen.getByTestId('access-passcode'), 'pw');
    await userEvent.click(screen.getByTestId('access-submit'));
    await waitFor(() => expect(screen.queryByTestId('access-gate')).toBeNull());
    expect(useAccessStore.getState().status).toEqual(STATUS);
    expect(reload).not.toHaveBeenCalled();
  });

  it('握手原因通过后重新载入页面（让 Socket.IO 带着 cookie 重连）', async () => {
    mockFetch(() => json({ ok: true, data: STATUS }));
    const reload = vi.fn();
    render(<AccessGateHost reload={reload} />);
    act(() => requireAccess('socket'));
    await userEvent.type(screen.getByTestId('access-passcode'), 'pw');
    await userEvent.click(screen.getByTestId('access-submit'));
    await waitFor(() => expect(reload).toHaveBeenCalledWith(null));
    // 页面跳转之前门禁页保持显示（按钮停在「验证中」），状态已更新
    expect(screen.getByTestId('access-gate')).toBeInTheDocument();
    expect(screen.getByTestId('access-submit')).toBeDisabled();
    expect(useAccessStore.getState().status).toEqual(STATUS);
  });

  it('自挂的全屏浮层（standalone）在页面另有宿主时让位：同一时刻只有一份门禁页', () => {
    const overlay = render(<AccessGateHost standalone reload={vi.fn()} />);
    act(() => requireAccess('api'));
    expect(screen.getAllByTestId('access-gate')).toHaveLength(1);
    const page = render(<AccessGateHost reload={vi.fn()} />);
    expect(screen.getAllByTestId('access-gate')).toHaveLength(1);
    expect(useAccessStore.getState().hosts).toBe(2);
    page.unmount();
    expect(screen.getAllByTestId('access-gate')).toHaveLength(1);
    overlay.unmount();
    expect(useAccessStore.getState().hosts).toBe(0);
  });
});

describe('InviteLink + 门禁', () => {
  let clip: string[];
  beforeEach(() => {
    clearGrantCache();
    clip = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (s: string) => void clip.push(s) },
    });
  });

  it('门禁关闭：普通链接，不生成授权', async () => {
    const calls = mockFetch(() =>
      json({ ok: true, data: { ...STATUS, mode: 'off', kind: null, grants: false, canGrant: false } }),
    );
    render(<InviteLink code="482913" allowWatch />);
    await waitFor(() => expect(useAccessStore.getState().status?.mode).toBe('off'));
    await userEvent.click(screen.getByTestId('invite-copy'));
    await waitFor(() => expect(clip).toEqual([`${location.origin}/r/482913`]));
    expect(calls.map((c) => c.url)).toEqual(['/api/access']);
    expect(screen.getByTestId('invite-url')).toHaveValue(`${location.origin}/r/482913`);
  });

  /** 每次 POST /api/access/grant 返回新的 token（第 n 次为 tok(n)） */
  const tok = (k: number) => String(k).repeat(43).slice(0, 43);
  function grantServer(o: { expiresIn?: number } = {}): Call[] {
    let n = 0;
    return mockFetch((c) => {
      if (c.url === '/api/access') return json({ ok: true, data: STATUS });
      n++;
      return json({
        ok: true,
        data: {
          room: '482913',
          token: tok(n),
          expiresAt: Date.now() + (o.expiresIn ?? 30 * 60_000),
          uses: 1,
          path: `/r/482913#g=${tok(n)}`,
        },
      });
    });
  }
  const link = (k: number, watch = false) => `${location.origin}/r/482913${watch ? '?watch=1' : ''}#g=${tok(k)}`;
  const grants = (calls: Call[]) => calls.filter((c) => c.url === '/api/access/grant').length;

  it('邀请框是一条还没交出去的授权链接；每次复制交出这一条并换新，观战链接同理；文案说明限一人、30 分钟', async () => {
    const calls = grantServer();
    render(<InviteLink code="482913" allowWatch />);
    // 邀请框自动换成授权链接（E2E 夹具读 data-grant）
    await waitFor(() => expect(screen.getByTestId('invite-url')).toHaveValue(link(1)));
    expect(screen.getByTestId('invite-url')).toHaveAttribute('data-grant', 'true');
    expect(screen.getByTestId('invite-grant-note')).toHaveTextContent('邀请链接限一人使用、30 分钟内有效');
    await userEvent.click(screen.getByTestId('invite-copy'));
    await waitFor(() => expect(clip).toEqual([link(1)]));
    // 复制过的链接不留在框里
    await waitFor(() => expect(screen.getByTestId('invite-url')).toHaveValue(link(2)));
    expect(useUiStore.getState().toasts.at(-1)?.text).toContain('限一人使用，30 分钟内有效');
    await userEvent.click(screen.getByTestId('invite-copy-watch'));
    await waitFor(() => expect(clip[1]).toBe(link(2, true)));
    await waitFor(() => expect(screen.getByTestId('invite-url')).toHaveValue(link(3)));
    await userEvent.click(screen.getByTestId('invite-copy'));
    await waitFor(() => expect(clip[2]).toBe(link(3)));
    expect(new Set(clip.map((u) => u.split('#')[1])).size).toBe(3);
    await waitFor(() => expect(grants(calls)).toBe(4));
    expect(calls.find((c) => c.url === '/api/access/grant')).toEqual({
      url: '/api/access/grant',
      method: 'POST',
      body: { room: '482913' },
      contentType: 'application/json',
    });
  });

  it('二维码：每次打开都交出一条新链接（框里随之换新）；在框里手动复制也算交出', async () => {
    const calls = grantServer();
    render(<InviteLink code="482913" allowWatch={false} />);
    await waitFor(() => expect(screen.getByTestId('invite-url')).toHaveValue(link(1)));
    await userEvent.click(screen.getByTestId('invite-qr-toggle'));
    await waitFor(() => expect(screen.getByTestId('invite-qr')).toHaveAttribute('data-url', link(1)));
    expect(screen.getByTestId('invite-qr-note')).toHaveTextContent('限一人扫码');
    await waitFor(() => expect(screen.getByTestId('invite-url')).toHaveValue(link(2)));
    // 关掉再打开：给下一个人的新链接
    await userEvent.click(screen.getByTestId('invite-qr-toggle'));
    expect(screen.queryByTestId('invite-qr')).toBeNull();
    await userEvent.click(screen.getByTestId('invite-qr-toggle'));
    await waitFor(() => expect(screen.getByTestId('invite-qr')).toHaveAttribute('data-url', link(2)));
    await waitFor(() => expect(screen.getByTestId('invite-url')).toHaveValue(link(3)));
    // 在邀请框里选中复制（Ctrl+C）：这条算交出去了
    fireEvent.copy(screen.getByTestId('invite-url'));
    await waitFor(() => expect(screen.getByTestId('invite-url')).toHaveValue(link(4)));
    expect(grants(calls)).toBe(4);
  });

  it('连点「复制」「复制观战」（下一条还在生成中）：两次拿到的也是两条不同的链接', async () => {
    const calls = grantServer();
    render(<InviteLink code="482913" allowWatch />);
    await waitFor(() => expect(screen.getByTestId('invite-url')).toHaveValue(link(1)));
    fireEvent.click(screen.getByTestId('invite-copy'));
    fireEvent.click(screen.getByTestId('invite-copy-watch'));
    fireEvent.click(screen.getByTestId('invite-copy'));
    await waitFor(() => expect(clip).toHaveLength(3));
    expect(new Set(clip.map((u) => u.split('#')[1])).size).toBe(3);
    await waitFor(() => expect(screen.getByTestId('invite-url')).toHaveAttribute('data-grant', 'true'));
    expect(clip).not.toContain((screen.getByTestId('invite-url') as HTMLInputElement).value);
    expect(grants(calls)).toBeGreaterThanOrEqual(4);
  });

  it('备用链接快到期（不足 5 分钟）时不交出去：复制时现生成一条', async () => {
    const calls = grantServer();
    const t0 = Date.now();
    let now = t0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      render(<InviteLink code="482913" allowWatch={false} />);
      await waitFor(() => expect(screen.getByTestId('invite-url')).toHaveValue(link(1)));
      now = t0 + 30 * 60_000 - GRANT_REUSE_MARGIN_MS + 1000;
      await userEvent.click(screen.getByTestId('invite-copy'));
      await waitFor(() => expect(clip).toEqual([link(2)]));
      await waitFor(() => expect(screen.getByTestId('invite-url')).toHaveValue(link(3)));
      expect(grants(calls)).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });

  it('生成失败：提示并退回普通链接', async () => {
    mockFetch((c) =>
      c.url === '/api/access'
        ? json({ ok: true, data: STATUS })
        : json({ ok: false, error: { code: 'RATE_LIMITED' } }, 429),
    );
    render(<InviteLink code="482913" allowWatch={false} />);
    await waitFor(() => expect(useAccessStore.getState().status?.canGrant).toBe(true));
    expect(screen.getByTestId('invite-url')).toHaveAttribute('data-grant', 'false');
    await userEvent.click(screen.getByTestId('invite-copy'));
    await waitFor(() => expect(clip).toEqual([`${location.origin}/r/482913`]));
    expect(useUiStore.getState().toasts.some((x) => x.text.includes('改用普通链接'))).toBe(true);
  });

  it('门禁状态变化（登出后重新登录、吊销后换了 cookie）：清空备用链接，邀请框换新授权', async () => {
    const calls = grantServer();
    render(<InviteLink code="482913" allowWatch={false} />);
    await waitFor(() => expect(screen.getByTestId('invite-url')).toHaveValue(link(1)));
    act(() => useAccessStore.setState({ status: { ...STATUS, granted: false, kind: null, canGrant: false } }));
    expect(screen.getByTestId('invite-url')).toHaveValue(`${location.origin}/r/482913`);
    act(() => useAccessStore.setState({ status: { ...STATUS, expiresAt: 2 } }));
    await waitFor(() => expect(screen.getByTestId('invite-url')).toHaveValue(link(2)));
    expect(grants(calls)).toBe(2);
  });

  it('经授权进入的访客：普通链接并提示不能再生成授权', async () => {
    const calls = mockFetch(() => json({ ok: true, data: { ...STATUS, kind: 'g', canGrant: false, room: '482913' } }));
    render(<InviteLink code="482913" allowWatch={false} />);
    expect(await screen.findByTestId('invite-guest-note')).toBeInTheDocument();
    expect(screen.queryByTestId('invite-grant-note')).toBeNull();
    await userEvent.click(screen.getByTestId('invite-copy'));
    await waitFor(() => expect(clip).toEqual([`${location.origin}/r/482913`]));
    expect(grants(calls)).toBe(0);
  });
});

describe('bootstrapAccess（入口调用）', () => {
  it('地址栏带 #g= → 要求门禁页（不先请求状态）', async () => {
    const calls = mockFetch(() => json({ ok: true, data: STATUS }));
    await bootstrapAccess({ hash: `#g=${TOKEN}` });
    expect(useAccessStore.getState().required).toBe('startup');
    expect(calls).toEqual([]);
  });

  it('门禁开启而未通过 → 要求门禁页；已通过或门禁关闭 → 不打扰', async () => {
    let status: AccessStatus = { ...STATUS, granted: false, kind: null, canGrant: false };
    mockFetch(() => json({ ok: true, data: status }));
    await bootstrapAccess({ hash: '' });
    expect(useAccessStore.getState().required).toBe('startup');
    useAccessStore.setState({ required: null });
    status = STATUS;
    await bootstrapAccess({ hash: '' });
    expect(useAccessStore.getState().required).toBeNull();
    mockFetch(() => json({ ok: false }, 404));
    await bootstrapAccess({ hash: '' });
    expect(useAccessStore.getState().required).toBeNull();
    expect(useAccessStore.getState().statusError).toBe(true);
  });
});
