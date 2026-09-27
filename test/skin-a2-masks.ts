// 调试脚本（A2）：统计 Panel 区域图 #8/#19/#22/#81 的取值分布
import { readFileSync } from 'node:fs';
import { MkfArchive } from '../tools/extract/src/mkf/container';
const a = MkfArchive.open(readFileSync('original/Game/Panel.mkf'), 'Panel');
for (const i of [8, 19, 22, 81]) {
  const d = a.read(i);
  const h = new Map<number, number>();
  for (const v of d) h.set(v, (h.get(v) ?? 0) + 1);
  const keys = [...h.keys()].sort((x, y) => x - y);
  console.log(i, d.length, `n=${keys.length}`, keys.join(','));
}
