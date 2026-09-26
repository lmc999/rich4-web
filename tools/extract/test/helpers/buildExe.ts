/**
 * 测试专用：合成一个「像 rich4.exe」的 PE32（数值全部虚构或取自公开调研文档，不含原版字节）。
 * 代码节里放若干条引用各表的指令（每条前面有唯一的 `mov eax, k` 作区分），数据节里放字符串与各表。
 * dataShift 让两个变体的数据 VA 不同，用来测试 xrefTransfer 与签名定位。
 */
import { encodeBig5 } from '../../src/bin/big5';
import { EXPECT_TAIWAN_STOCKS } from '../../src/exe/locate';
import { buildPe } from './buildPe';

export const IMAGE_BASE = 0x400000;
const TEXT_RVA = 0x1000;
const TEXT_RAW = 0x400;
const TEXT_SIZE = 0x1000;
const DATA_RVA = 0x3000;
const DATA_RAW = TEXT_RAW + TEXT_SIZE;
const DATA_SIZE = 0x8000;

export interface SynthOptions {
  /** 数据节内的整体偏移（两个变体取不同值） */
  dataShift?: number;
  /** 股票/节日的地图数 */
  maps?: number;
  /** 农历表天数 */
  lunarDays?: number;
  /** 改写卡价（测试「事实核对失败」） */
  cardPrice19?: number;
  /** 不写农历表之后的代码引用（测试 xref 失败的回退） */
  omitLunarRef?: boolean;
}

export interface SynthExe {
  bytes: Uint8Array;
  va: Record<
    | 'cards'
    | 'tools'
    | 'holidays'
    | 'characters'
    | 'stocks'
    | 'funds'
    | 'days'
    | 'wealth'
    | 'facility'
    | 'lunar'
    | 'idxFunds'
    | 'idxDays'
    | 'idxWealth',
    number
  >;
}

/** 卡名（虚构的「X卡」，前两项与最后几项用签名要求的名称） */
const CARD_NAMES = [
  '均富卡',
  '均貧卡',
  ...Array.from({ length: 28 }, (_, i) => (i === 21 || i === 22 ? `神${i}符` : `測試${i + 3}卡`)),
];
/** 初始张数（和 = 100） */
const CARD_COUNTS = [1, 2, 4, 4, 4, 3, 8, 3, 2, 1, 2, 5, 4, 4, 2, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 4, 3, 3, 2, 3];
const CARD_PRICES = [
  200, 200, 35, 25, 20, 20, 15, 20, 160, 180, 60, 15, 25, 20, 100, 25, 20, 20, 40, 25, 25, 10, 20, 50, 30, 35, 35, 35,
  40, 70,
];
const TOOL_NAMES = [
  '機器娃娃',
  '路障',
  '道具三',
  '道具四',
  '道具五',
  '道具六',
  '道具七',
  '道具八',
  '道具九',
  '道具十',
].concat(['道具十一', '道具十二', '道具十三']);
const TOOL_PRICES = [15, 30, 25, 25, 80, 150, 100, 30, 30, 40, 95, 150, 250];
const CHAR_NAMES = ['約 翰 喬', '沙隆巴斯', '角色三', '角色四', '角色五', '角色六'].concat([
  '角色七',
  '角色八',
  '角色九',
  '角色十',
  '角色十一',
  '角色十二',
]);
const CASH = [50, 40, 70, 60, 40, 70, 50, 40, 60, 50, 55, 80];

/** 台湾式节日 24 项（公历/农历节日日期为公共日历事实；图片、参数、曲号为虚构值）：[flags0, kind, 月, 日, 星期, 事件, 图片, 参数, BGM] */
export const SYNTH_HOLIDAYS: readonly (readonly number[])[] = [
  [1, 0, 1, 1, 0, 3, 500, 7, 0],
  [0, 0, 2, 14, 0, 0, 0, 0, 0],
  [1, 0, 3, 29, 0, 0, 0, 0, 0],
  [0, 0, 4, 1, 0, 0, 0, 0, 0],
  [1, 0, 4, 4, 0, 0, 0, 0, 0],
  [1, 0, 4, 5, 0, 0, 0, 0, 0],
  [1, 0, 5, 1, 0, 0, 0, 0, 0],
  [0, 2, 5, 2, 0, 0, 0, 0, 0],
  [0, 0, 8, 8, 0, 0, 0, 0, 0],
  [1, 0, 9, 28, 0, 0, 0, 0, 0],
  [1, 0, 10, 10, 0, 3, 500, 7, 0],
  [1, 0, 10, 25, 0, 0, 0, 0, 0],
  [0x80, 0, 10, 31, 0, 0, 0, 0, 0],
  [1, 0, 10, 31, 0, 0, 0, 0, 0],
  [1, 0, 11, 12, 0, 0, 0, 0, 0],
  [1, 0, 12, 25, 0, 0x0f, 501, 8, 3],
  [1, 1, 12, 31, 0, 0, 0, 0, 0],
  [1, 1, 1, 1, 0, 4, 0, 0, 4],
  [1, 1, 1, 2, 0, 0, 0, 0, 4],
  [1, 1, 1, 3, 0, 0, 0, 0, 4],
  [0, 1, 1, 15, 0, 0, 0, 0, 0],
  [1, 1, 5, 5, 0, 0, 0, 0, 0],
  [0, 1, 7, 15, 0, 0, 0, 0, 0],
  [1, 1, 8, 15, 0, 0, 0, 0, 0],
];

class Writer {
  constructor(
    readonly buf: Uint8Array,
    readonly base: number,
    readonly baseVa: number,
    public pos = 0,
  ) {}
  get va(): number {
    return this.baseVa + this.pos;
  }
  private dv(): DataView {
    return new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
  }
  u8(v: number): this {
    this.buf[this.base + this.pos++] = v & 0xff;
    return this;
  }
  u16(v: number): this {
    this.dv().setUint16(this.base + this.pos, v, true);
    this.pos += 2;
    return this;
  }
  u32(v: number): this {
    this.dv().setUint32(this.base + this.pos, v >>> 0, true);
    this.pos += 4;
    return this;
  }
  f32(v: number): this {
    this.dv().setFloat32(this.base + this.pos, v, true);
    this.pos += 4;
    return this;
  }
  bytes(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.u8(b[i]!);
    return this;
  }
  zero(n: number): this {
    this.pos += n;
    return this;
  }
  /** Big5 + NUL，返回串的 VA */
  cstr(s: string): number {
    const va = this.va;
    const enc = encodeBig5(s);
    if (!enc) throw new Error(`无法编码 ${s}`);
    this.bytes(enc).u8(0);
    return va;
  }
}

/** 逐日农历序列：从 1997-12-03 起，月长 29/30 交替 */
function lunarSeq(days: number): number[] {
  const out: number[] = [];
  let y = 1997;
  let m = 12;
  let d = 3;
  let len = 29;
  for (let i = 0; i < days; i++) {
    out.push((y << 16) | (m << 8) | d);
    d++;
    if (d > len) {
      d = 1;
      len = len === 29 ? 30 : 29;
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
  }
  return out;
}

export function buildSynthExe(opts: SynthOptions = {}): SynthExe {
  const shift = opts.dataShift ?? 0;
  const maps = opts.maps ?? 2;
  const pe = buildPe(
    [
      {
        name: 'AUTO',
        virtualAddress: TEXT_RVA,
        virtualSize: TEXT_SIZE,
        rawSize: TEXT_SIZE,
        rawPointer: TEXT_RAW,
        characteristics: 0x60000020,
      },
      {
        name: 'DGROUP',
        virtualAddress: DATA_RVA,
        virtualSize: DATA_SIZE,
        rawSize: DATA_SIZE,
        rawPointer: DATA_RAW,
        characteristics: 0xc0000040,
      },
      {
        name: '.bss',
        virtualAddress: DATA_RVA + DATA_SIZE,
        virtualSize: 0x1000,
        rawSize: 0,
        rawPointer: 0,
        characteristics: 0xc0000080,
      },
    ],
    { imageBase: IMAGE_BASE },
  );
  const data = new Writer(pe, DATA_RAW, IMAGE_BASE + DATA_RVA, 0x10 + shift);

  // 字符串
  const cardNames = CARD_NAMES.map((n) => data.cstr(n));
  const toolNames = TOOL_NAMES.map((n) => data.cstr(n));
  const charNames = CHAR_NAMES.map((n) => data.cstr(n));
  const stockNames: number[] = [];
  for (let m = 0; m < maps; m++) {
    for (let i = 0; i < 12; i++) {
      stockNames.push(
        data.cstr(m === 0 ? EXPECT_TAIWAN_STOCKS[i]![0].replace(/^(.)(.)(.)$/, '$1 $2 $3') : `股${m}號${i}`),
      );
    }
  }
  data.pos = (data.pos + 15) & ~15;

  // 下标变量（静态初值：资金 1，其余 0）
  const idxFunds = data.va;
  data.u32(1);
  const idxDays = data.va;
  data.u32(0);
  const idxWealth = data.va;
  data.u32(0);
  data.zero(4);

  // 开局三表
  const funds = data.va;
  for (const v of [300000, 200000, 100000, 50000, 30000, 10000]) data.u32(v);
  data.zero(8);
  const days = data.va;
  for (const v of [0, 730, 365, 182, 91, 30]) data.u32(v);
  const wealth = data.va;
  for (const v of [0, 100, 50, 10, 5, 3]) data.u32(v);
  data.zero(12);

  // 设施等级上限
  const facility = data.va;
  data.bytes([1, 5, 5, 1, 5]).zero(11);

  // 角色表
  const characters = data.va;
  for (let i = 0; i < 12; i++) {
    const start = data.pos;
    data.u32(charNames[i]!).u32(0x102030 + i);
    data.zero(0x12 - 8);
    data
      .u8(1)
      .u8(i)
      .u8(i % 2)
      .u8(0)
      .u8(3)
      .u8(i % 3)
      .u8(10 * (i % 11))
      .u8(CASH[i]!)
      .u8(5 * i);
    data.pos = start + 0x68;
  }

  // 股票（紧接卡表）
  const stocks = data.va;
  for (let m = 0; m < maps; m++) {
    for (let i = 0; i < 12; i++) {
      const [, price, vol] = m === 0 ? EXPECT_TAIWAN_STOCKS[i]! : [0, 10 + i, 1 + i / 10];
      data
        .u32(stockNames[m * 12 + i]!)
        .u16(i < 3 ? 1 : 0)
        .u16(0)
        .u16(i === 1 ? 5000 : 10000)
        .u16(0)
        .f32(price as number)
        .f32(price as number)
        .f32(price as number)
        .f32(vol as number)
        .zero(8);
    }
  }
  const cards = data.va;
  CARD_NAMES.forEach((_, i) => {
    const price = i === 18 && opts.cardPrice19 !== undefined ? opts.cardPrice19 : CARD_PRICES[i]!;
    data
      .u32(cardNames[i]!)
      .u8(CARD_COUNTS[i]!)
      .u8(price)
      .u8(i % 3)
      .u8(i % 2);
  });
  const tools = data.va;
  TOOL_NAMES.forEach((_, i) => {
    data
      .u32(toolNames[i]!)
      .u8(i < 8 ? 10 : 0)
      .u8(TOOL_PRICES[i]!)
      .u8(0)
      .u8(1);
  });
  const holidays = data.va;
  for (let m = 0; m < maps; m++) {
    const rows = m === 0 ? SYNTH_HOLIDAYS : SYNTH_HOLIDAYS.slice(0, 3);
    for (let s = 0; s < 24; s++) {
      const r = rows[s];
      if (!r) {
        data.zero(12);
        continue;
      }
      const [f0, kind, mo, d, wd, ev, pic, par, bgm] = r as number[];
      data.u8(f0!).u8(kind!).u8(mo!).u8(d!).u8(wd!).u8(ev!).u16(pic!).u16(par!).u16(bgm!);
    }
  }
  // 表尾：像指针的数据（不再是合法节日块）
  for (let i = 0; i < 6; i++) data.u32(IMAGE_BASE + DATA_RVA + 0x100 * i);
  data.pos = (data.pos + 15) & ~15;

  const lunar = data.va;
  for (const v of lunarSeq(opts.lunarDays ?? 400)) data.u32(v);

  // 代码：每条引用前放唯一的 mov eax, k
  const code = new Writer(pe, TEXT_RAW, IMAGE_BASE + TEXT_RVA, 0x10);
  let k = 1;
  const tag = () => code.bytes([0xb8, k++, 0, 0, 0]);
  const disp = (v: number) => code.u32(v);
  // 开局：mov eax,[idx]; mov ecx,[eax*4+表]；新开局 mov dword [idxFunds], 1
  tag();
  code.bytes([0xa1]);
  disp(idxFunds);
  code.bytes([0x8b, 0x0c, 0x85]);
  disp(funds);
  tag();
  code.bytes([0xc7, 0x05]);
  disp(idxFunds);
  code.u32(1);
  tag();
  code.bytes([0xa1]);
  disp(idxDays);
  code.bytes([0x8b, 0x04, 0x85]);
  disp(days);
  tag();
  code.bytes([0xa1]);
  disp(idxWealth);
  code.bytes([0x8b, 0x04, 0x85]);
  disp(wealth);
  // cmp bl, byte [edx + facility]
  tag();
  code.bytes([0x3a, 0x9a]);
  disp(facility);
  // mov eax,[eax*8 + cards/tools]；imul eax,eax,0x68; mov eax,[eax+characters]；stocks
  tag();
  code.bytes([0x8b, 0x04, 0xc5]);
  disp(cards);
  tag();
  code.bytes([0x8b, 0x04, 0xc5]);
  disp(tools);
  tag();
  code.bytes([0x8b, 0x80]);
  disp(characters);
  tag();
  code.bytes([0x8b, 0x80]);
  disp(stocks);
  // 节日：test byte [esi+eax*4+h],0x80；cmp byte [ecx+eax*4+h],0；test byte [eax+h+5],1/4；test byte [ebx+eax*4+h+5],8
  tag();
  code.bytes([0xf6, 0x84, 0x86]);
  disp(holidays);
  code.u8(0x80);
  tag();
  code.bytes([0x80, 0xbc, 0x81]);
  disp(holidays);
  code.u8(0);
  tag();
  code.bytes([0xf6, 0x80]);
  disp(holidays + 5);
  code.u8(1);
  tag();
  code.bytes([0xf6, 0x80]);
  disp(holidays + 5);
  code.u8(4);
  tag();
  code.bytes([0xf6, 0x84, 0x83]);
  disp(holidays + 5);
  code.u8(8);
  if (!opts.omitLunarRef) {
    tag();
    code.bytes([0x8b, 0x3c, 0x85]);
    disp(lunar);
  }
  tag();
  code.u8(0xc3);

  return {
    bytes: pe,
    va: {
      cards,
      tools,
      holidays,
      characters,
      stocks,
      funds,
      days,
      wealth,
      facility,
      lunar,
      idxFunds,
      idxDays,
      idxWealth,
    },
  };
}
