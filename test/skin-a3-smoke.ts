// A3 调试：小样本跑 buildAudio / buildFlicMap / buildVideo，输出到 .cache/assets-staging-smoke/（已被 git 忽略）。
// 用法：npx tsx test/skin-a3-smoke.ts [full]
import { buildAudio } from '../tools/extract/src/assets/audio';
import { buildFlicMap } from '../tools/extract/src/assets/flicMap';
import { buildVideo } from '../tools/extract/src/assets/video';

const full = process.argv[2] === 'full';
const outDir = full ? '.cache/assets-staging' : '.cache/assets-staging-smoke';
const t0 = Date.now();
const a = await buildAudio({
  outDir,
  ...(full ? {} : { ids: { voice: [0, 266, 1074, 1373], sfx: [0, 9, 82, 114], music: [2, 12] } }),
});
console.log('audio', a.files.length, a.tools, a.warnings, `${Date.now() - t0}ms`);
for (const f of a.files.slice(0, 12)) console.log(f.key, f.path, f.bytes, f.durationMs, f.source?.durationMs);
const fm = await buildFlicMap({ outDir });
console.log('flic', fm.verify?.checked, fm.verify?.issues, fm.verify?.unlisted, fm.files[0]?.path);
if (full || process.argv[2] === 'video') {
  const v = await buildVideo({ outDir, ...(full ? {} : { keys: ['flytw'] }) });
  console.log('video', v.files.map((f) => [f.key, f.bytes, f.durationMs]), v.warnings);
}
