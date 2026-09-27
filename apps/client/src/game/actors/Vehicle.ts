// 交通工具外观（design/client.md §3.6「有交通工具：机车或汽车精灵垫在角色脚下，行走时有排气粒子」）：
// 机车、汽车、工程车用 Graphics 自绘（玩家色车身），挂在角色身体之下；另有救护车 / 警车（接走演出用）。
import type { Vehicle } from '@rich4/shared/engine';
import { Container, Graphics } from 'pixi.js';
import { INK } from '../procedural/building/styles';

/** 角色骑乘时身体抬高的像素 */
export const RIDE_LIFT: Readonly<Record<Vehicle, number>> = { walk: 0, moto: 8, car: 12, engineer: 16 };

function wheel(g: Graphics, x: number, y: number, r: number): void {
  g.circle(x, y, r).fill(0x2a2a2a).stroke({ width: 2.5, color: INK });
  g.circle(x, y, r * 0.4).fill(0xbfc5cf);
}

/** 骑乘的车（原点在角色脚下；车身朝向由父容器镜像） */
export function vehicleGraphics(v: Vehicle, color: number): Container {
  const c = new Container({ label: `vehicle:${v}` });
  const g = new Graphics();
  switch (v) {
    case 'walk':
      break;
    case 'moto':
      wheel(g, -18, 2, 8);
      wheel(g, 18, 2, 8);
      g.roundRect(-20, -10, 40, 10, 5).fill(color).stroke({ width: 3, color: INK });
      g.poly([14, -10, 24, -22, 28, -20, 20, -8], true).fill(0x5a5a5a).stroke({ width: 2, color: INK });
      g.roundRect(-22, -4, 10, 5, 2).fill(0xbfc5cf).stroke({ width: 2, color: INK });
      break;
    case 'car':
      wheel(g, -20, 4, 9);
      wheel(g, 20, 4, 9);
      g.roundRect(-32, -14, 64, 16, 6).fill(color).stroke({ width: 3, color: INK });
      g.roundRect(-18, -26, 34, 14, 6).fill(color).stroke({ width: 3, color: INK });
      g.roundRect(-14, -23, 12, 9, 2).fill(0xbfe8ff);
      g.roundRect(2, -23, 11, 9, 2).fill(0xbfe8ff);
      g.circle(29, -7, 3).fill(0xfff3b0);
      break;
    case 'engineer':
      // 工程车：黄色车身 + 铲斗 + 履带
      g.roundRect(-30, -6, 60, 14, 7).fill(0x3a3a3a).stroke({ width: 3, color: INK });
      for (const x of [-20, -7, 7, 20]) g.circle(x, 1, 4).fill(0x8a8f99);
      g.roundRect(-24, -26, 40, 20, 4).fill(0xf2b705).stroke({ width: 3, color: INK });
      g.roundRect(-18, -38, 20, 14, 3).fill(0xf2b705).stroke({ width: 3, color: INK });
      g.rect(-15, -35, 14, 8).fill(0xbfe8ff);
      g.poly([16, -20, 36, -30, 42, -4, 26, 0], true).fill(0x8a8f99).stroke({ width: 3, color: INK, join: 'round' });
      break;
  }
  c.addChild(g);
  return c;
}

/** 救护车（白底红十字）/ 警车（黑白 + 警灯）；返回车身与警灯（闪烁由调用方驱动） */
export function escortVehicle(kind: 'ambulance' | 'police'): { root: Container; lights: Graphics[] } {
  const root = new Container({ label: kind });
  const g = new Graphics();
  const body = kind === 'ambulance' ? 0xffffff : 0x2a2a3a;
  wheel(g, -24, 6, 10);
  wheel(g, 24, 6, 10);
  g.roundRect(-40, -22, 80, 26, 7).fill(body).stroke({ width: 3, color: INK });
  g.roundRect(-8, -38, 44, 18, 6).fill(body).stroke({ width: 3, color: INK });
  g.roundRect(12, -34, 18, 11, 2).fill(0xbfe8ff);
  if (kind === 'ambulance') {
    g.rect(-30, -16, 6, 16).fill(0xe8453c);
    g.rect(-35, -11, 16, 6).fill(0xe8453c);
  } else {
    g.rect(-38, -12, 76, 7).fill(0xffffff);
  }
  const red = new Graphics().roundRect(-2, -46, 8, 7, 2).fill(0xf2545b).stroke({ width: 2, color: INK });
  const blue = new Graphics()
    .roundRect(8, -46, 8, 7, 2)
    .fill(kind === 'police' ? 0x3d8bfd : 0xf2545b)
    .stroke({
      width: 2,
      color: INK,
    });
  root.addChild(g, red, blue);
  return { root, lights: [red, blue] };
}
