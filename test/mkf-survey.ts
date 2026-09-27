/**
 * MKF 容器总览（调试脚本）：解析 original/ 下全部 MKF 的索引表与 16 字节资源头，
 * 对压缩资源用 test/lzhuf-proto.ts 解压并校验长度，按 payload 前 16 字节分类，
 * 输出 .cache/assets-research/mkf-index/<file>.json 与汇总 _summary.json。
 *
 * 用法：node test/mkf-survey.ts [--no-decompress] [--only=Data.mkf]
 * 只读 original/，只写 .cache/assets-research/。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type DecompressStats, lzhufDecompress } from './lzhuf-proto.ts';

const ROOT = '.';
const OUT = `${ROOT}/.cache/assets-research/mkf-index`;
const FILES: { edition: 'v206' | 'v311'; rel: string }[] = [
  { edition: 'v206', rel: 'Game/Data.mkf' },
  { edition: 'v206', rel: 'Game/Panel.mkf' },
  { edition: 'v206', rel: 'Game/Speaking.mkf' },
  { edition: 'v206', rel: 'Game/Effect.mkf' },
  { edition: 'v206', rel: 'Game/jump.mkf' },
  { edition: 'v206', rel: 'Game/help.mkf' },
  { edition: 'v206', rel: 'Game/map.mkf' },
  { edition: 'v206', rel: 'Game/MapDat.MKF' },
  { edition: 'v311', rel: 'MultiverseJourney/map.mkf' },
];

const args = new Set(process.argv.slice(2));
const noDecomp = args.has('--no-decompress');
const only = [...args].find((a) => a.startsWith('--only='))?.slice(7);

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const sha1 = (b: Uint8Array) => createHash('sha1').update(b).digest('hex');

type Kind = 'SPR' | 'SMP' | 'GND' | 'FLIC' | 'WAVE' | 'RAW16' | 'TEXT' | 'EMPTY' | 'DATA' | 'UNKNOWN';
const big5 = new TextDecoder('big5', { fatal: true });
function isBig5Text(p: Uint8Array): boolean {
  if (p.length === 0) return false;
  let hi = 0;
  for (const b of p) { if (b >= 0x80) hi++; else if (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09 && b !== 0) return false; }
  if (hi === 0) return false;
  try { big5.decode(p); return true; } catch { return false; }
}

interface Detail {
  [k: string]: unknown;
}

function classify(p: Uint8Array, imgOff: number, imgSize: number, raw: number): { kind: Kind; detail: Detail } {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const tag = p.length >= 4 ? Buffer.from(p.subarray(0, 4)).toString('latin1') : '';
  if (tag === 'SPR\0' || tag === 'SMP\0') {
    const n = dv.getUint32(4, true);
    const start = dv.getUint32(8, true);
    let sum = 0;
    const dims: [number, number, number, number, number][] = [];
    let ok = 12 + n * 12 <= p.length;
    if (ok) {
      for (let i = 0; i < n; i++) {
        const o = 12 + i * 12;
        const g = dv.getUint32(o + 8, true);
        sum += g;
        if (i < 4 || i === n - 1)
          dims.push([dv.getInt16(o, true), dv.getInt16(o + 2, true), dv.getInt16(o + 4, true), dv.getInt16(o + 6, true), g]);
      }
    }
    const first = tag === 'SPR\0' ? start + 512 : start;
    ok = ok && first + sum === p.length;
    return {
      kind: tag === 'SPR\0' ? 'SPR' : 'SMP',
      detail: {
        nchunk: n,
        startOffset: start,
        tableEnd: 12 + n * 12,
        firstGraph: first,
        sumGsize: sum,
        layoutExact: ok,
        imgOffEqStart: imgOff === start,
        imgCoversToEnd: imgOff + imgSize === raw,
        sample: dims,
      },
    };
  }
  if (tag === 'GND\0') {
    return {
      kind: 'GND',
      detail: {
        w: dv.getUint16(4, true),
        h: dv.getUint16(6, true),
        u32_8: dv.getUint32(8, true),
        u32_12: dv.getUint32(12, true),
      },
    };
  }
  if (p.length >= 16 && (dv.getUint16(4, true) === 0xaf12 || dv.getUint16(4, true) === 0xaf11)) {
    return {
      kind: 'FLIC',
      detail: {
        size: dv.getUint32(0, true),
        magic: `0x${dv.getUint16(4, true).toString(16)}`,
        frames: dv.getUint16(6, true),
        w: dv.getUint16(8, true),
        h: dv.getUint16(10, true),
        depth: dv.getUint16(12, true),
        sizeEqRaw: dv.getUint32(0, true) === p.length,
      },
    };
  }
  if (tag === 'RIFF' && p.length >= 44 && Buffer.from(p.subarray(8, 12)).toString('latin1') === 'WAVE') {
    return {
      kind: 'WAVE',
      detail: {
        fmt: dv.getUint16(20, true),
        ch: dv.getUint16(22, true),
        rate: dv.getUint32(24, true),
        bits: dv.getUint16(34, true),
        riffSizeOk: dv.getUint32(4, true) + 8 === p.length,
      },
    };
  }
  if (p.length === 0) return { kind: 'EMPTY', detail: {} };
  if (imgSize === 0 && isBig5Text(p)) return { kind: 'TEXT', detail: { text: new TextDecoder('big5').decode(p.subarray(0, 60)) } };
  if (imgSize > 0) return { kind: 'RAW16', detail: { headerBytes: imgOff, tail: raw - imgOff - imgSize } };
  if (imgOff === 0 && imgSize === 0) return { kind: 'DATA', detail: {} };
  return { kind: 'UNKNOWN', detail: {} };
}

const summary: Record<string, unknown>[] = [];
mkdirSync(OUT, { recursive: true });

for (const f of FILES) {
  const base = f.rel.split('/').pop()!;
  if (only && base !== only) continue;
  const t0 = Date.now();
  const file = new Uint8Array(readFileSync(`${ROOT}/original/${f.rel}`));
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const X = dv.getUint32(0, true);
  const rawN = (file.length - X) / 4;
  if (!Number.isInteger(rawN)) throw new Error(`${f.rel}: 索引表长度不能被 4 整除`);
  const starts: number[] = [];
  for (let i = 0; i < rawN; i++) starts.push(dv.getUint32(X + i * 4, true));
  const sentinel = starts[rawN - 1] === X;
  const n = sentinel ? rawN - 1 : rawN;
  const entries: Record<string, unknown>[] = [];
  const kindCount: Record<string, number> = {};
  const kindCompressed: Record<string, number> = {};
  let compressedCount = 0;
  let storedSum = 0;
  let rawSum = 0;
  let decompOk = 0;
  let decompFail = 0;
  let endMarkerCount = 0;
  let trailingBitsMax = 0;
  let gaps = 0;
  const errors: string[] = [];
  for (let i = 0; i < n; i++) {
    const off = starts[i]!;
    const next = i + 1 < rawN ? starts[i + 1]! : X;
    const raw = dv.getUint32(off, true);
    const stored = dv.getUint32(off + 4, true);
    const imgOff = dv.getUint32(off + 8, true);
    const imgSize = dv.getUint32(off + 12, true);
    const bodyStart = off + 16;
    const gap = next - (bodyStart + stored);
    if (gap !== 0) gaps++;
    const compressed = stored !== raw;
    storedSum += stored;
    rawSum += raw;
    const body = file.subarray(bodyStart, bodyStart + stored);
    let payload: Uint8Array | null = compressed ? null : body;
    let dstat: Record<string, unknown> | null = null;
    if (compressed) {
      compressedCount++;
      if (!noDecomp) {
        const st = {} as DecompressStats;
        try {
          const t1 = performance.now();
          payload = lzhufDecompress(body, raw, st);
          const ms = performance.now() - t1;
          const trailing = stored * 8 - st.bitsUsed;
          trailingBitsMax = Math.max(trailingBitsMax, trailing);
          if (st.endMarker) endMarkerCount++;
          const ok = payload.length === raw && !st.endMarker && st.overrun === 0 && st.tailEndMarker === true;
          if (ok) decompOk++;
          else decompFail++;
          dstat = {
            ok,
            bitsUsed: st.bitsUsed,
            trailingBits: trailing,
            endMarkerEarly: st.endMarker,
            literals: st.literals,
            matches: st.matches,
            rescales: st.rescales,
            overrun: st.overrun,
            tailEndMarker: st.tailEndMarker,
            bitsWithTail: st.bitsWithTail,
            bytesWithTail: st.bitsWithTail === undefined ? null : Math.ceil(st.bitsWithTail / 8),
            storedMinusTailBytes: st.bitsWithTail === undefined ? null : stored - Math.ceil(st.bitsWithTail / 8),
            ms: Math.round(ms),
          };
        } catch (e) {
          decompFail++;
          errors.push(`#${i}: ${(e as Error).message}`);
          dstat = { ok: false, error: (e as Error).message };
        }
      }
    }
    let kind: Kind | 'COMPRESSED?' = 'COMPRESSED?';
    let detail: Detail = {};
    let head16 = '';
    let payloadSha1: string | null = null;
    if (payload) {
      ({ kind, detail } = classify(payload, imgOff, imgSize, raw));
      head16 = hex(payload.subarray(0, 16));
      payloadSha1 = sha1(payload);
    }
    kindCount[kind] = (kindCount[kind] ?? 0) + 1;
    if (compressed) kindCompressed[kind] = (kindCompressed[kind] ?? 0) + 1;
    entries.push({
      i,
      offset: off,
      uncompressed: raw,
      stored,
      imgOff,
      imgSize,
      compressed,
      ratio: compressed ? +(stored / raw).toFixed(4) : 1,
      gap,
      kind,
      head16,
      payloadSha1,
      detail,
      ...(dstat ? { lzhuf: dstat } : {}),
    });
  }
  const fileSha256 = createHash('sha256').update(file).digest('hex');
  const rec = {
    file: f.rel,
    edition: f.edition,
    size: file.length,
    sha256: fileSha256,
    indexTableOffset: X,
    indexEntries: rawN,
    hasSentinel: sentinel,
    count: n,
    compressedCount,
    storedSum,
    rawSum,
    gaps,
    kindCount,
    kindCompressed,
    decompress: noDecomp ? null : { ok: decompOk, fail: decompFail, endMarkerEarly: endMarkerCount, trailingBitsMax },
    errors,
    seconds: (Date.now() - t0) / 1000,
  };
  summary.push(rec);
  writeFileSync(`${OUT}/${f.edition}-${base}.json`, JSON.stringify({ ...rec, entries }, null, 1));
  console.log(JSON.stringify(rec));
}
if (!only) writeFileSync(`${OUT}/_summary.json`, JSON.stringify(summary, null, 1));
