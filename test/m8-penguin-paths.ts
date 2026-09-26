// 企鹅 DDA 路径探查（供 geometry 测试钉住）
import { penguin } from '../packages/shared/src/minigames/index';

const pairs: [number, number][] = [
  [56, 13],
  [38, 42],
  [20, 60],
  [39, 41],
  [56, 24],
  [3, 77],
  [27, 35],
  [56, 8],
  [76, 4],
  [44, 36],
  [49, 31],
  [12, 68],
];
for (const [a, b] of pairs) {
  const r = penguin.tracePath(a, b);
  console.log(
    `${a}(${penguin.rowOf(a)},${penguin.colOf(a)}) -> ${b}(${penguin.rowOf(b)},${penguin.colOf(b)}) valid=${penguin.isValidCell(a)},${penguin.isValidCell(b)}`,
    JSON.stringify(r),
    r.path.map((c) => `(${penguin.rowOf(c)},${penguin.colOf(c)})`).join(' '),
  );
}
