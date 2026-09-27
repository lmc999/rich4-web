// 调试：用客户端 FlcDecoder 与 tools/extract 的解码器逐帧对拍本机素材包里的全部 FLC（只读）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FlcDecoder as Mine, parseFlc as parseMine } from '../apps/client/src/skin/flic/FlcDecoder';
import { FlcDecoder as Ref, parseFlc as parseRef } from '../tools/extract/src/gfx/flc';
const dir = 'rich4-assets';
const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
let n = 0, frames = 0, warn = 0;
for (const [key, e] of Object.entries<any>(m.entries)) {
  if (e.type !== 'flic') continue;
  const f = m.files[e.file];
  const bytes = new Uint8Array(readFileSync(join(dir, f.path)));
  const a = parseMine(bytes, key);
  const b = parseRef(bytes, key);
  if (a.frames !== e.frames || a.width !== e.w || a.height !== e.h) throw new Error(`${key} header mismatch`);
  if (a.chunks.length !== b.frameChunks.length) throw new Error(`${key} chunk count`);
  warn += a.warnings.length;
  const da = new Mine(a), db = new Ref(b);
  while (!da.done) {
    da.next(); db.next();
    if (!Buffer.from(da.pixels).equals(Buffer.from(db.pixels)) || !Buffer.from(da.palette).equals(Buffer.from(db.palette))) {
      throw new Error(`${key} frame ${da.position - 1} differs`);
    }
    frames++;
  }
  n++;
}
console.log(`ok: ${n} FLC, ${frames} frame chunks, ${warn} warnings`);
