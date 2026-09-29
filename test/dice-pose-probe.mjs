// 调研：角色持骰姿态（Data#87+21c+k，k=2 步行 / 5 机车 / 8 汽车）逐帧样张，确认掷骰动作的帧数与内容。只读 original/，输出 .cache/dice/。
// 帧号 = 方向槽 × (帧数/8) + anim（render.md §2.6）；exe fcn.0040d28a case 2：每 tick anim+1，到 帧数/8 时调用掷骰 fcn.00418d0b。
// 用法：node test/dice-pose-probe.mjs [角色号=0,1,…]
import { blit, canvas, contactSheet, decodeFrame, openMkf, parseSheet, savePng, upscale } from './ui-lib.mjs';

const ROOT = '.';
const OUT = `${ROOT}/.cache/dice`;
const chars = (process.argv[2] ?? '0,3,11').split(',').map(Number);
const m = openMkf(`${ROOT}/original/Game/Data.mkf`);
const imgs = [];
for (const c of chars) {
  for (const [k, name] of [[0, 'stand'], [2, 'dice'], [3, 'moto.stand'], [5, 'moto.dice'], [6, 'car.stand'], [8, 'car.dice']]) {
    const id = 87 + 21 * c + k;
    const raw = m.read(id);
    const sh = parseSheet(raw);
    const per = sh.frames.length / 8;
    console.log(`char ${c} ${name} Data#${id} 帧数 ${sh.frames.length} 每方向 ${per}`);
    // 只取方向槽 0（面向屏幕下方）与槽 2 的全部帧
    for (const slot of [0, 2]) {
      for (let a = 0; a < per; a++) {
        const i = slot * per + a;
        const f = sh.frames[i];
        const im = decodeFrame(sh, raw, i);
        const cv = canvas(110, 110, [60, 90, 60, 255]);
        blit(cv, im, 55 - f.x, 95 - f.y);
        imgs.push(Object.assign(upscale(cv, 1), { label: `${c}${name[0]}${name.includes('.') ? name.split('.')[1][0] : ''}s${slot}a${a}` }));
      }
    }
  }
}
savePng(`${OUT}/dice-poses.png`, contactSheet(imgs, { maxW: 1800 }));
console.log('输出', `${OUT}/dice-poses.png`);
