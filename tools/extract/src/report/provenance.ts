import type { FingerprintReport } from '../fingerprint/identify';
import type { BuildResult, IssueClass } from '../map/build';
import type { SampleResult } from '../verify/samples';
import { ICON } from './table';

/**
 * docs/research/provenance-summary.md（入库，data-pipeline.md §10.2）：
 * 只写输入指纹、样本 ✅/❌、几何统计与未决项；不含整图数据、原始字节、时间戳，重复生成字节一致。
 */

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
}

const code = (s: string | number) => `\`${s}\``;
const row = (cells: readonly (string | number)[]) => `| ${cells.map(String).join(' | ')} |`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

const CLASS_LABEL: Record<IssueClass, string> = {
  error: '错误',
  pending: '待 D2 数据',
  contract: '契约缺口',
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

  L.push('## 3. 几何归一化统计（data-pipeline.md §8）');
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
    ['taiwan.map.json sha256', code(p.mapFileSha256)],
  ];
  for (const [k, v] of items) L.push(row([k, v]));
  L.push('');

  L.push('## 4. validateMap 结果');
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

  L.push('## 5. 未决项');
  L.push('');
  const pending = build.semantic.pending;
  const open: string[] = [];
  if (pending.length > 0) {
    open.push(
      `本图的 ${pending.join('、')} 需要从 exe 表抽取（D2），目前为空数组；因此企业的 stockIndex 在 validateMap 中悬空（分类「待 D2 数据」）。`,
    );
  }
  if (build.classified.some((i) => i.class === 'contract')) {
    open.push(
      '同一企业的多个落点格相距过远（大宇百貨的两个百貨公司格分处南北），MapDef 只有一个矩形，无法同时与两格相邻：需要 shared 的契约或 validateMap 放宽（分类「契约缺口」）。',
    );
  }
  if (lat.mode === 'fitted') {
    open.push(
      `格点为拟合模式（T=${lat.tile}），与「32 单位一格」的假设不符，请对照原版截图人工审阅 ${code('.cache/extract/preview/taiwan.svg')}。`,
    );
  }
  if (g.landsOffSide.length > 0)
    open.push(`住宅地 ${g.landsOffSide.join(', ')} 不在 facing 所指的一侧，可用 lot override 微调。`);
  open.push(`几何决定记录在 ${code(p.overridesPath)}；岛屿朝向（transform）尚未与原版截图核对。`);
  for (const o of open) L.push(`- ${o}`);
  L.push('');
  return `${L.join('\n')}`;
}
