// 房间设置表单字段（建房与房主改设置共用）：地图、总资金、行进方式、地契、游戏时间、胜利条件、规则预设、
// 小游戏、计时档位、演出节奏（原版 / 紧凑）、观战、公开/私密；建房时额外有「电脑补位」。
// 计时档位下有一行小字「只有一名真人时不计时」（服务器按有效计时档位判定，design/net.md §5.4）；此刻就适用时
// （改设置：现在座位上只有一名真人；建房：电脑补满其余三个座位）换成「现在只有一名真人：开局后不计时」并高亮。
import {
  AI_PRESETS,
  type AiPreset,
  INITIAL_FUND_OPTIONS,
  type InitialFund,
  START_VEHICLES,
  type StartVehicle,
  TENURE_OPTIONS,
  type Tenure,
  TIME_LIMIT_OPTIONS,
  type TimeLimitDays,
  WIN_MULTIPLE_OPTIONS,
  type WinMultiple,
} from '@rich4/shared/engine';
import type { PacingProfile, TimerPreset } from '@rich4/shared/net';
import type { ReactNode } from 'react';
import { useTx } from '../../i18n/tx';
import c from '../common/common.module.css';
import l from './lobby.module.css';
import {
  draftSoloHuman,
  type MapListingLite,
  PACING_OPTIONS,
  type SettingsDraft,
  TIMER_PRESETS,
  timerHintActive,
} from './settingsDraft';

export interface RoomSettingsFieldsProps {
  draft: SettingsDraft;
  onChange(d: SettingsDraft): void;
  maps: readonly MapListingLite[];
  /** 建房时显示「电脑补位」（补满其余三个座位时计时说明换成「现在只有一名真人」） */
  withAi: boolean;
  /** 改房间设置：现在座位上只有一名真人（lobby/settingsDraft soloHumanNow） */
  soloHuman?: boolean;
  disabled?: boolean;
}

function Select<T extends string | number>({
  label,
  value,
  options,
  render,
  onChange,
  testId,
  disabled,
  hint,
  hintActive,
}: {
  label: string;
  value: T;
  options: readonly T[];
  render(v: T): string;
  onChange(v: T): void;
  testId: string;
  disabled?: boolean;
  /** 下拉框下方的一行小字说明 */
  hint?: string;
  /** 说明此刻就适用：高亮（文字由调用方换好） */
  hintActive?: boolean;
}): ReactNode {
  return (
    <label className={c.field}>
      <span>{label}</span>
      <select
        className="select"
        value={String(value)}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) => {
          const hit = options.find((o) => String(o) === e.target.value);
          if (hit !== undefined) onChange(hit);
        }}
      >
        {options.map((o) => (
          <option key={String(o)} value={String(o)}>
            {render(o)}
          </option>
        ))}
      </select>
      {hint && (
        <small className={l.fieldHint} data-testid={`${testId}-hint`} data-active={hintActive ? 'true' : 'false'}>
          {hint}
        </small>
      )}
    </label>
  );
}

export function RoomSettingsFields({
  draft,
  onChange,
  maps,
  withAi,
  soloHuman = false,
  disabled,
}: RoomSettingsFieldsProps): ReactNode {
  const t = useTx();
  const untimed = timerHintActive(draft.timerPreset, soloHuman || (withAi && draftSoloHuman(draft)));
  const set = <K extends keyof SettingsDraft>(k: K, v: SettingsDraft[K]): void => onChange({ ...draft, [k]: v });
  const mapIds = maps.some((m) => m.id === draft.mapId)
    ? maps.map((m) => m.id)
    : [draft.mapId, ...maps.map((m) => m.id)];
  return (
    <div className={l.fields}>
      <Select<string>
        label={t('lobby:settings.map')}
        value={draft.mapId}
        options={mapIds}
        render={(id) => t(`lobby:maps.${id}`, { defaultValue: id })}
        onChange={(v) => set('mapId', v)}
        testId="set-map"
        disabled={disabled}
      />
      <Select<InitialFund>
        label={t('lobby:settings.fund')}
        value={draft.initialFund}
        options={INITIAL_FUND_OPTIONS}
        render={(v) => t('lobby:settings.fundValue', { n: v / 10000 })}
        onChange={(v) => set('initialFund', v)}
        testId="set-fund"
        disabled={disabled}
      />
      <Select<StartVehicle>
        label={t('lobby:settings.vehicle')}
        value={draft.vehicle}
        options={START_VEHICLES}
        render={(v) => t(`lobby:vehicle.${v}`)}
        onChange={(v) => set('vehicle', v)}
        testId="set-vehicle"
        disabled={disabled}
      />
      <Select<Tenure>
        label={t('lobby:settings.tenure')}
        value={draft.tenure}
        options={TENURE_OPTIONS}
        render={(v) => t(`lobby:tenure.${v}`)}
        onChange={(v) => set('tenure', v)}
        testId="set-tenure"
        disabled={disabled}
      />
      <Select<TimeLimitDays>
        label={t('lobby:settings.timeLimit')}
        value={draft.timeLimitDays}
        options={TIME_LIMIT_OPTIONS}
        render={(v) => t(`lobby:timeLimit.${v}`)}
        onChange={(v) => set('timeLimitDays', v)}
        testId="set-time"
        disabled={disabled}
      />
      <Select<WinMultiple>
        label={t('lobby:settings.win')}
        value={draft.winMultiple}
        options={WIN_MULTIPLE_OPTIONS}
        render={(v) => (v === 0 ? t('lobby:win.none') : t('lobby:win.multiple', { n: v }))}
        onChange={(v) => set('winMultiple', v)}
        testId="set-win"
        disabled={disabled}
      />
      <Select<'program' | 'manual'>
        label={t('lobby:settings.rules')}
        value={draft.rulePreset}
        options={['program', 'manual']}
        render={(v) => t(`lobby:rules.${v}`)}
        onChange={(v) => set('rulePreset', v)}
        testId="set-rules"
        disabled={disabled}
      />
      <Select<'play' | 'skip'>
        label={t('lobby:settings.minigames')}
        value={draft.minigames}
        options={['play', 'skip']}
        render={(v) => t(`lobby:minigames.${v}`)}
        onChange={(v) => set('minigames', v)}
        testId="set-minigames"
        disabled={disabled}
      />
      <Select<TimerPreset>
        label={t('lobby:settings.timer')}
        value={draft.timerPreset}
        options={TIMER_PRESETS}
        render={(v) => t(`lobby:timer.${v}`)}
        onChange={(v) => set('timerPreset', v)}
        testId="set-timer"
        disabled={disabled}
        hint={t(untimed ? 'lobby:settings.timerHintActive' : 'lobby:settings.timerHint')}
        hintActive={untimed}
      />
      <Select<PacingProfile>
        label={t('lobby:settings.pacing')}
        value={draft.pacing}
        options={PACING_OPTIONS}
        render={(v) => t(`lobby:pacing.${v}`)}
        onChange={(v) => set('pacing', v)}
        testId="set-pacing"
        disabled={disabled}
      />
      <Select<'private' | 'public'>
        label={t('lobby:settings.visibility')}
        value={draft.visibility}
        options={['private', 'public']}
        render={(v) => t(`lobby:visibility.${v}`)}
        onChange={(v) => set('visibility', v)}
        testId="set-visibility"
        disabled={disabled}
      />
      <label className={`${c.field} ${l.check}`}>
        <input
          type="checkbox"
          checked={draft.allowSpectators}
          disabled={disabled}
          onChange={(e) => set('allowSpectators', e.target.checked)}
          data-testid="set-spectators"
        />
        <span>{t('lobby:settings.spectators')}</span>
      </label>
      {withAi && (
        <>
          <Select<0 | 1 | 2 | 3>
            label={t('lobby:settings.aiCount')}
            value={draft.aiCount}
            options={[0, 1, 2, 3]}
            render={(v) => t('lobby:settings.aiCountValue', { n: v })}
            onChange={(v) => set('aiCount', v)}
            testId="set-ai-count"
            disabled={disabled}
          />
          <Select<AiPreset>
            label={t('lobby:settings.aiPreset')}
            value={draft.aiPreset}
            options={AI_PRESETS}
            render={(v) => t(`lobby:aiPreset.${v}`)}
            onChange={(v) => set('aiPreset', v)}
            testId="set-ai-preset"
            disabled={disabled || draft.aiCount === 0}
          />
        </>
      )}
    </div>
  );
}
