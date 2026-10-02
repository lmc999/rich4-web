// 只重新生成指定命名空间的 zh-TW 语言包（其余命名空间由别的工作流在改，不碰）。
// 用法：npx tsx test/privacy-zh-tw-partial.ts items.json hud.json
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateZhTw, LOCALES_DIR } from '../scripts/gen-zh-tw';

const want = process.argv.slice(2);
const files = generateZhTw();
for (const f of want) {
  const text = files.get(f);
  if (text === undefined) throw new Error(`没有 ${f}`);
  writeFileSync(join(LOCALES_DIR, 'zh-TW', f), text);
  console.log(`写入 zh-TW/${f}`);
}
