// 调试（获释位置改动）：比较刷新前后的四张图 golden 摘要（只读）
// 刷新前的快照先存到 .cache/jail/impl/golden-before-<图>.json（git show HEAD:packages/shared/src/engine/golden/__golden__/<图>.json）
// 用法：node test/jail-golden-diff.mjs
import { readFileSync } from 'node:fs';

const KEYS = ['CONFINED', 'RELEASED', 'RETURNED', 'BAIL', 'MINIGAME_ENDED', 'POINTS_GAINED', 'TURN_BLOCKED', 'BANKRUPT'];
for (const m of ['taiwan', 'china', 'japan', 'usa']) {
  const a = JSON.parse(readFileSync(`.cache/jail/impl/golden-before-${m}.json`, 'utf8'));
  const b = JSON.parse(readFileSync(`packages/shared/src/engine/golden/__golden__/${m}.json`, 'utf8'));
  console.log(`## ${m}  engine ${a.engineVersion} → ${b.engineVersion}  mapHash same: ${a.mapHash === b.mapHash}`);
  const tot = { ev: [0, 0], div: [] };
  for (let i = 0; i < a.games.length; i++) {
    const x = a.games[i];
    const y = b.games[i];
    let firstDiff = x.head.findIndex((t, k) => y.head[k] !== t);
    const cpDiff = x.checkpoints.findIndex((c, k) => y.checkpoints[k] !== c);
    const parts = KEYS.map((k) => `${k} ${x.types[k] ?? 0}→${y.types[k] ?? 0}`);
    console.log(
      `- ${x.name}: events ${x.events}→${y.events}, actions ${x.actions}→${y.actions}, days ${x.days}→${y.days}, reason ${x.reason}→${y.reason}, rejects ${y.rejects}, head差异@${firstDiff}, 首个不同检查点 #${cpDiff}, final ${x.final === y.final ? '同' : '变'}`,
    );
    console.log(`    ${parts.join(', ')}`);
  }
}
