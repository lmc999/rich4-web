// 调试：把生产构建（apps/client/dist）里的压缩堆栈映射回源码位置。用法：node test/integ-map-stack.mjs '<stack text>'
import { readFileSync } from 'node:fs';
import { SourceMapConsumer } from 'source-map-js';

const text = process.argv[2] ?? readFileSync(0, 'utf8');
const cache = new Map();
for (const m of text.matchAll(/assets\/([\w.-]+\.js):(\d+):(\d+)/g)) {
  const [, file, line, col] = m;
  let c = cache.get(file);
  if (!c) {
    c = new SourceMapConsumer(JSON.parse(readFileSync(`apps/client/dist/assets/${file}.map`, 'utf8')));
    cache.set(file, c);
  }
  const p = c.originalPositionFor({ line: Number(line), column: Number(col) });
  console.log(`${file}:${line}:${col} -> ${p.source}:${p.line}:${p.column} ${p.name ?? ''}`);
}
