// 调试脚本（T3 选图与飞行动画的本机手测）：在 T2 出包之前，拿 rich4-assets 的一份 APFS 克隆（cp -c，不占额外空间）
// 放到 .cache/maps/t3-pack，补上开局设置背景 jump#1–3（title.setup.bg.china / japan / usa）与大陆、日本、美国的节日插画
// Data#28–86（去掉 #66；illustration.holiday.<res−4>），图取自调研阶段解出的 .cache/maps/assets/*.png，重算 packId。
// 只给本机手测用（.cache 已 gitignore），不改 rich4-assets/。
// 用法：npx tsx test/maps-t3-overlay-pack.ts   然后 RICH4_ASSETS_DIR=.cache/maps/t3-pack 起服务端
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hashedPath } from '../packages/shared/src/assets/common';
import { type PackManifestV1, safeParsePackManifest, withPackId } from '../packages/shared/src/assets/pack';

const SRC = 'rich4-assets';
const OUT = '.cache/maps/t3-pack';
const ART = '.cache/maps/assets';

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(dirname(OUT), { recursive: true });
execFileSync('cp', ['-cR', SRC, OUT]);

const m = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as PackManifestV1;
const { packId: _old, ...draft } = m;

function addImage(lp: string, from: string, group: string): { file: string; bytes: number } {
  const buf = readFileSync(from);
  const sha = createHash('sha256').update(buf).digest('hex');
  const path = hashedPath(lp, sha);
  mkdirSync(dirname(join(OUT, path)), { recursive: true });
  copyFileSync(from, join(OUT, path));
  draft.files[lp] = { path, bytes: statSync(from).size, sha256: sha, kind: 'image', contentType: 'image/png' };
  const g = draft.groups[group]!;
  if (!g.files.includes(lp)) {
    g.files.push(lp);
    g.files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    g.bytes += buf.length;
  }
  return { file: lp, bytes: buf.length };
}

const MAPS = ['china', 'japan', 'usa'] as const;
MAPS.forEach((id, i) => {
  const n = i + 1;
  const { file } = addImage(`images/jump/${n}.png`, join(ART, `setup-bg-jump${n}.png`), 'title');
  draft.entries[`title.setup.bg.${id}`] = {
    type: 'image',
    group: 'title',
    confidence: 'exe',
    src: [`jump#${n}`, '0x406c05', '0x40549c'],
    file,
    w: 640,
    h: 480,
    anchor: null,
    transparency: 'opaque',
  } as PackManifestV1['entries'][string];
});

let holidays = 0;
for (let res = 28; res <= 86; res++) {
  if (res === 66) continue;
  const { file } = addImage(`images/data/${res}.png`, join(ART, `holiday-data${res}.png`), 'illustration.holiday');
  draft.entries[`illustration.holiday.${res - 4}`] = {
    type: 'image',
    group: 'illustration.holiday',
    confidence: 'exe',
    src: [`Data#${res}`, '0x473098'],
    file,
    w: 200,
    h: 200,
    anchor: null,
    transparency: 'opaque',
  } as PackManifestV1['entries'][string];
  holidays++;
}

const next = withPackId(draft);
const check = safeParsePackManifest(next);
if (!check.ok) {
  console.error('manifest 校验失败', check.issues.slice(0, 5));
  process.exit(1);
}
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(next, null, 2)}\n`);
console.log(`已写 ${OUT}：packId ${next.packId}，补背景 3 张、节日插画 ${holidays} 张`);
