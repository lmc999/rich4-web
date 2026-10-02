import { describe, expect, it } from 'vitest';
import { fixtureRegistry } from '../data/maps/registry';
import { newGame } from '../engine/testing/builders';
import { decisionForSeat, simpleView } from '../engine/testing/view';
import type { GameAction, TurnMenuOptions } from '../engine/types/index';
import type { DecisionForYou } from '../view/types';
import { isLegalIntent, OriginalAiPolicy } from './policy';
import { makeAiContext } from './rng';

/**
 * 原版电脑从不收起交通工具（STOW_VEHICLE 只给真人）：电脑挑道具只在 1–13 号里选（v2.06 0x446b64–0x446baf），
 * 收起是道具函数表第 14 项，只有真人道具欄右下角那一格会调到。开局汽车 / 机车的自对弈里，即使菜单给出 canStow，
 * OriginalAiPolicy（含代打真人座位）也不会提交 STOW_VEHICLE。
 */
describe('OriginalAiPolicy 与收起交通工具', () => {
  it('开局机车 / 汽车的自对弈：看到 canStow 也从不提交 STOW_VEHICLE', { timeout: 120_000 }, () => {
    let menus = 0;
    let canStow = 0;
    for (const vehicle of ['moto', 'car'] as const) {
      const g = newGame({
        seed: vehicle === 'moto' ? '5709' : '5706',
        players: ['ai', 'human', 'ai'],
        config: { vehicle, timeLimitDays: 30 },
        devChecks: false,
      });
      let s = g.state;
      for (let n = 0; n < 1500 && s.status === 'playing'; n++) {
        const d = s.pending[0]!;
        const dfy = decisionForSeat(d) as DecisionForYou;
        const ctx = makeAiContext({
          aiSeed: s.secret.aiSeed,
          seat: d.seat,
          decisionId: d.id,
          turnNo: s.clock.turnNo,
          traits: s.players.find((p) => p.seat === d.seat)!.aiTraits,
          map: fixtureRegistry.getMap(s.dataRef.mapId),
          handVisibility: 'public',
        });
        const intent = OriginalAiPolicy.decide(simpleView(s), dfy, ctx);
        if (d.kind === 'TURN_MENU') {
          menus++;
          if ((d.options as TurnMenuOptions).vehicle?.canStow) canStow++;
        }
        expect(intent.type, JSON.stringify(intent)).not.toBe('STOW_VEHICLE');
        s = g.engine.applyAction(s, { ...intent, seat: d.seat, decisionId: d.id } as GameAction).state;
      }
    }
    expect(menus).toBeGreaterThan(20);
    expect(canStow).toBeGreaterThan(5);
  });

  it('合法性兜底（isLegalIntent）：STOW_VEHICLE 只在 options.vehicle.canStow 且没到菜单上限时合法', () => {
    const g = newGame({ players: ['human', 'ai'], config: { vehicle: 'car' } });
    const d = g.state.pending[0]!;
    expect(d.kind).toBe('TURN_MENU');
    const dfy = decisionForSeat(d) as DecisionForYou<'TURN_MENU'>;
    const stow = { type: 'STOW_VEHICLE' } as const;
    expect(dfy.options.vehicle).toEqual({ current: 'car', canStow: true });
    expect(isLegalIntent(dfy, stow)).toBe(true);
    const with_ = (o: Partial<TurnMenuOptions>): DecisionForYou<'TURN_MENU'> => ({
      ...dfy,
      options: { ...dfy.options, ...o },
    });
    expect(isLegalIntent(with_({ vehicle: { current: 'walk', canStow: false } }), stow)).toBe(false);
    expect(isLegalIntent(with_({ vehicle: { current: 'engineer', canStow: false } }), stow)).toBe(false);
    // 旧存档里挂着的决策没有 vehicle 字段
    expect(isLegalIntent(with_({ vehicle: undefined }), stow)).toBe(false);
    expect(isLegalIntent(with_({ menuActions: { used: 40, limit: 40 } }), stow)).toBe(false);
  });
});
