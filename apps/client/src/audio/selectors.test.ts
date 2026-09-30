// 原版映射选择器：场景曲（UI 状态与事件）、音效（素材包 cue / ZzFX 回退 / guess 默认回退）、语音（确定性变体与概率）。
import { buildMapIndex, buildTestMap, type LotId } from '@rich4/shared/data';
import { GAME_EVENT_TYPES, type GameEvent, type SeatIndex } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { describe, expect, it } from 'vitest';
import { SOUND_MAP } from '../presentation/soundMap';
import { selfPlay } from '../test/selfPlay';
import { makeSoundQuery, moneyTier, pointsTier } from './cues';
import {
  boardActiveFor,
  holidaySceneOf,
  sceneCueFor,
  sceneFor,
  sceneLayersFor,
  sfxFor,
  voiceFor,
  voiceSeed,
} from './selectors';
import { cardKey, itemKey, MULTI_SLOT, slotKey, testMusicMap, testSfxSets, testVoiceMap } from './testing/fixtures';

const map = buildMapIndex(buildTestMap());
const base = selfPlay({ seed: 1, steps: 0 }).initial.view;
/** 座位 0..3 的角色号 */
const CHARS = base.players.map((p) => p.character);

function viewWith(edit?: (v: GameView) => void): () => GameView {
  const v = structuredClone(base);
  edit?.(v);
  return () => v;
}

const vm = testVoiceMap();
const sets = testSfxSets();
const q0 = makeSoundQuery(viewWith(), map);
const ctx = (seq: number, eventIndex = 0) => ({ epoch: 1, seq, eventIndex });

describe('SOUND_MAP', () => {
  it('对 GameEventType 穷举', () => {
    expect(Object.keys(SOUND_MAP).sort()).toEqual([...GAME_EVENT_TYPES].sort());
  });
});

describe('sceneFor（UI 状态）', () => {
  it('整屏场景与场所曲', () => {
    expect(sceneFor({ screen: 'title' })).toEqual({ scene: 'title', noResume: false });
    expect(sceneFor({ screen: 'lobby' })).toEqual({ scene: 'setup', noResume: true });
    expect(sceneFor({ screen: 'gameOver' })).toEqual({ scene: 'gameOver', noResume: true });
    expect(sceneFor({ screen: 'none' })).toBeNull();
    expect(sceneFor({ screen: 'game' })).toBeNull();
    const at = (kind: Parameters<typeof sceneFor>[0]['venue']) =>
      sceneFor({ screen: 'game', venue: kind })?.scene ?? null;
    expect(at({ kind: 'BANK_COUNTER' })).toBe('bank');
    expect(at({ kind: 'BANK_ATM' })).toBe('bank');
    expect(at({ kind: 'SHOP' })).toBe('shop');
    expect(at({ kind: 'LOTTERY' })).toBe('lotteryBet');
    expect(at({ kind: 'MAGIC_CAST' })).toBe('magic');
    expect(at({ kind: 'AUCTION_BID' })).toBe('auction');
    expect(at({ kind: 'BAIL', where: 'jail' })).toBe('jail');
    expect(at({ kind: 'BAIL', where: 'hospital' })).toBe('hospital');
    expect(at({ kind: 'MINIGAME', minigameId: 'penguin' })).toBe('penguin');
    expect(at({ kind: 'MINIGAME', minigameId: 'balloon' })).toBe('balloon');
    expect(at({ kind: 'MINIGAME', minigameId: 'xicong' })).toBe('xicong');
    expect(at({ kind: 'TURN_MENU' })).toBeNull();
    expect(at({ kind: 'BUY_LAND' })).toBeNull();
  });

  it('节日在下、场所在上；只有对局中播棋盘曲', () => {
    const ui = { screen: 'game', holiday: 'christmas', venue: { kind: 'BANK_COUNTER' } } as const;
    expect(sceneLayersFor(ui)).toEqual({
      ambient: { scene: 'christmas', noResume: true },
      venue: { scene: 'bank', noResume: false },
    });
    expect(sceneFor(ui)?.scene).toBe('bank');
    expect(sceneFor({ screen: 'game', holiday: 'lunarNewYear' })?.scene).toBe('lunarNewYear');
    expect(boardActiveFor({ screen: 'game' })).toBe(true);
    expect(boardActiveFor({ screen: 'lobby' })).toBe(false);
  });

  it('holidaySceneOf：节日表标了 bgm 的节日', () => {
    const fake = {
      def: {
        holidays: [
          { slot: 1, month: 12, day: 25, kind: 0, flagsRaw: 0, bgm: true },
          { slot: 2, month: 1, day: 1, kind: 1, flagsRaw: 0, bgm: true, lunar: true },
          { slot: 3, month: 10, day: 10, kind: 0, flagsRaw: 0 },
        ],
      },
    } as unknown as typeof map;
    const at = (h: string | null) =>
      holidaySceneOf(
        viewWith((v) => {
          v.clock.holiday = h;
        })(),
        fake,
      );
    expect(at('h1')).toBe('christmas');
    expect(at('h2')).toBe('lunarNewYear');
    expect(at('h3')).toBeNull();
    expect(at(null)).toBeNull();
    expect(holidaySceneOf(base, null)).toBeNull();
  });
});

describe('sceneCueFor（事件）', () => {
  it('监狱、医院、破产、乐透开奖、月结、拍卖、结算', () => {
    const cue = (e: GameEvent) => sceneCueFor(e, q0);
    const seat = { t: 'seat', seat: 0 } as const;
    const cause = { k: 'system', ref: null, by: null } as const;
    expect(cue({ type: 'CONFINED', actor: seat, where: 'jail', days: 3, total: 3, cause })).toEqual({
      scene: 'jail',
      span: 'event',
    });
    expect(cue({ type: 'CONFINED', actor: seat, where: 'hospital', days: 3, total: 3, cause })?.scene).toBe('hospital');
    expect(cue({ type: 'CONFINED', actor: seat, where: 'away', days: 3, total: 3, cause })).toBeNull();
    expect(
      cue({ type: 'CONFINED', actor: { t: 'villain', kind: 'thief' }, where: 'jail', days: 3, total: 3, cause }),
    ).toBeNull();
    expect(cue({ type: 'BANKRUPT', seat: 1, cause, creditor: null })?.scene).toBe('bankrupt');
    expect(cue({ type: 'LOTTERY_DRAW', number: 7, winner: null, prize: 0 })?.scene).toBe('lotteryDraw');
    expect(cue({ type: 'LOTTERY_DRAW', number: null, winner: null, prize: 0 })).toBeNull();
    expect(
      cue({ type: 'AUCTION_STARTED', lot: 'L1', seller: null, source: 'card', start: 100, bidders: [0, 1] }),
    ).toEqual({ scene: 'auction', span: { until: ['AUCTION_ENDED'] } });
    expect(cue({ type: 'TURN_ENDED', actor: seat })).toBeNull();
  });
});

describe('sfxFor', () => {
  const land: GameEvent = { type: 'LAND_BOUGHT', seat: 0, lot: 'L1', price: 2000 };
  const move: GameEvent = { type: 'MOVE_SEGMENT', actor: { t: 'seat', seat: 0 }, path: [1, 2], remaining: 0 };

  it('语义置信度 exe 的 cue 用原版音效；guess 默认用 ZzFX，可切换为原版', () => {
    const walk = makeSoundQuery(
      viewWith((v) => {
        v.players[0]!.vehicle = 'walk';
      }),
      map,
    );
    expect(sfxFor(land, q0, sets, ctx(1))).toMatchObject({ key: 'sfx.049', origin: 'pack', confidence: 'exe' });
    expect(sfxFor(move, walk, sets, ctx(1))).toMatchObject({ key: 'zzfx.step', origin: 'zzfx', cue: 'move.walk' });
    expect(sfxFor(move, walk, sets, ctx(1), { guessOriginal: true })).toMatchObject({
      key: 'sfx.044',
      origin: 'pack',
      confidence: 'guess',
    });
  });

  it('没有素材包时全部走 ZzFX；只有 cue 没有 ZzFX 预设的 guess 项默认静音', () => {
    expect(sfxFor(land, q0, null, ctx(1))?.key).toBe('zzfx.stamp');
    const blocked: GameEvent = { type: 'TURN_BLOCKED', seat: 0, reason: 'jail', remaining: 2 };
    expect(sfxFor(blocked, q0, sets, ctx(1))).toBeNull();
    expect(sfxFor(blocked, q0, sets, ctx(1), { guessOriginal: true })?.key).toBe('sfx.056');
    expect(sfxFor({ type: 'SYNC', reason: 'flush' }, q0, sets, ctx(1))).toBeNull();
  });

  it('交通工具决定移动音效；flicCovered 的演出在原版皮肤里由 FLIC 出声', () => {
    const moto = makeSoundQuery(
      viewWith((v) => {
        v.players[0]!.vehicle = 'moto';
      }),
      map,
    );
    expect(sfxFor(move, moto, sets, ctx(1))?.cue).toBe('move.moto');
    expect(sfxFor(move, q0, sets, ctx(1))?.cue).toBe('move.car');
    const pts: GameEvent = { type: 'POINTS_GAINED', seat: 0, amount: 30, source: 'square' };
    expect(sfxFor(pts, q0, sets, ctx(1))?.key).toBe('sfx.036');
    expect(sfxFor(pts, q0, sets, ctx(1), { flicSfx: true })).toBeNull();
  });

  it('音效集有多个音效时按种子确定性选择', () => {
    const trade: GameEvent = {
      type: 'STOCK_TRADED',
      seat: 0,
      stock: 0,
      side: 'buy',
      shares: 1,
      priceCents: 100,
      amount: 1,
    };
    const seen = new Set<string>();
    for (let s = 0; s < 40; s++) {
      const a = sfxFor(trade, q0, sets, ctx(s), { guessOriginal: true })!.key;
      expect(sfxFor(trade, q0, sets, ctx(s), { guessOriginal: true })!.key).toBe(a);
      seen.add(a);
    }
    expect([...seen].sort()).toEqual(['sfx.040', 'sfx.041']);
  });
});

describe('voiceFor', () => {
  it('开局宣言：按座位顺序，每人一句槽 26，排队说完整句', () => {
    const r = voiceFor({ type: 'GAME_STARTED', seats: [0, 1, 2, 3], date: 20050505 }, q0, vm, ctx(1));
    expect(r.map((v) => v.key)).toEqual(CHARS.map((c) => slotKey(c, 26)));
    expect(r.every((v) => v.policy === 'queue')).toBe(true);
    expect(r.map((v) => v.speaker)).toEqual(['seat:0', 'seat:1', 'seat:2', 'seat:3']);
  });

  it('确定性：同一 {epoch, seq, 事件下标} 总是同一句；不同事件覆盖全部变体', () => {
    const e: GameEvent = {
      type: 'LOT_LEVEL',
      lot: 'L1',
      from: 4,
      to: 5,
      cause: { k: 'system', ref: 'upgrade', by: 2 },
    };
    const seen = new Set<string>();
    for (let s = 0; s < 60; s++) {
      const a = voiceFor(e, q0, vm, ctx(s, 3));
      expect(voiceFor(e, q0, vm, ctx(s, 3))).toEqual(a);
      expect(a.length).toBe(1);
      seen.add(a[0]!.key);
    }
    expect([...seen].sort()).toEqual([0, 1, 2].map((v) => slotKey(CHARS[2]!, MULTI_SLOT, v)));
    // 同一 seq 不同事件下标也会变化
    const byIndex = new Set([0, 1, 2, 3, 4, 5, 6, 7].map((i) => voiceFor(e, q0, vm, ctx(5, i))[0]!.key));
    expect(byIndex.size).toBeGreaterThan(1);
  });

  it('缺 epoch/seq/事件下标时回退到事件内容哈希（稳定）', () => {
    const e: GameEvent = {
      type: 'LOT_LEVEL',
      lot: 'L2',
      from: 4,
      to: 5,
      cause: { k: 'system', ref: 'upgrade', by: 0 },
    };
    expect(voiceSeed(e, {})).toBe(voiceSeed(structuredClone(e), {}));
    expect(voiceSeed({ ...e, post: { econ: { pool: 1 } } } as GameEvent, {})).toBe(voiceSeed(e, {}));
    expect(voiceSeed({ ...e, lot: 'L3' }, {})).not.toBe(voiceSeed(e, {}));
    expect(voiceFor(e, q0, vm, {})).toEqual(voiceFor(e, q0, vm, {}));
  });

  it('点券分档：>100 高、51–100 中、1–50 低；恰好 50 在高中二选一', () => {
    const pts = (amount: number, seq = 1) =>
      voiceFor({ type: 'POINTS_GAINED', seat: 0, amount, source: 'square' }, q0, vm, ctx(seq)).map((v) => v.key);
    const c = CHARS[0]!;
    expect(pts(120)).toEqual([slotKey(c, 0)]);
    expect(pts(80)).toEqual([slotKey(c, 1)]);
    expect(pts(30)).toEqual([slotKey(c, 2)]);
    expect(pts(0)).toEqual([]);
    const fifty = new Set(Array.from({ length: 40 }, (_, s) => pts(50, s)[0]));
    expect([...fifty].sort()).toEqual([slotKey(c, 0), slotKey(c, 1)]);
    expect(pointsTier(101)).toBe(0);
    expect(moneyTier(8999, 1)).toBe(1);
    expect(moneyTier(18000, 2)).toBe(0);
    expect(moneyTier(1999, 1)).toBeNull();
  });

  it('在独占街区加盖 1/3 概率（按种子），盖到 5 级必说', () => {
    const street = map.def.streets.find((s) => map.streetLots(s.id).length >= 3)!;
    const lots = map.streetLots(street.id).slice(0, 3) as LotId[];
    const q = makeSoundQuery(
      viewWith((v) => {
        for (const l of v.lands) if (lots.includes(l.id)) l.owner = 1;
      }),
      map,
    );
    const e = (seq: number) =>
      voiceFor(
        { type: 'LOT_LEVEL', lot: lots[0]!, from: 1, to: 2, cause: { k: 'system', ref: 'upgrade', by: 1 } },
        q,
        vm,
        ctx(seq),
      );
    let hits = 0;
    for (let s = 0; s < 300; s++) {
      const r = e(s);
      if (r.length > 0) {
        hits++;
        expect(r[0]!.key).toBe(slotKey(CHARS[1]!, 17));
      }
    }
    expect(hits / 300).toBeGreaterThan(0.25);
    expect(hits / 300).toBeLessThan(0.42);
    // 未独占：不说
    expect(
      voiceFor(
        { type: 'LOT_LEVEL', lot: lots[0]!, from: 1, to: 2, cause: { k: 'system', ref: 'upgrade', by: 1 } },
        q0,
        vm,
        ctx(1),
      ),
    ).toEqual([]);
    // 买地后同街 ≥3 块
    const q2 = makeSoundQuery(
      viewWith((v) => {
        for (const l of v.lands) if (l.id === lots[1] || l.id === lots[2]) l.owner = 0;
      }),
      map,
    );
    expect(
      voiceFor({ type: 'LAND_BOUGHT', seat: 0, lot: lots[0]!, price: 1 }, q2, vm, ctx(1)).map((v) => v.key),
    ).toEqual([slotKey(CHARS[0]!, 16)]);
  });

  it('过路费：被最敌视的对手拿走 ≥5000×PI 时 1/2 概率说「记住你了」，否则按付钱分档', () => {
    const rival = makeSoundQuery(
      viewWith((v) => {
        v.players[0]!.hostility = [0, 5, 90, 3];
      }),
      map,
    );
    const toll = (owner: SeatIndex, amount: number, seq: number) =>
      voiceFor(
        { type: 'TOLL_PAID', payer: 0, owner, ally: null, amount, allyAmount: 0, lots: ['L1'], mods: [] },
        rival,
        vm,
        ctx(seq),
      ).map((v) => v.key);
    const c = CHARS[0]!;
    const got = new Set(Array.from({ length: 60 }, (_, s) => toll(2, 6000, s)[0]));
    expect([...got].sort()).toEqual([slotKey(c, 10), slotKey(c, 18)].sort());
    expect(toll(1, 6000, 1)).toEqual([slotKey(c, 10)]);
    expect(toll(2, 9500, 2).length).toBe(1);
    expect(toll(2, 1000, 1)).toEqual([]);
  });

  it('卡片台词：对他人用 = 使用者 use + 被施用者 target；对自己用优先 self，没有则 use', () => {
    const use = (card: number, target: SeatIndex) =>
      voiceFor(
        { type: 'CARD_USED', seat: 0, card: card as 1, target: { t: 'seat', seat: target } },
        q0,
        vm,
        ctx(1),
      ).map((v) => v.key);
    expect(use(2, 3)).toEqual([cardKey(CHARS[0]!, 'use', 2), cardKey(CHARS[3]!, 'target', 2)]);
    expect(use(3, 3)).toEqual([cardKey(CHARS[0]!, 'use', 3)]); // 卡 3 没有 target 台词
    expect(use(6, 0)).toEqual([cardKey(CHARS[0]!, 'self', 6)]);
    expect(use(5, 0)).toEqual([cardKey(CHARS[0]!, 'use', 5)]);
    const item = voiceFor({ type: 'ITEM_USED', seat: 1, item: 7, target: { t: 'none' } }, q0, vm, ctx(1));
    expect(item.map((v) => v.key)).toEqual([itemKey(CHARS[1]!, 7)]);
  });

  it('卡片台词都标 timed（亮卡之后由 handler 说出）；orElse 落到的那句也随顶层标 timed', () => {
    const used = (card: number, target: SeatIndex) =>
      voiceFor({ type: 'CARD_USED', seat: 0, card: card as 1, target: { t: 'seat', seat: target } }, q0, vm, ctx(1));
    expect(used(2, 3).map((v) => v.timed)).toEqual([true, true]);
    // 卡 5 没有 self 台词 → orElse 落到 use，仍是 timed
    expect(used(5, 0).map((v) => [v.key, v.timed])).toEqual([[cardKey(CHARS[0]!, 'use', 5), true]]);
    // 其他事件的台词照旧在事件开始时说
    const item = voiceFor({ type: 'ITEM_USED', seat: 1, item: 7, target: { t: 'none' } }, q0, vm, ctx(1));
    expect(item.map((v) => v.timed)).toEqual([undefined]);
  });

  it('被动卡：持卡人说卡片台词，对方（事件的 other）接一句反应台词（mode 2 = target）；免罪等没有对方时只有一句', () => {
    const passive = (card: number, other: SeatIndex | null) =>
      voiceFor({ type: 'PASSIVE', seat: 1, card: card as 18, context: 'frame', other }, q0, vm, ctx(1)).map((v) => [
        v.key,
        v.speaker,
        v.timed,
      ]);
    // 复仇（exe fcn.004432ca：0x44334f 持卡人 → 0x443383 当前玩家）
    expect(passive(18, 0)).toEqual([
      [cardKey(CHARS[1]!, 'use', 18), 'seat:1', true],
      [cardKey(CHARS[0]!, 'target', 18), 'seat:0', true],
    ]);
    // 免费卡的地主 / 查税出卡者
    expect(passive(20, 2).map((x) => x[0])).toEqual([cardKey(CHARS[1]!, 'use', 20), cardKey(CHARS[2]!, 'target', 20)]);
    // 没有对方（免罪、企业消费、罚款）
    expect(passive(18, null).map((x) => x[0])).toEqual([cardKey(CHARS[1]!, 'use', 18)]);
    // 旧服务器发来的事件没有 other 字段：按没有对方处理
    const legacy = { type: 'PASSIVE', seat: 1, card: 18, context: 'frame' } as unknown as GameEvent;
    expect(voiceFor(legacy, q0, vm, ctx(1)).map((v) => v.key)).toEqual([cardKey(CHARS[1]!, 'use', 18)]);
  });

  it('踩地雷住院说反应台词，没有时改说住院槽；坐牢说槽 19', () => {
    const conf = (seat: SeatIndex, ref: string | null, where: 'jail' | 'hospital') =>
      voiceFor(
        {
          type: 'CONFINED',
          actor: { t: 'seat', seat },
          where,
          days: 3,
          total: 3,
          cause: { k: 'object', ref, by: null },
        },
        q0,
        vm,
        ctx(1),
      ).map((v) => v.key);
    expect(conf(0, 'mine', 'hospital')).toEqual([`voice.c${CHARS[0]}.react.mine`]);
    // 座位 1 的角色在测试表里没有地雷台词
    expect(CHARS[1]).toBe(4);
    expect(conf(1, 'mine', 'hospital')).toEqual(conf(1, 'mine', 'hospital'));
    const q = makeSoundQuery(
      viewWith((v) => {
        v.players[1]!.character = 1;
      }),
      map,
    );
    expect(
      voiceFor(
        {
          type: 'CONFINED',
          actor: { t: 'seat', seat: 1 },
          where: 'hospital',
          days: 3,
          total: 3,
          cause: { k: 'object', ref: 'mine', by: null },
        },
        q,
        vm,
        ctx(1),
      ).map((v) => v.key),
    ).toEqual([slotKey(1, 20)]);
    expect(conf(2, null, 'jail')).toEqual([slotKey(CHARS[2]!, 19)]);
  });

  it('NPC、点名、新闻：乐透得主、拍卖流标、魔法屋条件、新闻与命运', () => {
    const keys = (e: GameEvent) => voiceFor(e, q0, vm, ctx(1)).map((v) => v.key);
    expect(keys({ type: 'LOTTERY_DRAW', number: 5, winner: 3, prize: 100 })).toEqual([
      'voice.npc.lottery-draw-winnerIs',
      `voice.npc.lottery-winnerName-${CHARS[3]}`,
    ]);
    expect(keys({ type: 'AUCTION_ENDED', lot: 'L1', winner: null, price: 0 })).toEqual(['voice.npc.auction-noBid']);
    expect(keys({ type: 'MAGIC_CONDITION', caster: 0, cond: 7, targets: [] })).toEqual(['voice.npc.magic-cond-7']);
    expect(keys({ type: 'NEWS', id: 12, params: {}, affected: [] })).toEqual(['voice.news.12']);
    expect(keys({ type: 'FATE', seat: 0, id: 3, amount: null, blessing: null })).toEqual(['voice.fate.3']);
    expect(voiceFor({ type: 'NEWS', id: 12, params: {}, affected: [] }, q0, vm, ctx(1))[0]!.speaker).toBe('news');
  });

  it('allowGuess=false 时跳过 guess 台词；没有语音表时静默', () => {
    const e: GameEvent = { type: 'BOMB_ATTACHED', seat: 0, fuse: 3 };
    expect(voiceFor(e, q0, vm, ctx(1)).map((v) => v.confidence)).toEqual(['guess']);
    expect(voiceFor(e, q0, vm, ctx(1), { allowGuess: false })).toEqual([]);
    expect(voiceFor(e, q0, null, ctx(1))).toEqual([]);
  });
});

describe('真实自对弈事件', () => {
  it('全部事件都能解析声音、结果确定且只引用表里存在的键', () => {
    const sp = selfPlay({ seed: 11, steps: 400 });
    const mm = testMusicMap();
    const voiceKeys = new Set<string>();
    for (const c of vm.characters) {
      for (const g of [
        ...c.slots,
        ...c.itemLines,
        ...Object.values(c.itemReactions),
        ...c.cardLines.use,
        ...c.cardLines.self,
        ...c.cardLines.target,
      ]) {
        for (const l of g) voiceKeys.add(l.key);
      }
    }
    for (const g of [...Object.values(vm.npc), ...Object.values(vm.news)]) for (const l of g) voiceKeys.add(l.key);
    const sceneKeys = new Set(Object.values(mm.scenes).map((s) => s!.key));
    let view = sp.initial.view;
    let events = 0;
    let voices = 0;
    for (const b of sp.batches) {
      b.events.forEach((raw, i) => {
        const e = raw as GameEvent;
        const v = view;
        const q = makeSoundQuery(() => v, map);
        const c = { epoch: 1, seq: b.seq, eventIndex: i };
        const a = { sfx: sfxFor(e, q, sets, c), voice: voiceFor(e, q, vm, c), scene: sceneCueFor(e, q) };
        expect({ sfx: sfxFor(e, q, sets, c), voice: voiceFor(e, q, vm, c), scene: sceneCueFor(e, q) }).toEqual(a);
        for (const x of a.voice) expect(voiceKeys.has(x.key), `${e.type} → ${x.key}`).toBe(true);
        if (a.scene) expect(sceneKeys.has(mm.scenes[a.scene.scene]!.key)).toBe(true);
        events++;
        voices += a.voice.length;
      });
      view = b.view;
    }
    expect(events).toBeGreaterThan(200);
    expect(voices).toBeGreaterThan(0);
  });
});
