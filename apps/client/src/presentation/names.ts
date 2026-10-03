// 演出与日志用的名字（design/client.md §10.3：引擎与数据只给 id，文案键由 id 派生）。
// 纯函数：t 由调用方注入（i18next.t 或测试替身）；缺失的动态键退回可读的占位（卡片 #13）。
import type { MapIndex } from '@rich4/shared/data';
import {
  type ActorRef,
  CARD_KEYS,
  type CardId,
  CHARACTER_KEYS,
  type DateNum,
  GOD_KEYS,
  type GodKind,
  ITEM_KEYS,
  type ItemId,
  type LotId,
  type Party,
  type SeatIndex,
  type TileId,
  type VillainKind,
} from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { lotLabels, tileLabel } from './lotLabels';

export type LooseT = (key: string, params?: Record<string, unknown>) => string;

export interface NameKit {
  t: LooseT;
  seat(seat: SeatIndex | null): string;
  lot(lot: LotId): string;
  /** 地块的原名（地图文案本身，不加同名序号）：原版新闻标题 sprintf 的 %s 是地产 / 企业记录里的名字（例如新闻 6 0x4480f6） */
  lotName?(lot: LotId): string;
  tile(tile: TileId): string;
  card(id: CardId | null): string;
  /** null：私密手牌模式下别人的道具种类（「道具」） */
  item(id: ItemId | null): string;
  god(kind: GodKind): string;
  villain(kind: VillainKind): string;
  actor(a: ActorRef): string;
  party(p: Party): string;
  stock(idx: number): string;
  money(n: number): string;
  date(d: DateNum): string;
  /** 节日名（找不到文案时为「节日」） */
  holiday(key: string): string;
  /** 当前地图的原版地图号 gm（MapDef.globalMapId：台 0 / 中 1 / 日 2 / 美 3；fixture 与未载入为 null）。命运 33–36 按图选文案用 */
  globalMapId?(): number | null;
}

export const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const;

/** 48800 → "48,800"（负数带减号） */
export function formatMoney(n: number): string {
  const neg = n < 0;
  const s = String(Math.trunc(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? `-${s}` : s;
}

/** 12345 → "1.2万" */
export function formatMoneyShort(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const one = (x: number): string => {
    const v = Math.trunc(x * 10) / 10;
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  };
  if (a >= 1e8) return `${sign}${one(a / 1e8)}亿`;
  if (a >= 1e4) return `${sign}${one(a / 1e4)}万`;
  return formatMoney(n);
}

export function dateParts(d: DateNum): { y: number; m: number; d: number } {
  return { y: Math.trunc(d / 10000), m: Math.trunc(d / 100) % 100, d: d % 100 };
}

/** 19980312 → "1998年3月12日" */
export function formatDate(d: DateNum): string {
  const p = dateParts(d);
  return `${p.y}年${p.m}月${p.d}日`;
}

/** 节日名：键由地图拼出（events:holiday.<mapId>.<key>，key 形如 h<slot>）；没有文案时返回 null */
export function holidayName(t: LooseT, mapId: string | null, key: string): string | null {
  const name = mapId ? t(`events:holiday.${mapId}.${key}`, { defaultValue: '' }) : '';
  return name || null;
}

export function weekdayName(w: number): string {
  return `星期${WEEKDAYS[((w % 7) + 7) % 7]}`;
}

export interface NameDeps {
  t: LooseT;
  view(): GameView | null;
  map(): MapIndex | null;
  /** 当前界面语言（地图文案优先取它；缺省 zh-CN）。原版皮肤下为 zh-TW */
  lang?(): MapLang;
}

export type MapLang = 'zh-CN' | 'zh-TW';

/** 地图文案（MapDef.strings）：先取界面语言，缺失时回退另一种；都没有为 null */
export function pickMapString(
  strings: Partial<Record<MapLang, Readonly<Record<string, string>>>> | undefined,
  key: string,
  lang: MapLang = 'zh-CN',
): string | null {
  const other: MapLang = lang === 'zh-TW' ? 'zh-CN' : 'zh-TW';
  return strings?.[lang]?.[key] ?? strings?.[other]?.[key] ?? null;
}

/** 带缺省值的 t：键缺失时返回 fallback（i18next 的 defaultValue） */
function tf(t: LooseT, key: string, fallback: string, params?: Record<string, unknown>): string {
  return t(key, { ...params, defaultValue: fallback });
}

export function makeNames(d: NameDeps): NameKit {
  const mapString = (key: string): string | null => pickMapString(d.map()?.def.strings, key, d.lang?.());
  const seat = (s: SeatIndex | null): string => {
    if (s === null) return tf(d.t, 'events:names.nobody', '无人');
    const p = d.view()?.players.find((x) => x.seat === s);
    if (!p) return `${s + 1}P`;
    const key = CHARACTER_KEYS[p.character];
    return tf(d.t, `characters:${key}.name`, key);
  };
  const villain = (k: VillainKind): string => tf(d.t, `events:villain.${k}`, k);
  const lot = (id: LotId): string => {
    const m = d.map();
    if (!m) return id;
    return lotLabels(m, (k) => mapString(k) ?? k, d.lang?.() ?? 'zh-CN').get(id) ?? id;
  };
  const lotName = (id: LotId): string => {
    const def = d.map()?.def;
    const l = def?.lots.find((x) => x.id === id) ?? def?.companies.find((x) => x.id === id);
    return l ? (mapString(l.nameKey) ?? lot(id)) : lot(id);
  };
  const kit: NameKit = {
    t: d.t,
    seat,
    lot,
    lotName,
    tile: (id: TileId) => {
      const m = d.map();
      try {
        if (!m) return `#${id}`;
        const tile = m.tile(id);
        const name = tile.nameKey ? mapString(tile.nameKey) : null;
        if (name) return name;
        const label = tileLabel(
          m,
          id,
          mapString,
          (kind) => tf(d.t, `tiles:kind.${kind}`, kind),
          (lot) => tf(d.t, 'tiles:near', `${lot}旁`, { name: lot }),
          d.lang?.() ?? 'zh-CN',
        );
        return `${label} #${id}`;
      } catch {
        return `#${id}`;
      }
    },
    card: (id) =>
      id === null
        ? tf(d.t, 'events:names.hiddenCard', '1 张卡片')
        : tf(d.t, `cards:${CARD_KEYS[id]}.name`, `卡片#${id}`),
    item: (id) =>
      id === null ? tf(d.t, 'items:hidden.name', '道具') : tf(d.t, `items:${ITEM_KEYS[id]}.name`, `道具#${id}`),
    god: (k) => tf(d.t, `gods:${GOD_KEYS[k]}.name`, `神明#${k}`),
    villain,
    actor: (a) => (a.t === 'seat' ? seat(a.seat) : villain(a.kind)),
    party: (p) => {
      switch (p.t) {
        case 'seat':
          return seat(p.seat);
        case 'company':
          return lot(p.company);
        case 'pool':
          return tf(d.t, 'events:names.pool', '公库');
        case 'bank':
          return tf(d.t, 'events:names.bank', '银行');
      }
    },
    stock: (idx) => {
      const def = d.map()?.def.stocks.find((s) => s.index === idx);
      return (def ? mapString(def.nameKey) : null) ?? `#${idx + 1}`;
    },
    money: formatMoney,
    date: formatDate,
    holiday: (key) =>
      holidayName(d.t, d.view()?.dataRef.mapId ?? null, key) ?? tf(d.t, 'events:holiday.generic', '节日'),
    globalMapId: () => d.map()?.def.globalMapId ?? null,
  };
  return kit;
}
