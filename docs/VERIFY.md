# 待核实清单（VERIFY）

> 来源：`docs/architecture.md` §11（初始清单）。领域细节见 design/data-pipeline.md §14、design/engine.md §18、design/minigames-ai.md §11。
>
> **方式**：**E** = `npm run extract` 自动提取；**R** = `r2 -q -c 'pd …'` 人工反汇编核对（v3.11 的 VA 见 design/minigames-ai.md §11、design/engine.md §18）；**P** = 用户在原版 v2.06 里实机操作，或提供 SAVE*.DAT 由导入工具比对。
>
> **状态**：✅ 已核实　🟡 部分核实（结论栏写明剩余部分）　⬜ 待核实　❌ 与预期不符（结论栏写明处理）
>
> **回写路径**：核实结论先改 `packages/shared/src/data/tables` 中的数值或 `RuleConfig` 默认值，再刷新 golden，升 `ENGINE_VERSION` 次版本号，最后更新 `docs/DEVIATIONS.md` 与本文件。
>
> **卫生**：本文件只记录结论、计数、哈希与定位，不粘贴原版资源的原始字节或整表数据；原版文件与派生数据留在 `original/`、`.cache/`、`rich4-data/`（均不入库）。

## 文件与容器（V-F）

| ID | 核实项 | 方式 | 状态 | 结论 | 证据 |
|---|---|---|---|---|---|
| V-F1 | Steam 目录结构；`Game/MapDat.mkf` 是否存在、资源数；台湾结构资源是否压缩（压缩则 LZHUF 解码器进入关键路径） | E | ✅ | 目录含 `Game/` 与 `MultiverseJourney/`。`Game/MapDat.MKF` 存在（扩展名为大写），共 4 个资源。台湾结构资源（资源 0）**未压缩**，7956 字节（资源头的原始大小等于存储大小）。因此 LZHUF 解码器不在台湾图的关键路径上 | 2026-09-26 本会话只读读取 MKF 索引表与资源头；资源 0 表头计数按「景观表偏移 + (景观数+1)×0x1C」复算总长，恰为 7956 |
| V-F2 | 两个 RICH4.EXE 的 sha256 是否分别为 `110b29f9…`（v2.06）、`50cb24bb…`（v3.11）；与 mytbk 参考版 `5a90aee2…` 的差异；有无 SteamStub 或其他壳节 | E | 🟡 | 哈希一致：`Game/rich4.exe` = `110b29f9d2fadcff3836eb69ec380aa264951859c90955da6e11158d2f956a13`（v2.06）；`MultiverseJourney/rich4.exe` = `50cb24bbbd86353e26127e8e89e891c437984655d338a32f1458a3b79596219f`（v3.11）。两者节表均为 Watcom 典型的 AUTO/.idata/DGROUP/.bss/.reloc/.rsrc，**无 SteamStub（.bind）或其他壳节**。剩余：v3.11 与 mytbk 版大小相同（602,112 字节）但哈希不同，差异字节的位置与范围待 D2 `extract exe diff` 比对 | 2026-09-26 本会话 `shasum -a 256` 与 PE 节表只读解析 |
| V-F3 | MKF 索引表最后一项是否为哨兵；map.mkf 资源数（v3.11 应为 298）；两版压缩资源总数（约 878） | E | 🟡 | 索引表位于文件尾、首项为 4。`MultiverseJourney/map.mkf` 索引项 298 个，`Game/map.mkf` 150 个；末项都小于索引表偏移，是最后一个资源的起点而非指向文件尾的哨兵。剩余：两版压缩资源总数待 `extract mkf ls` 统计 | 2026-09-26 本会话只读读取两个 map.mkf 的文件头与索引表 |

## 地图（V-M）

| ID | 核实项 | 方式 | 状态 | 结论 | 证据 |
|---|---|---|---|---|---|
| V-M1 | 三个来源（v206-MapDat[0]、v206-map.mkf[1]、v311-map.mkf[1]）的规则字段是否一致；不一致时由用户选基线 | E | ✅ | 台湾图三个来源的**规则字段完全一致**，差异只在贴图编号类字段：node+0x22（decor）、company+0x20、landscape+0x1a，不影响规则，无需用户选基线。另发现（不属台湾图）：日本图 land17 的 rent[1] 在 MapDat 与 map.mkf 中不同（750 vs 7500），⚑ 待接入日本图时核实并由用户定基线 | 2026-09-26 会话内对三个来源的原始记录逐字段比对 |
| V-M2 | 住宅地：0x1c 地价、0x1e 房价、0x20 租金[6]；设施：0x22 地价、0x24 rateWindow、0x34 flast | E | ⬜ | | |
| V-M3 | 企业：0x19 股票下标、0x1a 行业码（7 以外的对应）、0x22 tollBase、0x24 assetValue（台灣人壽是否为 400000） | E | 🟡 | 台湾 3 家企业：中國信託 行业 7、股票行 0、tollBase 0、assetValue 900000；臺灣人壽 行业 4、行 1、tollBase 750、assetValue **400000**；大宇百貨 行业 10、行 2、tollBase 0、assetValue 200000。+0x19 指向的股票模板都是 hasCompany=1 且与企业同名，hasCompany 的股票数 = 企业数 3。「assetValue ÷ 10000 = 初始股价」只对臺灣人壽成立（40），另两家不成立（90≠100、20≠25），不能当规则用。剩余：7、4、10 以外的行业码（航空 1、电子 3、建设 11、门派 12 等）在其他地图，接入时核对 | 2026-09-27 `npm run extract -- map build --map taiwan --strict4`（企业↔股票核对，见 docs/research/provenance-summary.md §3） |
| V-M4 | flags 低字节与节点名是否一致；bit(30−k) 是否为槽 k 的封路位（台湾应恰好 2 处）；bit31 的节点数 | E | ⬜ | | |
| V-M5 | +0x1b facing 的语义，及其与地块到路格方向的映射 | E | ⬜ | | |
| V-M6 | 世界坐标对 32 取模的残差；对角边、长边、同格节点；邻接是否对称 | E | ⬜ | | |
| V-M7 | 8001/8002 关押格是否可走、是否兼有落点码、引用的景观名 | E | ⬜ | | |
| V-M8 | 样本：台北、新竹、台南；计数 103/50/4/3/21；Big5 严格解码与回编码 | E | 🟡 | 台北、新竹、台南三组样本与参考资料**吻合**；MapDat 资源 0 表头计数为 节点 103 / 住宅 50 / 设施 4 / 企业 3 / 景观 21，与预期一致。剩余：Big5 严格解码与回编码以 `extract map build` 报告为准 | 2026-09-26 会话内样本比对；表头计数本会话只读复核 |

## 程序常量与数据表（V-E）

| ID | 核实项 | 方式 | 状态 | 结论 | 证据 |
|---|---|---|---|---|---|
| V-E1 | 卡片表、道具表两版逐字节比较（裁决 Fandom 上嫁祸、红卡、涨价、同盟 4 张卡的价格） | E | ✅ | 卡表 30×8（v2.06 VA 0x47d552 / v3.11 0x47fdf2）与道具表 13×8（0x47d642 / 0x47fee2）两版内容**逐项一致**（名称、初始张数、点券价、f6、f7），原始字节只差名称指针。争议卡价两版都是 **嫁禍 40、紅卡 50、漲價 35、同盟 40**，Fandom 数值判为 wiki 错误；初始张数之和 100；道具 1..8 价格 [15,30,25,25,80,150,100,30]，库存前 8 种 10、后 5 种 0。手录 cards.ts、items.ts 与 exe 一致 | 2026-09-27 `npm run extract -- exe tables` / `exe diff` / `verify --tables`（报告 docs/research/version-diff.md §4；抽取结果 .cache/extract/tables.{v206,v311}.json）；v2.06 由签名定位并经 xrefTransfer 从 v3.11 迁移交叉核对一致 |
| V-E2 | 角色表 12×0x68：性格、借贷、现金、炒股比例、颜色、能力位 | E | ✅ | 角色表（v2.06 0x47c62c / v3.11 0x47e80c）两版全部字段一致：+0x13 编号 0..11；+0x14 性别（1 男）；+0x16 能力位全为 3；+0x17 性格 [2,1,2,2,1,1,1,0,0,0,1,2]；+0x18 借贷 [60,100,0,100,50,75,100,0,0,50,30,80]；+0x19 现金 [50,40,70,60,40,70,50,40,60,50,55,80]；+0x1a 炒股 [30,45,0,30,25,30,20,35,20,0,15,0]；+0x04 颜色；+0x12 全为 1、+0x15 全为 0，其余字节全 0。手录 characters.ts（含颜色、性别）与 exe 一致 | 2026-09-27 `npm run extract -- exe tables` / `exe diff` / `verify --tables`（报告 docs/research/version-diff.md §4；抽取结果 .cache/extract/tables.{v206,v311}.json） |
| V-E3 | 股票表有 48 项还是 96 项；台湾 12 支；价格是否为整数分；波动系数 | E | ✅ | 每项 36 字节：名称指针、u16 hasCompany、u16、u16 流通股、u16、f32×3 价格（模板中三者相等）、f32 波动、8 字节 0；表尾紧接卡表。v2.06 **48 项**（4 图，0x47ce92），v3.11 **96 项**（8 图，0x47f072），共有 48 项逐项一致。台湾 12 支名称/初始价/波动与样本全部吻合，价格 ×100 全为整数分；波动取 f32 位型（如 0.6 = 0x3f19999a）。已写入台湾 MapDef（stocks，initPriceCents + volatility + volatilityF32，名称去排版空格） | 2026-09-27 `npm run extract -- exe tables` / `exe diff` / `verify --tables`（报告 docs/research/version-diff.md §4；抽取结果 .cache/extract/tables.{v206,v311}.json）；`map build --map taiwan` |
| V-E4 | 开局三张表的数值，以及**默认资金档位的索引**（300000 还是 200000） | E + P | 🟡 | 三表两版相同：总资金 [300000,200000,100000,50000,30000,10000]、期限 [0,730,365,182,91,30]、倍率 [0,100,50,10,5,3]（v2.06 0x46aa40/0x46aa94/0x46aaac，v3.11 0x46cb94/0x46cbe8/0x46cc00）。**默认资金档位下标 = 1 → 200000**：新开局初始化把下标变量（v3.11 0x46cb40、v2.06 0x46a9ec，静态初值也是 1）写为 1；期限、倍率下标为 0（无限 / 无）。非新开局分支按当前总资金反查下标、沿用上局设置，推测存档实证 300000 来自这一分支。剩余（P）：实机确认首次新局默认值（V-R15） | 2026-09-27 `npm run extract -- exe tables` / `exe diff` / `verify --tables`（报告 docs/research/version-diff.md §4；抽取结果 .cache/extract/tables.{v206,v311}.json）；r2 人工复核 v3.11 `pd` 0x406f16..0x406fc6（fcn.00406de7） |
| V-E5 | 节日表每项 12 字节的布局与标志位（休市、送卡、BGM）；图数；农历节日怎么表示 | E + R | ✅ | 紧随道具表（v2.06 0x47d6aa / v3.11 0x47ff4a），每图 24 项，v2.06 4 图、v3.11 8 图。布局：+0 非 0 即休市、bit7 停用（查找时跳过）；+1 kind 0 公历 / 1 农历 / 2 第 n 个星期 w；+2 月；+3 日（kind 2 为 n）；+4 星期；+5 事件位 bit0 图片、bit2 换 BGM、bit3 每人发 1 张卡；+6/+8 图片资源号与参数；+10 BGM 曲号。农历项查 exe 内农历表（1998-01-01..2020-12-31 共 8401 天，两版相同）。台湾 24 项：公历 15、农历 8、第 n 星期 1，休市 17，slot 12（10/31）停用，12/25 休市+发卡+BGM，农历 12/31 在表中永不命中（原版瑕疵）。两版只差图片资源号。**HolidayDef 增加可选 `weekday`**（schema 同步，validateMap 新增 `E_HOLIDAY_FIELD`：kind 2 必须有 0..6 的 weekday、day 1..5，其他 kind 不带），台湾图 kind 2（5 月第 2 个星期日）写 weekday 0，flagsRaw = flags0 \| 事件 << 8 \| 星期 << 16 兼容保留；台湾 MapDef 已重建并 pack（dataHash `3c2f31eb…a551`）。农历表逐日数据（`lunar.packed`，u32 = 年<<16 \| 月<<8 \| 日）与按月归并（`lunar.months`，285 个月、9 个闰月；首项从 1998-01-01 的十二月初三起，不是整月）导出到 tables.<ed>.json。未解但不影响规则：+5 bit1（元旦、雙十置位，代码无引用）、+8 图片参数与 BGM 延续标志；2021 年以后原版查表越界时的行为 | 2026-09-27 `npm run extract -- exe tables` / `exe constants` / `verify --constants` / `exe diff`（报告 docs/research/version-diff.md §5、docs/research/events-from-exe.md；抽取结果 .cache/extract/tables.{v206,v311}.json、constants.json）；r2 人工复核 v3.11 0x4521f0（查找）、0x4523d5（休市判定）、0x452444（当日事件） |
| V-E6 | 设施等级上限、魔法屋表、商店系数 0.9、月息 1.1、rand 常量、LZHUF 位置码表 | E | 🟡 | 设施等级上限两版相同：公园 1、旅馆 5、购物中心 5、加油站 1、研究所 5（v3.11 0x474940 / v2.06 0x4727ec）。魔法屋效果表 12 × 16（图标号、转盘 x/y、名称；v3.11 0x475718 / v2.06 0x47354c）与条件名表（0x4756b8 / 0x4734ec）按签名定位，两版相同。商店卖回 × 0.9（double；卡 0x42d174、道具 0x42d1da / v2.06 0x42c54d、0x42c5b3），**只用于商店卖回**：命运 32 与魔法屋效果 0、8 按全价折点券。月息 × 1.1（0x438207 / 0x437363，截断）**只对贷款 = 0 的玩家**；银行界面的利息预览 = 存款 × 0.1。rand：next = next × 0x41C64E6D + 0x3039，返回 (next >> 16) & 0x7FFF（0x456f37..0x456f4a / 0x455597..），两版相同。剩余：LZHUF 位置码表未抽取（地图结构资源未压缩，不在关键路径上，E6 解码器实现时再核对） | 2026-09-27 `npm run extract -- exe tables` / `exe constants` / `verify --constants` / `exe diff`（报告 docs/research/version-diff.md §5、docs/research/events-from-exe.md；抽取结果 .cache/extract/tables.{v206,v311}.json、constants.json） |
| V-E7 | 新闻 36、命运 37、魔法屋 12 的文案与系数，两版之间的常量差异（funcdiff） | E | ✅ | 新闻指针表 36（v3.11 0x475e24 / v2.06 0x473c48）+ 分类号 36 + 分类名 6；命运指针表 49（0x475ef0 / 0x473d14，37 张 + 编号 33–36 在地图组 1–3 的文案变体 12 个）；魔法屋效果/条件的两张代码内跳表（0x431c7a、0x431812 / 0x431063、0x430bfb）；全部按版本无关的签名定位，v2.06 另经 xrefTransfer 迁移一致。逐条参数（金额 × 物价指数、天数、概率、目标选择方式、可行条件、加持类别）进 tables.<ed>.json 的 news / fate / magic 字段，人读摘要见 docs/research/events-from-exe.md。两版逐条相同（155 个常量锚点两版值全同；函数级对比中新闻/命运/魔法屋处理函数的数值差异只有资源号等表现层）。唯一的规则层差异：v3.11 的命运可行性对 33–36 加了「地图组 = 0」条件（资料片地图不抽坐牢命运），v2.06 无此分支。与社区资料的主要出入：新闻 9 补助对象含 0 块地的玩家且并列取座位号最小；新闻 12 地价税含设施；新闻 35 上涨天数按 16 取模、累计盈余加 2 × 原盈余；命运查加持的是 33 条（不是 28 条），「汽车超速」也查；命运 3、8、9、10、11、32 只处理免付/逃过，不加倍；命运 32 与魔法屋 0、8 全价折点券（不乘 0.9）；罚金类命运投保时由保险公司赔同额 | 2026-09-27 `npm run extract -- exe tables` / `exe constants` / `verify --constants` / `exe diff`（报告 docs/research/version-diff.md §5、docs/research/events-from-exe.md；抽取结果 .cache/extract/tables.{v206,v311}.json、constants.json）；v3.11 新闻 0x448be2..0x44b895、命运 0x44b896..0x44dd9e、魔法屋 0x431842..0x4339d8 逐函数人工反汇编 |
| V-E8 | 转盘数值：旅馆 12 格排列、保险天数、航空转盘、购物中心倍数 | E + R | ✅ | 设施转盘表 4 × 12 字节（v3.11 0x475d0c / v2.06 0x473b20，经引用指令迁移，两版相同）：起点 rand % 12，逐格 +1（模 12）转动，最后停在第一个非 0xFF 的格。0 航空（出国天数）[1,空,0,空,1,空,2,空,3,空,2,空] → 0 天 2/12、1 天 4/12、2 天 4/12、3 天 2/12；1 旅馆（住宿天数）[空,空,1,空,空,4,空,3,空,空,2,空] → 1 天 4/12、2 天 3/12、3 天 2/12、4 天 3/12；2 购物中心（倍数）1、6、5、4、3、2 各 2/12；3 保险（天数）5、3、30、20、15、10 各 2/12。与 g_map §4.2–4.3 一致 | 2026-09-27 `npm run extract -- exe tables` / `exe constants` / `verify --constants` / `exe diff`（报告 docs/research/version-diff.md §5、docs/research/events-from-exe.md；抽取结果 .cache/extract/tables.{v206,v311}.json、constants.json）；r2 人工复核 v3.11 0x43f7c6（转盘）、0x43f127（步进）、0x44090e（转盘对话框） |
| V-E9 | 常量复核：炸弹 38、娃娃 9、飞弹半宽 100、核弹 220、视窗 440、神明重生 300、恶人步数 rand%9+2、乐透 36 个号 / 1000 元、保释 30 / 雇恶人 300、贷款 90 天、乞丐 1000、个股停牌 15 | E + R | ✅ | 全部核实且两版相同（anchors/constants.json，`verify --constants` 返回 0）：定时炸弹拾取时引信 38；机器娃娃 9 步；飞弹范围半宽 100；核子飞弹传 −1 = 整个 440 × 440 视窗（中心 220，即半宽 220）；神明重生：新旧位置 \|dx\| < 300 且 \|dy\| < 300 时重抽；恶人步数 rand % 9 + 2；乐透号码 36 个、每注扣现金 1000（不乘物价指数）并进公库，电脑现金 > 1000 才买；保释点券表：玩家 30、恶人 300（监狱 0x475c44、医院 0x475ca4，u32 × 8）；贷款 90 天（遇休市日顺延）；乞丐施舍 1000 × 物价指数进公库；个股停牌写入 15 天（文案 10 天）。另：小游戏不玩分支 50 + rand % 20 点（见 V-C1）。v2.06 地址见 docs/research/events-from-exe.md §5 | 2026-09-27 `npm run extract -- exe tables` / `exe constants` / `verify --constants` / `exe diff`（报告 docs/research/version-diff.md §5、docs/research/events-from-exe.md；抽取结果 .cache/extract/tables.{v206,v311}.json、constants.json）；v3.11 各常量所在指令人工 r2 复核 |
| V-E10 | 视野投影表（0x46ccf0、0x474910），用于替换 geom/viewWindow | E + R | 🟡 | 已定位并抽取，两版相同（v2.06 0x46ab9c、0x4727bc、0x4714bc 经引用迁移）：0x46ccf0 为 8 个视角 × 29 × 29 相对格（dx, dy ∈ −14..14，dx 外层）→ 屏幕像素偏移 (x, y)（int16，每视角 0xd24 字节；中心格为 (0,0)；非严格线性，含舍入）；0x474910 为 8 个视角的格内亚像素 2 × 2 矩阵 [a,b,c,d]（int8，sx = (a·x + c·y) >> 5，sy = (b·x + d·y) >> 5，x/y 为世界坐标 & 31）；0x473610 为每视角的绘制顺序（(dx, dy) 字节对，−128 结束，各 296 项）。数据在 tables.<ed>.json 的 view 字段。剩余：geom/viewWindow 接入与 AI 视窗（−220 ≤ 投影偏移 < 220）的对照留给 M3/M9 | 2026-09-27 `npm run extract -- exe tables` / `exe constants` / `verify --constants` / `exe diff`（报告 docs/research/version-diff.md §5、docs/research/events-from-exe.md；抽取结果 .cache/extract/tables.{v206,v311}.json、constants.json）；r2 人工复核 v3.11 0x407a2c（亚像素投影）、0x408429（逐格绘制） |

## 小游戏、AI 与时序（V-C）

| ID | 核实项 | 方式 | 状态 | 结论 | 证据 |
|---|---|---|---|---|---|
| V-C1 | 小游戏：who_plays==1 才亲自玩、不玩分支 2 次 rand、企鹅计时/DDA/揭晓期间点击是否被吞、气球生成/命中框/999 夹子/无可用跑道时是否掷 rand、喜从天降炸弹 30%/**静止时能否接住**/更新顺序/财神状态机、「動畫過程」和梦游闸门、v2.06 与 v3.11 是否相同（M1–M21） | R | 🟡 | 已核实（常量锚点，两版相同）：M1 玩家类型 = 1（真人）且动画开关开启才亲自玩（0x41560d）；M2 不玩分支 = 50 + rand % 20 点，之后再掷 rand & 1 选台词（0x415457..）；M3 企鹅件数模板 [3,12,3,9,1]（代码节内 0x411fc8），合计 28，满分 = Σ 件数 × [0,5,12,8,20] = 188；M5 企鹅游玩 150 tick、intro 10 tick、计时器 100ms；M8 气球速度表、M9 特殊表、M14 喜从天降落速表与 minigames-ai §11 一致；气球 16 槽、8 条跑道（x = 40 起、步长 80、< 640）、游玩 150 tick；M12 数字气球计分 ≥ 1000 时写 999；喜从天降游玩 360 tick；M15 炸弹预警 = rand % 10 ≥ 7（30%）。M20：三个小游戏的常量两版全部相同，函数级对比中小游戏入口函数只有 Panel.mkf 加载方式等表现层差异。剩余（R，留给 M8）：M4 企鹅格表逐格、M6 DDA 取整、M7 揭晓期间点击、M10 无可用跑道时是否掷 rand、M11 命中框、M13 精灵尺寸、M16 静止时能否接住、M17 更新顺序、M18 财神状态机、M19 图标、M21 梦游闸门。M8 第一部分 sim 的暂定实现（⚑，architecture §18.4）：M18 财神按「frame 0..4 每拍 12px、frame 5 为决策拍」建模，初始 spawnFrame = 0；M16/M17 进入 ending（时间到或接到炸弹）后接物者停下、不再判定接住，初始接物者 x = 320；M10 无可用跑道时不掷选道 rand（开关 ROLL_LANE_WHEN_NONE）；气球冻结先 freeze-- 再判断移动 | 2026-09-27 `npm run extract -- exe tables` / `exe constants` / `verify --constants` / `exe diff`（报告 docs/research/version-diff.md §5、docs/research/events-from-exe.md；抽取结果 .cache/extract/tables.{v206,v311}.json、constants.json） |
| V-C2 | AI：个性闸门、硬币、候选 8/4、买地保留额、骰子策略、银行（借款是否要求贷款==0、30000 是否乘 PI）、股票常量、商店顺序表、保释/魔法屋/乐透/拍卖/公布栏分支、特別融資、核弹阈值（A1–A13） | E + R | 🟡 | 已核实（常量锚点，两版相同）：A4 买地保留额 = min(trunc(开局资金 × 0.05), 7000) × 物价指数（0x41d7d4）；A5 骰子策略前瞻 5 格（0x42221e）；A6 银行柜台：被拒绝往来不办；有贷款时，距到期 ≤ 6 天且 现金+存款 ≥ 1.1 × 贷款、或 2 × 贷款 < 存款 → 全额还清；**贷款 = 0 时**才考虑借款：rand % 10 == 0 或 现金+存款 < 30000（**不乘物价指数**），且未遇挤兑、角色借贷比例 ≠ 0 → 贷款 = trunc(借贷比例 × 身家 / 100)（赋值，不另取额度上限）并存入存款；A10 部分：魔法屋电脑 rand % 12 选条件（无人符合重抽）、名单含自己时选效果 6、否则 rand % 11（6 改 7）；乐透电脑现金 > 1000 才买、随机选未被买走的号码。A1、A2 见 V-E1、V-E2。剩余（R，留给 M4/M6 的 AI 代理）：A3 个性闸门/硬币/候选、A7 现金重分配常量、A8 股票打分常量、A9 商店顺序表、A10 其余（保释、拍卖、公布栏）、A11 视窗投影（数据见 V-E10）、A12 特別融資、A13 核弹阈值。M4 进展：`OriginalAiPolicy` 已按上述 A4、A5、A6 与乐透、魔法屋条件实现；A8 卖股打分按调研方向简化 ⚑、月均盈余取 累计盈余 ÷ (trunc(已过天数/30)+1) ⚑（ai/stock.ts）；A12 仍不用特別融資（DEV-11）；服务器默认策略已切到原版 AI（architecture §18.6） | 2026-09-27 `npm run extract -- exe tables` / `exe constants` / `verify --constants` / `exe diff`（报告 docs/research/version-diff.md §5、docs/research/events-from-exe.md；抽取结果 .cache/extract/tables.{v206,v311}.json、constants.json）；r2 人工复核 v3.11 0x436668（银行柜台）、0x43380a（魔法屋）、0x4315cc（乐透） |
| V-C3 | 工程车与神明显灵的先后；定时炸弹先倒数还是先转移 | R | ⬜ | | |

## 实机规则（V-R）

| ID | 核实项 | 方式 | 状态 | 结论 | 证据 |
|---|---|---|---|---|---|
| V-R1 | 坐牢 N 天实际经过的回合数；停留卡、乌龟卡的次数；陷害被嫁祸回来是 4 天 | P | ⬜ | 未核实。M1 暂按「坐牢 N 天 = N 个受阻回合 + 1 个走回棋盘、不掷骰的回合（RETURNED）」实现（architecture M1 验证清单）；与 g_arbitration §3.3（MY/NU：释放当回合照常行动）冲突，以实机为准（architecture §17） | |
| V-R2 | 首回合跳伞后是否立即掷骰、是否结算落点 | P | ⬜ | 未核实。M1 暂按「跳伞落地后不结算落点，随即照常进入回合菜单、可以掷骰」实现（⚑，architecture §17） | |
| V-R3 | 梦游者落点：是否付过路费、是否触发地雷和神明 | P | ⬜ | | |
| V-R4 | 定时炸弹是否伤及 3×3 范围内的其他人 | P | ⬜ | | |
| V-R5 | 满手时拿到第 16 张卡是否弹窗让玩家选弃哪张 | P | ⬜ | 未核实。M1 暂按 `handFull` 自动弃最便宜的一张实现，DISCARD_CARD 决策留到 M6（architecture §17） | |
| V-R6 | 星期日 ATM 和柜台能否使用 | P | ⬜ | 未核实。M4 按开关实现：PROGRAM（`sundayBankClosed:false`）星期日照常营业；MANUAL 星期日 ATM 与柜台都只发 `BANK_REJECTED{reason:'sunday'}`（architecture §18.1） | |
| V-R7 | 魔法屋：名单有自己时能否选全部效果；坐牢住院能否被免罪卡、嫁祸卡挡掉；「拍卖当格」的钱归谁 | P | ⬜ | | |
| V-R8 | 命运坐牢能否用免罪卡；罚款能否用免费卡 | P | ⬜ | | |
| V-R9 | 投降流程（拍卖范围、投降者是否变乞丐） | P | ⬜ | | |
| V-R10 | 四大恶人：雇用后何时移动；间谍偷租金是否存在；被关押释放后的去向 | P | ⬜ | | |
| V-R11 | 红卡、黑卡实际有效天数；个股停牌是 10 天还是 15 天 | P | ⬜ | | |
| V-R12 | 大财神附身时住旅馆是否免住宿；死神能否被送神符送走、会不会被其他神挤掉 | P | ⬜ | | |
| V-R13 | 保险重复投保是覆盖还是累加；航空消失天数 | P | ⬜ | 未核实。M4 暂按：重复投保累加（(旧值 + 新天数) & 0x7f，与原版加刑写法相同）；航空转盘 n 天 = n 个受阻回合 + 1 个走回棋盘的回合，n = 0「不用出國」不收费（architecture §18.1）⚑ | |
| V-R14 | 月结冠军和悲情人物有无奖金；点券超过 65535 的行为 | P | ⬜ | 未核实。M4 的月结只评出冠军与悲情人物并发 `MONTHLY_REPORT`，不发奖金 ⚑；点券默认饱和到 65535（DEV-01） | |
| V-R15 | 默认总资金；受困者能否参加拍卖、能否被选为嫁祸目标 | P | ⬜ | 默认总资金：exe 默认档位下标为 1（V-E4），GameConfig 默认已改为 200000；实机首次新局的默认值仍待确认。受困者参加拍卖、被选为嫁祸目标两项待核实 | |
| V-R16 | 工程车拆房的实际表现；换地卡是否交换地契期限 | P | ⬜ | | |
| V-R17 | 真人每回合能用几张卡、几个道具 | P | ⬜ | | |
| V-R18 | 企鹅挖宝与喜从天降的宝物图标和名称对照（截图，只用于核对，不入库） | P | ⬜ | | |
| V-R20 | 住旅馆 n 天实际受阻的回合数（原版写 n − 1，n = 1 时不受阻） | P + R | ⬜ | 未核实。M4 按 DEV-13 实现：住 n 天统一失去 n 个回合（n = 1 写 0x80）⚑ | |
| V-R21 | 挤兑期间 ATM 能否取款；特別融資的额度与董事长易主时是否要立即归还 | P + R | ⬜ | 未核实。M4 暂按 engine.md：挤兑期间 ATM 只能存、柜台不放款（r_stocks_time 说仍可存取，冲突）；融资额度 = 其他在场玩家存款合计 − 已融资额；董事长易主不强制归还（oama；r_squares_events 说立即归还，冲突）⚑ | |
| V-R22 | 研究所：业主停在自己的研究所改选项目时，进行中的研发是保留还是作废 | P | ⬜ | 未核实。M4 暂按：选同一项目保留进度，选不同项目作废旧项目（RESEARCH_CANCELLED）并重新计 5 天 ⚑ | |
| V-R19 | 建设公司董事长加盖 1 级还是 2 级；CONSTRUCTION_PICK 能否跳过 | P | 🟡 | 加盖级数：exe 对董事长连续调用两次加盖（g_map §4.3，A 级证据），PROGRAM `constructionChairmanLevels` 改为 2、MANUAL 为 1（PTT「附送加盖一次」），architecture §7.1 已同步。剩余（P）：CONSTRUCTION_PICK 能否跳过，M4 暂按 `canSkip=false` ⚑ | g_map §4.3；architecture §18.1 |
