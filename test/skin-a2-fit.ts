// 调试脚本（A2）：比较投影拟合误差的两种口径（欧氏 / 分轴最大）与调研 projection-fit 的 maxErrPx
import { readFileSync } from 'node:fs';
import { fitViewAffines } from '../tools/extract/src/assets/skin';
const t = JSON.parse(readFileSync('.cache/extract/tables.v206.json', 'utf8')).view;
const fits = fitViewAffines(t);
for (const f of fits) {
  let e2 = 0;
  let ea = 0;
  t.cellScreen.data[f.view].forEach(([sy, sx]: [number, number], i: number) => {
    const dy = Math.trunc(i / 29) - 14;
    const dx = (i % 29) - 14;
    const ex = f.sx[0] * dx + f.sx[1] * dy + f.sx[2] - sx;
    const ey = f.sy[0] * dx + f.sy[1] * dy + f.sy[2] - sy;
    e2 = Math.max(e2, Math.hypot(ex, ey));
    ea = Math.max(ea, Math.abs(ex), Math.abs(ey));
  });
  console.log(f.view, e2.toFixed(3), ea.toFixed(3));
}
