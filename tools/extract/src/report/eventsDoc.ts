import type { ConstantResult, ConstValue } from '../exe/constants';
import {
  type EventSpec,
  FATE_SPEC,
  MAGIC_CONDITION_SPEC,
  MAGIC_EFFECT_SPEC,
  MAGIC_FLOW_PARAMS,
  NEWS_CATEGORY_LABELS,
  NEWS_SPEC,
  type ParamRef,
} from '../exe/eventSpec';
import type { FateRow } from '../exe/events';
import type { FuncDiff } from '../exe/funcdiff';
import type { ExtractedTables } from '../exe/types';

/**
 * docs/research/events-from-exe.md（入库）：新闻 36 / 命运 37 / 魔法屋 12 条件 × 12 效果的逐条参数表。
 * 文案一律为本项目自拟概括（eventSpec.ts，≤ 15 字），不含原版文本；数值与位置来自两版 exe 的读取结果。
 * 供 M7 引擎代理手录 data/tables/{news,fate,magic}.ts 时对照。无时间戳，相同输入字节一致。
 */

export interface EventsDocInput {
  command: string;
  v311: ExtractedTables;
  v206: ExtractedTables;
  constants: readonly ConstantResult[];
  funcdiff: readonly FuncDiff[];
}

const code = (s: string | number) => `\`${s}\``;
const row = (cells: readonly (string | number)[]) =>
  `| ${cells.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`;

const fmtVal = (v: ConstValue | null | undefined): string =>
  v === null || v === undefined ? '—' : Array.isArray(v) ? `[${v.join(', ')}]` : String(v);

function paramText(p: ParamRef, consts: ReadonlyMap<string, ConstantResult>): string {
  const c = consts.get(p.const);
  const a = c?.v311.value ?? null;
  const b = c?.v206?.value ?? null;
  const same = fmtVal(a) === fmtVal(b);
  const val = same ? fmtVal(a) : `${fmtVal(b)}（v2.06）/ ${fmtVal(a)}（v3.11）`;
  const shown =
    typeof a === 'number' && p.const.endsWith('.trend')
      ? `${val}（${a >> 4 ? `涨 ${a >> 4} 天` : ''}${a & 15 ? `跌 ${a & 15} 天` : ''}）`
      : val;
  return `${p.name} = ${shown}${p.pi ? ' × 物价指数' : ''}${p.unit ? ` ${p.unit}` : ''}`;
}

function vaPair(a: string | null | undefined, b: string | null | undefined): string {
  return `${a ?? '—'} / ${b ?? '—'}`;
}

function paramVas(p: readonly ParamRef[], consts: ReadonlyMap<string, ConstantResult>): string {
  return p
    .map((x) => {
      const c = consts.get(x.const);
      return `${x.name} ${vaPair(c?.v311.va, c?.v206?.va)}`;
    })
    .join('；');
}

function diffCell(fd: ReadonlyMap<string, FuncDiff>, key: string): string {
  const d = fd.get(key);
  if (!d) return '—';
  if (d.class === 'same') return '相同';
  if (d.class === 'const') return d.diffs.length === 0 ? '相同（仅资源号）' : `常量差 ${d.diffs.length}`;
  return d.diffs.length === 0
    ? `布局不同（${d.similarity}），对齐部分无数值差`
    : `结构不同（${d.similarity}），数值差 ${d.diffs.length}`;
}

const FORTUNE_TEXT: Record<string, string> = { reward: '奖金类', penalty: '罚金类', misfortune: '劫难类' };

function fortuneCell(r: FateRow | undefined, other: FateRow | undefined): string {
  const f = r?.fortune ?? null;
  const g = other?.fortune ?? null;
  const t = (x: FateRow['fortune']) =>
    x === null ? '不查' : `${FORTUNE_TEXT[x.class]}${x.handlesDouble ? '' : '（不处理加倍）'}`;
  const a = t(f);
  const b = t(g);
  return a === b ? a : `${b}（v2.06）/ ${a}（v3.11）`;
}

function notesOf(specs: readonly EventSpec[], label: string): string[] {
  const out: string[] = [];
  for (const s of specs) for (const n of s.notes ?? []) out.push(`- ${label} ${s.id}：${n}`);
  return out;
}

export function renderEventsDoc(p: EventsDocInput): string {
  const a = p.v311;
  const b = p.v206;
  const consts = new Map(p.constants.map((c) => [c.id, c]));
  const fd = new Map(p.funcdiff.map((d) => [d.label, d]));
  const L: string[] = [];
  L.push('# 新闻 / 命运 / 魔法屋：exe 参数表（v2.06 与 v3.11）');
  L.push('');
  L.push(
    `> 由 ${code(p.command)} 生成，请勿手改。「概括」是本项目对反汇编的自拟描述（≤ 15 字），不是原版文案；` +
      `数值全部读自两版 exe（${code('tools/extract/anchors/constants.json')} 的锚点，${code('verify --constants')} 逐项复核），` +
      `位置写作「v3.11 / v2.06」VA。逐条原始抽取在 ${code('.cache/extract/tables.<edition>.json')} 的 news / fate / magic 字段（gitignore）。` +
      '「两版」列来自函数级对比：资源号整体偏移、Panel.mkf 加载方式等表现层差异不计。供 M7 手录 data/tables/{news,fate,magic}.ts 对照。',
  );
  L.push('');

  // ── 0. 定位
  L.push('## 0. 定位');
  L.push('');
  L.push(row(['表', 'v3.11', 'v2.06', '说明']));
  L.push(row(['---', '---', '---', '---']));
  const desc: Record<string, string> = {
    newsHandlers: '新闻处理函数指针 × 36（先以参数 0 显示、2400ms 后以参数 1 收尾）',
    newsCategories: '新闻分类号 × 36 + 6 个分类名',
    fateHandlers: '命运处理函数指针 × 49（37 张 + 编号 33..36 在地图组 1..3 的文案变体 12 个）',
    magicEffects: '魔法屋效果 12 × 16（图标号、转盘坐标、名称）',
    magicConditions: '魔法屋条件名 × 12',
    magicEffectJump: '效果执行函数的跳表（代码节内）',
    magicCondJump: '条件求名单函数的跳表（代码节内）',
  };
  for (const [k, info] of Object.entries(a.eventTables?.locate ?? {})) {
    const other = b.eventTables?.locate[k as keyof typeof b.eventTables.locate];
    L.push(
      row([code(k), `${info.va}（${info.method}）`, other ? `${other.va}（${other.method}）` : '—', desc[k] ?? '']),
    );
  }
  L.push('');
  const h = a.eventTables?.helpers ?? {};
  const hb = b.eventTables?.helpers ?? {};
  L.push(
    `辅助函数（按调用点在两版识别）：${Object.keys(h)
      .map((k) => `${k} ${vaPair(h[k], hb[k])}`)
      .join('；')}。`,
  );
  L.push('');

  // ── 1. 新闻
  L.push('## 1. 新闻（36 条）');
  L.push('');
  const deck = consts.get('news.deck');
  L.push(
    `- 牌堆 ${fmtVal(deck?.v311.value)} 张（开局洗一次，游标循环；抽到不可行的跳过、游标照样前进）。` +
      '可行性判断在一个函数里按编号分支（下表「可行条件」）；不查神明加持。「类」是标题栏的分类号：' +
      `${NEWS_CATEGORY_LABELS.map((n, i) => `${i} ${n}`).join('、')}（自拟称呼）。`,
  );
  L.push('');
  L.push(row(['#', '概括', '类', '效果键', '目标', '可行条件', '数值', '处理函数 v3.11 / v2.06', '参数位置', '两版']));
  L.push(row(['---:', '---', '---:', '---', '---', '---', '---', '---', '---', '---']));
  for (const s of NEWS_SPEC) {
    const ra = a.news?.[s.id];
    const rb = b.news?.[s.id];
    L.push(
      row([
        s.id,
        s.summary,
        ra?.category ?? '—',
        code(s.effect),
        s.target,
        s.feasible,
        s.params.map((x) => paramText(x, consts)).join('；') || '—',
        vaPair(ra?.handler, rb?.handler),
        paramVas(s.params, consts) || '—',
        diffCell(fd, `newsHandlers[${s.id}]`),
      ]),
    );
  }
  L.push('');
  L.push('新闻备注：');
  L.push('');
  L.push(...notesOf(NEWS_SPEC, '新闻'));
  L.push('');

  // ── 2. 命运
  L.push('## 2. 命运（37 条）');
  L.push('');
  const hi = consts.get('fortune.high')?.v311.value;
  const mid = consts.get('fortune.mid')?.v311.value;
  L.push(
    `- 牌堆 ${fmtVal(consts.get('fate.deck')?.v311.value)} 张，机制同新闻。抽到后先做可行性 / 替换（按座驾把 10↔11、12↔13、14/15/16 互换；` +
      '0、1、5、8、9、10–13、33–36 有可行条件），再分派处理函数；编号 ≥ 33 的表项 = 编号 + 4 × 地图组内序号（v2.06 用当前地图号）。',
  );
  L.push(
    `- 加持判定（exe 自动识别：处理函数调用加持函数时压栈的两个参数）：财运 / 福运 > ${fmtVal(hi)} 必定生效，` +
      `${fmtVal(mid)} < 值 ≤ ${fmtVal(hi)} 时 rand & 1，值 < 0 反向；奖金类读财运（高 = 加倍，低 = 作废），` +
      '罚金类读财运（高 = 免付，低 = 加倍），劫难类读福运（高 = 逃过，低 = 天数加倍）。' +
      '「不处理加倍」= 代码只检查「免付 / 逃过」一个结果，低档时照常执行、不加倍。',
  );
  L.push('');
  L.push(
    row([
      '#',
      '概括',
      '加持（exe）',
      '效果键',
      '目标',
      '可行 / 替换',
      '数值',
      '处理函数 v3.11 / v2.06',
      '参数位置',
      '两版',
    ]),
  );
  L.push(row(['---:', '---', '---', '---', '---', '---', '---', '---', '---', '---']));
  for (const s of FATE_SPEC) {
    const ra = a.fate?.[s.id];
    const rb = b.fate?.[s.id];
    L.push(
      row([
        s.id,
        s.summary,
        fortuneCell(ra, rb),
        code(s.effect),
        s.target,
        s.feasible,
        s.params.map((x) => paramText(x, consts)).join('；') || '—',
        vaPair(ra?.handler, rb?.handler),
        paramVas(s.params, consts) || '—',
        diffCell(fd, `fateHandlers[${s.id}]`),
      ]),
    );
  }
  L.push('');
  const variants = (a.fate ?? []).filter((r) => r.variants.length > 0);
  if (variants.length > 0) {
    L.push('坐牢类（33–36）的地图组变体（表项 37–48，文案不同、天数相同）：');
    L.push('');
    L.push(row(['#', '组 1 表项 / 天数', '组 2 表项 / 天数', '组 3 表项 / 天数']));
    L.push(row(['---:', '---', '---', '---']));
    for (const r of variants) {
      L.push(row([r.id, ...r.variants.map((v) => `${v.slot} / ${fmtVal(v.days)}`)]));
    }
    L.push('');
  }
  const withFortune = (a.fate ?? []).filter((r) => r.fortune !== null).length;
  L.push(
    `命运中调用加持判定的 ${withFortune} 条（exe 自动统计；g_arbitration 写 28 条，且称「汽车超速」未接加持——exe 中 16 与 15 共用收尾并调用判定）。`,
  );
  L.push('');
  L.push('命运备注：');
  L.push('');
  L.push(...notesOf(FATE_SPEC, '命运'));
  L.push('');

  // ── 3. 魔法屋
  L.push('## 3. 魔法屋');
  L.push('');
  const flow = (id: string) => fmtVal(consts.get(id)?.v311.value);
  L.push(
    `- 条件：真人与电脑都是 rand % ${flow('magic.condPickHuman')} 抽条件、无人符合就重抽（不设上限）；名单最多 4 人（= 玩家数）。`,
  );
  L.push(
    `- 效果：真人在转盘上点选（点击判定只看像素所属效果，不因名单含自己而限制）；电脑：名单含自己时固定选效果 ${flow('ai.magic.selfEffect')}，` +
      `否则 rand % ${flow('ai.magic.effectPick')}，抽到 6 改为 7。效果对名单逐人执行。`,
  );
  L.push('');
  L.push(row(['#', '条件概括', '判据', '处理 v3.11 / v2.06', '两版']));
  L.push(row(['---:', '---', '---', '---', '---']));
  for (const s of MAGIC_CONDITION_SPEC) {
    const ra = a.magic?.conditions[s.id];
    const rb = b.magic?.conditions[s.id];
    L.push(row([s.id, s.summary, s.target, vaPair(ra?.handler, rb?.handler), diffCell(fd, `magicCondJump[${s.id}]`)]));
  }
  L.push('');
  L.push(row(['#', '效果概括', '效果键', '对象', '数值', '处理 v3.11 / v2.06', '参数位置', '两版']));
  L.push(row(['---:', '---', '---', '---', '---', '---', '---', '---']));
  for (const s of MAGIC_EFFECT_SPEC) {
    const ra = a.magic?.effects[s.id];
    const rb = b.magic?.effects[s.id];
    L.push(
      row([
        s.id,
        s.summary,
        code(s.effect),
        s.target,
        s.params.map((x) => paramText(x, consts)).join('；') || '—',
        vaPair(ra?.handler, rb?.handler),
        paramVas(s.params, consts) || '—',
        diffCell(fd, `magicEffectJump[${s.id}]`),
      ]),
    );
  }
  L.push('');
  L.push(`流程常量：${MAGIC_FLOW_PARAMS.map((x) => paramText(x, consts)).join('；')}。`);
  L.push('');
  L.push('魔法屋备注：');
  L.push('');
  L.push(...notesOf(MAGIC_EFFECT_SPEC, '效果'));
  L.push('');

  // ── 4. 与社区资料的出入
  L.push('## 4. 与 r_squares_events.md / engine.md 的出入');
  L.push('');
  for (const line of DISCREPANCIES) L.push(`- ${line}`);
  L.push('');

  // ── 5. 其他规则常量
  L.push('## 5. 其他规则常量（anchors/constants.json，新闻 / 命运 / 魔法屋以外）');
  L.push('');
  L.push('供 M4（经济）、M6（道具）、M8（小游戏）、AI 对照；「两版」为 v2.06 与 v3.11 的读取值是否相同。');
  L.push('');
  L.push(row(['id', '值', '说明', 'v3.11 / v2.06', 'VERIFY', '两版']));
  L.push(row(['---', '---', '---', '---', '---', '---']));
  for (const c of p.constants) {
    if (/^(news|fate|magic)\./.test(c.id)) continue;
    L.push(
      row([
        code(c.id),
        fmtVal(c.v311.value ?? c.expected),
        c.desc,
        c.kind === 'derived' ? '（派生）' : vaPair(c.v311.va, c.v206?.va),
        c.verify,
        c.same === null ? '—' : c.same ? '相同' : '不同',
      ]),
    );
  }
  L.push('');
  return L.join('\n');
}

/** 人工核对 r_squares_events.md（社区资料，主要出自 oama/mytbk）与 design/engine.md §10.6–§10.8 后的出入清单 */
export const DISCREPANCIES: readonly string[] = [
  '新闻 9（补助地产最少者）：exe 在全体在场玩家中取最少（含 0 块地），并列取座位号最小；r_squares 与 engine.md 写「有地者中最少、并列取最后一个」。',
  '新闻 12（地价税）：exe 的基数包括设施（地价 + 等级 × 设施 +0x24 字段）；engine.md 只写了住宅部分。',
  '新闻 15（瓦斯爆炸）：只在有建筑的住宅中抽，但可行性与 4、5 共用（设施有建筑也算可行）；只有设施有建筑时原版会除以 0。建议引擎把可行条件收紧为「有等级 > 0 的住宅」。',
  '新闻 27（个股停牌）：exe 写入 15 天（文案 10 天），与 r_squares 一致；rand % 12 可能抽到已停牌的股票（覆盖计数）。',
  '新闻 29（董事长超贷）：可行性要求至少一位董事长在场且未受困，但处理函数在「所有有董事长的公司」中随机抽，抽到受困的董事长也照样坐牢。',
  '新闻 30、33、34：随机公司不要求有董事长（rand % 公司数）。',
  '新闻 35（获利翻倍）：累计盈余加的是 2 × 原盈余（不是 1 ×）；上涨天数 = 原盈余 / 10000 按字节截断（对 16 取模），engine.md 写 min(15, …)。',
  '命运 3、8、9：罚金类加持只处理「免付」，低档不加倍；命运 10、11、32：劫难类只处理「逃过」，低档不加倍。',
  '命运 16（汽车超速）：exe 与 15 共用收尾代码并查罚金类加持，g_arbitration「原版就没有接上加持」不成立；命运中查加持的共 33 条（除 0、1、4、5 外全部），不是 28 条。',
  '命运 14–19、23、24、26、30 与 2：投保期间由保险公司赔付同额（加持免付时不赔）；r_squares 只在「冒贷」写了保险。',
  '命运 32 与魔法屋效果 0、8：卡片、道具都按商店价格**全价**折点券（座驾先折回道具），不乘 0.9；engine.md §10.7「× 0.9」不符（0.9 只用于商店卖回）。',
  '命运 33–36：在 v3.11 只在地图组标志 = 0（原版 4 张图）时可行；v2.06 的可行性函数没有这一分支（跳表只到 16），并按当前地图号选文案。',
  '魔法屋效果 5、7、9、11 跳过受困（计数非 0）的目标；效果 11 的拍卖以目标玩家为卖方（V-R7「钱归谁」代码上归目标，待实机）。',
  '魔法屋条件 0（财产最多）0 也参选、并列全选；条件 1–5 数值为 0 的玩家不参选；名单上限 = 玩家数（没有另设 4 人上限）。',
  '月结利息（附带发现）：只有贷款为 0 的玩家存款 × 1.1（常量 bank.monthlyInterest 所在分支），design 未写这一条件。',
];
