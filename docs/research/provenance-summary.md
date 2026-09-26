# 原版数据提取 provenance 摘要（taiwan）

> 由 `npm run extract -- map build --map taiwan --strict4 --preview` 生成，请勿手改。只含输入指纹、样本结论与几何统计，不含整图数据；派生的 MapDef 在 `.cache/extract/maps/` 与 `rich4-data/`（均 gitignore）。

## 1. 输入指纹

| 文件 | 字节 | sha256 | 登记 id | 版本 | 状态 |
| --- | ---: | --- | --- | --- | --- |
| Game/MapDat.MKF | 36560 | `4dc6a47efe03f64484e6b9ac5ee31489b7f42fc369c0296f2f0b8d63845294b1` | steam.game.mapdat | v206 | known |
| Game/map.mkf | 40312048 | `717aaa1c1becf277064d29772500027427d39488bad64a7ee42875975c0e7106` | steam.game.mapmkf | v206 | known |
| Game/rich4.exe | 591360 | `110b29f9d2fadcff3836eb69ec380aa264951859c90955da6e11158d2f956a13` | steam.game.exe | v206 | known |
| MultiverseJourney/map.mkf | 76639739 | `311f44e6ab6f97623b8bc6a8bc27425806fc21ae17791d61966bd9bef778a6b8` | steam.mj.mapmkf | v311 | known |
| MultiverseJourney/rich4.exe | 602112 | `50cb24bbbd86353e26127e8e89e891c437984655d338a32f1458a3b79596219f` | steam.mj.exe | v311 | known |

本图来源：`v206-mapdat`，文件 sha256 `4dc6a47efe03f64484e6b9ac5ee31489b7f42fc369c0296f2f0b8d63845294b1`，地图资源 sha256 `e95239947d93656cb8786cd291395a1db53e117b262425d65ed0ffd7c9b76197`。
多来源比较：规则相关差异 0 项、表现相关差异 63 项；字节完全相同的分组 [v206-mapdat, v206-mapmkf] [v311-mapmkf]。

## 2. 样本校验（data-pipeline.md §10.1）

| 样本 | 期望 | v206-mapdat | v206-mapmkf | v311-mapmkf |
| --- | --- | :---: | :---: | :---: |
| 计数 节点/住宅/设施/企业/景观 | [103,50,4,3,21] | ✅ | ✅ | ✅ |
| 台北市 块数 | 4 | ✅ | ✅ | ✅ |
| 台北市 地价 | 2500 | ✅ | ✅ | ✅ |
| 台北市 租金 | [500,1200,3000,7500,16000,30000] | ✅ | ✅ | ✅ |
| 新竹市 存在 | ≥1 | ✅ | ✅ | ✅ |
| 新竹市 地价 | 1000 | ✅ | ✅ | ✅ |
| 新竹市 租金 | [200,500,1200,2800,6000,10000] | ✅ | ✅ | ✅ |
| 台南市 块数 | 4 | ✅ | ✅ | ✅ |
| 台南市 地价 | 1500 | ✅ | ✅ | ✅ |
| 台南市 房价（按编号） | [500,300,300,300] | ✅ | ✅ | ✅ |
| 台南市 租金 | [300,750,2000,4800,10000,18000] | ✅ | ✅ | ✅ |
| 医院关押格 type 8001 | 存在 | ✅ | ✅ | ✅ |
| 监狱关押格 type 8002 | 存在 | ✅ | ✅ | ✅ |
| 静态封路节点数（bit 30−k） | 2 | ✅ | ✅ | ✅ |
| 非空名称 Big5 严格解码且回编码一致 | 165/165 | ✅ | ✅ | ✅ |
| 台灣人壽 assetValue | 400000 | ✅ | ✅ | ✅ |
| 中國信託 industry/stockIndex | {"industry":7,"stockIndex":0} | ✅ | ✅ | ✅ |
| 住宅 rent[0] = 地价×20%（启发式） | 全部满足 | ⚠️ | ⚠️ | ⚠️ |

## 3. 几何归一化统计（data-pipeline.md §8）

| 项目 | 值 |
| --- | --- |
| 格点模式 | fitted（T=48，原点 (4, 36)，transform identity） |
| T=32 探测 | 残差众数 (0, 15)，覆盖率 11.7%，单位轴向边 11/103 |
| 世界坐标边方向 | 轴向 49，斜向 54 |
| 量化后边分类（拐角翻转、nodeCell 之前） | 单位轴向 52、单位对角 39、长直 10、其他 2、零长 0；节点同格 0 |
| 对角边数（最终网格，均以 L 形 via 连接） | 37 |
| 连边方式 | 直连 53、长直 10、L 形 40、绕行 0、override 0 |
| via 连接格 | 53 格（50 条边，单边最多 2） |
| 拐角翻转 | 节点 45, 49, 74, 94 |
| 住宅地朝向假设 | 35/35 一致（100.0%），已启用 |
| 住宅地放宽 / 偏侧 | 无 / 无 |
| 紧凑 | 关闭 |
| 网格尺寸 | 45×53（留白 4） |
| 地形 | g:1122 w:1016 s:247 p:0 m:0 |
| override 条数 | 4 |
| strict4 | 已启用 |
| MapDef dataHash | `f3bae58374147886ffa051e7aea3f89efb190cbe90e0ac68ed1244441625a36c` |
| taiwan.map.json sha256 | `f819635b11861e9ca4e401d200bd8c27f24f4240e29031f2cb37c15da17559e6` |

## 4. validateMap 结果

ok = false（error 以外的分类见下表；分类规则见 `tools/extract/src/map/build.ts`）

| 分类 | code | 数量 |
| --- | --- | ---: |
| 契约缺口 | `E_LOT_FRONT_NOT_ADJ` | 1 |
| 待 D2 数据 | `E_TILE_REF_MISMATCH` | 3 |
| 警告 | `W_DEADEND` | 2 |
| 警告 | `W_LINK_ONEWAY` | 2 |
| 警告 | `W_NAME_EMPTY` | 4 |

几何告警：
- `W_COMPANY_REMOTE_FRONT` 企业 C2 的前沿格 15 与建筑不相邻（原版同一企业的多个落点格相距过远）

语义层提示：
- `S_NAME_SUGGESTS_CODE` 节点 23 名称「公園」像落点码 1，但实际落点码为 0

## 5. 未决项

- 本图的 stocks、holidays 需要从 exe 表抽取（D2），目前为空数组；因此企业的 stockIndex 在 validateMap 中悬空（分类「待 D2 数据」）。
- 同一企业的多个落点格相距过远（大宇百貨的两个百貨公司格分处南北），MapDef 只有一个矩形，无法同时与两格相邻：需要 shared 的契约或 validateMap 放宽（分类「契约缺口」）。
- 格点为拟合模式（T=48），与「32 单位一格」的假设不符，请对照原版截图人工审阅 `.cache/extract/preview/taiwan.svg`。
- 几何决定记录在 `tools/extract/maps/taiwan.overrides.json`；岛屿朝向（transform）尚未与原版截图核对。
