// 调研：把一段 FLIC 解码后经 ffmpeg 编成 WebM(VP9)，对比体积。用法：node test/ar_flic_webm.mjs <mkf> <id> [alpha=0]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { openMkf, decodeFlc } from './ui-lib.mjs';
const ROOT = '.';
const [f, id, alpha = '0'] = process.argv.slice(2);
const m = openMkf(`${ROOT}/original/Game/${f}`);
const { w, h, frames, speed } = decodeFlc(m.read(+id), { transparentIndex: alpha === '1' ? 0 : -1 });
const raw = Buffer.concat(frames.map((fr) => Buffer.from(fr.rgba)));
const out = `${ROOT}/.cache/assets-research/audio/flic-atlas/${f.replace('.mkf', '')}${id}${alpha === '1' ? '_alpha' : ''}.webm`;
const args = ['-hide_banner', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-framerate', String(1000 / speed), '-i', '-', '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-row-mt', '1', '-pix_fmt', alpha === '1' ? 'yuva420p' : 'yuv420p', out];
const r = spawnSync('ffmpeg', args, { input: raw, maxBuffer: 1 << 30 });
console.log(r.status, r.stderr.toString().slice(0, 300), out, fs.existsSync(out) ? fs.statSync(out).size : 0);
