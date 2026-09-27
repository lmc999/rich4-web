// 临时调试：比较 v2.06(Game) 与 v3.11(MultiverseJourney) 同名 MKF 的逐资源哈希，给出编号映射
import crypto from 'node:crypto';
import { openMkf } from './ui-lib.mjs';
const SH = '/private/tmp/claude-501/-Users-dev-projects-rich4/1d740021-7a97-408c-8f18-14a87c324a4a/scratchpad/rich4-share';
for (const nm of process.argv.slice(2)) {
  const a = openMkf(`./original/Game/${nm}.mkf`);
  const b = openMkf(`${SH}/MultiverseJourney/${nm}.mkf`);
  const h = (m, i) => { const e = m.entries[i]; return crypto.createHash('sha1').update(m.buf.subarray(e.offset, e.offset + 16 + e.stored)).digest('hex').slice(0, 12); };
  const hb = new Map(); for (let i = 0; i < b.count; i++) { const k = h(b, i); if (!hb.has(k)) hb.set(k, []); hb.get(k).push(i); }
  const same = [], moved = [], changed = [];
  for (let i = 0; i < a.count; i++) {
    const k = h(a, i); const js = hb.get(k);
    if (js && js.includes(i)) same.push(i); else if (js) moved.push(`${i}->${js.join('/')}`); else changed.push(i);
  }
  const used = new Set(); for (let i = 0; i < a.count; i++) { const js = hb.get(h(a, i)); if (js) js.forEach(j => used.add(j)); }
  const onlyB = []; for (let j = 0; j < b.count; j++) if (!used.has(j)) onlyB.push(j);
  const rng = (arr) => { const out = []; let s = null, p = null; for (const x of arr) { if (s === null) { s = p = x; } else if (x === p + 1) p = x; else { out.push(s === p ? `${s}` : `${s}-${p}`); s = p = x; } } if (s !== null) out.push(s === p ? `${s}` : `${s}-${p}`); return out.join(','); };
  console.log(`== ${nm}: v206=${a.count} v311=${b.count} 同号同内容=${same.length} 内容相同但换号=${moved.length} v206独有/改动=${changed.length} v311独有=${onlyB.length}`);
  if (moved.length) console.log('  moved:', moved.length > 12 ? moved.slice(0, 6).join(' ') + ' … ' + moved.slice(-4).join(' ') : moved.join(' '));
  if (changed.length) console.log('  v206 changed:', rng(changed));
  if (onlyB.length) console.log('  v311 only:', rng(onlyB));
}
