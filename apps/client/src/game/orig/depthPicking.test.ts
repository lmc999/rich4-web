// 原版深度排序与拾取（A6）：深度键 = 锚点棋盘 y × 16 + layer（原版 render.md §2.5）；
// 拾取：高层建筑先按精灵 alpha 命中，再按世界坐标找 24 px 内最近节点、32 px 内最近地块。
import { buildTestMap } from '@rich4/shared/data';
import { describe, expect, it } from 'vitest';
import { ORIG_FLYING_Z, OrigLayer, origDepth, sortByDepth } from './depth';
import { OrigProjection } from './OrigProjection';
import { LOT_PICK_RADIUS, OrigPickIndex, pickSprite, type SpriteHitBox, TILE_PICK_RADIUS } from './picking';
import { trigViews } from './testing/views';

describe('深度排序', () => {
  it('画面上越靠下越后画；同一 y 按 layer（建筑 < NPC < 玩家 < 当前玩家 < ZZZ）', () => {
    expect(origDepth(10, OrigLayer.Building)).toBeLessThan(origDepth(11, OrigLayer.Building));
    const y = 100;
    const order = [OrigLayer.Building, OrigLayer.Npc, OrigLayer.Player, OrigLayer.Current, OrigLayer.Zzz].map((l) =>
      origDepth(y, l),
    );
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // layer 最大 0xF，不会跨过下一行
    expect(origDepth(y, 0xf)).toBeLessThan(origDepth(y + 1, 0));
    expect(origDepth(1e6, OrigLayer.Zzz)).toBeLessThan(ORIG_FLYING_Z);
  });

  it('按投影后的锚点 y 排序：同一张图换视角后前后关系随之改变', () => {
    const proj = new OrigProjection(trigViews(), { w: 640, h: 640 });
    const house = { x: 320, y: 300 };
    const actor = { x: 320, y: 340 };
    const zOf = (w: { x: number; y: number }, layer: number, v: number) => origDepth(proj.projectPx(w, v).y, layer);
    // 视角 0：角色在房子「南边」→ 画面更靠下 → 后画（压在房子前面）
    expect(zOf(actor, OrigLayer.Player, 0)).toBeGreaterThan(zOf(house, OrigLayer.Building, 0));
    // 视角 4（转 180°）：南北颠倒 → 角色在房子后面
    expect(zOf(actor, OrigLayer.Player, 4)).toBeLessThan(zOf(house, OrigLayer.Building, 4));
  });

  it('sortByDepth 稳定：同键保持输入顺序', () => {
    const items = [
      { id: 'a', z: 5 },
      { id: 'b', z: 1 },
      { id: 'c', z: 5 },
      { id: 'd', z: 3 },
    ];
    expect(sortByDepth(items).map((x) => x.id)).toEqual(['b', 'd', 'a', 'c']);
  });
});

describe('拾取', () => {
  const def = buildTestMap();
  const idx = new OrigPickIndex(def);
  const t1 = def.tiles[0]!;

  it('24 世界像素内最近的节点；超出范围为 null', () => {
    expect(idx.nearestTile({ x: t1.world.x + 10, y: t1.world.y - 10 })).toBe(t1.id);
    expect(idx.nearestTile({ x: t1.world.x + TILE_PICK_RADIUS + 1, y: t1.world.y }, TILE_PICK_RADIUS)).not.toBe(t1.id);
    expect(idx.nearestTile({ x: -500, y: -500 })).toBeNull();
  });

  it('命中节点时带上它的地块引用；地块中心附近命中地块并回传第一个前沿格', () => {
    const lot = def.lots[0]!;
    const far = { x: lot.world.x, y: lot.world.y - LOT_PICK_RADIUS + 2 };
    const near = idx.nearestLot(far);
    expect(near).toBe(lot.id);
    const pick = idx.pick({ x: -1000, y: -1000 }, { x: 0, y: 0 });
    expect(pick).toBeNull();
    const onLot = idx.pick(lot.world, { x: 0, y: 0 });
    expect(onLot).not.toBeNull();
    expect(onLot!.tile).not.toBeNull();
  });

  it('建筑精灵 alpha 优先，按深度从前往后；透明像素不命中', () => {
    const box = (lot: 'L1' | 'L2', z: number, solid: (x: number, y: number) => boolean): SpriteHitBox => ({
      lot,
      x: 0,
      y: 0,
      w: 20,
      h: 30,
      z,
      hit: solid,
    });
    const back = box('L1', 10, () => true);
    const front = box('L2', 20, (x) => x >= 10);
    expect(pickSprite({ x: 15, y: 5 }, [back, front])).toBe('L2');
    expect(pickSprite({ x: 5, y: 5 }, [back, front])).toBe('L1');
    expect(pickSprite({ x: 25, y: 5 }, [back, front])).toBeNull();
    // 精灵命中压过节点
    const lot = def.lots.find((l) => l.id === 'L2')!;
    const p = idx.pick(def.tiles[0]!.world, { x: 15, y: 5 }, [back, front]);
    expect(p).toEqual({ tile: lot.frontTiles[0] ?? null, lot: 'L2' });
  });
});
