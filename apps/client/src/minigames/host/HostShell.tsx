// 宿主的 DOM 叠层（React）：标题、各游戏的 HUD（计时与得分）、开局倒计时、观战等待、结算大号分数。
// 由 MiniGameHost 在自己的 React root 里渲染；状态经 useSyncExternalStore 订阅（每个 tick 至多更新一次）。
import type { SimBase } from '@rich4/shared/minigames';
import { type ComponentType, type ReactNode, useSyncExternalStore } from 'react';
import { mgName, mgText } from '../text';
import type { HostMode, HudProps } from '../types';
import s from './host.module.css';

export type HostPhase = 'loading' | 'countdown' | 'playing' | 'waiting' | 'result' | 'closed';

export interface HostSnapshot {
  phase: HostPhase;
  mode: HostMode;
  minigameId: string;
  sessionId: string;
  playerName: string;
  /** 当前（渲染用的最新）sim 状态（原地推进的同一个对象，变化看 tick） */
  state: SimBase | null;
  /** state 的 tick（快照变化判据） */
  tick: number;
  /** 距离开局的毫秒（倒计时阶段） */
  countdownMs: number;
  /** 本地重放得出的分数 */
  localScore: number;
  /** 服务器结算的分数（收到 MINIGAME_ENDED 或提交成功后）；null 表示还没有 */
  finalScore: number | null;
  /** 正在等服务器结算 */
  submitting: boolean;
  poseKey: string | null;
  notice: string | null;
  /** play：房间暂停中（不开局、不推进） */
  paused: boolean;
  /** 结算画面可以点击提前关闭（企鹅） */
  skippable: boolean;
}

export interface HostStore {
  subscribe(cb: () => void): () => void;
  getSnapshot(): HostSnapshot;
  /** 观战者主动收起、结算画面点击跳过 */
  dismiss(): void;
}

export function HostShell({
  store,
  Hud,
}: {
  store: HostStore;
  Hud: ComponentType<HudProps<SimBase>> | null;
}): ReactNode {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const who = snap.playerName;
  const sub =
    snap.mode === 'spectate'
      ? mgText('host.watching', { who })
      : snap.mode === 'replay'
        ? mgText('host.replay', { who })
        : null;
  const secs = Math.ceil(snap.countdownMs / 1000);
  const score = snap.finalScore ?? snap.localScore;
  const paused = snap.paused && snap.phase !== 'result';
  return (
    <>
      <div className={s.top}>
        <div className={s.title}>
          <span className={s.name}>{mgName(snap.minigameId)}</span>
          {sub && <span className={s.sub}>{sub}</span>}
        </div>
      </div>
      {Hud && snap.state && (
        <div className={s.hudLayer} data-testid="minigame-hud">
          <Hud state={snap.state} mode={snap.mode} />
        </div>
      )}
      {snap.phase === 'loading' && (
        <div className={`${s.center} ${s.dim}`}>
          <div className={s.panel}>{mgText('host.loading')}</div>
        </div>
      )}
      {paused && (
        <div className={`${s.center} ${s.dim}`} data-testid="minigame-paused">
          <div className={s.panel}>{mgText('host.paused')}</div>
        </div>
      )}
      {snap.phase === 'countdown' && !paused && (
        <div className={`${s.center} ${s.dim}`} data-testid="minigame-countdown">
          <div className={s.big}>{secs > 0 ? secs : mgText('host.go')}</div>
          <div className={s.panel}>{mgText(`${snap.minigameId}.hint`)}</div>
        </div>
      )}
      {snap.phase === 'waiting' && !snap.notice && !paused && (
        <div className={`${s.center} ${s.dim}`}>
          <div className={s.panel}>{mgText('host.waiting', { who })}</div>
        </div>
      )}
      {snap.phase === 'result' && (
        <div className={`${s.center} ${s.dim}`} data-testid="minigame-result">
          <div className={s.panel}>
            <div>{mgText('host.final')}</div>
            <div
              className={s.big}
              data-testid="minigame-final-score"
              data-value={score}
              data-final={snap.finalScore !== null}
            >
              {score}
            </div>
            {snap.poseKey && <div>{mgText(snap.poseKey)}</div>}
            {snap.finalScore !== null ? (
              <div>{mgText('host.coupons', { n: snap.finalScore })}</div>
            ) : (
              snap.submitting && <div>{mgText('host.submitting')}</div>
            )}
          </div>
          {snap.skippable && (
            <button
              type="button"
              className={s.skipLayer}
              aria-label={mgText('host.skip')}
              onClick={() => store.dismiss()}
            />
          )}
        </div>
      )}
      {snap.notice && snap.phase !== 'result' && (
        <div className={s.center}>
          <div className={s.panel}>{snap.notice}</div>
        </div>
      )}
      {snap.mode !== 'play' && snap.phase !== 'closed' && (
        <button type="button" className={s.btn} onClick={() => store.dismiss()} data-testid="minigame-close">
          {mgText('host.close')}
        </button>
      )}
    </>
  );
}

/** 各游戏 HUD 共用的计时与得分块 */
export function StatBox({ label, value, urgent }: { label: string; value: ReactNode; urgent?: boolean }): ReactNode {
  return (
    <div className={s.stat}>
      <span className={s.statLabel}>{label}</span>
      <span className={s.statValue} data-urgent={urgent === true}>
        {value}
      </span>
    </div>
  );
}

export function Stats({ children }: { children: ReactNode }): ReactNode {
  return <div className={s.stats}>{children}</div>;
}

export function Chips({ items }: { items: readonly ReactNode[] }): ReactNode {
  return (
    <div className={s.chips}>
      {items.map((x, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 固定顺序的小列表
        <span key={i} className={s.chip}>
          {x}
        </span>
      ))}
    </div>
  );
}
