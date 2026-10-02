import type { HolidayDef, MapDef, StockDef } from '@rich4/shared/data';
import { ExtractError } from '../context';
import { HOLIDAYS_PER_MAP } from './tables/holidays';
import { STOCKS_PER_MAP } from './tables/stocks';
import type { ExtractedTables, HolidayRow } from './types';

/**
 * exe 表 → MapDef 的按图数据（architecture §16.5）：该图 12 支股票与节日表。
 * - 股票名去掉排版空格（「台 積 電」→「台積電」），zh-CN 由 build 的 StringTable 经 opencc 转换；
 * - initPriceCents = f32 价格 × 100，必须是整数；volatility 取 f32 的最短十进制，volatilityF32 保留位型；
 * - 节日：空槽不输出；bit7「停用」项原版查找时直接跳过，也不输出（slot 保留原下标，所以会有空缺）；
 *   kind 2（该月第 n 个星期几）写 weekday；flagsRaw = flags0 | event << 8 | weekday << 16 仍保留星期位以兼容旧读法。
 */

export type MapStockInput = { stock: Omit<StockDef, 'nameKey'>; name: string };

export function stocksForMap(t: ExtractedTables, gm: number): MapStockInput[] {
  const rows = t.stocks.rows.filter((r) => r.mapId === gm).sort((a, b) => a.index - b.index);
  if (rows.length !== STOCKS_PER_MAP) {
    throw new ExtractError('E_EXE_STOCKS', `${t.edition} 股票表没有地图 ${gm} 的 12 支股票（找到 ${rows.length}）`);
  }
  return rows.map((r) => {
    if (!Number.isInteger(r.initPriceCents)) {
      throw new ExtractError('E_EXE_STOCKS', `股票 ${gm}/${r.index} 价格 ${r.price} 不是整数分`);
    }
    return {
      stock: {
        index: r.index,
        hasCompany: r.hasCompany !== 0,
        float: r.float,
        initPriceCents: r.initPriceCents,
        volatility: r.volatility,
        volatilityF32: r.volatilityF32,
      },
      name: r.nameNorm,
    };
  });
}

export function holidayFlagsRaw(r: HolidayRow): number {
  return (r.flags0 | (r.event << 8) | (r.weekday << 16)) >>> 0;
}

export interface MapHolidays {
  holidays: HolidayDef[];
  /** 未输出的槽（停用） */
  dropped: { slot: number; reason: 'disabled' }[];
  empty: number;
}

export function holidaysForMap(t: ExtractedTables, gm: number): MapHolidays {
  const rows = t.holidays.rows.filter((r) => r.mapId === gm).sort((a, b) => a.slot - b.slot);
  if (rows.length !== HOLIDAYS_PER_MAP) {
    throw new ExtractError('E_EXE_HOLIDAYS', `${t.edition} 节日表没有地图 ${gm} 的 24 项（找到 ${rows.length}）`);
  }
  const holidays: HolidayDef[] = [];
  const dropped: MapHolidays['dropped'] = [];
  let empty = 0;
  for (const r of rows) {
    if (r.empty) {
      empty++;
      continue;
    }
    if (r.disabled) {
      dropped.push({ slot: r.slot, reason: 'disabled' });
      continue;
    }
    holidays.push({
      slot: r.slot,
      month: r.month,
      day: r.day,
      kind: r.kind,
      ...(r.kind === 2 ? { weekday: r.weekday } : {}),
      flagsRaw: holidayFlagsRaw(r),
      closed: r.closed,
      giveCard: r.giveCard,
      bgm: r.bgmChange,
      lunar: r.lunar,
    });
  }
  return { holidays, dropped, empty };
}

export type CompanyStockStatus = 'OK' | 'KNOWN' | 'BAD';

export interface CompanyStockCheck {
  company: string;
  stockIndex: number;
  /** OK 一致；KNOWN 命中原版已知名称不一致白名单（不改原版数据，data-pipeline §7）；BAD 失败 */
  status: CompanyStockStatus;
  /** status !== 'BAD'（只有 BAD 让 map build 失败） */
  ok: boolean;
  detail: string;
}

/** 原版企业名与股票名不一致、但确属原版文案的已知项（按 globalMapId + 企业号 + 两个名称精确匹配）。 */
export interface KnownNameMismatch {
  globalMapId: number;
  company: string;
  stockIndex: number;
  companyName: string;
  stockName: string;
  evidence: string;
}

export const KNOWN_NAME_MISMATCHES: readonly KnownNameMismatch[] = [
  {
    globalMapId: 1,
    company: 'C4',
    stockIndex: 2,
    companyName: '王井府百貨',
    stockName: '王府井百貨',
    evidence:
      '@source MapDat.MKF#1 与 v3.11 map.mkf#1 的 companies#4 都是「王井府百貨」（v2.06 map.mkf#1 为「玉井府百貨」），' +
      'rich4.exe v2.06 股票模板表 0x47ce92 + 432（gm 1）下标 2 为「王府井百貨」；原版笔误，照原样保留',
  },
];

function knownMismatch(gm: number | null, company: string, stockIndex: number, cn: string, sn: string) {
  return KNOWN_NAME_MISMATCHES.find(
    (k) =>
      k.globalMapId === gm &&
      k.company === company &&
      k.stockIndex === stockIndex &&
      k.companyName === cn &&
      k.stockName === sn,
  );
}

/**
 * 企业 +0x19 股票行号 ↔ exe 股票模板（V-M3）：被引用的股票必须 hasCompany，且与企业同名；
 * hasCompany 的股票数应等于企业数。名称不一致但在 KNOWN_NAME_MISMATCHES 里的记为 KNOWN（不算失败）。
 */
export function companyStockChecks(def: MapDef): CompanyStockCheck[] {
  const tw = def.strings['zh-TW'];
  const out: CompanyStockCheck[] = def.companies.map((c) => {
    const s = def.stocks.find((x) => x.index === c.stockIndex);
    const cn = tw[c.nameKey] ?? '';
    const sn = s ? (tw[s.nameKey] ?? '') : '';
    let status: CompanyStockStatus = s?.hasCompany === true && cn === sn ? 'OK' : 'BAD';
    let note = '';
    if (status === 'BAD' && s?.hasCompany === true && knownMismatch(def.globalMapId, c.id, c.stockIndex, cn, sn)) {
      status = 'KNOWN';
      note = '（原版名称不一致，已登记，照原样保留）';
    }
    return {
      company: c.id,
      stockIndex: c.stockIndex,
      status,
      ok: status !== 'BAD',
      detail: s
        ? `「${cn}」→ 股票 ${c.stockIndex}「${sn}」hasCompany=${s.hasCompany}${note}`
        : `股票 ${c.stockIndex} 不存在`,
    };
  });
  const listed = def.stocks.filter((s) => s.hasCompany).length;
  const countOk = listed === def.companies.length;
  out.push({
    company: '*',
    stockIndex: -1,
    status: countOk ? 'OK' : 'BAD',
    ok: countOk,
    detail: `hasCompany 的股票 ${listed} 支，企业 ${def.companies.length} 家`,
  });
  return out;
}
