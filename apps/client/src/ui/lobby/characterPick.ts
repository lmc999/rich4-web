// 选角的光标与提交（design/client.md §5.5；程序化 LobbyView / CharacterPicker 与原版 ClassicLobby 共用）。
// 选角界面上有两个「角色」：光标（预览、名字、侧视走动显示的那个）与已提交给服务器的座位 characterId。服务器开局时给
// characterId 为空的座位随机分配角色（Room.start），所以只移动了光标、没点「选这个」就按开始 / 准备，界面上看到的是
// 忍太郎，进局却随机成了金贝贝。这里的规则：开始 / 准备前先把光标上的角色提交（pendingPick），提交失败就不开始 / 不准备——
// 界面上看到的就是进局的角色；光标的缺省位置是已选的角色，否则第一个没被别人选走的角色（不会停在置灰的格子上）。
// 已准备的非房主玩家开局由房主发起，不会再替他提交光标：已准备时把光标移开已提交的角色（改主意）就先取消准备
// （unreadyOnMove），再按「准备」时照上面的规则提交新光标上的角色——「已准备 ⇒ 光标 = 进局的角色」始终成立。
// 本文件是纯函数（client-unit 可测）；React 钩子在 useCharacterPick.ts。
import { CHARACTER_IDS, type CharacterId } from '@rich4/shared/engine';
import type { RoomView } from '@rich4/shared/net';

/** 本人已提交的角色（不是玩家或没选时为 null） */
export function myCharacter(room: RoomView): CharacterId | null {
  if (room.you.role !== 'player') return null;
  const me = room.you.seat;
  return room.seats.find((s) => s.index === me)?.characterId ?? null;
}

/** 被别的座位选走的角色 → 座位号 */
export function takenCharacters(room: RoomView): Map<CharacterId, number> {
  const me = room.you.role === 'player' ? room.you.seat : null;
  const m = new Map<CharacterId, number>();
  for (const s of room.seats) if (s.characterId !== null && s.index !== me) m.set(s.characterId, s.index);
  return m;
}

/** 光标的缺省位置：已选的角色，否则第一个没被别人选走的角色（全被选走时 0 号） */
export function defaultCursor(room: RoomView): CharacterId {
  const mine = myCharacter(room);
  if (mine !== null) return mine;
  const taken = takenCharacters(room);
  return CHARACTER_IDS.find((c) => !taken.has(c)) ?? CHARACTER_IDS[0]!;
}

/**
 * 开始 / 准备前要替本人提交的角色：光标上的角色，且与已提交的不同、没被别人选走、不是读档房间（角色锁定）、本人是玩家；
 * 否则 null（不用提交：已经选好，或者光标停在被选走的角色上——这时保持原样，开局由服务器随机分配）
 */
export function pendingPick(room: RoomView, cursor: CharacterId): CharacterId | null {
  if (room.you.role !== 'player' || room.phase !== 'lobby' || room.loadedSave !== undefined) return null;
  if (cursor === myCharacter(room)) return null;
  return takenCharacters(room).has(cursor) ? null : cursor;
}

/**
 * 光标移到 next 时要不要先取消准备：本人是已准备的非房主玩家、大厅阶段、next 不是已提交的角色。
 * 房主不用（开始时自己提交光标上的角色）；移动同时就提交 next 的（原版画面单击没被选走的头像）由调用方跳过。
 */
export function unreadyOnMove(room: RoomView, next: CharacterId): boolean {
  if (room.you.role !== 'player' || room.you.isHost || room.phase !== 'lobby') return false;
  const me = room.you.seat;
  const occ = room.seats.find((s) => s.index === me)?.occupant;
  if (occ?.kind !== 'human' || !occ.ready) return false;
  return next !== myCharacter(room);
}
