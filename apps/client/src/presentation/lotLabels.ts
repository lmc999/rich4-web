// 地块显示名：原版地块名就是路段名，一条街上多块同名，按地图里的出现顺序编号（「宜兰市 1」「宜兰市 2」…）。
// 事件日志（presentation/names）与对话框 / 面板（ui/components/names）共用，保证两处叫法一致。
import type { MapIndex } from '@rich4/shared/data';

const cache = new WeakMap<MapIndex, Map<string, string>>();

export function lotLabels(map: MapIndex, mapString: (k: string) => string): Map<string, string> {
  const hit = cache.get(map);
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
  cache.set(map, out);
  return out;
}
