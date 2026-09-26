// 设施地（通常 2×2）：未建时「招商」空地；建成后为 公园 / 旅馆 / 购物中心 / 加油站 / 研究所
import type { FacilityLot, Rect } from '@rich4/shared/data';
import type { BuildingSpec } from '../procedural/building/generate';
import { FACILITY_MAX_LEVEL, type FacilityStyle, PLAYER_COLORS } from '../procedural/building/styles';
import { FootprintView, type OwnedState, type ViewContext, variantOf } from './LotView';

export interface FacilityState extends OwnedState {
  facility: FacilityStyle;
}

export class FacilityView extends FootprintView {
  state: FacilityState = { owner: null, level: 0, facility: 'vacant' };

  constructor(
    ctx: ViewContext,
    readonly lot: FacilityLot,
  ) {
    super(
      ctx,
      lot.id,
      lot.rect,
      lot.frontTiles.map((t) => ctx.geo.tileCell(t)),
    );
  }

  setState(s: Partial<FacilityState>): void {
    const next = { ...this.state, ...s };
    // 未建设施没有等级；已建设施至少 1 级
    if (next.facility === 'vacant') next.level = 0;
    else next.level = Math.max(1, Math.min(FACILITY_MAX_LEVEL[next.facility], next.level));
    this.state = next;
    this.layout();
  }

  protected spec(vr: Rect, door: 'left' | 'right' | 'none'): BuildingSpec {
    const f = this.state.facility;
    const signKey = f === 'vacant' ? 'ui:board.forLease' : f === 'hotel' ? undefined : `tiles:facility.${f}`;
    return {
      kind: `facility:${f}`,
      level: this.state.level,
      w: vr.w,
      d: vr.h,
      owner: this.state.owner,
      variant: variantOf(this.lot.id) % 3,
      door,
      sign: signKey ? this.ctx.label(signKey) : undefined,
    };
  }

  protected plateStyle(): { fill: number; ring: number | null } {
    const ring = this.state.owner === null ? null : (PLAYER_COLORS[this.state.owner] ?? null);
    return { fill: this.state.facility === 'park' ? 0xb6e38a : 0xe9dcc0, ring };
  }
}
