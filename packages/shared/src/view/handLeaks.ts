/**
 * 私密手牌模式的泄漏扫描（测试与开发自检用；规则同 project.ts）：下发给观察者 own（座位号；观战者为 null）的一份载荷里，
 * 别人手上卡片 / 道具种类的泄漏路径。空数组 = 没有泄漏。
 *
 * 深度扫描：载荷里每一个可能承载卡号、道具号或牌堆张数的键（HAND_KEYS）都必须出现在已知位置，并满足该位置的脱敏规则；
 * 出现在未知位置的一律报告（新增下发字段时迫使作者决定它是否可以下发）。yourDecision 子树只发给做决策的本人
 * （抢夺卡、生日的对手清单按原版只给出卡人），不在扫描范围内，调用方另行断言 yourDecision.seat === own。
 */
import { isGameEventType } from '../engine/types/events';
import type { GameEvent, SeatIndex } from '../engine/types/index';

/**
 * 可能承载手牌种类的键。hostility：抢夺卡让被抢人对出卡人的敌意加上被抢物的标价，别人的敌意值只能带「对本人」那一项
 * （project.ts hideHostility）
 */
export const HAND_KEYS = Object.freeze([
  'cards',
  'items',
  'card',
  'item',
  'shelf',
  'pools',
  'take',
  'hostility',
] as const);
const HAND_KEY_SET = new Set<string>(HAND_KEYS);

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);

/** 私密模式下卡号 / 道具号只给 seat 本人的 redactHand 事件字段 */
const OWNER_ONLY: Partial<Record<GameEvent['type'], readonly string[]>> = {
  CARD_GAINED: ['card'],
  CARD_LOST: ['card'],
  SHOP_TRADE: ['card', 'item'],
  CHAIRMAN_GIFT: ['card', 'item'],
  ITEM_GAINED: ['item'],
  ITEM_LOST: ['item'],
  SHOP_OPENED: ['shelf'],
};

/** 公开事件里本来就公开的卡号 / 道具号（出卡、用道具、被动卡亮卡、研究所成果） */
const PUBLIC_FIELDS: Partial<Record<GameEvent['type'], readonly string[]>> = {
  CARD_USED: ['card'],
  CARD_NO_EFFECT: ['card'],
  PASSIVE: ['card'],
  ITEM_USED: ['item'],
  RESEARCH_DONE: ['item'],
};

const isEmpty = (x: unknown): boolean => x === null || (Array.isArray(x) && x.length === 0);

/** 别人的敌意值：除了对本人（own）那一项，其余必须为 0（观战者全为 0） */
const hidesHostility = (x: unknown, own: SeatIndex | null): boolean =>
  Array.isArray(x) && x.every((h, j) => j === own || h === 0);

function isEvent(x: unknown): x is GameEvent & Obj {
  return isObj(x) && isGameEventType(x.type);
}

/**
 * 判定一处命中：ancestors 为从根到父对象的对象链（不含数组），keys 为对应的键链。
 * 返回 null 表示合法，否则返回原因。
 */
function judge(
  key: string,
  value: unknown,
  parent: Obj,
  ancestors: readonly Obj[],
  keys: readonly string[],
  own: SeatIndex | null,
): string | null {
  const gp = ancestors.at(-2);
  const parentKey = keys.at(-2);
  // 牌堆：GameView.pools 为 null；post 里不应出现
  if (key === 'pools') return value === null ? null : 'pools';
  // 敌意值：PlayerView（有 cardCount）与 post.players[].set 里，别人的只能带对本人的一项
  if (key === 'hostility') {
    const who =
      'cardCount' in parent && typeof parent.seat === 'number'
        ? parent.seat
        : parentKey === 'set'
          ? gp?.seat
          : undefined;
    if (typeof who !== 'number') return 'unknown location';
    return who === own || hidesHostility(value, own)
      ? null
      : `${parentKey === 'set' ? 'patch' : 'player'} ${who} hostility`;
  }
  // PlayerView：{ seat, cards, cardCount, items, itemCount, ... }
  if ((key === 'cards' || key === 'items') && 'cardCount' in parent && typeof parent.seat === 'number') {
    return parent.seat === own || value === null ? null : `player ${parent.seat} ${key}`;
  }
  // post.players[].set：{ seat, set: { cards?, items? } }
  if ((key === 'cards' || key === 'items') && parentKey === 'set' && gp && typeof gp.seat === 'number') {
    return gp.seat === own || value === null ? null : `patch ${gp.seat} ${key}`;
  }
  // 公布栏挂牌（公开）：listing.asset / noticeBoard[].asset
  if ((key === 'card' || key === 'item') && parentKey === 'asset') return null;
  // 事件载荷
  if (isEvent(parent)) {
    const e = parent;
    if (PUBLIC_FIELDS[e.type]?.includes(key)) return null;
    if (OWNER_ONLY[e.type]?.includes(key)) {
      const seat = (e as { seat: SeatIndex }).seat;
      return seat === own || isEmpty(value) ? null : `${e.type} seat ${seat} ${key}`;
    }
    return `${e.type}.${key}`;
  }
  // 抢夺卡：CARD_USED.target.take.item 只给出卡人与被抢人
  if (key === 'take' && parentKey === 'target' && gp && isEvent(gp) && gp.type === 'CARD_USED') {
    const t = gp.target;
    if (t.t !== 'rob') return 'CARD_USED.target.take';
    const take = t.take;
    if (take.k === 'card') return null;
    return take.item === null || own === gp.seat || own === t.seat ? null : `rob take item (${gp.seat} → ${t.seat})`;
  }
  if (key === 'item' && parentKey === 'take') return null; // 由上面的 take 判定
  return 'unknown location';
}

export function findHandLeaks(payload: unknown, own: SeatIndex | null): string[] {
  const out: string[] = [];
  const ancestors: Obj[] = [];
  const keys: string[] = [];
  const visit = (x: unknown, path: string): void => {
    if (Array.isArray(x)) {
      for (const [i, v] of x.entries()) visit(v, `${path}[${i}]`);
      return;
    }
    if (!isObj(x)) return;
    ancestors.push(x);
    for (const [k, v] of Object.entries(x)) {
      if (k === 'yourDecision') continue;
      keys.push(k);
      if (HAND_KEY_SET.has(k)) {
        const why = judge(k, v, x, ancestors, keys, own);
        if (why !== null) out.push(`${path}.${k}: ${why}`);
      }
      // pools / 别人的 cards、items 已经判定过；继续向下扫描其余结构（事件里的 target、post 等）
      if (k !== 'pools' && k !== 'cards' && k !== 'items' && k !== 'shelf') visit(v, `${path}.${k}`);
      keys.pop();
    }
    ancestors.pop();
  };
  visit(payload, '$');
  return out;
}
