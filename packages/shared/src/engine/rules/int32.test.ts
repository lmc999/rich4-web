import { describe, expect, it } from 'vitest';
import { fixtureRegistry } from '../../data/maps/registry';
import { addU16, INT32_MAX, INT32_MIN } from '../../util/int32';
import { engineMap } from '../core/mapCache';
import { editState, makeConfig, makeSetups, testEngine } from '../testing/builders';
import type { GameState } from '../types/state';
import { checkInvariants } from '../validate/invariants';
import { transfer } from './payment';
import { landBuyPrice } from './purchase';
import { quoteLandToll } from './toll';
import { netWorth } from './wealth';

const em = engineMap(fixtureRegistry.getMap('test'));

function game(mode: 'saturate' | 'wrap'): GameState {
  return testEngine().createGame(
    makeConfig({ rules: { intOverflow: mode } }),
    makeSetups(['human', 'human']),
    'c0ffee',
  );
}

describe('int32 两种溢出模式（DEV-01：intOverflow）', () => {
  it('总资产：saturate 夹到 INT32_MAX，wrap 回绕成负数（原版行为）', () => {
    for (const mode of ['saturate', 'wrap'] as const) {
      const s = editState(game(mode), (d) => {
        d.players[0]!.cash = INT32_MAX;
        d.players[0]!.deposit = 1;
      });
      expect(netWorth(s, em, 0)).toBe(mode === 'saturate' ? INT32_MAX : INT32_MIN);
    }
  });

  it('过路费 × PI 与买地价：saturate 夹紧，wrap 用 Math.imul 语义', () => {
    for (const mode of ['saturate', 'wrap'] as const) {
      const s = editState(game(mode), (d) => {
        d.econ.priceIndex = 200000;
        d.lands[0]!.owner = 0;
        d.lands[0]!.level = 5; // rent 24000
      });
      const r = quoteLandToll(s, em, 0, 1);
      const want = mode === 'saturate' ? INT32_MAX : Math.imul(24000, 200000);
      expect(r).toMatchObject({ kind: 'toll', q: { amount: want } });
      expect(landBuyPrice(s, em, 1)).toBe(mode === 'saturate' ? 400000000 : Math.imul(2000, 200000));
    }
  });

  it('收款溢出：存量按模式截断，差额记入台账，资金恒等式仍然精确成立', () => {
    for (const mode of ['saturate', 'wrap'] as const) {
      const s = editState(game(mode), (d) => {
        d.players[0]!.cash = INT32_MAX - 10;
        d.econ.ledger.minted = INT32_MAX - 10 - 100000;
        d.players[1]!.cash = 100000;
      });
      expect(checkInvariants(s, em)).toEqual([]);
      const r = transfer(s, { t: 'seat', seat: 1 }, { t: 'seat', seat: 0 }, 50);
      expect(r).toEqual({ paid: 50, bankrupt: false });
      expect(s.players[0]!.cash).toBe(mode === 'saturate' ? INT32_MAX : INT32_MIN + 39);
      expect(checkInvariants(s, em)).toEqual([]);
    }
  });

  it('点券：saturate 夹到 65535，wrap 取低 16 位', () => {
    expect(addU16(65500, 50, 'saturate')).toBe(65535);
    expect(addU16(65500, 50, 'wrap')).toBe(14);
  });
});
