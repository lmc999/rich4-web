// 事件声音规则的类型与查询助手（presentation/soundMap.ts 按 GameEventType 穷举使用）。
// 规则只产出「提示」（音效集名 / ZzFX 预设、语音槽 / 卡片台词 / NPC 键、场景曲），不直接引用原版编号；
// 由 audio/selectors.ts 结合素材包的映射表解析成逻辑键，并按 {epoch, seq, 事件下标} 确定性地选择变体与概率。
import type { MusicScene, VoiceCardMode, VoiceItemReaction, VoiceSlot } from '@rich4/shared/assets';
import type { MapIndex } from '@rich4/shared/data';
import type {
  CardId,
  CharacterId,
  GameEventOf,
  GameEventType,
  ItemId,
  LotId,
  SeatIndex,
  Vehicle,
} from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import type { ZzfxPresetId } from './procedural';
import type { VoicePolicy } from './voice';

/** 事件音效：素材包 sfx-sets 的 `cue.<name>` 音效集（语义置信度够时优先），否则 ZzFX 预设 */
export interface SfxCue {
  cue?: string;
  zzfx?: ZzfxPresetId;
  bus?: 'sfx' | 'ui';
  /** 原版皮肤里这一演出有带同步音效的 FLIC（由 FLIC 播放器出声），导演层不再另放音效 */
  flicCovered?: boolean;
  /**
   * 由 handler 在演出的指定时刻经 ctx.audio.cue 放出（可放多次），导演层在事件开始时不放：掷骰的两声「咚」
   * （FLC 第 30 帧与播完时，exe 0x44fb9d / 0x418dc8）
   */
  timed?: boolean;
}

interface VoiceCueBase {
  policy?: VoicePolicy;
  maxWaitMs?: number;
  /** 本条落空（概率未命中，或素材包里没有候选台词）时改用这一条 */
  orElse?: VoiceCue;
  /**
   * 由 handler 在演出的指定时刻经 ctx.audio.voices(事件) 说出，导演层在事件开始时只选好台词、不开口（orElse 随本条）：
   * 出卡与被动卡的卡片台词在亮卡之后才说（原版亮卡函数 fcn.00440bac 停 1.5 秒返回后才调 fcn.0044d870 说台词）。
   * 演出被中止、handler 没有调用时作废
   */
  timed?: boolean;
}

/** 按角色点名的 NPC 台词（键 = `${base}.${角色号}`） */
export type NameCallBase = 'lottery.winnerName' | 'month.championName' | 'month.loserName' | 'auction.winnerName';

export type VoiceCue =
  | (VoiceCueBase & {
      k: 'slot';
      seat: SeatIndex;
      slot: VoiceSlot;
      /** 在 [slot, ...alt] 中确定性地选一个（原版「二选一」） */
      alt?: readonly VoiceSlot[];
      /** 1/chance 的概率触发（原版 1/2、1/3） */
      chance?: number;
    })
  | (VoiceCueBase & { k: 'card'; seat: SeatIndex; card: CardId; mode: VoiceCardMode })
  | (VoiceCueBase & { k: 'item'; seat: SeatIndex; item: ItemId })
  | (VoiceCueBase & { k: 'reaction'; seat: SeatIndex; reaction: VoiceItemReaction })
  | (VoiceCueBase & { k: 'npc'; key: string })
  | (VoiceCueBase & { k: 'name'; base: NameCallBase; seat: SeatIndex })
  | (VoiceCueBase & { k: 'news'; key: string });

/**
 * 事件期间的场景曲：span 'event' = 只在该事件的演出期间；{ until } = 直到其中任一事件开始演出（或演出被重置）。
 * 空 until 表示一直保持到导演层 reset（终局结算）。
 */
export interface SceneCue {
  scene: MusicScene;
  span: 'event' | { until: readonly GameEventType[] };
  noResume?: boolean;
}

/** 规则可读的上下文（事件提交之前的显示态） */
export interface SoundQuery {
  view(): GameView;
  readonly map: MapIndex | null;
  character(seat: SeatIndex): CharacterId | null;
  priceIndex(): number;
  vehicleOf(seat: SeatIndex): Vehicle | null;
  /** seat 最敌视的对手（hostility 最大且 > 0，并列取座位小者）；没有则 null */
  rivalOf(seat: SeatIndex): SeatIndex | null;
  ownerOf(lot: LotId): SeatIndex | null;
  /** seat 在 lot 所在街区拥有的住宅地块数（事件之前；lot 本身按事件前的归属计） */
  streetOwned(seat: SeatIndex, lot: LotId): number;
}

type Rule<T extends GameEventType, R> = R | ((e: GameEventOf<T>, q: SoundQuery) => R);

export interface SoundSpec<T extends GameEventType> {
  sfx?: Rule<T, SfxCue | null>;
  voice?: (e: GameEventOf<T>, q: SoundQuery) => readonly VoiceCue[];
  scene?: Rule<T, SceneCue | null>;
}

export type SoundMapTable = { readonly [T in GameEventType]: SoundSpec<T> };

// ───────────────────────── 分档（design-draft §3.7；r_minigames_chars §2.4） ─────────────────────────

/** 金额分档：0 高（≥9000×PI）· 1 中（≥5000×PI）· 2 低（≥2000×PI）；不足 2000×PI 不说话 */
export function moneyTier(amount: number, pi: number): 0 | 1 | 2 | null {
  const p = pi > 0 ? pi : 1;
  if (amount >= 9000 * p) return 0;
  if (amount >= 5000 * p) return 1;
  if (amount >= 2000 * p) return 2;
  return null;
}

/** 点券分档：>100 高 · 51–100 中 · 1–50 低（「得 50 点」在高、中二选一，由规则处理） */
export function pointsTier(points: number): 0 | 1 | 2 | null {
  if (points > 100) return 0;
  if (points > 50) return 1;
  if (points > 0) return 2;
  return null;
}

const TIERED = {
  points: ['pointsHigh', 'pointsMid', 'pointsLow'],
  loss: ['spendSmall0', 'spendSmall1', 'spendSmall2'],
  income: ['incomeHigh', 'incomeMid', 'incomeLow'],
  pay: ['payHigh', 'payMid', 'payLow'],
  fine: ['fine0', 'fine1', 'fine2'],
} as const satisfies Record<string, readonly [VoiceSlot, VoiceSlot, VoiceSlot]>;

export type TierKind = keyof typeof TIERED;

export function tierSlot(kind: TierKind, tier: 0 | 1 | 2): VoiceSlot {
  return TIERED[kind][tier];
}

/** 金额类语音（不足门槛时返回空数组） */
export function moneyVoice(kind: Exclude<TierKind, 'points'>, seat: SeatIndex, amount: number, pi: number): VoiceCue[] {
  const t = moneyTier(amount, pi);
  return t === null ? [] : [{ k: 'slot', seat, slot: tierSlot(kind, t) }];
}

/** 点券类语音：恰好 50 点在高、中两档间二选一（原版「得 50 点」格与小游戏自动结算） */
export function pointsVoice(seat: SeatIndex, points: number): VoiceCue[] {
  if (points === 50) return [{ k: 'slot', seat, slot: 'pointsHigh', alt: ['pointsMid'] }];
  const t = pointsTier(points);
  return t === null ? [] : [{ k: 'slot', seat, slot: tierSlot('points', t) }];
}

// ───────────────────────── 查询实现 ─────────────────────────

export function makeSoundQuery(view: () => GameView, map: MapIndex | null): SoundQuery {
  const player = (seat: SeatIndex) => view().players.find((p) => p.seat === seat) ?? null;
  const q: SoundQuery = {
    view,
    map,
    character: (seat) => player(seat)?.character ?? null,
    priceIndex: () => view().econ.priceIndex,
    vehicleOf: (seat) => player(seat)?.vehicle ?? null,
    rivalOf(seat) {
      const p = player(seat);
      if (!p) return null;
      let best: SeatIndex | null = null;
      let max = 0;
      p.hostility.forEach((h, j) => {
        if (j !== seat && h > max) {
          max = h;
          best = j as SeatIndex;
        }
      });
      return best;
    },
    ownerOf(lot) {
      const v = view();
      const land = v.lands.find((l) => l.id === lot);
      if (land) return land.owner;
      const fac = v.facilities.find((f) => f.id === lot);
      return fac ? fac.owner : null;
    },
    streetOwned(seat, lot) {
      if (!map) return 0;
      let street: string;
      try {
        const def = map.lot(lot);
        if (def.kind !== 'land') return 0;
        street = def.streetId;
      } catch {
        return 0;
      }
      const v = view();
      let n = 0;
      for (const id of map.streetLots(street)) {
        if (v.lands.find((l) => l.id === id)?.owner === seat) n++;
      }
      return n;
    },
  };
  return q;
}
