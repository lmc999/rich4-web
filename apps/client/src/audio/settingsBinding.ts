// 设置 → 引擎混音（store/settingsStore 由 A5 维护；这里只读取，不写）。
// 现有字段：volume.{master,bgm,sfx,voice}、muted。以下可选字段由整合方按报告里的补丁加入后自动生效：
//   volume.ui（界面音，缺省跟随 sfx）· voiceEnabled（角色语音开关，缺省 true）· muteInBackground（后台静音，缺省 true）。
import type { AudioMix } from './types';

export interface AudioSettingsLike {
  volume: { master: number; bgm: number; sfx: number; voice: number; ui?: number };
  muted: boolean;
  voiceEnabled?: boolean;
  muteInBackground?: boolean;
}

export interface SettingsStoreLike<S extends AudioSettingsLike = AudioSettingsLike> {
  getState(): S;
  subscribe(listener: (state: S, prev: S) => void): () => void;
}

export function mixFromSettings(s: AudioSettingsLike): AudioMix {
  const v = s.volume;
  return {
    master: v.master,
    bgm: v.bgm,
    sfx: v.sfx,
    voice: v.voice,
    ui: v.ui ?? v.sfx,
    muted: s.muted,
    voiceEnabled: s.voiceEnabled ?? true,
  };
}

function sameMix(a: AudioMix, b: AudioMix): boolean {
  return (
    a.master === b.master &&
    a.bgm === b.bgm &&
    a.sfx === b.sfx &&
    a.voice === b.voice &&
    a.ui === b.ui &&
    a.muted === b.muted &&
    a.voiceEnabled === b.voiceEnabled
  );
}

/** 把设置同步到引擎（立即应用一次）；返回退订函数 */
export function bindAudioSettings(
  engine: { setMix(m: Partial<AudioMix>): void },
  store: SettingsStoreLike,
  onBackgroundPolicy?: (muteInBackground: boolean) => void,
): () => void {
  let last = mixFromSettings(store.getState());
  let bg = store.getState().muteInBackground ?? true;
  engine.setMix(last);
  onBackgroundPolicy?.(bg);
  return store.subscribe((s) => {
    const m = mixFromSettings(s);
    if (!sameMix(m, last)) {
      last = m;
      engine.setMix(m);
    }
    const b = s.muteInBackground ?? true;
    if (b !== bg) {
      bg = b;
      onBackgroundPolicy?.(b);
    }
  });
}
