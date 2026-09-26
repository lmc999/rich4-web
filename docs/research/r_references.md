# 可复用的参考资源与技术选型现状（调研日期 2026-09-26）

## 0. 先说版本：几乎所有逆向数据都来自 v3.11（含资料片）
- **大富翁4 原版**：大宇资讯出品，1998 年发行（Fandom wiki 写 1998-10-05），有台湾、中国（大陆）、日本、美国 4 张地图。chiuinan 的资料说原版的最终版本号是 **v2.06**。
- **《大富翁4 超時空之旅》资料片**：Fandom 写 1999-12-30 发行，chiuinan 写“1999 年底”。新增星际之旅、恐龙世界、仙剑世界、南岛历险 4 张图，版本号为 **v3.11**。oama1111 的两个仓库都写成“v3.11, 2001”，这个年份和前两处对不上，**需要核实**。
- **Steam 版**：大富翁4 的 appid 为 2059810，发行日 2022-07-27；资料片 DLC 的 appid 为 2093880，发行日 2023-02-23。两者都由 SOFTSTAR 发行。按 chiuinan 的说法，Steam 包里同时有原版 2.06 和资料片 3.11，可以分开执行。Steam 是目前唯一**合法**拿到原版素材的途径。
- **原版渲染规格**：640×480、16 位色（DirectDraw）。remake 源码注释写的是 RGB555 取整。
- **最关键的一点**：mytbk/rich4、oama1111 的 remake 与 spec、LTCTM 修改器，全都是基于 **v3.11（超时空之旅）** 的 exe 或存档做出来的。map.mkf 里有 8 张地图，编号 `global_map_id = game_stage*4 + game_map`，stage 0 是原版 4 张，stage 1 是资料片 4 张。如果只想复刻“纯大富翁4（v2.06）”，只取 stage 0 的 4 张图即可。但 v2.06 的数值表是否和 v3.11 完全相同，**没有独立证据**，详见第 5 节的矛盾。

## 1. 大富翁4 专属的开源 / 逆向资源（按价值排序）

### 1.1 mytbk/rich4：大富翁4 逆向工程（地基）
- 仓库：https://github.com/mytbk/rich4 。作者 Iru Cai，GPL-3.0，144 stars，20 forks，最近推送 2026-09-10，仍然活跃。
- 目标 exe 为 v3.11（588 KiB，SHA256 5a90aee2…569550）。项目把反汇编逐步替换成 C 代码，可以用 MinGW + nasm 链接出能跑的 rich4_mscrt.exe（在 Wine 下运行）。注意：它的链接脚本把 rand 换成了 msvcrt 版，**随机序列和原版不同**。
- 可以直接拿来用的数据和文档：
  - `asm/rich4_card_table.c`：30 张卡的 {名称, 初始张数, 点券价格, f6, f7}。
  - `asm/rich4_tool_table.c`：13 种道具的 {名称, 数量, 点券价格, f6, f7}。
  - `asm/rich4_card_strings.c` / `rich4_tool_strings.c`：12 位角色对应每张卡、每种道具的台词（BIG5 编码，附简体注释）。
  - `docs/saveload.txt`（存档格式）、`docs/global_vars.txt`（玩家结构体 0x68 字节、全局变量）、`docs/characters.txt`（12 位角色编号）、`docs/map.txt`（地图资源定位与结构）、`docs/rich4_cfg.txt`（RICH4.CFG 格式与热键）、`docs/special_place.txt`（新闻、命运、魔法屋共 12 个功能）。
  - `csrc/mkf/mkf-format.md`：MKF 资源包格式，附 C 解压实现和 Qt 查看器。
  - `tools/map_data_parser.c` + `plot_map.py`：把地图导出成 JSON 并可视化。
  - 按系统拆分的汇编文件：每张卡（rich4_card_*.asm）、每种道具（rich4_tool_*.asm）、小游戏（rich4_small_games.asm，入口为 penguin_treasure、balloon、xicongtianjiang）、神明、魔法屋、商店、股票、银行、拍卖、乐透 UI 等。

### 1.2 oama1111/rich4-remake-public：TypeScript 网页版复刻，已做联机（最接近本项目目标）
- 仓库：https://github.com/oama1111/rich4-remake-public 。GPL-3.0-or-later，0 stars。这个公开镜像创建并推送于 2026-09-26，README 自述约 1005 个提交。它**只含代码**，原版素材（*.mkf、*.mid、rich4.exe）已从历史中剔除，运行时要自己提供 v3.11 安装目录。
- 技术栈：
  - pnpm monorepo，要求 Node ≥ 22，TypeScript 5.7，Vitest，Vite 6。
  - 桌面端用 Tauri。
  - 服务端**只用 Node 自带的 `node:http` 加 `ws@8.18.0`**，不用任何 web 框架。
  - 客户端**没有用任何渲染库**，直接用 Canvas 2D。
- 包结构：
  - `@rich4/data`：从逆向代码提取的数值表，每条都标了 @source 出处。包括卡片、道具、角色、股票、魔法屋、事件表、台词、农历（lunar）、投影表。
  - `@rich4/core`：零依赖的**确定性**引擎（纯 reducer）。子目录有 ai、cards、events、places、rules、rng、loaders（地图与存档读写）、net（协议与定序器）。
  - `@rich4/client`：渲染与输入，不含规则。
  - `@rich4/server`：hub、room、saves、ws-server、http-server、gate。
  - `@rich4/assets-pipeline`：MKF 解包、FLIC 动画、MIDI、精灵切图、超分辨率放大。
- 联机方案（docs/tasks/W-70-web-multiplayer.md 与 core/src/net/protocol.ts）：
  - 采用**确定性锁步**：服务器只负责给 action 排序并广播，不计算规则。各客户端重放同一串 action，用 stateFingerprint 校验和检测失步，失步后可以 resync / replay。
  - 协议版本已经升到 12 以上，规则一改就把版本号 +1。
  - 身份用 32 位十六进制的 clientId 令牌认回座位，而不是按名字认。
  - 房间码为 6 位，字符集 `A-HJ-NP-Z2-9`。房间内全员离线超过 10 分钟就删除，同时最多 50 个房间。
  - 每回合限时 60 秒，超时由电脑代打这一回合；连续两次超时就转为托管，并通知其他玩家。计时器只在服务器上跑，结果以广播 action 的形式落地。
  - 支持联机存档（snapshot）、大厅设置（人数、起始资金、载具、地产期限、胜利条件）、房间列表。
  - 整站用共享密码保护，cookie 为 HMAC 签名，限流为每 IP 每分钟 5 次；WebSocket 升级时同样验 cookie 和 Origin。
- 素材体量（实测）：
  - 原始大小：map.mkf 76.6MB、Data.mkf 54.2MB、Speaking.mkf 57.0MB、jump.mkf 28.9MB、Panel.mkf 25.9MB、Effect.mkf 3.9MB、help.mkf 0.4MB。
  - 合计约 247MB，gzip 后约 130MB。
  - 做法：用 Cache Storage 缓存，对局中途不走网络。
  - 性能：用无头 WebKit 自动打 41 回合，没有超过 250ms 的卡顿帧；单段 FLIC 动画最长解码 44ms。
  - 结论是手机不支持。
- 附带的文档本身就是规格书：docs/map-format.md（地图格式“已完全解明”）、player-struct.md、money-flow.md、original-ui.md、original-screens.md、gaps/01~07、audit/provenance-*.md（逐条标注 exe 地址）、deviations/*（已知偏差）。
- 自报的缺陷（docs/gaps/05）：
  - 企鹅挖宝缺少“挖到炸弹立即结束”。
  - 七彩气球少了 1 条跑道（原版 8 条）。
  - 喜从天降的炸弹起爆概率方向反了（原版 30%，remake 写成 70%）。
  - 选路只有 1 个候选时少掷一次随机数，等等。
- 注意：从文档看，开发主要由 AI 代理驱动（“首席撰写，执行方 DeepSeek 照做”），完成度需要实际运行验证。

### 1.3 oama1111/rich4-spec：逐指令逆向规格加差分测试
- 仓库：https://github.com/oama1111/rich4-spec 。Python 编写，**没有许可证**，默认保留所有权利，只能阅读参考。
- 机械层产物：
  - gen/functions.json：1388 个函数。
  - gen/xrefs.json：2259 个全局地址。
  - 69 个跳表。
  - 7146 条字符串，其中中文 6388 条。
  - gen/db.txt：全库反汇编，114312 行。
- docs/systems/ 下按系统写的规格：ai、animation、bank、cards、data-tables（共 104 张表）、dialogue-voice、economy、fortune、game-loop、gods、land-rent、magic-house、map-format、news、places、render-api、save-format、save-scalars、small-games、sound-effects、stocks、tools、ui 等。
- 验收层：用 Unicorn 仿真直接执行原版函数做差分测试，覆盖过路费、PRNG、总资产、数据表等。

### 1.4 其他大富翁4 相关仓库
- **nurockplayer/richman4-remake**：Godot 4.7.2 + GDScript，目标平台 macOS。没有许可证，素材放在私有 LFS。docs/ 下有 original-*.md 系列（神明、命运、新闻、道具、研究所、状态等）。2026-09-26 仍在推送，0 stars。
- **LTCTM/rich4_editor**：VB6 写的存档修改器，面向 3.11 超时空之旅。CardList.txt 里的卡片顺序和 mytbk 的卡片表完全一致。Player.cls 给出了存档偏移，并有 `地址列表.xlsx`。没有许可证。
- **ubnm/Richman4Editor**：纯 HTML 的网页版存档修改器，放在 ubnm.github.io，3 stars，2026-07 更新，没有许可证。
- **gnuhpc/Richman-4-HD-Mac**：Apache-2.0。用 Wine + cnc-ddraw + xBR 着色器在 macOS 上运行原版，并处理了 1185+ 张资源图，改写 Panel、Data、map 等 mkf 文件。
- **JCRJPZB/Rich4**：Cocos Creator 工程，只有 1 个提交，2021 年，基本是空壳。
- **Infinicken/Richman4L**：C# / UWP，AGPL-3.0，自述“像 **大富翁4 Fun**”，所以**不是**大富翁4 原版，2018 年后停更。
- **guotong1988/dafuweng4**：C++ 写的“角色不同天赋版”MOD（VS2013），Anti-996 许可证。
- **jackwangfeng/richman4**：TypeScript，素材由 AI 生成（ComfyUI），9 个提交，处于早期阶段。

### 1.5 规则资料站
- **Richman 中文 Fandom wiki**（richman.fandom.com/zh）。网页直接抓取会返回 402，改用 MediaWiki API（`api.php?action=parse&prop=wikitext`）可以读到内容。有“大富翁4”“大富翁4/卡片一覽”“大富翁4/道具一覽”等页面。
  - 页面给出的规则：点券不能用钱兑换，只能从点券格、小游戏、宝箱获得。
  - 医院或监狱里花 300 点可以放出四大恶人，花 30 点可以保释其他玩家。
  - 乐透每月 15 号开奖，每注 1000 元。
  - 可向银行贷款，额度等于玩家资产，期限 3 个月，无利息。
  - 小游戏共 3 种：七彩气球、喜从天降、企鹅挖宝。
- **chiuinan.github.io**（intro/ch/c43/rich4.htm）：版本说明（2.06 与 3.11）和兼容性说明。

## 2. 可以直接拿来用的数据表与格式（v3.11 exe 真值）

### 2.1 卡片表（30 张，编号从 1 开始）
列说明：“牌堆初始张数”即 init_amount；“点券价格”即 price；f7 是 AI 的“凶狠度”0..2；f6 在 exe 里没有任何读取点。

| # | 卡 | 牌堆初始张数 | 点券价格 | f7 |
|---|---|---|---|---|
|1|均富卡|1|200|2|
|2|均贫卡|2|200|2|
|3|购地卡|4|35|1|
|4|换地卡|4|25|0|
|5|换屋卡|4|20|0|
|6|转向卡|3|20|0|
|7|改建卡|8|15|0|
|8|拍卖卡|3|20|1|
|9|天使卡|2|160|0|
|10|恶魔卡|1|180|2|
|11|怪兽卡|2|60|2|
|12|拆除卡|5|15|1|
|13|抢夺卡|4|25|2|
|14|停留卡|4|20|0|
|15|冬眠卡|2|100|2|
|16|梦游卡|4|25|1|
|17|陷害卡|4|20|2|
|18|复仇卡|4|20|0|
|19|嫁祸卡|4|**40**|0|
|20|免费卡|4|25|0|
|21|免罪卡|4|25|0|
|22|送神符|3|10|0|
|23|请神符|3|20|0|
|24|红卡|3|**50**|0|
|25|黑卡|3|30|1|
|26|查税卡|4|35|1|
|27|涨价卡|3|**35**|0|
|28|查封卡|3|35|1|
|29|同盟卡|2|**40**|0|
|30|乌龟卡|3|70|0|

- 牌堆初始张数合计 100 张。
- 交叉核对：mytbk 的汇编表和 oama 的 data/cards.ts 完全一致（后者就是从前者提取的，**不算独立来源**）。
- 另拿 Fandom“卡片一覽”作为独立来源比对：26 张价格一致，**4 张不一致**（加粗项）：
  - 嫁祸卡：exe 40，wiki 30
  - 红卡：exe 50，wiki 30
  - 涨价卡：exe 35，wiki 30
  - 同盟卡：exe 40，wiki 70

### 2.2 道具表（13 种）
| # | 道具 | 数量字段 | 点券价格 | 获取 |
|---|---|---|---|---|
|1|机器娃娃|10|15|商店|
|2|路障|10|30|商店|
|3|地雷|10|25|商店|
|4|定时炸弹|10|25|商店|
|5|机车|10|80|商店|
|6|汽车|10|150|商店|
|7|飞弹|10|100|商店|
|8|遥控骰子|10|30|商店|
|9|机器工人|0|30|研究所 1 级|
|10|时光机|0|40|研究所 2 级|
|11|传送机|0|95|研究所 3 级|
|12|工程车|0|150|研究所 4 级|
|13|核子飞弹|0|250|研究所 5 级|

- 可买的 8 种价格，与 Fandom“道具一覽”**全部一致**（两个独立来源）。wiki 把第 9~13 种标为“非卖品”。
- 研究所的研发顺序，Fandom 与 oama 的逆向注释一致（研发完成后发放的道具编号 = 研究所等级 + 8）。
- oama 的逆向注释认为：第 1~8 种的“10”是**全局库存**，发一个扣一个；第 9~13 种不受库存限制。

### 2.3 存档格式（save0.dat 为自动存档，save1.dat 起为手动存档）
文件头：
- 0x00：4 字节标识
- 0x04：4 字节日期
- 0x0C：4 字节玩家数（含已破产）
- 0x10 起：4 × 0x68 字节玩家结构
- 0x654 起：4 × 15 字节，每名玩家的卡片槽（每槽存卡片编号，0 表示空）
- 0x690 起：4 × 15 字节，每名玩家每种道具的数量（uint8）

玩家结构体内的偏移：

| 偏移 | 字段 |
|---|---|
| +0x11 | 交通工具（0 步行 / 1 机车 / 2 汽车） |
| +0x12 | 骰子数 |
| +0x13 | 角色 |
| +0x15 | 操作者（0 出局 / 1 真人 / 2 电脑，出自 LTCTM） |
| +0x1C | 现金 |
| +0x20 | 存款（含特别融资） |
| +0x24 | 贷款 |
| +0x28 | 特别融资 |
| +0x30 | 点券（uint16） |
| +0x32 起 | 住旅馆 / 消失 / 监狱 / 医院 / 冬眠 / 梦游 / 停留 / 龟行的天数（低 7 位） |
| +0x3D | 同盟剩余天数（出自 LTCTM） |
| +0x3E | 保险天数 |
| +0x3F | 神明信息 |
| +0x41 | 同盟对象（出自 LTCTM） |

- mytbk 给的是内存地址（0x496b68 起），LTCTM 给的是 VB 的 1 基文件偏移（例如现金在 45+104i）。换算后两者**完全吻合**，所以是两个独立来源。

### 2.4 角色编号
| 编号 | 角色 |
|---|---|
| 00 | 约翰乔 |
| 01 | 沙隆巴斯 |
| 02 | 忍太郎 |
| 03 | 钱夫人 |
| 04 | 阿土伯 |
| 05 | 莎拉公主 |
| 06 | 宫本宝藏 |
| 07 | 糖糖 |
| 08 | 乌咪 |
| 09 | 孙小美 |
| 0A | 小丹尼 |
| 0B | 金贝贝 |

### 2.5 MKF 资源包格式
- 文件头 4 字节是索引表偏移，索引表放在文件末尾。
- 每个资源前有 16 字节头：未压缩大小、压缩大小、图像偏移、图像大小。两个大小相等表示未压缩。压缩算法是私有的，mytbk 已给出 C 版解压，oama 有 TS 版。
- SPR / SMP 子格式：12 字节头（签名、块数、起始偏移），后接每块 12 字节描述（宽、高、x、y、gsize）。SPR 的首块图像数据在 start_offset + 512 处（前面 512 字节是调色板）。

### 2.6 地图格式（map.mkf）
- 资源分布：结构数据在资源 `id*2+1`，地面图块集 GND 在 `id*2`（含 512 字节调色板），缩略图在 `16+id`。
- 地图数据头：10 个 uint32，依次是节点、住宅地、设施地、上市企业、特殊景观的数量和偏移。
- 节点 40 字节：
  - x, y：int16 世界坐标
  - 名称：20 字节 BIG5 字符串
  - adjacent[4]：uint16 相邻节点
  - type：uint16
  - decorIndex：uint16
  - flags：uint32
- 各类地块记录大小：住宅地 0x34、设施 0x38、上市企业 0x34、景观 0x1C。所有表的索引都从 1 开始。
- 8 张图共 987 个节点，其中 921 个有名称（出自 oama 统计）。

### 2.7 其他格式与常量
- **RICH4.CFG**：
  - 偏移 0 游戏速度（0~2）、1 动画开关、2 音乐（0~4）、3 音效（0~4）、4 自动存档、5 视图（日历 / 小地图 / 组合）。
  - 偏移 8~11 日期。
  - 0x10~0x4F 为热键，其中有“地图向左旋转 / 向右旋转”。
- **落点事件**：分派跳表共 17 项。类型 6、7、8 分别是企鹅挖宝、七彩气球、喜从天降。三个小游戏**只加点券**（写入玩家 +0x30），没有负值。
- **PRNG**：Open Watcom 的 rand。
  - 公式：`next = next*0x41C64E6D + 0x3039; return (next>>16) & 0x7FFF`，初始种子为 1。
  - 注意：mytbk 构建出来的 exe 换成了 msvcrt 的 rand，两者**序列不同**。

## 3. 渲染：原版不是标准等角 tilemap
- oama 从 exe（VA 0x00408480）得出的结论：地面由 32×32 像素的图块按排布表（宽 72 块）铺设。每块取**投影表**里相邻四个表项作为四角，贴成四边形，所以是透视或近似透视投影，不是菱形等角网格。
- 视角可以旋转 8 个方向（每步 45°），建筑和景物的图号也随视角变化。Fandom 称之为“2.5D 全地图视角”。
- 因此 Phaser、Excalibur 自带的 isometric tilemap（Tiled 格式）**不能直接对上**原版数据。
- oama 的做法：Canvas 2D 按三个角做仿射近似。和原版表值相比，最大误差 2 像素（8 个视角、全部 28×28 格中的最坏值）。
- 更精确的做法：用 WebGL 纹理四边形，例如 PixiJS v8 的 `PerspectiveMesh` 或 `MeshPlane`；或者 Three.js 用正交相机加平面网格。
- 不用原版素材、自绘 2.5D 美术时，再考虑 Phaser 4、Excalibur 的 isometric tilemap 或 PixiJS 的自定义深度排序。

## 4. 联机框架现状（2026-09）

| 框架 | 最新版本 / 时间 | 维护 | 房间 | 断线重连 | 状态同步 | 评价 |
|---|---|---|---|---|---|---|
| Colyseus | colyseus 0.18.8（2026-09-23）；@colyseus/core 0.18.17（2026-09-25）；@colyseus/schema 5.0.34 | 活跃（MIT，7.3k★，作者自述个人维护） | 内置房间、matchmaking、LobbyRoom、QueueRoom | 0.17（2026-02-06）加入客户端自动重连；服务端 onDrop / onReconnect / allowReconnection(client, 秒数 或 "manual")；刷新页面可用 reconnect(token) | 服务器权威，Schema 增量同步；0.18（2026-08-20）新增 Schema 5.0、request / response 消息、@colyseus/database | 最省事的“权威服务器 + 房间 + 重连”方案；0.18 有破坏性变更（移除 client.id、Schema 上限 63 字段） |
| boardgame.io | npm 上最后一版是 0.50.2（2022-11-10） | **事实停更**：仓库 2026 年只有依赖升级和 lint 类提交；社区 issue #1150（2023）询问项目状态 | 有 Lobby API | 靠 Socket.IO 传输加 credentials | 服务器权威，客户端乐观更新，支持 playerView 隐藏信息 | 回合、阶段抽象很适合桌游，但不建议新项目依赖 |
| Socket.IO | 4.8.4（2026-09-25） | 活跃（MIT，63k★） | rooms、namespaces | 4.6.0（2023-02-07）起有 connectionStateRecovery（默认 maxDisconnectionDuration 2 分钟，恢复 id、rooms、data 和漏发的包）；Redis pub/sub 适配器不支持此功能；官方提醒恢复不保证成功 | 需要自己实现 | 灵活成熟，规则、定序、计时都要自己写 |
| ws | 8.21.3（2026-08） | 活跃（MIT） | 无 | 无 | 无 | oama remake 所用；最轻量，一切自建 |
| PartyKit → cloudflare/partykit（partyserver 0.5.10，2026-08；partysocket 1.3.0，2026-06） | 原 partykit CLI 最后一版 0.0.115（2025-05），README 注明开发已迁到 cloudflare/partykit；PartyKit 于 2024-04-05 宣布并入 Cloudflare | 活跃（ISC/MIT） | 一个房间对应一个 Durable Object | partysocket 自带重连和缓冲；DO 支持 hibernation | 自己实现 | 适合部署在 Cloudflare 上的无服务器房间；会绑定到 Cloudflare 平台 |
| Nakama | v3.41.0（2026-09-18） | 活跃（Apache-2.0，13k★） | 内置 match 和匹配 | 有 | 权威 match handler（Go / Lua / TS） | 功能全但偏重，需要数据库；4 人桌游有些大材小用 |

**两种架构路线**：
1. **确定性锁步**，oama 已验证可行。
   - 做法：服务器只给 action 定序；共享一个纯 TS reducer；用 Watcom PRNG 保证位级一致；每步用校验和检测失步。
   - 优点：服务器极轻，存档就是 action 日志，可以原样重放。
   - 缺点：任何非确定性（浮点运算、随机数消耗次序、对象遍历顺序）都会导致失步。协议版本需要严格管理（oama 已升到 12 以上）。
   - 隐藏信息问题：所有客户端都持有全量状态，无法隐藏手牌。原版手牌本来就可以查询，所以影响不大。
2. **服务器权威**，推荐 Colyseus 0.18，或 Socket.IO 加自写 reducer。
   - 做法：规则只在服务器上运行，客户端只负责渲染。
   - 优点：重连后直接拿全量状态，防作弊更容易。
   - 缺点：服务器必须运行完整规则。

## 5. 渲染库现状

| 库 | 最新版本 / 时间 | 许可证 | 要点 |
|---|---|---|---|
| PixiJS | v8.21.0（2026-09-17），活跃 | MIT，48k★ | WebGL2 / WebGPU；有 PerspectiveMesh；没有内置等角 tilemap；@pixi/tilemap 5.0.2（2025-07）；pixi-viewport 6.0.3（2024-11，更新较慢） |
| Phaser | 4.0.0 于 2026-04-10 发布（据 Wikipedia），当前 4.2.1（2026-07-09） | MIT，40k★ | 自 3.50 起 Tilemaps.Orientation 支持 ISOMETRIC、STAGGERED、HEXAGONAL，Phaser 4 文档中仍在；内置场景、输入、音频、Tiled 解析 |
| Excalibur | 0.32.0（2025-12-23） | BSD-2 | 内置 IsometricMap 类；有 Tiled 插件 |
| Three.js | 0.186.1（2026-09-24） | MIT | 正交相机做 2.5D；zawsstt/monopoly-rich-life 用它加 PeerJS |
| Canvas 2D 自绘 | — | — | oama 选用：原版 640×480 精灵直接 drawImage，投影用仿射近似，零依赖 |

## 6. 通用网页大富翁联机项目（架构参考，均非大富翁4）
- **MXYZYP/richman**：Vue3、TS、Vite、Node、Socket.IO。支持 6 位房间码、2~6 人、观战席 3 个（断线保留 5 分钟）、刷新后恢复身份、单机复盘重演。版本 v2.16.0，没有许可证。
- **sasanqux/Monoply-**：Vue3、Node、Socket.IO。有房间、断线重连、AI 托管、回合计时、交易。
- **zawsstt/monopoly-rich-life**：Three.js 3D，联机走 PeerJS（WebRTC）且由房主权威。
- **clever830king/rich-game**：JS 联机版。
- **HumanSean/javascript-monopoly**：65★，没有许可证。
- **intrepidcoder/monopoly**：452★，MIT，2~8 人。

## 7. 许可证与合规要点
- mytbk 和 oama 的代码都是 GPL-3.0。直接复用代码的话，整个网页游戏也必须以 GPL-3.0 开源。
- 数值本身属于事实性数据，可以自己重新录入，但保留出处更稳妥。
- rich4-spec、nurockplayer、LTCTM、MXYZYP 都没有许可证，只能阅读参考。
- 原版素材（mkf、midi、avi）的版权属于大宇 / 软星。不能公开分发，可以仿照 oama 让玩家自己提供素材；或者改用原创美术。

## entries
- **mytbk/rich4（大富翁4逆向，v3.11）** [逆向工程/数据表] (high) GPL-3.0 的逆向工程，把 v3.11 exe 还原成可以链接运行的汇编加 C。提供卡片表、道具表、台词表、存档格式、玩家结构体、RICH4.CFG、MKF 格式与解压代码、地图解析工具；每张卡、每种道具、小游戏、神明、魔法屋、商店、股票、银行、拍卖都有独立的汇编文件。是所有后续复刻项目的数据来源。 | 数值: 144 stars，20 forks，最近推送 2026-09-10；rich4.exe v3.11，588KiB；卡片 30 张，牌堆初始合计 100 张；道具 13 种（前 8 种各 10，后 5 种为 0）；玩家结构 0x68 字节；8 张地图 | src: https://github.com/mytbk/rich4, https://raw.githubusercontent.com/mytbk/rich4/master/asm/rich4_card_table.c, https://raw.githubusercontent.com/mytbk/rich4/master/asm/rich4_tool_table.c
- **oama1111/rich4-remake-public（TypeScript 网页版复刻，已做联机）** [网页复刻/联机参考实现] (high) 大富翁4（v3.11）的 TS 复刻，GPL-3.0-or-later。结构为确定性纯 reducer 引擎（core）、带出处标注的数值表（data）、Canvas 2D 客户端、Node 服务端（node:http + ws）和 Tauri 桌面端。联机采用锁步：服务器只定序 action，状态指纹做校验，clientId 认回座位。有 6 位房间码、60 秒回合计时加 AI 代打与托管、联机存档。只含代码，需玩家自备原版素材。 | 数值: 素材原始约 247MB，gzip 后约 130MB（map 76.6、Data 54.2、Speaking 57.0、jump 28.9、Panel 25.9、Effect 3.9、help 0.4 MB）；房间内无人超过 10 分钟即删除；房间上限 50；ws 8.18.0；Node ≥ 22；协议版本 ≥ 12；公开镜像创建于 2026-09-26，0 stars | src: https://github.com/oama1111/rich4-remake-public, https://raw.githubusercontent.com/oama1111/rich4-remake-public/main/docs/tasks/W-70-web-multiplayer.md, https://raw.githubusercontent.com/oama1111/rich4-remake-public/main/packages/core/src/net/protocol.ts
- **oama1111/rich4-spec（逆向规格与差分测试）** [逆向规格] (high) 对 v3.11 exe 做的三层规格。机械层：函数、调用图、xref、跳表、字符串。语义层：docs/systems/ 下 20 多个系统文档，覆盖卡片、道具、神明、魔法屋、小游戏、股票、银行、存档、UI、音效等。验收层：用 Unicorn 仿真原版函数做差分测试。可作为规则细节的查询索引。 | 数值: 1388 个函数；2259 个全局地址；69 个跳表；7146 条字符串（中文 6388）；反汇编 114312 行；104 张数据表；创建于 2026-09-19 | src: https://github.com/oama1111/rich4-spec, https://raw.githubusercontent.com/oama1111/rich4-spec/main/README.md, https://raw.githubusercontent.com/oama1111/rich4-spec/main/docs/systems/small-games.md
- **nurockplayer/richman4-remake（Godot 复刻）** [其他语言复刻] (medium) Godot 4.7.2 + GDScript 的高保真复刻，目标平台 macOS，素材放在私有 Git LFS。docs/ 下有一批 original-*.md 规则整理（神明、命运、新闻、道具、研究所、状态、导弹、工程车等）。没有许可证，只能参考。 | 数值: 创建于 2026-09-08，2026-09-26 仍在推送；约 211 个提交，42 个 open issue；0 stars | src: https://github.com/nurockplayer/richman4-remake
- **LTCTM/rich4_editor（VB6 存档修改器）** [存档修改器/数据表] (high) 面向大富翁4 超时空之旅的存档修改器。Player.cls 给出现金、存款、贷款、点券、卡片、道具，以及消失、监狱、医院、冬眠、梦游、停留、龟行、同盟天数与对象、操作者的存档偏移。CardList.txt 有 30 张卡的编号顺序，另附 地址列表.xlsx。 | 数值: 现金偏移 45+104i（VB 1 基），相当于 0x10+0x1C；卡片 1621+15i，相当于 0x654；道具 1681+15i，相当于 0x690；操作者 0 死亡 / 1 人类 / 2 电脑；3 stars；最近推送 2020-09 | src: https://github.com/LTCTM/rich4_editor, https://raw.githubusercontent.com/LTCTM/rich4_editor/master/Player.cls, https://raw.githubusercontent.com/LTCTM/rich4_editor/master/CardList.txt
- **ubnm/Richman4Editor（网页版存档修改器）** [存档修改器] (medium) 纯 HTML/JS 的大富翁4存档修改器，下载后打开 index.html 即可离线使用，也可在线访问 ubnm.github.io/Richman4Editor。可作为在浏览器里解析 .dat 存档的参考。 | 数值: 3 stars；8 个提交；2026-07 更新；没有许可证 | src: https://github.com/ubnm/Richman4Editor
- **gnuhpc/Richman-4-HD-Mac（Wine 封装与高清化）** [素材处理参考] (medium) 在 macOS 上用 Wine、cnc-ddraw 和 xBR 着色器运行原版，并处理了 1185+ 张资源图，修改 Panel、Data、map 等 mkf 文件。可参考它的素材高清化流程。 | 数值: Apache-2.0；2026-07 更新 | src: https://github.com/gnuhpc/Richman-4-HD-Mac
- **Richman 中文 Fandom wiki（大富翁4 / 卡片一覽 / 道具一覽）** [规则资料站/独立交叉核对来源] (medium) 社区整理的大富翁4规则、卡片与道具功能和价格、特殊地点、研究所研发顺序、发行日期。网页直接抓取会返回 402，改用 MediaWiki API 可以读取 wikitext。拿它和 exe 表比对：可买道具的 8 个价格全部一致；卡片 30 张里 26 张一致，4 张不一致。 | 数值: 原版发行 1998-10-05；资料片 1999-12-30；Steam 2022-07-28，DLC 2023-02-24（wiki 写法，比 Steam 商店 API 的日期晚一天）。卡价与 exe 不同的 4 张：嫁祸 30（exe 40）、红卡 30（exe 50）、涨价 30（exe 35）、同盟 70（exe 40）。乐透每注 1000 元，每月 15 号开奖；保释四大恶人 300 点，保释他人 30 点；银行贷款额度等于资产，3 个月内无息 | src: https://richman.fandom.com/zh/wiki/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://richman.fandom.com/zh/api.php?action=parse&page=%E5%A4%A7%E5%AF%8C%E7%BF%814/%E5%8D%A1%E7%89%87%E4%B8%80%E8%A6%BD&prop=wikitext&format=json, https://richman.fandom.com/zh/api.php?action=parse&page=%E5%A4%A7%E5%AF%8C%E7%BF%814/%E9%81%93%E5%85%B7%E4%B8%80%E8%A6%BD&prop=wikitext&format=json
- **chiuinan 大富翁4 介绍页** [版本资料] (medium) 说明原版最终版本是 2.06，1999 年底的“超时空之旅”资料片是 3.11；Steam 版同时含 2.06 和 3.11，可分开执行。还写明原版需要 640×480、16 色深的 DirectDraw 模式，以及各种兼容性处理。 | 数值: 原版 v2.06；资料片 v3.11；分辨率 640×480 | src: https://chiuinan.github.io/game/game/intro/ch/c43/rich4.htm
- **Steam 大富翁4（2059810）与 超時空之旅 DLC（2093880）** [合法素材来源] (high) SOFTSTAR 官方重新发行，是目前合法获取原版素材（mkf、midi）用于本地运行的途径。Steam 分类标注支持单人和多人（同屏）。 | 数值: 大富翁4 发行于 2022-07-27；DLC 发行于 2023-02-23 | src: https://store.steampowered.com/api/appdetails?appids=2059810&l=tchinese, https://store.steampowered.com/api/appdetails?appids=2093880&l=tchinese
- **JCRJPZB/Rich4 / Infinicken/Richman4L / guotong1988/dafuweng4 / jackwangfeng/richman4** [低价值相关仓库] (medium) JCRJPZB/Rich4：Cocos Creator 空壳，只有 1 个提交。Richman4L：C# UWP 项目，AGPL-3.0，自述像大富翁4 Fun，属于其他版本。dafuweng4：C++ 写的角色天赋 MOD。jackwangfeng/richman4：TS 项目，素材由 AI 生成，处于早期。这几个都不能提供可靠的原版数据。 | 数值: JCRJPZB：2 stars，2021-08；Richman4L：9 stars，2018-04；dafuweng4：1 star；jackwangfeng：9 个提交 | src: https://github.com/JCRJPZB/Rich4, https://github.com/Infinicken/Richman4L, https://github.com/guotong1988/dafuweng4
- **MXYZYP/richman 等通用网页大富翁联机项目** [联机架构参考（非大富翁4）] (medium) MXYZYP/richman 用 Vue3、TS、Vite、Node、Socket.IO：6 位房间码，2~6 人，观战席，刷新后恢复身份，房主托管离线玩家，单机复盘重演。sasanqux/Monoply- 用 Vue3 + Socket.IO，有断线重连、AI 托管、回合计时。zawsstt/monopoly-rich-life 用 Three.js + PeerJS（WebRTC，房主权威）。intrepidcoder/monopoly 为 MIT 许可、支持 2~8 人。 | 数值: MXYZYP：v2.16.0，11 张地图，观战断线保留 5 分钟，没有许可证；intrepidcoder：452 stars，MIT；HumanSean/javascript-monopoly：65 stars，没有许可证 | src: https://github.com/MXYZYP/richman, https://github.com/sasanqux/Monoply-, https://github.com/zawsstt/monopoly-rich-life
- **Colyseus** [联机框架] (high) Node.js 的权威服务器框架（MIT）。内置房间、matchmaking、LobbyRoom、QueueRoom，用 Schema 做增量状态同步。0.17 加入客户端自动重连和服务端 onDrop、onReconnect、allowReconnection；0.18 新增 Schema 5.0、request/response 消息、@colyseus/database、@colyseus/admin、预测与延迟补偿。2026-04 官方发布了回合制卡牌 demo。 | 数值: colyseus 0.18.8（2026-09-23）；@colyseus/core 0.18.17（2026-09-25）；@colyseus/schema 5.0.34；0.17 发布于 2026-02-06；0.18 发布于 2026-08-20；7.3k stars；0.18 破坏性变更：Schema 上限 63 字段、移除 client.id | src: https://github.com/colyseus/colyseus, https://colyseus.io/blog/, https://colyseus.io/blog/colyseus-018-is-here/
- **boardgame.io** [联机框架（事实停更）] (high) 回合制桌游引擎，MIT。用 moves、turn、phase、stage 描述规则，框架自动生成多人对局（Local 或 SocketIO 传输，服务器权威加客户端乐观更新，playerView 隐藏信息，Lobby API）。但 npm 自 2022 年后就没有新版本，2026 年的提交只有依赖升级和 lint 迁移，不建议新项目采用。 | 数值: 最新 0.50.2（2022-11-10）；12.4k stars；67 个 open issue；项目状态 issue #1150（2023-05-09） | src: https://github.com/boardgameio/boardgame.io, https://registry.npmjs.org/boardgame.io, https://github.com/boardgameio/boardgame.io/issues/1150
- **Socket.IO** [联机传输库] (high) 成熟的双向实时通信库，MIT。有 rooms 和 namespaces；4.6.0 起提供 connectionStateRecovery，可恢复 id、rooms、data 和漏发的包。Redis pub/sub 适配器不支持该功能，官方也提醒恢复不一定成功，仍需做全量状态重同步。规则、定序、计时都要自己写。 | 数值: 最新 4.8.4（2026-09-25）；connectionStateRecovery 于 4.6.0（2023-02-07）引入，默认 maxDisconnectionDuration 为 2 分钟；63k stars | src: https://github.com/socketio/socket.io, https://socket.io/docs/v4/connection-state-recovery, https://raw.githubusercontent.com/socketio/socket.io/main/packages/socket.io/CHANGELOG.md
- **ws（websockets/ws）** [联机传输库] (high) Node 上最轻量的 WebSocket 实现，MIT。oama remake 的服务端只用它加 node:http。没有房间或重连机制，需要自己实现。 | 数值: 最新 8.21.3（2026-08）；oama 固定使用 8.18.0；22.8k stars | src: https://github.com/websockets/ws, https://registry.npmjs.org/ws
- **PartyKit → cloudflare/partykit（partyserver / partysocket）** [联机框架（无服务器）] (high) PartyKit 于 2024-04-05 宣布并入 Cloudflare，原仓库 README 注明开发已迁到 cloudflare/partykit。partyserver 在 Durable Object 上提供按房间路由、生命周期钩子和广播，支持 hibernation；partysocket 自带重连和缓冲。适合部署在 Cloudflare 上，会与该平台绑定。 | 数值: partykit CLI 最后一版 0.0.115（2025-05-21）；partyserver 0.5.10（2026-08-03）；partysocket 1.3.0（2026-06-23）；cloudflare/partykit 1.3k stars，ISC | src: https://github.com/partykit/partykit, https://github.com/cloudflare/partykit, https://blog.partykit.io/posts/partykit-is-joining-cloudflare/
- **Nakama** [联机框架（全功能游戏服务器）] (high) Heroic Labs 出品的开源游戏服务器，Apache-2.0。有权威 match handler（Go、Lua、TS 运行时）、匹配、账号、存储，需要 Postgres 或 CockroachDB。功能全面但部署偏重。 | 数值: v3.41.0（2026-09-18）；13.4k stars | src: https://github.com/heroiclabs/nakama
- **PixiJS v8** [2D 渲染] (high) WebGL2 / WebGPU 的 2D 渲染库，MIT。有 PerspectiveMesh，可以把原版“投影表四角”的地面图块做成纹理四边形，比 Canvas 2D 的仿射近似更精确。没有内置等角 tilemap。 | 数值: v8.21.0（2026-09-17）；48k stars；@pixi/tilemap 5.0.2（2025-07）；pixi-viewport 6.0.3（2024-11） | src: https://github.com/pixijs/pixijs, https://pixijs.download/release/docs/scene.PerspectiveMesh.html, https://registry.npmjs.org/pixi.js
- **Phaser 4** [2D 游戏引擎] (medium) 完整的 2D 引擎，MIT。v4 重写了渲染器，API 与 v3 基本一致。自 3.50 起支持 Tiled 的 ISOMETRIC、STAGGERED、HEXAGONAL 地图方向，v4 文档中仍在。但原版大富翁4是投影地面加 8 个视角，并非标准等角 tilemap，自绘新美术时才用得上。 | 数值: 4.0.0 于 2026-04-10 发布（Wikipedia）；4.1.0（2026-04-30）；4.2.1（2026-07-09）；40k stars | src: https://github.com/phaserjs/phaser, https://docs.phaser.io/api-documentation/namespace/tilemaps-orientation, https://en.wikipedia.org/wiki/Phaser_(game_framework)
- **Excalibur / Three.js / Canvas 2D 自绘** [渲染备选] (high) Excalibur 内置 IsometricMap 类，BSD-2。Three.js 可用正交相机做 2.5D，zawsstt 的项目用它。Canvas 2D 自绘是 oama 的选择：原版 640×480 精灵直接 drawImage，投影用三角仿射近似，与原版表值最大相差 2 像素，零依赖。 | 数值: excalibur 0.32.0（2025-12-23）；three 0.186.1（2026-09-24） | src: https://excaliburjs.com/docs/isometric, https://registry.npmjs.org/excalibur, https://registry.npmjs.org/three

## open_questions
- 原版大富翁4 v2.06（不含资料片）的卡片和道具数值表是否与 v3.11 exe 完全相同？所有逆向数据都来自 v3.11，Fandom 与 exe 有 4 张卡价格不一致：嫁祸卡 30 对 40、红卡 30 对 50、涨价卡 30 对 35、同盟卡 70 对 40。需要对 v2.06 的 rich4.exe 做同样的表提取（卡表约在 0x47fdf2，道具表约在 0x47fee2）才能确定。
- 卡片和道具在商店卖回时的折算比例：rich4_shop.asm 里用 fmul 乘了常量 0x464364 / 0x46436c，这次没有读出具体数值。
- 卡表和道具表中 f6 字段的原意：oama 称它在 exe 里没有任何读取点，但 f6=2 恰好是 5 张价格 ≥100 的卡。
- 资料片发行年份不一致：Fandom 写 1999-12-30，chiuinan 写 1999 年底，oama 的两个仓库写 2001。
- oama1111/rich4-remake-public 实际能否完整对局、联机是否稳定：公开镜像今天（2026-09-26）才创建，开发主要由 AI 代理完成，gaps 文档自报 3 个小游戏都有规则缺陷，没有实际运行验证。
- rich4-spec 的小游戏闸门说“玩家 +0x15 == 1 表示电脑”，而 LTCTM 修改器显示 1 = 人类、2 = 电脑，两者矛盾。这决定了小游戏是否只给真人玩（或只给电脑自动结算），需要核实。
- Colyseus 0.18 是否支持按客户端过滤可见状态（StateView），以及 Hathora、Rune、Playroom 等其他托管方案的现状：这次搜索额度用尽，没有核实。
- rich4-spec、nurockplayer/richman4-remake、LTCTM/rich4_editor、MXYZYP/richman 都没有许可证，能否引用或复用它们的内容需要联系作者。
- 原版 8 个视角旋转时，建筑和景物精灵的图号映射细节（remake 的 render.ts 有说明，但没有逐项核对）；以及 2.06 原版是否同样有 8 个视角。

## sources
- https://github.com/mytbk/rich4
- https://raw.githubusercontent.com/mytbk/rich4/master/readme.rst
- https://raw.githubusercontent.com/mytbk/rich4/master/asm/rich4_card_table.c
- https://raw.githubusercontent.com/mytbk/rich4/master/asm/rich4_tool_table.c
- https://raw.githubusercontent.com/mytbk/rich4/master/docs/global_vars.txt
- https://raw.githubusercontent.com/mytbk/rich4/master/docs/saveload.txt
- https://raw.githubusercontent.com/mytbk/rich4/master/docs/map.txt
- https://raw.githubusercontent.com/mytbk/rich4/master/docs/characters.txt
- https://raw.githubusercontent.com/mytbk/rich4/master/docs/rich4_cfg.txt
- https://raw.githubusercontent.com/mytbk/rich4/master/docs/special_place.txt
- https://raw.githubusercontent.com/mytbk/rich4/master/csrc/mkf/mkf-format.md
- https://github.com/oama1111/rich4-remake-public
- https://raw.githubusercontent.com/oama1111/rich4-remake-public/main/README.md
- https://raw.githubusercontent.com/oama1111/rich4-remake-public/main/docs/tasks/W-70-web-multiplayer.md
- https://raw.githubusercontent.com/oama1111/rich4-remake-public/main/packages/core/src/net/protocol.ts
- https://raw.githubusercontent.com/oama1111/rich4-remake-public/main/packages/data/src/cards.ts
- https://raw.githubusercontent.com/oama1111/rich4-remake-public/main/packages/data/src/tools.ts
- https://raw.githubusercontent.com/oama1111/rich4-remake-public/main/docs/map-format.md
- https://raw.githubusercontent.com/oama1111/rich4-remake-public/main/docs/gaps/05-loop-minigames-ai.md
- https://raw.githubusercontent.com/oama1111/rich4-remake-public/main/packages/client/src/render.ts
- https://github.com/oama1111/rich4-spec
- https://raw.githubusercontent.com/oama1111/rich4-spec/main/docs/systems/small-games.md
- https://raw.githubusercontent.com/oama1111/rich4-spec/main/docs/systems/data-tables.md
- https://github.com/nurockplayer/richman4-remake
- https://github.com/LTCTM/rich4_editor
- https://raw.githubusercontent.com/LTCTM/rich4_editor/master/Player.cls
- https://github.com/ubnm/Richman4Editor
- https://github.com/gnuhpc/Richman-4-HD-Mac
- https://github.com/JCRJPZB/Rich4
- https://github.com/Infinicken/Richman4L
- https://github.com/guotong1988/dafuweng4
- https://github.com/jackwangfeng/richman4
- https://richman.fandom.com/zh/wiki/%E5%A4%A7%E5%AF%8C%E7%BF%814
- https://chiuinan.github.io/game/game/intro/ch/c43/rich4.htm
- https://store.steampowered.com/api/appdetails?appids=2059810&l=tchinese
- https://store.steampowered.com/api/appdetails?appids=2093880&l=tchinese
- https://github.com/MXYZYP/richman
- https://github.com/sasanqux/Monoply-
- https://github.com/zawsstt/monopoly-rich-life
- https://github.com/intrepidcoder/monopoly
- https://github.com/HumanSean/javascript-monopoly
- https://github.com/colyseus/colyseus
- https://colyseus.io/blog/
- https://colyseus.io/blog/colyseus-018-is-here/
- https://colyseus.io/blog/colyseus-017-is-here/
- https://docs.colyseus.io/room/reconnection
- https://github.com/boardgameio/boardgame.io
- https://github.com/boardgameio/boardgame.io/issues/1150
- https://github.com/socketio/socket.io
- https://socket.io/docs/v4/connection-state-recovery
- https://github.com/websockets/ws
- https://github.com/partykit/partykit
- https://github.com/cloudflare/partykit
- https://blog.partykit.io/posts/partykit-is-joining-cloudflare/
- https://github.com/heroiclabs/nakama
- https://github.com/pixijs/pixijs
- https://pixijs.download/release/docs/scene.PerspectiveMesh.html
- https://github.com/phaserjs/phaser
- https://docs.phaser.io/api-documentation/namespace/tilemaps-orientation
- https://en.wikipedia.org/wiki/Phaser_(game_framework)
- https://excaliburjs.com/docs/isometric
- https://registry.npmjs.org/boardgame.io
- https://registry.npmjs.org/colyseus
- https://registry.npmjs.org/partyserver
- https://registry.npmjs.org/pixi.js
- https://registry.npmjs.org/phaser