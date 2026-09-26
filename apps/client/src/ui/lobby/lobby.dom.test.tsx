// 大厅与房间组件（design/client.md §5.5、§12.1 dom）：座位、补电脑、准备 / 开始、选角、邀请链接、建房表单、聊天
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientProvider } from '../../app/services';
import { useChatStore } from '../../store/chatStore';
import { makeTestClient } from '../../test/fakeTransport';
import { ai, human, roomView, seat } from '../../test/roomFixtures';
import { ChatPanel } from '../social/ChatPanel';
import { CreateRoomForm } from './CreateRoomForm';
import { LobbyView } from './LobbyView';

function renderWith(ui: React.ReactElement) {
  const t = makeTestClient();
  const utils = render(<ClientProvider client={t.client}>{ui}</ClientProvider>);
  return { ...utils, ...t };
}

afterEach(() => {
  useChatStore.getState().clear();
});

describe('LobbyView', () => {
  it('房主：空座位可补电脑、电脑可换预设与移除、真人可踢；未满足条件时开始按钮禁用', async () => {
    const room = roomView({
      seats: [human(0, '房主', { host: true, isYou: true }), human(1, '小明'), ai(2), seat(3)],
    });
    const { transport } = renderWith(<LobbyView room={room} onLeave={() => {}} />);
    expect(screen.getByTestId('room-start')).toBeDisabled(); // 小明没准备
    await userEvent.click(screen.getByTestId('seat-3-add-ai'));
    expect(transport.payloads('room:setSeatAi')).toEqual([{ seat: 3, ai: { preset: 'character' } }]);
    await userEvent.selectOptions(screen.getByTestId('seat-2-ai-preset'), 'cunning');
    expect(transport.payloads('room:setSeatAi')[1]).toEqual({ seat: 2, ai: { preset: 'cunning' } });
    await userEvent.click(screen.getByTestId('seat-2-remove-ai'));
    expect(transport.payloads('room:setSeatAi')[2]).toEqual({ seat: 2, ai: null });
    await userEvent.click(screen.getByTestId('seat-1-kick'));
    expect(transport.payloads('room:kick')).toEqual([{ target: { seat: 1 } }]);
    expect(within(screen.getByTestId('seat-1')).getByText('小明')).toBeInTheDocument();
    expect(screen.queryByTestId('room-ready')).toBeNull(); // 房主不需要准备
  });

  it('全员准备后可以开始；开始发 room:start', async () => {
    const room = roomView({
      seats: [human(0, 'A', { host: true, isYou: true }), human(1, 'B', { ready: true }), seat(2), seat(3)],
    });
    const { transport } = renderWith(<LobbyView room={room} onLeave={() => {}} />);
    await userEvent.click(screen.getByTestId('room-start'));
    expect(transport.payloads('room:start')).toHaveLength(1);
  });

  it('非房主：准备 / 取消准备；没有补电脑与踢人按钮', async () => {
    const room = roomView({
      seats: [human(0, 'A', { host: true }), human(1, '我', { isYou: true }), seat(2), seat(3)],
      you: { role: 'player', seat: 1, isHost: false },
    });
    const { transport, rerender, client } = renderWith(<LobbyView room={room} onLeave={() => {}} />);
    expect(screen.queryByTestId('seat-2-add-ai')).toBeNull();
    expect(screen.queryByTestId('seat-0-kick')).toBeNull();
    await userEvent.click(screen.getByTestId('room-ready'));
    expect(transport.payloads('room:setReady')).toEqual([{ ready: true }]);
    const ready = {
      ...room,
      seats: [room.seats[0], human(1, '我', { isYou: true, ready: true }), room.seats[2], room.seats[3]],
    } as typeof room;
    rerender(
      <ClientProvider client={client}>
        <LobbyView room={ready} onLeave={() => {}} />
      </ClientProvider>,
    );
    expect(screen.getByTestId('room-ready')).toHaveTextContent('取消准备');
    expect(screen.getByTestId('seat-1-ready')).toBeInTheDocument();
  });

  it('选角：被他人占用的置灰不可选；选择发 room:selectCharacter', async () => {
    const room = roomView({
      seats: [human(0, 'A', { host: true, isYou: true }), human(1, 'B', { character: 9 }), seat(2), seat(3)],
    });
    const { transport } = renderWith(<LobbyView room={room} onLeave={() => {}} />);
    expect(screen.getByTestId('char-9')).toHaveAttribute('data-taken', 'true');
    await userEvent.click(screen.getByTestId('char-9'));
    expect(screen.getByTestId('char-select')).toBeDisabled();
    expect(screen.getByTestId('char-select')).toHaveTextContent('已被 2P 选走');
    await userEvent.click(screen.getByTestId('char-4'));
    expect(screen.getByTestId('char-preview-name')).toHaveTextContent('阿土伯');
    await userEvent.click(screen.getByTestId('char-select'));
    expect(transport.payloads('room:selectCharacter')).toEqual([{ characterId: 4 }]);
    await userEvent.click(screen.getByTestId('char-next'));
    expect(screen.getByTestId('char-preview-name')).toHaveTextContent('莎拉公主');
  });

  it('邀请链接用当前页面 origin 拼出；二维码按需生成', async () => {
    renderWith(<LobbyView room={roomView({ code: '482913' })} onLeave={() => {}} />);
    expect(screen.getByTestId('room-code')).toHaveTextContent('482913');
    expect(screen.getByTestId('invite-url')).toHaveValue(`${location.origin}/r/482913`);
    await userEvent.click(screen.getByTestId('invite-qr-toggle'));
    const img = await screen.findByTestId('invite-qr');
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
  });
});

describe('CreateRoomForm', () => {
  it('提交 room:create（带全部设置），再给 1..N 号座位补电脑，回调房间号', async () => {
    const onCreated = vi.fn();
    const { transport } = renderWith(<CreateRoomForm onCreated={onCreated} />);
    await waitFor(() => expect(screen.getByTestId('set-map')).toHaveValue('test'));
    await userEvent.selectOptions(screen.getByTestId('set-fund'), '100000');
    await userEvent.selectOptions(screen.getByTestId('set-vehicle'), 'car');
    await userEvent.selectOptions(screen.getByTestId('set-timer'), 'fast');
    await userEvent.selectOptions(screen.getByTestId('set-visibility'), 'public');
    await userEvent.click(screen.getByTestId('set-spectators'));
    await userEvent.selectOptions(screen.getByTestId('set-ai-count'), '2');
    await userEvent.selectOptions(screen.getByTestId('set-ai-preset'), 'gentle');
    await userEvent.click(screen.getByTestId('create-quick'));
    await userEvent.click(screen.getByTestId('create-submit'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('123456'));
    expect(transport.payloads('room:create')[0]).toEqual({
      settings: {
        visibility: 'public',
        allowSpectators: false,
        timerPreset: 'fast',
        game: {
          mapId: 'test',
          initialFund: 100000,
          vehicle: 'car',
          tenure: 'unlimited',
          timeLimitDays: 365,
          winMultiple: 10,
          minigames: 'play',
          rules: { preset: 'program' },
        },
      },
    });
    expect(transport.payloads('room:setSeatAi')).toEqual([
      { seat: 1, ai: { preset: 'gentle' } },
      { seat: 2, ai: { preset: 'gentle' } },
    ]);
  });
});

describe('ChatPanel', () => {
  it('发送聊天；系统消息本地化（含 internalError）；客户端限速每 10 秒 5 条', async () => {
    const room = roomView();
    const { transport } = renderWith(<ChatPanel room={room} />);
    act(() => {
      useChatStore.getState().setHistory([
        { id: 's1', ts: 1, from: { kind: 'system' }, system: { key: 'internalError', params: {} }, audience: 'all' },
        {
          id: 's2',
          ts: 2,
          from: { kind: 'system' },
          system: { key: 'autopilotOn', params: { nickname: '小明', seat: 1, reason: 'afk' } },
          audience: 'all',
        },
        {
          id: 's3',
          ts: 3,
          from: { kind: 'system' },
          system: { key: 'timeoutDefault', params: { seat: 2 } },
          audience: 'all',
        },
      ]);
    });
    const msgs = screen.getAllByTestId('chat-msg').map((m) => m.textContent);
    expect(msgs).toEqual([
      '对局内部错误，房间已暂停，请房主稍后继续',
      '小明 进入托管（连续超时）',
      '3P 超时，已由电脑代为决定',
    ]);
    for (let i = 0; i < 6; i++) {
      await userEvent.type(screen.getByTestId('chat-input'), `你好${i}`);
      await userEvent.click(screen.getByTestId('chat-send'));
    }
    expect(transport.payloads('chat:send').map((p) => p.text)).toEqual(['你好0', '你好1', '你好2', '你好3', '你好4']);
  });

  it('表情面板发 chat:emote', async () => {
    const { transport } = renderWith(<ChatPanel room={roomView()} />);
    await userEvent.click(screen.getByTestId('emote-open'));
    await userEvent.click(screen.getByTestId('emote-laugh'));
    expect(transport.payloads('chat:emote')).toEqual([{ emoteId: 'laugh' }]);
  });
});
