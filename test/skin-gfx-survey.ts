// 临时调试：用生产解码器全量跑一遍 9 个 MKF（只读 original/），统计类型、告警与耗时
import { readFileSync } from 'node:fs';
import { MkfArchive } from '../tools/extract/src/mkf/container';
import { parseSpr, decodeSprFrame } from '../tools/extract/src/gfx/spr';
import { parseSmp, decodeSmpFrame } from '../tools/extract/src/gfx/smp';
import { parseGnd, gndToIndexed } from '../tools/extract/src/gfx/gnd';
import { decodeRaw16, raw16Dims } from '../tools/extract/src/gfx/raw16';
import { parseFlc, decodeFlcFrames, verifyFlcRing } from '../tools/extract/src/gfx/flc';
import { parseWave } from '../tools/extract/src/gfx/wave';
const files = ['Game/Data.mkf','Game/Panel.mkf','Game/Speaking.mkf','Game/Effect.mkf','Game/jump.mkf','Game/help.mkf','Game/map.mkf','Game/MapDat.MKF','MultiverseJourney/map.mkf'];
const t0 = Date.now();
const archives = files.map((f) => MkfArchive.open(new Uint8Array(readFileSync('original/' + f)), f));
console.log('open ms', Date.now() - t0);
const t1 = Date.now(); let comp = 0;
for (const a of archives) for (const e of a.entries()) if (e.compressed) { a.read(e.index); comp++; }
console.log('decompress', comp, 'ms', Date.now() - t1, 'total', Date.now() - t0);
let zeroFrames = 0, flcWarn: string[] = [], ringBad: string[] = [], rateCount: Record<string, number> = {}, chunkSets: Record<string, number> = {};
const t2 = Date.now();
for (const a of archives) {
  const kinds: Record<string, number> = {};
  for (const e of a.entries()) {
    kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    const lab = `${a.name}#${e.index}`;
    try {
      if (e.kind === 'SPR') { const s = parseSpr(a.read(e.index), lab); for (let i = 0; i < s.count; i++) { if (!s.frames[i]!.w || !s.frames[i]!.h) zeroFrames++; decodeSprFrame(s, i); } }
      else if (e.kind === 'SMP') { const s = parseSmp(a.read(e.index), lab); for (let i = 0; i < s.count; i++) { if (!s.frames[i]!.w || !s.frames[i]!.h) zeroFrames++; decodeSmpFrame(s, i); } }
      else if (e.kind === 'GND') { const g = parseGnd(a.read(e.index), lab); if (!g.identityLayout) console.log('non-identity', lab); gndToIndexed(g); }
      else if (e.kind === 'RAW16') { const d = a.read(e.index); if (!raw16Dims(d.length)) console.log('raw16 size?', lab, d.length); else decodeRaw16(d); }
      else if (e.kind === 'FLIC') { const f = parseFlc(a.read(e.index), lab); for (const w of f.warnings) flcWarn.push(`${lab} ${w.code} ${w.detail}`); decodeFlcFrames(f); if (verifyFlcRing(f) !== true) ringBad.push(lab); for (const k of Object.keys(f.subchunkCounts)) chunkSets[k] = (chunkSets[k] ?? 0) + f.subchunkCounts[k]!; }
      else if (e.kind === 'WAVE') { const w = parseWave(a.read(e.index), lab); const k = `${w.format}/${w.channels}/${w.sampleRate}/${w.bitsPerSample}/${w.chunks.map(c=>c.id).join(',')}`; rateCount[k] = (rateCount[k] ?? 0) + 1; }
    } catch (err) { console.log('ERR', lab, (err as Error).message); }
  }
  console.log(a.name, a.count, JSON.stringify(kinds));
}
console.log('decode ms', Date.now() - t2, 'zeroFrames', zeroFrames);
console.log('flc warnings', flcWarn); console.log('ring bad', ringBad); console.log('chunks', chunkSets); console.log('wave', rateCount);
