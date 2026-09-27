// 音频设置（original-skin.md U1：角色语音默认开启、各路音量独立调节；client.md §7.1 默认 主 80 / BGM 60 / 音效 80 / 语音 70）。
// AudioSettingsFields 是纯表现层；AudioSettings 接 settingsStore（五路音量、静音、角色语音开关、后台静音）。
// 文案键缺失时显示 defaultValue。
import type { ReactNode } from 'react';
import { useTx } from '../../i18n/tx';
import { useSettingsStore } from '../../store/settingsStore';
import c from '../common/common.module.css';
import sy from './system.module.css';

export type AudioVolumeKey = 'master' | 'bgm' | 'sfx' | 'voice' | 'ui';

export interface AudioSettingsValue {
  volume: { master: number; bgm: number; sfx: number; voice: number; ui?: number };
  muted: boolean;
  voiceEnabled?: boolean;
  muteInBackground?: boolean;
}

export interface AudioSettingsFieldsProps {
  value: AudioSettingsValue;
  onVolume(key: AudioVolumeKey, v: number): void;
  onMuted(m: boolean): void;
  /** 不提供时不显示对应开关 */
  onVoiceEnabled?(on: boolean): void;
  onMuteInBackground?(on: boolean): void;
}

const LABELS: Readonly<Record<AudioVolumeKey, string>> = {
  master: '主音量',
  bgm: '背景音乐',
  sfx: '音效',
  voice: '角色语音',
  ui: '界面音',
};

/** 主音量沿用旧 testid（settings-volume），其余为 settings-volume-<总线> */
const testId = (k: AudioVolumeKey) => (k === 'master' ? 'settings-volume' : `settings-volume-${k}`);

export function AudioSettingsFields({
  value,
  onVolume,
  onMuted,
  onVoiceEnabled,
  onMuteInBackground,
}: AudioSettingsFieldsProps): ReactNode {
  const t = useTx();
  const keys: AudioVolumeKey[] = ['master', 'bgm', 'sfx', 'voice'];
  if (value.volume.ui !== undefined) keys.push('ui');
  const voiceOn = value.voiceEnabled ?? true;
  return (
    <fieldset className={`${sy.group} ${sy.groupColumn}`} data-testid="audio-settings">
      <legend>{t('hud:settings.audio.title', { defaultValue: '声音' })}</legend>
      <label className={sy.check}>
        <input
          type="checkbox"
          checked={value.muted}
          onChange={(e) => onMuted(e.target.checked)}
          data-testid="settings-muted"
        />
        <span>{t('hud:settings.muted', { defaultValue: '静音' })}</span>
      </label>
      {onVoiceEnabled && (
        <label className={sy.check}>
          <input
            type="checkbox"
            checked={voiceOn}
            onChange={(e) => onVoiceEnabled(e.target.checked)}
            data-testid="settings-voice-enabled"
          />
          <span>
            {t('hud:settings.audio.voiceEnabled', { defaultValue: '角色语音（含卡片、道具台词与新闻播报）' })}
          </span>
        </label>
      )}
      {keys.map((k) => {
        const label = t(`hud:settings.audio.${k}`, { defaultValue: LABELS[k] });
        return (
          <label key={k} className={c.field}>
            <span>{label}</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round((value.volume[k] ?? 0) * 100)}
              disabled={value.muted || (k === 'voice' && !voiceOn)}
              onChange={(e) => onVolume(k, Number(e.target.value) / 100)}
              aria-label={label}
              data-testid={testId(k)}
            />
          </label>
        );
      })}
      {onMuteInBackground && (
        <label className={sy.check}>
          <input
            type="checkbox"
            checked={value.muteInBackground ?? true}
            onChange={(e) => onMuteInBackground(e.target.checked)}
            data-testid="settings-mute-background"
          />
          <span>{t('hud:settings.audio.muteInBackground', { defaultValue: '切到后台时静音' })}</span>
        </label>
      )}
    </fieldset>
  );
}

/** 接 settingsStore 的音频设置 */
export function AudioSettings(): ReactNode {
  const st = useSettingsStore();
  return (
    <AudioSettingsFields
      value={{
        volume: st.volume,
        muted: st.muted,
        voiceEnabled: st.voiceEnabled,
        muteInBackground: st.muteInBackground,
      }}
      onVolume={(k, v) => st.setVolume({ [k]: v })}
      onMuted={(m) => st.setMuted(m)}
      onVoiceEnabled={(on) => st.setVoiceEnabled(on)}
      onMuteInBackground={(on) => st.setMuteInBackground(on)}
    />
  );
}
