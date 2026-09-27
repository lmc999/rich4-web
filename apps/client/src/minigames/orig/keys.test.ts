// 小游戏原版视图的可用性判定：globalSetup 生成的合成素材包（.cache/synthetic-pack）带齐三款小游戏的必需条目，
// 帧数与原版包相同；缺条目、组失败或置信度 guess 时整局回退（origPlan 为 null）。
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssetEntry, PackManifestV1 } from '@rich4/shared/assets';
import { MINIGAME_IDS } from '@rich4/shared/minigames';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkEntry } from '../../skin/resolve';
import { ORIG_OPTIONAL, origPlan, origRequiredKeys, READY_KEY, readyDurationMs } from './keys';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

let manifest: PackManifestV1;
beforeAll(() => {
  manifest = JSON.parse(readFileSync(join(REPO, '.cache', 'synthetic-pack', 'manifest.json'), 'utf8'));
});

function packOf(m: PackManifestV1, failed: Set<string> = new Set()) {
  return {
    manifest: m,
    usableEntry: (key: string): AssetEntry | null => checkEntry(m, key, failed, {}).entry,
  };
}

/** 原版包的帧数（资源目录 catalog.v206 的 Panel#79–112） */
const FRAMES: Readonly<Record<string, number>> = {
  'mg.common.hud': 20,
  'mg.penguin.screen': 10,
  'mg.penguin.82': 32,
  'mg.penguin.83': 32,
  'mg.penguin.84': 8,
  'mg.penguin.85': 6,
  'mg.balloon.screen': 14,
  'mg.xicong.93': 19,
  'mg.xicong.94': 12,
  'mg.xicong.char.3': 33,
  'mg.xicong.char.5': 31,
};

describe('合成素材包的小游戏条目', () => {
  it('三款小游戏的必需条目齐全（喜从天降 12 个角色都有接物姿态），帧数同原版包', () => {
    const pack = packOf(manifest);
    expect(origPlan(pack, 'penguin', null)).not.toBeNull();
    expect(origPlan(pack, 'balloon', null)).not.toBeNull();
    for (let c = 0; c < 12; c++) expect(origPlan(pack, 'xicong', c), `角色 ${c}`).not.toBeNull();
    for (const [k, n] of Object.entries(FRAMES)) {
      const e = manifest.entries[k];
      expect(e?.type === 'sprite' ? e.frames.count : null, k).toBe(n);
    }
    const ready = manifest.entries[READY_KEY];
    expect(ready?.type === 'flic' ? [ready.w, ready.h, ready.frames, ready.frameMs] : null).toEqual([
      640, 480, 20, 114,
    ]);
    expect(readyDurationMs(pack)).toBe(20 * 114);
    const bg = manifest.entries['mg.xicong.bg'];
    expect(bg?.type === 'image' ? [bg.w, bg.h] : null).toEqual([640, 480]);
  });

  it('缺条目、组失败或 guess → 整局回退', () => {
    for (const id of MINIGAME_IDS) {
      const keys = origRequiredKeys(id, 0)!;
      for (const k of [keys[0]!, keys.at(-1)!]) {
        const m = structuredClone(manifest);
        delete (m.entries as Record<string, AssetEntry>)[k];
        expect(origPlan(packOf(m), id, 0), `${id} 缺 ${k}`).toBeNull();
        const g = structuredClone(manifest);
        (g.entries[k] as { confidence: string }).confidence = 'guess';
        expect(origPlan(packOf(g), id, 0), `${id} ${k} guess`).toBeNull();
      }
      const group = manifest.entries[keys.at(-1)!]!.group;
      expect(origPlan(packOf(manifest, new Set([group])), id, 0), `${id} 组 ${group} 失败`).toBeNull();
    }
    expect(origPlan(null, 'penguin', 0)).toBeNull();
  });

  it('可选条目不影响判定', () => {
    const m = structuredClone(manifest);
    for (const k of Object.values(ORIG_OPTIONAL).flat()) delete (m.entries as Record<string, AssetEntry>)[k];
    for (const id of MINIGAME_IDS) expect(origPlan(packOf(m), id, 1)).not.toBeNull();
  });
});
