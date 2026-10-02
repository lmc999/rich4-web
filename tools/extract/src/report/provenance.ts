import type { CompanyStockCheck } from '../exe/mapData';
import type { FingerprintReport } from '../fingerprint/identify';
import type { BuildResult, IssueClass } from '../map/build';
import type { RulesReport } from '../verify/rulesAgainstExe';
import type { SampleResult } from '../verify/samples';
import { ICON } from './table';

/**
 * docs/research/provenance-summary.md（台湾）与 provenance-<key>.md（其他图）（入库，data-pipeline.md §10.2）：
 * 只写输入指纹、样本 ✅/❌、几何统计与未决项；不含整图数据、原始字节、时间戳，重复生成字节一致。
 */

/** 按地图数据（股票、节日）来自哪个 exe（architecture §16.5） */
export interface ExeDataInfo {
  edition: string;
  exeFile: string;
  exeSha256: string;
  stocksVa: string;
  holidaysVa: string;
  stocks: number;
  holidays: number;
  /** 停用（bit7）而不输出的节日槽 */
  dropped: number[];
  empty: number;
  /** 另一版本 exe 中该图数据是否一致 */
  crossEdition: 'same' | 'diff' | 'n/a';
}

export interface ProvenanceInput {
  mapKey: string;
  command: string;
  overridesPath: string;
  fingerprint: FingerprintReport | null;
  samples: readonly { id: string; results: readonly SampleResult[] }[];
  diff: { rule: number; presentation: number; identicalGroups: string[][] } | null;
  build: BuildResult;
  mapFileSha256: string;
  strict4: boolean;
  exeData?: ExeDataInfo | null;
  rules?: RulesReport | null;
  companyStocks?: readonly CompanyStockCheck[];
}

const code = (s: string | number) => `\`${s}\``;
const row = (cells: readonly (string | number)[]) => `| ${cells.map(String).join(' | ')} |`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** 企业 ↔ 股票核对：KNOWN 为原版已知名称不一致（exe/mapData.ts KNOWN_NAME_MISMATCHES），不算失败 */
const STATUS_ICON: Record<CompanyStockCheck['status'], string> = { OK: ICON.pass, KNOWN: ICON.warn, BAD: ICON.fail };

const CLASS_LABEL: Record<IssueClass, string> = {
  error: '错误',
  pending: '待 exe 数据',
  warn: '警告',
};

export function renderProvenance(p: ProvenanceInput): string {
  const { build } = p;
  const g = build.geometry.report;
  const lat = g.lattice;
  const L: string[] = [];
  L.push(`# 原版数据提取 provenance 摘要（${p.mapKey}）`);
  L.push('');
  L.push(
    `> 由 ${code(p.command)} 生成，请勿手改。只含输入指纹、样本结论与几何统计，不含整图数据；` +
      `派生的 MapDef 在 ${code('.cache/extract/maps/')} 与 ${code('rich4-data/')}（均 gitignore）。`,
  );
  L.push('');

  L.push('## 1. 输入指纹');
  L.push('');
  if (p.fingerprint) {
    L.push(row(['文件', '字节', 'sha256', '登记 id', '版本', '状态']));
    L.push(row(['---', '---:', '---', '---', '---', '---']));
    for (const f of p.fingerprint.files) {
      L.push(row([f.path, f.size, code(f.sha256), f.knownId ?? '（未登记）', f.edition ?? '-', f.status]));
    }
    if (p.fingerprint.missing.length > 0) L.push('', `缺少必需文件：${p.fingerprint.missing.join('、')}`);
  } else {
    L.push(`（没有 ${code('.cache/extract/manifest.json')}，请先运行 ${code('npm run extract -- fingerprint')}）`);
  }
  L.push('');
  const src = build.semantic.source;
  L.push(
    `本图来源：${code(src.id)}，文件 sha256 ${code(src.fileSha256)}，地图资源 sha256 ${code(src.resourceSha256)}。`,
  );
  if (p.diff) {
    L.push(
      `多来源比较：规则相关差异 ${p.diff.rule} 项、表现相关差异 ${p.diff.presentation} 项；` +
        `字节完全相同的分组 ${p.diff.identicalGroups.map((gr) => `[${gr.join(', ')}]`).join(' ')}。`,
    );
  }
  L.push('');

  L.push('## 2. 样本校验（data-pipeline.md §10.1）');
  L.push('');
  if (p.samples.length > 0) {
    const base = p.samples[0]!;
    L.push(row(['样本', '期望', ...p.samples.map((s) => s.id)]));
    L.push(row(['---', '---', ...p.samples.map(() => ':---:')]));
    base.results.forEach((r, i) => {
      L.push(row([r.label, r.expected, ...p.samples.map((s) => ICON[s.results[i]?.status ?? 'fail'])]));
    });
  } else L.push('（未运行）');
  L.push('');

  L.push('## 3. exe 表：本图股票、节日与规则表核对（D2）');
  L.push('');
  const x = p.exeData ?? null;
  if (x) {
    L.push(
      `股票与节日取自 ${code(x.exeFile)}（${x.edition}，sha256 ${code(x.exeSha256)}）：股票模板表 ${code(x.stocksVa)} 的本图 ${x.stocks} 支、` +
        `节日表 ${code(x.holidaysVa)} 的本图 ${x.holidays} 条` +
        (x.dropped.length > 0 ? `（停用槽 ${x.dropped.join('、')} 原版查找时跳过，不输出）` : '') +
        (x.empty > 0 ? `，空槽 ${x.empty}` : '') +
        `。另一版本 exe 中本图数据：${x.crossEdition === 'same' ? '一致' : x.crossEdition === 'diff' ? '**不一致**' : '未比较'}。`,
    );
    const cs = p.companyStocks ?? [];
    if (cs.length > 0) {
      L.push('');
      L.push(`企业 ↔ 股票（企业 +0x19 行号）：${cs.map((c) => `${STATUS_ICON[c.status]} ${c.detail}`).join('；')}。`);
    }
  } else {
    L.push('（没有 exe 表：stocks/holidays 为空，见 §6 未决项）');
  }
  L.push('');
  const rules = p.rules ?? null;
  if (rules) {
    L.push('规则表「手录值 / v2.06 / v3.11 / 结论」矩阵（`npm run extract -- verify --tables`）：');
    L.push('');
    L.push(row(['表', '核对项', '手录', 'v2.06 与 v3.11', '结论']));
    L.push(row(['---', '---:', ':---:', '---', '---']));
    for (const v of rules.verdicts) {
      L.push(
        row([
          code(v.table),
          v.items,
          v.manual === 'ok' ? ICON.pass : v.manual === 'mismatch' ? ICON.fail : '（缺）',
          v.editions === 'same' ? '相同' : v.editions === 'diff' ? '不同' : '单版本',
          v.conclusion,
        ]),
      );
    }
    const badRefs = rules.verifyRefs.filter((r) => !r.ok).length;
    L.push('');
    L.push(`手录表 ${code('@verify')} 引用 ${rules.verifyRefs.length} 条，无法解析 ${badRefs} 条。`);
    for (const c of rules.checklist) L.push(`- 待对照：${c}`);
  }
  L.push('');

  L.push('## 4. 几何归一化统计（data-pipeline.md §8）');
  L.push('');
  L.push(row(['项目', '值']));
  L.push(row(['---', '---']));
  const items: [string, string][] = [
    ['格点模式', `${lat.mode}（T=${lat.tile}，原点 (${lat.origin.join(', ')})，transform ${lat.transform}）`],
    [
      'T=32 探测',
      `残差众数 (${lat.probe32.modeResidual.join(', ')})，覆盖率 ${pct(lat.probe32.coverage)}，` +
        `单位轴向边 ${lat.probe32.steps.unitAxial}/${g.routes.edges}`,
    ],
    ['世界坐标边方向', `轴向 ${lat.edgeDirections.axial}，斜向 ${lat.edgeDirections.diagonal}`],
    [
      '量化后边分类（拐角翻转、nodeCell 之前）',
      `单位轴向 ${lat.steps.unitAxial}、单位对角 ${lat.steps.unitDiagonal}、长直 ${lat.steps.longStraight}、` +
        `其他 ${lat.steps.other}、零长 ${lat.steps.zero}；节点同格 ${lat.score.collisions}`,
    ],
    ['对角边数（最终网格，均以 L 形 via 连接）', String(g.routes.diagonal)],
    [
      '连边方式',
      `直连 ${g.edgeKinds.unit}、长直 ${g.edgeKinds.straight}、L 形 ${g.edgeKinds.L}、绕行 ${g.edgeKinds.detour}、override ${g.edgeKinds.override}`,
    ],
    ['via 连接格', `${g.routes.viaCells} 格（${g.routes.viaEdges} 条边，单边最多 ${g.routes.maxVia}）`],
    ['拐角翻转', g.cornerFlips.length === 0 ? '无' : `节点 ${g.cornerFlips.join(', ')}`],
    [
      '住宅地朝向假设',
      `${g.facing.consistent}/${g.facing.samples} 一致（${pct(g.facing.consistency)}），${g.facing.enabled ? '已启用' : '未启用'}`,
    ],
    ['住宅地放宽 / 偏侧', `${g.landsRelaxed.join(', ') || '无'} / ${g.landsOffSide.join(', ') || '无'}`],
    ['紧凑', g.compact.enabled ? `删列 ${g.compact.removedCols.length}、删行 ${g.compact.removedRows.length}` : '关闭'],
    ['网格尺寸', `${g.bounds.w}×${g.bounds.h}（留白 ${g.bounds.margin}）`],
    [
      '地形',
      Object.entries(g.terrain)
        .map(([k, v]) => `${k}:${v}`)
        .join(' '),
    ],
    ['override 条数', String(g.overrides)],
    ['strict4', p.strict4 ? '已启用' : '未启用'],
    ['MapDef dataHash', code(build.def.meta.dataHash)],
    [`${p.mapKey}.map.json sha256`, code(p.mapFileSha256)],
  ];
  for (const [k, v] of items) L.push(row([k, v]));
  L.push('');

  L.push('## 5. validateMap 结果');
  L.push('');
  const counts = new Map<string, number>();
  for (const i of build.classified)
    counts.set(`${i.class}\u0000${i.code}`, (counts.get(`${i.class}\u0000${i.code}`) ?? 0) + 1);
  L.push(`ok = ${build.validation.ok}（error 以外的分类见下表；分类规则见 ${code('tools/extract/src/map/build.ts')}）`);
  L.push('');
  L.push(row(['分类', 'code', '数量']));
  L.push(row(['---', '---', '---:']));
  for (const [k, n] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const [cls, c] = k.split('\u0000') as [IssueClass, string];
    L.push(row([CLASS_LABEL[cls], code(c), n]));
  }
  const geoWarn = g.issues.filter((i) => i.severity !== 'info');
  if (geoWarn.length > 0) {
    L.push('', '几何告警：');
    for (const i of geoWarn) L.push(`- ${code(i.code)} ${i.msg}`);
  }
  const semIssues = build.semantic.issues;
  if (semIssues.length > 0) {
    L.push('', '语义层提示：');
    for (const i of semIssues) L.push(`- ${code(i.code)} ${i.msg}`);
  }
  L.push('');

  L.push('## 6. 未决项');
  L.push('');
  const pending = build.semantic.pending;
  const open: string[] = [];
  if (pending.length > 0) {
    open.push(
      `本图的 ${pending.join('、')} 需要从 exe 表抽取（先运行 exe tables 或提供 original/ 下的 RICH4.EXE），目前为空数组；因此企业的 stockIndex 在 validateMap 中悬空（分类「待 exe 数据」）。`,
    );
  }
  if (build.def.holidays.some((h) => h.kind === 2 && h.weekday === undefined)) {
    open.push('有 kind 2（该月第 n 个星期几）的节日缺 weekday 字段。');
  }
  if (lat.mode === 'fitted') {
    open.push(
      `格点为拟合模式（T=${lat.tile}），与「32 单位一格」的假设不符，请对照原版截图人工审阅 ${code(`.cache/extract/preview/${p.mapKey}.svg`)}。`,
    );
  }
  if (g.landsOffSide.length > 0)
    open.push(`住宅地 ${g.landsOffSide.join(', ')} 不在 facing 所指的一侧，可用 lot override 微调。`);
  open.push(`几何决定记录在 ${code(p.overridesPath)}；岛屿朝向（transform）尚未与原版截图核对。`);
  for (const o of open) L.push(`- ${o}`);
  L.push('');
  return `${L.join('\n')}`;
}
