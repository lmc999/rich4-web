// GO 钮（Panel#7：图0 常态 / 1 悬停 / 2 禁止 / 3 禁止悬停 / 4–5 乌龟；图6–11 骰子数小图 15×15；命中掩膜 Panel#8）。
// 行为与行动区的掷骰按钮一致：只在「我的 TURN_MENU 已就绪（动画播完）且未提交」时可按，带上选中的骰子数；
// 骰子数小图点按（或 D 键）在允许的颗数之间切换。data-testid 沿用 action-roll（E2E 两种布局同一套选择器）。
//
// 素材按像素核对过（真实素材包，只在本机裁图，不入库）：
// - 骰子数小图两两成对：图6/7 = 1 点（灰 / 白底红点），图8/9 = 2 点，图10/11 = 3 点；灰为不能切换，白底红点为可切换；
// - 掩膜 Panel#8 没有 0：区 1 = 左侧深紫竖槽（x7..22、y9..56，正好放 15×15 的骰子数小图）、区 2 = 紫色边框、
//   区 3 = GO 钮面、区 4 = 钮外的透明四角。按下只认区 2、3；骰子数小图画在区 1 竖槽里（点竖槽切换颗数）。
import type { DiceCount } from '@rich4/shared/engine';
import type { RoomView } from '@rich4/shared/net';
import { isDecisionForYouOf } from '@rich4/shared/view';
import { type MouseEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import { useGameStore } from '../../store/gameStore';
import { mySeat } from '../../store/roomStore';
import { useUiStore } from '../../store/uiStore';
import { ensureClassicMask, GO_MASK_KEY, type MaskAsset, maskRegion, useClassicAssets } from './assets';
import c from './classic.module.css';
import { DICE_COUNT_RECT, DICE_COUNT_SPRITE, GO_RECT, regionStyle } from './layout';
import { Sprite, useSheetStatus } from './Sprite';

export interface RollControl {
  /** 观战者 */
  spectator: boolean;
  /** 可以掷骰（我的 TURN_MENU 已就绪且未提交） */
  ready: boolean;
  /** 骰子被锁定的原因（停留 / 乌龟 / 梦游）；没有锁定为 null */
  lock: 'stay' | 'tortoise' | 'sleepwalk' | null;
  allowed: readonly DiceCount[];
  chosen: DiceCount;
  /** 可以切换骰子数 */
  canChooseDice: boolean;
  roll(): void;
  /** 切到下一个允许的颗数 */
  cycleDice(): void;
}

export function useRollControl(room: RoomView): RollControl {
  const client = useClient();
  const decision = useGameStore((s) => s.decision);
  const submitting = useGameStore((s) => s.submitting);
  const diceChoice = useUiStore((s) => s.diceChoice);
  const me = mySeat(room);
  const turn = me !== null && decision && isDecisionForYouOf(decision, 'TURN_MENU') ? decision : null;
  const ready = turn !== null && submitting !== turn.decisionId;
  const dice = turn?.options.dice;
  const lock = dice?.locked ?? null;
  const allowed: readonly DiceCount[] = dice?.allowed ?? [];
  const chosen: DiceCount = diceChoice && allowed.includes(diceChoice) ? diceChoice : (dice?.current ?? 1);
  const canChooseDice = ready && lock === null && allowed.length > 1;
  const decisionId = turn?.decisionId ?? null;
  const roll = useCallback(() => {
    if (!ready || decisionId === null) return;
    void client.act(
      lock !== null || allowed.length === 0 ? { type: 'ROLL' } : { type: 'ROLL', dice: chosen },
      decisionId,
    );
  }, [client, ready, decisionId, lock, allowed, chosen]);
  const cycleDice = useCallback(() => {
    if (!canChooseDice) return;
    const i = allowed.indexOf(chosen);
    useUiStore.getState().setDiceChoice(allowed[(i + 1) % allowed.length]!);
  }, [canChooseDice, allowed, chosen]);
  return { spectator: me === null, ready, lock, allowed, chosen, canChooseDice, roll, cycleDice };
}

/** GO 钮的帧：乌龟 4/5、禁止 2/3、常态 0/1（奇数为悬停） */
export function goFrame(ready: boolean, lock: RollControl['lock'], hover: boolean): number {
  const base = !ready ? 2 : lock === 'tortoise' ? 4 : 0;
  return base + (hover ? 1 : 0);
}

/** 骰子数小图的帧：图6–11 按颗数两两成对（1/2/3 点），每对先灰（不能切换）后白底红点（可切换） */
export function diceCountFrame(chosen: number, active: boolean): number {
  const n = Math.min(3, Math.max(1, Math.trunc(chosen)));
  return 6 + 2 * (n - 1) + (active ? 1 : 0);
}

/** 掩膜区号：区 2 紫色边框、区 3 钮面算 GO；区 1 是骰子数竖槽，区 4 是钮外透明四角 */
export const GO_MASK_REGIONS = { slot: 1, rim: 2, face: 3, outside: 4 } as const;

function localPoint(e: MouseEvent<HTMLElement> | PointerEvent<HTMLElement>): { x: number; y: number } {
  const r = e.currentTarget.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) * GO_RECT.w) / Math.max(1, r.width),
    y: ((e.clientY - r.top) * GO_RECT.h) / Math.max(1, r.height),
  };
}

/** 指针落在掩膜的钮面上（区 2、3；没有掩膜时整块矩形都算） */
export function onGoFace(mask: MaskAsset | null, p: { x: number; y: number }): boolean {
  if (mask === null) return true;
  const r = maskRegion(mask, p.x, p.y);
  return r === GO_MASK_REGIONS.rim || r === GO_MASK_REGIONS.face;
}

export function GoButton({ ctl }: { ctl: RollControl }): ReactNode {
  const t = useTx();
  const [hover, setHover] = useState(false);
  const status = useSheetStatus('ui.goButton');
  const art = status === 'ready';
  const mask = useClassicAssets((s) => s.masks[GO_MASK_KEY] ?? null);
  const packId = useClassicAssets((s) => s.packId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 绑定（或换了）素材包后再取掩膜
  useEffect(() => {
    ensureClassicMask(GO_MASK_KEY);
  }, [packId]);
  if (ctl.spectator) return null;
  const frame = goFrame(ctl.ready, ctl.lock, hover);
  const state = !ctl.ready ? 'disabled' : ctl.lock === 'tortoise' ? 'tortoise' : hover ? 'hover' : 'normal';
  const label = !ctl.ready
    ? t('classic:go.disabled')
    : ctl.lock
      ? t(`hud:action.locked.${ctl.lock}`)
      : t('hud:action.roll', { n: ctl.chosen });
  return (
    <>
      <button
        type="button"
        className={c.go}
        style={regionStyle(GO_RECT)}
        disabled={!ctl.ready}
        aria-label={label}
        title={label}
        data-testid="action-roll"
        data-state={state}
        data-frame={frame}
        onPointerMove={(e) => setHover(onGoFace(mask, localPoint(e)))}
        onPointerLeave={() => setHover(false)}
        onClick={(e) => {
          // 键盘触发（detail 0）总是生效；鼠标 / 触摸点在钮面之外（透明四角、骰子数竖槽）不算
          if (e.detail !== 0 && !onGoFace(mask, localPoint(e))) return;
          ctl.roll();
        }}
      >
        {status === 'loading' ? null : art ? (
          <Sprite sheet="ui.goButton" frame={frame} x={0} y={0} />
        ) : (
          <span className={c.goFallback} aria-hidden="true">
            {ctl.lock === 'tortoise' ? '' : 'GO'}
          </span>
        )}
        {/* 与程序化行动区同样的文字（读屏与 E2E：原版皮肤下为「擲骰（1 顆）」） */}
        <span className={c.srOnly}>{label}</span>
      </button>
      <button
        type="button"
        className={c.diceCount}
        style={regionStyle(DICE_COUNT_RECT)}
        disabled={!ctl.canChooseDice}
        onClick={ctl.cycleDice}
        aria-label={t('classic:go.diceCount', { n: ctl.chosen })}
        title={t('classic:go.diceCount', { n: ctl.chosen })}
        data-testid="action-dice-count"
        data-value={ctl.chosen}
        data-active={ctl.canChooseDice ? 'true' : 'false'}
      >
        <Sprite
          sheet="ui.goButton"
          frame={diceCountFrame(ctl.chosen, ctl.canChooseDice)}
          x={DICE_COUNT_SPRITE.x}
          y={DICE_COUNT_SPRITE.y}
          testId="dice-count-sprite"
          fallback={
            <span className={c.diceCountFallback} aria-hidden="true">
              {ctl.chosen}
            </span>
          }
        />
      </button>
    </>
  );
}
