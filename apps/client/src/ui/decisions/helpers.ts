// 对话框共用的小工具（只读 view，不实现规则）
import type { FacilityType, LotId, LotLevel, SeatIndex } from '@rich4/shared/engine';
import type { GameView, PlayerView } from '@rich4/shared/view';

export function playerOf(view: GameView, seat: SeatIndex): PlayerView | null {
  return view.players.find((p) => p.seat === seat) ?? null;
}

export interface LotStatus {
  owner: SeatIndex | null;
  level: LotLevel;
  /** 设施类型（住宅为 null） */
  facility: FacilityType | null;
  chain: boolean;
  mark: 'raise' | 'seal' | null;
}

/** 地块的当前归属与等级（企业返回 null） */
export function lotStatus(view: GameView, lot: LotId): LotStatus | null {
  const land = view.lands.find((l) => l.id === lot);
  if (land) {
    return { owner: land.owner, level: land.level, facility: null, chain: land.chain, mark: land.mark?.kind ?? null };
  }
  const f = view.facilities.find((x) => x.id === lot);
  if (f) return { owner: f.owner, level: f.level, facility: f.type, chain: false, mark: f.mark?.kind ?? null };
  return null;
}

/** 设施类型的图标（展示用） */
export const FACILITY_ICON: Readonly<Record<FacilityType, string>> = {
  park: '\u{1F333}',
  hotel: '\u{1F3E8}',
  mall: '\u{1F6CD}️',
  gas: '⛽',
  lab: '\u{1F52C}',
};
