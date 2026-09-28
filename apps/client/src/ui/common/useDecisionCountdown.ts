// 中央决策倒计时的数据源（ui/common/DecisionCountdown）：跟随本人当前的决策（countdownLogic.countdownTarget 的条件），
// 按 time:ping 校准的服务器时钟算剩余整秒，最后 10 秒每跨过一个整秒放一声提示音（countdownSound）。
// - 定时器对齐到整秒边界（每秒一次，不是每帧）：只有用到这个 hook 的小组件在秒数变化时重渲染，不牵动整棵树；
// - 提交（gameStore.submitting）、到点、决策换掉或截止时间变为 null（暂停）时立即停：清掉定时器与还没响的双响第二声；
// - 切到后台时浏览器节流定时器，回到前台（visibilitychange）立即按当前时间重算：只可能响「当前这一秒」，
//   之前被跳过的秒不补播；同一截止时间下每个整秒最多响一次（全页共用一个闸门，键只看截止时间：两处挂载、重挂载、
//   回合菜单换了 decisionId 重发而截止时间没变，都不会重复）；
// - 断线（连接状态不是 open）时不显示、不响：重连遮罩挡着画面，重连后 resetTo 带回的决策与截止时间重新计时。
import type { RoomView } from '@rich4/shared/net';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useConnectionStore } from '../../store/connectionStore';
import { useGameStore } from '../../store/gameStore';
import { mySeat } from '../../store/roomStore';
import { useServerNow } from '../decisions/clock';
import {
  BeepGate,
  type BeepLevel,
  beepKey,
  COUNTDOWN_FINAL_S,
  COUNTDOWN_URGENT_S,
  type CountdownTarget,
  countdownOnline,
  countdownTarget,
  msToNextSecond,
  secsLeft,
} from './countdownLogic';
import { playCountdownBeep, prepareCountdownSound } from './countdownSound';

export interface DecisionCountdownState {
  target: CountdownTarget;
  /** 剩余整秒（≥1；到点后整个状态为 null） */
  secs: number;
  /** 最后 10 秒 */
  urgent: boolean;
  /** 最后 3 秒 */
  final: boolean;
}

/** 放一声提示音；返回取消函数（取消还没响的双响第二声） */
export type CountdownBeepFn = (level: BeepLevel, info: { decisionId: string; secs: number }) => () => void;

export interface UseDecisionCountdownOptions {
  /** 服务器时间（缺省取 DecisionClockContext：Date.now() + 时钟偏移） */
  now?: () => number;
  /** 提示音（缺省 countdownSound.playCountdownBeep） */
  beep?: CountdownBeepFn;
  /** 倒计时出现时的准备（缺省预载提示音） */
  prepare?: () => void;
  /** 去重闸门（缺省全页共用一个；只在挂载时取一次） */
  gate?: BeepGate;
}

const sharedGate = new BeepGate();

/** 测试：清空全页共用的提示音闸门 */
export function resetCountdownGateForTest(): void {
  sharedGate.reset();
}

/** 本人当前决策的中央倒计时；不显示时为 null（room 为 null 视为观战者） */
export function useDecisionCountdown(
  room: RoomView | null,
  o: UseDecisionCountdownOptions = {},
): DecisionCountdownState | null {
  const decision = useGameStore((s) => s.decision);
  const submitting = useGameStore((s) => s.submitting);
  const me = mySeat(room);
  const control = me === null ? null : (room?.seats[me]?.control ?? 'human');
  const online = useConnectionStore((s) => countdownOnline(s.status));
  const target = useMemo(
    () => countdownTarget(decision, submitting, control, online),
    [decision, submitting, control, online],
  );
  const now = useServerNow(o.now);
  const nowRef = useRef(now);
  nowRef.current = now;
  const beepRef = useRef<CountdownBeepFn>(o.beep ?? playCountdownBeep);
  beepRef.current = o.beep ?? playCountdownBeep;
  const prepareRef = useRef(o.prepare ?? prepareCountdownSound);
  prepareRef.current = o.prepare ?? prepareCountdownSound;
  const gate = useRef(o.gate ?? sharedGate).current;

  // 提示音闸门的键只看截止时间（countdownLogic.beepKey）；定时器按「决策 + 截止时间」重启（提示音记录带上当前的 decisionId）
  const gateKey = target ? beepKey(target) : null;
  const key = target ? `${target.decisionId}${gateKey}` : null;
  // 秒数与它所属的键一起存：键刚变、effect 还没跑时不显示上一个决策的秒数
  const [tick, setTick] = useState<{ key: string; secs: number } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: target 由 key 代表（决策 id + 截止时间，gateKey 随之确定）；now 变化（时钟重新校准）时立即重算；gate 挂载后不变
  useEffect(() => {
    if (!target || key === null || gateKey === null) {
      setTick(null);
      return;
    }
    const { decisionId, deadlineAt } = target;
    prepareRef.current();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelEcho: (() => void) | null = null;
    const run = (): void => {
      timer = null;
      const ms = deadlineAt - nowRef.current();
      const secs = secsLeft(ms);
      setTick((cur) => (cur && cur.key === key && cur.secs === secs ? cur : { key, secs }));
      if (secs <= 0) return;
      const level = gate.take(gateKey, secs);
      if (level) {
        cancelEcho?.();
        cancelEcho = beepRef.current(level, { decisionId, secs });
      }
      timer = setTimeout(run, msToNextSecond(ms));
    };
    run();
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
      if (timer !== null) clearTimeout(timer);
      run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer !== null) clearTimeout(timer);
      cancelEcho?.();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, now]);

  if (!target || key === null) return null;
  const secs = tick && tick.key === key ? tick.secs : secsLeft(target.deadlineAt - now());
  if (secs <= 0) return null;
  return { target, secs, urgent: secs <= COUNTDOWN_URGENT_S, final: secs <= COUNTDOWN_FINAL_S };
}
