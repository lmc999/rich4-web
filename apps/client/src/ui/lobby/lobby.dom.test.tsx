// 大厅与房间组件（design/client.md §5.5、§12.1 dom）：座位、补电脑、准备 / 开始、选角、邀请链接、建房表单、聊天
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientProvider } from '../../app/services';
import { useChatStore } from '../../store/chatStore';
import { canStart } from '../../store/roomStore';
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
    await waitFor(() => expect(transport.payloads('room:start')).toHaveLength(1));
  });

  // 回归（线上反馈「选的是忍太郎，头像却是金贝贝」）：光标上的角色没提交就开始 / 准备时，先提交再开始 / 准备
  it('只移动光标（▶ 翻到忍太郎）不点「选择」就开始：先发 selectCharacter(2) 再发 room:start', async () => {
    const room = roomView({
      seats: [human(0, 'A', { host: true, isYou: true }), human(1, 'B', { ready: true }), seat(2), seat(3)],
    });
    const { transport } = renderWith(<LobbyView room={room} onLeave={() => {}} />);
    expect(screen.getByTestId('char-preview-name')).toHaveTextContent('约翰乔');
    await userEvent.click(screen.getByTestId('char-next'));
    await userEvent.click(screen.getByTestId('char-next'));
    expect(screen.getByTestId('char-preview-name')).toHaveTextContent('忍太郎');
    await userEvent.click(screen.getByTestId('room-start'));
    await waitFor(() => expect(transport.payloads('room:start')).toHaveLength(1));
    expect(
      transport.sent.map((r) => r.event).filter((e) => e === 'room:selectCharacter' || e === 'room:start'),
    ).toEqual(['room:selectCharacter', 'room:start']);
    expect(transport.payloads('room:selectCharacter')).toEqual([{ characterId: 2 }]);
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
    await waitFor(() => expect(transport.payloads('room:setReady')).toEqual([{ ready: true }]));
    // 准备前先提交了光标上的角色（缺省第一个没被选走的：约翰乔）
    expect(transport.payloads('room:selectCharacter')).toEqual([{ characterId: 0 }]);
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

  // 回归（复审）：已准备的非房主再移动光标，预览换成新角色，但开局由房主发起、不会替他提交光标——进局仍是旧角色。
  // 现在移开已提交的角色就先取消准备（房主开不了局），再按准备时提交新光标上的角色。
  it('非房主已准备后单击别的头像（改主意）：先取消准备；房主开不了局；再按准备先提交新角色', async () => {
    const guestYou = { role: 'player', seat: 1, isHost: false } as const;
    const readyRoom = roomView({
      seats: [
        human(0, 'A', { host: true }),
        human(1, '我', { isYou: true, ready: true, character: 11 }),
        seat(2),
        seat(3),
      ],
      you: guestYou,
    });
    const { transport, rerender, client } = renderWith(<LobbyView room={readyRoom} onLeave={() => {}} />);
    expect(screen.getByTestId('char-preview-name')).toHaveTextContent('金贝贝');
    expect(screen.getByTestId('room-ready')).toHaveTextContent('取消准备');
    // 光标还在已提交的角色上：不取消
    await userEvent.click(screen.getByTestId('char-11'));
    expect(transport.payloads('room:setReady')).toEqual([]);
    await userEvent.click(screen.getByTestId('char-2'));
    expect(screen.getByTestId('char-preview-name')).toHaveTextContent('忍太郎');
    await waitFor(() => expect(transport.payloads('room:setReady')).toEqual([{ ready: false }]));
    expect(transport.payloads('room:selectCharacter')).toEqual([]);
    // 服务器广播：取消准备 → 房主那边开始按钮不可用（canStart 要求其他真人都已准备）
    const unready = roomView({
      ...readyRoom,
      seats: [readyRoom.seats[0]!, human(1, '我', { isYou: true, character: 11 }), seat(2), seat(3)],
    });
    expect(canStart({ ...unready, you: { role: 'player', seat: 0, isHost: true } })).toBe(false);
    rerender(
      <ClientProvider client={client}>
        <LobbyView room={unready} onLeave={() => {}} />
      </ClientProvider>,
    );
    // 光标留在忍太郎上；再按准备：先提交忍太郎再准备
    expect(screen.getByTestId('char-preview-name')).toHaveTextContent('忍太郎');
    await userEvent.click(screen.getByTestId('room-ready'));
    await waitFor(() => expect(transport.payloads('room:setReady')).toEqual([{ ready: false }, { ready: true }]));
    expect(transport.payloads('room:selectCharacter')).toEqual([{ characterId: 2 }]);
    expect(
      transport.sent.map((r) => r.event).filter((e) => e === 'room:selectCharacter' || e === 'room:setReady'),
    ).toEqual(['room:setReady', 'room:selectCharacter', 'room:setReady']);
  });

  it('非房主已准备后 ▶ 翻看同样先取消准备；房主移动光标不发取消准备', async () => {
    const readyRoom = roomView({
      seats: [
        human(0, 'A', { host: true }),
        human(1, '我', { isYou: true, ready: true, character: 4 }),
        seat(2),
        seat(3),
      ],
      you: { role: 'player', seat: 1, isHost: false },
    });
    const a = renderWith(<LobbyView room={readyRoom} onLeave={() => {}} />);
    await userEvent.click(screen.getByTestId('char-next'));
    expect(screen.getByTestId('char-preview-name')).toHaveTextContent('莎拉公主');
    await waitFor(() => expect(a.transport.payloads('room:setReady')).toEqual([{ ready: false }]));
    a.unmount();
    const b = renderWith(
      <LobbyView
        room={roomView({
          seats: [human(0, '房主', { host: true, isYou: true, character: 4 }), seat(1), seat(2), seat(3)],
        })}
        onLeave={() => {}}
      />,
    );
    await userEvent.click(screen.getByTestId('char-next'));
    await userEvent.click(screen.getByTestId('char-7'));
    expect(b.transport.payloads('room:setReady')).toEqual([]);
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
  it('缺省地图取服务器地图目录的 defaultMap（不写死台湾）；手选过就不再覆盖', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({
        defaultMap: 'japan',
        maps: [
          { id: 'taiwan', mapHash: 'a', playable: true },
          { id: 'japan', mapHash: 'b', playable: true },
        ],
      }),
    );
    try {
      const { transport } = renderWith(<CreateRoomForm onCreated={() => {}} />);
      await waitFor(() => expect(screen.getByTestId('set-map')).toHaveValue('japan'));
      await userEvent.selectOptions(screen.getByTestId('set-map'), 'taiwan');
      await userEvent.click(screen.getByTestId('create-submit'));
      await waitFor(() => expect(transport.payloads('room:create')).toHaveLength(1));
      expect(transport.payloads('room:create')[0]).toMatchObject({ settings: { game: { mapId: 'taiwan' } } });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('提交 room:create（带全部设置），再给 1..N 号座位补电脑，回调房间号', async () => {
    const onCreated = vi.fn();
    const { transport } = renderWith(<CreateRoomForm onCreated={onCreated} />);
    await waitFor(() => expect(screen.getByTestId('set-map')).toHaveValue('test'));
    await userEvent.selectOptions(screen.getByTestId('set-fund'), '100000');
    await userEvent.selectOptions(screen.getByTestId('set-vehicle'), 'car');
    await userEvent.selectOptions(screen.getByTestId('set-timer'), 'fast');
    // 计时档位下的一行小字：只有一名真人时不计时（服务器按有效计时档位判定）
    expect(screen.getByTestId('set-timer-hint')).toHaveTextContent('只有一名真人时不计时');
    expect(screen.getByTestId('set-pacing')).toHaveValue('original');
    await userEvent.selectOptions(screen.getByTestId('set-pacing'), 'compact');
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
        pacing: 'compact',
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

describe('手牌说明（真人 ≥ 2 时他人看不到本人的手牌与道具，net.md §6.1）', () => {
  it('两名真人：说明为「他人无法查看自己手牌及道具」并高亮；只有一名真人时说明适用条件', () => {
    const two = roomView({
      seats: [human(0, '房主', { isYou: true, host: true }), human(1, '小明'), seat(2), seat(3)],
    });
    const r = renderWith(<LobbyView room={two} onLeave={() => {}} />);
    const hint = within(screen.getByTestId('room-settings')).getByTestId('room-hand-hint');
    expect(hint).toHaveTextContent('他人无法查看自己手牌及道具');
    expect(hint).not.toHaveTextContent('两名以上');
    expect(hint).toHaveAttribute('data-active', 'true');
    r.unmount();
    renderWith(<LobbyView room={roomView()} onLeave={() => {}} />);
    expect(screen.getByTestId('room-hand-hint')).toHaveTextContent('两名以上真人时，他人无法查看自己手牌及道具');
    expect(screen.getByTestId('room-hand-hint')).toHaveAttribute('data-active', 'false');
  });

  it('房间已锁定私密（例如对局后回到大厅只剩一名真人）：照样显示「他人无法查看自己手牌及道具」', () => {
    const base = roomView();
    renderWith(
      <LobbyView room={roomView({ settings: { ...base.settings, handVisibility: 'private' } })} onLeave={() => {}} />,
    );
    expect(screen.getByTestId('room-hand-hint')).toHaveAttribute('data-active', 'true');
  });
});

describe('计时说明（只有一名真人时不计时，net.md §5.4）', () => {
  it('服务器下发的有效档位为 off、而设置不是 off（现在只有一名真人）：说明高亮；设置本身照常显示', () => {
    const room = roomView({ effectiveTimerPreset: 'off' });
    renderWith(<LobbyView room={room} onLeave={() => {}} />);
    const box = screen.getByTestId('room-settings');
    expect(within(box).getByText('决策计时').nextSibling).toHaveTextContent('普通');
    expect(within(box).getByTestId('room-timer-hint')).toHaveAttribute('data-active', 'true');
  });

  it('此刻适用时文字本身换成「现在只有一名真人：开局后不计时」（不只靠颜色，读屏也听得出）；两名真人时是规则说明', () => {
    const solo = renderWith(<LobbyView room={roomView({ effectiveTimerPreset: 'off' })} onLeave={() => {}} />);
    expect(screen.getByTestId('room-timer-hint')).toHaveTextContent('现在只有一名真人：开局后不计时');
    solo.unmount();
    const two = roomView({
      seats: [human(0, '房主', { isYou: true, host: true }), human(1, '小明'), seat(2), seat(3)],
      effectiveTimerPreset: 'normal',
    });
    renderWith(<LobbyView room={two} onLeave={() => {}} />);
    const hint = screen.getByTestId('room-timer-hint');
    expect(hint).toHaveTextContent('只有一名真人时不计时');
    expect(hint).not.toHaveTextContent('现在');
    expect(hint).toHaveAttribute('data-active', 'false');
  });

  it('房主改设置：房间档位是 off、只有一名真人，草稿改成有时限时说明换成「现在只有一名真人…」', async () => {
    const base = roomView();
    const room = roomView({ settings: { ...base.settings, timerPreset: 'off' }, effectiveTimerPreset: 'off' });
    renderWith(<LobbyView room={room} onLeave={() => {}} />);
    // 房间档位本来就是不限时：不提示
    expect(screen.getByTestId('room-timer-hint')).toHaveTextContent('只有一名真人时不计时');
    expect(screen.getByTestId('room-timer-hint')).toHaveAttribute('data-active', 'false');
    await userEvent.click(screen.getByTestId('settings-edit'));
    expect(screen.getByTestId('set-timer-hint')).toHaveAttribute('data-active', 'false');
    await userEvent.selectOptions(screen.getByTestId('set-timer'), 'fast');
    expect(screen.getByTestId('set-timer-hint')).toHaveTextContent('现在只有一名真人：开局后不计时');
    expect(screen.getByTestId('set-timer-hint')).toHaveAttribute('data-active', 'true');
  });

  it('建房：电脑补满其余三个座位时说明换成「现在只有一名真人：开局后不计时」；计时选「不限时」时不提示', async () => {
    renderWith(<CreateRoomForm onCreated={() => {}} />);
    const hint = (): HTMLElement => screen.getByTestId('set-timer-hint');
    expect(hint()).toHaveTextContent('只有一名真人时不计时');
    expect(hint()).toHaveAttribute('data-active', 'false');
    await userEvent.selectOptions(screen.getByTestId('set-ai-count'), '2');
    expect(hint()).toHaveAttribute('data-active', 'false');
    await userEvent.selectOptions(screen.getByTestId('set-ai-count'), '3');
    expect(hint()).toHaveTextContent('现在只有一名真人：开局后不计时');
    expect(hint()).toHaveAttribute('data-active', 'true');
    await userEvent.selectOptions(screen.getByTestId('set-timer'), 'off');
    expect(hint()).toHaveTextContent('只有一名真人时不计时');
    expect(hint()).toHaveAttribute('data-active', 'false');
  });
});

describe('演出节奏（original-skin.md U3）', () => {
  it('建房默认「原版」；选项为 原版 / 紧凑', async () => {
    const { transport } = renderWith(<CreateRoomForm onCreated={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('set-map')).toHaveValue('test'));
    const sel = screen.getByTestId('set-pacing');
    expect(sel).toHaveValue('original');
    expect(
      within(sel)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['原版', '紧凑']);
    await userEvent.click(screen.getByTestId('create-submit'));
    await waitFor(() => expect(transport.payloads('room:create')).toHaveLength(1));
    expect(transport.payloads('room:create')[0]).toMatchObject({ settings: { pacing: 'original' } });
  });

  it('房间设置显示当前节奏；房主可改为紧凑并提交 room:updateSettings', async () => {
    const base = roomView();
    const room = { ...base, settings: { ...base.settings, pacing: 'original' as const } };
    const { transport } = renderWith(<LobbyView room={room} onLeave={() => {}} />);
    const box = screen.getByTestId('room-settings');
    expect(within(box).getByText('演出节奏').nextSibling).toHaveTextContent('原版');
    expect(within(box).getByTestId('room-timer-hint')).toHaveTextContent('只有一名真人时不计时');
    expect(within(box).getByTestId('room-timer-hint')).toHaveAttribute('data-active', 'false');
    await userEvent.click(screen.getByTestId('settings-edit'));
    expect(within(box).getByTestId('set-timer-hint')).toHaveTextContent('只有一名真人时不计时');
    await userEvent.selectOptions(screen.getByTestId('set-pacing'), 'compact');
    await userEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() => expect(transport.payloads('room:updateSettings')).toHaveLength(1));
    expect(transport.payloads('room:updateSettings')[0]).toMatchObject({ patch: { pacing: 'compact' } });
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
