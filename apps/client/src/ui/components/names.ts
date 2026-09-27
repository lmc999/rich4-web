// id → 中文名（design/client.md §10.3：引擎与数据只给 id，文案键由 id 派生）。
// 卡片 cards:<key>.name、道具 items:<key>.name、神明 gods:<key>.name、角色 characters:<key>.name 的 key 取自 data/tables/ids；
// 地块、股票、格子的名字来自 MapDef.strings（按界面语言：程序化皮肤 zh-CN，原版皮肤 zh-TW；缺失时回退另一种）。
import type { MapIndex, TileKind } from '@rich4/shared/data';
import {
  type ActorRef,
  CARD_KEYS,
  type CardId,
  CHARACTER_KEYS,
  type CharacterId,
  type FacilityType,
  GOD_KEYS,
  type GodKind,
  ITEM_KEYS,
  type ItemId,
  type LotId,
  type MagicConditionId,
  type MagicEffectId,
  type MinigameId,
  type ReasonKey,
  type SeatIndex,
  type TileId,
  type Vehicle,
  type VillainKind,
} from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { uiLanguage } from '../../i18n';
import { lotLabels, tileLabel } from '../../presentation/lotLabels';
import { pickMapString } from '../../presentation/names';

/** 动态键的 t（键由 id 拼出，编译期无法逐个校验；由 names.dom.test 遍历全部 id 断言存在） */
export type LooseT = (key: string, opts?: Record<string, unknown>) => string;

export interface GameText {
  t: LooseT;
  character(id: CharacterId): string;
  /** 座位上的角色名；座位不存在时为「nP」 */
  player(seat: SeatIndex): string;
  card(id: CardId): string;
  cardDesc(id: CardId): string;
  item(id: ItemId): string;
  itemDesc(id: ItemId): string;
  god(kind: GodKind): string;
  villain(kind: VillainKind): string;
  actor(a: ActorRef): string;
  facility(type: FacilityType): string;
  vehicle(v: Vehicle): string;
  /** 地块名（同名地块追加序号，如「测试大道 2」）；企业用企业名 */
  lot(id: LotId): string;
  stock(idx: number): string;
  tileKind(kind: TileKind): string;
  /** 「银行 #1」；有 nameKey 的格用地图文案 */
  tile(id: TileId): string;
  reason(key: ReasonKey | null | undefined): string;
  magicCondition(id: MagicConditionId): string;
  magicEffect(id: MagicEffectId): string;
  magicEffectDesc(id: MagicEffectId): string;
  minigame(id: MinigameId): string;
  minigameHowTo(id: MinigameId): string;
  /** 地图文案（当前界面语言，缺失时回退另一种，再回退键本身） */
  mapString(key: string): string;
}

export function makeGameText(t: LooseT, view: GameView | null, map: MapIndex | null): GameText {
  const mapString = (key: string): string => pickMapString(map?.def.strings, key, uiLanguage()) ?? key;
  const character = (id: CharacterId): string => t(`characters:${CHARACTER_KEYS[id]}.name`);
  const player = (seat: SeatIndex): string => {
    const p = view?.players.find((x) => x.seat === seat);
    return p ? character(p.character) : `${seat + 1}P`;
  };
  const villain = (kind: VillainKind): string => t(`events:villain.${kind}`);
  const text: GameText = {
    t,
    character,
    player,
    card: (id) => t(`cards:${CARD_KEYS[id]}.name`),
    cardDesc: (id) => t(`cards:${CARD_KEYS[id]}.desc`),
    item: (id) => t(`items:${ITEM_KEYS[id]}.name`),
    itemDesc: (id) => t(`items:${ITEM_KEYS[id]}.desc`),
    god: (kind) => t(`gods:${GOD_KEYS[kind]}.name`),
    villain,
    actor: (a) => (a.t === 'seat' ? player(a.seat) : villain(a.kind)),
    facility: (type) => t(`tiles:facility.${type}`),
    vehicle: (v) => t(`game:vehicle.${v}`),
    lot: (id) => {
      if (!map) return id;
      return lotLabels(map, mapString, uiLanguage()).get(id) ?? id;
    },
    stock: (idx) => {
      const def = map?.def.stocks.find((s) => s.index === idx);
      return def ? mapString(def.nameKey) : t('game:stockFallback', { n: idx + 1 });
    },
    tileKind: (kind) => t(`tiles:kind.${kind}`),
    tile: (id) => {
      try {
        if (!map) return `#${id}`;
        const name = tileLabel(
          map,
          id,
          (k) => mapString(k),
          (kind) => t(`tiles:kind.${kind}`),
          (lot) => t('tiles:near', { name: lot }),
          uiLanguage(),
        );
        return `${name} #${id}`;
      } catch {
        return `#${id}`;
      }
    },
    reason: (key) => (key ? t(`game:reason.${key}`) : ''),
    magicCondition: (id) => t(`magic:condition.${id}`),
    magicEffect: (id) => t(`magic:effect.${id}.name`),
    magicEffectDesc: (id) => t(`magic:effect.${id}.desc`),
    minigame: (id) => t(`minigames:${id}.name`),
    minigameHowTo: (id) => t(`minigames:${id}.howTo`),
    mapString,
  };
  return text;
}

/** React 钩子：随语言、视图与地图变化重新生成 */
export function useGameText(view: GameView | null, map: MapIndex | null): GameText {
  const { t, i18n } = useTranslation();
  const loose = t as unknown as LooseT;
  const players = view?.players;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只依赖玩家列表与语言，view 其余字段变化不影响名字
  return useMemo(() => makeGameText(loose, view, map), [loose, players, map, i18n.language]);
}
