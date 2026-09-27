// 读档后的大厅（net.md §8.4；architecture M5）：存档横幅（非官方、兼容性提示）、座位「原：角色 / 昵称，待认领」、
// 认领、补电脑、开始条件、角色与对局设置锁定。
import type { CharacterId } from '@rich4/shared/engine';
import type { RoomView, SaveSummary, SeatView } from '@rich4/shared/net';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ClientProvider } from '../../app/services';
import { makeTestClient } from '../../test/fakeTransport';
import { ai, human, roomView, seat } from '../../test/roomFixtures';
import { LobbyView, unclaimedSeats } from './LobbyView';

function renderWith(ui: React.ReactElement) {
  const t = makeTestClient();
  const utils = render(<ClientProvider client={t.client}>{ui}</ClientProvider>);
  return { ...utils, ...t };
}

const saved = (
  s: SeatView,
  nickname: string,
  characterId: number,
  o: { wasHuman?: boolean; claimable?: boolean } = {},
): SeatView => ({
  ...s,
  characterId: characterId as CharacterId,
  savedSeat: {
    nickname,
    characterId: characterId as CharacterId,
    wasHuman: o.wasHuman ?? true,
    claimableByYou: o.claimable ?? false,
  },
});

function loadedRoom(over: Partial<RoomView> = {}): RoomView {
  return roomView({
    seats: [
      saved(human(0, '房主', { isYou: true, host: true }), '房主', 9),
      saved(seat(1), '小明', 4, { claimable: true }),
      saved(seat(2), '小红', 0),
      seat(3),
    ],
    loadedSave: {
      saveId: 'sv1',
      name: '周末那局',
      gameDay: 42,
      date: 20100211,
      verified: false,
      warnings: ['tablesHashMismatch'],
    },
    ...over,
  });
}

describe('读档后的大厅', () => {
  it('横幅：存档名、日期、天数；非官方与兼容性提示', () => {
    renderWith(<LobbyView room={loadedRoom()} onLeave={() => {}} />);
    const banner = screen.getByTestId('loaded-save');
    expect(banner).toHaveTextContent('已读取存档「周末那局」· 2010年2月11日 · 第 42 天');
    expect(screen.getByTestId('loaded-unofficial')).toHaveTextContent('非官方存档');
    expect(screen.getByTestId('loaded-warn-tablesHashMismatch')).toHaveTextContent('数据版本不同');
  });

  it('座位：显示「原：角色 / 昵称」，空的标「待认领」；不在存档里的座位不可用', () => {
    renderWith(<LobbyView room={loadedRoom()} onLeave={() => {}} />);
    expect(screen.getByTestId('seat-1-origin')).toHaveTextContent('原：阿土伯 / 小明');
    expect(screen.getByTestId('seat-1-unclaimed')).toHaveTextContent('待认领');
    expect(screen.getByTestId('seat-1')).toHaveAttribute('data-saved', 'unclaimed');
    expect(screen.getByTestId('seat-0')).toHaveAttribute('data-saved', 'claimed');
    expect(within(screen.getByTestId('seat-3')).getByText('未使用')).toBeInTheDocument();
    expect(screen.queryByTestId('seat-3-add-ai')).toBeNull();
    expect(screen.queryByTestId('seat-3-take')).toBeNull();
    // 读档后没有「坐这里」，只有认领
    expect(screen.queryByTestId('seat-1-take')).toBeNull();
  });

  it('房主：待认领座位可补电脑；有座位待认领时不能开始，并提示是哪几个', async () => {
    const { transport } = renderWith(<LobbyView room={loadedRoom()} onLeave={() => {}} />);
    expect(unclaimedSeats(loadedRoom())).toEqual([1, 2]);
    expect(screen.getByTestId('room-start')).toBeDisabled();
    expect(screen.getByTestId('start-hint')).toHaveTextContent('还有座位待认领（2P、3P）');
    await userEvent.click(screen.getByTestId('seat-2-add-ai'));
    expect(transport.payloads('room:setSeatAi')).toEqual([{ seat: 2, ai: { preset: 'character' } }]);
    // 角色与对局设置锁定
    expect(screen.queryByTestId('character-picker')).toBeNull();
    expect(screen.getByText('读档后角色按存档锁定。')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-edit')).toBeNull();
  });

  it('全部存档座位有人（真人认领或电脑）且真人准备后可以开始', async () => {
    const room = loadedRoom({
      seats: [
        saved(human(0, '房主', { isYou: true, host: true }), '房主', 9),
        saved(human(1, '小明', { ready: true }), '小明', 4),
        saved(ai(2), '小红', 0),
        seat(3),
      ],
    });
    const { transport } = renderWith(<LobbyView room={room} onLeave={() => {}} />);
    expect(screen.getByTestId('room-start')).toBeEnabled();
    await userEvent.click(screen.getByTestId('room-start'));
    expect(transport.payloads('room:start')).toHaveLength(1);
  });

  it('读档后电脑座位的预设只读：存档里是电脑的显示原预设，存档里是真人、由电脑代打的标「电脑代打」', async () => {
    const cunning = (s: SeatView): SeatView =>
      s.occupant?.kind === 'ai' ? { ...s, occupant: { ...s.occupant, ai: { preset: 'cunning' } } } : s;
    const room = loadedRoom({
      seats: [
        saved(human(0, '房主', { isYou: true, host: true }), '房主', 9),
        saved(ai(1), '小明', 4),
        saved(cunning(ai(2)), '电脑', 0, { wasHuman: false }),
        seat(3),
      ],
    });
    const { transport } = renderWith(<LobbyView room={room} onLeave={() => {}} />);
    // 没有可改的下拉框
    expect(screen.queryByTestId('seat-1-ai-preset')).toBeNull();
    expect(screen.queryByTestId('seat-2-ai-preset')).toBeNull();
    expect(screen.queryAllByRole('combobox', { name: '电脑个性' })).toEqual([]);
    expect(screen.getByTestId('seat-2-ai-saved')).toHaveTextContent('存档设定：大老奸 · 困难');
    expect(screen.getByTestId('seat-1-ai-saved')).toHaveTextContent('电脑代打');
    expect(screen.getByTestId('seat-2-origin')).toHaveTextContent('原：约翰乔 / 电脑');
    // 仍可移除电脑（让真人认领）
    await userEvent.click(screen.getByTestId('seat-2-remove-ai'));
    expect(transport.payloads('room:setSeatAi')).toEqual([{ seat: 2, ai: null }]);
  });

  it('没有读档时房主仍可改电脑预设', async () => {
    const room = roomView({ seats: [human(0, '房主', { isYou: true, host: true }), ai(1), seat(2), seat(3)] });
    const { transport } = renderWith(<LobbyView room={room} onLeave={() => {}} />);
    expect(screen.queryByTestId('seat-1-ai-saved')).toBeNull();
    await userEvent.selectOptions(screen.getByTestId('seat-1-ai-preset'), 'normal');
    expect(transport.payloads('room:setSeatAi')).toEqual([{ seat: 1, ai: { preset: 'normal' } }]);
  });

  it('观战者：可认领的座位（自己的存档座位）有认领按钮，发 room:claimSeat', async () => {
    const room = loadedRoom({ you: { role: 'spectator', id: 'sp', isHost: false } });
    const { transport } = renderWith(<LobbyView room={room} onLeave={() => {}} />);
    expect(screen.queryByTestId('seat-2-claim')).toBeNull();
    await userEvent.click(screen.getByTestId('seat-1-claim'));
    expect(transport.payloads('room:claimSeat')).toEqual([{ seat: 1 }]);
  });

  it('房主打开「读取存档」后列出服务器存档；读档成功后面板收起', async () => {
    const t = makeTestClient();
    t.transport.respond('saves:list', () => ({
      ok: true,
      data: {
        saves: [
          {
            saveId: 'a1',
            name: '上次那局',
            kind: 'manual',
            mapId: 'test',
            gameDay: 3,
            date: 20100103,
            seats: [],
            createdAt: 1,
            compatible: true,
            verified: true,
          } satisfies SaveSummary,
        ],
      },
    }));
    render(
      <ClientProvider client={t.client}>
        <LobbyView room={roomView()} onLeave={() => {}} />
      </ClientProvider>,
    );
    await userEvent.click(screen.getByTestId('lobby-saves-toggle'));
    await userEvent.click(await screen.findByTestId('save-load-a1'));
    expect(t.transport.payloads('room:loadSave')).toEqual([{ saveId: 'a1' }]);
    expect(screen.queryByTestId('save-load')).toBeNull();
  });
});
