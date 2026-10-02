// 调试：美国图 kind 2 节日在若干年份的落点（T4 calendar 用例取值用）
import { holidayOn, nthWeekdayDay, weekdayOf } from '../packages/shared/src/engine/rules/calendar';

const rows: [string, number, number, number][] = [
  ['1月第3个星期一', 1, 3, 1],
  ['2月第3个星期一', 2, 3, 1],
  ['5月第2个星期日', 5, 2, 0],
  ['5月第5个星期一', 5, 5, 1],
  ['9月第1个星期一', 9, 1, 1],
  ['11月第4个星期四', 11, 4, 4],
];
for (const y of [1998, 1999, 2000, 2001, 2002, 2003]) {
  const out: string[] = [];
  for (const [name, m, n, w] of rows) {
    const wd1 = weekdayOf(y * 10000 + m * 100 + 1);
    const d = nthWeekdayDay(wd1, w, n);
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    out.push(`${name}: wd1=${wd1} d=${d}${d > dim ? '(不命中)' : ` 星期${weekdayOf(y * 10000 + m * 100 + d)}`}`);
  }
  console.log(y, out.join(' | '));
}
void holidayOn;
