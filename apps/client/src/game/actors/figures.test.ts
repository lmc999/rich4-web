// 神明、四大恶人与 NPC 造型（纯 SVG 生成，node 可测）
import { GOD_KINDS, VILLAIN_KINDS } from '@rich4/shared/engine';
import { describe, expect, it } from 'vitest';
import { FACINGS, POSES } from '../procedural/character/rig';
import { characterSvg } from '../procedural/character/svg';
import {
  allFigureIds,
  anyFigureSvg,
  figureConfig,
  figureSvg,
  GOD_PALETTES,
  godSvg,
  innerSvg,
  NPC_IDS,
} from './figures';

describe('figures', () => {
  it('覆盖 13 种神明、4 个恶人、4 个 NPC', () => {
    const ids = allFigureIds();
    expect(ids.filter((x) => x.startsWith('god:'))).toHaveLength(GOD_KINDS.length);
    expect(ids.filter((x) => x.startsWith('villain:'))).toHaveLength(VILLAIN_KINDS.length);
    expect(ids.filter((x) => x.startsWith('npc:'))).toHaveLength(NPC_IDS.length);
    for (const k of GOD_KINDS) expect(GOD_PALETTES[k]).toBeDefined();
  });

  it('每个造型都生成完整的 SVG，且彼此不同', () => {
    const seen = new Set<string>();
    for (const id of allFigureIds()) {
      const svg = anyFigureSvg(id);
      expect(svg.startsWith('<svg'), id).toBe(true);
      expect(svg.endsWith('</svg>'), id).toBe(true);
      expect(svg).not.toContain('NaN');
      expect(svg).not.toContain('undefined');
      seen.add(svg);
    }
    expect(seen.size).toBe(allFigureIds().length);
  });

  it('恶人全部姿势 × 两个朝向都能生成（行走图集用）', () => {
    for (const k of VILLAIN_KINDS) {
      for (const pose of POSES) {
        for (const facing of FACINGS) {
          const svg = figureSvg(`villain:${k}`, pose, facing);
          expect(svg).toContain('</svg>');
        }
      }
    }
  });

  it('复用 M3a 的 rig：人形造型的身体就是 characterSvg 的内容', () => {
    const cfg = figureConfig('npc:witch')!;
    const body = innerSvg(characterSvg(cfg, 'cast', 'front'));
    expect(figureSvg('npc:witch', 'cast')).toContain(body);
    expect(figureConfig('god:11')).toBeNull();
  });

  it('神明带柔光与云朵；大神比小神大', () => {
    const small = godSvg(1);
    const big = godSvg(2);
    expect(small).toContain(GOD_PALETTES[1].auraCss);
    expect(small).toMatch(/scale\(0\.72\)/);
    expect(big).toMatch(/scale\(0\.86\)/);
    // 恶犬不漂浮
    expect(godSvg(11)).not.toMatch(/scale\(0\.\d+\)/);
  });
});
