// 托管设置（原版「电脑设定」；architecture M5：TrusteeSettings 经 game:autopilot 的 settings 由服务器提交
// SYS_SET_AI_TRAITS 写入 state，随存档保存）：个性、是否用卡 / 用道具、现金比例、股票比例（0..100，10 的倍数）。
// 初值取本人 view.players[].aiTraits。任何组件都可以 openTrusteeSettings() 打开（对话框挂在 SystemMenu 里）。
import type { RoomView } from '@rich4/shared/net';
import { isAutopilot } from '@rich4/shared/view';
import { type ReactNode, useEffect, useState } from 'react';
import { create } from 'zustand';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import type { TrusteeSettings } from '../../net/client';
import { useGameStore } from '../../store/gameStore';
import { mySeat } from '../../store/roomStore';
import { useUiStore } from '../../store/uiStore';
import { Modal } from '../components/Modal';
import sy from './system.module.css';

/** 比例步长（与 shared/ai 的 TRUSTEE_RATIO_STEP、服务器 schema 一致） */
export const TRUSTEE_RATIO_STEP = 10;
export const PERSONALITIES = [0, 1, 2] as const satisfies readonly TrusteeSettings['personality'][];

export const DEFAULT_TRUSTEE: Readonly<TrusteeSettings> = Object.freeze({
  personality: 1,
  useCards: true,
  useItems: true,
  cashRatio: 30,
  stockRatio: 30,
});

/** 夹到 0..100 并对齐到 10 的倍数（旧存档里的特质可能不是整十） */
export function snapRatio(n: number): number {
  const v = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
  return Math.round(v / TRUSTEE_RATIO_STEP) * TRUSTEE_RATIO_STEP;
}

/** 从特质取出对话框初值（与 shared/ai 的 trusteeSettingsOf 相同，前端不依赖 shared/ai） */
export function trusteeFromTraits(t: TrusteeSettings | null | undefined): TrusteeSettings {
  if (!t) return { ...DEFAULT_TRUSTEE };
  return {
    personality: t.personality,
    useCards: t.useCards,
    useItems: t.useItems,
    cashRatio: snapRatio(t.cashRatio),
    stockRatio: snapRatio(t.stockRatio),
  };
}

interface TrusteeDialogState {
  open: boolean;
  setOpen(b: boolean): void;
}

export const useTrusteeDialog = create<TrusteeDialogState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function openTrusteeSettings(): void {
  useTrusteeDialog.getState().setOpen(true);
}

function Ratio({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: number;
  onChange(v: number): void;
  testId: string;
}): ReactNode {
  return (
    <label className={sy.ratio}>
      <span>{label}</span>
      <input
        type="range"
        min={0}
        max={100}
        step={TRUSTEE_RATIO_STEP}
        value={value}
        onChange={(e) => onChange(snapRatio(Number(e.target.value)))}
        data-testid={testId}
      />
      <output className="num" data-testid={`${testId}-value`}>
        {value}%
      </output>
    </label>
  );
}

export function TrusteeSettingsDialog({ room }: { room: RoomView }): ReactNode {
  const t = useTx();
  const client = useClient();
  const open = useTrusteeDialog((s) => s.open);
  const me = mySeat(room);
  const traits = useGameStore((s) =>
    me === null ? null : (s.view?.players.find((p) => p.seat === me)?.aiTraits ?? null),
  );
  const control = me === null ? 'human' : (room.seats[me]?.control ?? 'human');
  const auto = isAutopilot(control);
  const [draft, setDraft] = useState<TrusteeSettings>(() => trusteeFromTraits(traits));
  const [busy, setBusy] = useState(false);

  // 每次打开都从当前特质重新取初值
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在打开时取一次，编辑中特质变化不覆盖草稿
  useEffect(() => {
    if (open) setDraft(trusteeFromTraits(traits));
  }, [open]);

  // 观战者、大厅里不可用：被打开了也立即复位，免得以后换成玩家时突然弹出
  const usable = me !== null && room.phase !== 'lobby';
  useEffect(() => {
    if (open && !usable) useTrusteeDialog.getState().setOpen(false);
  }, [open, usable]);

  if (!usable) return null;
  const setOpen = (b: boolean): void => useTrusteeDialog.getState().setOpen(b);
  const patch = (p: Partial<TrusteeSettings>): void => setDraft((d) => ({ ...d, ...p }));

  const submit = async (on: boolean, withSettings: boolean, okText: string): Promise<void> => {
    setBusy(true);
    const r = await client.autopilot(on, withSettings ? draft : undefined);
    setBusy(false);
    if (!r.ok) {
      useUiStore.getState().toast(client.errorText(r.error), 'warn');
      return;
    }
    useUiStore.getState().toast(okText, 'success');
    setOpen(false);
  };

  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      title={t('ui:trustee.title')}
      testId="trustee-dialog"
      width={460}
      layer="system"
      footer={
        <>
          {auto ? (
            <button
              type="button"
              className="btn btn--sm btn--cream"
              disabled={busy}
              onClick={() => void submit(false, false, t('ui:trustee.offDone'))}
              data-testid="trustee-off"
            >
              {t('ui:trustee.off')}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--sm btn--blue"
              disabled={busy}
              onClick={() => void submit(true, true, t('ui:trustee.onDone'))}
              data-testid="trustee-on"
            >
              🤖 {t('ui:trustee.on')}
            </button>
          )}
          <button
            type="button"
            className="btn btn--sm btn--green"
            disabled={busy}
            onClick={() => void submit(auto, true, t('ui:trustee.saved'))}
            data-testid="trustee-save"
          >
            {t('ui:trustee.save')}
          </button>
        </>
      }
    >
      <div className={sy.trustee}>
        <p className={sy.help}>
          <span className={auto ? `${sy.status} ${sy.statusOn}` : sy.status} data-testid="trustee-status">
            {auto
              ? t('ui:trustee.statusOn', {
                  reason: t(`hud:systemReason.${control.slice('autopilot:'.length)}`, { defaultValue: '' }),
                })
              : t('ui:trustee.statusOff')}
          </span>{' '}
          {t('ui:trustee.intro')}
        </p>
        <fieldset>
          <legend>{t('ui:trustee.personality')}</legend>
          {PERSONALITIES.map((p) => (
            <label key={p} className={sy.radio}>
              <input
                type="radio"
                name="trustee-personality"
                checked={draft.personality === p}
                onChange={() => patch({ personality: p })}
                data-testid={`trustee-personality-${p}`}
              />
              <span>{t(`ui:trustee.personalities.${p}`)}</span>
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>{t('ui:trustee.usage')}</legend>
          <label className={sy.check}>
            <input
              type="checkbox"
              checked={draft.useCards}
              onChange={(e) => patch({ useCards: e.target.checked })}
              data-testid="trustee-cards"
            />
            <span>{t('ui:trustee.useCards')}</span>
          </label>
          <label className={sy.check}>
            <input
              type="checkbox"
              checked={draft.useItems}
              onChange={(e) => patch({ useItems: e.target.checked })}
              data-testid="trustee-items"
            />
            <span>{t('ui:trustee.useItems')}</span>
          </label>
        </fieldset>
        <Ratio
          label={t('ui:trustee.cashRatio')}
          value={draft.cashRatio}
          onChange={(v) => patch({ cashRatio: v })}
          testId="trustee-cash"
        />
        <Ratio
          label={t('ui:trustee.stockRatio')}
          value={draft.stockRatio}
          onChange={(v) => patch({ stockRatio: v })}
          testId="trustee-stock"
        />
        <p className={sy.help}>{t('ui:trustee.ratioHelp')}</p>
      </div>
    </Modal>
  );
}
