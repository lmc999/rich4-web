// 测试用 RoomView 构造
import { defaultGameConfig, type SeatIndex } from '@rich4/shared/engine';
import { defaultRoomSettings, type RoomView, type SeatView } from '@rich4/shared/net';

export function seat(index: SeatIndex, over: Partial<SeatView> = {}): SeatView {
  return { index, occupant: null, characterId: null, control: 'human', isHost: false, ...over };
}

export function human(
  index: SeatIndex,
  nickname: string,
  o: { ready?: boolean; connected?: boolean; isYou?: boolean; host?: boolean; character?: number | null } = {},
): SeatView {
  return seat(index, {
    occupant: {
      kind: 'human',
      nickname,
      connected: o.connected ?? true,
      ready: o.ready ?? false,
      isYou: o.isYou ?? false,
    },
    isHost: o.host ?? false,
    characterId: (o.character ?? null) as SeatView['characterId'],
  });
}

export function ai(index: SeatIndex, character: number | null = null): SeatView {
  return seat(index, {
    occupant: { kind: 'ai', ai: { preset: 'character' }, name: `AI${index + 1}` },
    control: 'ai',
    characterId: character as SeatView['characterId'],
  });
}

export function roomView(over: Partial<RoomView> = {}): RoomView {
  return {
    code: '123456',
    inviteUrl: 'http://localhost:3000/r/123456',
    phase: 'lobby',
    epoch: 0,
    seats: [human(0, '房主', { isYou: true, host: true }), seat(1), seat(2), seat(3)],
    spectators: [],
    settings: defaultRoomSettings(defaultGameConfig('test')),
    you: { role: 'player', seat: 0, isHost: true },
    serverNow: 0,
    ...over,
  };
}
