// 临时调试：用原版素材拼 640×480 主画面样稿 + 9-slice 伸缩演示 + 若干 1:1 代表图
import fs from 'node:fs';
import { openMkf, parseSheet, decodeFrame, decodeRaw555, decodeFlc, canvas, blit, savePng, upscale, label } from './ui-lib.mjs';
const G = './original/Game';
const OUT = './.cache/assets-research/ui/samples';
fs.mkdirSync(OUT, { recursive: true });
const mk = { Panel: openMkf(`${G}/Panel.mkf`), Data: openMkf(`${G}/Data.mkf`), map: openMkf(`${G}/map.mkf`), jump: openMkf(`${G}/jump.mkf`), help: openMkf(`${G}/help.mkf`) };
const fr = (a, r, i, opt) => { const d = mk[a].read(r); return decodeFrame(parseSheet(d), d, i, opt); };
// 带锚点绘制：落点 = 画点 − 图自带 x/y
const put = (cv, im, px, py) => blit(cv, im, px - im.x, py - im.y);

// ---- 1. 主画面样稿（v2.06 资源）----
const cv = canvas(640, 480, [0, 0, 0, 255]);
put(cv, fr('Panel', 1, 0), 0, 0); // 工具列底条 439×40
for (let i = 0; i < 11; i++) put(cv, fr('Panel', 1, (i === 6 ? 12 : 1) + i), i * 40 + 20, 20); // 第 7 颗演示悬停态
const big = fr('map', 8, 1); // 台湾大地图 400×400
blit(cv, big, 20, 60);
put(cv, fr('Panel', 0, 0), 440, 0); // 侧栏「資金」页 200×280
blit(cv, fr('Data', 2, 9), 446, 4); // 孙小美 72×72（落点为示意）
put(cv, fr('Panel', 2, 4), 440, 280); // 右下月历 200×200（春）
put(cv, fr('Panel', 2, 8, { keyBlack: true }), 440 + 16, 280 + 14); // 太阳钮
put(cv, fr('Panel', 2, 10, { keyBlack: true }), 440 + 44, 280 + 14); // 月亮钮
put(cv, fr('Panel', 7, 0, { keyBlack: true }), 360, 400); // GO 钮（位置示意）
const yn = fr('Data', 399, 1);
const box = fr('Data', 476, 5, { keyBlack: true });
put(cv, box, 220, 330); // 通用 YES/NO 框（锚点在中心）
blit(cv, yn, 220 - 48, 340);
const bub = fr('Data', 476, 6, { keyBlack: true });
put(cv, bub, 220 + 40, 130 + 30); // 讲话气泡
blit(cv, fr('map', 24, 0, { keyBlack: true }), 120, 110); // 讲话头像（孙小美 + 表情槽 0）
savePng(`${OUT}/mockup-main-640x480.png`, cv);
savePng(`${OUT}/mockup-main-1280x960.png`, upscale(cv, 2));

// ---- 2. 9-slice 演示 ----
function nine(im, W, H, l, t, r, b) {
  const out = canvas(W, H, [0, 0, 0, 0]);
  const sx = [0, l, im.w - r, im.w], dx = [0, l, W - r, W];
  const sy = [0, t, im.h - b, im.h], dy = [0, t, H - b, H];
  for (let gy = 0; gy < 3; gy++) for (let gx = 0; gx < 3; gx++) {
    const sw = sx[gx + 1] - sx[gx], sh = sy[gy + 1] - sy[gy], dw = dx[gx + 1] - dx[gx], dh = dy[gy + 1] - dy[gy];
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
      const ssx = sx[gx] + Math.min(sw - 1, Math.floor((x * sw) / dw)), ssy = sy[gy] + Math.min(sh - 1, Math.floor((y * sh) / dh));
      const s = (ssy * im.w + ssx) * 4, d = ((dy[gy] + y) * W + dx[gx] + x) * 4;
      out.rgba.set(im.rgba.subarray(s, s + 4), d);
    }
  }
  return out;
}
const demo = canvas(760, 700, [60, 60, 70, 255]);
const p25 = fr('Panel', 25, 2); // 绿边羊皮纸框 278×98
blit(demo, p25, 10, 10); label(demo, 10, 112, 25);
blit(demo, nine(p25, 460, 200, 14, 14, 14, 14), 290, 10);
const p9b = fr('Panel', 9, 12); // 蓝色按钮 97×40
blit(demo, p9b, 10, 240);
blit(demo, nine(p9b, 220, 48, 8, 8, 8, 8), 120, 236);
const p26 = fr('Panel', 26, 2); // 蓝边粉底框 244×100
blit(demo, p26, 10, 300);
blit(demo, nine(p26, 460, 160, 16, 16, 16, 16), 290, 300);
const p0 = fr('Panel', 0, 5); // 侧栏羊皮纸页（无页签版）200×280
blit(demo, nine(p0, 260, 220, 10, 10, 10, 10), 10, 470);
const p476 = fr('Data', 476, 5); // 宝石框 195×133（顶部装饰在中间，只能 3-slice）
blit(demo, p476, 300, 470);
savePng(`${OUT}/nineslice-demo.png`, demo);

// ---- 3. 代表图 1:1 ----
const one = (name, im) => savePng(`${OUT}/${name}.png`, im);
one('toolbar-strip-Panel1', (() => { const c = canvas(440, 80, [0, 0, 0, 0]); put(c, fr('Panel', 1, 0), 0, 0); for (let i = 0; i < 11; i++) { put(c, fr('Panel', 1, 1 + i), i * 40 + 20, 20); put(c, fr('Panel', 1, 12 + i), i * 40 + 20, 60); } return c; })());
one('title-Data1-f0', fr('Data', 1, 0));
one('sidebar-page-funds-Panel0-f0', fr('Panel', 0, 0));
one('asset-sheet-Panel9-f0', fr('Panel', 9, 0));
one('bank-Panel23-f0', fr('Panel', 23, 0));
one('calculator-Panel21-f0', fr('Panel', 21, 0));
one('card-art-Data531-均貧卡', decodeRaw555(mk.Data.read(531), 165, 256));
one('news-art-Data400', decodeRaw555(mk.Data.read(400), 388, 251));
one('holiday-Data4', decodeRaw555(mk.Data.read(4), 200, 200));
one('select-bg-jump0', decodeRaw555(mk.jump.read(0), 640, 480));
one('select-ui-jump4-f1', fr('jump', 4, 1));
one('yesno-Data399', (() => { const c = canvas(96, 144, [0, 0, 0, 0]); for (let i = 0; i < 3; i++) blit(c, fr('Data', 399, i), 0, i * 48); return c; })());
one('portraits-Data2', (() => { const c = canvas(72 * 12, 72, [0, 0, 0, 0]); for (let i = 0; i < 12; i++) blit(c, fr('Data', 2, i), i * 72, 0); return c; })());
one('speaker-map24', (() => { const c = canvas(260, 80, [0, 0, 0, 0]); let x = 0; for (let i = 0; i < 7; i++) { const im = fr('map', 24, i); blit(c, im, x, 0); x += im.w + 4; } return c; })());
const dice = decodeFlc(mk.Panel.read(4));
one('dice-roll-Panel4-f10', dice.frames[10]);
console.log('ok', fs.readdirSync(OUT).length, 'files');
