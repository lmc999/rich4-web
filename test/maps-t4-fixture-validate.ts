// 调试：test-industries fixture 的 validateMap 报告（T4）
import { buildTestMapIndustries, validateMap } from '../packages/shared/src/data';

const def = buildTestMapIndustries();
const r = validateMap(def, { strict4: true });
console.log('ok', r.ok, def.meta.counts);
for (const i of r.issues) console.log(i.severity, i.code, i.path, i.message);
