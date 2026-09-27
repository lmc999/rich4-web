// 地块显示名：原版地块名就是路段名，一条街上多块同名，按地图里的出现顺序编号（「宜兰市 1」「宜兰市 2」…）。
// 事件日志（presentation/names）与对话框 / 面板（ui/components/names）共用，保证两处叫法一致。
import type { MapIndex } from '@rich4/shared/data';

const cache = new WeakMap<MapIndex, Map<string, Map<string, string>>>();

/**
 * 地块 id → 显示名。variant 区分同一张地图的不同文案来源（界面语言 zh-CN / zh-TW：原版皮肤切繁体后编号表要重算），
 * 同一 variant 必须对应同一个 mapString。
 */
export function lotLabels(map: MapIndex, mapString: (k: string) => string, variant = ''): Map<string, string> {
  let byVariant = cache.get(map);
  if (!byVariant) {
    byVariant = new Map();
    cache.set(map, byVariant);
  }
  const hit = byVariant.get(variant);
  if (hit) return hit;
  const byName = new Map<string, string[]>();
  for (const l of [...map.def.lots, ...map.def.companies]) {
    const name = mapString(l.nameKey);
    const list = byName.get(name) ?? [];
    list.push(l.id);
    byName.set(name, list);
  }
  const out = new Map<string, string>();
  for (const [name, ids] of byName) {
    ids.forEach((id, i) => {
      out.set(id, ids.length > 1 ? `${name} ${i + 1}` : name);
    });
  }
  byVariant.set(variant, out);
  return out;
}

const frontCache = new WeakMap<MapIndex, Map<number, string>>();

/** 路面格 → 以它为前沿格的第一块地（地产、设施、企业；没有则不在表里）。给没有名字的道路格起名用 */
export function frontLotOfTile(map: MapIndex): Map<number, string> {
  const hit = frontCache.get(map);
  if (hit) return hit;
  const out = new Map<number, string>();
  for (const l of [...map.def.lots, ...map.def.companies]) {
    let front: readonly number[] = [];
    try {
      front = map.lot(l.id).frontTiles;
    } catch {
      front = [];
    }
    for (const t of front) if (!out.has(t)) out.set(t, l.id);
  }
  frontCache.set(map, out);
  return out;
}

/**
 * 道路格的显示名：有地图文案用文案；普通道路格用旁边地块的名字（「台东县 1 旁」），都没有时用格子种类名。
 * 调用方自行附加「#id」。
 */
export function tileLabel(
  map: MapIndex,
  id: number,
  mapString: (k: string) => string | null,
  kindName: (kind: string) => string,
  near: (lot: string) => string,
  variant = '',
): string {
  const tile = map.tile(id);
  const named = tile.nameKey ? mapString(tile.nameKey) : null;
  if (named) return named;
  if (tile.kind === 'plain') {
    const lot = frontLotOfTile(map).get(id);
    if (lot) return near(lotLabels(map, (k) => mapString(k) ?? k, variant).get(lot) ?? lot);
  }
  return kindName(tile.kind);
}
