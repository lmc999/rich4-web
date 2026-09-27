// 调试：列出 twp（带台湾惯用词）与 tw（只换字形）结果不同的文案，人工审查词汇替换是否合适
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Converter } from 'opencc-js/cn2t';
import { leafEntries } from '../apps/client/src/i18n/zhTw';
const tw = Converter({ from: 'cn', to: 'tw' });
const twp = Converter({ from: 'cn', to: 'twp' });
const dir = 'apps/client/src/i18n/locales/zh-CN';
const seen = new Map<string, string>();
for (const f of readdirSync(dir)) {
  const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  for (const [k, v] of leafEntries(j)) {
    const a = tw(v as string), b = twp(v as string);
    if (a !== b) {
      // 找出差异片段
      let i = 0; while (i < a.length && a[i] === b[i]) i++;
      let ja = a.length, jb = b.length; while (ja > i && jb > i && a[ja-1] === b[jb-1]) { ja--; jb--; }
      const key = `${a.slice(i, ja)} → ${b.slice(i, jb)}`;
      if (!seen.has(key)) seen.set(key, `${f}:${k}  ${b}`);
    }
  }
}
for (const [k, v] of seen) console.log(k.padEnd(16), '|', v.slice(0, 110));
