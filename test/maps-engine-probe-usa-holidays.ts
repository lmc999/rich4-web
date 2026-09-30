// 调试（只读调研）：美国图 kind 2（第 n 个星期 w）节日在 1998–2001 的命中日期与星期（复刻 exe 0x4521f0 的 w < wd1 缺陷）
import { readFileSync } from 'node:fs';
import { holidayKey, holidayOn, weekdayOf } from '../packages/shared/src/engine/rules/calendar';

const def = JSON.parse(readFileSync('.cache/maps/engine-probe/maps/usa.map.json', 'utf8'));
const kind2 = def.holidays.filter((h: { kind: number }) => h.kind === 2);
console.log('kind2', kind2.map((h: { slot: number; month: number; day: number; weekday: number }) => `h${h.slot} ${h.month}月 第${h.day}个 w=${h.weekday}`).join('；'));
const W = '日一二三四五六';
for (let y = 1998; y <= 2001; y++) {
  const hits: string[] = [];
  for (const h of kind2) {
    let found = '';
    for (let d = 1; d <= 31; d++) {
      const date = y * 10000 + h.month * 100 + d;
      const hit = holidayOn(date, def.holidays);
      if (hit && holidayKey(hit) === holidayKey(h)) found = `${h.month}/${d}(${W[weekdayOf(date)]})`;
    }
    hits.push(`h${h.slot}:${found || '不命中'}`);
  }
  console.log(y, hits.join(' '));
}
