// 企业：按行业选造型（银行 / 百货 / 写字楼…），招牌显示行业名（i18n tiles.industry.*）
import type { CompanyDef, Rect } from '@rich4/shared/data';
import type { BuildingSpec } from '../procedural/building/generate';
import { INDUSTRY_LOOKS, PLAYER_COLORS } from '../procedural/building/styles';
import { FootprintView, type ViewContext, variantOf } from './LotView';

export class CompanyView extends FootprintView {
  /** 董事长座位（股权最多者；M4 接入后由视图驱动） */
  chairman: number | null = null;

  constructor(
    ctx: ViewContext,
    readonly company: CompanyDef,
  ) {
    super(
      ctx,
      company.id,
      company.rect,
      company.frontTiles.map((t) => ctx.geo.tileCell(t)),
    );
  }

  setChairman(seat: number | null): void {
    this.chairman = seat;
    this.layout();
  }

  protected spec(vr: Rect, door: 'left' | 'right' | 'none'): BuildingSpec {
    const look = INDUSTRY_LOOKS[this.company.industryKey];
    return {
      kind: `landmark:${look.style}`,
      level: 1,
      w: vr.w,
      d: vr.h,
      owner: this.chairman,
      variant: variantOf(this.company.id) % 4,
      door,
      accent: look.accent,
      sign: this.ctx.label(`tiles:industry.${this.company.industryKey}`) ?? look.sign,
    };
  }

  protected plateStyle(): { fill: number; ring: number | null } {
    return { fill: 0xe6d3b3, ring: this.chairman === null ? null : (PLAYER_COLORS[this.chairman] ?? null) };
  }
}
