// 调试脚本（T3 选图与飞行动画）：只重新生成 T3 负责的命名空间的 zh-TW 语言包（lobby / classicScreens / events / ui），
// 不碰其他轨道的文件（例如 T4 的 fate.json）。生成逻辑与 scripts/gen-zh-tw.ts 相同（它的 generateZhTw）。
// 用法：npx tsx test/maps-t3-zhtw.ts [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateZhTw, LOCALES_DIR } from '../scripts/gen-zh-tw';

const MINE = ['lobby.json', 'classicScreens.json', 'events.json', 'ui.json'];
const check = process.argv.includes('--check');
const files = generateZhTw();
let stale = 0;
for (const f of MINE) {
  const text = files.get(f);
  if (text === undefined) throw new Error(`没有 ${f}`);
  const dst = join(LOCALES_DIR, 'zh-TW', f);
  const cur = readFileSync(dst, 'utf8');
  if (cur === text) continue;
  stale++;
  if (check) console.log(`需要重新生成：${f}`);
  else {
    writeFileSync(dst, text);
    console.log(`已写入 ${f}`);
  }
}
if (stale === 0) console.log('T3 命名空间的 zh-TW 都是最新的');
process.exit(check && stale > 0 ? 1 : 0);
