import { hexVa, type PeFile } from '../../pe/scan';
import type { Check, HolidayCode, HolidayRow, LocateContext } from '../types';
import { chk, hintOf, recordHex, type TableSpec } from './common';
import { TOOL_COUNT, TOOL_STRIDE } from './tools';

/**
 * 节日表（紧随道具表，v3.11 VA 0x47ff4a），每图 24 项 × 12 字节，按全局地图号 gm 分块（gm × 0x120）。
 * 布局由 v3.11 代码反推（查找 0x4521f0、休市 0x4523d5、当日事件 0x452444）：
 *   +0 u8  flags0：非 0 即休市（bit0）；bit7 = 停用，查找时跳过该项继续找
 *   +1 u8  kind：0 公历 (月,日)；1 农历 (月,日)（查 exe 内 1998 起的农历表）；2 该月第 n 个星期 w
 *   +2 u8  月；+3 u8 日（kind 2 为 n）；+4 u8 星期 w（kind 2，0 = 星期日；「第 n 个」超出当月则不命中）
 *   +5 u8  事件位：bit0 显示图片（+6 u16 资源号、+8 u16 参数）；bit2 换 BGM（+10 u16 曲号）；
 *          bit3 每位在场玩家发 1 张卡；bit1 在代码中未被引用
 * 查找时逐项比较，命中第一项即返回；农历项会把「当日日期」替换为农历日期后再比较后续项（原版写法）。
 */

export const HOLIDAYS_PER_MAP = 24;
export const HOLIDAY_STRIDE = 12;

export const HOLIDAY_KIND = { solar: 0, lunar: 1, nthWeekday: 2 } as const;

export function parseHoliday(file: PeFile, at: number, mapId: number, slot: number): HolidayRow {
  const b = file.slice(at, HOLIDAY_STRIDE);
  const flags0 = b[0]!;
  const kind = b[1]!;
  const event = b[5]!;
  return {
    mapId,
    slot,
    empty: b.every((x) => x === 0),
    disabled: (flags0 & 0x80) !== 0,
    flags0,
    kind,
    month: b[2]!,
    day: b[3]!,
    weekday: b[4]!,
    event,
    picture: file.u16(at + 6),
    pictureParam: file.u16(at + 8),
    bgm: file.u16(at + 10),
    closed: (flags0 & 0x7f) !== 0,
    giveCard: (event & 0x08) !== 0,
    bgmChange: (event & 0x04) !== 0,
    lunar: kind === HOLIDAY_KIND.lunar,
    hex: recordHex(file, at, HOLIDAY_STRIDE),
  };
}

/** 单项结构是否合法（空槽算合法） */
export function holidayRecordOk(r: HolidayRow): boolean {
  if (r.empty) return true;
  if ((r.flags0 & 0x7e) !== 0 || r.kind > 2 || (r.event & 0xf0) !== 0) return false;
  if (r.month < 1 || r.month > 12) return false;
  if (r.kind === HOLIDAY_KIND.nthWeekday) return r.day >= 1 && r.day <= 5 && r.weekday <= 6;
  return r.day >= 1 && r.day <= 31 && r.weekday === 0;
}

export function blockOk(file: PeFile, va: number, mapId: number): boolean {
  const base = va + mapId * HOLIDAYS_PER_MAP * HOLIDAY_STRIDE;
  if (file.tryVaToOff(base) === null || file.tryVaToOff(base + HOLIDAYS_PER_MAP * HOLIDAY_STRIDE - 1) === null) {
    return false;
  }
  const rows = Array.from({ length: HOLIDAYS_PER_MAP }, (_, s) =>
    parseHoliday(file, base + s * HOLIDAY_STRIDE, mapId, s),
  );
  // 至少一项非空；空槽只能在末尾
  const firstEmpty = rows.findIndex((r) => r.empty);
  if (firstEmpty === 0) return false;
  if (firstEmpty > 0 && rows.slice(firstEmpty).some((r) => !r.empty)) return false;
  return rows.every(holidayRecordOk);
}

/** 从 va 起连续合法的块数（= 地图数的上界） */
export function countHolidayBlocks(file: PeFile, va: number, max = 16): number {
  let n = 0;
  while (n < max && blockOk(file, va, n)) n++;
  return n;
}

export function parseHolidays(file: PeFile, va: number, maps: number): { maps: number; rows: HolidayRow[] } {
  const rows: HolidayRow[] = [];
  for (let m = 0; m < maps; m++) {
    for (let s = 0; s < HOLIDAYS_PER_MAP; s++) {
      rows.push(parseHoliday(file, va + (m * HOLIDAYS_PER_MAP + s) * HOLIDAY_STRIDE, m, s));
    }
  }
  return { maps, rows };
}

export function validateHolidays(file: PeFile, va: number, maps: number | undefined): Check[] {
  const blocks = countHolidayBlocks(file, va);
  const out: Check[] = [chk('holidays.blocks', 'error', blocks >= 1, `连续合法的 24 项块：${blocks}`)];
  if (maps !== undefined) {
    out.push(
      chk(
        'holidays.maps',
        'error',
        blocks >= maps,
        `股票表推出 ${maps} 张图，节日表合法块 ${blocks}${blocks > maps ? '（多出的块不计）' : ''}`,
      ),
    );
    out.push(
      chk(
        'holidays.end',
        'warn',
        blocks === maps,
        blocks === maps ? `第 ${maps + 1} 块不再合法（表尾明确）` : `第 ${maps + 1} 块仍像节日表`,
      ),
    );
  }
  return out;
}

export const holidaysSpec: TableSpec<{ maps: number; rows: HolidayRow[] }> = {
  id: 'holidays',
  xrefSpan: HOLIDAY_STRIDE,
  hint: (ctx) => hintOf(ctx, ctx.anchors.tables.holidays.hint),
  signature: (ctx: LocateContext) => {
    const tools = ctx.located.tools;
    if (tools === undefined) return { va: null, detail: '道具表未定位' };
    return { va: tools + TOOL_COUNT * TOOL_STRIDE, detail: `紧随道具表（${hexVa(tools)} + 104）` };
  },
  validate: (file, va, ctx) => validateHolidays(file, va, ctx.maps),
  parse: (file, va, ctx) => parseHolidays(file, va, ctx.maps ?? countHolidayBlocks(file, va)),
  byteLength: (ctx) => (ctx.maps ?? 0) * HOLIDAYS_PER_MAP * HOLIDAY_STRIDE,
};

/** 从代码里找节日表字段的用法，佐证布局解读（两版都应有 +0 test 0x80、+0 cmp 0、+5 test 1/4/8） */
export function holidayCodeEvidence(file: PeFile, va: number): HolidayCode {
  const fieldRefs: number[] = [];
  const flags0Tests = new Set<number>();
  const flags0Cmps = new Set<number>();
  const eventTests = new Set<number>();
  for (let f = 0; f < HOLIDAY_STRIDE; f++) {
    const refs = file.findU32InRange(va + f, va + f + 1, 'code');
    fieldRefs.push(refs.length);
    for (const r of refs) {
      const off = file.vaToOff(r.at);
      if (off + 4 >= file.bytes.length) continue;
      const imm = file.bytes[off + 4]!;
      // 操作码在 ModRM（off-1 或带 SIB 时 off-2）之前
      const ops = [file.bytes[off - 2], file.bytes[off - 3]];
      const isTest = ops.includes(0xf6);
      const isCmp = ops.includes(0x80);
      if (f === 0 && isTest) flags0Tests.add(imm);
      if (f === 0 && isCmp) flags0Cmps.add(imm);
      if (f === 5 && isTest) eventTests.add(imm);
    }
  }
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
  return {
    fieldRefs,
    flags0Tests: sorted(flags0Tests),
    flags0Cmps: sorted(flags0Cmps),
    eventTests: sorted(eventTests),
  };
}
