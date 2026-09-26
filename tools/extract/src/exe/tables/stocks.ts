import { f32BitsHex, f32FromBits, f32Shortest } from '../../bin/f32';
import { hexVa, normalizeText, type PeFile } from '../../pe/scan';
import type { Check, LocateContext, StockRow } from '../types';
import { chk, hintOf, namePtr, pointerPairSignature, recordHex, type TableSpec } from './common';

/**
 * 股票模板表（v2.06 VA 0x47ce92、v3.11 VA 0x47f072），每图 12 支、每项 36 字节：
 * +0x00 u32 名称指针、+0x04 u16 有对应企业、+0x06 u16、+0x08 u16 流通股、+0x0a u16、
 * +0x0c/+0x10/+0x14 f32 价格（模板中三者相等）、+0x18 f32 波动系数、+0x1c..+0x23 为 0。
 * 表尾紧接卡片表；项数 = 12 × 地图数。
 * @source oama packages/data/src/stocks.ts；nurockplayer parse_stock_groups；docs/research/g_map.md
 */

export const STOCKS_PER_MAP = 12;
export const STOCK_STRIDE = 36;
/** 最多扫描的地图数（防御性上限） */
const MAX_MAPS = 16;

export function parseStock(file: PeFile, at: number, i: number): StockRow {
  const name = namePtr(file, at) ?? '';
  const priceBits = file.u32(at + 0x0c);
  const price = f32FromBits(priceBits);
  const volBits = file.u32(at + 0x18);
  const tail = file.slice(at + 0x1c, 8);
  return {
    mapId: Math.floor(i / STOCKS_PER_MAP),
    index: i % STOCKS_PER_MAP,
    name,
    nameNorm: normalizeText(name),
    hasCompany: file.u16(at + 4),
    u6: file.u16(at + 6),
    float: file.u16(at + 8),
    u10: file.u16(at + 10),
    priceF32: f32BitsHex(priceBits),
    pricesEqual: file.u32(at + 0x10) === priceBits && file.u32(at + 0x14) === priceBits,
    price,
    initPriceCents: price * 100,
    volatilityF32: f32BitsHex(volBits),
    volatility: f32Shortest(volBits),
    tailZero: tail.every((b) => b === 0),
    hex: recordHex(file, at, STOCK_STRIDE),
  };
}

/** 单项是否像股票模板（用于数出项数） */
export function plausibleStock(file: PeFile, at: number): boolean {
  if (file.tryVaToOff(at) === null || file.tryVaToOff(at + STOCK_STRIDE - 1) === null) return false;
  const r = parseStock(file, at, 0);
  return (
    r.name !== '' &&
    r.hasCompany <= 1 &&
    r.float <= 10000 &&
    r.pricesEqual &&
    Number.isFinite(r.price) &&
    r.price > 0 &&
    Number.isFinite(r.volatility) &&
    r.volatility > 0 &&
    r.tailZero
  );
}

export function countStocks(file: PeFile, va: number): number {
  let n = 0;
  while (n < STOCKS_PER_MAP * MAX_MAPS && plausibleStock(file, va + n * STOCK_STRIDE)) n++;
  return n;
}

export function parseStocks(file: PeFile, va: number): { maps: number; rows: StockRow[] } {
  const n = countStocks(file, va);
  const maps = Math.floor(n / STOCKS_PER_MAP);
  const rows: StockRow[] = [];
  for (let i = 0; i < maps * STOCKS_PER_MAP; i++) rows.push(parseStock(file, va + i * STOCK_STRIDE, i));
  return { maps, rows };
}

export function validateStocks(file: PeFile, va: number, names: readonly string[]): Check[] {
  const n = countStocks(file, va);
  if (n === 0) return [chk('stocks.first', 'error', false, `${hexVa(va)} 处不像股票模板`)];
  const out: Check[] = [];
  const r0 = parseStock(file, va, 0);
  const r1 = n > 1 ? parseStock(file, va + STOCK_STRIDE, 1) : null;
  out.push(
    chk(
      'stocks.signature',
      'error',
      r0.nameNorm === normalizeText(names[0]!) && r1?.nameNorm === normalizeText(names[1]!),
      `前两项「${r0.name}」「${r1?.name ?? ''}」`,
    ),
  );
  out.push(
    chk(
      'stocks.count',
      'error',
      n % STOCKS_PER_MAP === 0 && n >= STOCKS_PER_MAP,
      `连续合法项 ${n}（${n / STOCKS_PER_MAP} 张图 × 12）`,
    ),
  );
  const rows = parseStocks(file, va).rows;
  const nonInt = rows.filter((r) => !Number.isInteger(r.initPriceCents));
  out.push(
    chk(
      'stocks.priceCents',
      'error',
      nonInt.length === 0,
      nonInt.length === 0
        ? '全部价格 ×100 为整数（整数分）'
        : `价格不是整数分：${nonInt.map((r) => `${r.mapId}/${r.index}`).join(',')}`,
    ),
  );
  return out;
}

export const stocksSpec: TableSpec<{ maps: number; rows: StockRow[] }> = {
  id: 'stocks',
  xrefSpan: STOCK_STRIDE,
  hint: (ctx) => hintOf(ctx, ctx.anchors.tables.stocks.hint),
  signature: (ctx) => pointerPairSignature(ctx, ctx.anchors.tables.stocks.names, STOCK_STRIDE),
  validate: (file, va, ctx) => validateStocks(file, va, ctx.anchors.tables.stocks.names),
  parse: (file, va) => parseStocks(file, va),
  byteLength: (ctx: LocateContext) => (ctx.maps ?? 0) * STOCKS_PER_MAP * STOCK_STRIDE,
};
