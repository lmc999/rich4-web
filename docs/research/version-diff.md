# 大富翁4 v2.06 与 v3.11 差异报告

> 由 `npm run extract -- exe diff --r2` 生成，请勿手改。只写事实、计数、哈希与结论，不含原始字节与整表数据；逐项抽取结果在 `.cache/extract/tables.<edition>.json`（gitignore）。代码级对比（常量锚点、funcdiff）见 §5。

## 1. 输入指纹

| 文件 | 版本 | 字节 | sha256 | 登记 id |
| --- | --- | ---: | --- | --- |
| Game/rich4.exe | v206 | 591360 | `110b29f9d2fadcff3836eb69ec380aa264951859c90955da6e11158d2f956a13` | steam.game.exe |
| MultiverseJourney/rich4.exe | v311 | 602112 | `50cb24bbbd86353e26127e8e89e891c437984655d338a32f1458a3b79596219f` | steam.mj.exe |
| Game/MapDat.MKF | - | 36560 | `4dc6a47efe03f64484e6b9ac5ee31489b7f42fc369c0296f2f0b8d63845294b1` | - |
| Game/map.mkf | - | 40312048 | `717aaa1c1becf277064d29772500027427d39488bad64a7ee42875975c0e7106` | - |
| MultiverseJourney/map.mkf | - | 76639739 | `311f44e6ab6f97623b8bc6a8bc27425806fc21ae17791d61966bd9bef778a6b8` | - |

## 2. 容器

| 文件 | 资源数 | 压缩资源 | 末项哨兵 |
| --- | ---: | ---: | --- |
| Game/MapDat.MKF | 4 | 0 | 无 |
| Game/map.mkf | 150 | 19 | 无 |
| MultiverseJourney/map.mkf | 298 | 23 | 无 |

地图结构资源都未压缩（台湾在 MapDat.mkf[0] 与两个 map.mkf[1]），LZHUF 解码器不在地图关键路径上。

## 3. 地图

| gm | 地图 | 来源 | 规则相关差异 | 表现相关差异 | 字节相同的分组 |
| ---: | --- | --- | ---: | ---: | --- |
| 0 | 台灣 | v206-mapdat、v206-mapmkf、v311-mapmkf | 0 | 63 | [v206-mapdat, v206-mapmkf] [v311-mapmkf] |
| 1 | 大陸 | v206-mapdat、v206-mapmkf、v311-mapmkf | 1 | 78 | [v206-mapdat] [v206-mapmkf] [v311-mapmkf] |
| 2 | 日本 | v206-mapdat、v206-mapmkf、v311-mapmkf | 1 | 64 | [v206-mapdat] [v206-mapmkf] [v311-mapmkf] |
| 3 | 美國 | v206-mapdat、v206-mapmkf、v311-mapmkf | 0 | 59 | [v206-mapdat, v206-mapmkf] [v311-mapmkf] |

- gm 0 台灣：
  - 表现相关字段：nodes.decor（+0x22，39 条）、companies.spriteRes（+0x20，3 条）、landscapes.spriteRes（+0x1a，21 条）
- gm 1 大陸：
  - 表现相关字段：nodes.decor（+0x22，48 条）、companies.spriteRes（+0x20，4 条）、landscapes.spriteRes（+0x1a，26 条）
  - 规则相关：companies#4 name（+0x04）：v206-mapdat="王井府百貨" / v206-mapmkf="玉井府百貨" / v311-mapmkf="王井府百貨"
- gm 2 日本：
  - 表现相关字段：nodes.decor（+0x22，42 条）、companies.spriteRes（+0x20，6 条）、landscapes.spriteRes（+0x1a，16 条）
  - 规则相关：lands#17 rent（+0x20）：v206-mapdat=[300,750,2000,4800,10000,18000] / v206-mapmkf=[300,7500,2000,4800,10000,18000] / v311-mapmkf=[300,750,2000,4800,10000,18000]
- gm 3 美國：
  - 表现相关字段：nodes.decor（+0x22，37 条）、companies.spriteRes（+0x20，6 条）、landscapes.spriteRes（+0x1a，16 条）

结论：台湾（gm 0）三个来源的规则相关差异 0 项，表现相关差异只在贴图编号类字段（nodes.decor、companies.spriteRes、landscapes.spriteRes）。社区所说「v3.11 保留 MapDat 时 2.06 地图显示异常」推测就是这些贴图编号：v3.11 的 map.mkf 资源编号与 v2.06 不同，MapDat 里的旧编号在 v3.11 下指向错误的精灵（未实机验证）。
4 张共有地图的规则相关差异共 2 项，离群来源：v206-mapmkf 2 项。v2.06 实际读取的 MapDat.mkf 与 v3.11 的 map.mkf 在规则字段上完全一致；差异都在 v2.06 的回退文件 map.mkf（存在 MapDat 时不会被读取）。

## 4. 固定表

| 表 | 定位 v2.06 | 定位 v3.11 | 内容 sha256 相同 | 结论 |
| --- | --- | --- | :---: | --- |
| `cards` | 0x47d552（signature） | 0x47fdf2（signature） | ✅ | 一致 |
| `tools` | 0x47d642（signature） | 0x47fee2（signature） | ✅ | 一致 |
| `characters` | 0x47c62c（signature） | 0x47e80c（signature） | ✅ | 一致 |
| `stocks` | 0x47ce92（signature） | 0x47f072（signature） | — | 见下 |
| `holidays` | 0x47d6aa（signature） | 0x47ff4a（signature） | — | 见下 |
| `setupFunds` | 0x46aa40（signature） | 0x46cb94（signature） | ✅ | 一致 |
| `setupDays` | 0x46aa94（signature） | 0x46cbe8（signature） | ✅ | 一致 |
| `setupWealth` | 0x46aaac（signature） | 0x46cc00（signature） | ✅ | 一致 |
| `facilityLevels` | 0x4727ec（signature） | 0x474940（signature） | ✅ | 一致 |
| `lunar` | 0x4741c0（signature） | 0x47639c（signature） | ✅ | 一致 |

- **卡片 30×8**：一致。30 项的名称、初始张数、点券价、f6、f7 两版完全一致；原始字节只有名称指针不同；争议卡价（v2.06/v3.11）：嫁禍卡 40/40、紅卡 50/50、漲價卡 35/35、同盟卡 40/40。
- **道具 13×8**：一致。13 项内容一致；原始字节只有名称指针不同。
- **角色 12×0x68**：一致。12 项全部字段一致；原始字节只有名称指针不同。
- **股票模板 n×36**：v3.11 为超集。项数：v2.06 48（4 张图），v3.11 96（8 张图）；共有的 4 张图 48 支逐项一致（名称、流通股、f32 价格与波动位型）；v3.11 另有地图 4..7 的 48 支（v2.06 没有这些地图）。
- **节日 24×12 / 图**：v3.11 为超集。共有的 4 张图只有图片资源号不同（表现层）：picture 482→523（6 项）；picture 513→554（4 项）；v3.11 另有地图 4..7 的节日块。
- **开局三表 u32×6**：一致。默认档位下标（资金/期限/倍率）：v2.06 1/0/0，v3.11 1/0/0；默认总资金：v2.06 200000，v3.11 200000。
- **设施等级上限 u8×5**：一致。v2.06 [1,5,5,1,5]，v3.11 [1,5,5,1,5]。
- **农历表 u32/日**：一致。8401 天（公历 1998-01-01..2020-12-31），两版字节相同。

节日表布局（由 v3.11 代码 0x4521f0 / 0x4523d5 / 0x452444 反推，两版用法相同）：

| 偏移 | 类型 | 含义 |
| --- | --- | --- |
| +0 | u8 | flags0：非 0 即休市（实际只用 bit0）；bit7 = 停用，查找时跳过继续找 |
| +1 | u8 | kind：0 公历 (月,日)；1 农历 (月,日)，查 exe 内农历表；2 该月第 n 个星期 w |
| +2 / +3 | u8 | 月 / 日（kind 2 为第 n 个；超出当月天数则当年不命中） |
| +4 | u8 | kind 2 的星期（0 = 星期日） |
| +5 | u8 | 事件位：bit0 显示图片；bit2 换 BGM；bit3 每位在场玩家从牌堆得 1 张卡；bit1 代码未引用 |
| +6 / +8 | u16 | 图片资源号 / 图片参数（两版资源号不同，属表现层） |
| +10 | u16 | BGM 曲号（下一项也有曲号时音乐延续） |

- 台湾（gm 0）24 项：公历 15、农历 8、「第 n 个星期几」1；休市 17、停用 1、发卡 1、换 BGM 2、显示图片 3。
- 停用项：slot 12（10/31），与后一项同日；原版查找时跳过停用项，所以该日按后一项处理（休市）。MapDef 不输出停用项。
- 代码用法佐证（v206）：+0 被 `test 0x80` 与 `cmp 0` 使用；+5 被 `test 1/4/8` 使用（bit1 无引用）。
- 两版字段用法相同（引用次数 v2.06 [2,1,4,3,1,4,1,0,1,0,2,0]，v3.11 [2,1,4,3,1,4,1,0,1,0,2,0]）。
- 农历：农历表十二月最大日 30，以下项永不命中：0/16（12/31）、1/11（12/31）（原版瑕疵，保留原数据）。
- 农历表：8401 天（公历 1998-01-01..2020-12-31，农历 1997-12-03..2020-11-17，闰月 9 个）；超出 2020 年后原版查表越界。
- MapDef：kind 2 写 `weekday`（0 = 星期日）；`flagsRaw` = flags0 | 事件位 << 8 | 星期 << 16（兼容保留）。

## 5. 代码行为

- xrefTransfer（v3.11 → v2.06，按引用点代码模式迁移）交叉核对：cards ✅、tools ✅、characters ✅、stocks ✅、holidays ✅、setupFunds ✅、setupDays ✅、setupWealth ✅、facilityLevels ✅、lunar —。
- 新闻 / 命运 / 魔法屋表（v2.06/v3.11）：newsHandlers 0x473c48/0x475e24（v2.06 signature，xref 迁移一致）；newsCategories 0x473cd8/0x475eb4（v2.06 signature，xref 迁移一致）；fateHandlers 0x473d14/0x475ef0（v2.06 signature，xref 迁移一致）；magicEffects 0x47354c/0x475718（v2.06 signature，xref 迁移一致）；magicConditions 0x4734ec/0x4756b8（v2.06 signature，xref 迁移一致）；magicEffectJump 0x431063/0x431c7a（v2.06 signature，xref 迁移一致）；magicCondJump 0x430bfb/0x431812（v2.06 signature，xref 迁移一致）。逐条参数见 `docs/research/events-from-exe.md`。
- 常量锚点（`tools/extract/anchors/constants.json`）：155 个，v3.11 位置人工复核，v2.06 位置由指令迁移得到；两版值不同 0 个，与期望不符 0 个。
- 函数级对比：种子 162 个（新闻 36、命运 49、魔法屋效果 12 与条件 12、辅助函数、常量所在函数），两版都能配对 162 个（100%）；对齐位置上的调用扩散新增 126 对，共比较 261 个函数。

| 系统 | 函数 | 相同 | 只差常量 | 结构不同 | 最低相似度 |
| --- | ---: | ---: | ---: | ---: | ---: |
| ai | 3 | 2 | 0 | 1 | 0.793 |
| ai·callee | 4 | 3 | 0 | 1 | 0.371 |
| fate | 50 | 50 | 0 | 0 | 1 |
| fate·callee | 8 | 5 | 1 | 2 | 0.897 |
| helper | 26 | 21 | 3 | 2 | 0.845 |
| helper·callee | 35 | 28 | 3 | 4 | 0.653 |
| magic | 27 | 23 | 2 | 2 | 0.895 |
| magic·callee | 6 | 4 | 1 | 1 | 0.998 |
| minigame | 7 | 5 | 0 | 2 | 0.836 |
| minigame·callee | 8 | 8 | 0 | 0 | 1 |
| news | 37 | 26 | 5 | 6 | 0.626 |
| news·callee | 24 | 24 | 0 | 0 | 1 |
| rules | 12 | 8 | 0 | 4 | 0.823 |
| rules·callee | 14 | 12 | 1 | 1 | 0.847 |

「只差常量」与「结构不同」中的数值差异：表现层 50 条（资源号整体差 0x29、按名/按号加载 Panel.mkf 等，自动归类）；其余 21 条逐条人工复核：

- ✅ auction：`0x43c0cb mov dword [0x48c490], 0x1 → 0x43ae7a mov dword [0x48920c], 0x33`——拍卖对话框的地块图片编号（v3.11 多了资料片地图的图片分支），表现层
- ✅ auction：`0x43c0ea push 0x1a → 0x43aeb0 push 0x0`——Panel.mkf 资源加载参数（v2.06 先按文件名打开 PANEL.MKF），表现层
- ✅ auction：`0x43c23c mov word [eax*4 + 0x48c436], 0x7 → 0x43afc3 mov word [eax*4 + 0x4891ae], 0x6`——拍卖对话框竞价者状态图编号，表现层
- ✅ fateDraw：`0x44db8c push 0x42 → 0x44c4b8 push 0x0`——Panel.mkf 资源加载参数，表现层
- ✅ lottery.numbers 所在函数：`0x4315f8 push 0xc → 0x4309e8 push 0x0`——Panel.mkf 资源加载参数，表现层
- ✅ bank.interestPreview 所在函数：`0x439c15 push 0x19 → 0x438c17 push 0x0`——Panel.mkf 资源加载参数，表现层
- ✅ news.deck 所在函数：`0x44b6ea push 0x42 → 0x44a18b push 0x0`——Panel.mkf 资源加载参数，表现层
- ✅ news.deck 所在函数：`0x44b75a lea edi, [ebx + 0x1b9] → 0x44a200 lea edi, [ebx + 0x190]`——新闻图片资源号基数（0x1b9 vs 0x190，差 0x29 的资源号偏移），表现层
- ✅ ai.magic.condPick 所在函数：`0x433839 push 0x12 → 0x432bf0 push 0x0`——Panel.mkf 资源加载参数，表现层
- ✅ minigame.humanOnly 所在函数：`0x415638 push 0x4e → 0x414f68 push 0x0`——Panel.mkf 资源加载参数，表现层
- ✅ minigame.skipMod 所在函数：`0x415251 push 0x4e → 0x414b9e push 0x0`——Panel.mkf 资源加载参数，表现层
- ✅ ai.bank.lendGateMod 所在函数：`0x4366ca push 0x2 → 0x435906 push 0x17`——银行 AI 提示框参数错位（v2.06 多压一个串地址），表现层
- ✅ ai.bank.lendGateMod 所在函数：`0x43686d push 0x5dc → 0x435aa8 push 0x462b03`——银行 AI 提示框显示时长 / 串参数错位，表现层
- ✅ fateHandlers[5] → 0x44192a：`0x441953 push 0xb → 0x4405c6 push 0x0`——Panel.mkf 资源加载参数，表现层
- ✅ fateHandlers[10] → 0x40b93b：`0x40b966 add edi, 0x80 → 0x40b450 add edi, 0x57`——座驾动画资源号（差 0x29），表现层
- ✅ cardCheck → 0x444bb2：`0x444c36 mov edi, dword [eax + 0x48128a] → 0x443815 mov edi, dword [eax + 0x47e56a]`——台词表地址（v3.11 该地址恰好被当成可换算的串），表现层
- ✅ upgradeLot → 0x440aac：`0x440b2d push 0x8c → 0x43f790 push 0x82`——设施类别对话框坐标（y 0x8c vs 0x82），表现层
- ✅ upgradeLot → 0x440aac：`0x440b51 push 0x7a → 0x43f7b4 push 0x70`——设施类别对话框坐标（y 0x7a vs 0x70），表现层
- ✅ ai.bank.lendGateMod 所在函数 → 0x450441：`0x450463 push 0x0 → 0x44eb37 push 0x80`——资源加载函数本身（按号 vs 按名）的参数，表现层
- ✅ ai.bank.lendGateMod 所在函数 → 0x450441：`0x4504ce push 0x0 → 0x44ebce push 0x4`——资源加载函数本身的参数，表现层
- ✅ ai.bank.lendGateMod 所在函数 → 0x450441：`0x45051b push 0x3 → 0x44ebee push 0x0`——资源加载函数本身的参数，表现层
- 结构不同但对齐部分无数值差异 15 个（尾块复制 / 跳转布局 / v3.11 为资料片增加的分支）：newsHandlers[23]（0.933）、newsHandlers[31]（0.808）、newsHandlers[32]（0.808）、newsHandlers[33]（0.687）、newsHandlers[34]（0.626）、magicEffectJump[6]（0.983）、bomb.fuse 所在函数（0.995）、god.respawnDistX 所在函数（0.823）、fateHandlers[2] → 0x440cac（0.899）、auction → 0x454176（0.909）、auction → 0x454240（0.883）、fateDraw → 0x44bb4b（0.653）、setLoanDue → 0x4523d5（0.933）、bomb.fuse 所在函数 → 0x4379c9（0.847）、ai.magic.condPick 所在函数 → 0x431caa（0.998）。
- radare2 交叉核对（radare2 6.2.0 +0 abi:132 @ darwin-arm_64，线性反汇编 `pD` 与本项目 x86 解码器逐条比较指令起点）：v206 116902 条指令、边界不一致 0；v311 117537 条指令、边界不一致 0。

## 6. 字符串

数据节中可严格解码的 Big5 串：v2.06 3159，v3.11 3523；两版共有 2367，只在 v2.06 792，只在 v3.11 1156。
- 只在 v3.11 的示例：「1.星際總動員」「2.重回侏儸紀」「3.夢幻伊甸園」「4.打拼為將來」「5.椰林風情畫」「6.浪漫月世界」「7.熱情的夏夜」「8.漫步星空下」「恭喜您成為幫主！」「行星銀行」「銀河保險」「宇宙百貨」
- 只在 v2.06 的示例：「永久持有」「1.攜手創奇蹟」「2.歡樂好時光」「3.黃金嘉年華」「4.美夢會成真」「5.奇幻妙城市」「6.看我的厲害」「7.世界逍遙遊」「8.大富翁之夜」「利息：」

## 7. 结论

- 卡片、道具、角色、开局三表、设施等级上限、农历表：两版一致。争议的四张卡在两版 exe 中都是 嫁禍 40、紅卡 50、漲價 35、同盟 40，Fandom 的数值判为 wiki 错误，按 exe 值实现。
- 默认总资金：两版代码在新开局时都把档位下标写为 1（200000）；非新开局分支会按当前总资金反查下标、沿用上局设置，推测存档实证中的 300000 来自这一分支（未实机验证）；实机默认值仍待 V-R15 复核。
- 股票：v2.06 4 张图、v3.11 8 张图，共有部分逐项一致；台湾 12 支与调研样本全部吻合，价格都是整数分。
- 节日：共有地图的规则字段一致，只有图片资源号不同。台湾 24 项中 1 项停用；农历「十二月三十一」在 exe 农历表中永不命中。
- 规则相关的 exe 表差异：无。v3.11 相对 v2.06 只增加了地图 4..7 的股票与节日数据，不需要「v2.06 规则开关」。
- 代码行为：155 个规则常量两版全部相同；新闻 36、命运 37、魔法屋 12 × 12 的处理函数两版逐一配对，数值差异都属表现层。唯一的规则层代码差异是 v3.11 为资料片地图增加的分支（例如命运 33–36 只在原版地图组可行），对原版 4 张图没有影响。
