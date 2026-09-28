// 原版托管设置（original-skin.md §4.2：托管 AI Panel#77；原版「电脑设定」）：对话框 435×355 摆在舞台中央——
// 左栏本人的角色页签（图1 亮）与圆头像（图6+角色），下方写托管状态；中间绿板两组选项（用卡 / 用道具可复选、个性三选一，
// 选中的行点亮红点 图3），两条比例滑杆（10 格，每格 10%；左右箭头 ±10%，滑杆本身是透明的 range 输入）；
// 右侧两个框钮：上 = 开始 / 解除托管、下 = 保存设置。Esc 与关闭钮放弃修改。
// 与程序化 TrusteeSettingsDialog 同一套逻辑（初值取本人 aiTraits，client.autopilot 提交，成功后 toast 并关闭）；
// data-testid 同名（trustee-dialog、trustee-personality-N、trustee-cards、trustee-items、trustee-cash、trustee-stock、
// trustee-on / trustee-off / trustee-save、trustee-status）。
import type { RoomView } from '@rich4/shared/net';
import { isAutopilot } from '@rich4/shared/view';
import { type ReactNode, useState } from 'react';
import { useClient } from '../../../app/services';
import { useTx } from '../../../i18n/tx';
import type { TrusteeSettings } from '../../../net/client';
import { useGameStore } from '../../../store/gameStore';
import { mySeat } from '../../../store/roomStore';
import { useUiStore } from '../../../store/uiStore';
import { PERSONALITIES, snapRatio, TRUSTEE_RATIO_STEP, trusteeFromTraits } from '../../system/TrusteeSettings';
import { Stage4x3 } from '../common/Stage4x3';
import { classicText, TEXT } from '../common/textStyles';
import { Sprite } from '../Sprite';
import { AUTOPLAY, AUTOPLAY_SHEET, autoplayHead } from './layout';
import pp from './popups.module.css';

export const TRUSTEE_KEYS = [AUTOPLAY_SHEET] as const;

/** 对话框左上角（舞台居中） */
export const TRUSTEE_AT = {
  x: Math.round((640 - AUTOPLAY.dialog.w) / 2),
  y: Math.round((480 - AUTOPLAY.dialog.h) / 2),
} as const;

/**
 * 中央决策倒计时的小牌（场景坐标，上缘中点；common/sceneCover）：对话框居中、盖住棋盘视窗中线，
 * 摆在工具列（y<40）与对话框上缘（y=63）之间的空档正中
 */
export const TRUSTEE_BADGE = { x: 320, y: 37 } as const;

export interface TrusteeScreenProps {
  room: RoomView;
  onClose: () => void;
}

export function TrusteeScreen({ room, onClose }: TrusteeScreenProps): ReactNode {
  const t = useTx();
  const client = useClient();
  const me = mySeat(room);
  const traits = useGameStore((s) =>
    me === null ? null : (s.view?.players.find((p) => p.seat === me)?.aiTraits ?? null),
  );
  const character = useGameStore((s) =>
    me === null ? 0 : (s.view?.players.find((p) => p.seat === me)?.character ?? 0),
  );
  const control = me === null ? 'human' : (room.seats[me]?.control ?? 'human');
  const auto = isAutopilot(control);
  const [draft, setDraft] = useState<TrusteeSettings>(() => trusteeFromTraits(traits));
  const [busy, setBusy] = useState(false);
  const patch = (p: Partial<TrusteeSettings>): void => setDraft((d) => ({ ...d, ...p }));
  const X = TRUSTEE_AT.x;
  const Y = TRUSTEE_AT.y;

  const submit = async (on: boolean, withSettings: boolean, okText: string): Promise<void> => {
    setBusy(true);
    const r = await client.autopilot(on, withSettings ? draft : undefined);
    setBusy(false);
    if (!r.ok) {
      useUiStore.getState().toast(client.errorText(r.error), 'warn');
      return;
    }
    useUiStore.getState().toast(okText, 'success');
    onClose();
  };

  const row = (
    at: { x: number; y: number },
    on: boolean,
    label: string,
    onClick: () => void,
    testId: string,
  ): ReactNode => (
    <div key={testId}>
      {on && <Sprite sheet={AUTOPLAY_SHEET} frame={AUTOPLAY.dot} x={X + at.x} y={Y + at.y} origin="topLeft" />}
      <button
        type="button"
        aria-pressed={on}
        className={pp.btn}
        style={{
          ...TEXT.body,
          left: X + at.x - 4,
          top: Y + at.y - 3,
          width: AUTOPLAY.rowLabel.dx + AUTOPLAY.rowLabel.w + 8,
          height: 21,
          justifyItems: 'start',
          paddingLeft: AUTOPLAY.rowLabel.dx + 4,
        }}
        disabled={busy}
        onClick={onClick}
        data-testid={testId}
      >
        {label}
      </button>
    </div>
  );

  const slider = (
    i: number,
    label: string,
    value: number,
    onChange: (v: number) => void,
    testId: string,
  ): ReactNode => {
    const s = AUTOPLAY.sliders[i]!;
    return (
      <div key={testId}>
        <span
          className={pp.cell}
          style={{ ...TEXT.small, left: X + 156, top: Y + s.y, width: 38, height: s.h }}
          aria-hidden="true"
        >
          {label}
        </span>
        <span className={pp.meter} style={{ left: X + s.x, top: Y + s.y, width: s.w, height: s.h }}>
          <span className={pp.meterFill} style={{ width: (s.w * value) / 100 }} />
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={TRUSTEE_RATIO_STEP}
          value={value}
          aria-label={label}
          disabled={busy}
          onChange={(e) => onChange(snapRatio(Number(e.target.value)))}
          className={pp.meter}
          style={{ left: X + s.x, top: Y + s.y, width: s.w, height: s.h, margin: 0, opacity: 0 }}
          data-testid={testId}
        />
        <button
          type="button"
          className={pp.btn}
          style={{ left: X + s.x - AUTOPLAY.arrowW - 1, top: Y + s.y, width: AUTOPLAY.arrowW, height: s.h }}
          aria-label={`${label} −${TRUSTEE_RATIO_STEP}%`}
          disabled={busy || value <= 0}
          onClick={() => onChange(snapRatio(value - TRUSTEE_RATIO_STEP))}
          data-testid={`${testId}-dec`}
        />
        <button
          type="button"
          className={pp.btn}
          style={{ left: X + s.x + s.w + 1, top: Y + s.y, width: AUTOPLAY.arrowW, height: s.h }}
          aria-label={`${label} +${TRUSTEE_RATIO_STEP}%`}
          disabled={busy || value >= 100}
          onClick={() => onChange(snapRatio(value + TRUSTEE_RATIO_STEP))}
          data-testid={`${testId}-inc`}
        />
        <output
          className={pp.cell}
          style={{ ...TEXT.number, left: X + s.x + s.w + 14, top: Y + s.y, width: 40, height: s.h }}
          data-testid={`${testId}-value`}
        >
          {value}%
        </output>
      </div>
    );
  };

  const [b0, b1] = AUTOPLAY.buttons;
  return (
    <Stage4x3
      testId="trustee-dialog"
      label={t('ui:trustee.title')}
      backdrop="dim"
      countdownBadgeAt={TRUSTEE_BADGE}
      onClose={onClose}
      attrs={{ 'data-classic': 'true', 'data-auto': auto ? 'true' : 'false' }}
    >
      <Sprite sheet={AUTOPLAY_SHEET} frame={AUTOPLAY.dialog.frame} x={X} y={Y} origin="topLeft" />
      <Sprite sheet={AUTOPLAY_SHEET} frame={AUTOPLAY.tab.on} x={X} y={Y + 6} origin="topLeft" />
      <Sprite sheet={AUTOPLAY_SHEET} frame={autoplayHead(character)} x={X + 62} y={Y + 49} />
      <p
        className={pp.text}
        style={{ ...classicText({ size: 12, color: '#3a1a04', outline: null }), left: X + 6, top: Y + 100, width: 104 }}
        data-testid="trustee-status"
      >
        {auto
          ? t('ui:trustee.statusOn', {
              reason: t(`hud:systemReason.${control.slice('autopilot:'.length)}`, { defaultValue: '' }),
            })
          : t('ui:trustee.statusOff')}
      </p>
      <p
        className={pp.text}
        style={{ ...classicText({ size: 12, color: '#3a1a04', outline: null }), left: X + 6, top: Y + 140, width: 104 }}
      >
        {t('ui:trustee.intro')}
      </p>
      <span
        className={pp.cell}
        style={{
          ...TEXT.small,
          left: X + AUTOPLAY.headers[0].x,
          top: Y + AUTOPLAY.headers[0].y,
          width: 72,
          height: 16,
        }}
      >
        {t('ui:trustee.usage')}
      </span>
      <span
        className={pp.cell}
        style={{
          ...TEXT.small,
          left: X + AUTOPLAY.headers[1].x,
          top: Y + AUTOPLAY.headers[1].y,
          width: 72,
          height: 16,
        }}
      >
        {t('ui:trustee.personality')}
      </span>
      <span
        className={pp.cell}
        style={{
          ...TEXT.small,
          left: X + AUTOPLAY.headers[2].x,
          top: Y + AUTOPLAY.headers[2].y,
          width: 110,
          height: 16,
        }}
      >
        {t('ui:trustee.cashRatio')} / {t('ui:trustee.stockRatio')}
      </span>
      {row(
        AUTOPLAY.toggles[0],
        draft.useCards,
        t('ui:trustee.useCards'),
        () => patch({ useCards: !draft.useCards }),
        'trustee-cards',
      )}
      {row(
        AUTOPLAY.toggles[1],
        draft.useItems,
        t('ui:trustee.useItems'),
        () => patch({ useItems: !draft.useItems }),
        'trustee-items',
      )}
      {PERSONALITIES.map((p, i) =>
        row(
          AUTOPLAY.personality[i]!,
          draft.personality === p,
          t(`ui:trustee.personalities.${p}`),
          () => patch({ personality: p }),
          `trustee-personality-${p}`,
        ),
      )}
      {slider(0, t('dlg.common.cash'), draft.cashRatio, (v) => patch({ cashRatio: v }), 'trustee-cash')}
      {slider(1, t('classic:profile.tabs.stocks'), draft.stockRatio, (v) => patch({ stockRatio: v }), 'trustee-stock')}
      <button
        type="button"
        className={pp.btn}
        style={{
          ...classicText({ size: 12, color: '#3a1a04', outline: null }),
          left: X + b0.x,
          top: Y + b0.y,
          width: b0.w,
          height: b0.h,
          whiteSpace: 'normal',
          padding: 4,
        }}
        disabled={busy}
        onClick={() =>
          auto ? void submit(false, false, t('ui:trustee.offDone')) : void submit(true, true, t('ui:trustee.onDone'))
        }
        data-testid={auto ? 'trustee-off' : 'trustee-on'}
      >
        {auto ? t('ui:trustee.off') : t('ui:trustee.on')}
      </button>
      <button
        type="button"
        className={pp.btn}
        style={{
          ...classicText({ size: 12, color: '#3a1a04', outline: null }),
          left: X + b1.x,
          top: Y + b1.y,
          width: b1.w,
          height: b1.h,
          whiteSpace: 'normal',
          padding: 4,
        }}
        disabled={busy}
        onClick={() => void submit(auto, true, t('ui:trustee.saved'))}
        data-testid="trustee-save"
      >
        {t('ui:trustee.save')}
      </button>
    </Stage4x3>
  );
}
