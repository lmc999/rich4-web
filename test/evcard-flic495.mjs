// 调试脚本（事件卡片取证，只读）：把卡片格得卡 FLIC Data#495（exe 0x41ab8d，画点 (208,180)、音效 99）全部帧放大拼成一张。
// 用法：node test/evcard-flic495.mjs → .cache/evcard/orig/flic495-frames.png
import { mkdirSync } from 'node:fs';
import { contactSheet, decodeFlc, openMkf, savePng, upscale } from './ui-lib.mjs';

mkdirSync('.cache/evcard/orig', { recursive: true });
const m = openMkf('original/Game/Data.mkf');
const fr = decodeFlc(m.read(495), {});
const frames = fr.frames ?? fr;
const imgs = frames.map((f, i) => {
  const im = upscale(f, 4);
  im.label = String(i).padStart(2, '0');
  return im;
});
savePng('.cache/evcard/orig/flic495-frames.png', contactSheet(imgs, { maxW: 1400 }));
console.log(frames.length, 'frames', frames[0].w, 'x', frames[0].h);
