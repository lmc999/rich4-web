// 门禁页（口令、#g= 房间邀请授权兑换、错误提示）、门禁宿主（按原因收尾）与邀请链接（门禁开启时生成授权链接）

import type { AccessStatus } from '@rich4/shared/net';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../../skin/pack/http';
import { clearGrantCache, GRANT_FRESH_MS, InviteLink } from '../lobby/InviteLink';
import { AccessGate } from './AccessGate';
import { AccessGateHost } from './AccessGateHost';
import { setAccessFetch } from './accessApi';
import { requireAccess, useAccessStore } from './accessStore';
import { bootstrapAccess } from './bootstrap';

const TOKEN = 'A'.repeat(43);
const STATUS: AccessStatus = { mode: 'passcode', granted: true, kind: 'p', expiresAt: 1, grants: true, canGrant: true };

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

  it('#g= 授权：挂载即兑换，先清掉片段；成功回调房间号', async () => {
    const calls = mockFetch(() => json({ ok: true, data: { ...STATUS, kind: 'g', canGrant: false, room: '123456' } }));
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

  it('可以生成授权：复制带 #g= 的链接；刚生成的授权（30 秒内）复用，连续复制不重复生成', async () => {
    const calls = mockFetch((c) =>
      c.url === '/api/access'
        ? json({ ok: true, data: STATUS })
        : json({
            ok: true,
            data: {
              room: '482913',
              token: TOKEN,
              expiresAt: Date.now() + 24 * 3600_000,
              uses: 8,
              path: `/r/482913#g=${TOKEN}`,
            },
          }),
    );
    render(<InviteLink code="482913" allowWatch />);
    await waitFor(() => expect(useAccessStore.getState().status?.canGrant).toBe(true));
    // 邀请框自动换成授权链接（E2E 夹具读 data-grant）
    await waitFor(() => expect(screen.getByTestId('invite-url')).toHaveAttribute('data-grant', 'true'));
    await userEvent.click(screen.getByTestId('invite-copy'));
    await waitFor(() => expect(clip).toEqual([`${location.origin}/r/482913#g=${TOKEN}`]));
    expect(screen.getByTestId('invite-url')).toHaveValue(`${location.origin}/r/482913#g=${TOKEN}`);
    expect(screen.getByTestId('invite-grant-note')).toHaveTextContent('最多 8 次');
    await userEvent.click(screen.getByTestId('invite-copy-watch'));
    await waitFor(() => expect(clip[1]).toBe(`${location.origin}/r/482913?watch=1#g=${TOKEN}`));
    expect(calls.filter((c) => c.url === '/api/access/grant')).toEqual([
      { url: '/api/access/grant', method: 'POST', body: { room: '482913' }, contentType: 'application/json' },
    ]);
  });

  it('复制与打开二维码要新鲜的授权：超过 30 秒的旧授权（可能已用满或被吊销）不再复制出去，邀请框随之换新', async () => {
    let n = 0;
    const calls = mockFetch((c) => {
      if (c.url === '/api/access') return json({ ok: true, data: STATUS });
      n++;
      const token = String(n).repeat(43).slice(0, 43);
      return json({
        ok: true,
        data: { room: '482913', token, expiresAt: Date.now() + 24 * 3600_000, uses: 8, path: `/r/482913#g=${token}` },
      });
    });
    const t0 = Date.now();
    let now = t0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      render(<InviteLink code="482913" allowWatch />);
      const tok = (k: number) => String(k).repeat(43).slice(0, 43);
      await waitFor(() =>
        expect(screen.getByTestId('invite-url')).toHaveValue(`${location.origin}/r/482913#g=${tok(1)}`),
      );
      now = t0 + GRANT_FRESH_MS + 1000;
      await userEvent.click(screen.getByTestId('invite-copy'));
      await waitFor(() => expect(clip).toEqual([`${location.origin}/r/482913#g=${tok(2)}`]));
      expect(screen.getByTestId('invite-url')).toHaveValue(`${location.origin}/r/482913#g=${tok(2)}`);
      // 紧接着打开二维码：30 秒内生成的，复用
      await userEvent.click(screen.getByTestId('invite-qr-toggle'));
      expect(calls.filter((c) => c.url === '/api/access/grant')).toHaveLength(2);
      await userEvent.click(screen.getByTestId('invite-qr-toggle'));
      now += GRANT_FRESH_MS + 1000;
      await userEvent.click(screen.getByTestId('invite-qr-toggle'));
      await waitFor(() => expect(calls.filter((c) => c.url === '/api/access/grant')).toHaveLength(3));
      await waitFor(() =>
        expect(screen.getByTestId('invite-url')).toHaveValue(`${location.origin}/r/482913#g=${tok(3)}`),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('门禁状态变化（登出后重新登录、吊销后换了 cookie）：清空授权缓存，邀请框换新授权', async () => {
    let n = 0;
    const calls = mockFetch((c) => {
      if (c.url === '/api/access') return json({ ok: true, data: STATUS });
      n++;
      const token = String(n).repeat(43).slice(0, 43);
      return json({
        ok: true,
        data: { room: '482913', token, expiresAt: Date.now() + 24 * 3600_000, uses: 8, path: `/r/482913#g=${token}` },
      });
    });
    render(<InviteLink code="482913" allowWatch={false} />);
    const tok = (k: number) => String(k).repeat(43).slice(0, 43);
    await waitFor(() =>
      expect(screen.getByTestId('invite-url')).toHaveValue(`${location.origin}/r/482913#g=${tok(1)}`),
    );
    act(() => useAccessStore.setState({ status: { ...STATUS, granted: false, kind: null, canGrant: false } }));
    expect(screen.getByTestId('invite-url')).toHaveValue(`${location.origin}/r/482913`);
    act(() => useAccessStore.setState({ status: { ...STATUS, expiresAt: 2 } }));
    await waitFor(() =>
      expect(screen.getByTestId('invite-url')).toHaveValue(`${location.origin}/r/482913#g=${tok(2)}`),
    );
    expect(calls.filter((c) => c.url === '/api/access/grant')).toHaveLength(2);
  });

  it('经授权进入的访客：普通链接并提示不能再生成授权', async () => {
    mockFetch(() => json({ ok: true, data: { ...STATUS, kind: 'g', canGrant: false } }));
    render(<InviteLink code="482913" allowWatch={false} />);
    expect(await screen.findByTestId('invite-guest-note')).toBeInTheDocument();
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
