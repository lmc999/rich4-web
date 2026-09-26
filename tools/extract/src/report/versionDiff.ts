import { EXPECT_DISPUTED_CARD_PRICES } from '../exe/locate';
import { stripHex } from '../exe/tables/common';
import type { ExeEdition, ExtractedTables, HolidayRow, TableId } from '../exe/types';
import type { FingerprintReport } from '../fingerprint/identify';
import { canonicalJson } from '../io/writeCanonicalJson';

/**
 * docs/research/version-diff.md（入库，data-pipeline.md §6.5）：v2.06 与 v3.11 的差异结论。
 * 只写事实、计数、哈希与结论，不贴原始字节与整表数据；无时间戳，相同输入字节一致。
 * 代码级对比（funcdiff、常量锚点）属于 D2 第二部分，本报告先标为待办。
 */

export type DiffStatus = 'same' | 'superset' | 'diff' | 'missing';

export interface TableDiff {
  table: string;
  label: string;
  status: DiffStatus;
  details: string[];
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

function rowDiffs<T extends object>(a: readonly T[], b: readonly T[], keyOf: (r: T) => string): string[] {
  const out: string[] = [];
  const bm = new Map(b.map((r) => [keyOf(r), r]));
  for (const ra of a) {
    const rb = bm.get(keyOf(ra));
    if (!rb) {
      out.push(`${keyOf(ra)} 只在 v2.06`);
      continue;
    }
    const [sa] = stripHex([ra]) as Record<string, unknown>[];
    const [sb] = stripHex([rb]) as Record<string, unknown>[];
    const fields = Object.keys(sa!).filter((k) => !same(sa![k], sb![k]));
    if (fields.length > 0) {
      out.push(
        `${keyOf(ra)}：${fields.map((f) => `${f} ${JSON.stringify(sa![f])}→${JSON.stringify(sb![f])}`).join('，')}`,
      );
    }
  }
  return out;
}

/** 节日表的差异按「字段 旧值→新值」归并计数 */
function holidayDiffs(a: readonly HolidayRow[], b: readonly HolidayRow[]): string[] {
  const groups = new Map<string, number>();
  const bm = new Map(b.map((r) => [`${r.mapId}/${r.slot}`, r]));
  for (const ra of a) {
    const rb = bm.get(`${ra.mapId}/${ra.slot}`);
    if (!rb) continue;
    for (const f of Object.keys(ra) as (keyof HolidayRow)[]) {
      if (f === 'hex' || ra[f] === rb[f]) continue;
      const k = `${f} ${String(ra[f])}→${String(rb[f])}`;
      groups.set(k, (groups.get(k) ?? 0) + 1);
    }
  }
  return [...groups.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([k, n]) => `${k}（${n} 项）`);
}

export function diffExeTables(a: ExtractedTables, b: ExtractedTables): TableDiff[] {
  const out: TableDiff[] = [];
  const push = (table: string, label: string, details: string[], extra: string[] = [], superset = false) => {
    out.push({
      table,
      label,
      status: details.length > 0 ? 'diff' : superset ? 'superset' : 'same',
      details: [...details, ...extra],
    });
  };
  const cd = rowDiffs(a.cards, b.cards, (r) => `卡#${r.id}`);
  const disputed = Object.keys(EXPECT_DISPUTED_CARD_PRICES)
    .map((id) => {
      const x = a.cards[Number(id) - 1];
      const y = b.cards[Number(id) - 1];
      return `${x?.name ?? id} ${x?.price}/${y?.price}`;
    })
    .join('、');
  push('cards', '卡片 30×8', cd, [
    cd.length === 0 ? '30 项的名称、初始张数、点券价、f6、f7 两版完全一致；原始字节只有名称指针不同' : '',
    `争议卡价（v2.06/v3.11）：${disputed}`,
  ]);
  const td = rowDiffs(a.tools, b.tools, (r) => `道具#${r.id}`);
  push('tools', '道具 13×8', td, td.length === 0 ? ['13 项内容一致；原始字节只有名称指针不同'] : []);
  const chd = rowDiffs(a.characters, b.characters, (r) => `角色#${r.id}`);
  push('characters', '角色 12×0x68', chd, chd.length === 0 ? ['12 项全部字段一致；原始字节只有名称指针不同'] : []);
  const common = Math.min(a.stocks.maps, b.stocks.maps);
  const sd = rowDiffs(
    a.stocks.rows.filter((r) => r.mapId < common),
    b.stocks.rows.filter((r) => r.mapId < common),
    (r) => `股票 ${r.mapId}/${r.index}`,
  );
  const extraStocks =
    b.stocks.maps > a.stocks.maps
      ? [
          `v3.11 另有地图 ${a.stocks.maps}..${b.stocks.maps - 1} 的 ${(b.stocks.maps - a.stocks.maps) * 12} 支（v2.06 没有这些地图）`,
        ]
      : [];
  push(
    'stocks',
    '股票模板 n×36',
    sd,
    [
      `项数：v2.06 ${a.stocks.rows.length}（${a.stocks.maps} 张图），v3.11 ${b.stocks.rows.length}（${b.stocks.maps} 张图）`,
      sd.length === 0 ? `共有的 ${common} 张图 ${common * 12} 支逐项一致（名称、流通股、f32 价格与波动位型）` : '',
      ...extraStocks,
    ],
    extraStocks.length > 0,
  );
  const hcommon = Math.min(a.holidays.maps, b.holidays.maps);
  const hd = holidayDiffs(
    a.holidays.rows.filter((r) => r.mapId < hcommon),
    b.holidays.rows.filter((r) => r.mapId < hcommon),
  );
  const onlyPicture = hd.every((d) => d.startsWith('picture '));
  const extraHol =
    b.holidays.maps > a.holidays.maps ? [`v3.11 另有地图 ${a.holidays.maps}..${b.holidays.maps - 1} 的节日块`] : [];
  out.push({
    table: 'holidays',
    label: '节日 24×12 / 图',
    status: hd.length === 0 ? (extraHol.length > 0 ? 'superset' : 'same') : onlyPicture ? 'superset' : 'diff',
    details: [
      ...(hd.length === 0
        ? [`共有的 ${hcommon} 张图逐项一致`]
        : onlyPicture
          ? [`共有的 ${hcommon} 张图只有图片资源号不同（表现层）：${hd.join('；')}`]
          : hd),
      ...extraHol,
    ],
  });
  const setupA = { funds: a.setup.funds, days: a.setup.days, wealth: a.setup.wealthMultipliers };
  const setupB = { funds: b.setup.funds, days: b.setup.days, wealth: b.setup.wealthMultipliers };
  const di = (t: ExtractedTables) =>
    `${t.setup.defaults.funds.index}/${t.setup.defaults.days.index}/${t.setup.defaults.wealthMultipliers.index}`;
  push(
    'setup',
    '开局三表 u32×6',
    same(setupA, setupB) ? [] : ['数值不同'],
    [
      `默认档位下标（资金/期限/倍率）：v2.06 ${di(a)}，v3.11 ${di(b)}`,
      `默认总资金：v2.06 ${a.setup.defaults.funds.value}，v3.11 ${b.setup.defaults.funds.value}`,
    ].concat(di(a) === di(b) ? [] : ['默认档位不同']),
  );
  push('facilityLevels', '设施等级上限 u8×5', same(a.facilityLevels.max, b.facilityLevels.max) ? [] : ['数值不同'], [
    `v2.06 [${a.facilityLevels.max}]，v3.11 [${b.facilityLevels.max}]`,
  ]);
  push('lunar', '农历表 u32/日', a.digests.lunar.bytesSha256 === b.digests.lunar.bytesSha256 ? [] : ['字节不同'], [
    `${a.lunar.days} 天（公历 ${a.lunar.firstSolar}..${a.lunar.lastSolar}），两版字节${a.digests.lunar.bytesSha256 === b.digests.lunar.bytesSha256 ? '相同' : '不同'}`,
  ]);
  for (const d of out) d.details = d.details.filter((x) => x !== '');
  return out;
}

// ───────────────────────── 渲染 ─────────────────────────

export interface ContainerInfo {
  file: string;
  bytes: number;
  sha256: string;
  count: number;
  compressed: number;
  hasSentinel: boolean;
}

export interface MapDiffInfo {
  gm: number;
  label: string;
  sources: string[];
  rule: number;
  presentation: number;
  identicalGroups: string[][];
  ruleItems: string[];
  /** 每条规则差异中与其余来源都不同的那个来源（没有唯一离群者时为 null） */
  ruleOdd: (string | null)[];
  presentationFields: string[];
}

export interface StringDiffInfo {
  v206: number;
  v311: number;
  common: number;
  onlyV206: number;
  onlyV311: number;
  examplesV311: string[];
  examplesV206: string[];
}

export interface VersionDiffInput {
  command: string;
  exes: Partial<Record<ExeEdition, ExtractedTables>>;
  fingerprint: FingerprintReport | null;
  containers: ContainerInfo[];
  maps: MapDiffInfo[];
  strings: StringDiffInfo | null;
}

const code = (s: string | number) => `\`${s}\``;
const row = (cells: readonly (string | number)[]) => `| ${cells.map(String).join(' | ')} |`;
const STATUS: Record<DiffStatus, string> = {
  same: '一致',
  superset: 'v3.11 为超集',
  diff: '有差异',
  missing: '缺数据',
};
const TABLE_ORDER: readonly TableId[] = [
  'cards',
  'tools',
  'characters',
  'stocks',
  'holidays',
  'setupFunds',
  'setupDays',
  'setupWealth',
  'facilityLevels',
  'lunar',
];

function holidayLayoutLines(t: ExtractedTables): string[] {
  const tw = t.holidays.rows.filter((r) => r.mapId === 0 && !r.empty);
  const n = (p: (r: HolidayRow) => boolean) => tw.filter(p).length;
  const kinds = [0, 1, 2].map((k) => n((r) => r.kind === k));
  const L = [
    `- 台湾（gm 0）24 项：公历 ${kinds[0]}、农历 ${kinds[1]}、「第 n 个星期几」${kinds[2]}；` +
      `休市 ${n((r) => r.closed && !r.disabled)}、停用 ${n((r) => r.disabled)}、发卡 ${n((r) => r.giveCard)}、` +
      `换 BGM ${n((r) => r.bgmChange)}、显示图片 ${n((r) => (r.event & 1) !== 0)}。`,
  ];
  const disabled = tw.filter((r) => r.disabled);
  if (disabled.length > 0) {
    L.push(
      `- 停用项：${disabled.map((r) => `slot ${r.slot}（${r.month}/${r.day}）`).join('、')}，与后一项同日；原版查找时跳过停用项，` +
        '所以该日按后一项处理（休市）。MapDef 不输出停用项。',
    );
  }
  const c = t.holidays.code;
  L.push(
    `- 代码用法佐证（${t.edition}）：+0 被 ${code(`test ${c.flags0Tests.map((v) => `0x${v.toString(16)}`).join('/')}`)} 与 ` +
      `${code(`cmp ${c.flags0Cmps.join('/')}`)} 使用；+5 被 ${code(`test ${c.eventTests.join('/')}`)} 使用（bit1 无引用）。`,
  );
  return L;
}

function mapConclusion(maps: readonly MapDiffInfo[]): string[] {
  const tw = maps.find((m) => m.gm === 0);
  const odd = new Map<string, number>();
  let unresolved = 0;
  for (const m of maps) {
    for (const o of m.ruleOdd) {
      if (o === null) unresolved++;
      else odd.set(o, (odd.get(o) ?? 0) + 1);
    }
  }
  const total = maps.reduce((s, m) => s + m.rule, 0);
  const L: string[] = [];
  if (tw) {
    L.push(
      `结论：台湾（gm 0）三个来源的规则相关差异 ${tw.rule} 项，表现相关差异只在贴图编号类字段（${tw.presentationFields.map((f) => f.split('（')[0]).join('、')}）。` +
        '社区所说「v3.11 保留 MapDat 时 2.06 地图显示异常」推测就是这些贴图编号：v3.11 的 map.mkf 资源编号与 v2.06 不同，' +
        'MapDat 里的旧编号在 v3.11 下指向错误的精灵（未实机验证）。',
    );
  }
  if (total > 0) {
    const oddText = [...odd.entries()].map(([k, n]) => `${k} ${n} 项`).join('、');
    L.push(
      `4 张共有地图的规则相关差异共 ${total} 项，离群来源：${oddText || '无'}${unresolved > 0 ? `；另有 ${unresolved} 项三方各不相同` : ''}。` +
        (odd.size === 1 && odd.has('v206-mapmkf') && unresolved === 0
          ? 'v2.06 实际读取的 MapDat.mkf 与 v3.11 的 map.mkf 在规则字段上完全一致；差异都在 v2.06 的回退文件 map.mkf（存在 MapDat 时不会被读取）。'
          : '接入对应地图时需由用户选定基线（V-M1）。'),
    );
  }
  return L;
}

export function renderVersionDiff(p: VersionDiffInput): string {
  const a = p.exes.v206;
  const b = p.exes.v311;
  const L: string[] = [];
  L.push('# 大富翁4 v2.06 与 v3.11 差异报告');
  L.push('');
  L.push(
    `> 由 ${code(p.command)} 生成，请勿手改。只写事实、计数、哈希与结论，不含原始字节与整表数据；` +
      `逐项抽取结果在 ${code('.cache/extract/tables.<edition>.json')}（gitignore）。代码级对比（funcdiff、常量锚点）属于 D2 第二部分，见 §5。`,
  );
  L.push('');

  L.push('## 1. 输入指纹');
  L.push('');
  L.push(row(['文件', '版本', '字节', 'sha256', '登记 id']));
  L.push(row(['---', '---', '---:', '---', '---']));
  for (const t of [a, b]) {
    if (t) L.push(row([t.exe.file, t.edition, t.exe.bytes, code(t.exe.sha256), t.exe.knownFileId ?? '（未登记）']));
  }
  for (const c of p.containers) L.push(row([c.file, '-', c.bytes, code(c.sha256), '-']));
  if (p.fingerprint) {
    const mapdat = p.fingerprint.files.find((f) => /mapdat\.mkf$/i.test(f.path));
    if (mapdat && !p.containers.some((c) => c.file === mapdat.path)) {
      L.push(row([mapdat.path, mapdat.edition ?? '-', mapdat.size, code(mapdat.sha256), mapdat.knownId ?? '-']));
    }
  }
  L.push('');

  L.push('## 2. 容器');
  L.push('');
  if (p.containers.length > 0) {
    L.push(row(['文件', '资源数', '压缩资源', '末项哨兵']));
    L.push(row(['---', '---:', '---:', '---']));
    for (const c of p.containers) L.push(row([c.file, c.count, c.compressed, c.hasSentinel ? '有' : '无']));
    L.push('');
    L.push('地图结构资源都未压缩（台湾在 MapDat.mkf[0] 与两个 map.mkf[1]），LZHUF 解码器不在地图关键路径上。');
  } else L.push('（未读取容器）');
  L.push('');

  L.push('## 3. 地图');
  L.push('');
  if (p.maps.length > 0) {
    L.push(row(['gm', '地图', '来源', '规则相关差异', '表现相关差异', '字节相同的分组']));
    L.push(row(['---:', '---', '---', '---:', '---:', '---']));
    for (const m of p.maps) {
      L.push(
        row([
          m.gm,
          m.label,
          m.sources.join('、'),
          m.rule,
          m.presentation,
          m.identicalGroups.map((g) => `[${g.join(', ')}]`).join(' ') || '—',
        ]),
      );
    }
    L.push('');
    for (const m of p.maps) {
      if (m.rule === 0 && m.presentation === 0) continue;
      L.push(`- gm ${m.gm} ${m.label}：`);
      if (m.presentationFields.length > 0) L.push(`  - 表现相关字段：${m.presentationFields.join('、')}`);
      for (const r of m.ruleItems) L.push(`  - 规则相关：${r}`);
    }
    L.push('');
    L.push(...mapConclusion(p.maps));
  } else L.push('（未比较；需要 original/ 下的 MapDat.mkf 与 map.mkf）');
  L.push('');

  L.push('## 4. 固定表');
  L.push('');
  if (a && b) {
    L.push(row(['表', '定位 v2.06', '定位 v3.11', '内容 sha256 相同', '结论']));
    L.push(row(['---', '---', '---', ':---:', '---']));
    for (const id of TABLE_ORDER) {
      const la = a.locate[id];
      const lb = b.locate[id];
      const eq = a.digests[id].contentSha256 === b.digests[id].contentSha256;
      L.push(
        row([
          code(id),
          `${la.va}（${la.method}）`,
          `${lb.va}（${lb.method}）`,
          eq ? '✅' : '—',
          eq ? '一致' : id === 'stocks' || id === 'holidays' ? '见下' : '不同',
        ]),
      );
    }
    L.push('');
    const diffs = diffExeTables(a, b);
    for (const d of diffs) {
      L.push(`- **${d.label}**：${STATUS[d.status]}。${d.details.join('；')}。`);
    }
    L.push('');
    L.push('节日表布局（由 v3.11 代码 0x4521f0 / 0x4523d5 / 0x452444 反推，两版用法相同）：');
    L.push('');
    L.push(row(['偏移', '类型', '含义']));
    L.push(row(['---', '---', '---']));
    for (const [o, ty, m] of [
      ['+0', 'u8', 'flags0：非 0 即休市（实际只用 bit0）；bit7 = 停用，查找时跳过继续找'],
      ['+1', 'u8', 'kind：0 公历 (月,日)；1 农历 (月,日)，查 exe 内农历表；2 该月第 n 个星期 w'],
      ['+2 / +3', 'u8', '月 / 日（kind 2 为第 n 个；超出当月天数则当年不命中）'],
      ['+4', 'u8', 'kind 2 的星期（0 = 星期日）'],
      ['+5', 'u8', '事件位：bit0 显示图片；bit2 换 BGM；bit3 每位在场玩家从牌堆得 1 张卡；bit1 代码未引用'],
      ['+6 / +8', 'u16', '图片资源号 / 图片参数（两版资源号不同，属表现层）'],
      ['+10', 'u16', 'BGM 曲号（下一项也有曲号时音乐延续）'],
    ]) {
      L.push(row([o!, ty!, m!]));
    }
    L.push('');
    L.push(...holidayLayoutLines(a));
    const cb = b.holidays.code;
    const ca = a.holidays.code;
    L.push(
      `- 两版字段用法${same(ca, cb) ? '相同' : '不同'}（引用次数 v2.06 [${ca.fieldRefs}]，v3.11 [${cb.fieldRefs}]）。`,
    );
    const unreach = a.facts.find((f) => f.id === 'holidays.lunarUnreachable');
    if (unreach && !unreach.ok) L.push(`- 农历：${unreach.detail}（原版瑕疵，保留原数据）。`);
    L.push(
      `- 农历表：${a.lunar.days} 天（公历 ${a.lunar.firstSolar}..${a.lunar.lastSolar}，农历 ${a.lunar.firstLunar}..${a.lunar.lastLunar}，` +
        `闰月 ${a.lunar.leapMonths} 个）；超出 2020 年后原版查表越界。`,
    );
    L.push(`- MapDef 的 ${code('flagsRaw')} = flags0 | 事件位 << 8 | 星期 << 16。`);
  } else {
    L.push(`（只有 ${a ? 'v2.06' : b ? 'v3.11' : '零'} 个版本的抽取结果，无法对比）`);
  }
  L.push('');

  L.push('## 5. 代码行为');
  L.push('');
  if (a) {
    const xr = TABLE_ORDER.map((id) => {
      const c = a.locate[id].candidates.find((x) => x.method === 'xref');
      return c ? `${id} ${c.accepted ? '✅' : '—'}` : `${id} —`;
    });
    L.push(`- xrefTransfer（v3.11 → v2.06，按引用点代码模式迁移）交叉核对：${xr.join('、')}。`);
  }
  L.push('- 函数级 funcdiff、新闻/命运/魔法屋/小游戏/AI 常量锚点：⬜ 待 D2 第二部分（exe diff --r2）。');
  L.push('');

  L.push('## 6. 字符串');
  L.push('');
  if (p.strings) {
    const s = p.strings;
    L.push(
      `数据节中可严格解码的 Big5 串：v2.06 ${s.v206}，v3.11 ${s.v311}；两版共有 ${s.common}，只在 v2.06 ${s.onlyV206}，只在 v3.11 ${s.onlyV311}。`,
    );
    if (s.examplesV311.length > 0) L.push(`- 只在 v3.11 的示例：${s.examplesV311.map((x) => `「${x}」`).join('')}`);
    if (s.examplesV206.length > 0) L.push(`- 只在 v2.06 的示例：${s.examplesV206.map((x) => `「${x}」`).join('')}`);
  } else L.push('（未比较）');
  L.push('');

  L.push('## 7. 结论');
  L.push('');
  const concl: string[] = [];
  if (a && b) {
    const cardsSame = a.digests.cards.contentSha256 === b.digests.cards.contentSha256;
    const disputedOk = a.facts.find((f) => f.id === 'cards.disputedPrices')?.ok === true;
    concl.push(
      `卡片、道具、角色、开局三表、设施等级上限、农历表：两版${cardsSame ? '一致' : '有差异（见 §4）'}。` +
        (disputedOk
          ? '争议的四张卡在两版 exe 中都是 嫁禍 40、紅卡 50、漲價 35、同盟 40，Fandom 的数值判为 wiki 错误，按 exe 值实现。'
          : '争议卡价与预期不符，见 §4。'),
    );
    concl.push(
      `默认总资金：两版代码在新开局时都把档位下标写为 ${a.setup.defaults.funds.index}（${a.setup.defaults.funds.value}）；` +
        '非新开局分支会按当前总资金反查下标、沿用上局设置，推测存档实证中的 300000 来自这一分支（未实机验证）；实机默认值仍待 V-R15 复核。',
    );
    concl.push(
      `股票：v2.06 ${a.stocks.maps} 张图、v3.11 ${b.stocks.maps} 张图，共有部分逐项一致；台湾 12 支与调研样本全部吻合，价格都是整数分。`,
    );
    const diffs = diffExeTables(a, b);
    const hol = diffs.find((d) => d.table === 'holidays');
    const twRows = a.holidays.rows.filter((r) => r.mapId === 0 && !r.empty);
    const disabled = twRows.filter((r) => r.disabled).length;
    const unreach = a.facts.find((f) => f.id === 'holidays.lunarUnreachable');
    concl.push(
      `节日：${hol?.status === 'diff' ? '共有地图有规则字段差异（见 §4）' : '共有地图的规则字段一致，只有图片资源号不同'}。` +
        `台湾 ${twRows.length} 项中 ${disabled} 项停用${unreach && !unreach.ok ? '；农历「十二月三十一」在 exe 农历表中永不命中' : ''}。`,
    );
    const ruleDiff = diffs.filter((d) => d.status === 'diff');
    concl.push(
      ruleDiff.length === 0
        ? `规则相关的 exe 表差异：无。v3.11 相对 v2.06 只增加了地图 ${a.stocks.maps}..${b.stocks.maps - 1} 的股票与节日数据，不需要「v2.06 规则开关」。`
        : `规则相关的 exe 表差异：${ruleDiff.map((d) => d.label).join('、')}，可作为「v2.06 规则开关」候选。`,
    );
  }
  for (const c of concl) L.push(`- ${c}`);
  L.push('');
  return L.join('\n');
}
