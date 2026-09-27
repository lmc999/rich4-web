// 调试脚本（A2）：用 A3 的纯函数映射表跑一遍契约换算，提前发现契约不符
import { buildMusicMap, buildSfxSets, buildVoiceMap } from '../tools/extract/src/assets/audio';
import { catalogV206, type FlicItem } from '../tools/extract/src/assets/catalog.v206';
import { flicInfo, sfxKey, toFlicMapV1, toMusicMapV1, toSfxSetsV1, toVoiceMapV1 } from '../tools/extract/src/assets/mediaMaps';
const v = toVoiceMapV1(buildVoiceMap());
console.log('voice npc keys', Object.keys(v.npc).length, 'news', Object.keys(v.news).length);
const s = toSfxSetsV1(buildSfxSets(), () => true);
console.log('sfx sets', Object.keys(s.sets).length);
const m = toMusicMapV1(buildMusicMap(), () => true);
console.log('music board', m.board.length, 'scenes', Object.keys(m.scenes).length);
const flics = catalogV206().items.filter((i): i is FlicItem => i.type === 'flic').map((it) => ({ key: it.key, info: flicInfo(it, it.def.sfx === null ? null : sfxKey(it.def.sfx)) }));
const f = toFlicMapV1(flics);
console.log('flics', Object.keys(f.flics).length);
