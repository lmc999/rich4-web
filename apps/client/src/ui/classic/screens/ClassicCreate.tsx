// 原版开局设置画面（original-skin.md §4.3；ui.md §2.3：jump#gm 背景风景 + jump#4 竖栏）→ 建房。
// - 竖栏（图1，整屏 (445,10)）：关卡一–四 = 台湾 / 大陆 / 日本 / 美国（点关卡行选图：播 click、写入草稿的地图（与联机设置的
//   地图下拉同一字段）、打勾、背景换成该图的 jump#gm；服务器地图目录里没有或不可开局的关卡变暗、不可点）、OK（建房）/ EXIT（回标题）、
//   6 个下拉：电脑人数、总资金、行进方式、土地期限、游戏时间、胜利条件（原生 <select> 叠在烘焙的白框上）；
// - 原版这一屏没有关卡横幅（jump#4 图11–14 只用在通关后的「下一关」列表），不画；
// - 缺省地图取服务器地图目录的 defaultMap（目录到达前的占位见 settingsDraft.FALLBACK_MAP_ID，用户手选过就不再覆盖）；
// - 左侧「联机设置」面板：地图、规则、小游戏、计时档位、演出节奏、公开 / 私密、观战、电脑个性，外加「快速局」；
// - 手机横屏 / 粗指针：竖栏的白框与关卡行只显示（关卡行 32 高、四行紧挨，缩放后不到 44 CSS 像素），全部设置（含地图）
//   排进两列的面板（行高 56，≥44 CSS 像素）。
// 提交逻辑与程序化 CreateRoomForm 相同（room:create，然后给 1..N 号座位补电脑）；testid 相同（create-form、set-*、
// create-submit、create-quick、create-error），另加 create-cancel（EXIT）。
import type { SeatIndex } from '@rich4/shared/engine';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useClient } from '../../../app/services';
import { useTx } from '../../../i18n/tx';
import {
  applyQuickPreset,
  defaultDraft,
  draftSoloHuman,
  draftToPatch,
  FALLBACK_MAP_ID,
  fetchMapList,
  type MapListingLite,
  mapAfterList,
  type SettingsDraft,
  timerHintActive,
} from '../../lobby/settingsDraft';
import { useEnsureSceneSprites } from '../common/sceneAssets';
import { regionStyle } from '../layout';
import { Sprite } from '../Sprite';
import {
  COLUMN,
  COLUMN_EXIT,
  COLUMN_OK,
  fieldLabelRect,
  fieldRect,
  ONLINE_PANEL,
  SETUP_FIELDS,
  SETUP_SHEET,
  STAGE_MAPS,
  stageCheck,
  stageRow,
  WIDE_PANEL,
} from './layout';
import { ClassicScreenFrame, HotButton, SetupBg, useWideHit } from './parts';
import s from './screens.module.css';
import {
  BoxSelect,
  draftValue,
  type FieldKey,
  fieldSpec,
  ONLINE_FIELDS,
  RowField,
  SETUP_FIELD_KEYS,
  WIDE_FIELDS,
} from './settingsFields';
import { playScreenCue } from './uiSound';

/** 关卡行的可用情况：服务器地图目录里有、并且可开局的地图 id */
export function stageAvailable(maps: readonly MapListingLite[]): ReadonlySet<string> {
  return new Set(maps.filter((m) => m.playable !== false).map((m) => m.id));
}

export interface SetupColumnProps {
  /** 当前地图（打勾的关卡） */
  mapId: string;
  /** 可选的地图（null = 目录还没到，全部按可用画、不可点） */
  available: ReadonlySet<string> | null;
  /** 点关卡行选图；缺省只读（非房主、读档后、手机横屏 / 粗指针） */
  onPick?(mapId: string): void;
  disabled?: boolean;
}

/** 竖栏的底图与关卡行（开局设置与选人画面共用） */
export function SetupColumn({ mapId, available, onPick, disabled = false }: SetupColumnProps): ReactNode {
  const t = useTx();
  return (
    <>
      <Sprite sheet={SETUP_SHEET} frame={1} x={COLUMN.x} y={COLUMN.y} origin="topLeft" testId="setup-column" />
      {STAGE_MAPS.map((m, k) => {
        const r = stageRow(k);
        const on = m === mapId;
        const usable = available === null || available.has(m);
        const name = t(`lobby:maps.${m}`, { defaultValue: m });
        const label = usable
          ? t('classicScreens:setup.stage', { name })
          : t('classicScreens:setup.stageNone', { name });
        const check = stageCheck(k);
        const attrs = {
          'data-testid': `setup-stage-${k}`,
          'data-map': m,
          'data-available': usable ? 'true' : 'false',
          'data-selected': on ? 'true' : 'false',
        } as const;
        const mark = on && (
          <Sprite sheet={SETUP_SHEET} frame={8} x={check.x - r.x} y={check.y - r.y} origin="topLeft" />
        );
        if (!onPick || available === null) {
          return (
            <div key={m} className={s.stageRow} style={regionStyle(r)} {...attrs}>
              {mark}
              <span className={s.srOnly}>{label}</span>
            </div>
          );
        }
        return (
          <button
            key={m}
            type="button"
            className={s.stageRow}
            style={regionStyle(r)}
            aria-label={label}
            aria-pressed={on}
            title={label}
            disabled={disabled || !usable}
            onClick={() => {
              if (!on) onPick(m);
            }}
            {...attrs}
          >
            {mark}
          </button>
        );
      })}
    </>
  );
}

export interface ClassicCreateProps {
  onCancel(): void;
  onCreated(code: string): void;
}

export default function ClassicCreate({ onCancel, onCreated }: ClassicCreateProps): ReactNode {
  const t = useTx();
  return (
    <ClassicScreenFrame testId="screen-setup" label={t('classicScreens:setup.title')}>
      <CreateBody onCancel={onCancel} onCreated={onCreated} />
    </ClassicScreenFrame>
  );
}

/** 舞台内容（要在 ClassicStage 之内才量得到缩放） */
function CreateBody({ onCancel, onCreated }: ClassicCreateProps): ReactNode {
  const t = useTx();
  const client = useClient();
  const wide = useWideHit();
  const [draft, setDraft] = useState<SettingsDraft>(() => defaultDraft(FALLBACK_MAP_ID));
  const [maps, setMaps] = useState<MapListingLite[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 用户手选过地图（关卡行或地图下拉）：目录到达后不再换成 defaultMap */
  const picked = useRef(false);
  useEnsureSceneSprites([SETUP_SHEET]);

  useEffect(() => {
    let stale = false;
    void fetchMapList().then((r) => {
      if (stale) return;
      setMaps(r.maps);
      setDraft((d) => ({ ...d, mapId: mapAfterList(d.mapId, picked.current, r) }));
    });
    return () => {
      stale = true;
    };
  }, []);

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await client.createRoom(draftToPatch(draft));
    if (!r.ok) {
      setBusy(false);
      setError(client.errorText(r.error));
      return;
    }
    for (let i = 1; i <= draft.aiCount; i++) {
      const a = await client.setSeatAi(i as SeatIndex, { preset: draft.aiPreset });
      if (!a.ok) {
        setError(client.errorText(a.error));
        break;
      }
    }
    setBusy(false);
    onCreated(r.data.code);
  };

  const spec = (k: FieldKey) => fieldSpec(k, t, draft.mapId, maps ?? []);
  // 电脑补满其余三个座位：开局时只有房主一名真人、不计时，计时说明换成「现在只有一名真人：开局后不计时」
  const untimed = timerHintActive(draft.timerPreset, draftSoloHuman(draft));
  const change = (d: SettingsDraft): void => {
    playScreenCue('move');
    if (d.mapId !== draft.mapId) picked.current = true;
    setDraft(d);
  };
  /**
   * 点关卡行：播全局 UI 音效表第 1 项（cue.ui.click，sfx.001），不是下拉框的 move
   * @source exe v2.06 0x405437–0x40543e：push 0; push 0x47f602（= 全局 UI 音效表 0x47f5fa 第 1 项）; call 0x4529ee
   */
  const pickStage = (mapId: string): void => {
    playScreenCue('click');
    picked.current = true;
    setDraft((d) => ({ ...d, mapId }));
  };
  const quick = (
    <button
      type="button"
      className={s.settingsBtn}
      onClick={() => change(applyQuickPreset(draft))}
      disabled={busy}
      data-testid="create-quick"
    >
      {t('lobby:create.quick')}
    </button>
  );

  return (
    <form className={s.fill} onSubmit={(e) => void submit(e)} data-testid="create-form">
      {/* 目录到达之前草稿里只是占位地图：不打勾、背景用 jump#0 */}
      <SetupBg mapId={maps === null ? null : draft.mapId} testId="setup-bg" />
      {/* 手机横屏 / 粗指针：关卡行只有约 25 CSS 像素高、四行紧挨，只读，改用两列面板里的地图下拉选图 */}
      <SetupColumn
        mapId={maps === null ? '' : draft.mapId}
        available={maps === null ? null : stageAvailable(maps)}
        onPick={wide ? undefined : pickStage}
        disabled={busy}
      />
      {SETUP_FIELDS.map(({ field, box }) => {
        const key = SETUP_FIELD_KEYS[field];
        const sp = spec(key);
        return (
          <div key={field}>
            <span className={`${s.boxLabel} ${s.outline}`} style={regionStyle(fieldLabelRect(box))} aria-hidden="true">
              {sp.label}
            </span>
            {wide || sp.kind !== 'select' ? (
              <span className={s.boxValue} style={regionStyle(fieldRect(box))} data-testid={`setup-value-${field}`}>
                {sp.kind === 'select' ? sp.render(draftValue(draft, sp.key)) : ''}
              </span>
            ) : (
              <BoxSelect spec={sp} draft={draft} onChange={change} disabled={busy} box={box} />
            )}
          </div>
        );
      })}
      {wide ? (
        <fieldset className={s.settings} style={regionStyle(WIDE_PANEL)} data-wide="true" disabled={busy}>
          {WIDE_FIELDS.map((k) => (
            <RowField
              key={k}
              spec={spec(k)}
              draft={draft}
              onChange={change}
              disabled={k === 'aiPreset' && draft.aiCount === 0}
              hintActive={k === 'timerPreset' && untimed}
            />
          ))}
          {quick}
        </fieldset>
      ) : (
        <fieldset className={s.settings} style={regionStyle(ONLINE_PANEL)} data-wide="false" disabled={busy}>
          <h2 className={s.outline}>{t('classicScreens:setup.online')}</h2>
          {ONLINE_FIELDS.map((k) => (
            <RowField
              key={k}
              spec={spec(k)}
              draft={draft}
              onChange={change}
              disabled={k === 'aiPreset' && draft.aiCount === 0}
              hintActive={k === 'timerPreset' && untimed}
            />
          ))}
          {quick}
        </fieldset>
      )}
      <HotButton
        rect={COLUMN_OK}
        label={t('classicScreens:setup.ok')}
        testId="create-submit"
        type="submit"
        disabled={busy}
        onPress={() => undefined}
        attrs={{ 'data-busy': busy ? 'true' : 'false' }}
      />
      <HotButton
        rect={COLUMN_EXIT}
        label={t('classicScreens:setup.exit')}
        testId="create-cancel"
        cue="back"
        onPress={onCancel}
      />
      {error && (
        <p
          className={s.note}
          style={regionStyle({ x: 8, y: 322, w: 428, h: 40 })}
          role="alert"
          data-testid="create-error"
        >
          {error}
        </p>
      )}
    </form>
  );
}
