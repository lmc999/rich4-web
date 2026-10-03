import { describe, expect, expectTypeOf, it } from 'vitest';
import { GAME_EVENT_TYPES, type GameEvent, type GameEventType, type GodKind } from '../engine/types/index';
import {
  DEFAULT_PACING as NET_DEFAULT_PACING,
  PACING_PROFILES as NET_PACING_PROFILES,
  type PacingProfile as NetPacingProfile,
} from '../net/timing';
import {
  CARD_GAIN_FOCUS_MS,
  CARD_GAIN_SHOW_SOURCES,
  CARD_SHOW_EVENT_TYPES,
  CARD_SHOW_MS,
  CARD_SHOW_TAIL_MS,
  COMPACT_BUDGET_MS,
  cardGainShows,
  DEFAULT_PACING,
  DICE_FLIC_FRAMES,
  DICE_KNOCK_FRAME,
  DICE_THROW_FRAMES_MAX,
  DICE_TIMING,
  diceShowMs,
  EVENT_BUDGET_MS,
  estimateAnimMs,
  eventBudgetMs,
  FATE_SHOW,
  FATE_SHOW_EVENT_TYPES,
  FATE_VOICE_MS,
  FLIC_EVENT_TYPES,
  FLIC_SLACK_MS,
  fateShowMs,
  flicMs,
  flicReserveOf,
  GOD_ARRIVAL_FLICS,
  NEWS_SHOW,
  NEWS_SHOW_EVENT_TYPES,
  NEWS_VOICE_MS,
  newsShowMs,
  ORIGINAL_BUDGET_MS,
  ORIGINAL_FLICS,
  PACING_PROFILES,
  PARACHUTE_FLICS,
  type PacingProfile,
  STEP_MS,
  WALK_OUT,
  WALK_OUT_EVENT_TYPES,
  WALK_OUT_TAIL_MS,
  walkOutMs,
  walkOutSwitchTick,
  walkOutTicks,
} from './pacing';

/** 任意事件类型的替身：函数型预算与 FLIC 预留读到的字段都给上（与 logFormat.test 同一做法） */
function stub(type: GameEventType): GameEvent {
  return {
    type,
    path: [1, 2],
    wheel: null,
    slot: null,
    mode: 'played',
    actor: { t: 'seat', seat: 0 },
    where: 'jail',
    cause: { k: 'object', ref: null, by: null },
    obj: { id: 1, kind: 'mine', node: 1, placedBy: 0 },
    source: 'square',
    kind: 1,
    dice: [3],
    diceCount: 1,
    giveCard: false,
  } as unknown as GameEvent;
}

const seat = (s: 0 | 1 | 2 | 3) => ({ t: 'seat', seat: s }) as const;
const cause = { k: 'card', ref: 1, by: 0 } as const;

describe('pacing：两种节奏的预算表', () => {
  it('节奏字面量与 net/timing 一致；默认 original', () => {
    expectTypeOf<PacingProfile>().toEqualTypeOf<NetPacingProfile>();
    expect([...PACING_PROFILES]).toEqual([...NET_PACING_PROFILES]);
    expect(DEFAULT_PACING).toBe('original');
    expect(NET_DEFAULT_PACING).toBe(DEFAULT_PACING);
    expect(Object.keys(EVENT_BUDGET_MS).sort()).toEqual([...PACING_PROFILES].sort());
    expect(EVENT_BUDGET_MS.compact).toBe(COMPACT_BUDGET_MS);
    expect(EVENT_BUDGET_MS.original).toBe(ORIGINAL_BUDGET_MS);
  });

  it.each(PACING_PROFILES)('%s 表覆盖全部事件类型且没有多余键', (p) => {
    expect(Object.keys(EVENT_BUDGET_MS[p]).sort()).toEqual([...GAME_EVENT_TYPES].sort());
  });

  it('穷举：每种事件在两种节奏下都是非负整数，original ≥ compact；没有 FLIC 预留、也不亮卡的完全相同', () => {
    const flicTypes = new Set<string>([
      ...FLIC_EVENT_TYPES,
      ...CARD_SHOW_EVENT_TYPES,
      ...FATE_SHOW_EVENT_TYPES,
      ...NEWS_SHOW_EVENT_TYPES,
      ...WALK_OUT_EVENT_TYPES,
    ]);
    for (const t of GAME_EVENT_TYPES) {
      const e = stub(t);
      const c = eventBudgetMs(e, 'compact');
      const o = eventBudgetMs(e, 'original');
      for (const ms of [c, o]) {
        expect(Number.isInteger(ms), t).toBe(true);
        expect(ms, t).toBeGreaterThanOrEqual(0);
      }
      expect(o, t).toBeGreaterThanOrEqual(c);
      if (!flicTypes.has(t)) expect(EVENT_BUDGET_MS.original[t], t).toBe(EVENT_BUDGET_MS.compact[t]);
    }
    // FLIC 预留只出现在真实事件类型上
    for (const t of FLIC_EVENT_TYPES) expect(GAME_EVENT_TYPES).toContain(t);
  });

  it('缺省节奏为 compact（旧调用方口径不变）', () => {
    const e: GameEvent = { type: 'CONFINED', actor: seat(1), where: 'hospital', days: 3, total: 3, cause };
    expect(eventBudgetMs(e)).toBe(eventBudgetMs(e, 'compact'));
    expect(estimateAnimMs([e])).toBe(estimateAnimMs([e], 'compact'));
  });
});

describe('pacing：compact（architecture §5.9 的示例值）', () => {
  it('示例值', () => {
    expect(STEP_MS).toBe(180);
    expect(COMPACT_BUDGET_MS.TOLL_PAID).toBe(1100);
    expect(COMPACT_BUDGET_MS.NEWS).toBe(3800);
    expect(COMPACT_BUDGET_MS.LOTTERY_DRAW).toBe(4200);
    const move: GameEvent = { type: 'MOVE_SEGMENT', actor: seat(0), path: [1, 2, 3, 4], remaining: 0 };
    expect(eventBudgetMs(move, 'compact')).toBe(4 * 180 + 250);
    // 行走不是 FLIC：两种节奏相同
    expect(eventBudgetMs(move, 'original')).toBe(4 * 180 + 250);
  });

  it('MINIGAME_ENDED 按 mode 取值', () => {
    const base = { type: 'MINIGAME_ENDED', seat: 0, minigameId: 'penguin', score: 60 } as const;
    for (const p of PACING_PROFILES) {
      expect(eventBudgetMs({ ...base, mode: 'played', speechSlot: null }, p)).toBeLessThan(
        eventBudgetMs({ ...base, mode: 'skipped', speechSlot: 1 }, p),
      );
    }
  });
});

describe('pacing：original（原版 FLIC 原长）', () => {
  it('FLIC 原长 = 帧数 × 帧间隔（audio_video.md §2.3 的两个对照值）', () => {
    expect(flicMs(ORIGINAL_FLICS.ambulance)).toBe(6200);
    expect(flicMs(ORIGINAL_FLICS.policeCar)).toBe(2485);
    expect(flicMs(ORIGINAL_FLICS.christmas)).toBe(7650);
    // 骰子 FLC 文件头 14 ms（事实值）；播放时 exe 用 flags 覆盖成按游戏速度的帧间隔，见下面「掷骰」
    expect(flicMs(ORIGINAL_FLICS.dice2)).toBe(504);
    expect(Object.keys(GOD_ARRIVAL_FLICS).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15]);
    expect(PARACHUTE_FLICS.map((f) => f.res)).toEqual([518, 519, 520, 521, 522, 523, 524, 525, 526, 527, 528, 529]);
  });

  /** original 预算 = max(compact, 原长 + FLIC 之外的等待 + 余量) */
  const expected = (e: GameEvent, flic: number, extra: number) =>
    Math.max(eventBudgetMs(e, 'compact'), flic + extra + FLIC_SLACK_MS);

  it('送医院 / 坐牢按救护车 / 警车原长；恶人与出国、旅馆不变', () => {
    const hospital: GameEvent = { type: 'CONFINED', actor: seat(1), where: 'hospital', days: 3, total: 3, cause };
    const jail: GameEvent = { ...hospital, where: 'jail' };
    expect(eventBudgetMs(hospital, 'original')).toBe(6200 + 350 + FLIC_SLACK_MS);
    expect(eventBudgetMs(jail, 'original')).toBe(2485 + 350 + FLIC_SLACK_MS);
    expect(eventBudgetMs(hospital, 'compact')).toBe(1500);
    for (const e of [
      { ...hospital, where: 'away' },
      { ...hospital, where: 'hotel' },
      { ...hospital, actor: { t: 'villain', kind: 'thief' } },
    ] as GameEvent[]) {
      expect(eventBudgetMs(e, 'original')).toBe(eventBudgetMs(e, 'compact'));
      expect(flicReserveOf(e)).toBeNull();
    }
  });

  it('神明降临按 GodKind 取对应 FLIC；恶犬没有降临动画', () => {
    for (const kind of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15] as GodKind[]) {
      const e: GameEvent = { type: 'GOD_ATTACHED', seat: 0, kind, displaced: null };
      const f = GOD_ARRIVAL_FLICS[kind];
      const want = f ? expected(e, flicMs(f), 100) : 1500;
      expect(eventBudgetMs(e, 'original'), `kind ${kind}`).toBe(want);
    }
    const bigFortune: GameEvent = { type: 'GOD_ATTACHED', seat: 0, kind: 4, displaced: null };
    expect(eventBudgetMs(bigFortune, 'original')).toBe(3500 + 100 + FLIC_SLACK_MS);
    expect(flicReserveOf(bigFortune)?.flic.res).toBe(502);
  });

  it('飞弹 / 核弹 / 外星人按原长；台风在 compact 内；3×3 炸弹没有预留', () => {
    const base = { type: 'STRIKE', center: 6, half: 100, lots: [], actors: [] } as const;
    const ms = (kind: string, p: PacingProfile) => eventBudgetMs({ ...base, kind } as unknown as GameEvent, p);
    expect(ms('missile', 'original')).toBe(2166 + 550 + FLIC_SLACK_MS);
    expect(ms('nuke', 'original')).toBe(2964 + 550 + FLIC_SLACK_MS);
    expect(ms('alien', 'original')).toBe(4104 + 550 + FLIC_SLACK_MS);
    expect(ms('typhoon', 'original')).toBe(2400);
    expect(ms('bomb3x3', 'original')).toBe(2400);
    for (const k of ['missile', 'nuke', 'alien', 'typhoon', 'bomb3x3']) expect(ms(k, 'compact')).toBe(2400);
  });

  it('得卡 / 得点券只在卡片格 / 点券格；踩雷的小爆炸；身上炸弹的大爆炸', () => {
    const card: GameEvent = { type: 'CARD_GAINED', seat: 0, card: 3, source: 'square' };
    // 卡片格：FLIC 原长 + 亮卡 1.5 秒 + 收尾 + 余量
    expect(eventBudgetMs(card, 'original')).toBe(994 + 1500 + CARD_SHOW_TAIL_MS + FLIC_SLACK_MS);
    expect(eventBudgetMs({ ...card, source: 'shop' }, 'original')).toBe(700);
    const pts: GameEvent = { type: 'POINTS_GAINED', seat: 0, amount: 30, source: 'square' };
    expect(eventBudgetMs(pts, 'original')).toBe(994 + FLIC_SLACK_MS);
    expect(eventBudgetMs({ ...pts, source: 'chest' }, 'original')).toBe(700);
    const obj = { id: 1, kind: 'mine', node: 6, placedBy: 0 } as const;
    const boom: GameEvent = { type: 'OBJECT_REMOVED', obj, cause: { k: 'object', ref: null, by: null } };
    expect(eventBudgetMs(boom, 'original')).toBe(912 + FLIC_SLACK_MS);
    expect(eventBudgetMs({ ...boom, obj: { ...obj, kind: 'roadblock' } } as GameEvent, 'original')).toBe(500);
    expect(eventBudgetMs({ ...boom, cause } as GameEvent, 'original')).toBe(500);
    const bomb: GameEvent = { type: 'BOMB_EXPLODED', seat: 2, node: 6, lot: null };
    expect(eventBudgetMs(bomb, 'original')).toBe(2911 + 700 + FLIC_SLACK_MS);
  });

  it('节日：送卡的是圣诞；开局跳伞按最长的角色；乐透、破产原长本来就在预算内', () => {
    expect(eventBudgetMs({ type: 'HOLIDAY', key: 'h15', giveCard: true }, 'original')).toBe(7650 + FLIC_SLACK_MS);
    expect(eventBudgetMs({ type: 'HOLIDAY', key: 'h0', giveCard: false }, 'original')).toBe(2772 + FLIC_SLACK_MS);
    const chute: GameEvent = { type: 'PARACHUTE', seat: 1, node: 5, prev: 4 };
    expect(eventBudgetMs(chute, 'original')).toBe(40 * 42 + 600 + FLIC_SLACK_MS);
    for (const e of [
      { type: 'LOTTERY_DRAW', number: 3, winner: 1, prize: 5000 },
      { type: 'BANKRUPT', seat: 2, cause, creditor: null },
    ] as GameEvent[]) {
      expect(flicReserveOf(e), e.type).not.toBeNull();
      expect(eventBudgetMs(e, 'original'), e.type).toBe(eventBudgetMs(e, 'compact'));
    }
    const magic: GameEvent = { type: 'MAGIC_CAST', caster: 0, effect: 2, targets: [1] };
    expect(eventBudgetMs(magic, 'original')).toBe(1775 + 200 + FLIC_SLACK_MS);
  });

  it('flicReserveOf：可用时长 = original 预算 − FLIC 之外的等待 ≥ FLIC 原长', () => {
    const samples: GameEvent[] = [
      { type: 'CONFINED', actor: seat(1), where: 'hospital', days: 3, total: 3, cause },
      { type: 'GOD_ATTACHED', seat: 0, kind: 3, displaced: null },
      { type: 'GOD_LEFT', seat: 0, kind: 3, reason: 'expired' },
      { type: 'STRIKE', kind: 'nuke', center: 6, half: 220, lots: [], actors: [] },
      { type: 'HOLIDAY', key: 'h1', giveCard: true },
      { type: 'PARACHUTE', seat: 0, node: 3, prev: 2 },
      { type: 'DICE_ROLLED', seat: 0, dice: [2], steps: 2, forced: false, diceCount: 1 },
    ];
    for (const e of samples) {
      const r = flicReserveOf(e);
      expect(r, e.type).not.toBeNull();
      expect(eventBudgetMs(e, 'original') - r!.extraMs, e.type).toBeGreaterThanOrEqual(flicMs(r!.flic));
    }
    expect(flicReserveOf({ type: 'TOLL_PAID' } as GameEvent)).toBeNull();
  });
});

describe('pacing：亮卡（原版 fcn.00440bac：卡图 + 消息框停 1.5 秒）', () => {
  const used: GameEvent = { type: 'CARD_USED', seat: 0, card: 17, target: { t: 'none' } };
  const passive: GameEvent = { type: 'PASSIVE', seat: 1, card: 21, context: 'frame', other: null };

  it('original 按原版 1.5 秒（0x440ce4 fcn.00450f9a(1500)），compact 沿用 1.2 / 0.95 秒（得卡 1.2 秒）', () => {
    expect(CARD_SHOW_MS.original).toEqual({ castMs: 1500, passiveMs: 1500, gainMs: 1500 });
    expect(CARD_SHOW_MS.compact).toEqual({ castMs: 1200, passiveMs: 950, gainMs: 1200 });
    expect([...CARD_SHOW_EVENT_TYPES]).toEqual(['CARD_USED', 'PASSIVE', 'CARD_GAINED']);
  });

  it('预算 = 亮卡 + 收尾 + 余量（original）；compact 不变且放得下 compact 的亮卡与收尾', () => {
    expect(eventBudgetMs(used, 'original')).toBe(1500 + CARD_SHOW_TAIL_MS + FLIC_SLACK_MS);
    expect(eventBudgetMs(passive, 'original')).toBe(1500 + CARD_SHOW_TAIL_MS + FLIC_SLACK_MS);
    expect(eventBudgetMs(used, 'compact')).toBe(1400);
    expect(eventBudgetMs(passive, 'compact')).toBe(1200);
    for (const p of PACING_PROFILES) {
      expect(eventBudgetMs(used, p)).toBeGreaterThanOrEqual(CARD_SHOW_MS[p].castMs + CARD_SHOW_TAIL_MS);
      expect(eventBudgetMs(passive, p)).toBeGreaterThanOrEqual(CARD_SHOW_MS[p].passiveMs + CARD_SHOW_TAIL_MS);
    }
    // 没有效果（原版没有对应的亮卡）两种节奏相同
    const fizzle: GameEvent = { type: 'CARD_NO_EFFECT', seat: 0, card: 16 };
    expect(eventBudgetMs(fizzle, 'original')).toBe(eventBudgetMs(fizzle, 'compact'));
  });
});

describe('pacing：掷骰（原版时序：持骰动作 → FLC 36 帧 → 落定停留）', () => {
  const roll = (dice: number[]): GameEvent =>
    ({
      type: 'DICE_ROLLED',
      seat: 0,
      dice,
      steps: dice.reduce((a, b) => a + b, 0),
      forced: false,
      diceCount: Math.max(1, dice.length),
    }) as GameEvent;

  it('original 取原版默认速度 1（tick 80 ms、FLC 30 ms/帧、停留 500 ms），compact 取速度 2', () => {
    expect(DICE_TIMING.original).toEqual({ throwTickMs: 80, flicFrameMs: 30, holdMs: 500 });
    expect(DICE_TIMING.compact).toEqual({ throwTickMs: 40, flicFrameMs: 20, holdMs: 300 });
    expect([DICE_FLIC_FRAMES, DICE_KNOCK_FRAME, DICE_THROW_FRAMES_MAX]).toEqual([36, 30, 9]);
    // 步行 9 帧持骰：720 + 1080 + 500；机车 / 汽车 4 帧：320 + 1080 + 500
    expect(diceShowMs(DICE_TIMING.original)).toBe(2300);
    expect(diceShowMs(DICE_TIMING.original, 4)).toBe(1900);
    expect(diceShowMs(DICE_TIMING.compact)).toBe(1380);
  });

  it('预算 = 持骰动作（按最多 9 帧）+ FLC + 停留 + 余量；1/2/3 颗相同；停留 / 乌龟（dice 为空）为 0', () => {
    for (const dice of [[3], [3, 4], [2, 5, 6]]) {
      expect(eventBudgetMs(roll(dice), 'original'), `${dice}`).toBe(2300 + FLIC_SLACK_MS);
      expect(eventBudgetMs(roll(dice), 'compact'), `${dice}`).toBe(1380 + 100);
      const r = flicReserveOf(roll(dice))!;
      expect(r.flic.res).toBe(3 + dice.length);
      // 预留按实际播放：36 帧 × 30 ms（exe 覆盖文件头的 14 ms）
      expect(flicMs(r.flic)).toBe(1080);
      expect(r.extraMs).toBe(9 * 80 + 500);
    }
    expect(flicReserveOf(roll([]))).toBeNull();
    for (const p of PACING_PROFILES) expect(eventBudgetMs(roll([]), p)).toBe(0);
  });
});

describe('pacing：得卡亮卡（原版只在卡片格 0x41abfa 与聖誕節 0x450e29 亮卡）', () => {
  const gain = (source: string): GameEvent => ({ type: 'CARD_GAINED', seat: 0, card: 3, source }) as GameEvent;

  it('亮卡的来源只有卡片格与聖誕節；其余得卡途径两种节奏都是 700', () => {
    expect([...CARD_GAIN_SHOW_SOURCES]).toEqual(['square', 'holiday']);
    for (const s of ['shop', 'god', 'chairmanGift', 'rob', 'birthday', 'villain', 'magic', 'board', 'debug']) {
      expect(cardGainShows(s), s).toBe(false);
      for (const p of PACING_PROFILES) expect(eventBudgetMs(gain(s), p), `${s} ${p}`).toBe(700);
    }
    expect(cardGainShows('square')).toBe(true);
    expect(cardGainShows('holiday')).toBe(true);
  });

  it('卡片格：original = FLIC 原长 + 亮卡 + 收尾 + 余量；compact 给 FLIC 约 0.5 秒，FLIC 之后同样留足 1.5 秒亮卡', () => {
    const r = flicReserveOf(gain('square'))!;
    expect(r.flic).toBe(ORIGINAL_FLICS.cardGain);
    expect(r.extraMs).toBe(CARD_SHOW_MS.original.gainMs + CARD_SHOW_TAIL_MS);
    expect(eventBudgetMs(gain('square'), 'original')).toBe(flicMs(r.flic) + r.extraMs + FLIC_SLACK_MS);
    expect(eventBudgetMs(gain('square'), 'compact')).toBe(500 + r.extraMs + FLIC_SLACK_MS);
    // 两种节奏都放得下各自的亮卡（compact 的亮卡比预留短，FLIC 之后不会被截断）
    for (const p of PACING_PROFILES) {
      expect(eventBudgetMs(gain('square'), p) - r.extraMs - FLIC_SLACK_MS).toBeGreaterThan(0);
      expect(r.extraMs).toBeGreaterThanOrEqual(CARD_SHOW_MS[p].gainMs + CARD_SHOW_TAIL_MS);
    }
  });

  it('聖誕節：镜头 + 亮卡 + 收尾 + 余量（没有 FLIC 预留，圣诞 FLIC 在 HOLIDAY 事件里）', () => {
    expect(flicReserveOf(gain('holiday'))).toBeNull();
    for (const p of PACING_PROFILES) {
      expect(eventBudgetMs(gain('holiday'), p)).toBe(
        CARD_GAIN_FOCUS_MS + CARD_SHOW_MS[p].gainMs + CARD_SHOW_TAIL_MS + FLIC_SLACK_MS,
      );
    }
  });

  it('预算与卡号无关（私密手牌下别人收到的 card 为 null，所有观察者同一预算）', () => {
    for (const s of ['square', 'holiday'])
      for (const p of PACING_PROFILES)
        expect(eventBudgetMs({ ...gain(s), card: null } as GameEvent, p)).toBe(eventBudgetMs(gain(s), p));
  });
});

describe('pacing：命运板（原版 fcn.0044c4a0：语音 ≥ 1.6 秒 → 效果 / 加持消息框 1.5 秒 → 0.8 秒）', () => {
  const fate = (id: number, blessing: 'high' | 'low' | null = null): GameEvent =>
    ({ type: 'FATE', seat: 0, id, amount: null, blessing }) as GameEvent;

  it('语音时长表 49 项（Speaking#185–233），1282–3816 ms', () => {
    expect(FATE_VOICE_MS).toHaveLength(49);
    expect(Math.min(...FATE_VOICE_MS)).toBe(1282);
    expect(Math.max(...FATE_VOICE_MS)).toBe(3816);
    expect(FATE_VOICE_MS.filter((v) => v <= 1600)).toHaveLength(7);
  });

  it('original：板子停留 = max(1.6 秒, 语音)，加持消息框 1.5 秒，停顿 0.8 秒', () => {
    expect(FATE_SHOW.original).toEqual({ minHoldMs: 1600, blessingMs: 1500, tailMs: 800, endMs: 100 });
    expect(fateShowMs(25, false, 'original')).toEqual({ holdMs: 1600, blessingMs: 0, tailMs: 800, endMs: 100 });
    expect(fateShowMs(4, true, 'original')).toEqual({ holdMs: 3816, blessingMs: 1500, tailMs: 800, endMs: 100 });
    // 33 在日本图（slot 41）的语音
    expect(fateShowMs(41, false, 'original').holdMs).toBe(2820);
  });

  it('compact：总长 2.25 秒不变（有加持时板子 1.35 + 消息框 0.9）+ 收尾 0.2 秒', () => {
    for (const slot of [0, 4, 25, 48]) {
      for (const b of [false, true]) {
        const t = fateShowMs(slot, b, 'compact');
        expect(t.holdMs + t.blessingMs + t.tailMs, `${slot} ${b}`).toBe(2250);
        expect(t.endMs).toBe(200);
      }
    }
    expect(eventBudgetMs(fate(4, 'high'), 'compact')).toBe(COMPACT_BUDGET_MS.FATE);
  });

  it('original 预算 = max(compact, 停留 + 加持 + 停顿 + 收尾 + 余量)；33–36 取四张图里最长的语音', () => {
    const o = FATE_SHOW.original;
    expect(eventBudgetMs(fate(25), 'original')).toBe(Math.max(2600, 1600 + o.tailMs + o.endMs + FLIC_SLACK_MS));
    expect(eventBudgetMs(fate(4, 'high'), 'original')).toBe(3816 + 1500 + 800 + 100 + FLIC_SLACK_MS);
    expect(eventBudgetMs(fate(4, 'low'), 'original')).toBe(eventBudgetMs(fate(4, 'high'), 'original'));
    const k33 = Math.max(FATE_VOICE_MS[33]!, FATE_VOICE_MS[37]!, FATE_VOICE_MS[41]!, FATE_VOICE_MS[45]!);
    expect(eventBudgetMs(fate(33), 'original')).toBe(k33 + 800 + 100 + FLIC_SLACK_MS);
    for (let id = 0; id <= 36; id++) {
      for (const b of [null, 'high'] as const) {
        expect(eventBudgetMs(fate(id, b), 'original'), `${id}`).toBeGreaterThanOrEqual(
          eventBudgetMs(fate(id, b), 'compact'),
        );
      }
    }
  });
});

describe('pacing：新闻板（原版 fcn.0044a173：fcn.00452c39(2400) 等语音 ≥ 2.4 秒，之后没有停顿）', () => {
  const news = (id: number): GameEvent => ({ type: 'NEWS', id, params: {}, affected: [] }) as GameEvent;

  it('语音时长表 36 项（Speaking#149–184），1346–3935 ms', () => {
    expect(NEWS_VOICE_MS).toHaveLength(36);
    expect(Math.min(...NEWS_VOICE_MS)).toBe(1346);
    expect(Math.max(...NEWS_VOICE_MS)).toBe(3935);
    expect(NEWS_VOICE_MS.indexOf(3935)).toBe(29);
  });

  it('original：停留 = max(2.4 秒, 语音)、收尾 0.2 秒；compact 沿用 3.4 秒', () => {
    expect(NEWS_SHOW.original).toEqual({ minHoldMs: 2400, endMs: 200 });
    expect(newsShowMs(11, 'original')).toEqual({ holdMs: 2400, endMs: 200 });
    expect(newsShowMs(5, 'original')).toEqual({ holdMs: 3068, endMs: 200 });
    expect(newsShowMs(29, 'original').holdMs).toBe(3935);
    for (const id of [0, 11, 29, 35]) expect(newsShowMs(id, 'compact')).toEqual({ holdMs: 3400, endMs: 200 });
  });

  it('original 预算 = max(compact 3.8 秒, 停留 + 收尾 + 余量)；只有语音超过 3.5 秒的新闻 29 放宽', () => {
    expect(eventBudgetMs(news(11), 'original')).toBe(COMPACT_BUDGET_MS.NEWS);
    expect(eventBudgetMs(news(29), 'original')).toBe(3935 + 200 + FLIC_SLACK_MS);
    for (let id = 0; id < 36; id++) {
      const t = newsShowMs(id, 'original');
      const o = eventBudgetMs(news(id), 'original');
      expect(o, `${id}`).toBeGreaterThanOrEqual(eventBudgetMs(news(id), 'compact'));
      expect(o, `${id}`).toBeGreaterThanOrEqual(t.holdMs + t.endMs);
      expect(eventBudgetMs(news(id), 'compact')).toBe(3800);
    }
  });
});

describe('pacing：获释走出建筑（原版 fcn.0040bb40 bit4 分支：8 px / tick，过半才画出来）', () => {
  const released = (from: 'jail' | 'hospital' | 'hotel' | 'away'): GameEvent => ({
    type: 'RELEASED',
    actor: seat(1),
    from,
  });

  it('tick 数 = trunc(距离 / 8)、至少 1、不超过上限；过半（剩余 < tick 数 >> 1）时换显隐', () => {
    expect(WALK_OUT.pxPerTick).toBe(8);
    // 四张图的实际距离（景观 → 关押格，世界像素）：台湾监狱 110.2 / 医院 92.6、美国监狱 130.0
    expect(walkOutTicks(110.2)).toBe(13);
    expect(walkOutTicks(92.6)).toBe(11);
    expect(walkOutTicks(130)).toBe(16);
    expect(walkOutTicks(0)).toBe(1);
    expect(walkOutTicks(500)).toBe(WALK_OUT.maxTicks);
    expect(walkOutTicks(500, WALK_OUT.hotelMaxTicks)).toBe(10);
    // 16 tick：剩余 7 < 8 在第 9 个 tick；13 tick：剩余 5 < 6 在第 8 个；3 tick 以内走到才换
    expect(walkOutSwitchTick(16)).toBe(9);
    expect(walkOutSwitchTick(13)).toBe(8);
    expect(walkOutSwitchTick(4)).toBe(3);
    expect(walkOutSwitchTick(3)).toBe(3);
    expect(walkOutSwitchTick(1)).toBe(1);
  });

  it('tick 与掷骰动作同一个（original 80 ms、compact 40 ms）', () => {
    for (const p of PACING_PROFILES) expect(walkOutMs(p, 1)).toBe(DICE_TIMING[p].throwTickMs);
    expect(walkOutMs('original')).toBe(16 * 80);
    expect(walkOutMs('compact')).toBe(16 * 40);
  });

  it('RELEASED：坐牢 / 住院 / 住旅馆 = max(1 秒, 走出 + 收尾 + 余量)；消失与恶人 1 秒；RETURNED 只剩落定的停顿', () => {
    // compact 是常数 1 秒：最远的走出也放得下
    expect(COMPACT_BUDGET_MS.RELEASED).toBe(1000);
    expect(walkOutMs('compact') + WALK_OUT_TAIL_MS + FLIC_SLACK_MS).toBeLessThanOrEqual(COMPACT_BUDGET_MS.RELEASED);
    for (const p of PACING_PROFILES) {
      for (const from of ['jail', 'hospital'] as const) {
        expect(eventBudgetMs(released(from), p)).toBe(
          Math.max(1000, walkOutMs(p, WALK_OUT.maxTicks) + WALK_OUT_TAIL_MS + FLIC_SLACK_MS),
        );
      }
      expect(eventBudgetMs(released('hotel'), p)).toBe(
        Math.max(1000, walkOutMs(p, WALK_OUT.hotelMaxTicks) + WALK_OUT_TAIL_MS + FLIC_SLACK_MS),
      );
      expect(eventBudgetMs(released('away'), p)).toBe(1000);
      const villain: GameEvent = { type: 'RELEASED', actor: { t: 'villain', kind: 'thief' }, from: 'jail' };
      expect(eventBudgetMs(villain, p)).toBe(1000);
      expect(eventBudgetMs({ type: 'RETURNED', seat: 1, node: 14 }, p)).toBe(400);
    }
    expect(eventBudgetMs(released('jail'), 'original')).toBe(1480);
    expect(eventBudgetMs(released('jail'), 'compact')).toBe(1000);
  });
});

describe('estimateAnimMs', () => {
  it('为各事件预算之和，空批为 0；按节奏求和', () => {
    const events: GameEvent[] = [
      { type: 'DICE_ROLLED', seat: 0, dice: [3], steps: 3, forced: false, diceCount: 1 },
      { type: 'MOVE_SEGMENT', actor: seat(0), path: [2, 3, 4], remaining: 0 },
      { type: 'CARD_GAINED', seat: 0, card: 3, source: 'square' },
      { type: 'SYNC', reason: 'flush' },
    ];
    // 卡片格得卡：FLIC 之后亮卡 1.5 秒 + 收尾（compact 的 FLIC 约 0.5 秒）
    expect(estimateAnimMs(events, 'compact')).toBe(1480 + 3 * 180 + 250 + 500 + 1600 + 100);
    expect(estimateAnimMs(events, 'original')).toBe(2400 + 3 * 180 + 250 + 994 + 1600 + FLIC_SLACK_MS);
    for (const p of PACING_PROFILES) {
      expect(estimateAnimMs([], p)).toBe(0);
      expect(estimateAnimMs(events, p)).toBe(events.reduce((a, e) => a + eventBudgetMs(e, p), 0));
    }
  });
});
