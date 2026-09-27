// 临时调试脚本：逐个解压全部私有压缩资源，核对「输出长度 = rawSize」与「消耗比特数 ≈ storedSize×8」
import { Mkf, lzStat, lzhufDecompress } from './sprite-proto.ts';
const G = './original/';
let total = 0, ok = 0; const slack: Record<number, number> = {}; const ends: Record<string, number> = {}; const slack2: Record<number, number> = {};
for (const f of ['Game/Data.mkf', 'Game/Panel.mkf', 'Game/jump.mkf', 'Game/map.mkf', 'MultiverseJourney/map.mkf']) {
  const m = Mkf.open(G + f);
  for (const e of m.entries) {
    if (!e.compressed) continue;
    total++;
    const body = m.bytes.subarray(e.offset + 16, e.offset + 16 + e.storedSize);
    const out = lzhufDecompress(body, e.rawSize);
    const usedBytes = Math.ceil(lzStat.bits / 8);
    const s = e.storedSize - usedBytes; // 剩余未用字节
    slack[s] = (slack[s] ?? 0) + 1;
    ends[lzStat.endMarker.toString(16)] = (ends[lzStat.endMarker.toString(16)] ?? 0) + 1;
    const s2 = e.storedSize - Math.ceil(lzStat.bitsWithEnd / 8); slack2[s2] = (slack2[s2] ?? 0) + 1;
    if (out.length === e.rawSize && s >= 0 && s <= 4) ok++;
  }
}
console.log({ total, ok, unusedBytesHistogram: slack, endMarkerDist: ends, unusedAfterEndMarker: slack2 });
