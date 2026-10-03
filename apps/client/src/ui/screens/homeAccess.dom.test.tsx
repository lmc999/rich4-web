// 程序化首页与房间页对访问会话的处理（architecture §35）：经房间邀请链接进入（kind g）只能回到邀请的房间——
// 建房 / 加入 / 读档 / 单机 / 公开房间都不显示，换成一行说明与「回到房间」；邀请码会话显示有效期；
// 打开别的房间被服务器拒绝（ACCESS_SCOPE）时显示同样的说明并给「回到房间」；访客可以点「我有口令」打开门禁页（可取消）；
// 邀请的房间已经结束时不给「回到房间」，改为提示要新链接或输入口令。
import { type AccessStatus, fail } from '@rich4/shared/net';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { ClientProvider } from '../../app/services';
import { useRoomStore } from '../../store/roomStore';
import { useSettingsStore } from '../../store/settingsStore';
import { makeTestClient } from '../../test/fakeTransport';
import { AccessGateHost } from '../access/AccessGateHost';
import { setAccessFetch } from '../access/accessApi';
import { useAccessStore } from '../access/accessStore';
import { HomeScreen } from './HomeScreen';
import RoomScreen from './RoomScreen';

const BASE: AccessStatus = {
  mode: 'passcode',
  granted: true,
  kind: 'p',
  expiresAt: 0,
  deadline: null,
  room: null,
  roomOpen: null,
  grants: true,
  canGrant: true,
};
const GUEST: AccessStatus = { ...BASE, kind: 'g', room: '482913', roomOpen: true, canGrant: false };

function renderWith(ui: ReactElement, path = '/') {
  const loc = memoryLocation({ path, record: true });
  const t = makeTestClient();
  const utils = render(
    <ClientProvider client={t.client}>
      <Router hook={loc.hook}>{ui}</Router>
    </ClientProvider>,
  );
  return { ...utils, loc, ...t };
}

/** 首页挂载时会刷新一次门禁状态（访客看房间是否还在）：GET /api/access 返回 store 里的当前状态 */
beforeEach(() => {
  setAccessFetch(
    async () =>
      new Response(JSON.stringify({ ok: true, data: useAccessStore.getState().status }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
});

afterEach(() => {
  setAccessFetch(null);
  useAccessStore.setState({ status: null, statusError: false, required: null });
  useSettingsStore.setState({ nickname: '' });
  useRoomStore.getState().clear();
});

describe('程序化首页', () => {
  it('口令会话：建房、加入、读档、单机、公开房间照常；没有访客说明与有效期', () => {
    useAccessStore.setState({ status: BASE });
    renderWith(<HomeScreen />);
    for (const id of [
      'home-create',
      'home-join-open',
      'home-load-open',
      'home-solo',
      'home-settings',
      'public-rooms-toggle',
    ]) {
      expect(screen.getByTestId(id), id).toBeInTheDocument();
    }
    expect(screen.queryByTestId('home-guest-note')).toBeNull();
    expect(screen.queryByTestId('home-guest-room')).toBeNull();
    expect(screen.queryByTestId('home-access-until')).toBeNull();
  });

  it('经房间邀请链接进入（kind g）：只显示说明与「回到房间」（外加昵称与设置）', async () => {
    useSettingsStore.setState({ nickname: 'G1' });
    useAccessStore.setState({ status: GUEST });
    const { loc, container } = renderWith(<HomeScreen />);
    expect(screen.getByTestId('home-guest-note')).toHaveTextContent('你是通过邀请链接进入的，只能加入邀请你的房间');
    for (const id of ['home-create', 'home-join-open', 'home-load-open', 'home-solo']) {
      expect(screen.queryByTestId(id), id).toBeNull();
    }
    expect(container.querySelector('[data-testid^="public-rooms"]')).toBeNull();
    expect(screen.getByTestId('home-settings')).toBeInTheDocument();
    expect(screen.getByTestId('home-nickname')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('home-guest-room'));
    expect(loc.history?.at(-1)).toBe('/r/482913');
  });

  it('门禁关闭或状态未知：不当作访客', () => {
    useAccessStore.setState({ status: { ...GUEST, mode: 'off' } });
    const { unmount } = renderWith(<HomeScreen />);
    expect(screen.getByTestId('home-create')).toBeInTheDocument();
    unmount();
    useAccessStore.setState({ status: null });
    renderWith(<HomeScreen />);
    expect(screen.queryByTestId('home-guest-note')).toBeNull();
  });

  it('用带到期时间的邀请码登录：显示本次登录的有效期（到点即失效）', () => {
    const deadline = new Date(2026, 9, 4, 9, 30).getTime();
    useAccessStore.setState({ status: { ...BASE, kind: 'i', expiresAt: deadline, deadline } });
    renderWith(<HomeScreen />);
    expect(screen.getByTestId('home-access-until')).toHaveTextContent(
      '本次登录有效期至 10月4日 09:30，到期后需要新的口令',
    );
  });
});

describe('访客：「我有口令」与房间已经结束', () => {
  it('「我有口令」打开门禁页：已有访问可以取消；输入口令通过后重新载入（换成完整权限）', async () => {
    useAccessStore.setState({ status: GUEST });
    const reloads: (string | null)[] = [];
    renderWith(
      <>
        <HomeScreen />
        <AccessGateHost reload={(r) => reloads.push(r)} />
      </>,
    );
    expect(screen.getByTestId('home-guest-room')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('home-guest-passcode'));
    expect(useAccessStore.getState().required).toBe('manual');
    expect(screen.getByTestId('access-gate')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('access-cancel'));
    expect(screen.queryByTestId('access-gate')).toBeNull();
    // 再开一次，这次输入口令
    const P: AccessStatus = { ...BASE };
    setAccessFetch(
      async () =>
        new Response(JSON.stringify({ ok: true, data: P }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await userEvent.click(screen.getByTestId('home-guest-passcode'));
    await userEvent.type(screen.getByTestId('access-passcode'), 'secret');
    await userEvent.click(screen.getByTestId('access-submit'));
    await waitFor(() => expect(reloads).toEqual([null]));
    expect(useAccessStore.getState().status).toMatchObject({ kind: 'p' });
  });

  it('邀请的房间已经结束（roomOpen false）：不给「回到房间」，提示要新链接或输入口令', () => {
    useAccessStore.setState({ status: { ...GUEST, roomOpen: false } });
    renderWith(<HomeScreen />);
    expect(screen.getByTestId('home-guest-closed')).toHaveTextContent(
      '邀请你的房间已经结束；要继续玩，请向朋友要新的邀请链接，或输入口令',
    );
    expect(screen.queryByTestId('home-guest-note')).toBeNull();
    expect(screen.queryByTestId('home-guest-room')).toBeNull();
    expect(screen.getByTestId('home-guest-passcode')).toHaveTextContent('我有口令');
    expect(screen.queryByTestId('home-create')).toBeNull();
  });

  it('首页挂载时刷新状态：房间刚结束也能看出来', async () => {
    useAccessStore.setState({ status: GUEST });
    setAccessFetch(
      async () =>
        new Response(JSON.stringify({ ok: true, data: { ...GUEST, roomOpen: false } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    renderWith(<HomeScreen />);
    expect(await screen.findByTestId('home-guest-closed')).toBeInTheDocument();
    expect(screen.queryByTestId('home-guest-room')).toBeNull();
  });

  it('口令会话打开门禁页（例如设置里解锁素材）没有已通过的访问时不给取消', () => {
    useAccessStore.setState({ status: { ...BASE, granted: false, kind: null } });
    render(<AccessGateHost reload={() => {}} />);
    act(() => useAccessStore.getState().require('manual'));
    expect(screen.getByTestId('access-gate')).toBeInTheDocument();
    expect(screen.queryByTestId('access-cancel')).toBeNull();
  });
});

describe('房间页：访客打开别的房间', () => {
  it('服务器拒绝（ACCESS_SCOPE）：显示「只能加入邀请你的房间」，并给「回到房间」', async () => {
    useAccessStore.setState({ status: GUEST });
    const t = makeTestClient();
    t.transport.respond('room:join', () => fail('ACCESS_SCOPE', { room: '482913' }));
    const loc = memoryLocation({ path: '/r/111111', record: true });
    render(
      <ClientProvider client={t.client}>
        <Router hook={loc.hook}>
          <RoomScreen code="111111" />
        </Router>
      </ClientProvider>,
    );
    expect(await screen.findByTestId('room-error')).toHaveTextContent('你是通过邀请链接进入的，只能加入邀请你的房间');
    expect(screen.getByTestId('room-guest-passcode')).toHaveTextContent('我有口令');
    await userEvent.click(screen.getByTestId('room-guest-back'));
    expect(loc.history?.at(-1)).toBe('/r/482913');
  });

  it('邀请的房间已经结束：错误页只给「我有口令」，点了打开门禁页', async () => {
    useAccessStore.setState({ status: { ...GUEST, roomOpen: false } });
    const t = makeTestClient();
    t.transport.respond('room:join', () => fail('ACCESS_SCOPE', { room: '482913' }));
    render(
      <ClientProvider client={t.client}>
        <Router hook={memoryLocation({ path: '/r/111111' }).hook}>
          <RoomScreen code="111111" />
        </Router>
      </ClientProvider>,
    );
    await screen.findByTestId('room-error');
    expect(screen.queryByTestId('room-guest-back')).toBeNull();
    await userEvent.click(screen.getByTestId('room-guest-passcode'));
    expect(useAccessStore.getState().required).toBe('manual');
  });
});
