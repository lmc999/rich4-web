// GO 钮（Panel#7：图0 常态 / 1 悬停 / 2 禁止 / 3 禁止悬停 / 4–5 乌龟；图6–11 骰子数小图 15×15；命中掩膜 Panel#8）。
// 行为与行动区的掷骰按钮一致：只在「我的 TURN_MENU 已就绪（动画播完）且未提交」时可按，带上选中的骰子数；
// 骰子数竖槽按原版 fcn.004169f6 画：交通工具的上限个小骰子竖着叠放（步行 / 工程车 1、机车 2、汽车 3），
// 前「骰子数」个画亮图、其余（或停留时全部）画灰图（layout.diceSlotIcons）；点第 i 个小骰子把颗数设为 i+1
// （原版 fcn.00417623 0x417a37–0x417a9a），D 键在允许的颗数之间循环（原版 0x4012c9–0x4012ff）。选过的颗数本回合里一直有效，
// 换车时作废（useDiceChoice）。停留时 GO 画「停留」帧 2/3（goFrame）。用鼠标 / 触摸按下 GO 或点竖槽时放原版的点击声
// Effect#1（cue.ui.go，0x417ac9 / 0x417a08），键盘不出声。data-testid 沿用 action-roll（E2E 两种布局同一套选择器）。
//
// 素材按像素核对过（真实素材包，只在本机裁图，不入库）：
// - 骰子数小图两两成对：图6/7 = 第 1 颗（1 点，灰 / 白底红点），图8/9 = 第 2 颗（2 点），图10/11 = 第 3 颗（3 点）；
// - 掩膜 Panel#8 没有 0：区 1 = 左侧深紫竖槽（x7..22、y9..56，正好放下 1–3 个 15×15 的小骰子）、区 2 = 紫色边框、
//   区 3 = GO 钮面、区 4 = 钮外的透明四角。按下只认区 2、3；骰子数小图画在区 1 竖槽里。
import { VEHICLE_MAX_DICE } from '@rich4/shared/data';
import type { DiceCount } from '@rich4/shared/engine';
import type { RoomView } from '@rich4/shared/net';
import { isDecisionForYouOf } from '@rich4/shared/view';
import { type MouseEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { useClient } from '../../app/services';
import { useTx } from '../../i18n/tx';
import { useGameStore } from '../../store/gameStore';
import { mySeat } from '../../store/roomStore';
import { useDiceChoice } from '../common/useDiceChoice';
import { ensureClassicMask, GO_MASK_KEY, type MaskAsset, maskRegion, useClassicAssets } from './assets';
import c from './classic.module.css';
import { DICE_COUNT_RECT, diceSlotIcons, GO_RECT, regionStyle } from './layout';
import { Sprite, useSheetStatus } from './Sprite';
import { playScreenCue, warmScreenCues } from './screens/uiSound';

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
  /** 竖槽里小骰子的个数（交通工具的上限：步行 / 工程车 1、机车 2、汽车 3） */
  slots: number;
  /** 竖槽里亮着的颗数：本人 TURN_MENU 时为要掷的颗数，否则为引擎记着的骰子数 */
  shown: number;
  /** 停留：竖槽全灰（原版 p+0x30） */
  stay: boolean;
  roll(): void;
  /** 切到下一个允许的颗数 */
  cycleDice(): void;
  /** 直接选颗数（点竖槽里第 n 个小骰子） */
  pickDice(n: number): void;
}

export function useRollControl(room: RoomView): RollControl {
  const client = useClient();
  const decision = useGameStore((s) => s.decision);
  const submitting = useGameStore((s) => s.submitting);
  const view = useGameStore((s) => s.view);
  const me = mySeat(room);
  const turn = me !== null && decision && isDecisionForYouOf(decision, 'TURN_MENU') ? decision : null;
  const ready = turn !== null && submitting !== turn.decisionId;
  const dice = turn?.options.dice;
  const lock = dice?.locked ?? null;
  const allowed: readonly DiceCount[] = dice?.allowed ?? [];
  const decisionId = turn?.decisionId ?? null;
  // 选过的颗数在本回合里一直有效（用卡、用道具后引擎换 decisionId 重发 TURN_MENU 也不丢），换车时作废（useDiceChoice）
  const { chosen, pick } = useDiceChoice(turn);
  const canChooseDice = ready && lock === null && allowed.length > 1;
  // 不是本人的 TURN_MENU（别人的回合、掷出之后）：竖槽照样按本人的交通工具与引擎记着的骰子数画
  const self = me === null ? undefined : view?.players.find((p) => p.seat === me);
  const slots = dice ? Math.max(1, allowed.length) : self ? VEHICLE_MAX_DICE[self.vehicle] : 1;
  const shown = dice ? chosen : (self?.diceCount ?? 1);
  const stay = dice ? lock === 'stay' : self ? self.st.stay !== 0 : false;
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
    pick(allowed[(i + 1) % allowed.length]!);
  }, [canChooseDice, allowed, chosen, pick]);
  const pickDice = useCallback(
    (n: number) => {
      if (!canChooseDice || !allowed.includes(n as DiceCount)) return;
      pick(n as DiceCount);
    },
    [canChooseDice, allowed, pick],
  );
  return {
    spectator: me === null,
    ready,
    lock,
    allowed,
    chosen,
    canChooseDice,
    slots,
    shown,
    stay,
    roll,
    cycleDice,
    pickDice,
  };
}

/**
 * GO 钮的帧（奇数为悬停）：原版 fcn.004169f6 底图帧 = 悬停 + (停留 p+0x30 ? 2 : 0)，乌龟 p+0x31 时改为 4
 * （0x416ab4–0x416ad9，0x416b18 画 Panel#7 帧 [0x488b4c]+ebx）——停留画「停留」帧 2/3，与同一判断下全灰的骰子数竖槽一致；
 * 乌龟 4/5；常态 0/1。不是本人可按的时候（原版此时隐去 GO 钮）借用停留帧 2/3 作禁止态
 */
export function goFrame(ready: boolean, lock: RollControl['lock'], hover: boolean): number {
  const base = !ready ? 2 : lock === 'tortoise' ? 4 : lock === 'stay' ? 2 : 0;
  return base + (hover ? 1 : 0);
}

/** 离纵坐标 y（GO 钮内）最近的小骰子下标（小骰子 15×15，按中心比较） */
export function nearestIcon(icons: readonly { y: number }[], y: number): number {
  let best = 0;
  for (let i = 1; i < icons.length; i++) {
    if (Math.abs(icons[i]!.y + 7.5 - y) < Math.abs(icons[best]!.y + 7.5 - y)) best = i;
  }
  return best;
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
  // 先载入音频模块：第一次按 GO 的点击声不因模块还没载入而跳过
  useEffect(() => {
    if (!ctl.spectator) warmScreenCues();
  }, [ctl.spectator]);
  if (ctl.spectator) return null;
  const frame = goFrame(ctl.ready, ctl.lock, hover);
  const icons = diceSlotIcons(ctl.slots, ctl.shown, ctl.stay);
  const state = !ctl.ready
    ? 'disabled'
    : ctl.lock === 'tortoise'
      ? 'tortoise'
      : ctl.lock === 'stay'
        ? 'stay'
        : hover
          ? 'hover'
          : 'normal';
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
          // 鼠标 / 触摸按下 GO：先放原版的点击声 Effect#1（exe 0x417ac9，在隐去 GO、开始掷骰之前）；键盘的 GO 原版不出声
          // （0x40126d–0x401283 直接隐去 GO、开始掷骰）
          if (e.detail !== 0 && ctl.ready) playScreenCue('go');
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
        onClick={(e) => {
          // 键盘触发（detail 0）循环切换；鼠标 / 触摸点在第 i 个小骰子上（按纵坐标取最近的一个）就选 i+1 颗
          if (e.detail === 0) {
            ctl.cycleDice();
            return;
          }
          const r = e.currentTarget.getBoundingClientRect();
          const y = ((e.clientY - r.top) * DICE_COUNT_RECT.h) / Math.max(1, r.height) + DICE_COUNT_RECT.y - GO_RECT.y;
          // 原版点竖槽（未停留）先放同一声 Effect#1（0x417a08），再按点到的小骰子改颗数；D 键不出声
          playScreenCue('go');
          ctl.pickDice(nearestIcon(icons, y) + 1);
        }}
        aria-label={t('classic:go.diceCount', { n: ctl.shown })}
        title={t('classic:go.diceCount', { n: ctl.shown })}
        data-testid="action-dice-count"
        data-value={ctl.shown}
        data-slots={icons.length}
        data-active={ctl.canChooseDice ? 'true' : 'false'}
      >
        {icons.map((ic, i) => {
          const x = ic.x - (DICE_COUNT_RECT.x - GO_RECT.x);
          const y = ic.y - (DICE_COUNT_RECT.y - GO_RECT.y);
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: 竖槽里的位置固定
              key={i}
              className={c.diceIcon}
              style={{ left: x, top: y }}
              data-testid="dice-count-die"
              data-index={i}
              data-on={ic.on ? 'true' : 'false'}
              data-frame={ic.frame}
            >
              <Sprite
                sheet="ui.goButton"
                frame={ic.frame}
                x={0}
                y={0}
                fallback={
                  <span className={c.diceCountFallback} data-on={ic.on ? 'true' : 'false'} aria-hidden="true">
                    {i + 1}
                  </span>
                }
              />
            </span>
          );
        })}
      </button>
    </>
  );
}
