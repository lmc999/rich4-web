# 原版数据提取与校验管线设计（tools/extract）

> 范围：从用户自有的 Steam 版《大富翁4》文件中提取**纯数据**（不含任何图片或音频），产出 `packages/shared` 可直接使用的 MapDef、规则表核对结果、`docs/research/version-diff.md` 和 provenance 报告。另设计一张手绘测试地图，让引擎、前端和服务器的开发不依赖原版文件。
> 约束：代码全部自研。GPL 仓库（mytbk、oama）只用来**阅读、理解格式**，不复制代码，也不内嵌从 GPL 源里抄来的表。解码所需的常量表在构建期从**用户自己的 rich4.exe** 中定位读取。本文件中的 VA 和偏移都是公开文档里的事实性地址，出处见各处 @source。

---

## 0. 结论速览（先看这里）

| 主题 | 结论 |
|---|---|
| **v2.06 地图的真实来源** | 巴哈姆特 bsn=972 snA=2227 帖指出，**`MapDat.mkf` 只有 v2.06 有**。rich4-spec 从 exe 的 `0x00407bc4` 查到：exe 先打开 `MAPDAT.MKF`，读资源号 **`global_map_id`**（不乘 2），打不开才退回 `map.mkf[gm*2+1]`。所以原版台湾图的**权威来源是 `Game/MapDat.mkf` 的资源 0**（如果 Steam 包里有这个文件）。管线会同时解析 `Game/MapDat.mkf[0]`、`Game/map.mkf[1]` 和 `MultiverseJourney/map.mkf[1]`，逐字段比对。 |
| **exe 指纹** | 调研给的 `5a90aee2…569550` 是 **mytbk 使用的 v3.11**（602,112 字节）。nurockplayer 实测记录的 Steam 版哈希**不一样**：`Game/RICH4.EXE` 为 `110b29f9…6a13`（v2.06），`MultiverseJourney/RICH4.EXE` 为 `50cb24bb…219f`（v3.11）。因此表定位**不能写死 VA**，一律用签名搜索加结构校验，已知偏移只作为快速路径提示。已知数据：Steam 版 MJ 的卡表在文件偏移 `0x7e3f2`，换算后 VA 为 `0x47fdf2`，与 mytbk 一致，说明布局相同，只有少量字节不同。 |
| MKF 解码 | 容器格式很简单：文件头 4 字节是索引表偏移，每个资源前有 16 字节头。私有压缩属于 **LZHUF 系列**（自适应 Huffman 编码 321 个符号，外加 12 位窗口位置码），比特流是 **LSB 优先**，**频度重标定的方式不标准**。我们自己写 TS 解码器，位置码表直接从用户 exe 中定位读取，并做不变量校验。nurockplayer 已核实 **`map.mkf` 里的地图结构资源都是未压缩记录**，所以解码器**不在台湾图的关键路径上**。它用于 MapDat.mkf（压缩与否待核实）和全量自检。 |
| 数据分三层 | `MapDataRaw`（逐字节忠实，1 基编号，保留 hex）→ `MapSemantic`（引擎语义）→ `MapDef`（语义加网格几何）。前两层放在 `.cache/`，不入库；MapDef 写到 `packages/shared/src/data/extracted/`，**默认 gitignore**。 |
| 规则表 | 卡片、道具、角色、开局表、设施上限、商店折价等**全局表手工录入**到 `packages/shared/src/data/rules/*.ts`（带 @source，入库）。管线负责**核对**它们，并比较 v2.06 与 v3.11，不作为数据源。只有**按地图的数据**（节点、地块、公司、该图 12 支股票、节日表）从文件生成。 |
| 几何归一化 | 原版节点坐标是世界坐标。exe 绘制时做 `>>5`，即 32 单位一块，与地面 72×72 块一一对应，所以格点就是地面块。管线自动检测格点，节点量化到格子；**非单位长度的边用 `via` 连接格绘制（这些格不是游戏格）**。地块占地的选取方法：住宅地用匈牙利算法指派到临路格，设施地选 2×2 的一侧，企业和景观就近放置矩形。最后叠加人工 `taiwan.overrides.json`，并用 `validateMap` 兜底。 |
| 版本对比 | 表级对比：卡片、道具、角色、股票、开局表、节日、设施上限、魔法屋、商店系数、rand 常量逐字段比较。代码级对比：以 exe 内的函数指针表（新闻 36、命运 49、卡片/道具 43、落点 17 …）为种子配对函数，规范化指令后比较，差异常量自动列出。radare2 为可选项。 |
| 仓库卫生 | `original/`、`.cache/`、`extracted/` 永不入库。CI 只用手绘 fixture。生产镜像**只含代码和 fixture**，真实数据通过 `rich4-data/` 只读卷挂载，避免把原版派生数据烘进镜像。 |

---

## 1. 用户操作指引：取文件、拷贝、登记指纹

### 1.1 找到 Steam 安装目录（在装有游戏的 Windows PC 上）
- 最稳的办法：在 Steam 库里右键「大富翁4」，选「管理 → 浏览本地文件」，会直接打开安装根目录。
- 也可以查 Steam 库目录下的 `steamapps\appmanifest_2059810.acf`，其中 `"installdir"` 字段就是 `steamapps\common\<installdir>`。默认库在 `C:\Program Files (x86)\Steam\steamapps\common\`，其他库一般在 `X:\SteamLibrary\steamapps\common\`。
- 按 nurockplayer 的记录，安装根目录下应该有 `Game\`（原版 v2.06）、`MultiverseJourney\`（超时空之旅 v3.11）、`DxWnd\` 和 `Media\`。nurockplayer 的根目录名是 `dfw4cskzl_136622`，你的可能不同，以实际为准。

### 1.2 需要拷贝的文件（大小写不敏感，工具按名匹配）

| 必需 | 路径（相对安装根目录） | 用途 | 约计大小 |
|---|---|---|---|
| ✅ | `Game\RICH4.EXE` | v2.06 数据表和代码对比 | 约 0.6 MB |
| ✅ | `Game\map.mkf` | v2.06 的回退地图数据（资源 1/3/5/7） | 待测 |
| ✅（**存在就必须拷**） | `Game\MapDat.mkf`（原名可能是 `MAPDAT.MKF`） | **v2.06 真正使用的地图结构**（资源号 = gm） | 待测，应该很小 |
| ✅ | `MultiverseJourney\RICH4.EXE` | v3.11 数据表（公开逆向资料基于这一版） | 约 0.6 MB |
| ✅ | `MultiverseJourney\map.mkf` | v3.11 地图（资源 1..15 中的奇数号） | 约 76.6 MB |
| 可选 | `MultiverseJourney\Data.mkf` | 只用于解码器自检（mytbk 提供了 Data.mkf 的 sha1 和逐资源 golden） | 约 54 MB |
| ❌ 不要拷 | `Speaking/Panel/jump/Effect/help.mkf`、`Media\`、`DxWnd\`、`*.avi`、`*.mid`、`SAVE*.DAT` | 图像、音频、视频，本项目不使用 | — |

### 1.3 先在 Windows 端记录指纹（PowerShell）
```powershell
$root = "D:\SteamLibrary\steamapps\common\<installdir>"   # 按实际修改
Get-ChildItem $root -Recurse -File -Include *.exe,*.mkf |
  Get-FileHash -Algorithm SHA256 | Select-Object Hash, Path | Format-Table -AutoSize
```

### 1.4 从局域网 PC 拷到本机（三选一）
- **SMB**：在 Windows 上把上面几个文件复制到一个新文件夹，比如 `D:\rich4-share`，然后右键「属性 → 共享 → 高级共享」，**只读**共享给你的账户。在 Mac 上用 Finder 的「前往 → 连接服务器」输入 `smb://<PC的IP>/rich4-share`，再拖到 `<repo>/original/`。
- **scp**：在 Mac 的「系统设置 → 通用 → 共享」里打开「远程登录」。Windows 10/11 自带 OpenSSH 客户端，在 PowerShell 里执行：
  `scp "$root\Game\RICH4.EXE" "$root\Game\map.mkf" "$root\Game\MapDat.mkf" dev@<Mac的IP>:<repo>/original/Game/`
  MultiverseJourney 的文件同样处理。
- **U 盘**：格式化为 exFAT，按下面的目录结构直接拷贝。

### 1.5 本机目录结构（保留 Steam 相对路径，避免版本混淆）
```
<repo>/original/        # .gitignore；工具只读
  Game/RICH4.EXE  Game/map.mkf  Game/MapDat.mkf
  MultiverseJourney/RICH4.EXE  MultiverseJourney/map.mkf  [MultiverseJourney/Data.mkf]
```
拷完后运行 `npm run extract -- fingerprint`。工具会计算 sha256，与 `tools/extract/known-files.json` 比对，并把本地基线写入 `tools/extract/fingerprints.lock.json`（**只含哈希，入库**）。也可以手动核对：`shasum -a 256 original/*/*`。

**已知指纹**（公开事实，写入 `known-files.json`）：

| id | 版本 | sha256 | 来源 |
|---|---|---|---|
| `steam.game.exe` | v2.06 | `110b29f9d2fadcff3836eb69ec380aa264951859c90955da6e11158d2f956a13` | nurockplayer/richman4-remake `docs/calendar-and-setup.md` |
| `steam.mj.exe` | v3.11 | `50cb24bbbd86353e26127e8e89e891c437984655d338a32f1458a3b79596219f` | 同上 |
| `ref.mytbk.exe` | v3.11（mytbk 所用，602,112 字节） | `5a90aee28ee5f7a5c3ba5cb935c9e55751a529c25fcd91208748a66293569550` | mytbk/rich4 `r2/rich4_dump.py` |
| `ref.mytbk.datamkf` | Data.mkf | sha1 `639dab8f896ea1d18bfda5309a4c7e0d7a990254` | mytbk `csrc/mkf/test/Data.mkf.sha1` |

**判定规则**：匹配 Steam 哈希即通过。只匹配 mytbk 哈希也可以（VA 快速路径完全可用）。哈希未知时报 `exit 3`；加 `--allow-unknown` 后改走纯签名定位，并在报告中标黄。

---

## 2. 目录与文件清单

```
rich4/
├─ original/                          # gitignore：用户正版文件（只读）
├─ .cache/extract/                    # gitignore：raw JSON、原始资源副本、预览 SVG、中间结果
├─ rich4-data/                        # gitignore：部署用数据包（extract pack 生成，compose 只读挂载）
├─ docs/research/
│  ├─ version-diff.md                 # 入库：v2.06 与 v3.11 的差异报告（事实与哈希，不贴整段反汇编）
│  └─ provenance-summary.md           # 入库：样本校验、表核对结论、输入指纹（不含整图数据）
├─ scripts/check-no-original.ts       # CI 守卫：禁止原版文件和派生原始数据入库
├─ tools/extract/                     # workspace 包 @rich4/extract（private，任何 app 不得依赖）
│  ├─ package.json                    # bin: rich4-extract；deps: @rich4/shared(workspace)；dev: opencc-js@1.4.2、fast-check@4
│  ├─ tsconfig.json  README.md        # README = 本文 §1 的操作指引
│  ├─ known-files.json                # 已知指纹与各版本表偏移提示（公开事实）
│  ├─ fingerprints.lock.json          # 本项目基线输入指纹（首次运行生成，入库）
│  ├─ anchors/
│  │  ├─ tables.json                  # 表定位签名（按文本或数值定义，不含原始字节块）和 v3.11 参考 VA
│  │  ├─ seeds.json                   # 函数配对种子：指针表名称、元素数、语义名（新闻#0..35 …）
│  │  └─ constants.json               # 规则常量锚点：规则 id → v3.11 指令位置 → 期望值
│  ├─ maps/
│  │  ├─ overrides.schema.json        # 由 zod schema 导出
│  │  └─ taiwan.overrides.json        # 入库：只含我们的几何决定和引用编号，不含原版数值
│  ├─ src/
│  │  ├─ cli.ts                       # 子命令分发（node:util parseArgs）
│  │  ├─ context.ts                   # 路径解析、只读守卫（拒绝写入 --src 之下）、日志、退出码
│  │  ├─ io/{hash.ts,readOnly.ts,writeCanonicalJson.ts}
│  │  ├─ fingerprint/{scan.ts,identify.ts}
│  │  ├─ bin/{reader.ts,big5.ts,f32.ts}
│  │  ├─ mkf/{container.ts,lzhuf.ts,lzhufTables.ts,headers.ts}   # headers 只读 SPR/SMP/GND 头做统计，不解像素
│  │  ├─ pe/{pe.ts,scan.ts}           # PE 节表、VA 与文件偏移互转、带通配的字节模式搜索、Big5 字符串索引
│  │  ├─ exe/
│  │  │  ├─ locate.ts                 # 签名 → 候选 → 结构校验 → 唯一化
│  │  │  ├─ xrefTransfer.ts           # 把 v3.11 中引用某地址的代码模式迁移到 v2.06
│  │  │  ├─ tables/{cards,tools,characters,stocks,setup,holidays,facilityLevels,magicHouse,pointerTables,shopFactor,rand,lzTables}.ts
│  │  │  ├─ r2.ts                     # 可选：spawn r2/radiff2，解析 JSON
│  │  │  ├─ funcdiff.ts               # 函数配对、规范化、比较
│  │  │  └─ strings.ts                # 两版 Big5 字符串全集比较
│  │  ├─ map/
│  │  │  ├─ parseRaw.ts               # → MapDataRaw
│  │  │  ├─ rawDiff.ts                # 多来源逐字段比较
│  │  │  ├─ semantic.ts               # → MapSemantic
│  │  │  ├─ geometry/{lattice,quantize,routeEdges,placeFacilities,placeCompanies,placeLands,hungarian,placeLandmarks,terrain,compact,normalize}.ts
│  │  │  ├─ overrides.ts              # zod 校验与应用
│  │  │  ├─ i18n.ts                   # zh-TW 原文；zh-CN 由 opencc-js 做 t→s
│  │  │  └─ build.ts                  # 组装 MapDef、计算 dataHash、validateMap
│  │  ├─ verify/{samples.ts,rulesAgainstExe.ts}
│  │  └─ report/{versionDiff.ts,provenance.ts,previewSvg.ts}
│  └─ test/
│     ├─ helpers/{buildMkf.ts,buildMapResource.ts,buildPe.ts,lzhufEncode.ts}   # 仅测试用的合成器
│     ├─ unit/*.test.ts               # CI 跑，全部用合成数据
│     └─ local/*.local.test.ts        # 需要 original/，没有时自动 skip
└─ packages/shared/src/data/
   ├─ maps/{types.ts,schema.ts,validate.ts,ids.ts}      # MapDef 契约、zod schema、validateMap（纯函数、零 IO）
   ├─ fixtures/{ascii.ts,testMap.ts,test-map.json,test-map-allkinds.json}   # 手绘测试图（入库）
   ├─ rules/{cards,tools,characters,setup,facility,shop,rng}.ts   # 手工录入、带 @source（入库）
   ├─ extracted/                       # gitignore：maps/taiwan.map.json、manifest.json、provenance/*.json
   └─ index.ts
```

与生产隔离：
- `.dockerignore` 排除 `original/ .cache/ tools/ rich4-data/ packages/shared/src/data/extracted/`。
- Biome 的 `noRestrictedImports` 禁止在 `apps/**` 和 `packages/**` 中 import `@rich4/extract`。

---

## 3. CLI 用法与每步输出、校验

根 `package.json` 增加：`"extract": "tsx tools/extract/src/cli.ts"`（tsx 4.23.x，本机 Node 24.9 可用）。

```bash
npm run extract -- fingerprint [--src original/] [--allow-unknown]
npm run extract -- mkf ls --file original/Game/map.mkf [--json]
npm run extract -- mkf selftest [--src original/] [--file …/Data.mkf]     # 全量解码，只校验不落盘
npm run extract -- map raw   --map 0 [--sources auto|all] [--dump-bin]     # → .cache/extract/raw/
npm run extract -- map diff  --map 0                                       # → .cache/extract/diff/map0.json
npm run extract -- exe tables [--edition v206|v311|all]                    # → .cache/extract/tables.<ed>.json
npm run extract -- exe diff  [--r2] [--r2-timeout 120]                     # → docs/research/version-diff.md
npm run extract -- map build --map taiwan [--overrides tools/extract/maps/taiwan.overrides.json] [--strict4] [--preview]
npm run extract -- verify                                                  # 手录规则表与提取值、样本 → provenance
npm run extract -- pack --out rich4-data/                                  # 部署数据包（只含 MapDef 与 manifest）
npm run extract -- fixture                                                 # 重新生成 fixtures/*.json（不需要原版文件）
npm run extract -- all                                                     # 以上全部，任何一步失败即停
```
通用参数：`--src`（默认 `original/`）、`--out`（默认 `packages/shared/src/data/extracted`）、`--cache`（默认 `.cache/extract`）、`--json`（机器可读输出）、`--dry-run`、`--verbose`。

退出码：0 成功；1 校验失败；2 缺少输入；3 指纹未知；4 发现版本差异但没有 `--accept-diff`；5 需要 override（几何无解）。

| 步骤 | 输入 | 输出 | 必过的校验 |
|---|---|---|---|
| fingerprint | original/ | `.cache/extract/manifest.json`、`fingerprints.lock.json` | 必需文件齐全；sha256 已知（或已允许未知）；PE 头合法；没有 `.bind` 这类壳节（有则告警 SteamStub） |
| mkf ls/selftest | *.mkf | 资源清单（下标、偏移、两个大小、签名 SPR/SMP/GND/无） | §4.2 的容器不变量；每个压缩资源解码后长度 = 头部原始大小；终止条件干净；Data.mkf 的 sha1 匹配时比对 mytbk golden |
| map raw | MapDat/map.mkf | `raw/<source>/map0.raw.json`（加 `--dump-bin` 另存 .bin） | §5.4 的结构不变量全部成立 |
| map diff | 多个 raw | `diff/map0.json` | 规则相关字段不同时 exit 4 |
| exe tables | 两个 exe | `tables.v206.json`、`tables.v311.json` | 每张表唯一定位且结构校验通过 |
| exe diff | 两个 exe 和 tables | `version-diff.md` 及同名 `.json` | 种子配对率不低于 95%；未配对的列出 |
| map build | raw、semantic、overrides | `extracted/maps/taiwan.map.json`、`extracted/manifest.json`、`provenance/taiwan.provenance.json`，外加 `.cache/extract/preview/taiwan.svg` | `validateMap` 无 error；样本全过；重复生成字节一致 |
| verify | rules/*.ts 和 tables | `docs/research/provenance-summary.md` | 手录值与**选定基线版本**的提取值一致 |
| pack | extracted/ | `rich4-data/{manifest.json,maps/*.json}` | dataHash 复算一致 |

输出规范：JSON 键名排序、2 空格缩进、LF、文件末尾有换行；**数据文件里没有时间戳**（`generatedAt` 只写进报告），所以相同输入产出的字节必定相同。

---

## 4. MKF 容器与私有压缩（自研方案）

参考过的公开文档：mytbk `csrc/mkf/mkf-format.md`（格式描述）；mytbk `csrc/mkf/mkf_decompress.c` 和 oama `packages/assets-pipeline/src/mkf*.ts`（只读，用于理解算法）；nurockplayer `docs/assets.md`（边界校验思路）；rich4-spec `map-format.md` §6.1（exe 的读取算法）。**不复制代码和表**。

### 4.1 容器结构（小端）
```
u32 indexTableOffset                       // 文件头
[资源数据块...]                             // 第一个资源从偏移 4 开始
indexTable @ indexTableOffset .. EOF: u32[N] // 每项是资源的绝对起始偏移
资源块 = { u32 rawSize; u32 storedSize; u32 imageOffset; u32 imageSize } + storedSize 字节
        storedSize == rawSize → 未压缩；否则为私有压缩
```

### 4.2 容器不变量（`container.ts`）
1. `4 ≤ indexTableOffset < fileSize`，且 `(fileSize - indexTableOffset) % 4 == 0`。
2. `index[0] == 4`，并且 index 严格递增。
3. 对每个 i：`index[i] + 16 + storedSize ≤ next`，其中 next 是 `index[i+1]`（最后一项则取 `indexTableOffset`）。nurockplayer 核对的是严格等式，这里等式成立记为 OK，不等只告警。
4. 如果最后一项 `== indexTableOffset`，视为**哨兵**（资源数为 N−1），报告里注明。
5. 非图像资源的 `imageOffset` 和 `imageSize` 都是 0；图像资源满足 `imageOffset + imageSize ≤ rawSize`。

```ts
export interface MkfEntry { index: number; offset: number; rawSize: number; storedSize: number; imageOffset: number; imageSize: number; compressed: boolean; kind: 'SPR'|'SMP'|'GND'|'data'|'unknown' }
export class MkfArchive { static open(bytes: Uint8Array, name: string): MkfArchive; entries(): readonly MkfEntry[]; read(i: number, codec?: LzhufCodec): Uint8Array; }
```

### 4.3 私有压缩：LZHUF 系列变体（我们的理解和伪代码）
- **符号层**：321 个符号。0..255 是字面字节；256..320 表示复制长度 = 符号 − 253，即 3..67。符号用**自适应 Huffman 树**编码：T = 641 个节点，根 R = 640。初始状态与经典 LZHUF 的起始树相同：叶频度都为 1，内部节点逐对合并。
- **位置层**：窗口 4096，偏移是 12 位值 `d`，复制源为 `out[o − 1 − d]`。高 6 位用一套固定前缀码表示（码长分布 3:1、4:3、5:8、6:12、7:24、8:16，共 64 个码），低 6 位原样读取。`d == 0xFFF` 是流结束标记。
- **比特序**：字节内 **LSB 优先**。这与经典 LZHUF 的 MSB 优先不同，位置码的码字分配也不同。
- **非标准重标定**：根频度**恰好等于** 0x8000 时触发。做法是先把每个频度为奇数的叶子各 bump 一次，使其变成偶数，再把 0..640 所有节点的频度右移 1 位，**不重建树**。
- **位置码表来源**：两张 256 项的查找表，POS_LEN（码长）和 POS_HI（高 6 位），是**在用户 exe 里定位读取的**。v3.11 的参考 VA 是 POS_HI 在 `0x483430`、POS_LEN 在 `0x483530`，初始树表紧随其后，从 `0x483630` 开始（mytbk 源码注释给出的地址）。
  - v2.06 按签名找：POS_LEN 是一个 16 字节模式重复 16 次；POS_HI 是它前面的 256 字节。
  - 读出后校验三项不变量：(a) 相同的前 L 位得到相同的 HI 值（即确实是前缀码）；(b) 64 个值恰好各出现一次；(c) 码长分布同上。
  - 另外，我们用算法生成初始树，换算成 exe 的字节偏移形式（son 和 prnt 存储值为 ×2），与 exe 中 `+0x200` 处的内容逐字比较，以此证明我们对初始状态的理解正确。

```text
init():
  for s in 0..320: freq[s]=1; son[s]=s+T; leafPos[s]=s        // leafPos 即 prnt[s+T]
  i=0; for j in 321..640: freq[j]=freq[i]+freq[i+1]; son[j]=i; parent[i]=parent[i+1]=j; i+=2
  freq[641]=0xFFFF; parent[640]=0
bump(s):                                  // 从叶节点本身开始，一直走到根
  c = leafPos[s]
  do:
    k = ++freq[c]
    if k > freq[c+1]:                     // 破坏了有序性：与同频度块的最后一个节点交换
      l = c+1; while freq[l+1] == k-1: l++
      swap(freq[c], freq[l])
      a = son[c]; b = son[l]
      setParent(a, l); setParent(b, c)    // setParent(x,p): x≥T → leafPos[x-T]=p，否则 parent[x]=parent[x+1]=p
      son[c]=b; son[l]=a; c = l
    c = parent[c]
  while c != 0
rescale(): for s in 0..320: if freq[leafPos[s]] & 1: bump(s)
           for n in 0..640: freq[n] >>= 1
decodeSym(): n = son[R]; while n < T: n = son[n + bit()]
             s = n - T; if freq[R] == 0x8000: rescale(); bump(s); return s
decodePos(): w = u32le(src, pos>>3) >>> (pos & 7)           // 输入末尾补 4 个 0 字节
             L = POS_LEN[w & 0xFF]; hi = POS_HI[w & 0xFF]; lo = (w >>> L) & 0x3F
             pos += L + 6; return (hi << 6) | lo
decompress(src, rawSize):
  out = new Uint8Array(rawSize); o = 0
  while o < rawSize:
    s = decodeSym()
    if s < 256: out[o++] = s; continue
    d = decodePos(); if d == 0xFFF: endedByMarker = true; break
    from = o - 1 - d; if from < 0: throw MkfError('E_BACKREF')
    n = min(s - 253, rawSize - o); for k in 0..n-1: out[o++] = out[from + k]  // 逐字节复制，允许重叠
  assert pos ≤ storedSize*8 + 32
  return { out, bits: pos, endedByMarker }
```

```ts
export interface LzhufTables { posHi: Uint8Array; posLen: Uint8Array; source: { edition: string; va: number } }
export function locateLzhufTables(exe: PeImage): LzhufTables      // 找不到或不变量失败时抛错
export function lzhufDecompress(src: Uint8Array, rawSize: number, t: LzhufTables): { out: Uint8Array; bits: number; endedByMarker: boolean }
```

**正确性保证**：
- ① CI 中：测试专用的**自写编码器**（`test/helpers/lzhufEncode.ts`，按上面的状态机镜像实现编码）对随机数据做往返测试，覆盖重标定、重叠复制和长度截断。测试用的位置表由生成器随机构造一套满足不变量的前缀码，不依赖原版。
- ② 本地：两版 mkf 中全部压缩资源（nurockplayer 统计两版合计 878 个）解码后长度正确、没有越界、终止位置合理。
- ③ 本地可选：如果 Data.mkf 的 sha1 等于 `639dab8f…`，把资源 4..43 的 sha1 与 mytbk 公开的 golden 列表比对（只比哈希，不引入其数据）。

---

## 5. 地图结构解析（MapDataRaw）

参考：mytbk `docs/map.txt`、`asm/rich4_map.h`、`csrc/land.h`；oama `docs/map-format.md`；rich4-spec `docs/systems/map-format.md`（它从 exe 重新核对字段，并列出勘误）；nurockplayer `docs/assets.md` 和 `docs/fidelity.md`。

### 5.1 资源定位
- v2.06 主路径：`MapDat.mkf[global_map_id]`。回退路径：`map.mkf[gm*2+1]`。
- v3.11：只有 `map.mkf[gm*2+1]`（发行版中没有 MapDat）。
- 台湾：gm = 0。

### 5.2 头部（40 字节 = 10 个 u32）和表布局
`[nodeCount, nodeOff, landCount, landOff, facCount, facOff, comCount, comOff, scapeCount, scapeOff]`。每张表都是 **1 基**，第 i 项在 `off + i*stride`；**第 0 项是全 0 的哨兵**，因此每张表实际有 count+1 项。

### 5.3 字段表（✔ 表示 exe 或多源已证实；？表示需在用户文件上核实）

**节点（stride 0x28）**

| 偏移 | 类型 | 字段 | 备注 |
|---|---|---|---|
| 0x00/0x02 | i16 | x, y | 世界坐标；exe 绘制时 `>>5` ✔ |
| 0x04 | char[≤20] | name | Big5，以 NUL 结尾；实测最长 10 字节 ✔ |
| 0x18 | u16×4 | adj[slot0..3] | 1 基节点号，0 表示无；**槽位顺序有意义** ✔ |
| 0x20 | u16 | type | 取值区间都是开区间：0 特殊格；(2000,4000) 住宅 i；(4000,6000) 设施；(6000,8000) 企业；(8000,10000) 景观。8001 和 8002 是医院、监狱的关押格 ✔ |
| 0x22 | u16 | decor | 装饰精灵的下标（渲染用，我们不用），只保留在 raw 里 ✔ |
| 0x24 | u32 | flags | 低字节 = 落点码 0..16 ✔；bit31 = 禁放物件（`noItems`，随机取空格时用掩码 0x80ffff00）✔；**bit(30−k) = 槽 k 静态封路**（oama provenance V-14 引用 exe 0x40b221/0x40b343 的 `0x40000000>>k`）？需用台湾两个岔路核实 |

**住宅地（stride 0x34）**

| 偏移 | 类型 | 字段 | 备注 |
|---|---|---|---|
| 0x00/0x02 | i16 | x, y | |
| 0x04 | char[≤19] | name | 同一街道按原始字节比较（strcmp）✔ |
| 0x17 | u8 | 涨价/查封状态 | 运行期字段，文件中为 0 |
| 0x18 | u8 | 连锁店标记 | 运行期字段，文件中为 0 |
| 0x19 | u8 | owner | 运行期字段，文件中为 0 |
| 0x1a | u8 | level | 运行期字段，文件中为 0 |
| 0x1b | u8 | facing 0..7 | 朝向？oama 称 exe 0x4091af 的用法是 `(8-(v+视角))&7`，需核实 |
| 0x1c | u16 | landPrice | mytbk 的 `rich4_map.h` 与 `land.h` 在此处**互相矛盾**，用台北 2500 裁决 ✔？ |
| 0x1e | u16 | housePrice | 用台南 300/500 核实 |
| 0x20 | u16×6 | rent[0..5] | exe 0x419796 ✔ |
| 0x2c | u32 | — | 运行期，被传送机清零 |
| 0x30 | u32 | flast | 运行期 |

**设施（stride 0x38）**

| 偏移 | 类型 | 字段 | 备注 |
|---|---|---|---|
| 0x04 | name | — | |
| 0x18 | u8 | 设施类型 | 运行期 |
| 0x19 | u8 | owner | 运行期 |
| 0x1a | u8 | level | 运行期 |
| 0x1b | u8 | facing | ？ |
| 0x1c | u8 | 状态 | 运行期；是 **1 字节**，与住宅地 0x1c 不同义 ✔ |
| 0x1d/0x1e | u8 | 研发项目 / 研发天数 | 运行期 |
| 0x22 | u16 | landPrice | |
| 0x24 | u16×6 | rateWindow | **下标 0 = housePrice，1..5 = 各级费率**（exe 0x41a429 按 `+0x24+level*2` 寻址） |
| 0x30 | u32 | — | 运行期 |
| 0x34 | u32 | flast | 运行期；与住宅地的 0x30 不同 |

**企业（stride 0x34）**

| 偏移 | 类型 | 字段 | 备注 |
|---|---|---|---|
| 0x04 | name | — | |
| 0x18 | u8 | owner | 运行期 |
| 0x19 | u8 | stockIndex | **0 基** ✔ |
| 0x1a | u8 | industry | 7 = 银行 ✔（exe 0x436b31）；1 航空、2 饭店、3 电子、4 保险、5 汽车、6 石油、10 百货、11 建设、12 门派为目视归纳？ |
| 0x1b | u8 | facing | ？ |
| 0x1c..0x1f | u8×4 | 持股排名 | 运行期 |
| 0x20 | u16 | 建筑精灵资源号 − 0x26 | 不用 |
| 0x22 | u16 | tollBase | 收费基数 |
| 0x24 | u32 | assetValue | 公司资产；股价均值回归的锚点 = assetValue/10000；台灣人壽应为 400000 ？ |
| 0x28/0x2c | i32 | 本月 / 累计盈余 | 运行期 |
| 0x30 | u32 | 自留股 | 运行期，由加载代码算出 |

**景观（stride 0x1c）**

| 偏移 | 类型 | 字段 | 备注 |
|---|---|---|---|
| 0x04 | char[≤20] | name | |
| 0x18 | u8 | facing | ？ |
| 0x19 | — | — | |
| 0x1a | u16 | spriteRes | 不用 |

**17 类落点**（flags 低字节）：0 地产/无；1 公园；2 新闻；3 命运；4 监狱（保释）；5 医院（保释）；6 企鹅挖宝；7 七彩气球；8 喜从天降；9 乐透；10 得 50 点；11 得 30 点；12 得 10 点；13 卡片；14 银行；15 百货公司；16 魔法屋。
- 编码与名称的对应，是 oama 用节点名交叉验证得出的。我们**再用节点名复核一遍**，期望名称表写在 `semantic.ts`，不一致的报出来。
- 银行和百货格的 type 同时是企业（type 为 6000+i，落点码为 14/15），两种身份都要保留。

**Big5 解码**：`new TextDecoder('big5', { fatal: true })`，本机 Node 24.9 已验证能解码 `a5 64 a4 f9 …` 得到「卡片魔法屋」。另外枚举全部双字节码建立反向表做**回编码校验**，能发现 HKSCS 与 CP950 的歧义字。原始字节以 hex 保留在 raw 层。

### 5.4 MapDataRaw schema（`.cache/extract/raw/<source>/map<gm>.raw.json`）
```ts
export type EditionId = 'v206' | 'v311' | 'unknown';
export type RawSourceId = 'v206-mapdat' | 'v206-mapmkf' | 'v311-mapmkf';
export interface TableRef { count: number; offset: number; stride: number }
export interface RawName { hex: string; text: string | null; roundtrip: boolean }
export interface RawNode { id: number; x: number; y: number; name: RawName; adj: [number, number, number, number]; type: number; decor: number; flags: number; hex: string }
export interface RawLand { id: number; x: number; y: number; name: RawName; b17: number; b18: number; b19: number; b1a: number; facing: number; landPrice: number; housePrice: number; rent: [number, number, number, number, number, number]; u2c: number; u30: number; hex: string }
export interface RawFacility { id: number; x: number; y: number; name: RawName; b18: number; b19: number; b1a: number; facing: number; b1c: number; b1d: number; b1e: number; landPrice: number; rateWindow: [number, number, number, number, number, number]; u30: number; u34: number; hex: string }
export interface RawCompany { id: number; x: number; y: number; name: RawName; owner: number; stockIndex: number; industry: number; facing: number; ranking: [number, number, number, number]; spriteRes: number; tollBase: number; assetValue: number; funds: number; profit: number; shares: number; hex: string }
export interface RawLandscape { id: number; x: number; y: number; name: RawName; facing: number; b19: number; spriteRes: number; hex: string }
export interface MapDataRaw {
  schema: 'rich4.map-raw/1';
  source: { id: RawSourceId; edition: EditionId; file: string; fileSha256: string; container: 'MapDat.mkf' | 'map.mkf'; resource: number; compressed: boolean; byteLength: number; resourceSha256: string };
  globalMapId: number;
  header: { nodes: TableRef; lands: TableRef; facilities: TableRef; companies: TableRef; landscapes: TableRef };
  nodes: RawNode[]; lands: RawLand[]; facilities: RawFacility[]; companies: RawCompany[]; landscapes: RawLandscape[];
  checks: Record<string, { ok: boolean; detail?: string }>;
}
```

**结构不变量**（任何一条失败都是 exit 1）：
- 五张表的间距 = (count+1)×stride。
- `byteLength == scapeOff + (scapeCount+1)*0x1c`。
- 哨兵项全 0。
- `adj` 的值 ≤ nodeCount，且邻接对称（不对称时报 warn 并在 links 上标注）。
- type 解析后的编号在对应表的范围内。
- 住宅地的 0x17..0x1a 全为 0，企业的运行期字段全为 0。说明读到的是干净的地图模板，而不是存档里被写过的地图块。

### 5.5 多来源比较（`rawDiff.ts`）
对每条记录逐字段比较，分成两类：
- **规则相关**：adj、type、flags（低字节、bit27–31）、价格、租金、费率、stockIndex、industry、tollBase、assetValue、名称字节、计数。
- **表现相关**：x、y、decor、facing、spriteRes。

结论写入 `diff/map0.json` 和 version-diff.md §3。**MapDat 与 map.mkf 如果有规则相关差异，默认 exit 4**，需要用户明确选择基线，写入 overrides 的 `source.id`。

---

## 6. 从 exe 提取固定数据表，并对比 v2.06 与 v3.11

### 6.1 PE 与扫描基础（`pe/*.ts`，零依赖）
- 解析 DOS 头 → `e_lfanew` → COFF 头 → 可选头（ImageBase 应为 0x400000）→ 节表，由此实现 `vaToOff` 和 `offToVa`。
- 可以与 `rabin2 -S -j` 交叉核对，这一步可选。
- **Big5 字符串索引**：扫描数据节中以 NUL 结尾、能严格解码的串，建立 `Map<va, text>` 和反向的 `Map<text, va[]>`。比较时去掉文本中的空格，因为角色名里有空格，例如「約 翰 喬」。
- **模式搜索**：支持通配字节；指针搜索即在数据节中找 u32 LE 等于某个 VA 的位置。

### 6.2 表清单与定位签名（写在 `anchors/tables.json`，全部版本无关）

| 表 | v3.11 参考 VA / 文件偏移提示 | 定位签名 | 结构校验 |
|---|---|---|---|
| 卡片 30×8 | 0x47fdf2（MJ 文件偏移 0x7e3f2，Game 文件偏移 0x7c152） | 找指向「均富卡」的指针 p，且 p+8 指向「均貧卡」 | 30 项的名称指针都指向以「卡」或「符」结尾的串；初始张数之和 = 100 |
| 道具 13×8 | 卡表 + 240（MJ 0x7e4e2，Game 0x7c242） | 首项指向「機器娃娃」 | 前 8 项库存为 10，后 5 项为 0 |
| 节日 8(或4)×24×12 | 道具表 + 104（0x47ff4a） | 与道具表相邻，并校验记录 | 月份 1..12、日 1..31；按 24 项一块计数，直到校验失败 → 得到图数 |
| 角色 12×0x68 | 0x47e80c（MJ 0x7ce0c，Game 0x7b22c） | 指向「約翰喬」（去空格后比较）且 stride 为 0x68 | +0x13 依次为 0..11；+0x19 现金比例在 40..80 |
| 股票 n×36 | 0x47f072 | 首项指向「中國信託」，stride 36 | +12/+16/+20 三个 f32 相等（都是初始价）；项数应为 48 或 96 |
| 开局三表 u32×6 | MJ 文件偏移 0x6b194/0x6b1e8/0x6b200；Game 0x69640/0x69694/0x696ac | 数值序列 [300000,200000,100000,50000,30000,10000]、[0,730,365,182,91,30]、[0,100,50,10,5,3] | 各自唯一 |
| 设施等级上限 | 0x474940 | 用 xrefTransfer 迁移 | 值为 公园 1、旅馆 5、购物中心 5、加油站 1、研究所 5 |
| 魔法屋 12×16 | 0x475718 | 用 xrefTransfer 迁移，名称指针 +12 | 12 个名称都能解码 |
| 函数指针表 | 卡片/道具 0x475d5c（43）、新闻 0x475e24（36）、命运 0x475ef0（49）、AI 出卡 0x475324（44）、落点跳表 0x4197e9（17） | 用 xrefTransfer 迁移 | 所有项都指向 .text |
| 商店折价 double 0.9 | MJ 0x464364/0x46436c，Game 0x462350/0x462358 | 通过 xref 找到 double 值 | 值等于 0.9 |
| 月息 double 1.1/0.1 | 0x464e88 / 0x464ea0 | 同上 | |
| rand 常量 | .text 中的 imm32 0x41C64E6D 和 0x3039 | 立即数搜索 | 两版一致（决定 PRNG 的保真度） |
| LZHUF 位置码表 | 0x483430 / 0x483530 | 见 §4.3 | §4.3 的不变量 |

**xrefTransfer 算法**（用于迁移没有文本签名的表）：
1. 在 v3.11 的 .text 中找所有等于表 VA 的 imm32 或 disp32，取前后各 12 字节作为模式。模式中**落在映像范围内的 4 字节值一律改成通配**。
2. 在 v2.06 的 .text 中搜索这个模式，要求**唯一命中**。
3. 读出同一位置的 imm32，得到 v2.06 的表 VA。
4. 用上表的结构校验确认。
5. 如有多个引用点，要求各引用点迁移出的结果一致。

### 6.3 抽取结果类型（`tables.<ed>.json`）
```ts
export interface ExtractedTables {
  edition: EditionId; exeSha256: string; locate: Record<string, { va: string; fileOffset: string; method: 'hint' | 'signature' | 'xref'; checks: string[] }>;
  cards: { id: number; name: string; initCount: number; price: number; f6: number; f7: number }[];          // id 1..30
  tools: { id: number; name: string; stock: number; price: number; f6: number; f7: number }[];             // id 1..13
  characters: { id: number; name: string; color: number; b16: number; personality: number /* +0x17 */; loanRatio: number /* +0x18 */; initCashRatio: number /* +0x19 */; stockRatio: number /* +0x1a */; hex: string }[];
  stocks: { index: number; mapId: number; name: string; hasCompany: number; float: number; priceF32: string; volatilityF32: string; price: number; volatility: number; hex: string }[];
  setup: { funds: number[]; days: number[]; wealthMultipliers: number[] };
  holidays: { mapId: number; slot: number; hex: string; month: number; day: number; kind: number; flags: number }[];  // 12 字节布局待核实
  facilityMaxLevel: number[]; magicHouse: { slot: number; name: string; hex: string }[];
  pointerTables: Record<'cardTool' | 'news' | 'fate' | 'aiCard' | 'landing', string[]>;
  constants: { shopSell: number; monthlyInterest: number; randMul: string; randAdd: string };
  lzhuf: { posHiSha256: string; posLenSha256: string };
}
```

### 6.4 代码级对比（`funcdiff.ts`，radare2 可选）
1. **种子配对**：同名指针表的第 k 项，在 v2.06 和 v3.11 中视为同一个函数。
2. **反汇编**：开启 `--r2` 时执行 `r2 -q -2 -e bin.relocs.apply=true -c "af @ <va>; pdfj @ <va>" <exe>` 取 JSON；不开时用 .text 中的原始字节比较，粒度较粗。
3. **规范化**：每条指令保留助记符和操作数；落在映像范围内的地址替换为符号化 token（能映射到已知表或字符串的，替换为「表名[偏移]」或「串:文本」，否则为 `ADDR`）；小立即数保留。
4. **比较**：做 LCS 对齐，结果分三类：`same`（完全一致）、`const`（结构相同，只有立即数不同，列出每个差异，例如 `push 0x2710 → push 0x1388`）、`struct`（结构不同，给出相似度，不贴整段反汇编）。
5. **扩散**：已配对函数中，处在同一对齐位置的 `call` 目标自动成为新的配对，迭代到不动点。
6. **交叉核对**：执行 `radiff2 -A -C` 取全局函数相似度，标出与我们配对结果冲突的项。可选：用 binary-diff 技能把 mytbk/oama 标注的 v3.11 符号名批量迁移到 v2.06，产出 `anchors/symbols.v206.json`（只含地址与名称，入库），让报告更可读。
7. **规则常量锚点**（`anchors/constants.json`）：每条形如 `{ "id":"news.11.incomeTaxPct","rule":"rules/news.ts#INCOME_TAX_PCT","v311":{"fn":"news[11]","va":"0x…","insnIndex":n,"operand":0},"expect":5 }`。在 v3.11 上验证期望值；在 v2.06 上借助配对函数和 LCS 对齐找到对应指令并读值。结果进入 verify 和 version-diff。

### 6.5 `docs/research/version-diff.md` 结构
1. 输入指纹（两个 exe、两个 map.mkf、MapDat 的哈希和大小）。
2. 容器：资源数、压缩资源数、MapDat 是否存在、解码自检结果。
3. 地图：先写台湾，再写 1..3。包括计数、规则相关差异、表现相关差异，并解释社区所说「v3.11 保留 MapDat 时 2.06 地图显示异常」（推测是精灵资源号偏移造成的）。
4. 固定表：每张表给出「一致」或逐项差异。重点复核卡价，nurockplayer 称两版 43 项完全一致，这样 Fandom 上嫁祸、红卡、涨价、同盟四张卡的价格差异可以判为 wiki 错误。
5. 代码行为：种子配对率，并按系统（落点、卡片、道具、新闻、命运、魔法屋、AI）分别统计 same、const、struct 的数量，列出 const 差异明细。
6. 字符串差异：新增、删除、改动的 Big5 串，优先列与规则相关的文案。
7. 结论：哪些差异影响规则、推荐默认值、哪些可以做成「房间可选的 v2.06 规则开关」的候选。

---

## 7. 语义层（MapSemantic）
- **节点 → Tile**：`kind` 由落点码映射，码为 0 时，有引用的算 `property`，否则算 `plain`；`ref` 指向住宅、设施、企业或景观；`links` 取 adj 中非 0 的槽，**按槽号顺序排列**；`blocked` 取 `flags & (0x40000000 >> slot)`；`noItems` 取 bit31。
- **街道**：住宅地按**原始名称字节**分组。id 形如 `S01…`，按首次出现的顺序编号；空名也照原样成组，与原版 strcmp 的语义一致。
- **关押格**：type 8001 的节点对应医院，8002 对应监狱。对应的景观记录成为 landmark，其 `holdTile` 指向该节点。
- **企业**：industry 保留原值，另外映射一个 key。其前沿格是所有 type 为 6000+k 的节点。
- **本图股票**：取 `stocks.slice(gm*12, gm*12+12)`。价格存成整数「分」（f32 乘 100 后四舍五入，写入前断言恰好是整数）；波动系数保留 f32 位型的 hex，另给一个十进制值。
- **本图节日**：取 24 项。原始 flags 全部保留；只有已核实的位才解释为 `closed`（休市）、`giveCard`（送卡）、`bgm`，其余位在 `flagsRaw` 里原样保留。
- **不修正原版数据瑕疵**。例如台南第 1 块房价 500。规则基准就是原版程序的行为。

---

## 8. 几何归一化：世界坐标 → MapDef 网格

### 8.1 格点检测（`lattice.ts`）
```text
T = 32                                         // exe 绘制时 `>>5` 的证据
rx = hist(x mod T), ry = hist(y mod T)         // 取众数残差 (ox, oy) 和覆盖率 cov
edgeSteps = { (Δx/T, Δy/T) : (u,v) ∈ E }       // 按 单位轴向 / 单位对角 / 长直 / 其他 分类
若 cov ≥ 0.95 且单位轴向边 ≥ 90%            → mode='tile'
否则 T' = 边长直方图的众数（候选 16/32/48/64）→ mode='fitted'，并在报告中要求人工确认
cell(p) = round((p - o) / T)，再经 transform（identity/rot90/rot180/rot270/flipX/flipY，由 override 选择，决定台湾在等角视图里的朝向）
```

### 8.2 流程（`normalize.ts`，每一步都记录决策和问题，写入 GeometryReport）
1. **放置路格**。cell 重叠时报 `E_CELL_COLLIDE`，必须用 `nodeCell` override 处理。
2. **连边**（`routeEdges.ts`）：
   - 单位轴向：直接相连。
   - 长直边：内部格作为 `via` 连接格。
   - 单位对角或其他：候选两种 L 形折线，选肘点空闲、且不是任何地块目标格的那一种。仍有并列时，按 (x,y) 字典序选。
   - override `edgeRoute` 可以直接指定折线。
   - 连接格记入 `roadCells`。它们**不是游戏格**，只用于绘路和走路动画插值。
3. **设施 2×2**（`placeFacilities.ts`）：两个前沿格必须 4-相邻且共线。在共线段的两侧各取一个 2×2 候选，选中心离 `facility(x,y)/T` 最近、且全部空闲的一侧。都不行则报 `E_LOT_NO_CELL`，需要 `lot.F<n>.side` 或 `rect` override。
4. **企业**（`placeCompanies.ts`）：候选尺寸为 [2×2, 3×2, 2×3, 3×3, 1×1] 的矩形，要求与每个前沿格 4-相邻、全部空闲，按「与世界坐标的距离 + 面积惩罚」取最小值。可用 `rect` override 覆盖。
5. **关押地标**：医院和监狱是 2×2，必须与 holdTile 相邻。
6. **住宅地 1×1**：用匈牙利算法做指派（`placeLands.ts` 和 `hungarian.ts`）。
   ```text
   候选(i) = { c ∈ N4(frontTile(i)) : c 空闲 ∧ manhattan(c, want_i) ≤ 2 }，其中 want_i = cell(land_i.x, land_i.y)
   cost(i,c) = 10·manhattan(c, want_i) + facingPenalty(i,c) + ε·order(c)
   facingPenalty：先在「want_i 本身就与前沿格相邻」的样本上统计 facing→方向 的映射，
                  若映射一致性 ≥ 90% 则启用（方向不符罚 3）；否则为 0，并在报告里给出统计
   用匈牙利算法求最小总代价（地块数 ≤ 73，秒级以内）；有地块的候选为空时报 E_LOT_NO_CELL
   ```
7. **风景地标**（阿里山、佛光山等）：默认 2×2，从世界坐标出发螺旋搜索空闲矩形，找不到就降为 1×1。`kind` 按名称关键词加 override 决定，风景统一为 `scenery`。
8. **可选紧凑**（`compact.ts`，由 override 的 `compact` 开启）：删除没有任何元素、也没有任何边或矩形跨越的整行、整列，保持所有相邻关系不变。
9. **边界与地形**（`terrain.ts`）：包围盒四周留 2 格边距，并平移到原点。地形默认草地 `g`；到最近占用格的 Chebyshev 距离 ≥ 4 的格为水 `w`，等于 3 的为沙 `s`，结果是确定的。`terrain.paint` override 可以局部涂改。
10. **自检**：执行 `validateMap(strict4: --strict4)`，并生成预览 SVG（左边是世界坐标下的点和线，右边是网格结果，问题处用红圈标出）。预览是我们自己画的示意图，不含原版图像。

### 8.3 overrides schema（`tools/extract/src/map/overrides.ts`，zod；按原版编号引用，不含原版数值）
```ts
export const MapOverridesSchema = z.object({
  mapKey: z.string(),                       // 'taiwan'
  source: z.object({ id: z.enum(['v206-mapdat','v206-mapmkf','v311-mapmkf']), expectResourceSha256: z.string().optional() }),
  lattice: z.object({ tile: z.number().default(32), origin: z.tuple([z.number(), z.number()]).optional(), transform: z.enum(['identity','rot90','rot180','rot270','flipX','flipY']).default('identity') }).partial(),
  compact: z.boolean().default(false),
  nodeCell: z.record(z.string() /* 节点号 */, z.tuple([z.number(), z.number()])).default({}),
  edgeRoute: z.record(z.string() /* "57-58" */, z.array(z.tuple([z.number(), z.number()]))).default({}),
  lot: z.record(z.string() /* 'L12'|'F2'|'C1' */, z.object({ cell: z.tuple([z.number(), z.number()]).optional(), side: z.enum(['a','b']).optional(), rect: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional() })).default({}),
  landmark: z.record(z.string() /* 景观号 */, z.object({ kind: z.enum(['hospital','jail','scenery']).optional(), rect: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(), hidden: z.boolean().optional() })).default({}),
  terrain: z.object({ paint: z.array(z.object({ rect: z.tuple([z.number(), z.number(), z.number(), z.number()]), t: z.enum(['g','w','s','p','m']) })) }).partial().default({}),
  expect: z.object({ nodes: z.number(), lands: z.number(), facilities: z.number(), companies: z.number(), landscapes: z.number() }).partial().optional(),
});
```
如果 override 引用的编号不存在，或指定的格子冲突，一律报错（exit 5）。`expectResourceSha256` 用来在输入变化时让旧的 override 失效，避免把旧决定套到新数据上。

### 8.4 `validateMap`（`packages/shared/src/data/maps/validate.ts`，纯函数，服务器加载时和测试时都会调用）
```ts
export type MapIssueCode =
  | 'E_ID_DUP' | 'E_LINK_TARGET' | 'E_LINK_ASYM' | 'E_SLOT_DUP' | 'E_BLOCKED_NOT_LINK' | 'E_CELL_COLLIDE'
  | 'E_RECT_INVALID' | 'E_OUT_OF_BOUNDS' | 'E_OVERLAP' | 'E_LOT_FRONT_NOT_ADJ' | 'E_LOT_NO_FRONT'
  | 'E_TILE_REF_MISMATCH' | 'E_STREET_NAME' | 'E_RENT_SHAPE' | 'E_PRICE_RANGE' | 'E_UNREACHABLE'
  | 'E_HOLD_MISSING' | 'E_TERRAIN_SHAPE' | 'E_COUNT_MISMATCH' | 'E_VIA_BROKEN'
  | 'W_DIAGONAL_LINK' | 'W_VIA_LONG' | 'W_RENT_NONMONO' | 'W_DEADEND' | 'W_NAME_EMPTY' | 'W_LINK_ONEWAY'
  | 'W_COMPANY_REMOTE_FRONT'    // architecture §16.2
  | 'E_HOLIDAY_FIELD';          // architecture §18.5；以 validate.ts 的 MAP_ISSUE_CODES 为准
export interface MapIssue { code: MapIssueCode; severity: 'error' | 'warn'; path: string; msg: string; tiles?: number[]; cells?: Cell[] }
export function validateMap(map: MapDef, opts?: { strict4?: boolean; expect?: Partial<MapCounts> }): { ok: boolean; issues: MapIssue[] };
```
检查项：
- 编号唯一；links 的目标存在，且除标注 oneWay 的外都是对称的；同一格没有重复槽号；blocked 的槽确实是一条边。
- 格子、地块、地标、连接格两两不重叠，都在边界内，矩形尺寸为正。
- 每块地块至少有一个前沿格，且与每个前沿格 4-相邻；`tile.ref` 与地块反向一致。例外（architecture §16.2）：企业只要有一个前沿格与建筑相邻，落点码 14/15（银行格、百货格）的远端前沿格只报 `W_COMPANY_REMOTE_FRONT`（warn）。
- 同一街道内名称相同；rent 有 6 项且都 ≥ 0（不单调只报 warn）；设施的 rateWindow 有 6 项。
- 所有可走格在无向图上连通；有死路时报 warn（原版遇死路会原路返回）。
- 关押格存在；terrain 是 h 行、每行 w 字符；计数与 `expect` 一致。
- 节日：kind 2（第 n 个星期 w）必须带 0..6 的 `weekday` 且 day 为 1..5，其他 kind 不带 `weekday`；`lunar` 标记与 kind 一致（`E_HOLIDAY_FIELD`）。
- `strict4` 模式下出现对角 link 即为 error，否则只报 warn。

---

## 9. MapDef 契约（`packages/shared/src/data/maps/types.ts`，schemaVersion 1）
```ts
export type TileId = number;                       // = 原版节点号（1 基）；fixture 也用 1 基
export type LotId = `L${number}` | `F${number}` | `C${number}`;   // 住宅地 / 设施 / 企业（沿用原版 1 基编号）
export interface Cell { x: number; y: number }     // +x → 等角屏幕的 SE，+y → SW（与 client iso/projection 一致）
export interface Rect { x: number; y: number; w: number; h: number }
export type TileKind = 'property' | 'plain' | 'park' | 'news' | 'fate' | 'jail' | 'hospital' | 'penguin' | 'balloon'
  | 'gift' | 'lottery' | 'points50' | 'points30' | 'points10' | 'card' | 'bank' | 'shop' | 'magic';
export interface TileLink { to: TileId; slot: 0 | 1 | 2 | 3; blocked: boolean; via?: Cell[] }  // blocked：从本格经此槽出发被禁止
export interface TileDef {
  id: TileId; cell: Cell; kind: TileKind; landingCode: number /* 0..16 原值 */;
  ref?: { lot?: LotId; landmark?: string };
  links: TileLink[];                    // ★ 按原版槽号升序；引擎在岔路用它的顺序作为 rand()%n 的候选顺序
  noItems: boolean;                     // flags bit31：禁止随机放置物件、神明、礼物，也不能作为开局落点
  holdFor?: 'hospital' | 'jail';
  nameKey?: string;
  src?: { x: number; y: number; flags: number };   // 原值，用于调试和回溯；fixture 中可省略
}
interface LotBase { id: LotId; rect: Rect; frontTiles: TileId[]; facing?: number; nameKey: string }
export interface LandLot extends LotBase { kind: 'land'; streetId: string; landPrice: number; housePrice: number; rent: [number, number, number, number, number, number] }
export interface FacilityLot extends LotBase { kind: 'facility'; landPrice: number; housePrice: number; rateWindow: [number, number, number, number, number, number] }  // rateWindow[0]===housePrice
export interface CompanyDef extends LotBase { kind: 'company'; industry: number; industryKey: IndustryKey; stockIndex: number; tollBase: number; assetValue: number }
export type IndustryKey = 'airline' | 'hotel' | 'electronics' | 'insurance' | 'auto' | 'oil' | 'bank' | 'dept' | 'construction' | 'sect' | 'unknown';
export interface LandmarkDef { id: string; kind: 'hospital' | 'jail' | 'scenery'; rect: Rect; nameKey: string; holdTile?: TileId }
export interface StreetDef { id: string; nameKey: string; lots: LotId[] }
export interface StockDef { index: number; nameKey: string; hasCompany: boolean; float: number; initPriceCents: number; volatility: number; volatilityF32: string }
export interface HolidayDef { slot: number; month: number; day: number; kind: number; flagsRaw: number; closed?: boolean; giveCard?: boolean; bgm?: boolean }
export interface MapDef {
  schemaVersion: 1; id: string; globalMapId: number | null; nameKey: string;
  grid: { w: number; h: number }; terrain: string[];              // g/w/s/p/m
  tiles: TileDef[]; roadCells: Cell[];
  lots: (LandLot | FacilityLot)[]; companies: CompanyDef[]; landmarks: LandmarkDef[]; streets: StreetDef[];
  stocks: StockDef[]; holidays: HolidayDef[];
  decorations: { kind: 'tree' | 'rock' | 'flower'; cell: Cell; variant: number }[];
  strings: Record<'zh-TW' | 'zh-CN', Record<string, string>>;     // nameKey → 文本；前端 i18n 按图合并
  meta: { source: { id: string; fileSha256: string; resourceSha256: string } | { fixture: true }; counts: MapCounts; dataHash: string; generator: string };
}
export interface MapCounts { nodes: number; lands: number; facilities: number; companies: number; landscapes: number }
```
- **dataHash**：对 MapDef 的规范化 JSON（排除 `meta.dataHash`）取 sha256，由 tools 端计算，服务器加载时复算。
- **nameKey 格式**：`map.<id>.street.S03`、`map.<id>.tile.57`、`map.<id>.company.C1`、`map.<id>.landmark.2`、`map.<id>.stock.4`。
- **与 design_client §3.1 的差异**：
  - `next/prev` 改为无向的 `links`。原版没有固有行进方向：棋子始终向前走，转向卡会使其掉头，所以有向的 next/prev 无法表达。
  - `LotDef.cells` 改为 `rect`。
  - 新增 `companies`、`holdFor`、`roadCells` 和 `via`。
  - 用户已决定岔路始终随机，`ForkChooser` 只用来显示结果，不再用于做选择。

---

## 10. 校验样本与 provenance

### 10.1 台湾样本（`verify/samples.ts`；出处见 @source）
| 样本 | 期望 | 出处 |
|---|---|---|
| 计数 | nodes 103 / lands 50 / facilities 4 / companies 3 / landscapes 21 | rich4-spec map-format §6.2；nurockplayer fidelity.md（两个版本目录都是这个数） |
| 台北市（名称接受「台北市」或「臺北市」） | 4 块；landPrice 2500；rent [500,1200,3000,7500,16000,30000] | oama `toll.test.ts`；r_property |
| 新竹市 | landPrice 1000；rent [200,500,1200,2800,6000,10000] | 同上 |
| 台南市 | 4 块；landPrice 1500；按编号顺序 housePrice 为 [500,300,300,300]；rent [300,750,2000,4800,10000,18000] | oama `known-deviations.md` |
| 规则 | 所有住宅地 rent[0] 等于 landPrice 的 20%（启发式，偏离只报 warn） | 实测归纳 |
| 企业 | 中國信託 industry=7、stockIndex=0；台灣人壽 assetValue=400000（除以 10000 等于初始股价 40） | oama map.ts 注释；stocks 表 |
| 关押格 | type 8001 节点引用景观 1（期望名「醫院大樓」），8002 引用景观 2（期望名「綠島」） | r_rules_map，需核实 |
| 静态封路 | 恰好 2 个岔路节点带封路位，且被封的槽非 0 | r_rules_map §5（「台湾图两个岔路各封一条」） |
| Big5 | 所有非空名称都能严格解码，并能回编码成原字节 | nurockplayer fidelity.md |
| 角色表 | 现金比例 50,40,70,60,40,70,50,40,60,50,55,80 | nurockplayer calendar-and-setup.md；mytbk |
| 卡片 / 道具 | 与 `rules/cards.ts`、`rules/tools.ts` 的手录值一致，初始张数之和为 100 | mytbk card/tool table；r_references |

### 10.2 provenance 输出
- `extracted/provenance/taiwan.provenance.json`（gitignore）：MapDef 的每个数值字段都记录 `{ source: RawSourceId, file, sha256, resource, recordId, byteOffset, rawHex }`。
- `docs/research/provenance-summary.md`（入库）：记录输入指纹、样本逐条结果（✅/❌）、每张规则表的「手录值 / v2.06 / v3.11 / 结论」矩阵、几何统计（格点模式、对角边数、连接格数、override 条数），以及未决项。**不包含整图数据**。
- 手录规则 TS 的 JSDoc 同时写两类出处：`@source mytbk asm/rich4_card_table.c; oama data/cards.ts; 说明书 p.x` 和 `@verify extract:cards[19].price v206=… v311=…`。verify 步骤会检查 `@verify` 引用的条目确实存在。

---

## 11. 手绘测试地图 fixture（入库，与原版无关）

`packages/shared/src/data/fixtures/testMap.ts` 用 ASCII 布局和声明表生成 MapDef，再由 `npm run extract -- fixture` 写出 `test-map.json`。**槽号规则固定为 N=0、E=1、S=2、W=3**。

网格 12×9，其中 20 个可走格，布局如下（两位数字是 TileId）：
```
y\x  0   1   2   3   4   5   6   7   8   9  10  11
 0   .   .   .   .   .   .   .   .   .   .   .   .
 1   B   B   .   .   .   .  a1  a2  a3   .   .   .
 2   B   B  01  02  03  04  05  06  07   .   .   .
 3   .   .  18   F   F  19   ~   ~  08   .   .   .
 4   .   .  17   F   F  20   ~   ~  09   .   .   .
 5   .   .  16  15  14  13  12  11  10   D   D   .
 6   .   .   H   H   J   J  b2  b1   .   D   D   .
 7   .   .   H   H   J   J   .   .   .   .   .   .
 8   .   .   .   .   .   .   .   .   .   .   .   .
```

| Tile | 格 | kind（落点码） | 说明 |
|---|---|---|---|
| 01 | (2,2) | bank(14) | 企业 C1「测试银行」industry 7、stockIndex 0，建筑 B = rect(0,1,2,2) |
| 02 / 03 | (3,2)/(4,2) | news(2) / fate(3) | |
| 04 | (5,2) | card(13) | **岔路**，邻接 03、05、19；**04→19 静态封路**（S 槽 blocked） |
| 05/06/07 | (6..8,2) | property | 街道 A「测试大道」三块住宅地 L1–L3，lots 为 a1–a3 = (6,1)/(7,1)/(8,1)；landPrice 2000、housePrice 500、rent [400,1000,2500,6000,12000,24000] |
| 08 / 09 | (8,3)/(8,4) | lottery(9) / magic(16) | |
| 10 | (8,5) | shop(15) | 企业 C2「测试百货」industry 10、stockIndex 2，建筑 D = rect(9,5,2,2) |
| 11/12 | (7,5)/(6,5) | property | 街道 B「样例街」L4/L5，lots 为 b1 (7,6)、b2 (6,6)；landPrice 1200、housePrice 300、rent [240,600,1500,3600,7200,12000]。其中 L5 的 housePrice 故意设为 350，用来复现「同街房价不一致」这类原版瑕疵 |
| 13 | (5,5) | points30(11) | **岔路**，邻接 12、14、20，随机 |
| 14 | (4,5) | jail(4) | holdFor jail；地标 J = rect(4,6,2,2) |
| 15 | (3,5) | hospital(5) | holdFor hospital；地标 H = rect(2,6,2,2) |
| 16 | (2,5) | penguin(6) | |
| 17/18 | (2,4)/(2,3) | property | 设施 F1 的前沿格；F1 = rect(3,3,2,2)，landPrice 4000，rateWindow [800,600,1500,3500,7000,13000] |
| 19/20 | (5,3)/(5,4) | balloon(7) / gift(8) | 捷径；只能从 13 进入（04→19 被封） |

- 地形：`~`（(6..7, 3..4)）是池塘 `w`，其余为 `g`。另有 12 支虚构股票（测试银行、测试人寿、测试百货…）和 2 条节日（1/1 休市、12/25 送卡）。
- 覆盖面：随机岔路、一侧被封的岔路、汇合点、2×2 设施、两条街道的同街累加、企业兼落点码 14/15、两个关押格、13 种特殊格。
- `test-map-allkinds.json`（26 格）在上图基础上加一条向右的**死路支线**：公园(1)、得 50 点(10)、得 10 点(12)、`plain` 各一格；一家保险企业 C3（两个前沿格）；以及一条带 `via` 连接格的长边。这样可以覆盖全部 17 类落点、死路折返和连接格渲染。

---

## 12. 法律与仓库卫生

- **.gitignore**：`/original/`、`/.cache/`、`/rich4-data/`、`packages/shared/src/data/extracted/`、`**/*.mkf`、`**/*.MKF`、`**/RICH4.EXE`、`**/SAVE*.DAT`。
- **CI 守卫** `scripts/check-no-original.ts` 扫描 git 跟踪的文件，拒绝以下情况：
  - 扩展名为 `.mkf/.exe/.dll/.avi/.mid`；
  - sha256 出现在 `fingerprints.lock.json` 里的文件；
  - 路径位于 `data/extracted/`（除非设了 `RICH4_ALLOW_EXTRACTED_COMMIT=1`，这就是「私有仓库入库」开关）；
  - JSON 中出现 `hex` 或 `rawHex` 字段（只允许出现在 `test/`）；
  - 超过 64 KB 的 base64 串（防止夹带图像或音频）。
- **只读保证**：`context.ts` 把 `--src` 解析为真实路径，任何写操作如果目标落在它下面就直接抛错；读取一律用 `fs.open(…, 'r')`。单测会验证这条守卫。
- **生产与部署**：Docker 镜像只含代码和 fixture，便于推送到镜像仓库。真实数据由 `extract pack` 生成到 `rich4-data/`，compose 用 `./rich4-data:/data/rich4:ro` 挂载，服务器读 `RICH4_DATA_DIR`。目录缺失时只提供 fixture 地图，并在日志中告警。
- **风险告知**：MapDef（坐标、地名、价格）会下发到每个联机玩家的浏览器，实质上等于公开分发了从原作派生的**事实性数据**。它不含图像或音频，风险低于素材，但不是零。股票表里的真实公司名属于商标，建议默认通过 i18n 改名。
- **CI**：`RICH4_DATASET=fixture`；`test/local/**` 发现没有 `original/` 时自动 skip。

---

## 13. 测试方案

| 层 | 用例（全部 vitest） | 是否需要原版 |
|---|---|---|
| bin/pe | 合成 PE 头测试 VA 与文件偏移互转、越界处理；f32 位型往返 | 否 |
| mkf/container | 合成 MKF：哨兵、非递增索引、越界、未压缩读取 | 否 |
| mkf/lzhuf | 自写编码器加随机前缀码表：做 1e3 组随机缓冲往返，覆盖触发重标定（≥0x8000 次更新）、重叠复制、截断、结束标记 | 否 |
| big5 | 用公开文档里的字节序列（「卡片」「魔法屋」「銀行」）验证解码；验证回编码能发现歧义字 | 否 |
| map/parseRaw | `buildMapResource()` 合成资源：1 基与哨兵、stride、边界、type 开区间 | 否 |
| geometry | 合成图：①轴向网格 ②对角边 ③长边 ④住宅地候选冲突，由匈牙利算法解开 ⑤设施侧选择 ⑥格子碰撞时报错。fast-check：随机生成网格上的平面图，normalize 后 validateMap 必过、确定性输出一致、override 能生效 | 否 |
| validateMap | fixture 能通过；对 fixture 做 25 种变异，每种命中预期的 issue code | 否 |
| fixture | 生成器重复运行字节一致；引擎冒烟：从每个格、每个来向出发的前进候选集与手算表一致（包括被封的岔路） | 否 |
| local | 指纹；两个来源的台湾 raw 都通过 §5.4 的不变量；§10.1 样本全过；12 张地图全部能解析；两版表定位都唯一；verify 退出码为 0；`map build` 两次输出字节一致；解码器全量自检 | 是 |
| CI 守卫 | `check-no-original` 对样例违规文件报错 | 否 |

---

## 14. 需要在用户正版文件上核实的项
1. Steam 安装根目录名，以及是否确实有 `Game/`、`MultiverseJourney/`；**`Game/` 下有没有 `MapDat.mkf`**，它的资源数，**地图结构资源是否压缩**。
2. 两个 RICH4.EXE 的 sha256 是否等于 nurockplayer 记录的 `110b29f9…`、`50cb24bb…`，以及与 mytbk 的 `5a90aee2…569550` 有什么差异（差异字节的位置和范围）。另外有没有 SteamStub 或其他壳节。
3. MKF 索引表最后一项是否是哨兵；map.mkf 的资源数（v3.11 应为 298）；两版压缩资源数（合计约 878）。
4. 台湾的三份来源（v206-MapDat[0]、v206-map.mkf[1]、v311-map.mkf[1]）逐字段是否一致，尤其是价格、租金、邻接、flags、企业字段；并解释「v3.11 保留 MapDat 时地图显示异常」的具体原因。
5. 住宅地 0x1c 是地价、0x1e 是房价（mytbk 两个头文件互相矛盾），以及租金在 0x20..0x2b；设施的 rateWindow 在 0x24..0x2f、flast 在 +0x34。
6. 企业的 0x19 股票下标、0x1a 行业码（除 7 以外的对应关系）、0x22 收费基数、0x24 资产值（台灣人壽是否为 400000）。
7. flags：低字节与节点名是否一致；**bit(30−k) 是否就是槽 k 的封路位**（台湾应恰好 2 处）；bit31 共多少节点。
8. +0x1b 等 facing 字段是否表示朝向，以及 facing 与「地块到路格的方向」有没有稳定映射。
9. 世界坐标格点：x、y 对 32 取模的残差分布；相邻节点是否都是单位轴向；有没有对角边或长边；有没有两个节点落在同一个 32 格里。
10. 邻接是否全部对称；8001/8002 节点是否可走、是否兼有落点码 5/4、它们引用的景观名称。
11. 台北、新竹、台南三个样本，以及 103/50/4/3/21 这组计数。
12. 卡片和道具表两版是否逐字节一致（nurockplayer 称 43 项相同），以此裁决 Fandom 的 4 张卡价。
13. 角色表 12×0x68 各字段两版是否一致：+0x16（全为 3？）、+0x17 性格、+0x18 借贷比例、+0x19 现金比例、+0x1a 炒股比例、颜色。
14. 股票表在 v2.06 中有 48 项还是 96 项；台湾 12 支是否一致；f32 价格是否都是整数分。
15. 开局三张表的数值，以及**默认资金档位的索引**（代码常量；存档实证是 300000，nurockplayer 称索引 1 即 200000，两者冲突）。
16. 节日表每项 12 字节的布局和各标志位含义（休市、送卡、换 BGM），以及 v2.06 的图数。
17. 设施等级上限表、魔法屋表、商店 0.9 系数、月息 1.1、rand 常量，在两版中的位置和值。
18. 新闻、命运、魔法屋、卡片、道具、落点处理函数在两版之间的常量差异（由 funcdiff 给出）。
19. 所有地名 Big5 回编码是否一致；有没有 HKSCS 与 CP950 的歧义字。
20. （可选）Data.mkf 的 sha1 是否为 `639dab8f…`，匹配时用 mytbk 的 golden 验证解码器。

---

## 15. 实施顺序（约 8 人日）
1. **E0（1 天，不需要原版）**：`maps/types.ts`、zod schema、`validateMap`、ASCII fixture 生成器和两份 fixture JSON。这一步先交付，让引擎、前端、服务器可以立即开工。
2. **E1（0.5 天）**：CLI 骨架、只读守卫、fingerprint、PE 解析、MKF 容器，以及 `mkf ls`。
3. **E2（1 天）**：`map raw`、`map diff`、台湾样本校验。拿到真实数据后，先按 §14 的 1–11 项逐条确认。
4. **E3（1.5 天）**：表定位与 xrefTransfer、`exe tables`、`verify`，以及手录的 `rules/*.ts`。
5. **E4（2 天）**：几何归一化、overrides、预览 SVG、`map build`、`pack`，并与服务器的 DataRegistry 联调。
6. **E5（1 天）**：funcdiff（可选 r2）、constants 锚点、`version-diff.md`。
7. **E6（1 天）**：LZHUF 解码器和自写编码器测试、`mkf selftest`；如果 MapDat 是压缩的，这一项要提前到 E2 之前。

---

## 16. 参考来源（只读参考，未复制代码）
- mytbk/rich4：`csrc/mkf/mkf-format.md`、`csrc/mkf/mkf_decompress.c`、`csrc/mkf/test/*.sha1`、`docs/map.txt`、`asm/rich4_map.h`、`csrc/land.h`、`asm/rich4_{card,tool}_table.c`、`asm/rich4_characters.c`、`asm/rich4_all_stocks.c`、`r2/rich4_dump.py`
- oama1111/rich4-remake-public：`docs/map-format.md`、`packages/core/src/loaders/map.ts`、`packages/assets-pipeline/src/mkf.ts`、`packages/data/src/{projection,binary-truth.test,event-table}.ts`、`packages/core/src/places/calendar.ts`、`docs/audit/provenance-ai-move.md`
- oama1111/rich4-spec：`docs/systems/map-format.md`（§1.2 MAPDAT 主路径、§4 字段、§6 统计与勘误）、`docs/systems/data-tables.md`
- nurockplayer/richman4-remake：`docs/assets.md`、`docs/fidelity.md`、`docs/calendar-and-setup.md`、`docs/original-inventory.md`（Steam 目录结构、两版 exe 哈希与表偏移、「地图资源未压缩」）
- 巴哈姆特 bsn=972 snA=2227（MapDat.mkf 为 v2.06 独有）；chiuinan 大富翁4 页（Steam 同时含 2.06 与 3.11、DxWnd）


## key_decisions
- 台湾图的权威来源按 exe 的真实加载路径确定：v2.06 优先读 Game/MapDat.mkf[0]，没有这个文件才用 Game/map.mkf[1]；同时解析 v3.11 的 map.mkf[1] 逐字段比较。规则相关字段有差异时默认停下（exit 4），由用户选定基线 — rich4-spec 在 exe 0x00407bc4 查到：先打开 MAPDAT.MKF 读资源 gm，失败才回退 map.mkf[gm*2+1]。巴哈帖证实 MapDat.mkf 只有 v2.06 有，而且和 v3.11 混用时会出现地图显示异常。用户要复刻的是原版台湾图，只读 map.mkf 可能读到非原版实际使用的数据
- exe 数据表不写死 VA：先用文本或数值签名找候选，再做结构校验，没有文本签名的表用 xrefTransfer 从 v3.11 迁移到 v2.06。已知的文件偏移只作快速路径提示 — Steam 版 MultiverseJourney 的 exe 哈希（50cb24bb…）与 mytbk 所用 v3.11（5a90aee2…）不同，v2.06 的布局也不同（卡表文件偏移 0x7c152 对 0x7e3f2）。只有签名定位加结构校验才能同时覆盖三种二进制，而且能自证定位正确
- MKF 私有压缩按 LZHUF 系列变体自研解码（自适应 Huffman 321 符号，12 位位置码，LSB 优先，非标准重标定）。位置码表在构建期从用户 exe 中定位读取并校验不变量；初始树用算法生成，再与 exe 字节比对 — 满足「自研、不复用 GPL 代码」：不照抄 mytbk 的 C 代码，也不内嵌从 GPL 源抄来的表。表数据来自用户合法拥有的文件，而 exe 本来就是必须提供的输入。nurockplayer 已证实 map.mkf 的地图资源是未压缩的，所以解码器不在关键路径上，风险可控
- 数据分三层：MapDataRaw（忠实，放在 .cache）→ MapSemantic → MapDef（加几何，放在 extracted）。只有 MapDef 进入 shared 的数据目录 — raw 层保留原始 hex 和偏移，供 provenance 与版本比较使用。semantic 层集中处理规则语义：槽位顺序、封路位、街道分组、关押格。几何层可以通过 override 反复迭代而不污染规则数据。三层各自可测
- 卡片、道具、角色、开局表等全局规则表手工录入并入库（@source 加 @verify），管线只做核对和版本比较。按地图的数据（节点、地块、公司、该图股票、节日）由管线生成 — 符合用户「按设计自研，数值重新录入并标注出处」的决定；手录表在 CI 中不依赖原版文件。按地图的数据量大、结构复杂，手工录入容易出错，只能生成，但每个字段都能追溯到原版的字节位置
- TileId 直接用原版节点号（1 基）。links 按原版槽号升序保存，并带逐方向的 blocked 标记。放弃 client 草案里的有向 next/prev — 原版岔路用 rand()%n 从候选中选，候选顺序就是槽位顺序，要做到行为级保真就必须保留槽序。原版棋子没有固有行进方向（向前走，转向卡掉头），静态封路也是按槽和方向存储的
- 几何采用「世界 32 单位一格（exe 的 >>5）」的格点模型：先自动检测，再量化节点、给非单位长度的边加 via 连接格、用匈牙利算法指派住宅地、设施选 2×2 的一侧，最后由 overrides 修正、validateMap 兜底 — 原版绘制时就把 x>>5 当作地面块下标，地面是 72×72 块，所以原版本身就是块网格，直接嵌入最保真。对角边或长边无法保证 4-邻接，用非游戏格的 via 连接，不改变游戏步数。确定性算法加少量人工 override，重复运行可以得到相同结果
- 从原版派生的数据默认不入库，部署时以只读卷 rich4-data/ 挂载。镜像只含代码和 fixture。用 RICH4_ALLOW_EXTRACTED_COMMIT=1 作为私有仓库入库的开关 — 镜像可以安全推送到镜像仓库；CI 不依赖原版文件；用户如需在私有仓库保存数据，有明确的开关和守卫。原版文件和派生的原始 hex 永远不会进入 git
- 代码行为的版本比较以 exe 内的函数指针表（新闻、命运、卡片/道具、AI 出卡、落点跳表）为种子配对函数，规范化指令后用 LCS 比较，并沿调用图扩散。radare2 和 radiff2 为可选的交叉核对 — 指针表按下标给出两版之间可靠的函数对应关系，成本低、误配少。规范化后只剩立即数差异，正好能暴露新闻、命运罚款之类数值的版本差异。r2 本机已装（6.2.0），但设为可选，避免成为必需依赖
- 测试地图用 ASCII 布局加声明表的生成器在 shared 中产出。主图 20 格覆盖随机岔路、被封岔路、汇合点、2×2 设施、两条街道、银行和百货兼作企业、两个关押格及 13 种特殊格；allkinds 变体 26 格补齐全部 17 类落点、死路折返和 via 连接格 — 引擎、前端、服务器和 E2E 都要能在没有原版文件时开发。ASCII 布局易读易改；生成器确定性输出，保证 JSON 与 TS 源一致
- 工具链为 tsx 加纯 TS，没有原生依赖；zh-CN 地名在构建期用 opencc-js@1.4.2 做繁转简；Big5 解码用 Node 自带的 TextDecoder('big5')，另外自建回编码表做校验 — 本机 Node 24.9 已验证能正确解码 big5；opencc-js 以 MIT/Apache-2.0 授权，只在构建期使用，不进生产包；零原生依赖，Docker 和本机都省心

## contracts
- packages/shared/src/data/maps/types.ts 导出 MapDef（schemaVersion 1）、TileDef、TileLink、LandLot、FacilityLot、CompanyDef、LandmarkDef、StreetDef、StockDef、HolidayDef、MapCounts；引擎、前端、服务器都以它为唯一的地图契约
- TileId = 原版节点号（1 基）；TileDef.links 按原版槽号升序且只包含非 0 槽；引擎在岔路计算前进候选时，必须按 links 顺序排除来路和 blocked 为 true 的边，再取 rand()%n
- TileLink.blocked 表示「从本格经此槽出发被禁止」，是有方向的静态封路；反方向是否可走由对端格自己的 link 决定
- TileDef.noItems（原版 flags 的 bit31）为 true 的格，不能作为随机放置物件、神明、礼物宝箱的位置，也不能作为开局降落伞落点
- TileDef.kind 与 landingCode 同时提供；银行和百货格同时带 landingCode 14/15 和 ref.lot = 'C<n>'，引擎在落点码不为 0 时按落点码处理，公司归属和收费另按 CompanyDef 处理
- FacilityLot.rateWindow 与原版寻址一致：下标 0 等于 housePrice，下标 1..5 是 1..5 级费率；引擎不得对它做「修正」
- LandLot 按 streetId 分组，分组依据是原版名称字节完全相等；同街过路费累加、涨价卡、查封卡、天使卡、恶魔卡、地震等「整区」效果一律按 streetId 处理
- hospital 与 jail 的关押格通过 TileDef.holdFor 和 LandmarkDef.holdTile 双向给出，引擎的关押与释放以 holdTile 为准
- MapDef.meta.dataHash 为规范化 JSON 的 sha256，由提取工具计算、服务器复算；存档只记录 {mapId, dataHash}，不内嵌地图（与 design_net §8.3 的 dataHash 对齐）
- 服务器在启动时从 RICH4_DATA_DIR/manifest.json 加载 maps/*.map.json，先做 zod 校验再调用 validateMap；fixture 地图永远可用；大厅列出可用地图；客户端通过 GET /api/maps/:id?h=<dataHash> 获取 MapDef（可强缓存）
- 建议引擎（由引擎领域定稿）：GameState 持有对冻结 GameData（map 加 rules）的引用 state.static，序列化时剔除，读档时凭 dataRef.dataHash 重新挂接，以保持 applyAction(state, action) 的签名不变
- 前端：用 cell、rect 渲染，支持 via 连接格和 roadCells 绘路与走路插值；如果坚持 4-邻接，由提取端对台湾图启用 --strict4，并通过 overrides 消除对角边
- 前端 i18n：MapDef.strings 提供 zh-TW 和 zh-CN 两套 nameKey 文本，加载地图时合并；nameKey 格式为 map.<id>.<street|tile|company|landmark|stock>.<n>
- packages/shared/src/data/rules/*.ts 的每个数值都带 @source 和 @verify；npm run extract -- verify 必须以退出码 0 通过，否则视为规则表与原版不一致
- validateMap(map, {strict4?, expect?}) 是 shared 中的纯函数，返回 {ok, issues[]}，issue code 的集合固定（E_* 为错误，W_* 为警告），可供前端 /dev/map 页面和服务器加载时复用
- tools/extract 永不写入 --src（original/）；输出只含 JSON 和 Markdown，不含图像、音频或原始资源；scripts/check-no-original.ts 在 CI 中强制执行
- fixtures/test-map.json 与 test-map-allkinds.json 由 shared 中的生成器确定性产出并入库；fixture 的槽号规则固定为 N=0、E=1、S=2、W=3，引擎单测可以依赖

## risks
- Steam 包里可能没有 MapDat.mkf，或者 MapDat 与 map.mkf 的台湾数据在规则字段上有差异：需要用户在「原版 v2.06」与「v3.11」之间做基线决定，并可能牵连其他领域以 v3.11 为基准的数值
- Steam 版 exe 与 mytbk 参考版哈希不同：如果差异不只是补丁（例如有加壳或区段加密），签名定位、代码比较都会受影响；fingerprint 阶段检测壳节并告警
- MapDat.mkf 如果是压缩的，解码器就进入关键路径；位置码表、非标准重标定只要理解偏差一个比特，整份资源都会错。缓解：用自写编码器做往返测试、全量长度校验，加上可选的 mytbk golden 哈希
- 几何：原版如果存在较多对角边、长边或同格节点，自动嵌入的效果会变差，需要较多 override；而前端的 4-邻接深度排序假设可能要放宽为支持 via 或对角
- facing 字段（+0x1b）等语义没有定论，只作为住宅地指派的弱约束使用，统计不一致时自动禁用；地块朝向的视觉可能与原版不同
- 节日表的 12 字节布局与标志位、企业行业码（除 7 以外）、封路位含义都依赖二手逆向，必须在用户文件上核实，否则引擎相关规则可能错位
- 函数级比较在编译器优化、跳转表、共享尾代码处容易误配或漏配；报告会标注未配对和低相似度的项，结论需要人工复核
- 法律：MapDef（地名、价格、坐标）会下发到公网所有玩家的浏览器，等于公开分发原作派生的事实数据；股票表里的真实公司名有商标风险。建议默认通过 i18n 改名，并在对外发布前评估
- Big5 的 HKSCS 与 CP950 映射差异可能让个别地名显示成异体字；回编码校验只能发现问题，修正需要人工决定
- 手录规则表与提取值会随时间漂移：verify 只能在有原版文件的本机运行，CI 无法覆盖；需要把 verify 列入发布前的检查清单

## open_questions
- 如果 v2.06（MapDat 或 map.mkf）与 v3.11 的台湾图在价格、租金、邻接、flags 上不同，以哪一版为默认？是否把「v2.06 数据与数值」做成房间可选开关？
- 固定表或代码常量出现两版差异时（例如新闻、命运数值），规则基准默认 v3.11（逆向资料齐全）还是 v2.06（真正的原版）？
- 提取出的 MapDef 是否要在私有仓库入库（打开 RICH4_ALLOW_EXTRACTED_COMMIT），还是只在本机生成、以 rich4-data/ 卷部署？
- 前端能否接受 via 连接格和对角 link？还是要求台湾图必须严格 4-邻接（这可能需要大量几何 override，甚至局部改变形状）？
- 等角视图中台湾岛的朝向（transform：identity、rot90 等）与地形风格（程序生成的海岸线还是手工涂改）由谁确认？是否需要对照原版截图人工审阅预览 SVG？
- 地名、股票名默认显示繁体原文还是简体（opencc 转换）？真实公司名（台積電、統一超商等）是否默认改为虚构名称？
- 服务器是否就按「运行时从 RICH4_DATA_DIR 加载并经 HTTP 下发 MapDef」这一方案执行？引擎是否接受 state.static 引用加 dataRef 的序列化约定？
- 是否需要把中国、日本、美国三张原版图一并纳入管线的持续校验（首发只做台湾，但表定位与比较可以顺带覆盖）？