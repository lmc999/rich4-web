// 建房 / 改房间设置的表单草稿（design/client.md §5.5 CreateRoomForm）与 RoomSettingsPatch 的互转（纯函数，可单测）
import type { AiPreset, InitialFund, StartVehicle, Tenure, TimeLimitDays, WinMultiple } from '@rich4/shared/engine';
import { DEFAULT_INITIAL_FUND, QUICK_GAME_PRESET } from '@rich4/shared/engine';
import {
  DEFAULT_PACING,
  PACING_PROFILES,
  type PacingProfile,
  type RoomSettings,
  type RoomSettingsPatch,
  type TimerPreset,
} from '@rich4/shared/net';
import { noteApiStatus } from '../access/accessStore';

export interface SettingsDraft {
  mapId: string;
  initialFund: InitialFund;
  vehicle: StartVehicle;
  tenure: Tenure;
  timeLimitDays: TimeLimitDays;
  winMultiple: WinMultiple;
  minigames: 'play' | 'skip';
  rulePreset: 'program' | 'manual';
  timerPreset: TimerPreset;
  /** 演出节奏（original-skin.md U3）：原版完整播放原版动画，紧凑按紧凑预算；开局后不可改 */
  pacing: PacingProfile;
  allowSpectators: boolean;
  visibility: 'private' | 'public';
  /** 建房后给 1..aiCount 号座位补电脑（只在建房时生效） */
  aiCount: 0 | 1 | 2 | 3;
  aiPreset: AiPreset;
}

export const TIMER_PRESETS: readonly TimerPreset[] = ['fast', 'normal', 'slow', 'off'];
/** 演出节奏选项（默认原版在前） */
export const PACING_OPTIONS: readonly PacingProfile[] = PACING_PROFILES;

export function defaultDraft(mapId = 'taiwan'): SettingsDraft {
  return {
    mapId,
    initialFund: DEFAULT_INITIAL_FUND,
    vehicle: 'walk',
    tenure: 'unlimited',
    timeLimitDays: 0,
    winMultiple: 0,
    minigames: 'play',
    rulePreset: 'program',
    timerPreset: 'normal',
    pacing: DEFAULT_PACING,
    allowSpectators: true,
    visibility: 'private',
    aiCount: 0,
    aiPreset: 'character',
  };
}

/** 快速局：1 年、10 倍（architecture §5.3） */
export function applyQuickPreset(d: SettingsDraft): SettingsDraft {
  return { ...d, timeLimitDays: QUICK_GAME_PRESET.timeLimitDays, winMultiple: QUICK_GAME_PRESET.winMultiple };
}

export function draftFromSettings(s: RoomSettings): SettingsDraft {
  const g = s.game;
  return {
    mapId: g.mapId,
    initialFund: g.initialFund,
    vehicle: g.vehicle,
    tenure: g.tenure,
    timeLimitDays: g.timeLimitDays,
    winMultiple: g.winMultiple,
    minigames: g.minigames,
    rulePreset: g.rules.preset === 'manual' ? 'manual' : 'program',
    timerPreset: s.timerPreset,
    pacing: s.pacing ?? DEFAULT_PACING,
    allowSpectators: s.allowSpectators,
    visibility: s.visibility,
    aiCount: 0,
    aiPreset: 'character',
  };
}

export function draftToPatch(d: SettingsDraft): RoomSettingsPatch {
  return {
    visibility: d.visibility,
    allowSpectators: d.allowSpectators,
    timerPreset: d.timerPreset,
    pacing: d.pacing,
    game: {
      mapId: d.mapId,
      initialFund: d.initialFund,
      vehicle: d.vehicle,
      tenure: d.tenure,
      timeLimitDays: d.timeLimitDays,
      winMultiple: d.winMultiple,
      minigames: d.minigames,
      rules: { preset: d.rulePreset },
    },
  };
}

/** 服务器地图目录（GET /api/maps） */
export interface MapListingLite {
  id: string;
  mapHash: string;
  playable?: boolean;
  fixture?: boolean;
}

export async function fetchMapList(
  fetchImpl: (u: string) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }> = (u) => fetch(u),
): Promise<{ defaultMap: string; maps: MapListingLite[] }> {
  try {
    const r = await fetchImpl('/api/maps');
    if (r.status !== undefined) noteApiStatus(r.status);
    if (r.ok) {
      const j = (await r.json()) as { defaultMap?: string; maps?: MapListingLite[] };
      const maps = (j.maps ?? []).filter((m) => m.playable !== false);
      if (maps.length > 0) return { defaultMap: j.defaultMap ?? maps[0]!.id, maps };
    }
  } catch {
    // 服务器不可达：只列出 fixture
  }
  return {
    defaultMap: 'test',
    maps: [
      { id: 'test', mapHash: '', fixture: true },
      { id: 'test-allkinds', mapHash: '', fixture: true },
    ],
  };
}
