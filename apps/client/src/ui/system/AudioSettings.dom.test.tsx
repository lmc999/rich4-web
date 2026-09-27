// 音频设置表单：各路音量独立、静音禁用滑杆、可选开关按回调出现；接 settingsStore 的版本写回 store。
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOLUME, useSettingsStore } from '../../store/settingsStore';
import { AudioSettings, AudioSettingsFields } from './AudioSettings';

describe('AudioSettingsFields', () => {
  it('四路音量滑杆；ui 有值时多一路；静音时禁用', () => {
    const onVolume = vi.fn();
    const onMuted = vi.fn();
    const { rerender } = render(
      <AudioSettingsFields
        value={{ volume: { master: 0.8, bgm: 0.6, sfx: 0.8, voice: 0.7 }, muted: false }}
        onVolume={onVolume}
        onMuted={onMuted}
      />,
    );
    expect(screen.getByTestId('settings-volume')).toHaveValue('80');
    expect(screen.getByTestId('settings-volume-bgm')).toHaveValue('60');
    expect(screen.getByTestId('settings-volume-voice')).toHaveValue('70');
    expect(screen.queryByTestId('settings-volume-ui')).toBeNull();
    expect(screen.queryByTestId('settings-voice-enabled')).toBeNull();
    fireEvent.change(screen.getByTestId('settings-volume-sfx'), { target: { value: '25' } });
    expect(onVolume).toHaveBeenCalledWith('sfx', 0.25);
    fireEvent.click(screen.getByTestId('settings-muted'));
    expect(onMuted).toHaveBeenCalledWith(true);
    const onVoice = vi.fn();
    rerender(
      <AudioSettingsFields
        value={{ volume: { master: 0.8, bgm: 0.6, sfx: 0.8, voice: 0.7, ui: 0.5 }, muted: true, voiceEnabled: false }}
        onVolume={onVolume}
        onMuted={onMuted}
        onVoiceEnabled={onVoice}
      />,
    );
    expect(screen.getByTestId('settings-volume-ui')).toHaveValue('50');
    expect(screen.getByTestId('settings-volume')).toBeDisabled();
    expect(screen.getByTestId('settings-voice-enabled')).not.toBeChecked();
    fireEvent.click(screen.getByTestId('settings-voice-enabled'));
    expect(onVoice).toHaveBeenCalledWith(true);
  });
});

describe('AudioSettings（接 settingsStore）', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      volume: { ...DEFAULT_VOLUME },
      muted: false,
      voiceEnabled: true,
      muteInBackground: true,
    });
  });

  it('改音量与静音写回 store', () => {
    render(<AudioSettings />);
    fireEvent.change(screen.getByTestId('settings-volume-voice'), { target: { value: '30' } });
    expect(useSettingsStore.getState().volume.voice).toBeCloseTo(0.3);
    expect(useSettingsStore.getState().volume.bgm).toBeCloseTo(DEFAULT_VOLUME.bgm);
    fireEvent.click(screen.getByTestId('settings-muted'));
    expect(useSettingsStore.getState().muted).toBe(true);
  });

  it('界面音、角色语音开关与后台静音写回 store', () => {
    render(<AudioSettings />);
    fireEvent.change(screen.getByTestId('settings-volume-ui'), { target: { value: '40' } });
    expect(useSettingsStore.getState().volume.ui).toBeCloseTo(0.4);
    expect(screen.getByTestId('settings-voice-enabled')).toBeChecked();
    fireEvent.click(screen.getByTestId('settings-voice-enabled'));
    expect(useSettingsStore.getState().voiceEnabled).toBe(false);
    expect(screen.getByTestId('settings-volume-voice')).toBeDisabled();
    fireEvent.click(screen.getByTestId('settings-mute-background'));
    expect(useSettingsStore.getState().muteInBackground).toBe(false);
  });
});
