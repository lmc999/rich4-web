// 事件 → 声音（design/client.md §7.3；design-draft §3.7；original-skin.md U1）：对 GameEvent['type'] 穷举（satisfies）。
// 每项可给出：
// - sfx：素材包 sfx-sets 的 `cue.<name>` 音效集（语义置信度为 exe / visual 时用原版音效），否则 ZzFX 预设
//   （置信度 guess 的原版音效默认也用 ZzFX，试听页可切换）；flicCovered 表示原版皮肤里由带同步音效的 FLIC 出声；
// - voice：角色事件槽（1050+27c+slot）、卡片 / 道具台词、NPC 与新闻播报的提示，变体与概率由 audio/selectors 确定性选择；
// - scene：事件期间的场景曲（监狱、医院、破产、乐透开奖、月结、拍卖、结算）。场所屏与小游戏的场景曲由 UI 状态决定
//   （audio/selectors.sceneLayersFor）。
// 事件槽的触发门槛与概率按 r_minigames_chars §2.4（第三方转述，语义置信度 visual / guess），金额门槛乘物价指数。
import { GOD, type GodKind, type SeatIndex } from '@rich4/shared/engine';
import {
  moneyVoice,
  pointsVoice,
  type SfxCue,
  type SoundMapTable,
  type SoundQuery,
  type SoundSpec,
  type VoiceCue,
} from '../audio/cues';
import type { ZzfxPresetId } from '../audio/procedural';

/** 旧名（M3 骨架）：程序化音效 id 即 ZzFX 预设名 */
export type SfxId = ZzfxPresetId;

const z = (zzfx: ZzfxPresetId, cue?: string): SfxCue => (cue === undefined ? { zzfx } : { cue, zzfx });
const flic = (zzfx: ZzfxPresetId, cue?: string): SfxCue => ({ ...z(zzfx, cue), flicCovered: true });

/** 衰神、穷神、死神（事件槽 22 / 23） */
const BAD_GODS: ReadonlySet<GodKind> = new Set<GodKind>([
  GOD.SMALL_POOR,
  GOD.BIG_POOR,
  GOD.SMALL_MISFORTUNE,
  GOD.BIG_MISFORTUNE,
  GOD.DEATH,
]);

const seatOf = (a: { t: 'seat'; seat: SeatIndex } | { t: 'villain' }): SeatIndex | null =>
  a.t === 'seat' ? a.seat : null;

/** 付给其他玩家（过路费、设施费）：被最敌视的对手拿走 ≥5000×PI 时 1/2 概率说「我记住你了」，否则按金额分档 */
function payVoice(q: SoundQuery, payer: SeatIndex, receiver: SeatIndex | null, amount: number): VoiceCue[] {
  const pay = moneyVoice('pay', payer, amount, q.priceIndex());
  if (receiver !== null && q.rivalOf(payer) === receiver && amount >= 5000 * q.priceIndex()) {
    const rival: VoiceCue = { k: 'slot', seat: payer, slot: 'robbedByRival', chance: 2 };
    return [pay[0] ? { ...rival, orElse: pay[0] } : rival];
  }
  return pay;
}

export const SOUND_MAP = {
  // ── turn
  GAME_STARTED: {
    sfx: z('fanfare'),
    // 开局宣言：逐人说完整句（原版阻塞）
    voice: (e) => e.seats.map((seat) => ({ k: 'slot', seat, slot: 'gameStart', policy: 'queue', maxWaitMs: 20_000 })),
  },
  TURN_STARTED: { sfx: z('ding') },
  PARACHUTE: { sfx: z('whoosh') },
  TURN_BLOCKED: { sfx: { cue: 'status.skipTurn' } },
  RELEASED: {},
  RETURNED: {},
  TURN_ENDED: {},
  // ── move
  DICE_ROLLED: { sfx: z('dice') },
  MOVE_SEGMENT: {
    sfx: (e, q) => {
      const seat = seatOf(e.actor);
      const v = seat === null ? 'walk' : (q.vehicleOf(seat) ?? 'walk');
      return z(
        'step',
        v === 'moto' ? 'move.moto' : v === 'car' ? 'move.car' : v === 'engineer' ? 'move.engineer' : 'move.walk',
      );
    },
  },
  ROADBLOCK_HIT: {
    sfx: z('stamp'),
    voice: (e) => {
      const seat = seatOf(e.actor);
      return seat === null ? [] : [{ k: 'reaction', seat, reaction: 'hitRoadblock' }];
    },
  },
  REVERSED: { sfx: z('whoosh') },
  LANDED: {},
  // ── money
  MONEY: {
    sfx: (e) => (e.from.t === 'seat' || e.to.t === 'seat' ? z('coin') : null),
    voice: (e, q) => {
      const pi = q.priceIndex();
      const amount = e.paid;
      switch (e.reason) {
        case 'fine':
        case 'tax':
        case 'taxAudit':
          return e.from.t === 'seat' ? moneyVoice('fine', e.from.seat, amount, pi) : [];
        case 'reward':
        case 'lotteryPrize':
        case 'insurance':
          return e.to.t === 'seat' ? moneyVoice('income', e.to.seat, amount, pi) : [];
        case 'villain':
          return e.from.t === 'seat' ? moneyVoice('loss', e.from.seat, amount, pi) : [];
        default:
          return [];
      }
    },
  },
  LOAN: { sfx: z('coin'), voice: () => [{ k: 'npc', key: 'bank.loanDone' }] },
  REPAY: { sfx: z('coin'), voice: () => [{ k: 'npc', key: 'bank.repayDone' }] },
  LOAN_REMINDER: {},
  LOAN_FORCED: { sfx: z('sad'), voice: (e, q) => moneyVoice('loss', e.seat, e.paid, q.priceIndex()) },
  ATM: { sfx: z('coin') },
  FINANCE: { sfx: z('coin') },
  RESERVE_SHORTFALL: {},
  INSURANCE_PAYOUT: { sfx: z('coin'), voice: (e, q) => moneyVoice('income', e.seat, e.amount, q.priceIndex()) },
  POINTS_GAINED: {
    sfx: flic('coin', 'gain.points'),
    voice: (e) => pointsVoice(e.seat, e.amount),
  },
  // ── property
  LAND_BOUGHT: {
    sfx: z('stamp', 'land.buy'),
    // 买地后同一街区独占 ≥3 块
    voice: (e, q) => (q.streetOwned(e.seat, e.lot) + 1 >= 3 ? [{ k: 'slot', seat: e.seat, slot: 'monopolyBuy' }] : []),
  },
  LOT_LEVEL: {
    sfx: (e) => (e.to > e.from ? z('hammer', 'land.build') : e.to < e.from ? z('boom') : null),
    voice: (e, q) => {
      if (e.to <= e.from) return [];
      const owner = e.cause.by ?? q.ownerOf(e.lot);
      if (owner === null) return [];
      if (e.to === 5) return [{ k: 'slot', seat: owner, slot: 'buildLevel5' }];
      // 在独占街区（同街 ≥3 块）加盖：1/3 概率
      if (q.streetOwned(owner, e.lot) >= 3) return [{ k: 'slot', seat: owner, slot: 'monopolyBuild', chance: 3 }];
      return [];
    },
  },
  FACILITY_BUILT: { sfx: z('hammer', 'land.build') },
  LOT_MUTATED: { sfx: z('boom') },
  TOLL_PAID: {
    sfx: z('coin', 'money.payFee'),
    voice: (e, q) => payVoice(q, e.payer, e.owner, e.amount),
  },
  TOLL_EXEMPT: {},
  FEE_PAID: {
    sfx: z('coin', 'money.payFee'),
    voice: (e, q) => payVoice(q, e.payer, q.ownerOf(e.lot), e.amount),
  },
  HOTEL_STAY: {},
  COMPANY_FEE: { sfx: z('coin', 'money.payFee'), voice: (e, q) => payVoice(q, e.seat, null, e.amount) },
  SUBSCRIBED: { sfx: z('coin', 'stock.trade') },
  INVEST_BLOCKED: {},
  CANNOT_AFFORD: {},
  MARK_SET: { sfx: z('stamp') },
  MARK_EXPIRED: {},
  TENURE_EXPIRED: {},
  RESEARCH_STARTED: {},
  RESEARCH_DONE: { sfx: z('ding', 'gain.item') },
  RESEARCH_CANCELLED: {},
  // ── card
  CARD_GAINED: { sfx: flic('card') },
  CARD_LOST: {},
  CARD_USED: {
    sfx: z('magic', 'card.use'),
    voice: (e) => {
      const t = e.target;
      const target =
        t.t === 'seat' || t.t === 'rob' ? t.seat : t.t === 'actor' && t.actor.t === 'seat' ? t.actor.seat : null;
      const use: VoiceCue = { k: 'card', seat: e.seat, card: e.card, mode: 'use' };
      if (target === e.seat) return [{ k: 'card', seat: e.seat, card: e.card, mode: 'self', orElse: use }];
      const out: VoiceCue[] = [use];
      if (target !== null) out.push({ k: 'card', seat: target, card: e.card, mode: 'target' });
      return out;
    },
  },
  CARD_NO_EFFECT: {},
  PASSIVE: {
    sfx: z('magic', 'card.use'),
    voice: (e) => [{ k: 'card', seat: e.seat, card: e.card, mode: 'use' }],
  },
  SHOP_OPENED: { voice: () => [{ k: 'npc', key: 'itemShop.welcome' }] },
  SHOP_TRADE: {
    sfx: (e) => (e.op === 'buyItem' || e.op === 'buyCard' ? z('coin', 'gain.item') : z('coin')),
  },
  CHAIRMAN_GIFT: { sfx: z('card') },
  // ── item
  ITEM_GAINED: { sfx: z('ding', 'gain.item') },
  ITEM_LOST: {},
  ITEM_USED: { sfx: z('magic'), voice: (e) => [{ k: 'item', seat: e.seat, item: e.item }] },
  VEHICLE: { sfx: z('ding') },
  VEHICLE_DESTROYED: { sfx: z('boom') },
  OBJECT_PLACED: {
    sfx: (e) => {
      switch (e.obj.kind) {
        case 'roadblock':
          return z('stamp', 'item.roadblock.place');
        case 'mine':
          return z('stamp', 'item.mine.place');
        case 'bomb':
          return z('stamp', 'item.timeBomb.place');
        default:
          return z('ding');
      }
    },
  },
  OBJECT_REMOVED: {
    sfx: (e) => (e.obj.kind === 'mine' && e.cause.k === 'object' ? flic('boom') : null),
  },
  DOLL_WALK: { sfx: z('step') },
  BOMB_ATTACHED: { sfx: z('stamp'), voice: (e) => [{ k: 'reaction', seat: e.seat, reaction: 'bombAttached' }] },
  BOMB_TRANSFERRED: { voice: (e) => [{ k: 'reaction', seat: e.to, reaction: 'bombAttached' }] },
  BOMB_EXPLODED: { sfx: flic('boom') },
  STRIKE: { sfx: flic('boom') },
  TELEPORTED: { sfx: z('magic') },
  TIME_REWOUND: { sfx: z('magic') },
  // ── god
  GOD_ATTACHED: {
    sfx: flic('magic'),
    voice: (e) => (BAD_GODS.has(e.kind) ? [{ k: 'slot', seat: e.seat, slot: 'badGodAttach' }] : []),
  },
  GOD_POWER: {
    sfx: z('coin'),
    voice: (e, q) => {
      const net = e.transfers.reduce((s, t) => (t.seat === e.seat ? s + t.amount : s), 0);
      if (net > 0) return moneyVoice('income', e.seat, net, q.priceIndex());
      if (net < 0) return moneyVoice('loss', e.seat, -net, q.priceIndex());
      return [];
    },
  },
  GOD_LEFT: {
    sfx: flic('whoosh'),
    voice: (e) =>
      e.seat !== null && BAD_GODS.has(e.kind) && e.reason !== 'bankrupt'
        ? [{ k: 'slot', seat: e.seat, slot: 'badGodLeave' }]
        : [],
  },
  GOD_SPAWNED: {},
  GOD_MANIFEST: { sfx: z('magic') },
  DOG_BITE: { sfx: z('siren') },
  DOG_KNOCKED: { sfx: z('boom') },
  DEATH_GOD_SUMMONED: { sfx: z('sad') },
  // ── status
  CONFINED: {
    sfx: (e) => (e.where === 'jail' || e.where === 'hospital' ? flic('siren') : null),
    voice: (e) => {
      const seat = seatOf(e.actor);
      if (seat === null) return [];
      if (e.where === 'jail') return [{ k: 'slot', seat, slot: 'jail' }];
      if (e.where !== 'hospital') return [];
      if (e.cause.k === 'object' && e.cause.ref === 'mine') {
        return [{ k: 'reaction', seat, reaction: 'hitMine', orElse: { k: 'slot', seat, slot: 'hospital' } }];
      }
      return [{ k: 'slot', seat, slot: 'hospital' }];
    },
    scene: (e) =>
      e.actor.t !== 'seat'
        ? null
        : e.where === 'jail'
          ? { scene: 'jail', span: 'event' }
          : e.where === 'hospital'
            ? { scene: 'hospital', span: 'event' }
            : null,
  },
  BLESSING: { sfx: z('magic') },
  STATUS_SET: {
    voice: (e) => {
      const seat = seatOf(e.actor);
      return seat !== null && e.value > 0 && (e.status === 'sleepwalk' || e.status === 'hibernate')
        ? [{ k: 'slot', seat, slot: 'sleepwalk' }]
        : [];
    },
  },
  ALLIANCE_FORMED: { sfx: z('ding') },
  ALLIANCE_BROKEN: {},
  ALLIANCE_EXPIRED: {},
  BANK_REJECTED: { sfx: z('sad') },
  // ── event
  NEWS: { sfx: z('news'), voice: (e) => [{ k: 'news', key: `news.${e.id}` }] },
  FATE: { sfx: z('card'), voice: (e) => [{ k: 'news', key: `fate.${e.id}` }] },
  MAGIC_CONDITION: { voice: (e) => [{ k: 'npc', key: `magic.condition.${e.cond}` }] },
  MAGIC_CAST: { sfx: z('magic', 'magic.cast'), voice: () => [{ k: 'npc', key: 'magic.chant' }] },
  LOTTERY_TICKET: { sfx: z('coin', 'lottery.bet') },
  LOTTERY_DRAW: {
    sfx: (e) => (e.number === null ? null : z('fanfare', 'lottery.draw')),
    voice: (e) => {
      if (e.number === null) return [];
      if (e.winner === null) return [{ k: 'npc', key: 'lottery.draw.noWinner', policy: 'queue' }];
      return [
        { k: 'npc', key: 'lottery.draw.winnerIs', policy: 'queue' },
        { k: 'name', base: 'lottery.winnerName', seat: e.winner, policy: 'queue' },
      ];
    },
    scene: (e) => (e.number === null ? null : { scene: 'lotteryDraw', span: 'event' }),
  },
  MINIGAME_STARTED: {},
  MINIGAME_ENDED: {
    sfx: z('coin', 'mg.result'),
    voice: (e) => {
      // 不玩：引擎给出台词槽（rand15()&1 → 槽 0 / 1）；玩了：按得点分档
      if (e.mode === 'skipped' && e.speechSlot !== null) {
        return [{ k: 'slot', seat: e.seat, slot: e.speechSlot === 0 ? 'pointsHigh' : 'pointsMid' }];
      }
      return pointsVoice(e.seat, e.score);
    },
  },
  BAIL: { sfx: z('coin'), voice: () => [{ k: 'npc', key: 'rescue.thanks' }] },
  VILLAIN_HIRED: {},
  VILLAIN_ACTION: {
    sfx: z('siren'),
    voice: (e, q) =>
      e.victim !== null && (e.what === 'robDeposit' || e.what === 'extort')
        ? moneyVoice('loss', e.victim, e.amount, q.priceIndex())
        : [],
  },
  VILLAIN_HOME: {},
  BEGGAR_ALMS: { sfx: z('coin', 'money.giveBeggar') },
  // ── stock
  STOCK_TRADED: { sfx: z('coin', 'stock.trade') },
  CHAIRMAN_CHANGED: { sfx: z('fanfare') },
  STOCK_FLAG: {},
  SUSPENDED: {},
  RESUMED: {},
  MARKET_TICK: {},
  MARKET_CLOSED: {},
  LISTING_ADDED: {},
  LISTING_REMOVED: {},
  LISTING_SOLD: { sfx: z('coin') },
  // ── auction
  AUCTION_STARTED: {
    sfx: z('ding'),
    voice: () => [{ k: 'npc', key: 'auction.open' }],
    scene: { scene: 'auction', span: { until: ['AUCTION_ENDED'] } },
  },
  AUCTION_BID: { sfx: z('click', 'auction.bid') },
  AUCTION_PASS: {},
  AUCTION_QUIT: {},
  AUCTION_ENDED: {
    sfx: (e) => (e.winner === null ? null : z('stamp', 'auction.sold')),
    voice: (e) =>
      e.winner === null
        ? [{ k: 'npc', key: 'auction.noBid' }]
        : [
            { k: 'npc', key: 'auction.sold', policy: 'queue' },
            { k: 'name', base: 'auction.winnerName', seat: e.winner, policy: 'queue' },
          ],
  },
  // ── day
  DAY_ADVANCED: {},
  PRICE_INDEX: {},
  HOLIDAY: { sfx: flic('fanfare') },
  DIVIDENDS: { sfx: z('coin', 'stock.dividend') },
  MONTHLY_REPORT: {
    sfx: z('fanfare', 'month.award'),
    voice: (e) => {
      const out: VoiceCue[] = [];
      if (e.champion !== null) {
        out.push({ k: 'npc', key: 'month.championIs', policy: 'queue', maxWaitMs: 8000 });
        out.push({ k: 'name', base: 'month.championName', seat: e.champion, policy: 'queue', maxWaitMs: 8000 });
      }
      if (e.tragic !== null) {
        out.push({ k: 'npc', key: 'month.loserIs', policy: 'queue', maxWaitMs: 8000 });
        out.push({ k: 'name', base: 'month.loserName', seat: e.tragic, policy: 'queue', maxWaitMs: 8000 });
      }
      return out;
    },
    scene: { scene: 'monthly', span: 'event' },
  },
  OBJECTS_RESPAWNED: {},
  DAY_END: {},
  // ── end
  BANKRUPT: {
    sfx: flic('sad'),
    voice: (e) => [{ k: 'slot', seat: e.seat, slot: 'bankrupt' }],
    scene: { scene: 'bankrupt', span: 'event' },
  },
  LIQUIDATION: {},
  BECAME_BEGGAR: { sfx: z('sad') },
  SURRENDERED: { sfx: z('sad') },
  GAME_OVER: {
    sfx: z('fanfare'),
    voice: (e) => (e.result.winner === null ? [] : [{ k: 'slot', seat: e.result.winner, slot: 'win' }]),
    scene: { scene: 'gameOver', span: { until: [] }, noResume: true },
  },
  // ── system
  CONTROLLER_CHANGED: {},
  AI_TRAITS_CHANGED: {},
  DEBUG_APPLIED: {},
  SYNC: {},
} as const satisfies SoundMapTable;

export function soundFor<T extends keyof typeof SOUND_MAP>(type: T): SoundSpec<T> {
  return SOUND_MAP[type] as SoundSpec<T>;
}
