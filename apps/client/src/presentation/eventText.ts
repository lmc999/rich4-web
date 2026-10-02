// 新闻、命运、魔法屋、恶人的文案参数（日志行与演出弹窗共用；M7 真实引擎载荷对齐）：
// - 新闻：引擎 NEWS.params 只给 id / 数值（lot / company → 地块 id，stock → 股票下标，seat → 座位，
//   amount / fine / gain / loss → 元，days / pct → 数字），这里解析成名字与千分位金额；缺失的常用键给中性默认值，
//   模板里不会残留 {{…}}。
// - 命运：FATE 事件只带 {seat, id, amount, blessing}；天数、百分比、金额的含义（补偿 / 罚金 / 贷款 / 点券）
//   与加持类别读 shared 的命运表（data/tables/fate.ts，与引擎同一份），不在客户端另记一份。
import {
  type BlessingClass,
  type FateEffect,
  fateDef,
  MAGIC_EFFECTS,
  type NewsCategory,
  newsDef,
} from '@rich4/shared/data';
import type {
  BlessingResult,
  EventParams,
  FateId,
  LotId,
  MagicEffectId,
  NewsId,
  SeatIndex,
  TileId,
  VillainActionKind,
} from '@rich4/shared/engine';
import type { NameKit } from './names';

// ───────────────────────── 新闻 ─────────────────────────

/** 新闻分类（exe newsCategories：0 奇闻、1 政府公告、2 社会、3 路况、4 气象、5 财经），读 shared 新闻表 */
export function newsCategory(id: NewsId): NewsCategory {
  return newsDef(id).category;
}

/**
 * 文案插值参数：lot / company → 地块名，stock → 股票名，seat / who → 人名（统一写到 who），tile / node → 格名（写到 tile），
 * amount / price / fine / reward / subsidy / loan / gain / loss → 千分位金额；其余原样。
 */
export function eventTextParams(n: NameKit, params: EventParams | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {
    lot: n.t('events:param.lot'),
    company: n.t('events:param.company'),
    stock: n.t('events:param.stock'),
    who: n.t('events:param.who'),
    tile: n.t('events:param.tile', { defaultValue: n.t('events:param.lot') }),
    days: n.t('events:param.days'),
    amount: n.t('events:param.amount'),
    fine: n.t('events:param.amount'),
    gain: n.t('events:param.amount'),
    loss: n.t('events:param.amount'),
    pct: n.t('events:param.pct'),
  };
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === null) continue;
    switch (k) {
      case 'lot':
      case 'company':
        out[k] = typeof v === 'string' ? n.lot(v as LotId) : v;
        break;
      case 'stock':
        out[k] = typeof v === 'number' ? n.stock(v) : v;
        break;
      case 'seat':
      case 'who':
        out.who = typeof v === 'number' ? n.seat(v as SeatIndex) : v;
        break;
      case 'tile':
      case 'node':
        out.tile = typeof v === 'number' ? n.tile(v as TileId) : v;
        break;
      case 'amount':
      case 'price':
      case 'fine':
      case 'reward':
      case 'subsidy':
      case 'loan':
      case 'gain':
      case 'loss':
        out[k] = typeof v === 'number' ? n.money(v) : v;
        break;
      default:
        out[k] = v;
    }
  }
  return out;
}

export function newsHeadline(n: NameKit, id: NewsId, params: EventParams | null | undefined): string {
  return n.t(`news:${id}.headline`, { ...eventTextParams(n, params), defaultValue: n.t('events:show.news') });
}

export function newsBody(n: NameKit, id: NewsId, params: EventParams | null | undefined): string {
  return n.t(`news:${id}.body`, { ...eventTextParams(n, params), defaultValue: '' });
}

// ───────────────────────── 命运 ─────────────────────────

/** 命运金额的含义：补偿 / 奖金（收入）、罚金 / 被收回的股票市值（支出）、被冒用的贷款、卖股所得（进存款）、折成的点券 */
export type FateAmountKind = 'gain' | 'loss' | 'loan' | 'deposit' | 'points';

const AMOUNT_KIND: Readonly<Record<FateEffect, FateAmountKind | null>> = {
  demolishOwn: 'gain',
  expropriate: 'gain',
  fakeLoan: 'loan',
  bankRefuse: null,
  embezzle: null,
  birthday: null,
  abroad: null,
  stockDefault: 'loss',
  sellAllStocks: 'deposit',
  loseVehicle: null,
  ditch: null,
  fine: 'loss',
  reward: 'gain',
  sellAllCardsTools: 'points',
  jail: null,
};

const TONE: Readonly<Record<FateEffect, FateTone>> = {
  demolishOwn: 'bad',
  expropriate: 'neutral',
  fakeLoan: 'bad',
  bankRefuse: 'bad',
  embezzle: 'good',
  birthday: 'good',
  abroad: 'bad',
  stockDefault: 'bad',
  sellAllStocks: 'neutral',
  loseVehicle: 'bad',
  ditch: 'bad',
  fine: 'bad',
  reward: 'good',
  sellAllCardsTools: 'neutral',
  jail: 'bad',
};

export type FateTone = 'good' | 'bad' | 'neutral';

/** 第 33 条起的命运（4 条坐牢）在原版按当前地图换处理函数、标题、语音与插图 */
export const FATE_BY_MAP_FROM = 33;
const FATE_BY_MAP_TO = 36;

/**
 * 命运在原版处理函数表里的下标：第 33–36 条在大陆 / 日本 / 美国图（gm 1–3）换成表项 k + 4·gm（37–48），其余为 k。
 * 同一下标也用于标题（exe 字符串 0x463cfb–0x463e07）、语音（fate.<下标> = voice 0222–0233）与插图表 0x473dd8。
 * 天数与效果不变（引擎 FATE 事件照旧给 id 33–36）。
 * @source exe v2.06 0x44c537–0x44c5c7、0x44c686–0x44c6a0：k ≥ 0x21 时 call [0x473d14 + 16·gm + 4k]，插图 [0x473dd8 + 8·gm + 2k]
 */
export function fateVariantSlot(id: FateId, globalMapId: number | null | undefined): number {
  const gm = globalMapId ?? 0;
  if (id < FATE_BY_MAP_FROM || id > FATE_BY_MAP_TO || !Number.isInteger(gm) || gm < 1 || gm > 3) return id;
  return id + 4 * gm;
}

/** 命运文案的键前缀：按图变体为 fate:<id>.byMap.<gm>，其余为 fate:<id> */
function fateKeyBase(n: NameKit, id: FateId): { base: string; variant: string | null } {
  const gm = n.globalMapId?.() ?? null;
  const variant = fateVariantSlot(id, gm) !== id ? `fate:${id}.byMap.${gm}` : null;
  return { base: `fate:${id}`, variant };
}

export interface FateShown {
  tone: FateTone;
  /** 加持类别（null：这张命运不查加持） */
  category: BlessingClass | null;
  /** 文案参数：who / amount / days / pct（已格式化） */
  params: Record<string, unknown>;
  /** 正文（按当前地图选变体，缺变体时回退通用文案；都没有为空串） */
  text: string;
  /** 金额行（没有金额时 null）与颜色 */
  amountText: string | null;
  amountTone: 'gain' | 'loss' | 'neutral';
}

/**
 * 一张命运的显示信息。blessing：FATE 事件的加持结果（引擎对只处理「免付 / 逃过」的命运已把 low 归为 none）：
 * 罚金、劫难类 high 为免付 / 逃过（改为中性色调），奖金类 low 为作废；劫难类 low 天数 ×2。
 */
export function fateShown(
  n: NameKit,
  e: { seat: SeatIndex; id: FateId; amount: number | null; blessing: BlessingResult | null },
): FateShown {
  const def = fateDef(e.id);
  const category = def.blessing?.category ?? null;
  const b = e.blessing ?? 'none';
  const escaped = b === 'high' && (category === 'penalty' || category === 'misfortune');
  const voided = b === 'low' && category === 'reward';
  const baseDays = def.params.days;
  const days = baseDays === undefined ? null : b === 'low' && def.blessing?.handlesDouble ? baseDays * 2 : baseDays;
  const params: Record<string, unknown> = {
    who: n.seat(e.seat),
    amount: e.amount === null ? n.t('events:param.amount') : n.money(e.amount),
    days: days ?? n.t('events:param.days'),
    pct: def.params.pct ?? n.t('events:param.pct'),
  };
  const kind = AMOUNT_KIND[def.effect];
  let amountText: string | null = null;
  let amountTone: FateShown['amountTone'] = 'neutral';
  if (kind !== null && e.amount !== null && e.amount > 0) {
    const m = n.money(e.amount);
    if (escaped) amountText = n.t('events:fateAmount.waived', { amount: m });
    else if (voided) amountText = n.t('events:fateAmount.voided', { amount: m });
    else {
      amountText = n.t(`events:fateAmount.${kind}`, { amount: m });
      amountTone = kind === 'loss' || kind === 'loan' ? 'loss' : kind === 'gain' ? 'gain' : 'neutral';
    }
  }
  let tone = TONE[def.effect];
  if (escaped) tone = 'neutral';
  if (voided) tone = 'neutral';
  const k = fateKeyBase(n, e.id);
  const common = n.t(`${k.base}.text`, { ...params, defaultValue: '' });
  const text = k.variant ? n.t(`${k.variant}.text`, { ...params, defaultValue: common }) : common;
  return { tone, category, params, text, amountText, amountTone };
}

/** 命运标题（按当前地图选变体，缺变体时回退通用标题，再缺时为「命运 #n」） */
export function fateTitle(n: NameKit, id: FateId): string {
  const k = fateKeyBase(n, id);
  const common = n.t(`${k.base}.title`, { defaultValue: n.t('events:popup.fateNo', { n: id + 1 }) });
  return k.variant ? n.t(`${k.variant}.title`, { defaultValue: common }) : common;
}

// ───────────────────────── 魔法屋、恶人 ─────────────────────────

export function magicEffectName(n: NameKit, effect: MagicEffectId): string {
  return n.t(`magic:effect.${effect}.name`, { defaultValue: MAGIC_EFFECTS[effect]?.key ?? String(effect) });
}

/** 恶人作案一句话（日志与 toast 共用）：robDeposit 抢的是全场非雇主的存款，没有单一受害人 */
export function villainActionText(
  n: NameKit,
  e: { kind: Parameters<NameKit['villain']>[0]; victim: SeatIndex | null; what: VillainActionKind; amount: number },
): string {
  return n.t(`events:villainAction.${e.what}`, {
    villain: n.villain(e.kind),
    who: n.seat(e.victim),
    amount: n.money(e.amount),
  });
}
