// 决策注册表：23 种 kind 全覆盖（类型 + 运行期），DecisionHost 懒加载每一种，只读态禁用全部控件，未知 kind 走 GenericChoice
import { DECISION_KINDS, type DecisionKind, type PlayerIntent, PlayerIntentSchema } from '@rich4/shared/engine';
import type { DecisionForYou } from '@rich4/shared/view';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType, LazyExoticComponent } from 'react';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { DecisionHost } from './DecisionHost';
import { demoDecisions } from './devFixtures';
import { type DecisionRegistry, decisionRegistry, getDecisionComponent } from './registry';
import { fixture, installResizeObserver } from './testing';
import type { DecisionProps } from './types';

installResizeObserver();

describe('decisionRegistry', () => {
  it('类型上对 DecisionKind 穷举，且每个组件接收对应 kind 的 DecisionProps', () => {
    expectTypeOf<keyof DecisionRegistry>().toEqualTypeOf<DecisionKind>();
    expectTypeOf<DecisionRegistry['BUY_LAND']>().toExtend<
      LazyExoticComponent<ComponentType<DecisionProps<'BUY_LAND'>>>
    >();
    expectTypeOf<DecisionRegistry['TURN_MENU']>().toExtend<
      LazyExoticComponent<ComponentType<DecisionProps<'TURN_MENU'>>>
    >();
    expectTypeOf(getDecisionComponent).returns.toEqualTypeOf<LazyExoticComponent<ComponentType<DecisionProps>>>();
  });

  it('运行期键集合 = 23 种 DECISION_KINDS', () => {
    expect(DECISION_KINDS).toHaveLength(23);
    expect(Object.keys(decisionRegistry).sort()).toEqual([...DECISION_KINDS].sort());
  });

  it('未知 kind 返回 GenericChoice', () => {
    expect(getDecisionComponent('NOPE')).not.toBe(getDecisionComponent('BUY_LAND'));
  });
});

describe('DecisionHost 渲染全部 23 种', () => {
  const fx = fixture();
  const decisions = demoDecisions(fx.view, { now: Date.now(), timeoutMs: 30_000 });

  it.each(DECISION_KINDS)('%s：懒加载出对应对话框（带倒计时）', async (kind) => {
    const submit = vi.fn();
    render(<DecisionHost decision={decisions[kind]} isMine view={fx.view} map={fx.map} submit={submit} />);
    const frame = await screen.findByTestId(`decision-${kind}`, {}, { timeout: 5000 });
    expect(frame).toHaveAttribute('role', 'dialog');
    expect(within(frame).getAllByTestId('countdown').length).toBeGreaterThan(0);
    expect(frame).toHaveAttribute('data-readonly', 'false');
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(DECISION_KINDS)('%s：isMine=false 时显示等待态，所有控件禁用', async (kind) => {
    const submit = vi.fn();
    render(<DecisionHost decision={decisions[kind]} isMine={false} view={fx.view} map={fx.map} submit={submit} />);
    const frame = await screen.findByTestId(`decision-${kind}`, {}, { timeout: 5000 });
    expect(frame).toHaveAttribute('data-readonly', 'true');
    expect(within(frame).getByRole('status')).toHaveTextContent('等待 孙小美 做决定');
    for (const b of within(frame).queryAllByRole('button')) expect(b).toBeDisabled();
    // 点也没用
    const user = userEvent.setup();
    for (const b of within(frame).queryAllByRole('button').slice(0, 3)) await user.click(b);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('GenericChoice 兜底', () => {
  it('未知 kind：按默认处理提交 defaultIntent', async () => {
    const fx = fixture();
    const submit = vi.fn();
    const weird = {
      decisionId: 'd999',
      seat: 0,
      kind: 'FUTURE_KIND',
      timing: 'pick',
      options: {},
      defaultIntent: { type: 'SKIP' },
      deadlineAt: null,
    } as unknown as DecisionForYou;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<DecisionHost decision={weird} isMine view={fx.view} map={fx.map} submit={submit} />);
    const btn = await screen.findByTestId('generic-default');
    await userEvent.setup().click(btn);
    expect(submit).toHaveBeenCalledTimes(1);
    const intent = submit.mock.calls[0]![0] as PlayerIntent;
    expect(PlayerIntentSchema.safeParse(intent).success).toBe(true);
    expect(intent).toEqual({ type: 'SKIP' });
    warn.mockRestore();
  });

  it('已知 kind 的组件渲染出错时退回 GenericChoice（列出无参数选项）', async () => {
    const fx = fixture();
    const submit = vi.fn();
    const decisions = demoDecisions(fx.view, { timeoutMs: null });
    // options 被破坏：BuyLotDialog 读 street.lots 会抛错
    const broken = { ...decisions.BUY_LAND, options: null } as unknown as DecisionForYou;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<DecisionHost decision={broken} isMine view={fx.view} map={fx.map} submit={submit} />);
    await userEvent.setup().click(await screen.findByTestId('generic-DECLINE'));
    expect(submit.mock.calls[0]![0]).toEqual({ type: 'DECLINE' });
    expect(screen.getByTestId('generic-CONFIRM')).toBeInTheDocument();
    err.mockRestore();
  });
});
