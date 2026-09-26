import { describe, expect, it } from 'vitest';
import { DEFAULT_MINIGAME_PARAMS, InputCode, type InputEvent, MINIGAME_TIMING, type SimFx } from '../types';
import { GOD_TURN_LEFT_END, GOD_TURN_RIGHT_END, GOD_WALK_LEFT, GOD_WALK_RIGHT, ITEM_BOMB } from './constants';
import { itemPx, XICONG_SIM as sim, XICONG_SPEC, type XicongState, xicongPose } from './sim';

const P = DEFAULT_MINIGAME_PARAMS;
const cursor = (tick: number, x: number): InputEvent => [tick, InputCode.CursorX, x];

/** 进入游玩（tick 10），清空掉落物，并让财神停在「左端转身」很久（不撒宝、不掷预警） */
function quietPlay(seed = 1): XicongState {
  const s = sim.init(seed, P);
  while (s.phase === 'intro') sim.step(s, []);
  s.ix.fill(0);
  s.godState = GOD_TURN_LEFT_END;
  s.godFrame = -10_000;
  return s;
}

function place(s: XicongState, slot: number, x: number, y: number, kind: number, vy = 0, frame = 0): void {
  s.ix[slot] = x;
  s.iy[slot] = y;
  s.ikind[slot] = kind;
  s.ivy[slot] = vy;
  s.iframe[slot] = frame;
}

const RIGHT_DECISIONS = [170, 242, 314, 386, 458, 530];
const LEFT_DECISIONS = [470, 398, 326, 254, 182, 110];

describe('喜从天降 sim', () => {
  it('spec 与计时契约一致', () => {
    expect(XICONG_SPEC).toMatchObject({
      id: 'xicong',
      tickMs: 50,
      introTicks: 10,
      playTicks: 360,
      maxTicks: MINIGAME_TIMING.xicong.maxTicks,
      scoreSanityMax: 999,
      acceptedCodes: [InputCode.CursorX],
      maxInputsPerTick: 1,
    });
  });

  it('财神：x ∈ [110,530]，行走每拍 ±12，决策点落在 170/242/…/530 与 470/…/110，远半场才转身', () => {
    let turnsR = 0;
    let turnsL = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const s = sim.init(seed * 131, P);
      while (s.phase === 'intro') sim.step(s, []);
      expect([s.godState, s.godFrame, s.godX]).toEqual([GOD_TURN_LEFT_END, 4, 110]);
      while (s.phase === 'play') {
        const { godState: st, godFrame: fr, godX: x } = s;
        sim.step(s, []);
        if (s.phase !== 'play') break;
        expect(s.godX).toBeGreaterThanOrEqual(110);
        expect(s.godX).toBeLessThanOrEqual(530);
        if (st === GOD_WALK_RIGHT || st === GOD_WALK_LEFT) {
          const dir = st === GOD_WALK_RIGHT ? 1 : -1;
          if (fr === 5) expect(st === GOD_WALK_RIGHT ? RIGHT_DECISIONS : LEFT_DECISIONS).toContain(x);
          if (s.godState === st) {
            expect(s.godX - x).toBe(12 * dir);
          } else {
            expect(fr).toBe(5);
            expect(s.godX).toBe(x);
            if (st === GOD_WALK_RIGHT) {
              expect(s.godState).toBe(GOD_TURN_RIGHT_END);
              expect([386, 458, 530]).toContain(x);
              turnsR++;
            } else {
              expect(s.godState).toBe(GOD_TURN_LEFT_END);
              expect([254, 182, 110]).toContain(x);
              turnsL++;
            }
          }
        } else {
          expect(s.godX).toBe(x);
        }
      }
    }
    expect(turnsR).toBeGreaterThan(0);
    expect(turnsL).toBeGreaterThan(0);
  });

  it('撒宝：每个行走段一件；类型分布 1 分 45% / 3 分 30% / 5 分 15% / 10 分 10%', () => {
    const hist = [0, 0, 0, 0];
    for (let seed = 1; seed <= 400; seed++) {
      const s = sim.init(seed * 7 + 3, P);
      while (!sim.isOver(s)) {
        sim.step(s, []);
        for (const f of s.fx) if (f.t === 'drop') hist[f.item]!++;
      }
    }
    const n = hist.reduce((a, b) => a + b, 0);
    expect(n).toBeGreaterThan(10_000);
    expect(Math.abs(hist[3]! / n - 0.45)).toBeLessThan(0.02);
    expect(Math.abs(hist[2]! / n - 0.3)).toBeLessThan(0.02);
    expect(Math.abs(hist[1]! / n - 0.15)).toBeLessThan(0.02);
    expect(Math.abs(hist[0]! / n - 0.1)).toBeLessThan(0.02);
  });

  it('上抛：y=100、初速 −16、每拍 +2（上限 16），y ≥ 130 后按类型匀速；y > 380 漏接', () => {
    const s = quietPlay();
    s.catcherX = 600;
    s.cursorX = 600;
    s.ix[0] = 200;
    s.iy[0] = 100;
    s.ivy[0] = -16;
    s.ikind[0] = 3;
    s.iframe[0] = 0;
    const ys: number[] = [];
    while (s.ix[0] !== 0) {
      sim.step(s, []);
      ys.push(s.iy[0]!);
    }
    expect(ys.slice(0, 18)).toEqual([86, 74, 64, 56, 50, 46, 44, 44, 46, 50, 56, 64, 74, 86, 100, 116, 132, 144]);
    expect(ys[ys.length - 1]).toBeGreaterThan(380);
    expect(ys[ys.length - 2]).toBeLessThanOrEqual(380);
    expect(ys).toHaveLength(38);
  });

  it('摆动判定点：px = x + trunc(frame·(y−130)/250)，y < 130 时不摆', () => {
    expect(itemPx(100, 380, 7)).toBe(107);
    expect(itemPx(100, 129, 7)).toBe(100);
    expect(itemPx(100, 255, 3)).toBe(101);
    expect(itemPx(100, 300, 0)).toBe(100);
  });

  it('接物者：差距 > 8 才追，每拍 10px；intro 中上报的光标在开局第一拍生效', () => {
    const s = sim.init(1, P);
    sim.step(s, [cursor(0, 350)]);
    while (s.phase === 'intro') sim.step(s, []);
    expect(s.catcherX).toBe(320);
    sim.step(s, []);
    expect([s.catcherX, s.catcherDir]).toEqual([330, 2]);
    sim.step(s, []);
    expect([s.catcherX, s.catcherDir]).toEqual([340, 2]);
    sim.step(s, []); // 差 10 → 再走
    expect(s.catcherX).toBe(350);
    sim.step(s, []);
    expect([s.catcherX, s.catcherDir]).toEqual([350, 0]);
    sim.step(s, [cursor(s.tick, 342)]); // 差 8 → 不动
    expect([s.catcherX, s.catcherDir]).toEqual([350, 0]);
    sim.step(s, [cursor(s.tick, 341)]); // 差 9 → 向左
    expect([s.catcherX, s.catcherDir]).toEqual([340, 1]);
  });

  it('⚑ 只有移动中才接得住；接住计分', () => {
    const still = quietPlay();
    place(still, 0, 320, 300, 3);
    sim.step(still, []);
    expect(still.catcherDir).toBe(0);
    expect(still.ix[0]).toBe(320);
    expect(sim.score(still)).toBe(0);

    const moving = quietPlay();
    place(moving, 0, 320, 300, 3);
    sim.step(moving, [cursor(moving.tick, 340)]);
    expect(moving.catcherDir).toBe(2);
    expect(moving.ix[0]).toBe(0);
    expect(moving.fx).toContainEqual({ t: 'catch', item: 3 });
    expect(sim.score(moving)).toBe(1);
  });

  it('接住矩形：x−33 < px < x+33 且 309 < y < 381（开区间）', () => {
    const at = (x: number, y: number, kind = 0) => {
      const s = quietPlay();
      s.catcherX = 330;
      s.cursorX = 300; // 向左移到 320
      place(s, 0, x, y - [24, 18, 15, 12][kind]!, kind);
      sim.step(s, []);
      return s.ix[0] === 0 && s.counts[kind] === 1;
    };
    expect(at(288, 320)).toBe(true); // px = 288 + trunc(1·190/250) = 288 > 287
    expect(at(287, 320)).toBe(false);
    expect(at(352, 320)).toBe(true);
    expect(at(353, 320)).toBe(false);
    expect(at(320, 309)).toBe(false);
    expect(at(320, 310)).toBe(true);
    expect(at(320, 380)).toBe(true);
  });

  it('接到炸弹：立即进入 ending，分数保留，之后接不到任何东西，落完才 over', () => {
    const s = quietPlay();
    s.counts = [1, 0, 0, 2];
    place(s, 0, 320, 300, ITEM_BOMB);
    place(s, 1, 320, 290, 0);
    place(s, 2, 500, 200, 3);
    sim.step(s, [cursor(s.tick, 340)]);
    expect(s.hitBomb).toBe(true);
    expect(s.phase).toBe('ending');
    expect(s.fx).toContainEqual({ t: 'boom' });
    expect(s.ix[1]).toBe(320); // 同一拍后面的槽也接不到
    expect(sim.score(s)).toBe(12);
    const before = s.catcherX;
    while (!sim.isOver(s)) sim.step(s, [cursor(s.tick, 100)]);
    expect(s.catcherX).toBe(before);
    expect(sim.score(s)).toBe(12);
    expect(s.ix.every((x) => x === 0)).toBe(true);
  });

  it('炸弹预警：约 30% 起预警；落点在财神另一侧；第 8 帧投下，共 12 帧', () => {
    let eligible = 0;
    let warned = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const s = sim.init(seed * 17 + 5, P);
      while (!sim.isOver(s)) {
        const far =
          s.phase === 'play' &&
          s.timeLeft > 1 &&
          s.warn < 0 &&
          ((s.godState < 2 && s.godX > 320) || (s.godState > 3 && s.godX < 320));
        const godRight = s.godX > 320;
        sim.step(s, []);
        const w = s.fx.find((f): f is Extract<SimFx, { t: 'warn' }> => f.t === 'warn');
        if (far) eligible++;
        if (w) {
          expect(far).toBe(true);
          warned++;
          if (godRight) {
            expect(w.x).toBeGreaterThanOrEqual(160);
            expect(w.x).toBeLessThan(300);
          } else {
            expect(w.x).toBeGreaterThanOrEqual(360);
            expect(w.x).toBeLessThan(500);
          }
          expect(s.warn).toBe(0);
          const wx = w.x;
          const t0 = s.tick;
          const drops: number[] = [];
          while (s.warn >= 0 && !sim.isOver(s)) {
            sim.step(s, []);
            for (const f of s.fx) if (f.t === 'bombDrop') drops.push(s.tick - t0, s.ix[f.slot]!);
          }
          if (!sim.isOver(s)) {
            expect(s.tick - t0).toBe(12);
            expect(drops).toEqual([8, wx]);
          }
        }
      }
    }
    expect(eligible).toBeGreaterThan(3000);
    expect(Math.abs(warned / eligible - 0.3)).toBeLessThan(0.03);
  });

  it('不操作：18 秒后时间到，ending 等掉落物落完，0 分（静止接不到）', () => {
    const s = sim.init(42, P);
    while (s.phase !== 'ending') sim.step(s, []);
    expect(s.tick).toBe(370);
    expect(s.fx).toContainEqual({ t: 'timeup' });
    while (!sim.isOver(s)) {
      sim.step(s, []);
      expect(s.godState).toBe(2);
      expect(s.fx.some((f) => f.t === 'drop')).toBe(false);
    }
    expect(s.tick).toBeLessThanOrEqual(XICONG_SPEC.maxTicks);
    expect(sim.score(s)).toBe(0);
  });

  it('时间到后接物者不再跟随光标', () => {
    const s = sim.init(8, P);
    while (s.phase !== 'ending') sim.step(s, [cursor(s.tick, s.tick % 2 === 0 ? 100 : 500)]);
    const x = s.catcherX;
    while (!sim.isOver(s)) sim.step(s, [cursor(s.tick, 600)]);
    expect(s.catcherX).toBe(x);
    expect(s.catcherDir).toBe(0);
    expect(sim.accepting(s)).toBe(false);
  });

  it('计分 10/5/3/1；姿势分档', () => {
    const s = sim.init(1, P);
    s.counts = [2, 3, 4, 5];
    expect(sim.score(s)).toBe(20 + 15 + 12 + 5);
    expect([xicongPose(39), xicongPose(40), xicongPose(49), xicongPose(50), xicongPose(60)]).toEqual([0, 1, 1, 2, 3]);
  });

  it('validateInput：只收 CursorX、x 0..639、不带第 4 项', () => {
    expect(sim.validateInput([0, InputCode.CursorX, 0])).toBe(true);
    expect(sim.validateInput([0, InputCode.CursorX, 639])).toBe(true);
    expect(sim.validateInput([0, InputCode.CursorX, 640])).toBe(false);
    expect(sim.validateInput([0, InputCode.CursorX, 5, 5])).toBe(false);
    expect(sim.validateInput([0, InputCode.Click, 5, 5])).toBe(false);
  });

  it('clone 独立、hash 相同', () => {
    const s = sim.init(11, P);
    for (let i = 0; i < 80; i++) sim.step(s, []);
    const c = sim.clone(s);
    expect(c).toEqual(s);
    expect(sim.hash(c)).toBe(sim.hash(s));
    sim.step(c, [cursor(c.tick, 0)]);
    expect(s.tick).toBe(80);
    expect(sim.hash(c)).not.toBe(sim.hash(s));
  });
});
