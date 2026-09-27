// 设置（design/client.md §5.7）：昵称（大厅）、动画速度、镜头跟随、声音（AudioSettings：五路音量、静音、角色语音、后台静音）、
// 画质、色弱、左手模式、皮肤；存 localStorage。
// 皮肤（原版皮肤 A5）：自动 / 原版 / 程序化；下方显示当前判定、素材包与回退原因（地图不匹配时列出明细）。
import type { MapSkinMismatch } from '@rich4/shared/assets';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useTx } from '../../i18n/tx';
import { useSkinStore } from '../../skin/skinStore';
import { SKIN_PREFS } from '../../skin/types';
import { type AnimSpeed, type QualitySetting, useSettingsStore } from '../../store/settingsStore';
import { requireAccess } from '../access/accessStore';
import c from '../common/common.module.css';
import { Modal } from '../components/Modal';
import { AudioSettings } from './AudioSettings';
import sy from './system.module.css';

function mismatchText(t: ReturnType<typeof useTx>, m: MapSkinMismatch): string {
  return t(`hud:skin.mismatch.${m.code}`, { expected: m.expected ?? '-', actual: m.actual ?? '-' });
}

/** 皮肤判定与回退原因（设置页） */
export function SkinStatus(): ReactNode {
  const t = useTx();
  const res = useSkinStore((s) => s.resolution);
  const pack = useSkinStore((s) => s.pack);
  const inGame = useSkinStore((s) => s.activeMap !== null);
  useEffect(() => {
    void useSkinStore.getState().ensurePack();
  }, []);
  const reason = res.reason ?? (inGame ? res.boardReason : null);
  return (
    <div className={c.muted} data-testid="settings-skin-status" data-skin={res.skin} data-board={res.board}>
      <div>
        {t('hud:settings.skinCurrent', {
          skin: t(`hud:settings.skinKinds.${res.skin}`),
          board: t(`hud:settings.skinKinds.${inGame ? res.board : 'procedural'}`),
        })}
      </div>
      <div>
        {pack.status === 'ready'
          ? t('hud:settings.skinPack', { id: pack.manifest.packId })
          : t('hud:settings.skinNoPack')}
      </div>
      {reason && (
        <div data-testid="settings-skin-reason" data-reason={reason}>
          {t('hud:settings.skinReason', { reason: t(`hud:skin.reason.${reason}`) })}
        </div>
      )}
      {res.mismatches.length > 0 && (
        <ul data-testid="settings-skin-mismatch">
          {res.mismatches.map((m) => (
            <li key={m.code}>{mismatchText(t, m)}</li>
          ))}
        </ul>
      )}
      {reason === 'access-required' && (
        <button
          type="button"
          className="btn btn--sm btn--blue"
          onClick={() => requireAccess('manual')}
          data-testid="settings-skin-unlock"
        >
          {t('hud:skin.unlock')}
        </button>
      )}
      <div>{t('hud:settings.skinHint')}</div>
    </div>
  );
}

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
        <AudioSettings />
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
        <fieldset className={sy.group} style={{ flexWrap: 'wrap' }} data-testid="settings-skin">
          <legend>{t('hud:settings.skin')}</legend>
          {SKIN_PREFS.map((p) => (
            <label key={p} className={sy.radio}>
              <input
                type="radio"
                name="skin"
                checked={st.skin === p}
                onChange={() => st.setSkin(p)}
                data-testid={`settings-skin-${p}`}
              />
              <span>{t(`hud:settings.skins.${p}`)}</span>
            </label>
          ))}
        </fieldset>
        {open && <SkinStatus />}
      </div>
    </Modal>
  );
}
