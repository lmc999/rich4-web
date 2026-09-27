// 聊天、表情、观战栏（design/client.md §5.6、§12.1 dom）：限长、限速、频道、屏蔽、快捷语、表情流水与头顶气泡总线、跟随切换
import type { ChatMessage, EmoteMsg, RoomView } from '@rich4/shared/net';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientProvider } from '../../app/services';
import { useChatStore } from '../../store/chatStore';
import { useUiStore } from '../../store/uiStore';
import { makeTestClient } from '../../test/fakeTransport';
import { ai, human, roomView } from '../../test/roomFixtures';
import { ChatPanel, clampChatInput } from './ChatPanel';
import { SpectatorList } from './SpectatorList';
import { EMOTE_BUBBLE_MS, type HeadBubble, onHeadBubble, useSocialStore } from './socialStore';

function renderWith(ui: React.ReactElement) {
  const t = makeTestClient();
  const utils = render(<ClientProvider client={t.client}>{ui}</ClientProvider>);
  return { ...utils, ...t };
}

let ts = 1000;
function text(id: string, from: ChatMessage['from'], body: string, audience: ChatMessage['audience'] = 'all') {
  return { id, ts: ts++, from, text: body, audience } satisfies ChatMessage;
}
function emote(id: string, from: EmoteMsg['from'], emoteId: string): EmoteMsg {
  return { id, ts: ts++, from, emoteId };
}

const P2 = { kind: 'seat', seat: 1, nickname: '小明' } as const;
const SPEC = { kind: 'spectator', id: 'sp1', nickname: '路人甲' } as const;

const spectatorRoom = (over: Partial<RoomView['settings']> = {}): RoomView => {
  const base = roomView({
    phase: 'playing',
    seats: [human(0, '房主', { host: true }), human(1, '小明'), ai(2), ai(3)],
    spectators: [{ id: 'sp1', nickname: '路人甲' }],
    you: { role: 'spectator', id: 'sp1', isHost: false },
  });
  return { ...base, settings: { ...base.settings, ...over } };
};

beforeEach(() => {
  ts = 1000;
});

afterEach(() => {
  vi.restoreAllMocks();
  useChatStore.getState().clear();
  useSocialStore.getState().reset();
  useUiStore.getState().clear();
});

describe('ChatPanel 限长与限速', () => {
  it('输入按码点截到 200 字（emoji 算 1 个），计数器显示 n/200；发送的正文不超过 200 字', async () => {
    expect(Array.from(clampChatInput('😀'.repeat(201)))).toHaveLength(200);
    expect(clampChatInput('abc')).toBe('abc');
    const { transport } = renderWith(<ChatPanel room={roomView()} />);
    const input = screen.getByTestId('chat-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '长'.repeat(205) } });
    expect(Array.from(input.value)).toHaveLength(200);
    expect(screen.getByTestId('chat-count')).toHaveTextContent('200/200');
    expect(screen.getByTestId('chat-count')).toHaveAttribute('data-value', '200');
    await userEvent.click(screen.getByTestId('chat-send'));
    const sent = transport.payloads('chat:send');
    expect(sent).toHaveLength(1);
    expect(Array.from(sent[0]!.text)).toHaveLength(200);
    expect(input.value).toBe('');
    // 只有空白：不发
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByTestId('chat-send')).toBeDisabled();
  });

  it('每 10 秒最多 5 条：第 6 条被拦下（提示且保留输入），10 秒后又能发；快捷语同样计数', async () => {
    let now = 50_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { transport } = renderWith(<ChatPanel room={roomView()} />);
    const input = screen.getByTestId('chat-input') as HTMLInputElement;
    for (let i = 0; i < 4; i++) {
      fireEvent.change(input, { target: { value: `第${i}条` } });
      await userEvent.click(screen.getByTestId('chat-send'));
    }
    await userEvent.click(screen.getByTestId('chat-quick-open'));
    await userEvent.click(screen.getByTestId('chat-quick-2'));
    expect(transport.payloads('chat:send').map((p) => p.text)).toEqual([
      '第0条',
      '第1条',
      '第2条',
      '第3条',
      '我要破产了',
    ]);
    fireEvent.change(input, { target: { value: '第六条' } });
    await userEvent.click(screen.getByTestId('chat-send'));
    expect(transport.payloads('chat:send')).toHaveLength(5);
    expect(input.value).toBe('第六条');
    expect(useUiStore.getState().toasts.at(-1)?.text).toBe('说话太快了，稍等一下');
    now += 10_001;
    await userEvent.click(screen.getByTestId('chat-send'));
    expect(transport.payloads('chat:send').at(-1)?.text).toBe('第六条');
    expect(input.value).toBe('');
  });

  it('限速窗口跨面板重挂载保留（关掉聊天坞再打开也不能绕过）', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(80_000);
    const { transport, unmount } = renderWith(<ChatPanel room={roomView()} />);
    for (let i = 0; i < 5; i++) {
      fireEvent.change(screen.getByTestId('chat-input'), { target: { value: `m${i}` } });
      await userEvent.click(screen.getByTestId('chat-send'));
    }
    unmount();
    renderWith(<ChatPanel room={roomView()} />);
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'again' } });
    await userEvent.click(screen.getByTestId('chat-send'));
    expect(transport.payloads('chat:send')).toHaveLength(5);
  });
});

describe('ChatPanel 频道、屏蔽、表情', () => {
  it('观战页签只显示观战者的发言与表情；观战者看到发送范围提示', async () => {
    renderWith(<ChatPanel room={spectatorRoom({ spectatorChat: 'spectators' })} />);
    act(() => {
      useChatStore
        .getState()
        .setHistory([
          text('m1', P2, '玩家说话'),
          text('m2', SPEC, '观众对所有人'),
          text('m3', SPEC, '观众悄悄话', 'spectators'),
        ]);
      useChatStore.getState().emote(emote('e1', SPEC, 'cool'));
      useChatStore.getState().emote(emote('e2', P2, 'laugh'));
    });
    const list = screen.getByTestId('chat-list');
    expect(
      within(list)
        .getAllByTestId('chat-msg')
        .map((x) => x.textContent),
    ).toEqual([
      expect.stringContaining('玩家说话'),
      expect.stringContaining('观众对所有人'),
      expect.stringContaining('观众悄悄话'),
    ]);
    expect(within(list).getAllByTestId('chat-emote')).toHaveLength(2);
    expect(screen.getByTestId('chat-audience')).toHaveTextContent('你的消息只有观战者可见');
    await userEvent.click(screen.getByTestId('chat-tab-spectators'));
    expect(screen.getByTestId('chat-tab-spectators')).toHaveAttribute('aria-selected', 'true');
    const msgs = within(screen.getByTestId('chat-list')).getAllByTestId('chat-msg');
    expect(msgs.map((x) => x.textContent)).toEqual([
      expect.stringContaining('观众对所有人'),
      expect.stringContaining('观众悄悄话'),
    ]);
    expect(msgs[1]).toHaveAttribute('data-audience', 'spectators');
    const emotes = within(screen.getByTestId('chat-list')).getAllByTestId('chat-emote');
    expect(emotes.map((x) => x.getAttribute('data-emote'))).toEqual(['cool']);
  });

  it('观战者聊天关闭时输入框与表情禁用', () => {
    renderWith(<ChatPanel room={spectatorRoom({ spectatorChat: 'off' })} />);
    expect(screen.getByTestId('chat-input')).toBeDisabled();
    expect(screen.getByTestId('emote-open')).toBeDisabled();
    expect(screen.getByTestId('chat-quick-open')).toBeDisabled();
  });

  it('屏蔽某人：他的消息与表情不再显示，也不再弹头顶气泡；取消屏蔽后恢复', async () => {
    const bubbles: HeadBubble[] = [];
    const off = onHeadBubble((b) => bubbles.push(b));
    try {
      renderWith(<ChatPanel room={roomView()} />);
      act(() => {
        useChatStore.getState().setHistory([text('m1', P2, '我是小明'), text('m2', SPEC, '我是路人')]);
        useChatStore.getState().emote(emote('e1', P2, 'laugh'));
      });
      expect(bubbles.map((b) => [b.seat, b.kind, b.emoteId, b.glyph, b.durationMs])).toEqual([
        [1, 'emote', 'laugh', '😂', EMOTE_BUBBLE_MS],
      ]);
      // 自己的消息没有屏蔽按钮；小明的消息有
      const line = screen.getByText('我是小明').closest('li')!;
      await userEvent.click(within(line).getByTestId('chat-mute'));
      expect(screen.queryByText('我是小明')).toBeNull();
      expect(screen.queryAllByTestId('chat-emote')).toHaveLength(0);
      expect(screen.getByText('我是路人')).toBeInTheDocument();
      expect(screen.getByTestId('chat-muted')).toHaveTextContent('已屏蔽 1 人');
      // 被屏蔽的人再发表情：不进流水、不发气泡
      act(() => useChatStore.getState().emote(emote('e2', P2, 'cry')));
      expect(bubbles).toHaveLength(1);
      expect(useSocialStore.getState().emotes.map((e) => e.id)).toEqual(['e1']);
      // 取消屏蔽
      await userEvent.click(within(screen.getByTestId('chat-muted')).getByRole('button', { expanded: false }));
      await userEvent.click(screen.getByTestId('chat-unmute-seat:1'));
      expect(screen.getByText('我是小明')).toBeInTheDocument();
      expect(screen.queryByTestId('chat-muted')).toBeNull();
    } finally {
      off();
    }
  });

  it('自己的消息没有屏蔽按钮；换房间（chatStore 清空）时屏蔽名单与表情流水一并清空', () => {
    renderWith(<ChatPanel room={roomView()} />);
    act(() => {
      useChatStore.getState().setHistory([text('m1', { kind: 'seat', seat: 0, nickname: '房主' }, '我自己')]);
      useSocialStore.getState().mute('seat:1', '小明');
      useChatStore.getState().emote(emote('e1', SPEC, 'cool'));
    });
    const line = screen.getByText('我自己').closest('li')!;
    expect(within(line).queryByTestId('chat-mute')).toBeNull();
    expect(useSocialStore.getState().emotes).toHaveLength(1);
    act(() => useChatStore.getState().clear());
    expect(useSocialStore.getState().muted).toEqual({});
    expect(useSocialStore.getState().emotes).toEqual([]);
  });

  it('座位上的聊天也发头顶气泡（3 秒），到时从 socialStore 移除', () => {
    vi.useFakeTimers();
    try {
      const got: HeadBubble[] = [];
      const off = onHeadBubble((b) => got.push(b));
      act(() => useChatStore.getState().add(text('m9', P2, '冲鸭')));
      expect(got.map((b) => [b.seat, b.kind, b.text, b.durationMs])).toEqual([[1, 'chat', '冲鸭', 3000]]);
      expect(useSocialStore.getState().bubbles[1]?.id).toBe('m9');
      act(() => {
        vi.advanceTimersByTime(3001);
      });
      expect(useSocialStore.getState().bubbles[1]).toBeUndefined();
      off();
    } finally {
      vi.useRealTimers();
    }
  });

  it('表情面板：发 chat:emote 后收起；Esc 关闭；冷却 1.5 秒内再发被拦下', async () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { transport } = renderWith(<ChatPanel room={roomView()} />);
    await userEvent.click(screen.getByTestId('emote-open'));
    expect(screen.getAllByRole('menuitem')).toHaveLength(16);
    await userEvent.click(screen.getByTestId('emote-money'));
    expect(screen.queryByTestId('emote-picker')).toBeNull();
    await userEvent.click(screen.getByTestId('emote-open'));
    await userEvent.click(screen.getByTestId('emote-clap'));
    expect(transport.payloads('chat:emote')).toEqual([{ emoteId: 'money' }]);
    now += 1600;
    await userEvent.click(screen.getByTestId('emote-open'));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('emote-picker')).toBeNull();
    await userEvent.click(screen.getByTestId('emote-open'));
    await userEvent.click(screen.getByTestId('emote-clap'));
    expect(transport.payloads('chat:emote')).toEqual([{ emoteId: 'money' }, { emoteId: 'clap' }]);
  });
});

describe('SpectatorList', () => {
  it('人数、名单；对局中可切换跟随的玩家（写 uiStore.followSeat）', async () => {
    renderWith(<SpectatorList room={spectatorRoom()} />);
    expect(screen.getByTestId('spectator-count')).toHaveTextContent('1');
    expect(screen.getByTestId('spectator-sp1')).toHaveTextContent('路人甲');
    expect(screen.getByTestId('spectator-sp1')).toHaveTextContent('你');
    const sel = screen.getByTestId('follow-select');
    expect(
      within(sel)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['自动（当前行动者）', '1P 房主', '2P 小明', '3P AI3', '4P AI4']);
    await userEvent.selectOptions(sel, '1');
    expect(useUiStore.getState().followSeat).toBe(1);
    await userEvent.selectOptions(sel, 'auto');
    expect(useUiStore.getState().followSeat).toBeNull();
    // 观战者不是房主：没有请出与设置
    expect(screen.queryByTestId('spectator-kick-sp1')).toBeNull();
    expect(screen.queryByTestId('spectator-chat-mode')).toBeNull();
  });

  it('房主：请出观战者、开关观战、设置观战者聊天范围；大厅里没有跟随切换', async () => {
    const room = roomView({ spectators: [{ id: 'sp9', nickname: '看客' }] });
    const { transport } = renderWith(<SpectatorList room={room} />);
    expect(screen.queryByTestId('follow-select')).toBeNull();
    await userEvent.click(screen.getByTestId('spectator-kick-sp9'));
    expect(transport.payloads('room:kick')).toEqual([{ target: { spectatorId: 'sp9' } }]);
    await userEvent.selectOptions(screen.getByTestId('spectator-chat-mode'), 'spectators');
    await userEvent.click(screen.getByTestId('spectators-allow'));
    expect(transport.payloads('room:updateSettings')).toEqual([
      { patch: { spectatorChat: 'spectators' } },
      { patch: { allowSpectators: false } },
    ]);
  });
});
