/** 测试专用：本机原版 MKF 的清单与期望值（containers.md §2），以及只读加载。 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ExtractContext } from '../../src/context';
import { readFileRO } from '../../src/io/readOnly';
import type { MkfKind } from '../../src/mkf/kind';

export interface MkfExpectation {
  rel: string;
  count: number;
  compressed: number;
  kinds: Partial<Record<MkfKind, number>>;
}

/** containers.md §2 的统计表 */
export const ORIGINAL_MKFS: readonly MkfExpectation[] = [
  { rel: 'Game/Data.mkf', count: 561, compressed: 270, kinds: { SPR: 290, RAW16: 190, FLIC: 72, SMP: 9 } },
  { rel: 'Game/Panel.mkf', count: 113, compressed: 92, kinds: { SPR: 66, SMP: 34, FLIC: 8, DATA: 4, RAW16: 1 } },
  { rel: 'Game/Speaking.mkf', count: 1374, compressed: 0, kinds: { WAVE: 1374 } },
  { rel: 'Game/Effect.mkf', count: 115, compressed: 0, kinds: { WAVE: 99, EMPTY: 16 } },
  { rel: 'Game/jump.mkf', count: 67, compressed: 36, kinds: { SPR: 36, FLIC: 25, RAW16: 4, SMP: 2 } },
  { rel: 'Game/help.mkf', count: 100, compressed: 0, kinds: { SMP: 1, TEXT: 99 } },
  { rel: 'Game/map.mkf', count: 150, compressed: 19, kinds: { SPR: 125, SMP: 17, GND: 4, DATA: 4 } },
  { rel: 'Game/MapDat.MKF', count: 4, compressed: 0, kinds: { DATA: 4 } },
  { rel: 'MultiverseJourney/map.mkf', count: 298, compressed: 23, kinds: { SPR: 261, SMP: 21, GND: 8, DATA: 8 } },
];

export const originalCtx = new ExtractContext({ logger: { out: () => {}, err: () => {} } });

export function originalPath(rel: string): string {
  return path.join(originalCtx.srcDir, rel);
}

export function originalAvailable(rels: readonly string[]): boolean {
  return rels.every((r) => existsSync(originalPath(r)));
}

export async function readOriginal(rel: string): Promise<Uint8Array> {
  return readFileRO(originalPath(rel));
}

/** 调研产物目录（.cache/assets-research，只读对照） */
export function researchPath(...segs: string[]): string {
  return path.join(originalCtx.root, '.cache', 'assets-research', ...segs);
}
