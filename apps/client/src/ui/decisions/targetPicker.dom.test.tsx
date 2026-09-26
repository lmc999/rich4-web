// TargetPicker：buildTarget 对全部候选形态的纯函数测试；DOM 候选列表与棋盘桥（高亮 + 点选）
import { CARD, ITEM, PlayerIntentSchema, type TargetCandidates, type UseTarget } from '@rich4/shared/engine';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { buildTarget, draftFromPick, TargetPicker, type TargetSource } from './TargetPicker';
import { type BoardBridge, BoardBridgeContext, type BoardPick, type TargetHighlight } from './targeting';
import { fixture } from './testing';

function valid(t: UseTarget | null): UseTarget {
  expect(t).not.toBeNull();
  const r = PlayerIntentSchema.safeParse({ type: 'USE_CARD', slot: 0, card: 1, target: t });
  expect(r.success, JSON.stringify(t)).toBe(true);
  return t!;
}

describe('buildTarget', () => {
  it('none / auto → {t:none}', () => {
    expect(valid(buildTarget({ t: 'none' }, {}))).toEqual({ t: 'none' });
    expect(valid(buildTarget({ t: 'auto' }, {}))).toEqual({ t: 'none' });
  });

  it('seat / actor：只接受候选里的', () => {
    const c: TargetCandidates = { t: 'seat', seats: [1, 2] };
    expect(buildTarget(c, {})).toBeNull();
    expect(buildTarget(c, { seat: 3 })).toBeNull();
    expect(valid(buildTarget(c, { seat: 2 }))).toEqual({ t: 'seat', seat: 2 });
    const a: TargetCandidates = { t: 'actor', actors: [{ t: 'villain', kind: 'spy' }] };
    expect(buildTarget(a, { actor: { t: 'villain', kind: 'thief' } })).toBeNull();
    expect(valid(buildTarget(a, { actor: { t: 'villain', kind: 'spy' } }))).toEqual({
      t: 'actor',
      actor: { t: 'villain', kind: 'spy' },
    });
  });

  it('lot：needType 里的地块必须附带设施类型', () => {
    const c: TargetCandidates = { t: 'lot', lots: ['L1', 'F1'], needType: ['F1'] };
    expect(valid(buildTarget(c, { lot: 'L1' }))).toEqual({ t: 'lot', lot: 'L1', facility: null });
    expect(buildTarget(c, { lot: 'F1' })).toBeNull();
    expect(valid(buildTarget(c, { lot: 'F1', facility: 'mall' }))).toEqual({ t: 'lot', lot: 'F1', facility: 'mall' });
  });

  it('underfoot：types 为 null 时不带类型，否则必须在 types 里选', () => {
    expect(valid(buildTarget({ t: 'underfoot', lot: 'L1', types: null }, {}))).toEqual({
      t: 'underfoot',
      facility: null,
    });
    const c: TargetCandidates = { t: 'underfoot', lot: 'F1', types: ['gas', 'park'] };
    expect(buildTarget(c, {})).toBeNull();
    expect(buildTarget(c, { facility: 'hotel' })).toBeNull();
    expect(valid(buildTarget(c, { facility: 'gas' }))).toEqual({ t: 'underfoot', facility: 'gas' });
  });

  it('lotPair / lotOrObject / stock / node / anyNode / dice', () => {
    expect(valid(buildTarget({ t: 'lotPair', from: 'L1', to: ['L4'] }, { lot: 'L4' }))).toEqual({
      t: 'lotPair',
      from: 'L1',
      to: 'L4',
    });
    const lo: TargetCandidates = { t: 'lotOrObject', lots: ['L2'], objects: [7] };
    expect(valid(buildTarget(lo, { object: 7 }))).toEqual({ t: 'object', object: 7 });
    expect(valid(buildTarget(lo, { lot: 'L2' }))).toEqual({ t: 'lot', lot: 'L2', facility: null });
    expect(buildTarget(lo, { object: 8 })).toBeNull();
    expect(valid(buildTarget({ t: 'stock', stocks: [3] }, { stock: 3 }))).toEqual({ t: 'stock', stock: 3 });
    expect(buildTarget({ t: 'node', nodes: [4] }, { node: 5 })).toBeNull();
    expect(valid(buildTarget({ t: 'anyNode' }, { node: 5 }))).toEqual({ t: 'node', node: 5 });
    expect(buildTarget({ t: 'dice', values: [1, 2] }, { dice: 6 })).toBeNull();
    expect(valid(buildTarget({ t: 'dice', values: [1, 6] }, { dice: 6 }))).toEqual({ t: 'dice', value: 6 });
  });

  it('rob：必须选对手与其持有的一张卡或一个道具', () => {
    const c: TargetCandidates = {
      t: 'rob',
      victims: [{ seat: 1, cards: [{ slot: 2, card: CARD.FRAME }], items: [{ item: ITEM.MINE, count: 1 }] }],
    };
    expect(buildTarget(c, { rob: { seat: 1 } })).toBeNull();
    expect(buildTarget(c, { rob: { seat: 1, take: { k: 'card', slot: 0 } } })).toBeNull();
    expect(valid(buildTarget(c, { rob: { seat: 1, take: { k: 'item', item: ITEM.MINE } } }))).toEqual({
      t: 'rob',
      seat: 1,
      take: { k: 'item', item: ITEM.MINE },
    });
  });

  it('teleport：来源与目的地都必须在候选里', () => {
    const c: TargetCandidates = {
      t: 'teleport',
      sources: [{ k: 'god', slot: 3 }],
      roads: [9],
      lands: ['L3'],
    };
    expect(buildTarget(c, { tpSource: { k: 'god', slot: 3 } })).toBeNull();
    expect(buildTarget(c, { tpSource: { k: 'god', slot: 4 }, tpDest: { k: 'road', node: 9 } })).toBeNull();
    expect(valid(buildTarget(c, { tpSource: { k: 'god', slot: 3 }, tpDest: { k: 'lot', lot: 'L3' } }))).toEqual({
      t: 'teleport',
      source: { k: 'god', slot: 3 },
      dest: { k: 'lot', lot: 'L3' },
    });
  });
});

describe('draftFromPick（棋盘点选）', () => {
  const fx = fixture();
  it('seat：点到候选玩家所在格即选中，点别处忽略', () => {
    const c: TargetCandidates = { t: 'seat', seats: [1, 2] };
    expect(draftFromPick(c, {}, { tile: 11, lot: 'L4' }, fx.view)).toEqual({ seat: 1 });
    expect(draftFromPick(c, {}, { tile: 5, lot: 'L1' }, fx.view)).toBeNull();
  });
  it('lot / lotOrObject / node', () => {
    expect(draftFromPick({ t: 'lot', lots: ['L2'], needType: [] }, {}, { tile: 6, lot: 'L2' }, fx.view)).toMatchObject({
      lot: 'L2',
    });
    expect(
      draftFromPick({ t: 'lotOrObject', lots: [], objects: [1] }, {}, { tile: 12, lot: 'L5' }, fx.view),
    ).toMatchObject({ object: 1 });
    expect(draftFromPick({ t: 'node', nodes: [4] }, {}, { tile: 4, lot: null }, fx.view)).toEqual({ node: 4 });
  });
});

function renderPicker(candidates: TargetCandidates, source: TargetSource, bridge?: BoardBridge) {
  const fx = fixture();
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const el = (
    <TargetPicker
      candidates={candidates}
      view={fx.view}
      map={fx.map}
      me={0}
      source={source}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
  render(bridge ? <BoardBridgeContext.Provider value={bridge}>{el}</BoardBridgeContext.Provider> : el);
  return { onConfirm, onCancel, user: userEvent.setup() };
}

describe('TargetPicker DOM', () => {
  it('天使卡：选 0 级设施时要求选类型；候选同步到棋盘高亮', async () => {
    const highlight = vi.fn<(h: TargetHighlight | null) => void>();
    const r = renderPicker(
      { t: 'lot', lots: ['L1', 'F1'], needType: ['F1'] },
      { kind: 'card', card: CARD.ANGEL, slot: 1 },
      { highlight },
    );
    expect(highlight).toHaveBeenCalled();
    expect(highlight.mock.calls.at(-1)![0]!.lots).toEqual(['L1', 'F1']);
    await r.user.click(screen.getByTestId('target-lot-F1'));
    expect(screen.getByTestId('target-confirm')).toBeDisabled();
    await r.user.click(screen.getByTestId('target-type-mall'));
    expect(highlight.mock.calls.at(-1)![0]!.selected).toEqual({ lot: 'F1' });
    await r.user.click(screen.getByTestId('target-confirm'));
    expect(r.onConfirm).toHaveBeenCalledWith({ t: 'lot', lot: 'F1', facility: 'mall' });
  });

  it('棋盘点选回填：点到阿土伯所在格即选中他', async () => {
    let pick: ((p: BoardPick) => void) | null = null;
    const bridge: BoardBridge = {
      highlight: () => {},
      onPick: (cb) => {
        pick = cb;
        return () => {
          pick = null;
        };
      },
    };
    const r = renderPicker({ t: 'seat', seats: [1, 3] }, { kind: 'card', card: CARD.TAX_AUDIT, slot: 0 }, bridge);
    expect(pick).not.toBeNull();
    act(() => pick!({ tile: 11, lot: 'L4' }));
    expect(screen.getByTestId('target-seat-1')).toHaveAttribute('aria-pressed', 'true');
    await r.user.click(screen.getByTestId('target-confirm'));
    expect(r.onConfirm).toHaveBeenCalledWith({ t: 'seat', seat: 1 });
  });

  it('抢夺卡：先选对手，再选要抢的卡', async () => {
    const r = renderPicker(
      {
        t: 'rob',
        victims: [{ seat: 1, cards: [{ slot: 1, card: CARD.DEMOLISH }], items: [{ item: ITEM.MINE, count: 1 }] }],
      },
      { kind: 'card', card: CARD.ROB, slot: 2 },
    );
    await r.user.click(screen.getByTestId('target-rob-1'));
    await r.user.click(screen.getByTestId('target-rob-card-1'));
    await r.user.click(screen.getByTestId('target-confirm'));
    expect(r.onConfirm).toHaveBeenCalledWith({ t: 'rob', seat: 1, take: { k: 'card', slot: 1 } });
  });

  it('传送机：先选被传送物，再选目的地', async () => {
    const r = renderPicker(
      {
        t: 'teleport',
        sources: [
          { k: 'actor', actor: { t: 'seat', seat: 1 } },
          { k: 'object', object: 1 },
        ],
        roads: [2, 9],
        lands: ['L3'],
      },
      { kind: 'item', item: ITEM.TELEPORTER },
    );
    expect(screen.queryByTestId('target-tp-road-2')).toBeNull();
    await r.user.click(screen.getByTestId('target-tp-src-1'));
    expect(screen.getByTestId('target-tp-src-1')).toHaveTextContent('路障');
    await r.user.click(screen.getByTestId('target-tp-lot-L3'));
    await r.user.click(screen.getByTestId('target-confirm'));
    expect(r.onConfirm).toHaveBeenCalledWith({
      t: 'teleport',
      source: { k: 'object', object: 1 },
      dest: { k: 'lot', lot: 'L3' },
    });
  });

  it('飞弹（anyNode）用下拉选任意格；返回 → onCancel', async () => {
    const r = renderPicker({ t: 'anyNode' }, { kind: 'item', item: ITEM.MISSILE });
    await r.user.selectOptions(screen.getByTestId('target-any-node'), '8');
    await r.user.click(screen.getByTestId('target-confirm'));
    expect(r.onConfirm).toHaveBeenCalledWith({ t: 'node', node: 8 });
    await r.user.click(screen.getByTestId('target-cancel'));
    expect(r.onCancel).toHaveBeenCalled();
  });

  it('请神符（auto）直接确认；没有候选时提示', async () => {
    const r = renderPicker({ t: 'auto' }, { kind: 'card', card: CARD.SUMMON_GOD, slot: 0 });
    expect(screen.getByText('将自动选择视野内最近的神明。')).toBeInTheDocument();
    await r.user.click(screen.getByTestId('target-confirm'));
    expect(r.onConfirm).toHaveBeenCalledWith({ t: 'none' });
  });

  it('候选为空时显示提示且不能确认', () => {
    renderPicker({ t: 'seat', seats: [] }, { kind: 'card', card: CARD.FRAME, slot: 0 });
    expect(screen.getByText('视野内没有可选目标。')).toBeInTheDocument();
    expect(screen.getByTestId('target-confirm')).toBeDisabled();
  });
});
