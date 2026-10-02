// 汇总 test/maps-t5-sim.sh 的输出（.cache/maps/t5/sim/<map>.<cfg>.run{1,2}.txt）：两次 finalHash 是否一致、
// 每局平均 action / 天数、小游戏与各行业事件次数。用法（仓库根）：node test/maps-t5-sim-summary.mjs
import { existsSync, readFileSync } from 'node:fs';

const DIR = '.cache/maps/t5/sim';
const MAPS = ['taiwan', 'china', 'japan', 'usa'];
const CFGS = ['original', 'random', 'basic3'];
const IND = { 1: '航空', 3: '电子', 4: '保险', 5: '汽车', 6: '石油', 7: '银行', 10: '百货', 11: '建设' };

function parse(file) {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const line = text.split('\n').find((l) => l.startsWith('finished='));
  const statsLine = text.split('\n').find((l) => l.startsWith('stats='));
  if (!line) return null;
  const kv = Object.fromEntries(
    [...line.matchAll(/(\w+)=(\{[^}]*\}|\S+)/g)].map((m) => [m[1], m[2]]),
  );
  return { kv, stats: statsLine ? JSON.parse(statsLine.slice(6)) : null };
}

const per = (n, g) => (n === undefined ? '0' : (n / g).toFixed(2));
for (const cfg of CFGS) {
  console.log(`\n## ${cfg}`);
  for (const m of MAPS) {
    const a = parse(`${DIR}/${m}.${cfg}.run1.txt`);
    const b = parse(`${DIR}/${m}.${cfg}.run2.txt`);
    if (!a) {
      console.log(`${m}: 未完成`);
      continue;
    }
    const g = Number(a.kv.games);
    const same = b ? (a.kv.finalHash === b.kv.finalHash && a.kv.journalHash === b.kv.journalHash ? '一致' : '不一致!') : '缺 run2';
    const st = a.stats;
    const ev = st?.events ?? {};
    const fee = Object.entries(st?.companyFee ?? {})
      .map(([k, n]) => `${IND[k] ?? k}${per(n, g)}`)
      .join(' ');
    const conf = Object.entries(st?.confined ?? {})
      .map(([k, n]) => `${k}:${per(n, g)}`)
      .join(' ');
    console.log(
      `${m}: finished=${a.kv.finished}/${g} rejects=${a.kv.rejects} inv=${a.kv.invariantErrors} err=${a.kv.errors} ` +
        `avgDays=${a.kv.avgDays} avgActions=${st?.avgActions} reasons=${a.kv.reasons} finalHash=${a.kv.finalHash} 两次=${same} ` +
        `s=${a.kv.seconds}/${b?.kv.seconds ?? '-'}`,
    );
    console.log(
      `   每局：MINIGAME_ENDED=${per(ev.MINIGAME_ENDED, g)} COMPANY_FEE=${per(ev.COMPANY_FEE, g)} [${fee}] ` +
        `CONSTRUCTION_PICK=${per(st?.decisions?.CONSTRUCTION_PICK, g)} CONFINED[${conf}]`,
    );
  }
}
