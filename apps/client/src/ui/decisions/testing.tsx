// client-dom 测试共用：假局面、决策组装、渲染与 intent 断言（文件名含 testing，check-deps 视为测试代码）
import type { MapIndex } from '@rich4/shared/data';
import {
  type DecisionKind,
  type DecisionOptionsMap,
  type PlayerIntent,
  PlayerIntentSchema,
  type SeatIndex,
} from '@rich4/shared/engine';
import type { DecisionForYou, GameView } from '@rich4/shared/view';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType, ReactElement } from 'react';
import { expect, vi } from 'vitest';
import { demoMap, demoOptions, demoView, makeDecision } from './devFixtures';
import type { DecisionProps } from './types';

/** jsdom 没有 ResizeObserver（radix Popper 需要） */
export function installResizeObserver(): void {
  if (typeof globalThis.ResizeObserver !== 'undefined') return;
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

export interface Fixture {
  map: MapIndex;
  view: GameView;
  options: { [K in DecisionKind]: DecisionOptionsMap[K] };
}

export function fixture(): Fixture {
  const map = demoMap();
  const view = demoView(map);
  return { map, view, options: demoOptions(view, 0) };
}

export interface RenderOpts<K extends DecisionKind> {
  options?: Partial<DecisionOptionsMap[K]>;
  isMine?: boolean;
  seat?: SeatIndex;
  /** 截止时间距 now 的毫秒数；null 不限时 */
  timeoutMs?: number | null;
  now?: () => number;
  submit?: DecisionProps['submit'];
  id?: string;
  minigame?: unknown;
  extraProps?: Record<string, unknown>;
}

/** 直接渲染某个对话框组件（非懒加载），返回 submit 的 mock 与 userEvent */
export function renderDialog<K extends DecisionKind>(
  Comp: ComponentType<DecisionProps<K>>,
  kind: K,
  o: RenderOpts<K> = {},
) {
  const fx = fixture();
  const submit = vi.fn<(intent: PlayerIntent) => unknown>(o.submit ?? (() => undefined));
  const now = o.now ?? (() => Date.now());
  const decision: DecisionForYou<K> = makeDecision(
    kind,
    { ...fx.options[kind], ...(o.options ?? {}) },
    {
      seat: o.seat ?? 0,
      now: now(),
      timeoutMs: o.timeoutMs === undefined ? 30_000 : o.timeoutMs,
      id: o.id,
      minigame: o.minigame,
    },
  );
  const props: DecisionProps<K> = {
    decision,
    isMine: o.isMine ?? true,
    view: fx.view,
    map: fx.map,
    submit,
    now,
  };
  const user = userEvent.setup();
  const el = <Comp {...props} {...(o.extraProps ?? {})} />;
  const utils = render(el as ReactElement);
  const rerenderWith = (patch: Partial<DecisionProps<K>>): void => {
    utils.rerender(<Comp {...props} {...patch} {...(o.extraProps ?? {})} />);
  };
  return { ...utils, ...fx, submit, user, decision, props, rerenderWith };
}

/** submit 收到的全部 intent（每个都必须通过 PlayerIntentSchema） */
export function intents(submit: { mock: { calls: unknown[][] } }): PlayerIntent[] {
  return submit.mock.calls.map((c) => {
    const intent = c[0] as PlayerIntent;
    const r = PlayerIntentSchema.safeParse(intent);
    expect(r.success, JSON.stringify(intent)).toBe(true);
    return intent;
  });
}

/** 恰好提交了一次，且等于 expected */
export function expectSingleIntent(submit: { mock: { calls: unknown[][] } }, expected: PlayerIntent): void {
  const all = intents(submit);
  expect(all).toHaveLength(1);
  expect(all[0]).toEqual(expected);
}
