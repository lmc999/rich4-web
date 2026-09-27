// 临时调试库：MKF 容器 + 私有 LZHUF 解压 + SPR/SMP 解码 + 最小 PNG 编码。
// 依据 docs/research/g_map.md §6.2–§6.3 的伪代码与 r_references.md §2.5 自行实现（不含任何第三方代码）。
import fs from 'node:fs';
import zlib from 'node:zlib';

// ---------------- MKF 容器 ----------------
export function openMkf(path) {
  const b = fs.readFileSync(path);
  const X = b.readUInt32LE(0);
  const n = (b.length - X) / 4;
  const starts = [];
  for (let i = 0; i < n; i++) starts.push(b.readUInt32LE(X + 4 * i));
  const count = starts[n - 1] === X ? n - 1 : n;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = starts[i];
    entries.push({
      index: i,
      offset: o,
      raw: b.readUInt32LE(o),
      stored: b.readUInt32LE(o + 4),
      imgOff: b.readUInt32LE(o + 8),
      imgSize: b.readUInt32LE(o + 12),
    });
  }
  const cache = new Map();
  return {
    path,
    buf: b,
    entries,
    count,
    read(i) {
      if (cache.has(i)) return cache.get(i);
      const e = entries[i];
      const body = b.subarray(e.offset + 16, e.offset + 16 + e.stored);
      const out = e.raw === e.stored ? body : lzhufDecompress(body, e.raw);
      if (cache.size > 8) cache.clear();
      cache.set(i, out);
      return out;
    },
  };
}

// ---------------- LZHUF（自适应哈夫曼 + LZ77，LSB-first） ----------------
const NCHAR = 321;
const T = 641; // 节点数
const R = 640; // 根
const DLEN = new Uint8Array(256);
const DHI = new Uint8Array(256);
(function buildDist() {
  for (let v = 0; v < 256; v++) {
    const blk = v >> 4;
    const lo = v & 15;
    let L;
    let H;
    if (lo === 0) {
      L = 8;
      H = 63 - blk;
    } else if (lo === 7 || lo === 15) {
      L = 3;
      H = 0;
    } else if (lo === 3 || lo === 11 || lo === 13) {
      L = 4;
      H = 3 - { 3: 0, 11: 1, 13: 2 }[lo];
    } else if (lo === 1 || lo === 5 || lo === 9 || lo === 14) {
      L = 5;
      H = 11 - 4 * (blk % 2) - { 1: 0, 5: 1, 9: 2, 14: 3 }[lo];
    } else if (lo === 2 || lo === 6 || lo === 10) {
      L = 6;
      H = 23 - 3 * (blk % 4) - { 2: 0, 6: 1, 10: 2 }[lo];
    } else {
      // 4, 8, 12
      L = 7;
      H = 47 - 3 * (blk % 8) - { 4: 0, 8: 1, 12: 2 }[lo];
    }
    DLEN[v] = L;
    DHI[v] = H;
  }
})();

export function lzhufDecompress(src, size) {
  const out = new Uint8Array(size);
  const freq = new Uint32Array(T + 1);
  const son = new Int32Array(T); // 存「索引×2」
  const prnt = new Int32Array(T + NCHAR + 1); // 963
  for (let i = 0; i < NCHAR; i++) {
    freq[i] = 1;
    son[i] = (i + T) * 2;
  }
  for (let j = NCHAR; j < T; j++) {
    const k = j - NCHAR;
    freq[j] = freq[2 * k] + freq[2 * k + 1];
    son[j] = 2 * k * 2;
  }
  freq[T] = 0xffff;
  for (let i = 0; i < R; i++) prnt[i] = (NCHAR + (i >> 1)) * 2;
  prnt[R] = 0;
  for (let s = 0; s < NCHAR; s++) prnt[T + s] = s * 2;
  prnt[T + NCHAR] = 0;

  let pos = 0;
  const nbits = src.length * 8;
  const bit = () => {
    const p = pos++;
    if (p >= nbits) return 0;
    return (src[p >> 3] >> (p & 7)) & 1;
  };
  const bits = (n) => {
    let v = 0;
    for (let k = 0; k < n; k++) v |= bit() << k;
    return v;
  };
  const bump = (s) => {
    let e = prnt[T + s] >> 1;
    for (;;) {
      freq[e]++;
      const a = freq[e];
      if (a <= freq[e + 1]) {
        e = prnt[e] >> 1;
        if (e === 0) return;
        continue;
      }
      let l = e + 1;
      while (freq[l] === a - 1) l++;
      l--;
      const t = freq[e];
      freq[e] = freq[l];
      freq[l] = t;
      const i = son[e];
      const j = son[l];
      prnt[j >> 1] = e * 2;
      if (j < 0x502) prnt[(j >> 1) + 1] = e * 2;
      prnt[i >> 1] = l * 2;
      if (i < 0x502) prnt[(i >> 1) + 1] = l * 2;
      son[e] = j;
      son[l] = i;
      e = prnt[l] >> 1;
      if (e === 0) return;
    }
  };
  const rescale = () => {
    for (let s = 0; s < NCHAR; s++) if (freq[prnt[T + s] >> 1] & 1) bump(s);
    for (let k = 0; k < T; k++) freq[k] >>>= 1;
  };
  const decodeSymbol = () => {
    let n = R;
    let c;
    for (;;) {
      c = son[n] >> 1;
      if (c >= T) break;
      c += bit();
      n = c;
    }
    const s = c - T;
    if (freq[R] === 0x8000) rescale();
    bump(s);
    return s;
  };
  let o = 0;
  while (o < size) {
    const s = decodeSymbol();
    if (s < 256) {
      out[o++] = s;
      continue;
    }
    const save = pos;
    const b = bits(8);
    pos = save;
    const L = DLEN[b];
    const hi = DHI[b];
    pos += L;
    const lo6 = bits(6);
    const dist = (hi << 6) | lo6;
    if (dist === 0xfff) break;
    let n = Math.min(s - 253, size - o);
    let p = o - 1 - dist;
    while (n-- > 0) {
      out[o++] = p >= 0 ? out[p] : 0;
      p++;
    }
  }
  out.decodedLength = o;
  return out;
}

// ---------------- SPR / SMP ----------------
export function parseSheet(data) {
  if (data.length < 12) return null;
  const sig = String.fromCharCode(data[0], data[1], data[2], data[3]);
  if (sig !== 'SPR\0' && sig !== 'SMP\0') return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n = dv.getUint32(4, true);
  const start = dv.getUint32(8, true);
  const isSpr = sig === 'SPR\0';
  let off = isSpr ? start + 512 : start;
  const frames = [];
  for (let i = 0; i < n; i++) {
    const t = 12 + i * 12;
    const f = {
      w: dv.getInt16(t, true),
      h: dv.getInt16(t + 2, true),
      x: dv.getInt16(t + 4, true),
      y: dv.getInt16(t + 6, true),
      gsize: dv.getUint32(t + 8, true),
      off,
    };
    frames.push(f);
    off += f.gsize;
  }
  return { kind: isSpr ? 'SPR' : 'SMP', start, frames, palette: isSpr ? data.subarray(start, start + 512) : null, end: off };
}

const x5 = (v) => (v << 3) | (v >> 2);
export function rgb555(c) {
  return [x5((c >> 10) & 31), x5((c >> 5) & 31), x5(c & 31)];
}

export function decodeFrame(sheet, data, i, { keyBlack = false } = {}) {
  const f = sheet.frames[i];
  const { w, h } = f;
  const rgba = new Uint8Array(w * h * 4);
  if (sheet.kind === 'SPR') {
    const pal = [];
    for (let k = 0; k < 256; k++) pal.push(rgb555(sheet.palette[k * 2] | (sheet.palette[k * 2 + 1] << 8)));
    for (let p = 0; p < w * h; p++) {
      const idx = data[f.off + p];
      if (idx === 0 || idx === undefined) continue;
      const c = pal[idx];
      rgba[p * 4] = c[0];
      rgba[p * 4 + 1] = c[1];
      rgba[p * 4 + 2] = c[2];
      rgba[p * 4 + 3] = 255;
    }
  } else {
    for (let p = 0; p < w * h; p++) {
      const q = f.off + p * 2;
      if (q + 1 >= data.length) break;
      const v = data[q] | (data[q + 1] << 8);
      if (keyBlack && v === 0) continue;
      const c = rgb555(v);
      rgba[p * 4] = c[0];
      rgba[p * 4 + 1] = c[1];
      rgba[p * 4 + 2] = c[2];
      rgba[p * 4 + 3] = 255;
    }
  }
  return { w, h, x: f.x, y: f.y, rgba };
}

export function decodeRaw555(data, w, h, off = 0) {
  const rgba = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const q = off + p * 2;
    const v = data[q] | (data[q + 1] << 8);
    const c = rgb555(v);
    rgba[p * 4] = c[0];
    rgba[p * 4 + 1] = c[1];
    rgba[p * 4 + 2] = c[2];
    rgba[p * 4 + 3] = 255;
  }
  return { w, h, x: 0, y: 0, rgba };
}

// ---------------- PNG ----------------
const CRC_T = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_T[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
export function savePng(path, img) {
  fs.writeFileSync(path, encodePng(img.w, img.h, img.rgba));
}

// ---------------- 画布（拼接样张） ----------------
export function canvas(w, h, bg = [40, 40, 48, 255]) {
  const rgba = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) rgba.set(bg, p * 4);
  return { w, h, rgba };
}
export function blit(dst, src, dx, dy, { checker = false } = {}) {
  for (let y = 0; y < src.h; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.h) continue;
    for (let x = 0; x < src.w; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.w) continue;
      const s = (y * src.w + x) * 4;
      const d = (ty * dst.w + tx) * 4;
      const a = src.rgba[s + 3];
      if (a === 0) {
        if (checker) {
          const v = ((tx >> 3) + (ty >> 3)) & 1 ? 200 : 160;
          dst.rgba[d] = dst.rgba[d + 1] = dst.rgba[d + 2] = v;
          dst.rgba[d + 3] = 255;
        }
        continue;
      }
      dst.rgba[d] = src.rgba[s];
      dst.rgba[d + 1] = src.rgba[s + 1];
      dst.rgba[d + 2] = src.rgba[s + 2];
      dst.rgba[d + 3] = 255;
    }
  }
}
export function rect(dst, x0, y0, w, h, c) {
  for (let x = x0; x < x0 + w; x++)
    for (const y of [y0, y0 + h - 1]) {
      if (x < 0 || y < 0 || x >= dst.w || y >= dst.h) continue;
      dst.rgba.set(c, (y * dst.w + x) * 4);
    }
  for (let y = y0; y < y0 + h; y++)
    for (const x of [x0, x0 + w - 1]) {
      if (x < 0 || y < 0 || x >= dst.w || y >= dst.h) continue;
      dst.rgba.set(c, (y * dst.w + x) * 4);
    }
}

// 3×5 位图数字，用于在样张上标注帧号
const DIG = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];
export function label(dst, x, y, text, c = [255, 255, 0, 255], s = 2) {
  let cx = x;
  for (const ch of String(text)) {
    const d = DIG[+ch];
    if (d) {
      for (let r = 0; r < 5; r++)
        for (let q = 0; q < 3; q++)
          if (d[r * 3 + q] === '1')
            for (let a = 0; a < s; a++)
              for (let b2 = 0; b2 < s; b2++) {
                const px = cx + q * s + a;
                const py = y + r * s + b2;
                if (px >= 0 && py >= 0 && px < dst.w && py < dst.h) dst.rgba.set(c, (py * dst.w + px) * 4);
              }
    }
    cx += 4 * s;
  }
}

// 把一组帧拼成样张（按行流式排版）
export function contactSheet(imgs, { maxW = 1400, pad = 6, scale = 1, labels = true } = {}) {
  const items = imgs.map((im, k) => ({ im, k: im.label ?? k }));
  let x = pad;
  let y = pad;
  let rowH = 0;
  const pos = [];
  for (const it of items) {
    const w = it.im.w * scale;
    const h = it.im.h * scale + (labels ? 14 : 0);
    if (x + w + pad > maxW && x > pad) {
      x = pad;
      y += rowH + pad;
      rowH = 0;
    }
    pos.push([x, y]);
    x += Math.max(w, 30) + pad;
    rowH = Math.max(rowH, h);
  }
  const W = Math.min(maxW, Math.max(...pos.map((p, i) => p[0] + Math.max(items[i].im.w * scale, 30) + pad), 60));
  const H = y + rowH + pad;
  const cv = canvas(W, H);
  items.forEach((it, i) => {
    const [px, py] = pos[i];
    if (labels) label(cv, px, py, it.k);
    const im = scale === 1 ? it.im : upscale(it.im, scale);
    blit(cv, im, px, py + (labels ? 14 : 0), { checker: true });
  });
  return cv;
}
export function upscale(im, s) {
  const w = im.w * s;
  const h = im.h * s;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const si = (((y / s) | 0) * im.w + ((x / s) | 0)) * 4;
      rgba.set(im.rgba.subarray(si, si + 4), (y * w + x) * 4);
    }
  return { w, h, rgba };
}
export function downscale(im, s) {
  const w = Math.max(1, (im.w / s) | 0);
  const h = Math.max(1, (im.h / s) | 0);
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const si = ((y * s) * im.w + x * s) * 4;
      rgba.set(im.rgba.subarray(si, si + 4), (y * w + x) * 4);
    }
  return { w, h, rgba, x: im.x, y: im.y };
}

// ---------------- FLC（Autodesk Animator Pro，8bpp） ----------------
export function decodeFlc(data, { maxFrames = Infinity, transparentIndex = -1 } = {}) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const type = dv.getUint16(4, true);
  const nframes = dv.getUint16(6, true);
  const w = dv.getUint16(8, true);
  const h = dv.getUint16(10, true);
  const speed = dv.getUint32(16, true);
  let off = type === 0xaf12 ? dv.getUint32(80, true) || 128 : 128;
  const idx = new Uint8Array(w * h);
  const pal = new Uint8Array(768);
  const frames = [];
  const chunkTypes = {};
  for (let f = 0; f < nframes && f < maxFrames && off + 16 <= data.length; f++) {
    let fsize = dv.getUint32(off, true);
    const ftype = dv.getUint16(off + 4, true);
    if (ftype !== 0xf1fa) {
      off += fsize || 16;
      f--;
      if (!fsize) break;
      continue;
    }
    const nch = dv.getUint16(off + 6, true);
    let c = off + 16;
    for (let k = 0; k < nch; k++) {
      const csize = dv.getUint32(c, true);
      const ctype = dv.getUint16(c + 4, true);
      chunkTypes[ctype] = (chunkTypes[ctype] || 0) + 1;
      let p = c + 6;
      if (ctype === 4 || ctype === 11) {
        const packets = dv.getUint16(p, true);
        p += 2;
        let ci = 0;
        for (let q = 0; q < packets; q++) {
          ci += data[p++];
          let cnt = data[p++];
          if (cnt === 0) cnt = 256;
          for (let j = 0; j < cnt; j++) {
            const s = ctype === 11 ? 4 : 1;
            pal[ci * 3] = Math.min(255, data[p] * s);
            pal[ci * 3 + 1] = Math.min(255, data[p + 1] * s);
            pal[ci * 3 + 2] = Math.min(255, data[p + 2] * s);
            p += 3;
            ci++;
          }
        }
      } else if (ctype === 15) {
        for (let y = 0; y < h; y++) {
          p++;
          let x = 0;
          while (x < w) {
            const cnt = (data[p++] << 24) >> 24;
            if (cnt > 0) {
              const v = data[p++];
              for (let j = 0; j < cnt && x < w; j++) idx[y * w + x++] = v;
            } else {
              for (let j = 0; j < -cnt && x < w; j++) idx[y * w + x++] = data[p++];
            }
          }
        }
      } else if (ctype === 7) {
        let lines = dv.getUint16(p, true);
        p += 2;
        let y = 0;
        while (lines > 0 && y < h) {
          let word = dv.getUint16(p, true);
          p += 2;
          if ((word & 0xc000) === 0xc000) {
            y += 0x10000 - word;
            continue;
          }
          if ((word & 0xc000) === 0x8000) {
            idx[y * w + w - 1] = word & 0xff;
            word = dv.getUint16(p, true);
            p += 2;
            if (word === 0) {
              y++;
              lines--;
              continue;
            }
          }
          let x = 0;
          for (let q = 0; q < word; q++) {
            x += data[p++];
            const cnt = (data[p++] << 24) >> 24;
            if (cnt > 0) {
              for (let j = 0; j < cnt; j++) {
                idx[y * w + x++] = data[p++];
                idx[y * w + x++] = data[p++];
              }
            } else {
              const a = data[p++];
              const b = data[p++];
              for (let j = 0; j < -cnt; j++) {
                idx[y * w + x++] = a;
                idx[y * w + x++] = b;
              }
            }
          }
          y++;
          lines--;
        }
      } else if (ctype === 12) {
        let y = dv.getUint16(p, true);
        const n = dv.getUint16(p + 2, true);
        p += 4;
        for (let l = 0; l < n; l++, y++) {
          const packets = data[p++];
          let x = 0;
          for (let q = 0; q < packets; q++) {
            x += data[p++];
            const cnt = (data[p++] << 24) >> 24;
            if (cnt > 0) for (let j = 0; j < cnt; j++) idx[y * w + x++] = data[p++];
            else {
              const v = data[p++];
              for (let j = 0; j < -cnt; j++) idx[y * w + x++] = v;
            }
          }
        }
      } else if (ctype === 13) {
        idx.fill(0);
      } else if (ctype === 16) {
        idx.set(data.subarray(p, p + w * h));
      }
      c += csize;
    }
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const v = idx[i];
      if (v === transparentIndex) continue;
      rgba[i * 4] = pal[v * 3];
      rgba[i * 4 + 1] = pal[v * 3 + 1];
      rgba[i * 4 + 2] = pal[v * 3 + 2];
      rgba[i * 4 + 3] = 255;
    }
    frames.push({ w, h, rgba });
    off += fsize;
  }
  return { w, h, nframes, speed, frames, chunkTypes };
}
