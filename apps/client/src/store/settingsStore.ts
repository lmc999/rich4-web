// 本机设置（design/client.md §5.7、§10.1）：昵称、动画速度、音量、画质、镜头跟随、色弱、左手模式。
// zustand persist → localStorage 'rich4.settings'（不可用时退回内存，见 net/identity.safeStorage）。
import { NICKNAME_MAX, sanitizeNickname } from '@rich4/shared/net';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { defaultNickname, safeStorage } from '../net/identity';

export type AnimSpeed = 1 | 2 | 3;
export type QualitySetting = 'auto' | 'high' | 'mid' | 'low';

export interface Volume {
  master: number;
  bgm: number;
  sfx: number;
  voice: number;
}

export interface SettingsState {
  nickname: string;
  speed: AnimSpeed;
  volume: Volume;
  muted: boolean;
  quality: QualitySetting;
  autoFollow: boolean;
  colorBlind: boolean;
  leftHanded: boolean;
  lang: 'zh-CN';
  setNickname(n: string): void;
  setSpeed(s: AnimSpeed): void;
  setVolume(v: Partial<Volume>): void;
  setMuted(m: boolean): void;
  setQuality(q: QualitySetting): void;
  setAutoFollow(b: boolean): void;
  setColorBlind(b: boolean): void;
  setLeftHanded(b: boolean): void;
}

export const SETTINGS_KEY = 'rich4.settings';

export const DEFAULT_VOLUME: Volume = { master: 0.8, bgm: 0.6, sfx: 0.8, voice: 0.7 };

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** 清洗昵称；清洗后为空则返回 null */
export function normalizeNickname(raw: string): string | null {
  const s = sanitizeNickname(raw).slice(0, NICKNAME_MAX * 2);
  return s.length > 0 ? s : null;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      nickname: defaultNickname(),
      speed: 1,
      volume: { ...DEFAULT_VOLUME },
      muted: false,
      quality: 'auto',
      autoFollow: true,
      colorBlind: false,
      leftHanded: false,
      lang: 'zh-CN',
      setNickname: (n) => {
        const v = normalizeNickname(n);
        if (v) set({ nickname: v });
      },
      setSpeed: (speed) => set({ speed }),
      setVolume: (v) =>
        set((s) => ({
          volume: {
            master: clamp01(v.master ?? s.volume.master),
            bgm: clamp01(v.bgm ?? s.volume.bgm),
            sfx: clamp01(v.sfx ?? s.volume.sfx),
            voice: clamp01(v.voice ?? s.volume.voice),
          },
        })),
      setMuted: (muted) => set({ muted }),
      setQuality: (quality) => set({ quality }),
      setAutoFollow: (autoFollow) => set({ autoFollow }),
      setColorBlind: (colorBlind) => set({ colorBlind }),
      setLeftHanded: (leftHanded) => set({ leftHanded }),
    }),
    {
      name: SETTINGS_KEY,
      version: 1,
      storage: createJSONStorage(() => safeStorage()),
      partialize: (s) => ({
        nickname: s.nickname,
        speed: s.speed,
        volume: s.volume,
        muted: s.muted,
        quality: s.quality,
        autoFollow: s.autoFollow,
        colorBlind: s.colorBlind,
        leftHanded: s.leftHanded,
        lang: s.lang,
      }),
    },
  ),
);
