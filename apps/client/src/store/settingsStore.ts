// 本机设置（design/client.md §5.7、§10.1）：昵称、动画速度、音量、画质、镜头跟随、色弱、左手模式、皮肤。
// 音频（原版皮肤 A9，original-skin.md U1 默认项）：五路音量（主 / BGM / 音效 / 语音 / 界面音）、静音、角色语音开关（默认开）、
// 切到后台时静音（默认开）；audio/settingsBinding 读这些字段同步到 AudioEngine。
// zustand persist → localStorage 'rich4.settings'（不可用时退回内存，见 net/identity.safeStorage）。
// 皮肤（原版皮肤 A5）：auto = 有素材包且地图匹配时用原版；original / procedural 为强制。界面语言由实际皮肤决定
// （原版 → zh-TW，程序化 → zh-CN，见 skin/theme.ts），lang 字段只作记录。
import { NICKNAME_MAX, sanitizeNickname } from '@rich4/shared/net';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { defaultNickname, safeStorage } from '../net/identity';
import { SKIN_PREFS, type SkinPref } from '../skin/types';

export type AnimSpeed = 1 | 2 | 3;
export type QualitySetting = 'auto' | 'high' | 'mid' | 'low';

export interface Volume {
  master: number;
  bgm: number;
  sfx: number;
  voice: number;
  /** 界面音（按钮、倒计时） */
  ui: number;
}

export interface SettingsState {
  nickname: string;
  speed: AnimSpeed;
  volume: Volume;
  muted: boolean;
  /** 角色语音（含卡片、道具台词与新闻播报）；U1 默认开启 */
  voiceEnabled: boolean;
  /** 切到后台标签页时静音（挂起音频） */
  muteInBackground: boolean;
  quality: QualitySetting;
  autoFollow: boolean;
  colorBlind: boolean;
  leftHanded: boolean;
  /** 皮肤偏好（原版皮肤） */
  skin: SkinPref;
  lang: 'zh-CN';
  setNickname(n: string): void;
  setSpeed(s: AnimSpeed): void;
  setVolume(v: Partial<Volume>): void;
  setMuted(m: boolean): void;
  setVoiceEnabled(b: boolean): void;
  setMuteInBackground(b: boolean): void;
  setQuality(q: QualitySetting): void;
  setAutoFollow(b: boolean): void;
  setColorBlind(b: boolean): void;
  setLeftHanded(b: boolean): void;
  setSkin(s: SkinPref): void;
}

export const SETTINGS_KEY = 'rich4.settings';

/** client.md §7.1：主 80、BGM 60、音效 80、语音 70；界面音缺省同音效 */
export const DEFAULT_VOLUME: Volume = { master: 0.8, bgm: 0.6, sfx: 0.8, voice: 0.7, ui: 0.8 };

/** 持久化版本：v2 加入 volume.ui、voiceEnabled、muteInBackground */
export const SETTINGS_VERSION = 2;

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** 持久化里的皮肤值不认识时回到 auto */
export function normalizeSkinPref(x: unknown): SkinPref {
  return typeof x === 'string' && (SKIN_PREFS as readonly string[]).includes(x) ? (x as SkinPref) : 'auto';
}

/** 持久化里的音量：缺的路补上（界面音缺省跟随音效），非法值夹到 0..1 */
export function normalizeVolume(x: unknown, fallback: Volume = DEFAULT_VOLUME): Volume {
  const v = (typeof x === 'object' && x !== null ? x : {}) as Partial<Record<keyof Volume, unknown>>;
  const num = (y: unknown, d: number): number => (typeof y === 'number' ? clamp01(y) : d);
  const sfx = num(v.sfx, fallback.sfx);
  return {
    master: num(v.master, fallback.master),
    bgm: num(v.bgm, fallback.bgm),
    sfx,
    voice: num(v.voice, fallback.voice),
    ui: num(v.ui, sfx),
  };
}

/** v1 → v2：补 volume.ui（= 音效音量）、voiceEnabled = true、muteInBackground = true */
export function migrateSettings(persisted: unknown, version: number): unknown {
  const p = (typeof persisted === 'object' && persisted !== null ? persisted : {}) as Record<string, unknown>;
  if (version >= SETTINGS_VERSION) return p;
  return {
    ...p,
    volume: normalizeVolume(p.volume),
    voiceEnabled: typeof p.voiceEnabled === 'boolean' ? p.voiceEnabled : true,
    muteInBackground: typeof p.muteInBackground === 'boolean' ? p.muteInBackground : true,
  };
}

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
      voiceEnabled: true,
      muteInBackground: true,
      quality: 'auto',
      autoFollow: true,
      colorBlind: false,
      leftHanded: false,
      skin: 'auto',
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
            ui: clamp01(v.ui ?? s.volume.ui),
          },
        })),
      setMuted: (muted) => set({ muted }),
      setVoiceEnabled: (voiceEnabled) => set({ voiceEnabled }),
      setMuteInBackground: (muteInBackground) => set({ muteInBackground }),
      setQuality: (quality) => set({ quality }),
      setAutoFollow: (autoFollow) => set({ autoFollow }),
      setColorBlind: (colorBlind) => set({ colorBlind }),
      setLeftHanded: (leftHanded) => set({ leftHanded }),
      setSkin: (skin) => set({ skin: normalizeSkinPref(skin) }),
    }),
    {
      name: SETTINGS_KEY,
      version: SETTINGS_VERSION,
      storage: createJSONStorage(() => safeStorage()),
      migrate: (persisted, version) => migrateSettings(persisted, version) as SettingsState,
      partialize: (s) => ({
        nickname: s.nickname,
        speed: s.speed,
        volume: s.volume,
        muted: s.muted,
        voiceEnabled: s.voiceEnabled,
        muteInBackground: s.muteInBackground,
        quality: s.quality,
        autoFollow: s.autoFollow,
        colorBlind: s.colorBlind,
        leftHanded: s.leftHanded,
        skin: s.skin,
        lang: s.lang,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SettingsState>;
        return {
          ...current,
          ...p,
          volume: normalizeVolume(p.volume, current.volume),
          skin: normalizeSkinPref(p.skin ?? current.skin),
        };
      },
    },
  ),
);
