// 原版开局设置画面（original-skin.md §4.3；ui.md §2.3：jump#0 背景风景 + jump#4 竖栏）→ 建房。
// - 竖栏（图1）：关卡一–四（当前地图打勾，本项目只有台湾 = 关卡一）、OK（建房）/ EXIT（回标题）、6 个下拉：
//   电脑人数、总资金、行进方式、土地期限、游戏时间、胜利条件（原生 <select> 叠在烘焙的白框上）；
// - 左侧「联机设置」面板：地图、规则、小游戏、计时档位、演出节奏、公开 / 私密、观战、电脑个性，外加「快速局」；
// - 手机横屏 / 粗指针：竖栏的白框只显示数值，全部设置排进两列 7 行的面板（行高 56，≥44 CSS 像素）。
// 提交逻辑与程序化 CreateRoomForm 相同（room:create，然后给 1..N 号座位补电脑）；testid 相同（create-form、set-*、
// create-submit、create-quick、create-error），另加 create-cancel（EXIT）。
import type { SeatIndex } from '@rich4/shared/engine';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { useClient } from '../../../app/services';
import { useTx } from '../../../i18n/tx';
import {
  applyQuickPreset,
  defaultDraft,
  draftToPatch,
  fetchMapList,
  type MapListingLite,
  type SettingsDraft,
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
  SETUP_BANNER,
  SETUP_BG,
  SETUP_FIELDS,
  SETUP_SHEET,
  STAGE_MAPS,
  stageRow,
  WIDE_PANEL,
} from './layout';
import { ClassicScreenFrame, HotButton, SceneImage, useWideHit } from './parts';
import s from './screens.module.css';
import {
  BoxSelect,
  draftValue,
  type FieldKey,
  fieldSpec,
  ONLINE_FIELDS,
  RowField,
  SETUP_FIELD_KEYS,
} from './settingsFields';
import { playScreenCue } from './uiSound';

/** 竖栏的底图与关卡行（开局设置与选人画面共用） */
export function SetupColumn({ mapId }: { mapId: string }): ReactNode {
  const t = useTx();
  return (
    <>
      <Sprite sheet={SETUP_SHEET} frame={1} x={COLUMN.x} y={COLUMN.y} origin="topLeft" testId="setup-column" />
      {STAGE_MAPS.map((m, k) => {
        const r = stageRow(k);
        const on = m !== null && m === mapId;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: 固定 4 行
            key={k}
            className={s.stageRow}
            style={regionStyle(r)}
            data-testid={`setup-stage-${k}`}
            data-available={m === null ? 'false' : 'true'}
            data-selected={on ? 'true' : 'false'}
          >
            {on && <Sprite sheet={SETUP_SHEET} frame={8} x={r.w - 34} y={3} origin="topLeft" />}
            <span className={s.srOnly}>
              {m === null
                ? t('classicScreens:setup.stageNone')
                : t('classicScreens:setup.stage', { name: t(`lobby:maps.${m}`, { defaultValue: m }) })}
            </span>
          </div>
        );
      })}
    </>
  );
}

/** 关卡横幅（图11–14：关卡一–四）；地图不在原版四关里时不画 */
export function StageBanner({ mapId }: { mapId: string }): ReactNode {
  const k = STAGE_MAPS.indexOf(mapId);
  if (k < 0) return null;
  return <Sprite sheet={SETUP_SHEET} frame={11 + k} x={SETUP_BANNER.x} y={SETUP_BANNER.y} testId="setup-banner" />;
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
  const [draft, setDraft] = useState<SettingsDraft>(() => defaultDraft('taiwan'));
  const [maps, setMaps] = useState<MapListingLite[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEnsureSceneSprites([SETUP_SHEET]);

  useEffect(() => {
    let stale = false;
    void fetchMapList().then((r) => {
      if (stale) return;
      setMaps(r.maps);
      setDraft((d) => (r.maps.some((m) => m.id === d.mapId) ? d : { ...d, mapId: r.defaultMap }));
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

  const spec = (k: FieldKey) => fieldSpec(k, t, draft.mapId, maps);
  const change = (d: SettingsDraft): void => {
    playScreenCue('move');
    setDraft(d);
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
      <SceneImage imageKey={SETUP_BG} w={640} h={480} testId="setup-bg" />
      {!wide && <StageBanner mapId={draft.mapId} />}
      <SetupColumn mapId={draft.mapId} />
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
          {[...SETUP_FIELDS.map((f) => SETUP_FIELD_KEYS[f.field]), ...ONLINE_FIELDS].map((k) => (
            <RowField
              key={k}
              spec={spec(k)}
              draft={draft}
              onChange={change}
              disabled={k === 'aiPreset' && draft.aiCount === 0}
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
