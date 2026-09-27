// 调试（A12 第一组场所屏）：把本机素材包图集里的一帧裁一块、放大并画网格（每 10 源像素细线、每 50 像素粗线），
// 输出 PNG 到 .cache/w3-venues/（含原版像素，只在本机看，不入库）。
// 用法：node test/w3-venue-crop.mjs <atlas.json> <atlas.png> <帧名> <x> <y> <w> <h> <倍率> <输出名>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

function decode(buf) {
  let off = 8;
  let w = 0;
  let h = 0;
  let ctype = 0;
  const idat = [];
  let pal = null;
  let trns = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      ctype = data[9];
    }
    if (type === 'PLTE') pal = data;
    if (type === 'tRNS') trns = data;
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = new Uint8Array(w * h * bpp);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const a = raw[y * (stride + 1) + 1 + x];
      const left = x >= bpp ? out[y * stride + x - bpp] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const ul = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v;
      if (f === 0) v = a;
      else if (f === 1) v = a + left;
      else if (f === 2) v = a + up;
      else if (f === 3) v = a + ((left + up) >> 1);
      else {
        const p = left + up - ul;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - ul);
        v = a + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
      }
      out[y * stride + x] = v & 255;
    }
  }
  const rgba = (x, y) => {
    const i = (y * w + x) * bpp;
    if (ctype === 6) return [out[i], out[i + 1], out[i + 2], out[i + 3]];
    if (ctype === 2) return [out[i], out[i + 1], out[i + 2], 255];
    if (ctype === 3) {
      const k = out[i];
      return [pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2], trns && k < trns.length ? trns[k] : 255];
    }
    return [out[i], out[i], out[i], 255];
  };
  return { w, h, rgba };
}

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b) {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encode(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const [, , atlasJson, pngFile, name, sx, sy, sw, sh, sk, outName] = process.argv;
const atlas = JSON.parse(readFileSync(atlasJson, 'utf8'));
const img = decode(readFileSync(pngFile));
const F = atlas.frames[name].frame;
const x0 = Number(sx);
const y0 = Number(sy);
const w = Number(sw);
const h = Number(sh);
const k = Number(sk);
const W = w * k;
const H = h * k;
const out = new Uint8Array(W * H * 4);
for (let Y = 0; Y < H; Y++) {
  for (let X = 0; X < W; X++) {
    const x = x0 + Math.floor(X / k);
    const y = y0 + Math.floor(Y / k);
    let c = [40, 40, 48, 255];
    if (x >= 0 && y >= 0 && x < F.w && y < F.h) {
      const p = img.rgba(F.x + x, F.y + y);
      c = p[3] < 128 ? [((x ^ y) & 4) === 0 ? 70 : 90, 70, 90, 255] : p;
    }
    const gx = X % k === 0 && x % 10 === 0;
    const gy = Y % k === 0 && y % 10 === 0;
    if (process.env.GRID !== "0" && (gx || gy)) {
      const major = (gx && x % 50 === 0) || (gy && y % 50 === 0);
      c = major ? [255, 0, 255, 255] : [0, 255, 255, 255];
    }
    out.set(c, (Y * W + X) * 4);
  }
}
mkdirSync('.cache/w3-venues', { recursive: true });
writeFileSync(`.cache/w3-venues/${outName}.png`, encode(W, H, out));
console.log(`.cache/w3-venues/${outName}.png`, W, H);
