// 设置（design/client.md §5.7）：昵称（大厅）、动画速度、镜头跟随、音量、画质、色弱、左手模式；存 localStorage。
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTx } from '../../i18n/tx';
import { type AnimSpeed, type QualitySetting, useSettingsStore } from '../../store/settingsStore';
import c from '../common/common.module.css';
import { Modal } from '../components/Modal';
import sy from './system.module.css';

export function SettingsDialog({
  open,
  onOpenChange,
  inGame,
}: {
  open: boolean;
  onOpenChange(o: boolean): void;
  inGame: boolean;
}): ReactNode {
  const t = useTx();
  const st = useSettingsStore();
  const [nick, setNick] = useState(st.nickname);
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('hud:settings.title')} testId="settings-dialog" width={420}>
      <div className={sy.form}>
        {!inGame && (
          <label className={c.field}>
            <span>{t('hud:settings.nickname')}</span>
            <input
              className="input"
              value={nick}
              maxLength={24}
              onChange={(e) => setNick(e.target.value)}
              onBlur={() => st.setNickname(nick)}
              data-testid="settings-nickname"
            />
          </label>
        )}
        <fieldset className={sy.group}>
          <legend>{t('hud:settings.speed')}</legend>
          {([1, 2, 3] as AnimSpeed[]).map((s) => (
            <label key={s} className={sy.radio}>
              <input
                type="radio"
                name="speed"
                checked={st.speed === s}
                onChange={() => st.setSpeed(s)}
                data-testid={`settings-speed-${s}`}
              />
              <span className="num">{s}x</span>
            </label>
          ))}
        </fieldset>
        <label className={sy.check}>
          <input
            type="checkbox"
            checked={st.autoFollow}
            onChange={(e) => st.setAutoFollow(e.target.checked)}
            data-testid="settings-follow"
          />
          <span>{t('hud:settings.autoFollow')}</span>
        </label>
        <label className={sy.check}>
          <input
            type="checkbox"
            checked={st.muted}
            onChange={(e) => st.setMuted(e.target.checked)}
            data-testid="settings-muted"
          />
          <span>{t('hud:settings.muted')}</span>
        </label>
        <label className={c.field}>
          <span>{t('hud:settings.volume')}</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(st.volume.master * 100)}
            onChange={(e) => st.setVolume({ master: Number(e.target.value) / 100 })}
            data-testid="settings-volume"
          />
        </label>
        <label className={c.field}>
          <span>{t('hud:settings.quality')}</span>
          <select
            className="select"
            value={st.quality}
            onChange={(e) => st.setQuality(e.target.value as QualitySetting)}
            data-testid="settings-quality"
          >
            {(['auto', 'high', 'mid', 'low'] as const).map((q) => (
              <option key={q} value={q}>
                {t(`hud:settings.qualities.${q}`)}
              </option>
            ))}
          </select>
        </label>
        <label className={sy.check}>
          <input type="checkbox" checked={st.colorBlind} onChange={(e) => st.setColorBlind(e.target.checked)} />
          <span>{t('hud:settings.colorBlind')}</span>
        </label>
        <label className={sy.check}>
          <input
            type="checkbox"
            checked={st.leftHanded}
            onChange={(e) => st.setLeftHanded(e.target.checked)}
            data-testid="settings-left"
          />
          <span>{t('hud:settings.leftHanded')}</span>
        </label>
        <p className={c.muted}>{t('hud:settings.audioLater')}</p>
      </div>
    </Modal>
  );
}
