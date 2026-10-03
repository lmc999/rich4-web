// 状态外观：住旅馆的状态，以及「人在建筑里」（原版关押 / 住旅馆期间棋子坐标写成景观 / 旅馆坐标、不画，exe v2.06 0x4082a5–0x4082c3）
import { buildTestMap } from '@rich4/shared/data';
import type { GameView } from '@rich4/shared/view';
import { describe, expect, it } from 'vitest';
import { selfPlay } from '../../test/selfPlay';
import { hotelAt, insideOf, NO_STATUS, sameStatus, statusOf } from './ActorStatus';

const def = buildTestMap();
const base = selfPlay({ seed: 5, steps: 1 }).initial.view;

describe('insideOf：关押 / 住旅馆期间人在哪栋建筑里', () => {
  it('坐牢 / 住院在监狱 / 医院景观里；出国、乞丐、平常都不在建筑里', () => {
    expect(insideOf({ ...NO_STATUS, confined: { where: 'jail', days: 2 } }, 14, () => null)).toEqual({
      t: 'landmark',
      kind: 'jail',
    });
    expect(insideOf({ ...NO_STATUS, confined: { where: 'hospital', days: 1 } }, 15, () => null)).toEqual({
      t: 'landmark',
      kind: 'hospital',
    });
    expect(insideOf({ ...NO_STATUS, away: true }, 3, () => null)).toBeNull();
    expect(insideOf(NO_STATUS, 3, () => 'F1')).toBeNull();
  });

  it('住旅馆：门前格所属的旅馆；找不到（死神替人付费、旅馆被拆）时停在原格、同样不画', () => {
    const hotel = def.tiles.find((t) => t.ref?.lot === 'F1')!;
    const view: Pick<GameView, 'facilities'> = {
      facilities: base.facilities.map((f) => (f.id === 'F1' ? { ...f, type: 'hotel', level: 2 } : f)),
    };
    const s = { ...NO_STATUS, hotel: true };
    expect(hotelAt(hotel.id, def, view)).toBe('F1');
    expect(insideOf(s, hotel.id, (n) => hotelAt(n, def, view))).toEqual({ t: 'lot', lot: 'F1' });
    // 不是旅馆（购物中心）或不在门前
    const mall: Pick<GameView, 'facilities'> = {
      facilities: base.facilities.map((f) => (f.id === 'F1' ? { ...f, type: 'mall', level: 2 } : f)),
    };
    expect(hotelAt(hotel.id, def, mall)).toBeNull();
    expect(insideOf(s, 3, (n) => hotelAt(n, def, view))).toEqual({ t: 'here' });
  });

  it('statusOf 带出住旅馆；sameStatus 比较它', () => {
    const p = { ...base.players[0]!, st: { ...base.players[0]!.st, hotel: 2 } };
    const s = statusOf(p, base);
    expect(s.hotel).toBe(true);
    expect(sameStatus(s, { ...s, hotel: false })).toBe(false);
  });
});
