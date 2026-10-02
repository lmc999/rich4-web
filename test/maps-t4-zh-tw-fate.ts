// 调试（T4）：只重新生成 zh-TW/fate.json（与 npm run i18n:zh-tw 同一个生成器），不动其他命名空间——
// 并行开发时别的轨道正在改 lobby / events 等文件。用法：npx tsx test/maps-t4-zh-tw-fate.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateZhTw, LOCALES_DIR } from '../scripts/gen-zh-tw';

const only = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['fate.json'];
const files = generateZhTw();
for (const f of only) {
  const text = files.get(f);
  if (text === undefined) throw new Error(`zh-CN 没有 ${f}`);
  writeFileSync(join(LOCALES_DIR, 'zh-TW', f), text);
  console.log(`wrote zh-TW/${f}`);
}
