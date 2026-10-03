/**
 * 原版四张图的监狱 / 医院获释位置与方向（VERIFY V-M7；exe v2.06 0x40d184 获释不换节点、0x40bc10 起步时来路 0 → 全部未封邻格随机）。
 * 只在本机有 RICH4_DATA_DIR（从正版提取的数据包：manifest.json + maps/<id>.map.json，不入库）时运行，数据包里没有的图单独 skip
 * （CI 没有提取过的数据，整组 skip）：
 *   RICH4_DATA_DIR=./rich4-data npx vitest run --project shared src/engine/scenario/jailRelease.local.test.ts
 *
 * 每张图：0 号走到命运格，命运 33 坐牢 / 命运 12 住院（步行掉进水沟）3 天 → 获释那一回合 RETURNED 在关押格、
 * 之后 node = prevNode = 关押格 → 下一次掷骰从关押格出发：
 * - 支线尽头的关押格（台湾监狱 1、医院 23，大陆监狱 144，日本监狱 84）只有一个邻格，沿支线走向保释格；
 * - 环路上的关押格（大陆医院 63、日本医院 55、美国医院 85 与监狱 118）两个邻格都可能，fork 0 / 1 各走一边。
 * 1 号整局关在另一种设施里（不走动，免得它的新闻、命运、魔法屋打乱断言）。
 * 断言里只有节点编号，不含原版数据本身（check-no-original 放行）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildFixtureMaps, createRegistry, type DataRegistry, parseMapDef, TABLES } from '../../data';
import type { MapIndex } from '../../data/maps/mapIndex';
import { type Scenario, scenario } from '../testing/scenario';
import type { GameEventOf } from '../types/events';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../..');

type MapId = 'taiwan' | 'china' | 'japan' | 'usa';
type Where = 'jail' | 'hospital';

/** 关押格与获释后的走法：path = 掷 6 点时依次经过的格（单一出路）；forks = 环路上 fork 0 / 1 时第一步到的格 */
interface Expect {
  hold: number;
  path?: number[];
  forks?: [number, number];
}

const CASES: Record<MapId, Record<Where, Expect>> = {
  taiwan: {
    // 监狱支线 1 → 2 → 34 → 4 → 33 → 3 → 32 → 77 → 31 → 76 → 保释格 12
    jail: { hold: 1, path: [2, 34, 4, 33, 3, 32] },
    // 医院支线 23 → 24 → 99 → 25（七彩气球）→ 26 → 100 → 101（企鹅挖宝）→ … → 71（喜从天降）→ 30 → 70 → 出院格 16
    hospital: { hold: 23, path: [24, 99, 25, 26, 100, 101] },
  },
  china: {
    jail: { hold: 144, path: [143, 142, 141, 140, 139, 138] },
    hospital: { hold: 63, forks: [64, 62] },
  },
  japan: {
    jail: { hold: 84, path: [83, 82, 81, 80, 79, 78] },
    hospital: { hold: 55, forks: [56, 54] },
  },
  usa: {
    jail: { hold: 118, forks: [1, 117] },
    hospital: { hold: 85, forks: [86, 84] },
  },
};

interface ManifestEntry {
  id: string;
  file: string;
}

/** RICH4_DATA_DIR 里这张图的 registry（fixture 地图 + 这一张原版图）；没有时 null */
function registryFor(id: MapId): DataRegistry | null {
  const raw = process.env.RICH4_DATA_DIR;
  if (!raw) return null;
  const cands = isAbsolute(raw) ? [raw] : [resolve(process.cwd(), raw), resolve(REPO_ROOT, raw)];
  for (const dir of cands) {
    const manifest = resolve(dir, 'manifest.json');
    if (!existsSync(manifest)) continue;
    const m = JSON.parse(readFileSync(manifest, 'utf8')) as { maps?: ManifestEntry[] };
    const entry = m.maps?.find((x) => x.id === id);
    if (!entry || !existsSync(resolve(dir, entry.file))) continue;
    const def = parseMapDef(JSON.parse(readFileSync(resolve(dir, entry.file), 'utf8')));
    return createRegistry([...buildFixtureMaps().filter((x) => x.id !== def.id), def], { tables: TABLES });
  }
  return null;
}

/** 0 号从某个邻格掷 1 点走上 target（强制岔路选到它） */
function stepOnto(sc: Scenario, ix: MapIndex, target: number): void {
  for (const n of ix.def.tiles) {
    for (const l of n.links) {
      const idx = ix.forwardCandidates(n.id, l.to).indexOf(target);
      if (idx < 0) continue;
      sc.teleport(0, n.id, l.to).force('fork', idx).force('dice', 1).roll(0);
      return;
    }
  }
  throw new Error(`no way onto tile ${target}`);
}

/** 0 号坐牢（命运 33）/ 住院（命运 12），推进到获释（RELEASED）之后 0 号的第一个回合菜单；返回获释那一回合的 RETURNED */
function confineAndRelease(sc: Scenario, ix: MapIndex, where: Where): GameEventOf<'RETURNED'> {
  const fateTile = ix.def.tiles.find((t) => t.landingCode === 3)!.id;
  sc.stackDeck('fate', [where === 'jail' ? 33 : 12]);
  // 1 号也关着，关押到获释之间没有待决策：被关、获释、走回棋盘可能都在掷骰这一批事件里
  const from = sc.log.length;
  stepOnto(sc, ix, fateTile);
  const confined = sc.log.slice(from).find((e): e is GameEventOf<'CONFINED'> => e.type === 'CONFINED');
  expect(confined).toMatchObject({ actor: { t: 'seat', seat: 0 }, where, days: 3 });
  const hold = where === 'jail' ? ix.jailHold : ix.hospitalHold;
  expect(confined!.post?.players?.find((p) => p.seat === 0)?.set).toMatchObject({ node: hold, prevNode: hold });
  sc.until(
    (s) =>
      sc.log.slice(from).some((e) => e.type === 'RELEASED' && e.actor.t === 'seat' && e.actor.seat === 0) &&
      s.pending[0]?.seat === 0 &&
      s.pending[0]?.kind === 'TURN_MENU',
  );
  const returned = sc.log.slice(from).find((e): e is GameEventOf<'RETURNED'> => e.type === 'RETURNED');
  expect(returned).toBeDefined();
  return returned!;
}

const MAPS = Object.keys(CASES) as MapId[];

describe.each(MAPS)('原版 %s：获释留在关押格，下一回合从关押格随机方向出发', (id) => {
  const registry = registryFor(id);
  const run = registry ? it : it.skip;
  for (const where of ['jail', 'hospital'] as const) {
    const want = CASES[id][where];
    const other: Where = where === 'jail' ? 'hospital' : 'jail';
    const start = () => {
      const sc = scenario({ map: id, registry: registry!, players: ['human', 'human'] }).untilMenu(0);
      const ix = registry!.getMap(id);
      // 1 号关在另一种设施里（关押格与 0 号不同），整局不走动
      sc.edit((s) => {
        const p = s.players[1]!;
        p.st[other] = 100;
        p.placed = true;
        p.node = other === 'jail' ? ix.jailHold : ix.hospitalHold;
        p.prevNode = p.node;
      });
      return { sc, ix };
    };

    run(`${where}：RETURNED 与之后的位置都在关押格 ${want.hold}`, () => {
      const { sc, ix } = start();
      expect(where === 'jail' ? ix.jailHold : ix.hospitalHold).toBe(want.hold);
      const r = confineAndRelease(sc, ix, where);
      expect(r).toMatchObject({ seat: 0, node: want.hold });
      expect(sc.player(0)).toMatchObject({ node: want.hold, prevNode: want.hold, returning: false });
    });

    if (want.path) {
      const path = want.path;
      run(`${where}：只有一条出路，沿支线 ${want.hold} → ${path.join(' → ')} 走出来`, () => {
        const { sc, ix } = start();
        confineAndRelease(sc, ix, where);
        sc.force('dice', 6).roll(0);
        expect(sc.events.find((e) => e.type === 'MOVE_SEGMENT')).toMatchObject({ path });
        expect(sc.player(0)).toMatchObject({ node: path.at(-1), prevNode: path.at(-2) });
      });
    }
    if (want.forks) {
      const forks = want.forks;
      run(`${where}：环路上两个方向都可能（fork 0 → ${forks[0]}，fork 1 → ${forks[1]}）`, () => {
        for (const [fork, to] of forks.entries()) {
          const { sc, ix } = start();
          confineAndRelease(sc, ix, where);
          sc.force('fork', fork).force('dice', 1).roll(0);
          expect(sc.state.secret.debugQueue).toEqual([]);
          expect(sc.player(0)).toMatchObject({ node: to, prevNode: want.hold });
        }
      });
    }
  }
});
