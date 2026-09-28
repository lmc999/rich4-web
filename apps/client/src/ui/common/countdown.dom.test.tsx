// 画面中央的决策倒计时（client-dom）：
// - useDecisionCountdown：剩余整秒、最后 10 秒每秒一声（最后 3 秒 final）、提交后停止并取消双响第二声、到点隐藏、
//   后台回来不补播、deadline 为 null / 托管 / 观战 / 小游戏不显示、两处挂载同一秒只响一次；
// - DecisionCountdown：role=timer 与 aria-label、只在进入最后 10 秒写一次 aria-live、不可聚焦、摆放（center / top / stage）、
//   回合横幅期间让位；原版布局经 portal 挂到经典舞台容器上且层级高于原版场景；样式层 pointer-events: none；
// - 两种布局（GameScreen 程序化 / 经典）都挂着倒计时。
// Pixi 不在 jsdom 挂载：BoardCanvas 用替身；皮肤判定直接给结果。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { YourDecision } from '@rich4/shared/net';
import { act, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientProvider } from '../../app/services';
import { useConnectionStore } from '../../store/connectionStore';
import { useGameStore } from '../../store/gameStore';
import { useMapStore } from '../../store/mapStore';
import { useUiStore } from '../../store/uiStore';
import { makeTestClient } from '../../test/fakeTransport';
import { ai, human, roomView } from '../../test/roomFixtures';
import { selfPlay } from '../../test/selfPlay';
import { CLASSIC_COUNTDOWN_Z, ClassicCountdown } from '../classic/ClassicCountdown';
import { ClassicStage } from '../classic/ClassicStage';
import { useSceneCoverStore } from '../classic/common/sceneCover';
import { SCENE_Z } from '../classic/common/stage';
import { CountdownRing, useRemainingMs } from '../components/Countdown';
import { useServerNow } from '../decisions/clock';
import GameScreen from '../screens/GameScreen';
import { BeepGate } from './countdownLogic';
import { anchorAboveDialog, countdownPlace, DecisionCountdown, dialogAnchor } from './DecisionCountdown';
import {
  type CountdownBeepFn,
  resetCountdownGateForTest,
  type UseDecisionCountdownOptions,
  useDecisionCountdown,
} from './useDecisionCountdown';

vi.mock('../screens/BoardCanvas', () => ({
  BoardCanvas: () => <div data-testid="board-host">board</div>,
}));

const skinMock = vi.hoisted(() => ({ skin: 'procedural' as 'original' | 'procedural' }));
vi.mock('../../skin/useGameSkin', () => ({
  useGameSkin: () => ({
    resolution: {
      pref: 'auto',
      skin: skinMock.skin,
      board: 'procedural',
      reason: skinMock.skin === 'original' ? null : 'pack-absent',
      boardReason: 'renderer-unavailable',
      mismatches: [],
      mapId: 'test',
      packId: null,
    },
    waitForPack: false,
  }),
}));

const room = roomView({
  phase: 'playing',
  epoch: 1,
  seats: [human(0, '我', { isYou: true, host: true }), ai(1), human(2, '小红'), ai(3)],
});
const spectatorRoom = roomView({
  phase: 'playing',
  epoch: 1,
  seats: [human(0, '甲'), ai(1), human(2, '乙'), ai(3)],
  you: { role: 'spectator', id: 's1', isHost: false } as never,
});

const T0 = 1_800_000_000_000;

function decision(over: Partial<YourDecision> = {}): YourDecision {
  return {
    decisionId: 'd1',
    seat: 0,
    kind: 'TURN_MENU',
    timing: 'menu',
    options: {} as YourDecision['options'],
    defaultIntent: { type: 'ROLL' },
    deadlineAt: null,
    ...over,
  };
}

function setDecision(d: YourDecision | null): void {
  act(() => useGameStore.setState({ decision: d, submitting: null }));
}

interface Beep {
  id: string;
  secs: number;
  level: string;
}

function recorder() {
  const beeps: Beep[] = [];
  const cancels: ReturnType<typeof vi.fn>[] = [];
  const beep: CountdownBeepFn = (level, info) => {
    beeps.push({ id: info.decisionId, secs: info.secs, level });
    const c = vi.fn();
    cancels.push(c);
    return c;
  };
  return { beeps, cancels, beep, secs: () => beeps.map((b) => b.secs) };
}

function Probe({ r = room, o }: { r?: typeof room; o: UseDecisionCountdownOptions }): ReactNode {
  const cd = useDecisionCountdown(r, o);
  return (
    <output
      data-testid="probe"
      data-secs={cd?.secs ?? ''}
      data-urgent={cd ? String(cd.urgent) : ''}
      data-final={cd ? String(cd.final) : ''}
    />
  );
}

const probe = () => screen.getByTestId('probe');

function tick(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
  resetCountdownGateForTest();
  useMapStore.getState().clear();
});

afterEach(() => {
  vi.useRealTimers();
  useGameStore.getState().clear();
  useUiStore.getState().clear();
  useConnectionStore.getState().reset();
  useSceneCoverStore.setState({ covers: [] });
  skinMock.skin = 'procedural';
});

describe('useDecisionCountdown', () => {
  it('剩余整秒；10 秒以上不响；最后 10 秒每跨过一个整秒响一次（最后 3 秒 final）；到点隐藏且不再响', () => {
    const r = recorder();
    setDecision(decision({ deadlineAt: T0 + 12_500 }));
    render(<Probe o={{ beep: r.beep, prepare: () => {} }} />);
    expect(probe()).toHaveAttribute('data-secs', '13');
    expect(probe()).toHaveAttribute('data-urgent', 'false');
    tick(500);
    expect(probe()).toHaveAttribute('data-secs', '12');
    tick(1000);
    expect(probe()).toHaveAttribute('data-secs', '11');
    expect(r.beeps).toEqual([]);
    tick(1000);
    expect(probe()).toHaveAttribute('data-secs', '10');
    expect(probe()).toHaveAttribute('data-urgent', 'true');
    expect(r.beeps).toEqual([{ id: 'd1', secs: 10, level: 'tick' }]);
    tick(7000);
    expect(probe()).toHaveAttribute('data-secs', '3');
    expect(probe()).toHaveAttribute('data-final', 'true');
    tick(2999);
    expect(probe()).toHaveAttribute('data-secs', '1');
    expect(r.secs()).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(r.beeps.map((b) => b.level)).toEqual([...Array(7).fill('tick'), 'final', 'final', 'final']);
    tick(1);
    expect(probe()).toHaveAttribute('data-secs', '');
    tick(10_000);
    expect(r.beeps).toHaveLength(10);
  });

  it('提交后立即停止：隐藏、不再响、取消还没响的双响第二声', () => {
    const r = recorder();
    setDecision(decision({ deadlineAt: T0 + 2_500 }));
    render(<Probe o={{ beep: r.beep, prepare: () => {} }} />);
    expect(probe()).toHaveAttribute('data-secs', '3');
    expect(r.beeps).toEqual([{ id: 'd1', secs: 3, level: 'final' }]);
    act(() => useGameStore.getState().setSubmitting('d1'));
    expect(probe()).toHaveAttribute('data-secs', '');
    expect(r.cancels[0]).toHaveBeenCalled();
    tick(5000);
    expect(r.beeps).toHaveLength(1);
  });

  it('切到后台再回来不补播：定时器被节流期间跨过的秒不响，回来只响当前这一秒', () => {
    const r = recorder();
    setDecision(decision({ deadlineAt: T0 + 9_500 }));
    render(<Probe o={{ beep: r.beep, prepare: () => {} }} />);
    expect(r.secs()).toEqual([10]);
    // 后台：时间过去 5 秒，定时器一次都没跑（浏览器节流）
    act(() => vi.setSystemTime(T0 + 5_000));
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(probe()).toHaveAttribute('data-secs', '5');
    expect(r.secs()).toEqual([10, 5]);
    // 之后照常每秒一次，旧的定时器已清掉，不会多响
    tick(500);
    expect(r.secs()).toEqual([10, 5, 4]);
    vis.mockRestore();
  });

  it('deadline 为 null（不限时、暂停中）/ 托管 / 观战 / 小游戏：不显示、不响', () => {
    const r = recorder();
    const o = { beep: r.beep, prepare: () => {} };
    setDecision(decision({ deadlineAt: null }));
    const { rerender } = render(<Probe o={o} />);
    expect(probe()).toHaveAttribute('data-secs', '');
    setDecision(decision({ kind: 'MINIGAME', deadlineAt: T0 + 5_000 }));
    expect(probe()).toHaveAttribute('data-secs', '');
    setDecision(decision({ deadlineAt: T0 + 5_000 }));
    expect(probe()).toHaveAttribute('data-secs', '5');
    const auto = roomView({
      ...room,
      seats: room.seats.map((st, i) => (i === 0 ? { ...st, control: 'autopilot:manual' } : st)) as typeof room.seats,
    });
    rerender(<Probe r={auto} o={o} />);
    expect(probe()).toHaveAttribute('data-secs', '');
    rerender(<Probe r={spectatorRoom} o={o} />);
    expect(probe()).toHaveAttribute('data-secs', '');
    // 暂停：服务器把截止时间改成 null
    rerender(<Probe o={o} />);
    expect(probe()).toHaveAttribute('data-secs', '5');
    setDecision(decision({ deadlineAt: null }));
    expect(probe()).toHaveAttribute('data-secs', '');
    tick(10_000);
    // 只有显示过的那一秒（5）响过
    expect(r.secs()).toEqual([5]);
  });

  it('两处挂载同一决策（或重挂载）：全页共用的闸门让同一秒只响一次；截止时间变了重新计', () => {
    const r = recorder();
    setDecision(decision({ deadlineAt: T0 + 4_500 }));
    const { unmount } = render(
      <>
        <Probe o={{ beep: r.beep, prepare: () => {} }} />
        <Probe o={{ beep: r.beep, prepare: () => {} }} />
      </>,
    );
    tick(1000);
    expect(r.secs()).toEqual([5, 4]);
    unmount();
    render(<Probe o={{ beep: r.beep, prepare: () => {} }} />);
    expect(r.secs()).toEqual([5, 4]);
    tick(1000);
    expect(r.secs()).toEqual([5, 4, 3]);
    // 解除托管 / 暂停恢复：同一决策换了截止时间，重新计
    setDecision(decision({ deadlineAt: T0 + 2_000 + 9_500 }));
    expect(r.secs()).toEqual([5, 4, 3, 10]);
  });

  // 回归（复审）：去重键曾带 decisionId——回合菜单里用卡、买股票后服务器用新 id 重发 TURN_MENU，截止时间常常不变，
  // 闸门被重置，同一秒可能 0.3 秒内响两次。现在键只看截止时间。
  it('回合菜单重发决策（新 decisionId、截止时间不变）：同一秒不重响，之后的秒照常；截止时间变了才重新计', () => {
    const r = recorder();
    setDecision(decision({ deadlineAt: T0 + 9_900 }));
    render(<Probe o={{ beep: r.beep, prepare: () => {} }} />);
    expect(r.beeps).toEqual([{ id: 'd1', secs: 10, level: 'tick' }]);
    // 玩家在回合菜单里用卡：提交 → 隐藏；0.3 秒后服务器用新 id 重发，截止时间没变
    act(() => useGameStore.getState().setSubmitting('d1'));
    tick(300);
    setDecision(decision({ decisionId: 'd2', deadlineAt: T0 + 9_900 }));
    expect(probe()).toHaveAttribute('data-secs', '10');
    expect(r.secs()).toEqual([10]);
    tick(600);
    expect(r.beeps).toEqual([
      { id: 'd1', secs: 10, level: 'tick' },
      { id: 'd2', secs: 9, level: 'tick' },
    ]);
    // 批尾直接换 id（没有提交空档）：同样不重响
    setDecision(decision({ decisionId: 'd3', deadlineAt: T0 + 9_900 }));
    expect(r.secs()).toEqual([10, 9]);
    // 链被延长（截止时间变了）：重新计
    setDecision(decision({ decisionId: 'd4', deadlineAt: T0 + 9_900 + 300 }));
    expect(r.secs()).toEqual([10, 9, 10]);
  });

  // 回归（复审）：断线时 gameStore.decision 不清，重连遮罩挡着画面，倒计时却照常走、照常响急促的提示音
  it('断线：立即隐藏、不再响、取消还没响的双响第二声；重连后按当前（服务器带回的）截止时间重新计时', () => {
    const r = recorder();
    act(() => useConnectionStore.getState().setStatus('open', 0));
    setDecision(decision({ deadlineAt: T0 + 10_500 }));
    render(<Probe o={{ beep: r.beep, prepare: () => {} }} />);
    expect(probe()).toHaveAttribute('data-secs', '11');
    tick(500);
    expect(r.secs()).toEqual([10]);
    act(() => useConnectionStore.getState().setStatus('reconnecting', 1));
    expect(probe()).toHaveAttribute('data-secs', '');
    // 断线期间跨过 9…3 秒：一声都不响
    tick(7_000);
    expect(r.secs()).toEqual([10]);
    act(() => useConnectionStore.getState().setStatus('closed', 3));
    tick(500);
    expect(r.secs()).toEqual([10]);
    // 重连：resetTo 带回新的决策与截止时间（服务器按断线宽限改过）
    act(() => useConnectionStore.getState().setStatus('open', 0));
    setDecision(decision({ decisionId: 'd2', deadlineAt: Date.now() + 4_500 }));
    expect(probe()).toHaveAttribute('data-secs', '5');
    expect(r.beeps.at(-1)).toEqual({ id: 'd2', secs: 5, level: 'tick' });
    // 双响第二声还没响时断线：取消
    tick(2_500);
    expect(r.beeps.at(-1)).toEqual({ id: 'd2', secs: 2, level: 'final' });
    const lastCancel = r.cancels.at(-1)!;
    act(() => useConnectionStore.getState().setStatus('reconnecting', 1));
    expect(lastCancel).toHaveBeenCalled();
    expect(probe()).toHaveAttribute('data-secs', '');
  });

  it('自带闸门时互不影响（测试注入）', () => {
    const r = recorder();
    setDecision(decision({ deadlineAt: T0 + 1_500 }));
    render(
      <>
        <Probe o={{ beep: r.beep, prepare: () => {}, gate: new BeepGate() }} />
        <Probe o={{ beep: r.beep, prepare: () => {}, gate: new BeepGate() }} />
      </>,
    );
    expect(r.secs()).toEqual([2, 2]);
  });
});

describe('DecisionCountdown', () => {
  const quiet = (): UseDecisionCountdownOptions => ({ beep: () => () => {}, prepare: () => {} });

  it('程序化布局：role=timer + aria-label；不可聚焦；只在进入最后 10 秒写一次 aria-live；提交后消失', () => {
    setDecision(decision({ deadlineAt: T0 + 11_500 }));
    const { container } = render(<DecisionCountdown room={room} variant="hud" options={quiet()} />);
    const timer = screen.getByRole('timer');
    expect(timer).toHaveAttribute('data-testid', 'decision-countdown');
    expect(timer).toHaveAttribute('data-variant', 'hud');
    expect(timer).toHaveAttribute('aria-label', i18next.t('hud:countdown.aria', { n: 12 }));
    expect(timer).toHaveTextContent('12');
    expect(timer).not.toHaveAttribute('tabindex');
    expect(container.querySelectorAll('button, a, input, select, textarea, [tabindex]')).toHaveLength(0);
    const live = screen.getByTestId('decision-countdown-live');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('');
    tick(1500);
    expect(screen.getByRole('timer')).toHaveAttribute('data-urgent', 'true');
    const hurry = i18next.t('hud:countdown.hurry', { n: 10 });
    expect(live).toHaveTextContent(hurry);
    tick(3000);
    // 秒数继续变化，播报不重写
    expect(screen.getByRole('timer')).toHaveTextContent('7');
    expect(live).toHaveTextContent(hurry);
    act(() => useGameStore.getState().setSubmitting('d1'));
    expect(screen.queryByRole('timer')).toBeNull();
    expect(live).toHaveTextContent('');
  });

  // 回归（复审）：圆环 / 侧栏按 200ms 轮询、最后 5 秒才变红，与中央倒计时（整秒对齐、10 秒变红）同屏时差 1 秒、一红一绿
  it('同屏的圆环（侧栏、等待条同一个 useRemainingMs）与中央倒计时在同一时刻换秒、同一档变红', () => {
    const deadlineAt = T0 + 12_345;
    setDecision(decision({ deadlineAt }));
    function Ring(): ReactNode {
      const now = useServerNow();
      const { remainingMs, totalMs } = useRemainingMs(deadlineAt, now, 'd1');
      return <CountdownRing remainingMs={remainingMs} totalMs={totalMs} />;
    }
    render(
      <>
        <DecisionCountdown room={room} variant="hud" options={quiet()} />
        <Ring />
      </>,
    );
    let urgentSeen = false;
    for (let t = 0; t < 12_300; t += 37) {
      const center = screen.getByTestId('decision-countdown');
      const ring = screen.getByTestId('countdown');
      expect(ring.textContent, `t=${t}`).toBe(center.getAttribute('data-secs'));
      expect(ring.getAttribute('data-urgent'), `t=${t}`).toBe(center.getAttribute('data-urgent'));
      if (center.getAttribute('data-urgent') === 'true') urgentSeen = true;
      tick(37);
    }
    expect(urgentSeen).toBe(true);
  });

  it('摆放：等掷骰在中线偏上（center），决策框在中央避让（top），回合横幅显示期间 center 让位', () => {
    setDecision(decision({ deadlineAt: T0 + 20_000 }));
    render(<DecisionCountdown room={room} variant="hud" options={quiet()} />);
    const timer = () => screen.getByTestId('decision-countdown');
    expect(timer()).toHaveAttribute('data-place', 'center');
    expect(timer()).toHaveAttribute('data-yield', 'false');
    act(() => {
      useUiStore.getState().showBanner({ kind: 'turn', title: '轮到你了' });
    });
    expect(timer()).toHaveAttribute('data-yield', 'true');
    act(() => useUiStore.getState().hideBanner());
    expect(timer()).toHaveAttribute('data-yield', 'false');
    // 展开回合菜单：对话框在中央。jsdom 量不到对话框（也没有圆环）：放不下 → 隐去（data-anchor="none"）
    act(() => useUiStore.getState().openMenu(null));
    expect(timer()).toHaveAttribute('data-place', 'top');
    expect(timer()).toHaveAttribute('data-anchor', 'none');
    act(() => useUiStore.getState().openPanel(null));
    expect(timer()).toHaveAttribute('data-place', 'center');
    setDecision(decision({ decisionId: 'd2', kind: 'BUY_LAND', timing: 'confirm', deadlineAt: T0 + 20_000 }));
    expect(timer()).toHaveAttribute('data-place', 'top');
    expect(timer()).toHaveAttribute('data-kind', 'BUY_LAND');
  });

  it('countdownPlace / anchorAboveDialog / dialogAnchor', () => {
    expect(countdownPlace('TURN_MENU', null, false)).toBe('center');
    expect(countdownPlace('TURN_MENU', 'cards', false)).toBe('center');
    expect(countdownPlace('TURN_MENU', 'menu', false)).toBe('top');
    expect(countdownPlace('BANK_ATM', null, false)).toBe('top');
    expect(countdownPlace('TURN_MENU', null, true)).toBe('stage');
    const layer = new DOMRect(0, 66, 1620, 904);
    // 对话框上方留有 200px：小牌底边落在对话框上缘之上 8px、水平居中
    expect(anchorAboveDialog(layer, new DOMRect(500, 266, 400, 300))).toEqual({ x: 700, y: 192, mode: 'dialog' });
    // 放不下（对话框顶着决策层上缘）
    expect(anchorAboveDialog(layer, new DOMRect(500, 90, 400, 700))).toBeNull();
    expect(anchorAboveDialog(layer, new DOMRect(0, 0, 0, 0))).toBeNull();
    // 回归（复审）：手机横屏 844×390，决策层只有两百多像素高，对话框上方放不下 → 叠到对话框标题栏里圆环的左边
    // （小牌右边中点离圆环 8px、与圆环垂直居中），不再整个隐去
    const phone = new DOMRect(0, 48, 644, 266);
    const dialog = new DOMRect(84, 52, 476, 258);
    const ring = new DOMRect(500, 62, 44, 44);
    expect(dialogAnchor(phone, dialog, ring)).toEqual({ x: 492, y: 36, mode: 'ring' });
    expect(dialogAnchor(phone, dialog, null)).toBeNull();
    expect(dialogAnchor(phone, dialog, new DOMRect(0, 0, 0, 0))).toBeNull();
    // 上方放得下时仍在正上方
    expect(dialogAnchor(layer, new DOMRect(500, 266, 400, 300), ring)).toEqual({ x: 700, y: 192, mode: 'dialog' });
  });

  it('程序化布局：对话框上方放不下时摆到圆环左边（data-anchor="ring"，内联 left/top）', () => {
    setDecision(decision({ kind: 'BUY_LAND', timing: 'confirm', deadlineAt: T0 + 20_000 }));
    // 模拟手机横屏的决策层与对话框（jsdom 没有布局，直接给矩形）
    const rects = new Map<string, DOMRect>([
      ['layer', new DOMRect(0, 48, 644, 266)],
      ['dialog', new DOMRect(84, 52, 476, 258)],
      ['ring', new DOMRect(500, 62, 44, 44)],
    ]);
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const k = this.getAttribute('data-rect');
      return (k && rects.get(k)) || new DOMRect(0, 0, 0, 0);
    });
    render(
      <>
        <div data-testid="decision-layer">
          <section role="dialog" data-rect="dialog">
            <span data-testid="countdown" data-rect="ring" />
          </section>
        </div>
        <DecisionCountdown room={room} variant="hud" options={quiet()} />
      </>,
    );
    const timer = screen.getByTestId('decision-countdown');
    (timer.parentElement as HTMLElement).setAttribute('data-rect', 'layer');
    tick(300);
    expect(timer).toHaveAttribute('data-place', 'top');
    expect(timer).toHaveAttribute('data-anchor', 'ring');
    expect(timer.style.left).toBe('492px');
    expect(timer.style.top).toBe('36px');
    spy.mockRestore();
  });

  it('程序化布局：左侧日志 / 聊天停靠栏开着时标 data-dock（center 的数字据此不越过停靠栏右缘）', () => {
    setDecision(decision({ deadlineAt: T0 + 20_000 }));
    render(<DecisionCountdown room={room} variant="hud" options={quiet()} />);
    const layer = () => screen.getByTestId('decision-countdown').parentElement!;
    expect(layer()).toHaveAttribute('data-dock', 'false');
    act(() => useUiStore.getState().setLogOpen(true));
    expect(layer()).toHaveAttribute('data-dock', 'true');
    act(() => {
      useUiStore.getState().setLogOpen(false);
      useUiStore.getState().setChatOpen(true);
    });
    expect(layer()).toHaveAttribute('data-dock', 'true');
    act(() => useUiStore.getState().setChatOpen(false));
    expect(layer()).toHaveAttribute('data-dock', 'false');
  });

  it('原版布局：经 portal 挂到经典舞台容器上（与舞台同一落点与缩放），层级高于原版场景；铺满舞台的场景开着时移到舞台顶端', () => {
    setDecision(decision({ deadlineAt: T0 + 20_000 }));
    render(
      <ClassicStage
        size={{ w: 1920, h: 1080 }}
        leftLabel="左"
        rightLabel="右"
        overlay={<ClassicCountdown room={room} options={quiet()} />}
      >
        <div />
      </ClassicStage>,
    );
    const layer = screen.getByTestId('decision-countdown-layer');
    expect(layer.parentElement).toBe(screen.getByTestId('classic-stage'));
    expect(CLASSIC_COUNTDOWN_Z).toBeGreaterThan(SCENE_Z);
    expect(layer.style.zIndex).toBe(String(CLASSIC_COUNTDOWN_Z));
    expect(layer.style.transform).toBe('scale(2.25)');
    expect(layer.style.left).toBe('240px');
    const timer = screen.getByRole('timer');
    expect(timer).toHaveAttribute('data-variant', 'classic');
    expect(timer).toHaveAttribute('data-place', 'center');
    let off = (): void => {};
    act(() => {
      off = useSceneCoverStore.getState().add();
    });
    expect(timer).toHaveAttribute('data-place', 'stage');
    expect([timer.style.left, timer.style.top]).toEqual(['320px', '2px']);
    // 场景指定的位置（股市：自己的圆环左边）；后登记的优先，关掉后回到先前的
    let off2 = (): void => {};
    act(() => {
      off2 = useSceneCoverStore.getState().add({ x: 572, y: 448 });
    });
    expect([timer.style.left, timer.style.top]).toEqual(['572px', '448px']);
    act(() => off2());
    expect([timer.style.left, timer.style.top]).toEqual(['320px', '2px']);
    act(() => off());
    expect(timer).toHaveAttribute('data-place', 'center');
    expect(timer.style.left).toBe('');
  });

  it('样式：整层不接收指针；最后 10 秒的脉动遵守 prefers-reduced-motion', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, 'countdown.module.css'), 'utf8');
    const rule = (sel: string): string => {
      const i = css.indexOf(`\n${sel} {`);
      expect(i, sel).toBeGreaterThanOrEqual(0);
      return css.slice(i, css.indexOf('}', i));
    };
    for (const sel of ['.hudLayer', '.classicLayer', '.countdown']) expect(rule(sel)).toContain('pointer-events: none');
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('animation: none');
  });
});

describe('两种布局都挂着中央倒计时', () => {
  const sp = selfPlay({ seed: 21, steps: 60 });

  function renderGame(): void {
    vi.useRealTimers();
    const b = sp.batches[10]!;
    const t = makeTestClient();
    act(() =>
      useGameStore.getState().resetTo({
        epoch: 1,
        seq: b.seq,
        view: b.view,
        pending: [],
        decision: decision({ deadlineAt: Date.now() + 60_000 }),
      }),
    );
    render(
      <ClientProvider client={t.client}>
        <GameScreen room={room} onLeave={() => {}} />
      </ClientProvider>,
    );
  }

  it('程序化布局', async () => {
    renderGame();
    const timer = await screen.findByTestId('decision-countdown');
    expect(timer).toHaveAttribute('data-variant', 'hud');
    expect(screen.queryByTestId('classic-stage')).toBeNull();
  });

  it('经典布局：挂在舞台容器上', async () => {
    skinMock.skin = 'original';
    renderGame();
    await screen.findByTestId('classic-stage');
    const timer = await screen.findByTestId('decision-countdown');
    expect(timer).toHaveAttribute('data-variant', 'classic');
    expect(screen.getByTestId('decision-countdown-layer').parentElement).toBe(screen.getByTestId('classic-stage'));
  });
});
