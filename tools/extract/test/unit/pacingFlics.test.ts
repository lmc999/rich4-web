/**
 * 演出节奏 original（original-skin.md U3、§3 修正 1）：shared/view/pacing 里按原版 FLIC 原长放宽预算用的时长常量，
 * 必须与 A3 的 flic-map 源数据（data/flic.ts，build 时按源文件头核对）逐项一致——mkf、资源号、用途键、帧数、帧间隔。
 */
import { type FlicTiming, GOD_ARRIVAL_FLICS, ORIGINAL_FLICS, PARACHUTE_FLICS } from '@rich4/shared/view';
import { describe, expect, it } from 'vitest';
import { FLIC_DEFS } from '../../src/assets/data/flic';

function defOf(f: FlicTiming) {
  const d = FLIC_DEFS.find((x) => x.mkf === f.mkf && x.res === f.res);
  if (!d) throw new Error(`flic-map 没有 ${f.mkf}#${f.res}`);
  return d;
}

describe('pacing 的 FLIC 时长常量 = A3 flic-map 源数据', () => {
  it('事件用到的 FLIC：mkf / 资源号 / 用途 / 帧数 / 帧间隔一致', () => {
    for (const [name, f] of Object.entries(ORIGINAL_FLICS)) {
      const d = defOf(f);
      expect({ use: f.use, frames: f.frames, frameMs: f.frameMs }, name).toEqual({
        use: d.use,
        frames: d.frames,
        frameMs: d.frameMs,
      });
    }
  });

  it('神明降临按 GodKind、棋盘跳伞按角色号', () => {
    for (const [kind, f] of Object.entries(GOD_ARRIVAL_FLICS)) {
      const d = defOf(f!);
      expect(d.use).toBe('god.arrive');
      expect(d.god, `god ${kind}`).toBe(Number(kind));
      expect([f!.frames, f!.frameMs]).toEqual([d.frames, d.frameMs]);
    }
    const gods = FLIC_DEFS.filter((d) => d.use === 'god.arrive').map((d) => d.god);
    expect(
      Object.keys(GOD_ARRIVAL_FLICS)
        .map(Number)
        .sort((x, y) => x - y),
    ).toEqual([...gods].sort((x, y) => (x ?? 0) - (y ?? 0)));
    expect(PARACHUTE_FLICS).toHaveLength(12);
    PARACHUTE_FLICS.forEach((f, c) => {
      const d = defOf(f);
      expect(d.use).toBe('char.parachuteBoard');
      expect(d.char).toBe(c);
      expect([f.frames, f.frameMs]).toEqual([d.frames, d.frameMs]);
    });
  });
});
