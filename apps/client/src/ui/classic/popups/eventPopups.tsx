// 原版皮肤的「事件后」演出（original-skin.md §4.2：轮盘 Panel#68–71、月结颁奖 Panel#25）：转盘与月结不是决策，
// 程序化演出层里也没有对应的弹窗（handler 只弹 toast / 横幅）。这里监听显示态日志（gameStore.log：每个事件 handler 播完、
// 显示态提交时追加一行，带事件来源），遇到
//   FEE_PAID（旅馆 / 购物中心，wheel ≠ null）、COMPANY_FEE（航空 / 保险，wheel ≠ null）→ 轮盘停在结果上；
//   MONTHLY_REPORT → 月结颁奖（按总资产排名、本月冠军）；
// 就弹一个只读的原版场景（不挡操作，点「跳过」或到时自动收起）。它在事件之后出现、与后续事件（住宿、出国、投保、下一回合）
// 重叠，纯展示，不影响规则与计时；只播放（instant、后台标签页、追帧）时不弹。本人出现新的决策（回合菜单以外）时立即收起。
import type { MapIndex } from '@rich4/shared/data';
import type { GameEvent, SeatIndex } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { type ReactNode, useEffect } from 'react';
import { create } from 'zustand';
import { useTx } from '../../../i18n/tx';
import { type LogLine, useGameStore } from '../../../store/gameStore';
import { makeGameText } from '../../components/names';
import { sceneKeysStatus, scenePackClient } from '../common/sceneAssets';
import { companyWheel, MONTHLY_SHEET, WHEELS, type WheelKind } from './layout';
import { PopupScene } from './PopupScene';
import { Ranking, type RankRow } from './Ranking';
import { Roulette, type RouletteSpec } from './Roulette';

export type EventPopupSpec =
  | { kind: 'roulette'; roulette: RouletteSpec }
  | { kind: 'monthly'; rows: RankRow[]; title: string; subtitle: string | null };

export interface EventPopup {
  id: number;
  spec: EventPopupSpec;
  /** 展示时长（真实毫秒） */
  ms: number;
}

/** 转盘转动的时长与停住后的停留（真实毫秒） */
export const ROULETTE_SPIN_MS = 1100;
export const ROULETTE_MS = 2800;
export const MONTHLY_MS = 3400;
const MAX_QUEUE = 2;

interface EventPopupState {
  current: EventPopup | null;
  queue: EventPopup[];
  push(spec: EventPopupSpec, ms: number): void;
  close(id?: number): void;
  clear(): void;
}

let seq = 0;

export const useEventPopups = create<EventPopupState>()((set, get) => ({
  current: null,
  queue: [],
  push: (spec, ms) => {
    const p: EventPopup = { id: ++seq, spec, ms };
    const s = get();
    if (!s.current) set({ current: p });
    else set({ queue: [...s.queue, p].slice(-MAX_QUEUE) });
  },
  close: (id) => {
    const s = get();
    if (id !== undefined && s.current?.id !== id) return;
    const [next, ...rest] = s.queue;
    set({ current: next ?? null, queue: rest });
  },
  clear: () => set({ current: null, queue: [] }),
}));

/** 事件 → 转盘种类（没有转盘的收费返回 null） */
export function wheelOf(e: GameEvent): { wheel: WheelKind; value: number; seat: SeatIndex } | null {
  if (e.type === 'FEE_PAID') {
    if (e.wheel === null) return null;
    if (e.feeKind === 'hotel' || e.feeKind === 'mall') return { wheel: e.feeKind, value: e.wheel, seat: e.payer };
    return null;
  }
  if (e.type === 'COMPANY_FEE') {
    if (e.wheel === null) return null;
    const w = companyWheel(e.industry);
    return w ? { wheel: w, value: e.wheel, seat: e.seat } : null;
  }
  return null;
}

/** 月结行 → 名次（总资产降序，同额按座位） */
export function monthlyRows(
  rows: readonly { seat: SeatIndex; netWorth: number }[],
  view: GameView,
  nameOf: (seat: SeatIndex) => string,
): RankRow[] {
  return [...rows]
    .sort((a, b) => b.netWorth - a.netWorth || a.seat - b.seat)
    .map((r, i) => {
      const p = view.players.find((x) => x.seat === r.seat);
      return {
        seat: r.seat,
        character: p?.character ?? 0,
        name: nameOf(r.seat),
        rank: i + 1,
        netWorth: r.netWorth,
        alive: p?.alive ?? true,
      };
    });
}

/** 日志行 → 事件后演出（不需要的返回 null） */
export function eventPopupOf(
  line: LogLine,
  t: (k: string, o?: Record<string, unknown>) => string,
  map: MapIndex | null,
): { spec: EventPopupSpec; ms: number } | null {
  const src = line.src;
  if (!src) return null;
  const e = src.event;
  const text = makeGameText(t, src.view, map);
  const w = wheelOf(e);
  if (w) {
    return {
      spec: {
        kind: 'roulette',
        roulette: { wheel: w.wheel, value: w.value, caption: line.text, who: text.player(w.seat) },
      },
      ms: ROULETTE_MS,
    };
  }
  if (e.type === 'MONTHLY_REPORT') {
    return {
      spec: {
        kind: 'monthly',
        rows: monthlyRows(e.rows, src.view, text.player),
        title: t('events:show.monthly'),
        subtitle: e.champion === null ? null : t('events:show.monthlyChampion', { who: text.player(e.champion) }),
      },
      ms: MONTHLY_MS,
    };
  }
  return null;
}

/** 这一种演出依赖的素材 */
export function eventPopupKeys(spec: EventPopupSpec): string[] {
  return spec.kind === 'roulette' ? [WHEELS[spec.roulette.wheel].key, 'ui.common'] : [MONTHLY_SHEET];
}

/** 监听显示态日志，按需推入事件后演出（挂载之前已有的行不补弹） */
export function useEventPopupWatcher(map: MapIndex | null): void {
  const t = useTx();
  useEffect(() => {
    let last = useGameStore.getState().log.at(-1)?.id ?? 0;
    const off = useGameStore.subscribe((st, prev) => {
      // 本人出现新的决策（回合菜单以外）：收起正在演出的事件场景
      if (st.decision && st.decision !== prev.decision && st.decision.kind !== 'TURN_MENU') {
        useEventPopups.getState().clear();
      }
      if (st.log === prev.log) return;
      const fresh = st.log.filter((l) => l.id > last);
      if (fresh.length === 0) return;
      last = fresh.at(-1)!.id;
      if (st.anim.instant || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
      const client = scenePackClient();
      for (const line of fresh) {
        const hit = eventPopupOf(line, t, map);
        if (!hit) continue;
        if (sceneKeysStatus(eventPopupKeys(hit.spec), client) !== 'ready') continue;
        useEventPopups.getState().push(hit.spec, hit.ms);
      }
    });
    return () => {
      off();
      useEventPopups.getState().clear();
    };
  }, [t, map]);
}

/** 当前的事件后演出（到时自动收起） */
export function EventPopupLayer(): ReactNode {
  const cur = useEventPopups((s) => s.current);
  useEffect(() => {
    if (!cur) return;
    const id = setTimeout(() => useEventPopups.getState().close(cur.id), cur.ms);
    return () => clearTimeout(id);
  }, [cur]);
  if (!cur) return null;
  const close = (): void => useEventPopups.getState().close(cur.id);
  if (cur.spec.kind === 'roulette') {
    return (
      <PopupScene key={cur.id} kind="roulette" label={cur.spec.roulette.caption} minMs={500} onSkip={close}>
        <Roulette spec={cur.spec.roulette} spinMs={ROULETTE_SPIN_MS} />
      </PopupScene>
    );
  }
  return (
    <PopupScene key={cur.id} kind="monthly" label={cur.spec.title} minMs={800} onSkip={close} backdrop="opaque">
      <Ranking
        rows={cur.spec.rows}
        title={cur.spec.title}
        subtitle={cur.spec.subtitle}
        testId="monthly-popup"
        rowTestId={(rank) => `monthly-rank-${rank}`}
      />
    </PopupScene>
  );
}
