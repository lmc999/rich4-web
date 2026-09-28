// 选角光标与提交的纯函数（client-unit），以及「角色号 → 各处素材键」的映射表。
// 回归：线上反馈「选的是忍太郎，头像却是金贝贝」——根因是只移动了光标（预览、名字、走动都换成忍太郎）没提交就按 OK，
// 服务器给没选角色的座位随机分配；各处的角色号 → 素材键映射本身是对的，这里一并锁住，免得以后混用格子序号、座位号与角色号。

import { characterDef } from '@rich4/shared/data';
import { CHARACTER_IDS, CHARACTER_KEYS, type CharacterId, type SeatIndex } from '@rich4/shared/engine';
import type { RoomView } from '@rich4/shared/net';
import { describe, expect, it } from 'vitest';
import { characterPose, PLAIN_POSE } from '../../game/orig/poses';
import { parachuteUse } from '../../game/orig/stage/flicPlan';
import { characterByKey } from '../../game/procedural/character/defs';
import zhCN from '../../i18n/locales/zh-CN/characters.original.json';
import zhTW from '../../i18n/locales/zh-TW/characters.original.json';
import { xicongCharKey } from '../../minigames/orig/keys';
import { ai, human, roomView, seat } from '../../test/roomFixtures';
import { speakerSheet } from '../classic/common/SpeakerBubble';
import { FACE_SHEET as DIALOG_FACE_SHEET } from '../classic/dialogs/parts';
import { FACE_SHEET as POPUP_FACE_SHEET } from '../classic/popups/layout';
import { FACE_SHEET, GRID, gridCell, sidewalkKey } from '../classic/screens/layout';
import { chibiSheet } from '../classic/venues/b/auctionLayout';
import { defaultCursor, myCharacter, pendingPick, takenCharacters, unreadyOnMove } from './characterPick';

const NAMES_CN = [
  '约翰乔',
  '沙隆巴斯',
  '忍太郎',
  '钱夫人',
  '阿土伯',
  '莎拉公主',
  '宫本宝藏',
  '糖糖',
  '乌咪',
  '孙小美',
  '小丹尼',
  '金贝贝',
];
const NAMES_TW = [
  '約翰喬',
  '沙隆巴斯',
  '忍太郎',
  '錢夫人',
  '阿土伯',
  '莎拉公主',
  '宮本寶藏',
  '糖糖',
  '烏咪',
  '孫小美',
  '小丹尼',
  '金貝貝',
];

function room(seats: RoomView['seats'], you: RoomView['you'] = { role: 'player', seat: 0, isHost: true }): RoomView {
  return roomView({ seats, you });
}

describe('选角：光标与提交', () => {
  const host = (character: number | null = null) => human(0, '房主', { host: true, isYou: true, character });

  it('myCharacter / takenCharacters：本人的角色与被别的座位选走的角色（→ 座位号）', () => {
    const r = room([host(2), human(1, 'B', { character: 11 }), ai(2, 4), seat(3)]);
    expect(myCharacter(r)).toBe(2);
    expect([...takenCharacters(r)]).toEqual([
      [11, 1],
      [4, 2],
    ]);
    const watcher = room(r.seats, { role: 'spectator', id: 'w1', isHost: false });
    expect(myCharacter(watcher)).toBeNull();
    expect([...takenCharacters(watcher).keys()]).toEqual([2, 11, 4]);
  });

  it('defaultCursor：已选的角色；没选时第一个没被别人选走的角色', () => {
    expect(defaultCursor(room([host(7), seat(1), seat(2), seat(3)]))).toBe(7);
    expect(defaultCursor(room([host(), seat(1), seat(2), seat(3)]))).toBe(0);
    expect(defaultCursor(room([host(), human(1, 'B', { character: 0 }), ai(2, 1), seat(3)]))).toBe(2);
  });

  it('pendingPick：光标上的角色没提交、没被选走时要先提交；已选好 / 被选走 / 读档 / 观战 / 已开局时不提交', () => {
    const r = room([host(), human(1, 'B', { character: 11 }), ai(2), seat(3)]);
    expect(pendingPick(r, 2)).toBe(2);
    expect(pendingPick(r, 11)).toBeNull();
    const chosen = room([host(2), human(1, 'B', { character: 11 }), ai(2), seat(3)]);
    expect(pendingPick(chosen, 2)).toBeNull();
    expect(pendingPick(chosen, 5)).toBe(5);
    expect(pendingPick({ ...r, you: { role: 'spectator', id: 'w1', isHost: false } }, 2)).toBeNull();
    expect(pendingPick({ ...r, phase: 'playing' }, 2)).toBeNull();
    const loaded: RoomView = {
      ...r,
      loadedSave: { saveId: 's', name: 'n', gameDay: 1, date: 19980101, verified: true },
    };
    expect(pendingPick(loaded, 2)).toBeNull();
    // 非房主（2 号座位）同样按自己的座位判断
    const guest = room([host(0), human(1, 'B'), human(2, '我', { isYou: true }), seat(3)], {
      role: 'player',
      seat: 2 as SeatIndex,
      isHost: false,
    });
    expect(pendingPick(guest, 0)).toBeNull();
    expect(pendingPick(guest, 3)).toBe(3);
  });

  it('unreadyOnMove：已准备的非房主把光标移开已提交的角色（改主意）要先取消准备；房主 / 没准备 / 移回已选的 / 观战 / 已开局不用', () => {
    const guestYou = { role: 'player', seat: 1 as SeatIndex, isHost: false } as const;
    const ready = room(
      [host(0), human(1, '我', { isYou: true, ready: true, character: 11 }), ai(2), seat(3)],
      guestYou,
    );
    expect(unreadyOnMove(ready, 2)).toBe(true);
    // 移到被别人选走的角色上看预览：同样取消（预览已不是进局的角色）
    expect(unreadyOnMove(ready, 0)).toBe(true);
    expect(unreadyOnMove(ready, 11)).toBe(false);
    // 已准备但还没选（光标停在被选走的角色上时准备的，开局随机）：移到任何角色都取消
    const readyNoPick = room([host(0), human(1, '我', { isYou: true, ready: true }), ai(2), seat(3)], guestYou);
    expect(unreadyOnMove(readyNoPick, 5)).toBe(true);
    const notReady = room([host(0), human(1, '我', { isYou: true, character: 11 }), ai(2), seat(3)], guestYou);
    expect(unreadyOnMove(notReady, 2)).toBe(false);
    // 房主（开始时自己提交光标上的角色），即使 ready 标记残留（换房主）也不用
    const hostReady = room([
      human(0, '房主', { host: true, isYou: true, ready: true, character: 0 }),
      seat(1),
      seat(2),
      seat(3),
    ]);
    expect(unreadyOnMove(hostReady, 2)).toBe(false);
    expect(unreadyOnMove({ ...ready, you: { role: 'spectator', id: 'w1', isHost: false } }, 2)).toBe(false);
    expect(unreadyOnMove({ ...ready, phase: 'playing' }, 2)).toBe(false);
  });
});

describe('角色号 → 各处素材键（映射表）', () => {
  it('12 个角色：名字、数据表、纸娃娃按同一个 CHARACTER_KEYS', () => {
    expect(CHARACTER_IDS).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    for (const c of CHARACTER_IDS) {
      const key = CHARACTER_KEYS[c];
      expect((zhCN as Record<string, { name: string }>)[key]!.name).toBe(NAMES_CN[c]);
      expect((zhTW as Record<string, { name: string }>)[key]!.name).toBe(NAMES_TW[c]);
      expect(characterDef(c).id).toBe(c);
      expect(characterDef(c).key).toBe(key);
      expect(characterByKey(key).key).toBe(key);
    }
  });

  it('选人头像格：格 c = 角色 c（6 列 × 2 行，行主序，间距 72），格里画 portrait.face72 的帧 c', () => {
    expect(FACE_SHEET).toBe('portrait.face72');
    expect(DIALOG_FACE_SHEET).toBe(FACE_SHEET);
    expect(POPUP_FACE_SHEET).toBe(FACE_SHEET);
    for (const c of CHARACTER_IDS) {
      const r = gridCell(c);
      expect(r).toEqual({ x: GRID.x + 4 + 72 * (c % 6), y: GRID.y + 5 + 72 * Math.floor(c / 6), w: 72, h: 72 });
    }
    // 第一行：约翰乔…莎拉公主；第二行：宫本宝藏…金贝贝（与原版 jump#4 图0 的 6×2 格一致）
    expect(gridCell(2)).toEqual({ x: 152, y: 326, w: 72, h: 72 });
    expect(gridCell(11)).toEqual({ x: 368, y: 398, w: 72, h: 72 });
  });

  it('每一种按角色取的素材键都带同一个角色号', () => {
    for (const c of CHARACTER_IDS as readonly CharacterId[]) {
      expect(speakerSheet(c)).toBe(`portrait.speaker.${c}`);
      for (const v of ['walk', 'moto', 'car'] as const) expect(sidewalkKey(c, v)).toBe(`title.sidewalk.${c}.${v}`);
      expect(chibiSheet(c)).toBe(`venue.chibi.${c}.1`);
      expect(xicongCharKey(c)).toBe(`mg.xicong.char.${c}`);
      expect(parachuteUse(c)).toBe(`char.parachuteBoard.${c}`);
      for (const mode of ['stand', 'walk', 'dice'] as const) {
        for (const k of characterPose(c, mode, PLAIN_POSE).keys) expect(k.startsWith(`char.${c}.`)).toBe(true);
        for (const vehicle of ['moto', 'car'] as const) {
          const keys = characterPose(c, mode, { ...PLAIN_POSE, vehicle }).keys;
          for (const k of keys) expect(k.startsWith(`char.${c}.`)).toBe(true);
        }
      }
    }
  });
});
