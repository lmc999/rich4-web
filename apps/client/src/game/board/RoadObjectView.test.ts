// RoadObjectView（node，不渲染）：按显示态键控增删路面物件、路上神明、乞丐与四大恶人；演出取走 / 加入后 sync 不重复创建。
import { buildTestMapAllKinds } from '@rich4/shared/data';
import type { GodSlot, RoadObject, VillainState } from '@rich4/shared/engine';
import { Container } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { AnimClock } from '../anim/AnimClock';
import { DepthBias, depthOfCell } from '../iso/depth';
import { BoardGeometry } from './BoardGeometry';
import { godKey, RoadObjectView, type RoadWorld } from './RoadObjectView';

const def = buildTestMapAllKinds();

function setup() {
  const layer = new Container({ sortableChildren: true });
  const clock = new AnimClock();
  const view = new RoadObjectView(layer, clock, { rasterize: false });
  const geo = new BoardGeometry(def, 0);
  view.attach(geo);
  return { layer, clock, view, geo };
}

const obj = (id: number, kind: RoadObject['kind'], node: number): RoadObject => ({ id, kind, node, placedBy: 0 });
const road = (slot: number, kind: GodSlot['kind'], node: number): GodSlot => ({
  slot,
  kind,
  where: { t: 'road', node },
});
const villain = (kind: VillainState['kind'], onBoard: boolean, node: number): VillainState => ({
  kind,
  home: kind === 'thief' || kind === 'robber' ? 'jail' : 'hospital',
  onBoard,
  node,
  prevNode: node,
  homeNode: 14,
  leftHome: onBoard,
  employer: null,
  st: { jail: 0, hospital: 0, hibernate: 0, sleepwalk: 0, stay: 0, tortoise: 0 },
});

const world = (w: Partial<RoadWorld>): RoadWorld => ({ objects: [], gods: [], beggars: [], villains: [], ...w });

describe('RoadObjectView.sync', () => {
  it('物件按 id 增删，位置与深度落在格上', () => {
    const { view, layer, geo } = setup();
    view.sync(world({ objects: [obj(1, 'roadblock', 5), obj(2, 'mine', 6), obj(3, 'bomb', 7)] }));
    expect(view.counts().objects).toBe(3);
    const mine = view.objectView(2)!;
    const p = geo.tileScreenPos(6);
    expect(mine.position.x).toBeCloseTo(p.x);
    expect(mine.position.y).toBeCloseTo(p.y);
    expect(mine.zIndex).toBeCloseTo(depthOfCell(geo.viewCell(geo.tileCell(6)), DepthBias.RoadObject));
    expect(layer.children).toContain(mine);
    // 删一个、加一个、改一个的位置
    view.sync(world({ objects: [obj(1, 'roadblock', 5), obj(3, 'bomb', 8), obj(4, 'gift', 9)] }));
    expect(view.objectView(2)).toBeUndefined();
    expect(mine.destroyed).toBe(true);
    expect(view.objectOf(3)?.node).toBe(8);
    expect(view.objectOf(4)?.kind).toBe('gift');
    expect(view.counts().objects).toBe(3);
    view.sync(world({}));
    expect(view.counts().objects).toBe(0);
  });

  it('未知格上的物件忽略', () => {
    const { view } = setup();
    view.sync(world({ objects: [obj(1, 'chest', 999)] }));
    expect(view.counts().objects).toBe(0);
  });

  it('路上神明按「种类@节点」增删；附身与缺席的不画', () => {
    const { view } = setup();
    view.sync(
      world({
        gods: [
          road(1, 1, 5),
          road(2, 11, 6),
          { slot: 3, kind: 2, where: { t: 'attached', seat: 0 } },
          { slot: 4, kind: 3, where: { t: 'absent' } },
        ],
      }),
    );
    expect(view.counts().gods).toBe(2);
    view.sync(world({ gods: [road(1, 1, 9), road(2, 11, 6)] }));
    expect(view.counts().gods).toBe(2);
    // 演出取走一个后，sync 看到它已不在路上就不会重建
    const g = view.detachGod(11, 6);
    expect(g?.kind).toBe(11);
    g?.destroy();
    view.sync(world({ gods: [road(1, 1, 9)] }));
    expect(view.counts().gods).toBe(1);
    expect(godKey(1, 9)).toBe('1@9');
  });

  it('乞丐按座位增删并跟随节点；挪窝返回起止位置', () => {
    const { view, geo } = setup();
    view.sync(world({ beggars: [{ seat: 2, node: 5 }] }));
    expect(view.counts().beggars).toBe(1);
    const m = view.moveBeggar(2, 9)!;
    expect(m.to).toEqual(geo.tileScreenPos(9));
    m.settle();
    expect(view.beggarView(2)!.position.x).toBeCloseTo(geo.tileScreenPos(9).x);
    view.sync(world({ beggars: [] }));
    expect(view.counts().beggars).toBe(0);
  });

  it('恶人在棋盘上时显示在所在节点，回家后隐藏', () => {
    const { view } = setup();
    view.sync(world({ villains: [villain('thief', true, 5), villain('spy', false, 0)] }));
    expect(view.counts().villains).toBe(1);
    expect(view.villain('thief')?.tile).toBe(5);
    expect(view.villainNode('thief')).toBe(5);
    view.sync(world({ villains: [villain('thief', true, 7)] }));
    expect(view.villain('thief')?.tile).toBe(7);
    view.sync(world({ villains: [villain('thief', false, 0)] }));
    expect(view.counts().villains).toBe(0);
    expect(view.villainNode('thief')).toBeNull();
  });

  it('演出先 add / detach，随后的 sync 保持一致（不重复创建、不误删）', () => {
    const { view } = setup();
    const o = obj(7, 'mine', 6);
    const root = view.addObject(o)!;
    view.sync(world({ objects: [o] }));
    expect(view.objectView(7)).toBe(root);
    const taken = view.detachObject(7)!;
    expect(taken).toBe(root);
    view.sync(world({ objects: [] }));
    expect(taken.destroyed).toBe(false);
    taken.destroy();
  });

  it('旋转后重新布局；卸载清空', () => {
    const { view, geo } = setup();
    view.sync(world({ objects: [obj(1, 'roadblock', 5)], beggars: [{ seat: 1, node: 9 }] }));
    geo.setRotation(1);
    view.layout();
    expect(view.objectView(1)!.position.x).toBeCloseTo(geo.tileScreenPos(5).x);
    view.clear();
    expect(view.counts()).toEqual({ objects: 0, gods: 0, beggars: 0, villains: 0 });
    expect(view.attached).toBe(false);
    view.destroy();
  });
});
