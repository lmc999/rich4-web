# 原版数据提取 provenance 摘要（china）

> 由 `npm run extract -- map build --map china --strict4 --preview` 生成，请勿手改。只含输入指纹、样本结论与几何统计，不含整图数据；派生的 MapDef 在 `.cache/extract/maps/` 与 `rich4-data/`（均 gitignore）。

## 1. 输入指纹

| 文件 | 字节 | sha256 | 登记 id | 版本 | 状态 |
| --- | ---: | --- | --- | --- | --- |
| Game/MapDat.MKF | 36560 | `4dc6a47efe03f64484e6b9ac5ee31489b7f42fc369c0296f2f0b8d63845294b1` | steam.game.mapdat | v206 | known |
| Game/map.mkf | 40312048 | `717aaa1c1becf277064d29772500027427d39488bad64a7ee42875975c0e7106` | steam.game.mapmkf | v206 | known |
| Game/rich4.exe | 591360 | `110b29f9d2fadcff3836eb69ec380aa264951859c90955da6e11158d2f956a13` | steam.game.exe | v206 | known |
| MultiverseJourney/map.mkf | 76639739 | `311f44e6ab6f97623b8bc6a8bc27425806fc21ae17791d61966bd9bef778a6b8` | steam.mj.mapmkf | v311 | known |
| MultiverseJourney/rich4.exe | 602112 | `50cb24bbbd86353e26127e8e89e891c437984655d338a32f1458a3b79596219f` | steam.mj.exe | v311 | known |

本图来源：`v206-mapdat`，文件 sha256 `4dc6a47efe03f64484e6b9ac5ee31489b7f42fc369c0296f2f0b8d63845294b1`，地图资源 sha256 `6a589d151efc800cb7ca9e41c988c36405b93a8aa52e6126c23858aa3e535d6e`。
多来源比较：规则相关差异 1 项、表现相关差异 78 项；字节完全相同的分组 [v206-mapdat] [v206-mapmkf] [v311-mapmkf]。

## 2. 样本校验（data-pipeline.md §10.1）

| 样本 | 期望 | v206-mapdat | v206-mapmkf | v311-mapmkf |
| --- | --- | :---: | :---: | :---: |
| 计数 节点/住宅/设施/企业/景观 | [144,73,8,4,26] | ✅ | ✅ | ✅ |
| 街道价格样本（待原版核对） | 原版 v2.06 地产信息抽查 | ⚠️ | ⚠️ | ⚠️ |
| 医院关押格 type 8001（节点 / 景观 1） | 节点 63「醫院」 | ✅ | ✅ | ✅ |
| 监狱关押格 type 8002（节点 / 景观 2） | 节点 144「監獄」 | ✅ | ✅ | ✅ |
| 静态封路的边（bit 30−k） | 28->136 | ✅ | ✅ | ✅ |
| bit31 禁放物件节点 | 0 个 | ✅ | ✅ | ✅ |
| 非空名称 Big5 严格解码且回编码一致 | 242/242 | ✅ | ✅ | ✅ |
| 中國石油 industry/stockIndex/assetValue | {"industry":6,"stockIndex":3,"assetValue":120000} | ✅ | ✅ | ✅ |
| 中國人壽 industry/stockIndex/assetValue | {"industry":4,"stockIndex":1,"assetValue":288000} | ✅ | ✅ | ✅ |
| 上海銀行 industry/stockIndex/assetValue | {"industry":7,"stockIndex":0,"assetValue":560000} | ✅ | ✅ | ✅ |
| 王井府百貨 industry/stockIndex/assetValue | {"industry":10,"stockIndex":2,"assetValue":160000} | ✅ | ✅ | ✅ |
| C4 企业名（原版笔误，股票表为「王府井百貨」） | 王井府百貨 | ✅ | ✅ | ✅ |
| 住宅 rent[0] = 地价×20%（启发式） | 全部满足 | ⚠️ | ⚠️ | ⚠️ |

## 3. exe 表：本图股票、节日与规则表核对（D2）

股票与节日取自 `Game/rich4.exe`（v206，sha256 `110b29f9d2fadcff3836eb69ec380aa264951859c90955da6e11158d2f956a13`）：股票模板表 `0x47ce92` 的本图 12 支、节日表 `0x47d6aa` 的本图 19 条，空槽 5。另一版本 exe 中本图数据：一致。

企业 ↔ 股票（企业 +0x19 行号）：✅ 「中國石油」→ 股票 3「中國石油」hasCompany=true；✅ 「中國人壽」→ 股票 1「中國人壽」hasCompany=true；✅ 「上海銀行」→ 股票 0「上海銀行」hasCompany=true；⚠️ 「王井府百貨」→ 股票 2「王府井百貨」hasCompany=true（原版名称不一致，已登记，照原样保留）；✅ hasCompany 的股票 4 支，企业 4 家。

规则表「手录值 / v2.06 / v3.11 / 结论」矩阵（`npm run extract -- verify --tables`）：

| 表 | 核对项 | 手录 | v2.06 与 v3.11 | 结论 |
| --- | ---: | :---: | --- | --- |
| `cards` | 120 | ✅ | 相同 | 手录值与 exe 一致（90 项） |
| `items` | 39 | ✅ | 相同 | 手录值与 exe 一致（26 项） |
| `characters` | 84 | ✅ | 相同 | 手录值与 exe 一致（72 项） |
| `setup` | 6 | ✅ | 相同 | 手录值与 exe 一致（6 项） |
| `facilityLevels` | 1 | （缺） | 相同 | 手录表缺失：只输出 exe 值（见对照清单） |

手录表 `@verify` 引用 58 条，无法解析 0 条。
- 待对照：facilities.ts：设施等级上限（公园/旅馆/购物中心/加油站/研究所）↔ exe facilityLevels.max

## 4. 几何归一化统计（data-pipeline.md §8）

| 项目 | 值 |
| --- | --- |
| 格点模式 | fitted（T=48，原点 (32, 39)，transform identity） |
| T=32 探测 | 残差众数 (16, 8)，覆盖率 5.6%，单位轴向边 19/144 |
| 世界坐标边方向 | 轴向 63，斜向 81 |
| 量化后边分类（拐角翻转、nodeCell 之前） | 单位轴向 74、单位对角 59、长直 11、其他 0、零长 0；节点同格 0 |
| 对角边数（最终网格，均以 L 形 via 连接） | 51 |
| 连边方式 | 直连 79、长直 11、L 形 51、绕行 0、override 3 |
| via 连接格 | 68 格（65 条边，单边最多 2） |
| 拐角翻转 | 节点 134 |
| 住宅地朝向假设 | 45/46 一致（97.8%），已启用 |
| 住宅地放宽 / 偏侧 | 无 / 无 |
| 紧凑 | 关闭 |
| 网格尺寸 | 50×46（留白 4） |
| 地形 | g:1296 w:783 s:214 p:0 m:7 |
| override 条数 | 15 |
| strict4 | 已启用 |
| MapDef dataHash | `a36d1285be25c4c71aa5fe2fc8c8c4359fce18706738152ec54930680e8e4363` |
| china.map.json sha256 | `58bd4313fd85328d6297f8b4e6aa3d83cdca6634b72f50f8e426c5680812138d` |

## 5. validateMap 结果

ok = true（error 以外的分类见下表；分类规则见 `tools/extract/src/map/build.ts`）

| 分类 | code | 数量 |
| --- | --- | ---: |
| 警告 | `W_COMPANY_REMOTE_FRONT` | 1 |
| 警告 | `W_DEADEND` | 1 |
| 警告 | `W_LINK_ONEWAY` | 1 |

几何告警：
- `W_COMPANY_REMOTE_FRONT` 企业 C4 的前沿格 10 与建筑不相邻（原版同一企业的多个落点格相距过远）

## 6. 未决项

- 格点为拟合模式（T=48），与「32 单位一格」的假设不符，请对照原版截图人工审阅 `.cache/extract/preview/china.svg`。
- 几何决定记录在 `tools/extract/maps/china.overrides.json`；岛屿朝向（transform）尚未与原版截图核对。
