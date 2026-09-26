// 地标：医院、监狱（关押格所在建筑）与景点（台湾图 21 处）。景点按 id 选宝塔/灯塔/牌坊/纪念碑造型，
// 招牌取地图文案（MapDef.strings），过长时截断。
import type { LandmarkDef, Rect } from '@rich4/shared/data';
import type { BuildingSpec } from '../procedural/building/generate';
import { FootprintView, type ViewContext, variantOf } from './LotView';

const SIGN_MAX = 5;

export class LandmarkView extends FootprintView {
  constructor(
    ctx: ViewContext,
    readonly landmark: LandmarkDef,
  ) {
    const hold =
      landmark.holdTile !== undefined && ctx.geo.hasTile(landmark.holdTile)
        ? [ctx.geo.tileCell(landmark.holdTile)]
        : [];
    super(ctx, `M${landmark.id}`, landmark.rect, hold);
  }

  protected spec(vr: Rect, door: 'left' | 'right' | 'none'): BuildingSpec {
    const lm = this.landmark;
    let sign: string | undefined;
    if (lm.kind === 'scenery') {
      const name = this.ctx.mapString(lm.nameKey);
      sign = name ? [...name].slice(0, SIGN_MAX).join('') : '';
    } else {
      sign = this.ctx.label(`tiles:landmark.${lm.kind}`);
    }
    return {
      kind: `landmark:${lm.kind}`,
      level: 1,
      w: vr.w,
      d: vr.h,
      owner: null,
      variant: variantOf(lm.id),
      door,
      sign,
    };
  }

  protected plateStyle(): { fill: number; ring: number | null } {
    return { fill: this.landmark.kind === 'scenery' ? 0xcfe8b0 : 0xe6d3b3, ring: null };
  }
}
