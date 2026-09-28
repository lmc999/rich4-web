// 房间设置字段（原版开局设置的 6 个下拉 + 联机专有设置）：与程序化的 RoomSettingsFields 同一份草稿（lobby/settingsDraft）
// 与同一套 data-testid（set-map、set-fund、set-timer…），E2E 在两种皮肤下用同一组选择器。这里只换表现层：
// - BoxSelect：原版竖栏里烘焙的白框 + 箭头上叠一个透明的原生 <select>（桌面）；
// - RowField：面板里的一行（标签 + 下拉 / 勾选框），手机横屏时行高 56（≥44 CSS 像素）。
// 计时档位带一行小字「只有一名真人时不计时」（SelectSpec.hint；服务器按有效计时档位判定，design/net.md §5.4），
// 此刻就适用时（大厅：现在座位上只有一名真人；建房：电脑补满其余三个座位）换成「现在只有一名真人：开局后不计时」
// （SelectSpec.hintActive）并高亮：平时排在这一行下方；手机横屏两列面板里这一行占满整行，说明排在下拉框右边
// （右列的位置，字号 14 逻辑像素——844×390 时约 11 CSS 像素），行高仍是 56。
import {
  AI_PRESETS,
  INITIAL_FUND_OPTIONS,
  START_VEHICLES,
  TENURE_OPTIONS,
  TIME_LIMIT_OPTIONS,
  WIN_MULTIPLE_OPTIONS,
} from '@rich4/shared/engine';
import type { ReactNode } from 'react';
import type { LooseT } from '../../../i18n/tx';
import { type MapListingLite, PACING_OPTIONS, type SettingsDraft, TIMER_PRESETS } from '../../lobby/settingsDraft';
import { regionStyle } from '../layout';
import { Sprite } from '../Sprite';
import { fieldRect, SETUP_FIELDS, SETUP_SHEET, type SetupField } from './layout';
import s from './screens.module.css';

export type SelectKey =
  | 'mapId'
  | 'aiCount'
  | 'initialFund'
  | 'vehicle'
  | 'tenure'
  | 'timeLimitDays'
  | 'winMultiple'
  | 'rulePreset'
  | 'minigames'
  | 'timerPreset'
  | 'pacing'
  | 'visibility'
  | 'aiPreset';

export type FieldKey = SelectKey | 'allowSpectators';

export interface SelectSpec {
  kind: 'select';
  key: SelectKey;
  testId: string;
  label: string;
  options: readonly (string | number)[];
  render(v: string | number): string;
  /** 一行小字说明（RowField 显示；testid 为 `<testId>-hint`） */
  hint?: string;
  /** 说明此刻就适用时换成这句（FieldProps.hintActive） */
  hintActive?: string;
}

export interface CheckSpec {
  kind: 'check';
  key: 'allowSpectators';
  testId: string;
  label: string;
}

export type FieldSpec = SelectSpec | CheckSpec;

/** 与 RoomSettingsFields 相同的 data-testid */
export const FIELD_TEST_IDS: Readonly<Record<FieldKey, string>> = {
  mapId: 'set-map',
  aiCount: 'set-ai-count',
  initialFund: 'set-fund',
  vehicle: 'set-vehicle',
  tenure: 'set-tenure',
  timeLimitDays: 'set-time',
  winMultiple: 'set-win',
  rulePreset: 'set-rules',
  minigames: 'set-minigames',
  timerPreset: 'set-timer',
  pacing: 'set-pacing',
  visibility: 'set-visibility',
  allowSpectators: 'set-spectators',
  aiPreset: 'set-ai-preset',
};

/** 原版竖栏上的 6 个下拉之外的联机设置（开局设置画面的「联机设置」面板） */
export const ONLINE_FIELDS: readonly FieldKey[] = [
  'mapId',
  'rulePreset',
  'minigames',
  'timerPreset',
  'pacing',
  'visibility',
  'allowSpectators',
  'aiPreset',
];

/** 地图下拉的选项：目录里的地图（当前草稿的地图不在目录里时补在最前） */
export function mapOptions(draftMap: string, maps: readonly MapListingLite[]): string[] {
  return maps.some((m) => m.id === draftMap) ? maps.map((m) => m.id) : [draftMap, ...maps.map((m) => m.id)];
}

/** 字段的表现规格（标签、选项、选项文字） */
export function fieldSpec(key: FieldKey, t: LooseT, draftMap: string, maps: readonly MapListingLite[]): FieldSpec {
  const testId = FIELD_TEST_IDS[key];
  switch (key) {
    case 'allowSpectators':
      return { kind: 'check', key, testId, label: t('lobby:settings.spectators') };
    case 'mapId':
      return {
        kind: 'select',
        key,
        testId,
        label: t('lobby:settings.map'),
        options: mapOptions(draftMap, maps),
        render: (v) => t(`lobby:maps.${v}`, { defaultValue: String(v) }),
      };
    case 'aiCount':
      return {
        kind: 'select',
        key,
        testId,
        label: t('classicScreens:setup.aiCount'),
        options: [0, 1, 2, 3],
        render: (v) => t('lobby:settings.aiCountValue', { n: v }),
      };
    case 'initialFund':
      return {
        kind: 'select',
        key,
        testId,
        label: t('lobby:settings.fund'),
        options: INITIAL_FUND_OPTIONS,
        render: (v) => t('lobby:settings.fundValue', { n: Number(v) / 10000 }),
      };
    case 'vehicle':
      return {
        kind: 'select',
        key,
        testId,
        label: t('lobby:settings.vehicle'),
        options: START_VEHICLES,
        render: (v) => t(`lobby:vehicle.${v}`),
      };
    case 'tenure':
      return {
        kind: 'select',
        key,
        testId,
        label: t('lobby:settings.tenure'),
        options: TENURE_OPTIONS,
        render: (v) => t(`lobby:tenure.${v}`),
      };
    case 'timeLimitDays':
      return {
        kind: 'select',
        key,
        testId,
        label: t('lobby:settings.timeLimit'),
        options: TIME_LIMIT_OPTIONS,
        render: (v) => t(`lobby:timeLimit.${v}`),
      };
    case 'winMultiple':
      return {
        kind: 'select',
        key,
        testId,
        label: t('lobby:settings.win'),
        options: WIN_MULTIPLE_OPTIONS,
        render: (v) => (Number(v) === 0 ? t('lobby:win.none') : t('lobby:win.multiple', { n: v })),
      };
    case 'rulePreset':
      return {
        kind: 'select',
        key,
        testId,
        label: t('lobby:settings.rules'),
        options: ['program', 'manual'],
        render: (v) => t(`lobby:rules.${v}`),
      };
    case 'minigames':
      return {
        kind: 'select',
        key,
        testId,
        label: t('lobby:settings.minigames'),
        options: ['play', 'skip'],
        render: (v) => t(`lobby:minigames.${v}`),
      };
    case 'timerPreset':
      return {
        kind: 'select',
        key,
        testId,
        label: t('lobby:settings.timer'),
        options: TIMER_PRESETS,
        render: (v) => t(`lobby:timer.${v}`),
        hint: t('lobby:settings.timerHint'),
        hintActive: t('lobby:settings.timerHintActive'),
      };
    case 'pacing':
      return {
        kind: 'select',
        key,
        testId,
        label: t('lobby:settings.pacing'),
        options: PACING_OPTIONS,
        render: (v) => t(`lobby:pacing.${v}`),
      };
    case 'visibility':
      return {
        kind: 'select',
        key,
        testId,
        label: t('lobby:settings.visibility'),
        options: ['private', 'public'],
        render: (v) => t(`lobby:visibility.${v}`),
      };
    case 'aiPreset':
      return {
        kind: 'select',
        key,
        testId,
        label: t('lobby:settings.aiPreset'),
        options: AI_PRESETS,
        render: (v) => t(`lobby:aiPreset.${v}`),
      };
  }
}

/** 草稿里字段的值 */
export function draftValue(d: SettingsDraft, key: SelectKey): string | number {
  return d[key];
}

/** 改草稿（按选项的原始类型写回：数字选项写数字） */
export function withField(d: SettingsDraft, key: FieldKey, raw: string | boolean, spec?: FieldSpec): SettingsDraft {
  if (key === 'allowSpectators') return { ...d, allowSpectators: raw === true || raw === 'true' };
  const hit = spec?.kind === 'select' ? spec.options.find((o) => String(o) === String(raw)) : raw;
  if (hit === undefined) return d;
  return { ...d, [key]: hit } as SettingsDraft;
}

export interface FieldProps {
  spec: FieldSpec;
  draft: SettingsDraft;
  onChange(d: SettingsDraft): void;
  disabled?: boolean;
  /** 说明此刻就适用（只有一名真人，开局就不计时）：换成 SelectSpec.hintActive 的文字并高亮 */
  hintActive?: boolean;
}

/** 原版竖栏的下拉框：透明 <select> 叠在烘焙的白框与箭头上 */
export function BoxSelect({
  spec,
  draft,
  onChange,
  disabled,
  box,
}: FieldProps & { box: { x: number; y: number; w: number; h: number } }): ReactNode {
  if (spec.kind !== 'select') return null;
  const value = draftValue(draft, spec.key);
  return (
    <select
      className={s.boxSelect}
      style={regionStyle(fieldRect(box))}
      value={String(value)}
      disabled={disabled}
      aria-label={spec.label}
      data-testid={spec.testId}
      onChange={(e) => onChange(withField(draft, spec.key, e.target.value, spec))}
    >
      {spec.options.map((o) => (
        <option key={String(o)} value={String(o)}>
          {spec.render(o)}
        </option>
      ))}
    </select>
  );
}

/** 面板里的一行：标签 + 下拉（或勾选框：原版的勾 jump#4 图8） */
export function RowField({ spec, draft, onChange, disabled, hintActive }: FieldProps): ReactNode {
  if (spec.kind === 'check') {
    const on = draft.allowSpectators;
    return (
      <label className={s.row}>
        <span>{spec.label}</span>
        <span className={s.check}>
          <input
            type="checkbox"
            checked={on}
            disabled={disabled}
            onChange={(e) => onChange(withField(draft, 'allowSpectators', e.target.checked))}
            data-testid={spec.testId}
          />
          {on && (
            <Sprite
              sheet={SETUP_SHEET}
              frame={8}
              x={0}
              y={0}
              origin="topLeft"
              fallback={
                <span className={s.checkFallback} aria-hidden="true">
                  ✓
                </span>
              }
            />
          )}
        </span>
      </label>
    );
  }
  const value = draftValue(draft, spec.key);
  return (
    <label className={spec.hint ? `${s.row} ${s.rowHinted}` : s.row}>
      <span>{spec.label}</span>
      <select
        className={s.rowSelect}
        value={String(value)}
        disabled={disabled}
        data-testid={spec.testId}
        onChange={(e) => onChange(withField(draft, spec.key, e.target.value, spec))}
      >
        {spec.options.map((o) => (
          <option key={String(o)} value={String(o)}>
            {spec.render(o)}
          </option>
        ))}
      </select>
      {spec.hint && (
        <small className={s.rowHint} data-testid={`${spec.testId}-hint`} data-active={hintActive ? 'true' : 'false'}>
          {hintActive && spec.hintActive ? spec.hintActive : spec.hint}
        </small>
      )}
    </label>
  );
}

/** 竖栏 6 个下拉对应的草稿字段 */
export const SETUP_FIELD_KEYS: Readonly<Record<SetupField, SelectKey>> = {
  aiCount: 'aiCount',
  initialFund: 'initialFund',
  vehicle: 'vehicle',
  tenure: 'tenure',
  timeLimitDays: 'timeLimitDays',
  winMultiple: 'winMultiple',
};

/**
 * 手机横屏两列面板（开局设置 data-wide）的字段顺序：竖栏 6 项 + 联机设置，只是计时档位挪到演出节奏之后——带说明的
 * 这一行占满整行（说明排在右列的位置），要落在左列（前面有偶数项）才不会在右列留下空格；14 项（计时档位占两格）+
 * 快速局 = 16 格，仍是 8 行（screens.test.ts）
 */
export const WIDE_FIELDS: readonly FieldKey[] = (() => {
  const online = ONLINE_FIELDS.filter((k) => k !== 'timerPreset');
  const at = online.indexOf('pacing') + 1;
  return [
    ...SETUP_FIELDS.map((f) => SETUP_FIELD_KEYS[f.field]),
    ...online.slice(0, at),
    'timerPreset',
    ...online.slice(at),
  ];
})();
