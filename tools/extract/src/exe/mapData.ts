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
 *   flagsRaw = flags0 | event << 8 | weekday << 16（HolidayDef 没有星期字段，kind 2 的星期放在 16..23 位）。
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
      flagsRaw: holidayFlagsRaw(r),
      closed: r.closed,
      giveCard: r.giveCard,
      bgm: r.bgmChange,
      lunar: r.lunar,
    });
  }
  return { holidays, dropped, empty };
}

export interface CompanyStockCheck {
  company: string;
  stockIndex: number;
  ok: boolean;
  detail: string;
}

/**
 * 企业 +0x19 股票行号 ↔ exe 股票模板（V-M3）：被引用的股票必须 hasCompany，且与企业同名；
 * hasCompany 的股票数应等于企业数。
 */
export function companyStockChecks(def: MapDef): CompanyStockCheck[] {
  const tw = def.strings['zh-TW'];
  const out: CompanyStockCheck[] = def.companies.map((c) => {
    const s = def.stocks.find((x) => x.index === c.stockIndex);
    const cn = tw[c.nameKey] ?? '';
    const sn = s ? (tw[s.nameKey] ?? '') : '';
    const ok = s?.hasCompany === true && cn === sn;
    return {
      company: c.id,
      stockIndex: c.stockIndex,
      ok,
      detail: s ? `「${cn}」→ 股票 ${c.stockIndex}「${sn}」hasCompany=${s.hasCompany}` : `股票 ${c.stockIndex} 不存在`,
    };
  });
  const listed = def.stocks.filter((s) => s.hasCompany).length;
  out.push({
    company: '*',
    stockIndex: -1,
    ok: listed === def.companies.length,
    detail: `hasCompany 的股票 ${listed} 支，企业 ${def.companies.length} 家`,
  });
  return out;
}
