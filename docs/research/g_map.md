# 大富翁4 台湾图（gm=0）数据与企业参数：调研结论与实现规格

> 范围：只看原版《大富翁4》及 v3.11 超时空之旅合版（Steam 版的 `Game/` 与 `MultiverseJourney/` 两个子目录），不含《4 Fun》。凡是只在 v3.11 exe 上验证过的内容，文中标【v3.11】。
> 证据等级：A = 机器码或原始字节直接读出；B = 代码加数据双重印证，但命名或语义属推断；C = 仅有统计或二手资料。
> 来源缩写：**mytbk** = mytbk/rich4（GPL-3.0）；**oama** = oama1111/rich4-spec 与 rich4-remake-public，两者算同一来源；**nuro** = nurockplayer/richman4-remake（无许可证，只能参考阅读）；**说明书** = archive.org 上的 OCR 文本；**巴哈** = 巴哈姆特 bsn=972 讨论板。

---

## 0. 一句话结论

1. **公开渠道找不到台湾图的完整导出**（103 个节点、50 块住宅、4 处设施、3 家企业都没有）。
   - mytbk 只提供解析器（`tools/map_data_parser.c`、`plot_map.py`），没有附带数据文件。
   - oama 两个仓库的测试都要读本地 `extracted/map/0001.bin`，不内嵌数据。
   - nuro 的数据放在私有 LFS 仓库，公开的 fixture 是合成数据。
   - Steam 指南 3489536813 已被下架，只剩各图公司认购价。
   - 巴哈能找到的地价帖都是《4 Fun》的（已排除）。
2. 能拿到的是**零散的真值样本**（第 1 节），足够用来做提取后的自检。
3. **完整数据必须从用户自己的正版 `map.mkf` 资源 1 解析**。第 6 节给出可以照做的方案：容器格式、压缩算法伪代码、逐字段偏移、JSON schema 和自检步骤。
   - nuro 实测：`map.mkf` 里的地图结构资源**全部是未压缩存储**，不需要解压算法就能读。解压算法作为兜底一并给出。

---

## 1. 目前公开可得的台湾图真值（gm=0，`map.mkf` 资源 1）

| 项 | 值 | 来源 / 等级 |
|---|---|---|
| 各表规模（节点/住宅/设施/企业/景观） | 103 / 50 / 4 / 3 / 21 | oama（`map-format.md` §6.2）+ nuro（`fidelity.md`，`Game` 与 `MultiverseJourney` 两个版本一致）【A，两个独立来源】 |
| 资源解包后长度 | 7956 字节 | oama（`07-data-contracts.md`、`map-format.md` §三）【A，单一来源】 |
| 各表偏移 | node_off=0x28(40)、land_off=4200、fac_off=6852、comm_off=7132、landscape_off=7340(0x1CAC) | oama 字节转储；按 `(count+1)×步长` 可以算回【A，单一来源】 |
| 核对 | 7340 + 22×28 = 7956，正好等于文件长度 | 同上 |
| 住宅 1 | 台北市，x=1463，y=192，地价 2500，房价 500，rent=[500,1200,3000,7500,16000,30000] | oama 原始字节 `b7 05 c0 00 a5 78 a5 5f a5 ab …`（`a578 a55f a5ab` 是 Big5 编码的「台北市」）【A】 |
| 台北市范围 | 住宅 1..4，共 4 块同名 | oama（T-052、Q-TOLL-FX-1）【B】 |
| 桃園市范围 | 住宅 5..8 | oama（T-052）【B】 |
| 新竹市 | 地价 1000，rent=[200,500,1200,2800,6000,10000] | oama（`map.ts` 注释、`toll.test.ts`）【A，单一来源】 |
| 台南市 | 住宅 21..24，地价 1500，房价 500/300/300/300，rent=[300,750,2000,4800,10000,18000] | oama（`known-deviations.md` Q-001，认定为原版数据瑕疵，保留不改）【A，单一来源】 |
| 其他已知区名 | 台中市（节点 53）、高雄市 | oama 文档与测试【C】 |
| 台東縣「費用 500 元」 | 只出现在 UI 测试的字面量里，**不能当真值用** | oama（`dialog.test.ts`）【C】 |
| 设施 1 | 花蓮市，地价 (+0x22) 4000，+0x24 表=[400,400,1000,2500,5000,8000]，+0x1b=7 | oama 字节转储【A，单一来源】 |
| 企业（stock 行 0..2） | 中國信託（行业 7 银行）、臺灣人壽（行业 4 保险）、大宇百貨（推断行业 10 百货） | 股票模板取自 exe VA 0x47F072【v3.11】（oama）；三家都标了 hasCommercial=1【A】；行业码：7 与 4【A/B】，10【B】 |
| 臺灣人壽 | 资产额 (+0x24) 400000，所以每股认购价 400000/10000 = **40** | 与 Steam 指南「台灣人壽：40」吻合【A+C，两个来源】 |
| 臺灣人壽 | 流通股 5000，公司自留 10000−5000 = **5000 股**，每次落地最多认购 1000 股 | oama（`stocks.ts`）【A】 |
| 臺灣人壽所在节点 | 51、52（两个入口格） | oama（Q-COMMERCIAL-1）【B】 |
| 中國信託 / 大宇百貨 | 流通股都是 10000，所以自留股为 0，落地时**买不到** | 与 Steam 指南「台灣」一栏只列了台灣人壽吻合【B】 |
| 台湾 12 支股票（名称/价格/波动） | 中國信託 100/1.0，臺灣人壽 40/0.6，大宇百貨 25/1.5，台積電 180/1.6，大宇資訊 80/1.2，台灣塑膠 60/1.0，裕隆汽車 60/1.4，遠東紡織 27/0.9，統一超商 310/0.7，震旦行 66/1.0，萊爾富 171/1.4，聯合報 280/0.8 | oama（`packages/data/src/stocks.ts`，从 v3.11 exe 直接提取）【A，单一来源】 |
| 監獄落点格（保释格，flags 低字节 = 4） | 节点 12，坐标 (1248,1583) | oama（`game-loop.md` E-12、`confinement.test.ts`）【A，单一来源】 |
| 醫院落点格（flags 低字节 = 5） | 节点 16，坐标 (767,1631) | 同上 |
| 監獄**关押格**（type=0x1F42 = 景观 2） | 节点 1，坐标 (1752,1871)，adj=[2,0,0,0]，decor=33，flags=0x80000000（禁放道具） | 同上；另见 oama `07-data-contracts.md` |
| 醫院**关押格**（type=0x1F41 = 景观 1） | 节点 23，坐标 (384,1056)，bit31 未置位 | 同上 |
| 景观 1 | 醫院，坐标 (319,990)，sprite 144（关押期间棋子贴图画在这里） | oama【A】 |
| 景观 2 | 綠島，坐标 (1817,1960)，sprite 259 | oama【A】 |
| 地理印证 | 醫院 = 澎湖、監獄 = 綠島，都在岛外；玩家不能主动走过去 | fandom wiki（独立来源）【C】 |
| 景观名 | 醫院、綠島、沙崙、野柳、基隆港、石門水庫、龜山、台中港、阿里山、玉山、澄清湖、佛光山、高雄造船、墾丁、陽明山、八卦山，另有 4 条空名 | oama（Q-HOVER-1）。16+4=20，与表头的 21 **差 1**，待核对 |
| 其他节点 | 20 = 樂透，21 = 公園 | oama（Q-COMMERCIAL-1）【B】 |
| 地图 0 上确认存在的特殊格名 | 卡片、命運、魔法屋、銀行、醫院、監獄、樂透、新聞、公園 | oama（`map.test.ts`）【B】 |

其他三张图的规模（两个独立来源）：

| 地图 | 节点 | 住宅 | 设施 | 企业 | 景观 |
|---|---|---|---|---|---|
| 中国 | 144 | 73 | 8 | 4 | 26 |
| 日本 | 110 | 49 | 5 | 6 | 16 |
| 美国 | 118 | 55 | 8 | 6 | 16 |

与任务给出的校验数一致。

---

## 2. 地图资源格式（逐字段；无特别标注的，均已由 oama 在 exe 上证实，并与 mytbk、nuro 至少一方一致）

### 2.1 定位

- `global_map_id = stage×4 + map`。
- 结构数据在 `MAP.MKF` 的资源 **gm×2+1**，台湾图就是资源 **1**。
- 【v3.11】exe 会先尝试 `MAPDAT.MKF[gm]`，打不开才回退到上面这条。发行版里没有这个文件。
- nuro 实测：`Game` 版（资源 1/3/5/7）和 `MultiverseJourney` 版（资源 1..15 奇数）用的是同一套资源号。

### 2.2 表头：10 个 u32，小端

| 偏移 | 字段 |
|---|---|
| 0x00 | 节点数 |
| 0x04 | 节点表偏移 |
| 0x08 | 住宅数 |
| 0x0C | 住宅表偏移 |
| 0x10 | 设施数 |
| 0x14 | 设施表偏移 |
| 0x18 | 企业数 |
| 0x1C | 企业表偏移 |
| 0x20 | 景观数 |
| 0x24 | 景观表偏移 |

- 偏移都是相对资源起点的。
- **每张表都是 1 基，并在第 0 项放一个全 0 的哨兵**，所以表在文件里实际有 count+1 项。第 i 项的位置 = 表偏移 + i×步长。
- 数据总长 = 景观表偏移 + (景观数+1)×0x1C。
- 三方一致：oama、mytbk `map_data_parser.c`（先读掉第 0 项）、nuro（`count + 1 # dummy record`）。

### 2.3 节点表（步长 0x28）

| 偏移 | 类型 | 字段 |
|---|---|---|
| 0x00 / 0x02 | i16 | x / y |
| 0x04 | Big5 串 | 名字，NUL 结尾，结构上最多 20 字节，实测最长 10 字节 |
| 0x18 | u16×4 | 邻接槽，存 1 基节点号，0 表示空。**槽号本身有意义，不要压缩成列表** |
| 0x20 | u16 | type：0 = 特殊格；2000+i = 住宅 i；4000+i = 设施 i；6000+i = 企业 i；8000+i = 景观 i。各段是开区间，宽 2000 |
| 0x22 | u16 | decor：装饰图的 1 基下标，0 表示不画。【v3.11】取自资源 0x18（58 帧）；Game 版取自资源 12（17 帧，nuro） |
| 0x24 | u32 | flags，见第 3 节 |

### 2.4 住宅表（步长 0x34）

| 偏移 | 类型 | 字段 |
|---|---|---|
| 0x04 | Big5 | 区名，最多 19 字节 |
| 0x17 | u8 | 价格状态：0x50 = 涨价（过路费翻倍）；0x51 = 查封。运行期字段 |
| 0x18 | u8 | 0 = 住宅，非 0 = 连锁店。运行期字段 |
| 0x19 | u8 | owner，1 基，0 表示无主。运行期字段 |
| 0x1A | u8 | level 0..5。运行期字段 |
| 0x1B | u8 | 朝向 0..7 |
| **0x1C** | u16 | **地价** |
| **0x1E** | u16 | **房价**（每级加盖价） |
| 0x20 | u16×6 | rent[0..5] |
| 0x2C | u32 | 未决，运行期被清零 |
| 0x30 | u32 | 地契到期日 |

**地价/房价偏移的冲突裁决**：

- 认为 +0x1C 是 `price_per_level`、+0x1E 是 `land_price` 的有两处：mytbk `asm/rich4_map.h`，以及 ubnm 存档编辑器（`landPrice = u16(0x1E)`）。
- 认为 **+0x1C 是地价、+0x1E 是房价** 的有三处：mytbk `csrc/land.h`、oama、nuro（`fidelity.md` 称已按反汇编和本地 fixture 核对）。
- 两条硬证据支持后者：
  - 台北市原始字节 +0x1C = 2500，+0x1E = 500，2500 正是已知的台北市地价；
  - exe `0x41add5` 收建设工程费时读的就是 `land+0x1C × 物价指数`。
- 结论：**+0x1C 是地价**。

### 2.5 设施表（步长 0x38）

| 偏移 | 类型 | 字段 |
|---|---|---|
| 0x04 | Big5 | 名字，最多 20 字节 |
| 0x18 | u8 | 设施种类：0 公園 / 1 旅館 / 2 購物中心 / 3 加油站 / 4 研究所。运行期字段，地图文件里恒为 0 |
| 0x19 | u8 | owner |
| 0x1A | u8 | level |
| 0x1B | u8 | 朝向 |
| 0x1C | u8 | 状态：高 4 位是倒计时 |
| 0x1D / 0x1E | u8 | 研究项目 / 剩余天数 |
| **0x22** | u16 | **地价** |
| **0x24** | u16×6 | [0] = 加盖单价；[1..5] = 1~5 级费率。寻址方式是 `+0x24 + level×2` |
| 0x34 | u32 | 地契到期日（注意与住宅的 0x30 不同） |

- 等级上限表（VA 0x474940）：公園 1、旅館 5、購物中心 5、加油站 1、研究所 5（oama、nuro 两方一致）。

### 2.6 企业表（步长 0x34）

| 偏移 | 类型 | 字段 |
|---|---|---|
| 0x04 | Big5 | 公司名 |
| 0x18 | u8 | owner。运行期字段（注意：在企业表里 +0x18 是所有者，不是种类） |
| 0x19 | u8 | 该图 12 行股票里的行号，0 基 |
| 0x1A | u8 | **行业码** |
| 0x1B | u8 | 朝向 |
| 0x1C..0x1F | u8×4 | 持股排名。运行期字段 |
| 0x20 | u16 | 建筑图 id：【v3.11】资源号 = id+0x26；Game 版资源号 = id+26（nuro） |
| **0x22** | u16 | **收费基数**（nuro 称 toll_fee，oama 称地价） |
| **0x24** | u32 | **资产额**（认购价 = 资产额 ÷ 10000） |
| 0x28 / 0x2C | i32 | 本月盈余 / 累计盈余。运行期字段 |
| 0x30 | u32 | 自留股。载入时计算为 10000 − 流通股 |

- mytbk `rich4_map.h` 标注：owner 在 0x18、commerce_type 在 0x1A（4 = 保险，11 = 建设）、toll_fee 在 0x22。三方一致。

**行业码**：

| 码 | 行业 | 依据 / 等级 |
|---|---|---|
| 1 | 航空 | 转盘 0 + 「不用出國！」【A】 |
| 2 | 饭店 | exe 里**不收费** |
| 3 | 电子 | 【A】 |
| 4 | 保险 | 【A】 |
| 5 | 汽车 | 【A】 |
| 6 | 石油 | 【A】 |
| 7 | 银行 | VA 0x436b31【A】 |
| 10 | 百货 | 【B】 |
| 11 | 建设 | 【A】 |
| 12 | 门派 | 【A】 |

- 费名表 `0x47528E`（按行业码取下标）= [2,6,0,8,7,3,2,0,0,0,0,9,0,10]，指向 `過路費/房租費/加油費/修車費/店租費/住宿費/旅遊費/保險費/電腦費/工程費/…`，与上面的行业划分吻合。

### 2.7 景观表（步长 0x1C）

| 偏移 | 类型 | 字段 |
|---|---|---|
| 0x04 | Big5 | 名字 |
| 0x18 | u8 | 朝向 |
| 0x1A | u16 | 图 id，规则同企业 +0x20。实测取值可达 259，所以 +0x1B 只是这个 u16 的高字节 |

**关押格与景观的对应**：载入时扫描节点表，type 为 **0x1F41**（8001，景观 1）的那一格记为医院关押格，type 为 **0x1F42**（8002，景观 2）的记为监狱关押格（VA 0x40803f）。每张图各一格。

**关押与获释**（2026-10-01 v2.06 radare2 取证，VERIFY V-M7）：被关时节点写成关押格、来路写 0（监狱 0x43c34c / 0x43c359，医院 0x43d9d9 / 0x43d9e6），棋子坐标是景观坐标，关押期间不画棋子（0x4082a5–0x4082c3；上表「关押期间棋子贴图画在景观坐标」的说法以此为准）；获释（0x40d184，期满、新闻 0、保释同路）不换节点，从景观走 1 步到关押格，下一回合从关押格出发，来路 0 → 在全部未封邻格里 `rand() % n`（0x40bc10–0x40bc89）。所以台湾监狱 1、医院 23 所在的支线（被封路位挡住、不能从环路走进去）只能从关押格走出来；保释格 12 / 16（落点码 4 / 5）只是开保释屏的落点。

---

## 3. flags（节点 +0x24）

### 3.1 低字节：17 类落点（跳表 0x4197e9 共 17 项）

| 值 | 落点 | exe 入口 |
|---|---|---|
| 0 | 地产或企业（按 type 分派） | 0x4198b9 |
| 1 | 公園（无事件） | 0x41b3d0 |
| 2 | 新聞 | 0x44b6df |
| 3 | 命運 | 0x44db81 |
| 4 | 監獄（保释格） | 0x43d304 |
| 5 | 醫院（出院手续格） | 0x43e9a4 |
| 6 | 企鵝挖寶 | 0x415215 |
| 7 | 七彩氣球 | 0x4154dc |
| 8 | 喜從天降 | 0x4155fc |
| 9 | 樂透 | 0x4315cc |
| 10 | 得点券 50 | exe 串「得點券５０點」、`+0x32` |
| 11 | 得点券 30 | 串「…３０點」、`+0x1e` |
| 12 | 得点券 10 | 串「…１０點」、`+0xa` |
| 13 | 卡片（「得到%s！」） | — |
| 14 | 銀行（先 ATM 后柜台） | — |
| 15 | 百貨公司 / 商店 | 0x42e931 |
| 16 | 魔法屋 | 0x43380a |

- 1..16 的名称由 oama 的 SPECIAL_KIND 给出，并与机器码逐条对上；nuro 也称 1..16 已按跳表核对。

### 3.2 高位

| 位 | 含义 | 等级 |
|---|---|---|
| bit 8..15 | 运行期占用位：`0x100 << 玩家号`（玩家 0..3、NPC 4..7） | A |
| bit 16..23 | 运行期字段 | — |
| **bit 27..30** | **静态封路位**：走路例程 0x40c12e 和 AI 前瞻 0x40b29e 都用掩码 `0x40000000 >> 槽号`，置位的邻接槽不会被选。8 张图合计只出现 bit27×3、bit28×7，也就是只有槽 3、槽 2 被封 | 机器码 A；语义 B |
| **bit 31** | 禁止放道具（投放判定掩码 0x80FFFF00） | A |

- 封路位的语义推断：wiki 说台湾图「不能主动走向監獄/醫院」，与「单向封路」相符。
- 另外两条走路规则【A】：不走回头路；多条候选路时取 `rand() % 候选数`，代码里没有看到真人选路的分支。
- 「水路」：exe 里没有找到对应字段，见 open questions。

---

## 4. 收费公式与冲突裁决

记号：PI = 物价指数（全局 0x4990E8），steps = 本次掷骰总点数（0x48BAFC），days = 游戏天数计数器（0x4990E4，开局为 0，每天 +1）。交通倍率 k = `1 << ((trafficMethod & 3) − 1)`：机车 = 1，汽车 = 2，工程车 (0x1F) = **4**，步行不收费。

### 4.1 住宅

- 过路费 = PI × Σ（该地主名下、与所踩地块**同名**、type=0 的每块地的 rent[level]）。
- 连锁店 = 2000 × 该地主的连锁店数 × PI。
- +0x17 不为 0（涨价）时翻倍。
- 依据：oama `land-rent.md`（0x419744、0x419b09）+ nuro `original-remodel.md` + 巴哈冷知识帖（「2000 元/家」）【A】。
- 买地 = 地价 × PI；每加盖一级 = 房价 × PI。

### 4.2 设施（依据：oama 与 nuro 各自读机器码，结论一致）【A】

- **旅館**（种类 1）：先转盘 1（1 天 4/12、2 天 3/12、3 天 2/12、4 天 3/12，转出 n）；费用 = n × rate[level] × PI，涨价时单价 ×2；另外要住 n 天（+0x32 = n−1）。
- **購物中心**（种类 2）：费用 = 转盘 2（1..6 各 2/12）× rate[level] × PI，涨价时 ×2。
- **加油站**（种类 3）：费用 = **500 × k × steps × PI**（0x41a4db..0x41a529，500 由移位链 `k→3k→24k→25k→100k→500k` 算出）。路障提前截停不影响 steps。
- **公園 / 研究所**：不收费。
- **买设施**：地价(+0x22) × PI；**首次建造**（0→1 级）再付一次地价 × PI 并选定种类；**升级**：rate[0] × PI。

### 4.3 上市企业

先看条件：公司无主不收费，只问是否认购；**踩到自家公司走董事长分支**；所有费用都进公司的本月盈余（0x41d2c6），每月 15 日按持股比例分红。

**航空（行业 1）【A】**

- 流程：转盘 0 转出 n，其中 n=0:2/12、1:4/12、2:4/12、3:2/12。
  - n=0 时提示「不用出國！」，不收费；
  - 否则收费 = **n × 收费基数(+0x22) × PI**，然后调用 `0x40d375(玩家, n, 0)`，也就是**出国消失 n 天**，期间收不到过路费。
- 裁决 1：「费率 × 点数 × PI」那种说法是门派（行业 12）的公式，**用在航空上是错的**。
- 裁决 2：oama `game-loop.md` 把出国这一支记为「读的是未初始化栈槽，所以未决」，复刻版也因此没做出国。**这个判断有误**：
  - 0x41b04f 先 `push 0`，esp 减 4，所以紧接着读的 `[esp+0xd4]` 就是入栈前的 `[esp+0xd0]`，也就是 0x41abcd 写入的转盘值 n；
  - 旅館保险理赔处（0x41a805 / 0x41a807）是同一个模式。
  - 说明书也写「出國期間不能收取過路費」，与此吻合。

**电子（行业 3）**：费用 = 收费基数(+0x22) × days，**不乘 PI**（0x41ac2c）。oama 与 nuro 一致【A】。

**保险（行业 4）**

- 非董事长：转盘 3 转出投保天数 d（5/3/30/20/15/10，各 1/6）；费用 = **d × 收费基数(+0x22) × PI**；投保天数 +0x3E += d（结果 & 0x7F）【A】。
- 董事长：免费获得 d 天【A】。
- 理赔：住院、坐牢或住旅館时，赔付 新增天数 × 2000 × PI，由**第一家行业 4 的公司**的盈余支付，进被保人现金（oama + nuro）【A】。

**汽车 / 石油（行业 5 / 6）**

- 费用 = **收费基数(+0x22) × k × steps × PI**（0x41ac8c..0x41acc5），步行免费【A】。
- nuro 写的是「700/500 × 点数 × PI，汽车再 ×2」。机器码里的系数取自记录的 +0x22，不是常数，所以 700/500 **很可能是这两类公司在地图数据里的 +0x22 值**（C，未证实）。
- nuro 没有处理工程车（k=4）。

**建设（行业 11）【A】**

- 流程：
  - 选目标：真人走 UI（0x446ae8），AI 走 0x40b455。AI 的挑法是，住宅里选当前等级租金最高且未满 5 级的，设施里选地价最高的，两者取大；
  - 非董事长：`0x40b110` 调用**一次**，即 +1 级；工程费 = 目标的地价（住宅 +0x1C / 设施 +0x22）× PI；**找不到目标时收 1000 × PI**（0x41adff 移位链算出的正是 1000×PI）。
  - 董事长：`0x40b110` 调用**两次**（0x41aae8 与 0x41aafc），免费；第一次调用后若已满 5 级（返回值 bit7 置位）就不再加第二层。
- 结论：**董事长加盖 2 层**，与 nuro 一致；oama 复刻代码注释里写的「加盖一级」有误。说明书只描述了非董事长加盖一层的情况。

**门派（行业 12）**：费用 = 收费基数(+0x22) × steps × PI【A】。

**饭店（2）、银行（7）、8、9、百货（10）**

- 在这个分支里都不收费。
- 银行和百货的服务由节点落点码 14/15 触发；说明书写饭店公司要转盘住宿，但 exe 没有这一支（nuro 也观察到这一差异）。

---

## 5. 版本差异

- **只在 v3.11 上验证过**：
  - 所有 VA；
  - 行为公式（v3.11 rich4.exe 602,112 B；它与 Steam `MultiverseJourney` exe 的 VA 一致，nuro 引用的设施 VA 与之吻合）；
  - `MAPDAT.MKF` 优先路径；
  - 装饰图用资源 0x18 且有 58 帧；
  - 图 id 偏移 +0x26。
- **两个版本都验证过**（nuro）：
  - MKF 容器；
  - 压缩算法（878 个压缩资源全部与 C 参考实现逐字节一致）；
  - 表头和记录尺寸；
  - 4 张原版图的表规模。
- **Game 版不同的地方**（nuro）：
  - 装饰图用资源 12，17 帧；
  - 住宅建筑图是资源 27+5×map+level−1（资料片的基数是 39）；
  - 图 id 偏移 +26；
  - 股票模板位于 VA 0x47CE92（v3.11 是 0x47F072）。
- Steam 安装目录下有 `Game/`、`MultiverseJourney/`、`Media/Music`（nuro + 巴哈 snA=2189 两方印证）。

---

## 6. 提取方案（在用户自己的正版上照做）

### 6.1 输入

- Steam appid 2059810（Richman 4，DLC 2093880），或原版光盘安装目录。
- 两个版本各取一份：`Game/map.mkf`、`MultiverseJourney/map.mkf`；对应 exe 可选，用于核对股票表。
- 先对两个文件记录 SHA-256，再分别解析；两份资源 1 是否逐字节相同，本身就是一个待验证项。

### 6.2 MKF 容器（mytbk `csrc/mkf/mkf-format.md`、`mkf.c` 的 load_mkf/read_mkf；oama `packages/assets-pipeline/src/mkf.ts` 的 MkfArchive.header；nuro `tools/import_original.py` 的 parse_mkf）

```
X   = u32le(file[0])                 # 索引表起点
N   = (len(file) - X) / 4            # 必须整除
start[i] = u32le(file[X + 4*i])      # 资源 i 的绝对起点；start[0] 应为 4，且严格递增
hdr = 4 × u32le @ start[i]:
      {uncompressed, stored, img_off, img_size}
body = file[start[i]+16 : start[i]+16+stored]   # 不得越过下一个 start 或 X
if stored == uncompressed: data = body
else:                      data = decompress(body, uncompressed)
# img_size != 0 时要做像素格式转换，只影响图像资源，地图结构资源这两项为 0
# data 以 "SPR\0"/"SMP\0" 开头的是精灵库，与地图结构无关
```

- 资源 1 预期表头为 (7956, 7956, 0, 0)。这一点由「地图资源都是未压缩存储」推出，属 B 级。

### 6.3 私有压缩（兜底用）

参考实现（函数名）：

- mytbk `csrc/mkf/mkf_decompress.c`：mkf_decompress、cfcn_004551bb（解一个符号）、cfcn_00455109、cfcn_45511b（更新树）、cfcn_004550cc（减半）；表 table_483430、table_483530、ctab_orig。原版 VA 在 0x4550cc..0x4551bb。
- oama `packages/assets-pipeline/src/mkf-decompress.ts`：mkfDecompress、decodeSymbol、afterSymbol、updateTree、halveFrequencies、readBits32；表在 `mkf-tables.ts`。
- nuro `tools/decode_original_images.py`：decompress_private、_initial_huffman_tables、_distance_tables、_update_huffman_symbol、_normalize_huffman_tables。

算法是 LZHUF 类的自适应哈夫曼加 LZ77，比特序 **LSB-first**。

```
# 初始树（与 mytbk ctab_orig 逐项一致；表中存的是「索引×2」）
NCHAR=321, T=641, R=640
freq[0..641]: i<321 → 1；j=321..640: freq[j]=freq[2(j-321)]+freq[2(j-321)+1]；freq[641]=0xFFFF
son[0..640] : i<321 → (i+641)*2；321+k → (2k)*2
prnt[0..962]: i<640 → (321+i//2)*2；prnt[640]=0；prnt[641+s]=s*2 (s=0..320)；prnt[962]=0
# 距离前缀表（逐字节生成；抽样核对与 mytbk table_483430/483530 一致，实现后须全表比对）
for v in 0..255: blk=v>>4, lo=v&15
  lo==0          → LEN=8, HI=63-blk
  lo∈{7,15}      → LEN=3, HI=0
  lo∈{3,11,13}   → LEN=4, HI=3-{3:0,11:1,13:2}[lo]
  lo∈{1,5,9,14}  → LEN=5, HI=11-4*(blk%2)-{1:0,5:1,9:2,14:3}[lo]
  lo∈{2,6,10}    → LEN=6, HI=23-3*(blk%4)-{2:0,6:1,10:2}[lo]
  lo∈{4,8,12}    → LEN=7, HI=47-3*(blk%8)-{4:0,8:1,12:2}[lo]
bit(p) = (src[p>>3] >> (p&7)) & 1
decode_symbol():
  n=640; loop { c=son[n]/2; if c>=641 break; c+=bit(pos++); n=c }
  s=c-641; if freq[640]==0x8000: rescale(); bump(s); return s
bump(s):
  e=prnt[641+s]/2
  loop:
    freq[e]++; a=freq[e]
    if a<=freq[e+1]: e=prnt[e]/2; if e==0 return; continue
    l=e+1; while freq[l]==a-1: l++;  l--
    swap(freq[e],freq[l]); i=son[e]; j=son[l]
    prnt[j/2]=e*2; if j<0x502: prnt[j/2+1]=e*2
    prnt[i/2]=l*2; if i<0x502: prnt[i/2+1]=l*2
    son[e]=j; son[l]=i; e=prnt[l]/2; if e==0 return
rescale(): for s in 0..320: if freq[prnt[641+s]/2]&1: bump(s)
           for k in 0..640: freq[k]>>=1
main:
  while len(out)<size:
    s=decode_symbol()
    if s<256: out+=s; continue
    b=8 bits LSB-first @pos; L=LEN[b]; hi=HI[b]
    lo6=bits[pos+L : pos+L+6]; dist=(hi<<6)|lo6; pos+=L+6
    if dist==0xFFF: break                      # 结束标记
    n=min(s-253, size-len(out)); p=len(out)-1-dist
    repeat n: out+=out[p]; p++                 # 允许源与目标重叠，逐字节复制
```

许可说明：

- mytbk 与 oama 复刻都是 GPL-3.0，直接拷贝代码或表会让你的代码也受 GPL 约束。
- rich4-spec 与 nuro 没有许可证，只能参考阅读。
- 上面的表可以按规则**自行生成**，也可以从自有 exe 读取（【v3.11】VA 0x483430 / 0x483530 / 0x483630 起）。

### 6.4 解析

- 按第 2 节逐表、逐字段读取；第 0 项是哨兵，要跳过；表间距必须等于 (count+1)×步长。
- 字符串：从 +0x04 读到第一个 NUL，用 **CP950 / Big5** 解码。nuro 实测所有非空名字都能严格解码再编码回原字节。浏览器端用 `TextDecoder('big5')`。**同时保留原始 hex**。
- 为 v3.11 exe 解析股票模板时：【v3.11】VA 0x47F072 起，每项 36 字节 × 12 × 8 张图（Game 版 VA 0x47CE92、4 张图）。每项依次为：名字指针、u16 标志、u16 ×2、float 价格……（nuro 的 parse_stock_groups、oama 的 stocks.ts）。

### 6.5 输出 JSON（建议）

```json
{"schema":"rich4.map/v1","edition":"Game|MultiverseJourney","source":{"archive":"map.mkf","resource":1,"fileSha256":"…","payloadSha256":"…"},
 "globalMapId":0,"header":{"nodes":[103,40],"lands":[50,4200],"facilities":[4,6852],"companies":[3,7132],"landscapes":[21,7340]},
 "nodes":[{"id":1,"x":1752,"y":1871,"name":"","nameHex":"","adjSlots":[2,0,0,0],"type":8002,"ref":{"kind":"landscape","index":2},"decor":33,"flags":2147483648,"landingKind":0,"blockedSlots":[],"noObjects":true}],
 "lands":[{"id":1,"x":1463,"y":192,"name":"台北市","facing":0,"landPrice":2500,"housePrice":500,"rent":[500,1200,3000,7500,16000,30000],"nodes":[]}],
 "facilities":[{"id":1,"name":"花蓮市","facing":7,"landPrice":4000,"upgradeCost":400,"fee":[400,1000,2500,5000,8000],"nodes":[]}],
 "companies":[{"id":0,"name":"臺灣人壽","stockIndex":1,"industry":4,"feeBase":0,"assetValue":400000,"spriteId":0,"facing":0,"nodes":[51,52]}],
 "landscapes":[{"id":1,"name":"醫院","x":319,"y":990,"spriteId":144,"facing":0}],
 "derived":{"prisonGate":1,"hospitalGate":23,"prisonLanding":[12],"hospitalLanding":[16],"districts":{"台北市":[1,2,3,4]}}}
```

说明：

- `blockedSlots` 由 flags 的 bit(30−slot) 推出；`landingKind` = flags & 0xFF。
- 所有未决字节放进 `rawHex`，方便以后回填。
- 示例中 `id:0`、`feeBase:0`、`spriteId:0` 等是占位值，实际以解析结果为准。

### 6.6 自检（全部通过后才算提取正确）

1. 资源 1 长度 = 7956。表头 = 103/40、50/4200、4/6852、3/7132、21/7340。7340 + 22×28 = 7956。
2. 每张表的第 0 项全为 0；所有邻接值都 ≤ 103；50 个住宅节点的名字与住宅表逐一对上。
3. 住宅 1 = 台北市，(1463,192)，2500 / 500 / [500,1200,3000,7500,16000,30000]。
4. 新竹市地价 1000，rent 为 [200,500,1200,2800,6000,10000]。
5. 台南市 = 21..24，房价 500/300/300/300，rent 为 [300,750,2000,4800,10000,18000]。
6. 设施 1 = 花蓮市，4000，+0x24 表为 [400,400,1000,2500,5000,8000]。
7. 节点 1：type 8002，adj [2,0,0,0]，decor 33，flags 0x80000000。节点 23：type 8001。节点 12 / 16 的 flags 低字节为 4 / 5。
8. 景观 1 = 醫院 (319,990) / 144；景观 2 = 綠島 (1817,1960) / 259。
9. 臺灣人壽：资产额 400000，股票行号 1，行业 4。
10. 另三张图的规模分别为 144/73/8/4/26、110/49/5/6/16、118/55/8/6/16。

每项在两个版本上各跑一遍，差异写进报告。


## entries
- **公开渠道没有台湾图完整导出** [数据可得性] (high) 103 节点、50 住宅、4 设施、3 企业的全量数据必须从用户自有正版的 map.mkf 资源 1 解析；公开来源只够做校验样本 | 数值: mytbk 只有解析器；oama 测试读本地 extracted/map/0001.bin；nuro 数据在私有 LFS，fixture 为合成；Steam 指南 3489536813 已下架；巴哈地价帖均为 4 Fun | src: https://github.com/mytbk/rich4/blob/HEAD/tools/README.md, https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/loaders/map.test.ts, https://github.com/nurockplayer/richman4-remake/blob/HEAD/docs/assets.md
- **四张原版图的表规模** [地图数据] (high) 可直接作为提取后的断言 | 数值: 台湾 103/50/4/3/21；中国 144/73/8/4/26；日本 110/49/5/6/16；美国 118/55/8/6/16（节点/住宅/设施/企业/景观）；Game 与 MultiverseJourney 两个版本一致 | src: https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/map-format.md, https://github.com/nurockplayer/richman4-remake/blob/HEAD/docs/fidelity.md
- **台湾图资源 1 的长度与表偏移** [地图数据] (medium) 字节级自检锚点 | 数值: 长度 7956；node_off=40，land_off=4200，fac_off=6852，comm_off=7132，landscape_off=7340(0x1CAC)；7340+22×28=7956 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/docs/gaps/07-data-contracts.md, https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/map-format.md
- **台北市、新竹市、台南市样本** [住宅] (medium) 与任务给的校验样本完全一致；另得到台北市坐标、台南市编号 21..24、台北市 1..4、桃園市 5..8 | 数值: 台北市 (1463,192) 地价 2500，房价 500，rent [500,1200,3000,7500,16000,30000]；新竹市 1000，rent [200,500,1200,2800,6000,10000]；台南市 1500，房价 500/300/300/300，rent [300,750,2000,4800,10000,18000] | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/docs/gaps/07-data-contracts.md, https://github.com/oama1111/rich4-remake-public/blob/HEAD/docs/known-deviations.md, https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/toll.test.ts
- **台湾设施 1：花蓮市** [设施] (medium) 说明 +0x24 起 6 项中，[0] 是加盖价，[1..5] 是费率 | 数值: 地价(+0x22)=4000；+0x24 表=[400,400,1000,2500,5000,8000]；朝向 7 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/docs/gaps/07-data-contracts.md, https://github.com/nurockplayer/richman4-remake/blob/HEAD/tools/import_original.py
- **台湾三家上市企业与 12 支股票** [企业] (medium) 企业名与行业可以确定；各家收费基数(+0x22)未公开 | 数值: 中國信託：行业 7（银行），股 100，自留 0；臺灣人壽：行业 4（保险），资产额 400000，认购价 40，自留 5000 股，节点 51/52；大宇百貨：行业 10（推断），股 25，自留 0；其余 9 支（台積電 180、大宇資訊 80、台灣塑膠 60、裕隆汽車 60、遠東紡織 27、統一超商 310、震旦行 66、萊爾富 171、聯合報 280）没有对应公司 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/stocks.ts, https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/stocks.md, https://steamcommunity.com/sharedfiles/filedetails/?id=3489536813
- **台湾監獄 / 醫院的落点格与关押格** [特殊格] (medium) 落点格（开保释屏）与关押格（棋子被传送到的节点）是两个不同节点；关押期间棋子贴图画在景观坐标上 | 数值: 落点：監獄节点 12 (1248,1583)，醫院节点 16 (767,1631)；关押格：監獄节点 1 (1752,1871)，type 0x1F42，flags 0x80000000；醫院节点 23 (384,1056)，type 0x1F41；景观 1 醫院 (319,990) sprite 144，景观 2 綠島 (1817,1960) sprite 259 | src: https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/game-loop.md, https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/confinement.ts, https://richman.fandom.com/zh/wiki/%E5%8F%B0%E7%81%A3_(%E5%A4%A7%E5%AF%8C%E7%BF%814)
- **台湾景观名称** [景观] (low) 可用于悬停提示，并核对景观表 | 数值: 醫院、綠島、沙崙、野柳、基隆港、石門水庫、龜山、台中港、阿里山、玉山、澄清湖、佛光山、高雄造船、墾丁、陽明山、八卦山，另有 4 条空名（合计 20，与表头 21 差 1） | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/docs/deviations/Q-HOVER-1.md
- **地图结构：表头、1 基加哨兵、五张表的步长** [格式] (high) 解析器的核心约定；按 count 项解析而不跳过第 0 项会整表错位 | 数值: 表头 10×u32；步长：节点 0x28、住宅 0x34、设施 0x38、企业 0x34、景观 0x1C；表间距=(count+1)×步长；总长=landscape_off+(n+1)×0x1C | src: https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/map-format.md, https://github.com/mytbk/rich4/blob/HEAD/tools/map_data_parser.c, https://github.com/nurockplayer/richman4-remake/blob/HEAD/tools/import_original.py
- **住宅 +0x1C 与 +0x1E 的冲突裁决** [格式冲突] (high) 采用 +0x1C=地价、+0x1E=房价 | 数值: mytbk asm/rich4_map.h 与 ubnm 编辑器认为 +0x1E 是地价；mytbk csrc/land.h、oama、nuro 认为 +0x1C 是地价；台北市字节 +0x1C=2500、+0x1E=500；exe 0x41add5 以 land+0x1C×PI 作为地价 | src: https://github.com/mytbk/rich4/blob/HEAD/csrc/land.h, https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_map.h, https://github.com/nurockplayer/richman4-remake/blob/HEAD/docs/fidelity.md
- **企业记录的字段** [格式] (high) 企业收费全部以 +0x22 为基数 | 数值: +0x18 owner（运行期）；+0x19 股票行号（0 基）；+0x1A 行业；+0x1B 朝向；+0x20 图 id；+0x22 收费基数；+0x24 资产额；+0x28/+0x2C 盈余（运行期）；+0x30 自留股=10000−流通股 | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_map.h, https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/loaders/map.ts, https://github.com/nurockplayer/richman4-remake/blob/HEAD/tools/import_original.py
- **17 类落点（flags 低字节）** [特殊格] (high) 落点分派表 | 数值: 0 地产/企业，1 公園，2 新聞，3 命運，4 監獄，5 醫院，6 企鵝挖寶，7 七彩氣球，8 喜從天降，9 樂透，10 +50 点，11 +30 点，12 +10 点，13 卡片，14 銀行，15 百貨/商店，16 魔法屋；跳表 VA 0x4197e9 | src: https://github.com/oama1111/rich4-spec/blob/HEAD/gen/jumptables.json, https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/loaders/map.ts, https://github.com/nurockplayer/richman4-remake/blob/HEAD/docs/fidelity.md
- **静态封路位与禁放位** [特殊格] (medium) bit(30−槽号) 置位时，该邻接槽在走路和 AI 前瞻中都不能走；bit31 禁止放道具 | 数值: 掩码 0x40000000>>slot（0x40c12e、0x40b29e）；8 张图合计 bit27×3、bit28×7、bit31×47；bit8..15 为运行期占用位 0x100<<玩家号 | src: https://github.com/oama1111/rich4-spec/blob/HEAD/gen/db.txt, https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/map-format.md, https://richman.fandom.com/zh/wiki/%E5%8F%B0%E7%81%A3_(%E5%A4%A7%E5%AF%8C%E7%BF%814)
- **住宅与连锁店过路费** [收费] (high) 同名同主的住宅地块合并计租 | 数值: 过路费=PI×Σrent[level]（同名、同主、type=0）；连锁店=2000×店数×PI；+0x17 不为 0 时翻倍 | src: https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/land-rent.md, https://github.com/nurockplayer/richman4-remake/blob/HEAD/docs/original-remodel.md, https://forum.gamer.com.tw/C.php?bsn=972&snA=2175
- **设施收费：旅館、購物中心、加油站** [收费] (high) 加油站按交通工具和步数收费；工程车倍率 4 | 数值: 旅館=转盘1(n)×rate[lv]×PI 并住 n 天；購物中心=转盘2(1..6)×rate[lv]×PI；加油站=500×k×steps×PI，k 为机车 1、汽车 2、工程车 4，步行 0；买/首建=地价×PI，升级=rate[0]×PI；等级上限 [1,5,5,1,5] | src: https://github.com/oama1111/rich4-spec/blob/HEAD/gen/db.txt, https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/facility.ts, https://github.com/nurockplayer/richman4-remake/blob/HEAD/docs/original-facilities.md
- **航空公司（行业 1）裁决** [企业收费冲突] (high) 采用「转盘天数×收费基数×PI，并出国消失 n 天」；否定「费率×点数×PI」；oama 以栈槽未初始化为由判为未决，这一判断有误 | 数值: 转盘 0：n=0 占 2/12，1 占 4/12，2 占 4/12，3 占 2/12；费用=n×(+0x22)×PI；0x41b04f push 0 之后 [esp+0xd4]=原 [esp+0xd0]=n，再调用 0x40d375(玩家,n,0) | src: https://github.com/oama1111/rich4-spec/blob/HEAD/gen/db.txt, https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/game-loop.md, https://archive.org/download/Richman-4-Manual/%E5%A4%A7%E5%AF%8C%E7%BF%814%E8%AA%AA%E6%98%8E%E6%9B%B8_djvu.txt
- **电子公司（行业 3）** [企业收费] (high) 不乘物价指数 | 数值: 费用=(+0x22)×天数计数器 0x4990E4（开局为 0，每天 +1） | src: https://github.com/oama1111/rich4-spec/blob/HEAD/gen/db.txt, https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/save-scalars.md, https://github.com/nurockplayer/richman4-remake/blob/HEAD/docs/original-companies.md
- **保险公司（行业 4）与理赔** [企业收费] (high) 「费率」即收费基数×PI 按天计；台湾臺灣人壽的 +0x22 未知 | 数值: 天数 d∈{5,3,30,20,15,10}，各 1/6；非董事长费用=d×(+0x22)×PI；董事长免费获得 d 天；理赔=新增天数×2000×PI，由第一家行业 4 公司支付 | src: https://github.com/oama1111/rich4-spec/blob/HEAD/gen/db.txt, https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/places.md, https://github.com/nurockplayer/richman4-remake/blob/HEAD/docs/original-companies.md
- **汽车 / 石油（行业 5/6）裁决** [企业收费冲突] (high) 采用「收费基数×k×步数×PI」；nuro 的 700/500 常数很可能是数据值，未证实 | 数值: 费用=(+0x22)×k×steps×PI（0x41ac8c..0x41acc5）；k 为机车 1、汽车 2、工程车 4；步行免费 | src: https://github.com/oama1111/rich4-spec/blob/HEAD/gen/db.txt, https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/places/company.ts, https://github.com/nurockplayer/richman4-remake/blob/HEAD/game/core/game_state.gd
- **建设公司（行业 11）裁决：董事长加盖 2 层** [企业收费冲突] (high) 非董事长 +1 级并付工程费；董事长免费 +2 级（第一次已满 5 级则停）；oama 复刻注释写的「一级」有误 | 数值: 非董事长费用=目标地价(住宅 +0x1C / 设施 +0x22)×PI，无目标时 1000×PI；董事长在 0x41aae8、0x41aafc 两次调用 0x40b110；0x40b110 在升到 5 级时返回 bit 0x80 | src: https://github.com/oama1111/rich4-spec/blob/HEAD/gen/db.txt, https://github.com/nurockplayer/richman4-remake/blob/HEAD/docs/original-companies.md, https://archive.org/download/Richman-4-Manual/%E5%A4%A7%E5%AF%8C%E7%BF%814%E8%AA%AA%E6%98%8E%E6%9B%B8_djvu.txt
- **门派（行业 12）与不收费的行业** [企业收费] (medium) 台湾图用不到门派；行业 2/7/8/9/10 在企业落点分支中不收费 | 数值: 门派费用=(+0x22)×steps×PI；银行和百货走落点码 14/15；说明书的饭店规则与 exe 不符 | src: https://github.com/oama1111/rich4-spec/blob/HEAD/gen/db.txt, https://github.com/nurockplayer/richman4-remake/blob/HEAD/docs/original-companies.md
- **MKF 容器格式** [提取] (high) 地图结构资源为未压缩存储，可直接读取 | 数值: u32@0 为索引表偏移，表中存绝对起点，首项为 4；每个资源 16 字节头 {uncompressed, stored, img_off, img_size}；stored==uncompressed 表示未压缩 | src: https://github.com/mytbk/rich4/blob/HEAD/csrc/mkf/mkf-format.md, https://github.com/mytbk/rich4/blob/HEAD/csrc/mkf/mkf.c, https://github.com/nurockplayer/richman4-remake/blob/HEAD/docs/assets.md
- **私有压缩算法** [提取] (high) 兜底用；两个版本共 878 个压缩资源已被 nuro 逐字节验证 | 数值: 自适应哈夫曼 NCHAR=321/T=641/R=640，频次到 0x8000 时减半；LZ77 12 位距离，长度=符号−253（3..67），源为 out−1−dist，dist=0xFFF 表示结束，比特序 LSB-first | src: https://github.com/mytbk/rich4/blob/HEAD/csrc/mkf/mkf_decompress.c, https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/assets-pipeline/src/mkf-decompress.ts, https://github.com/nurockplayer/richman4-remake/blob/HEAD/tools/decode_original_images.py
- **Game 与 MultiverseJourney 版本差异** [版本] (medium) exe 侧的 VA 与行为只在 v3.11/MultiverseJourney 上验证；结构格式两个版本都验证过 | 数值: 装饰资源：v3.11 为 0x18（58 帧），Game 为 12（17 帧）；图 id 偏移：+0x26 对 +26；住宅建筑图基数：39 对 27；股票表 VA：0x47F072 对 0x47CE92 | src: https://github.com/nurockplayer/richman4-remake/blob/HEAD/docs/original-scenes.md, https://github.com/nurockplayer/richman4-remake/blob/HEAD/tools/import_original.py, https://github.com/mytbk/rich4/blob/HEAD/docs/map.txt

## open_questions
- 台湾图 50 块住宅的全部区名、地价、房价、rent，4 处设施中的 3 处，以及 3 家企业的收费基数(+0x22)、图 id、节点：公开渠道都没有，必须按第 6 节从正版 map.mkf 资源 1 提取。
- 臺灣人壽的 +0x22（保险费每天的基数）不明，所以台湾图的保险费额无法给出。
- nuro 写的汽车 700、石油 500：机器码的系数取自企业记录 +0x22，这两个数是否就是豐田汽車/福特汽車与中國石油的 +0x22 值，需提取中、美、日图后核对。
- Steam 版 Game/map.mkf 与 MultiverseJourney/map.mkf 的资源 1 是否逐字节相同；Steam 版与 1998 年光盘版（v2.06 等）的地名、股票名是否被改动（Steam 已把地图标题改成「地圖1」等）。
- 台湾图景观：已知名称 16 个加空名 4 个，合计 20，与表头的 21 差 1，需要提取后核对。
- flags 的 bit27/28 在台湾图上落在哪些节点、哪些槽；「水路」在格式里是否有专门字段（目前只找到 bit27..30 的按槽封路，没有找到水路标记）。
- 住宅 +0x1B / 设施 +0x1B（朝向）、住宅 +0x2C、设施 +0x26..0x2F 之外字节的完整语义；企业 +0x1A 中 10 为百货属于推断。
- 大宇百貨的行业码是否为 10（依据只有一个测试 fixture 和名称推断）。
- 走路例程在岔路上对真人也调用 rand()%n 选路：真人是否另有选路分支，需要更全面地反汇编核对。
- 航空出国的触发条件里还有一个全局标志 [0x46caf8]==0，其语义未知（银行柜台分支也检查它）。
- Game 版 exe 的企业与设施收费机器码是否与 v3.11 完全相同，目前只有 VA 不同的间接证据。

## sources
- https://archive.org/download/Richman-4-Manual/%E5%A4%A7%E5%AF%8C%E7%BF%814%E8%AA%AA%E6%98%8E%E6%9B%B8_djvu.txt
- https://github.com/mytbk/rich4/blob/HEAD/docs/map.txt
- https://github.com/mytbk/rich4/blob/HEAD/tools/map_data_parser.c
- https://github.com/mytbk/rich4/blob/HEAD/tools/plot_map.py
- https://github.com/mytbk/rich4/blob/HEAD/csrc/land.h
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_map.h
- https://github.com/mytbk/rich4/blob/HEAD/csrc/mkf/mkf-format.md
- https://github.com/mytbk/rich4/blob/HEAD/csrc/mkf/mkf.c
- https://github.com/mytbk/rich4/blob/HEAD/csrc/mkf/mkf_decompress.c
- https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/map-format.md
- https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/land-rent.md
- https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/places.md
- https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/game-loop.md
- https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/stocks.md
- https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/save-scalars.md
- https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/small-games.md
- https://github.com/oama1111/rich4-spec/blob/HEAD/gen/db.txt
- https://github.com/oama1111/rich4-spec/blob/HEAD/gen/jumptables.json
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/loaders/map.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/loaders/map.test.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/docs/map-format.md
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/docs/gaps/07-data-contracts.md
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/docs/known-deviations.md
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/docs/deviations/Q-HOVER-1.md
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/docs/deviations/Q-COMMERCIAL-1.md
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/docs/deviations/T-052.md
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/places/company.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/facility.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/god-toll.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/confinement.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/toll.test.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/stocks.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/assets-pipeline/src/mkf.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/assets-pipeline/src/mkf-decompress.ts
- https://github.com/nurockplayer/richman4-remake/blob/HEAD/docs/fidelity.md
- https://github.com/nurockplayer/richman4-remake/blob/HEAD/docs/assets.md
- https://github.com/nurockplayer/richman4-remake/blob/HEAD/docs/original-companies.md
- https://github.com/nurockplayer/richman4-remake/blob/HEAD/docs/original-facilities.md
- https://github.com/nurockplayer/richman4-remake/blob/HEAD/docs/original-scenes.md
- https://github.com/nurockplayer/richman4-remake/blob/HEAD/tools/import_original.py
- https://github.com/nurockplayer/richman4-remake/blob/HEAD/tools/decode_original_images.py
- https://github.com/nurockplayer/richman4-remake/blob/HEAD/game/core/game_state.gd
- https://github.com/ubnm/Richman4Editor/blob/HEAD/index.html
- https://steamcommunity.com/sharedfiles/filedetails/?id=3489536813
- https://store.steampowered.com/app/2059810/
- https://richman.fandom.com/zh/wiki/%E5%8F%B0%E7%81%A3_(%E5%A4%A7%E5%AF%8C%E7%BF%814)
- https://forum.gamer.com.tw/C.php?bsn=972&snA=2189
- https://forum.gamer.com.tw/C.php?bsn=972&snA=2175
- https://forum.gamer.com.tw/C.php?bsn=972&snA=2030