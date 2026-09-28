// M11 压测热点：比较 structuredClone 与 cloneJson（引擎的 JSON 递归拷贝）在台湾图中局 state / 投影视图上的耗时与结果一致性。
// 用法：npx tsx test/m11-clone-bench.ts [--actions 400]
import { performance } from 'node:perf_hooks';
import { createEngine, defaultGameConfig, type GameState, type PlayerSetup } from '@rich4/shared/engine';
import { intentRng, randomAction } from '@rich4/shared/engine-testing';
import { projectState } from '@rich4/shared/view';
import { loadMapCatalog } from '../apps/server/src/data/DataRegistry';
import { silentLogger } from '../apps/server/src/infra/logger';

const n = Number(process.argv[process.argv.indexOf('--actions') + 1] || 400);

function cloneJson<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const out = new Array<unknown>(v.length);
    for (let i = 0; i < v.length; i++) out[i] = cloneJson(v[i] as unknown);
    return out as T;
  }
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) out[k] = cloneJson(src[k]);
  return out as T;
}

const catalog = await loadMapCatalog({ dataDir: 'rich4-data', defaultMap: 'taiwan', log: silentLogger });
const engine = createEngine(catalog.registry);
const config = defaultGameConfig('taiwan', 20260928);
const players: PlayerSetup[] = [0, 1, 2, 3].map((s) => ({ seat: s as 0, character: s as 0, controller: 'ai' }));
let st: GameState = engine.createGame(config, players, 'be0c4be0c4be0c4be0c4be0c4be0c4aa');
const rng = intentRng('0123abcd');
for (let i = 0; i < n; i++) {
  const a = randomAction(st, rng);
  if (!a) break;
  try {
    st = engine.applyAction(st, a).state;
  } catch {
    // 随机 intent 不合法：换一个
  }
}
const view = projectState(st, { kind: 'seat', seat: 0 }, { handVisibility: 'public' });
console.log(`state ${(JSON.stringify(st).length / 1024).toFixed(0)}KB，view ${(JSON.stringify(view).length / 1024).toFixed(0)}KB`);

function bench(name: string, fn: () => unknown, iters = 400): number {
  for (let i = 0; i < 50; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = (performance.now() - t0) / iters;
  console.log(`${name.padEnd(36)} ${ms.toFixed(3)}ms`);
  return ms;
}
bench('structuredClone(state)', () => structuredClone(st));
bench('cloneJson(state)', () => cloneJson(st));
bench('JSON roundtrip(state)', () => JSON.parse(JSON.stringify(st)));
bench('projectState', () => projectState(st, { kind: 'seat', seat: 0 }, { handVisibility: 'public' }));
bench('structuredClone(view)', () => structuredClone(view));
bench('cloneJson(view)', () => cloneJson(view));
const same = JSON.stringify(cloneJson(st)) === JSON.stringify(structuredClone(st));
console.log('cloneJson 与 structuredClone 序列化一致：', same);
