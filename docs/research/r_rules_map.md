# 大富翁4（原版 PC，1998）基本规则与地图：设计规格草案

> 这份规格的数值大多来自两个公开的逆向工程仓库：oama1111/rich4-remake-public 和 oama1111/rich4-spec。两者都针对 rich4.exe v3.11（超时空之旅版），代码注释里写了机器码地址（VA）和存档实证。我用巴哈姆特 FAQ、B站攻略（蓝水夜lsy）、百度百科、中文维基、Fandom 做了交叉核对。凡是只有单一来源的数值，我都在 entries 里标成 medium 或 low。**本文只讲《大富翁4》原版**。《4 Fun》（手机和 Switch 版）规则不同，萌娘百科的部分数值也可能混入了 4 Fun，下文会单独标出。

---
## 1. 开局设置（选人/选图画面）
- **角色**：12 名，排成 2 行 × 6 列：约翰乔、沙隆巴斯、忍太郎、钱夫人、阿土伯、莎拉公主、宫本宝藏、糖糖、乌咪、孙小美、小丹尼、金贝贝。选中的格子描金边。
- **地图**：原版 4 张，界面显示为 TAIWAN / CHINA / JAPAN / U.S.A。Steam 版改名为"关卡一～四"。
- **六条下拉选项**（实机截图判读，与二进制中的表一致）：

| 选项 | 可选值 | 默认 | 二进制含义 |
|---|---|---|---|
| 游戏人数 | 四人 / 三人 / 二人 | 四人 | 引擎要求 2..4 人；真人不足时由电脑随机补角色 |
| 总资金 | 300000 / 200000 / 100000 / 50000 / 30000 / 10000 | 300000（存档实证；截图中有人选了 200000） | 表 0x46cb94。这个值同时是**物价指数的除数**：选得越少，通胀越快，实际上是难度旋钮 |
| 行进方式 | 步行 / 机车 / 汽车 | 步行 | 全员统一。开局骰子数 = 交通等级 + 1，并扣全局车辆库存 |
| 土地权限（地契） | 无限期 / 二年 / 一年 / 六个月 / 三个月 / 一个月 | 无限期 | 买地当天加 2 年 / 1 年 / 6 月 / 3 月 / 1 月（按日历月）；到期当天地主归零，房子保留 |
| 游戏时间 | 无限期 / 二年 / 一年 / 六个月 / 三个月 / 一个月 | 无限期 | 分别为 0 / 730 / 365 / 182 / 91 / 30 **天**（1 天 = 全员各走一回合） |
| 胜利条件 | 无限 / 100倍 / 50倍 / 10倍 / 5倍 / 3倍 | 无限 | 目标资产 = 倍数 × **本局所选总资金** |

  - 萌娘百科（仅从搜索摘要看到）列的胜利条件是"60000、100000、200000、1000000、2000000、无限"。这些数字恰好等于 2 万 ×(3/5/10/50/100)，但二进制的资金档里没有 2 万，可能来自 4 Fun 或别的版本。复刻时应以倍率表为准。
- **初始资金分配**：
  - 真人：现金 = 总资金 ÷ 2，存款 = 剩余部分。
  - 电脑：现金 = 总资金 × 角色比例 ÷ 100，比例为 40–80%（例如阿土伯 40%、金贝贝 80%），存款 = 剩余部分。
  - 实证：30 万档下，孙小美 150000/150000，阿土伯（电脑）120000/180000。
- **点券**：开局 0 点（大富翁3 开局是 100 点）。
- **开局道具**：每人各 1 件机器娃娃、路障、地雷、定时炸弹、遥控骰子、机器工人（只有逆向这一个来源）。
- **开局日期**：取电脑系统当天，范围限制在 1998-01-01 到 2010-01-01。2010 年以后的电脑一律从 **2010-01-01** 开始（巴哈 FAQ 也提到"2010 年后固定 1 月 1 日"）。标题页另有"日期更改"按钮，具体功能未核实。
- **开局位置**：不在同一个起点。轮到某位玩家的第一回合时，才用"降落伞"把他随机放到一个可落脚的格子上，并随机定一个"来路"邻格作为朝向。地图上**没有"起点/经过起点领薪水"**。
- **开局物件**：随机摆放小财神、小福神、小穷神、小衰神、天使、恶犬以及礼物/宝箱。
- **难度**：原版**没有单独的"电脑难度"选项**。难度来自三处：
  - 所选角色的固定性格：大老奸 / 普通人 / 乖宝宝。
  - 总资金档位（影响通胀速度）。
  - 托管 AI 对话框：只能编辑**真人座位**交给电脑代打时的性格、是否用卡、是否用道具、现金/存款比例、股票/资金比例。
- **其他系统设置**（RICH4.CFG）：游戏速度 3 档、动画开关、音乐 4 档、音效 4 档、自动存档、右下角窗口（日月历 / 缩小地图 / 组合画面）、8 首 BGM。
- **联机**：原版支持同机多人，另有 IPX 局域网联线（百度百科）。上限 4 人。

## 2. 胜负判定
- **只在"日推进"那一刻判定**，不是每个玩家回合都判。顺序是：总天数 +1 → 判定 → 达成则当日其余结算（物价、行情、开奖、月结、地契）全部跳过。
- 游戏时间：已过天数 ≥ 目标天数时结束。**赢家是仍在场者中总资产最高的人**，平手取座位靠前者。边界情况：首富资产为 0 时时间条件不生效。
- 胜利条件：在场首富的总资产 ≥ 倍数 × 开局资金时结束，赢家同样是在场首富。
- 两条都设为"无限"时，只能靠破产结束：
  - 某人破产后，若**在场真人数 = 0**，立即结束（判真人负，电脑剩几家都结束）。
  - 若只剩 1 人，结束并判胜。
  - 否则继续。
- 投降：多人真人局中，≥2 名真人、共 ≥3 人参加，一名真人投降时可召唤死神附身对手（巴哈 FAQ）。
- **总资产** = 现金 + 存款 − 贷款 + Σ(持股 × 股价) + Σ自有住宅(地价 + 等级 × 房价) + Σ连锁店(地价 + 房价) + Σ设施(地价 + 等级 × 房价)。
  - 地价和房价按原始值计，不乘物价。
  - 用 32 位整数计算，超过 2147483647 会溢出成负数（B站实测"最大资产 2^31−1"与此一致）。

## 3. 回合流程
- **座位轮转**：0 → 1 → 2 → 3 → 0。游标绕回 0 号时推进一天，所以**一轮（全员各走一次）= 1 天**。巴哈原文："每一个人物都前进一回合便算一天"。
- **回合开始**（针对即将行动者）：
  1. 刷新股票可成交量。
  2. **贷款到期检查**：
     - 剩 3 天：真人弹出还款提醒窗。
     - 剩 2 天、1 天：各弹一次提示。
     - 到期当天："强制执行"扣回本金，扣穿即破产。
  3. 阻碍计数递减：住宿、消失、坐牢、住院。
  4. 其他计数递减：冬眠、梦游、乌龟、停留、拒贷、同盟、保险。
  5. 神明任期递减、研究所研发推进。
  6. 如果仍被阻碍，弹出"○○住院中／还剩 N 天"框（1.5 秒），本回合结束。
  7. 梦游者自动走子。
- **真人行动阶段**（掷骰前）：
  - 可以使用卡片（电脑每回合最多 1 张）、道具、股市买卖、公布栏或拍卖、存档、托管等。
  - 可以切换本次掷骰颗数：步行固定 1 颗，机车 1–2 颗，汽车 1–3 颗。
- **掷骰**：每颗 1–6 均匀随机，点数和即步数。遥控骰子可直接指定 1–6。
- **逐格移动**：每走一格结算经过效果，包括：
  - 路障拦停；
  - 地雷；
  - 踩到神明被附身；
  - 定时炸弹引信减 1；
  - 经过银行可存取款；
  - 恶犬、礼物、宝箱等。
- **落点结算**：共 17 类落点处理器，编号见第 11.4 节。
- **待决交互**：买地、盖房、商店、银行、乐透、保释等需要回应。回应后回合结束，先检查破产，再轮到下一位。
- **电脑回合**：先用一次随机数在"用卡"和"用道具"之间二选一（互斥），再决定骰子颗数，然后掷骰。

## 4. 骰子与交通工具
| 方式 | 骰子 | 获得方式 | 特性 |
|---|---|---|---|
| 步行 | 固定 1 颗 | 默认 | 撞到恶犬被咬，住院 3 天 |
| 机车 | 1–2 颗可选（默认 2） | 开局设定；百货公司 **80 点券**；抢夺卡抢得 | 撞飞恶犬；加油站、汽车公司、石油公司收油费 |
| 汽车 | 1–3 颗可选（默认 3） | 开局设定；百货公司 **150 点券**；抢夺卡 | 同上；B站称汽车不会触发命运住院（单一来源） |
| 工程车 | 研究所 4 级研发 | 研究所 | 7 天内经过的对手房屋拆成空地 |

- 全局库存：机车、汽车各 10 台（道具表 init_amount）。每人同种道具最多持有 9 件。
- 被地雷、定时炸弹、飞弹、核弹炸到时**车毁**，变回步行 1 颗骰子。
- 油费公式：加油站按"步数 × 交通等级"收费；汽车公司、石油公司收 **地价 × 载具倍率 × 步数 × 物价**，步行免费，大股东免费。

## 5. 行走方向与岔路
- 地图是**节点图**，每个节点最多 4 个邻接节点，路径以 45° 俯视、八方向连接。
- 棋子**永远向前**，不走回头路：候选节点会排除"上一格"和被静态封掉的邻接槽。
- **岔路不询问玩家**：在剩下的候选中 `rand() % n` 随机挑一条。即使只有 1 个候选也会消耗一次随机数。
- 没有候选（死路）时原路返回。
- 玩家只能靠转向卡（立即向后转）、传送机、乌龟卡、停留卡、路障等手段间接控制路线。
- 这一条只有逆向单源。社区资料没有提到"选路"交互，与之不矛盾。
- 台湾图两个岔路各有一条支线被静态封掉，实际只剩一条路可走。

## 6. 日期与日历
- 日期推进：日 +1，超过当月天数则进月，12 月后进年。闰年只判"能被 4 整除"。
- 星期：1998-01-01 定为星期四。
- **休市**：星期日一律休市，另加各地图的节日表：
  - 台湾：元旦、3/29、4/4、4/5、5/1、9/28、10/10、10/25、10/31、11/12、12/25、农历除夕至初三、端午、中秋等。
  - 中国：3/8、5/4、6/1、7/1、8/1、10/1、春节等。
  - 日本：2/11、4/29、5/3、5/5、11/3、11/23、12/23 等。
  - 美国：7/4、感恩节、圣诞节等。
  - 休市日不跑行情。巴哈称"每逢星期例假日股市跟银行都休息"，逆向资料只确认了**股市**休市规则。
- 节日：圣诞节（地图 0–3）每位在场玩家送 1 张卡；农历新年、圣诞节会切换节日 BGM。
- 季节底图：2–4 月为春，5–7 月夏，8–10 月秋，11–1 月冬。
- 贷款期限 = **90 天**。到期日若落在假日，顺延到下一个工作日。

## 7. 每日 / 每月结算（日推进 `advanceGameDay` 的顺序）
1. 日期 +1，总天数 +1。
2. **胜负判定**（达成即结束）。
3. **物价指数**：`新指数 = floor(在场者平均总资产 / 开局资金)`，**只升不降**。开局为 1。所有地价、租金、罚款、奖金都乘这个指数。
4. 股票倒数计时；非休市日跑一次行情。
5. 节日送卡。
6. **每月 15 日**：
   - 上市公司累积盈余按持股比例分红，进存款。盈余为负时反向扣，扣穿即破产。
   - **乐透开奖**：每注 1000 元，没人中奖则奖池累积。
7. **跨月当天（即每月 1 日）月结**：
   - **存款 × 1.1**（10% 月息，向零取整）。**有贷款者不发利息**。
   - 结算屏显示每人的利息、"本月意外损失"、"本月意外之财"、"本月倒楣天数"。
   - 评出"本期悲情人物"：`分数 = 意外损失 − 意外之财 + 倒楣天数 × 物价 × 2500 + 霉运值 × 10`。最高分须领先次高分 40% 以上才颁发。
   - 评出"本期冠军"（总资产最高者）。
   - 清零三项月度累计。
   - 月结屏上是否另有奖金：逆向资料里没看到。
8. **跨月**：礼物和宝箱收回后重新随机摆放。
9. **每日**：涨价卡、查封卡的倒数（5 天）递减；地契到期的地归为无主，房子保留。

- 各来源对月息时点的说法："每月最后一天发 10% 利息"（巴哈）和"每月 1 号 10% 利息"（B站）指的是同一次跨月结算。
- **年底**：没有发现单独的年终结算，只有元旦和农历新年的节日效果。

## 8. 付款级联与银行（与破产直接相关）
- **付款顺序**：先扣现金，不足扣存款，再不足就**当场破产**。
  - **不会**自动动用贷款额度。
  - **不会**自动变卖房产或股票。
- 免费卡可在大额付款（租金、罚款、税 > 2000 × 物价）或付款超过剩余资金时抵免一次。
- **贷款**：
  - 只能在**停在银行**时办理。
  - 额度 = 总资产 − 现有贷款。
  - 借款**进存款**，90 天无息。
  - 借贷期间不发存款利息。
  - 还款时先扣存款再扣现金。
  - 经过银行只能存款和取款。
- 银行董事长（持股最多者）可以"特别融资"，即挪用他人存款。

## 9. 破产判定与清算流程
1. **触发**：任何一笔应付款（过路费、罚款、分红负值、贷款强制执行等）大于现金 + 存款，即破产。
2. 身上附着的神明和定时炸弹放回地图；清空其监狱/医院床位；清空他人对他的敌意；作废其乐透号码。
3. 若破产导致对局结束（在场真人为 0，或只剩 1 人），**跳过清算**，他的地产原样留在图上。
4. 否则清算：
   - 所有股票按市价卖出，**所得进乐透奖池**，并重排董事长。
   - 名下住宅和设施一律变为**无主**，**房屋等级保留**；此后别人买下需付"地价 + 等级 × 房价"。
   - 卡片、道具全部变卖（点券不归任何人）。
   - 如果释放的地产**超过 3 处**，随机抽 **3 处**进行拍卖（维基称"破产拍卖限三次"），成交款进奖池。不超过 3 处则一场都不拍。
5. 破产者的棋子留在原地变成**乞丐**。别人**停**在同一格时要施舍 **1000 × 物价指数**（进奖池），乞丐随后换位置。
6. 破产者现金、存款、贷款、点券、状态全部清零。

## 10. 停留天数机制（住院、坐牢、住宿、消失、冬眠等）
| 原因 | 状态 | 天数 |
|---|---|---|
| 踩地雷 | 住院 | 3，车毁 |
| 步行被恶犬咬 | 住院 | 3 |
| 定时炸弹（附身后走 **38 格**爆炸） | 住院 | 5，车毁 |
| 飞弹（3×3）/ 核子飞弹（9×9） | 住院 | **3**（B站写 5，与二进制和百科不符），车毁 |
| 新闻"外星人攻打地球" | 住院 | 3 |
| 魔法屋"立刻坐牢 / 住院" | 坐牢 / 住院 | 3 |
| 陷害卡 | 坐牢 | 5（对自己使用为 4） |
| 命运卡坐牢事件 | 坐牢 | 3 / 5 / 7 / 9（仅地图 0–3） |
| 新闻：董事长入狱 | 坐牢 | 5 |
| 旅馆（对手的） | 住宿 | 转盘 1 / 2 / 3 / 4 天，并付费 |
| 航空公司、出国观光、外星人绑架 | 消失 | 转盘决定 |
| 冬眠卡 | 冬眠（所有对手） | 5；在牢里或医院里的天数不算 |
| 梦游卡 | 梦游 | 自动乱走、不收租 |
| 停留卡 | 原地停一次 | — |
| 乌龟卡 | 三次只走 1 步 | — |
| 神明附身 | — | 7 天（死神 13 天） |
| 同盟卡 | — | 7 天 |
| 查封卡 / 涨价卡 | — | 5 天 |
| 工程车 | — | 7 天 |

- **加刑**：已经关着再判刑时天数累加（上限 127）。首次关押会同时清掉住宿、消失、另一种关押状态。
- **关押格**：人被搬到关押格（台湾图为"绿岛"和"医院大楼"）。监狱、医院各 8 个床位（4 名玩家 + 4 名恶人）。
- **关押期间**：本人地产**不收过路费**，但公司照常收钱；每天计入"本月倒楣天数"；若买了保险，保险公司赔 2000 × 天数 × 物价。
- **刑满释放**：计数到 0 后挂上"待释放"标记，下一回合整回合走回棋盘，**不掷骰**。状态框显示"还剩（计数 + 1）天"。
- **落在监狱格或医院格**：**不会**被关，而是打开保释菜单：
  - 花 30 点券保释其他玩家；
  - 花 300 点券放出小偷、强盗（监狱）或流氓、间谍（医院）。

## 11. 地图
### 11.1 地图清单（global_map_id = 关卡 × 4 + 图号）
| id | 名称 | 节点 | 住宅地块 | 设施大地（占 2 格） | 上市企业 | 景观 | 地图上的企业 |
|---|---|---|---|---|---|---|---|
| 0 | 台湾 | 103 | 50 | 4 | 3 | 21 | 中国信托（银行）、台湾人寿、大宇百货 |
| 1 | 中国大陆 | 144 | 73 | 8 | 4 | 26 | 上海银行、中国人寿、王府井百货、中国石油 |
| 2 | 日本 | 110 | 49 | 5 | 6 | 16 | 富士银行、三井生命、三越百货、日产建设、SEGA、丰田汽车 |
| 3 | 美国 | 118 | 55 | 8 | 6 | 16 | 花旗银行、乔治亚人寿、环球百货、联合航空、福特汽车、IBM |
| 4* | 星际/宇宙 | 135 | 47 | 5 | 3 | 2 | 行星银行、银河保险、宇宙百货（节点为 12 星座和行星） |
| 5* | 武侠/仙剑 | 135 | 60 | 3 | 12 | 143 | 聚宝银楼、狂徒镖局、南北货场及 8 大门派、逍遥客栈 |
| 6* | 恐龙 | 141 | 55 | 6 | 3 | 154 | 黄金银行、肥龙保险、飞龙百货 |
| 7* | 岛屿/梦幻乐园 | 101 | **0** | 20 | 7 | 79 | 假期银行、假期百货、5 家大饭店 |

- \* 为资料片《超时空之旅》地图，各来源命名不一：Fandom 写"星际之旅、恐龙世界、仙剑世界、南岛历险"，维基写"宇宙、武侠、恐龙、岛屿"。
- "节点"包括不可走的景观节点（全部 8 张图共 987 个节点，其中 20 个没有邻接）。
- 每张图有 12 支股票，企业（蓝色字）只是其中一部分。

### 11.2 格子数据结构（MAP.MKF，每张图一个资源）
- **节点（40 字节）**：x、y 坐标，Big5 名称，4 个邻接节点号，type 字段，装饰图，flags。
  - type 编码：0 = 特殊格（种类看 flags 低字节）；2000+i = 住宅 lands[i]；4000+i = 设施 facilities[i]；6000+i = 企业；8000+i = 景观（8001 为医院关押格，8002 为监狱关押格）。
- **住宅地块（52 字节）**：名称、地价、房价、**6 档租金表（0–5 级）**、地主、等级、类型（住宅或连锁店）、涨价/查封状态、地契到期日。
- **同名地块 = 同一条街（路段）**。原版逐块比较名字（strcmp）。
- **台湾实例**：台南市 4 块，每块地价 1500、房价 300（第 1 块是 500，原版数据瑕疵），租金表 [300, 750, 2000, 4800, 10000, 18000]。
- 台湾景观包括阿里山、佛光山、绿岛（监狱关押处）、医院大楼。

### 11.3 地产价格公式（全部乘物价指数 PI）
- 买无主住宅：PI × (地价 + 房价 × 当前等级)。
- 加盖一层：PI × 房价，最高 5 级（空地 0 → 平房 1 → 店铺 2 → 商场 3 → 商业大楼 4 → 摩天大楼 5）。
- **过路费**：PI × Σ(地主在**同名路段**所拥有各块的租金表[等级])。整条街都是你的，租金就叠加。
- 连锁店（用改建卡改成）：过路费 = PI × 2000 × 地主在全图拥有的连锁店数。
- 设施大地：
  - 买地 = PI × 地价(+0x22)；首建也按地价；加盖按房价(+0x24)。
  - 等级上限：公园 1、旅馆 5、购物中心 5、加油站 1、研究所 5。
- 企业收费：
  - 航空：转盘 × 地价 × PI，并消失几天；
  - 电子：地价 × 总天数（不乘物价）；
  - 保险：强制投保 3–30 天；
  - 汽车、石油：地价 × 载具倍率 × 步数 × PI；
  - 建设：选地加盖；
  - 门派：地价 × 步数 × PI；
  - 饭店、银行、百货不收费。
  - 企业收入进公司盈余，15 日分红。

### 11.4 17 类落点（节点 flags 低字节）
| 编号 | 落点 | 编号 | 落点 |
|---|---|---|---|
| 0 | 地产 / 设施 / 企业结算 | 9 | 乐透 |
| 1 | 普通格 | 10 | 得 50 点 |
| 2 | 新闻 | 11 | 得 30 点 |
| 3 | 命运 | 12 | 得 10 点（资料片中为星座/行星格） |
| 4 | 监狱（保释） | 13 | 卡片（抽 1 张） |
| 5 | 医院（保释） | 14 | 银行 |
| 6 | 企鹅挖宝 | 15 | 百货公司 |
| 7 | 七彩气球 | 16 | 魔法屋 |
| 8 | 喜从天降 | | |

- 公园也作为特殊种类 1 出现在节点表中。
- 全部 8 张图的数量合计：公园 10、新闻 17、命运 22、监狱 7、医院 3、企鹅 9、气球 10、喜从天降 8、乐透 16、50 点 26、30 点 39、10 点（含星座/行星）130、卡片 13、魔法屋 15。
- **逐图逐格的完整名称、地价、租金表未在公开资料中找到**。需要从正版的 MAP.MKF / MAPDAT.MKF 按上述格式解析（资源号 = 图号 × 2 + 1）。

## 12. 电脑 AI 行为
- **个性**（角色固定，可在托管对话框改）：
  - 大老奸：约翰乔、忍太郎、钱夫人、金贝贝。
  - 普通人：沙隆巴斯、阿土伯、莎拉公主、宫本宝藏、小丹尼。
  - 乖宝宝：糖糖、乌咪、孙小美。
  - B站与逆向资料一致。
- **个性闸门**：每种卡片或道具行为有一个"凶狠度"f7（0–2）。差值 = f7 − 个性：
  - ≥ 2：从不做；
  - = 1：1/3 概率做；
  - ≤ 0：照做。
  - 因此乖宝宝几乎不害人，大老奸什么都做。
- **视野**：只对画面内（以自己为中心 ±220 像素）的目标出卡。**永不使用时光机**。
- **买地**：满足 `现金 + 存款 − 地价 > min(开局资金 × 5%, 7000) × PI` 就买。不考虑仇恨。
- **盖房**：自有地等级 < 5 且现金 ≥ 房价 × PI 就盖。
- **商业大地**：现金够就买，行业随机 `rand() % 4 + 1`（旅馆 / 购物中心 / 加油站 / 研究所）。
- **贷款**：
  - 到银行时借"身家 × 借贷比例"：约翰乔 60、沙隆巴斯 100、忍太郎 0、钱夫人 100、阿土伯 50、莎拉 75、宫本 100、糖糖 0、乌咪 0、孙小美 50、小丹尼 30、金贝贝 80。
  - 放款闸门：`rand() % 10 == 0`，或现金 + 存款 < 30000。
  - 提前还款：2 × 贷款 < 存款，或距到期 ≤ 6 天且现金 + 存款 ≥ 1.1 × 贷款。
- **炒股**：目标持仓 = (持仓市值 + 现金 + 存款) × 比例（上限为存款）。忍太郎、孙小美、金贝贝的比例为 0，从不买股票（与 B站"大老奸爱买股票"的印象不完全一致）。
- **骰子**：
  - 开车默认 3 颗、骑车默认 2 颗。
  - 身背定时炸弹且引信 < 15 格时只掷 1 颗。
  - 前瞻 5 格：无安全地且对手地 > 2 块时，汽车掷 2–3 颗（随机）、机车 2 颗；安全地 ≥ 2 块且对手地 ≤ 1 块时只掷 1 颗。
- **银行现金重分配**：到银行时按"现金比例"重分现金和存款。月初（1–7 日）× 1.5，月末（≥ 26 日）× 0.5。
- **敌意表**：记录谁害过谁，用来挑"最仇恨的对手"作为出卡目标。平手取座位号小者。

## 13. 复刻（4 人联机）实现提示
- 岔路随机、骰子、事件都依赖同一条伪随机序列。联机时应由服务器统一掷随机数并广播结果，才能保证各端一致。
- 胜负、物价、分红、开奖、月结都挂在"日推进"上，即游标绕回 0 号座位时，一轮 = 一天。
- 原版"真人全部出局即结束"：做 4 人联机时，要决定掉线或破产的真人由 AI 接管还是直接判负。


## entries
- **游戏人数** [开局设置] (high) 默认 4 人，可改为 3 人或 2 人；真人不足时电脑随机补角色。引擎要求 2..4 人。 | 数值: 2/3/4（默认4） | src: https://forum.gamer.com.tw/C.php?bsn=972&snA=2070, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/new-game.ts, https://github.com/oama1111/rich4-remake-public/blob/main/docs/original-screens.md
- **总资金（初始资金档位）** [开局设置] (high) 每人开局的现金加存款总额。这个值同时是物价指数的除数：选得越少通胀越快。 | 数值: 300000/200000/100000/50000/30000/10000；二进制默认 300000 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/setup.ts, https://forum.gamer.com.tw/C.php?bsn=972&snA=2070, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **初始现金/存款分配** [开局设置] (medium) 真人现金与存款各一半；电脑按角色的现金比例拿现金，其余为存款。 | 数值: 真人现金=总资金/2；电脑比例：约翰乔50 沙隆巴斯40 忍太郎70 钱夫人60 阿土伯40 莎拉70 宫本50 糖糖40 乌咪60 孙小美50 小丹尼55 金贝贝80（%） | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/setup.ts, https://github.com/oama1111/rich4-remake-public/blob/main/packages/data/src/characters.ts
- **行进方式（开局交通工具）** [开局设置] (high) 全员统一的开局交通工具，决定开局骰子数（交通等级+1），并扣全局车辆库存。 | 数值: 步行1颗/机车2颗/汽车3颗；默认步行 | src: https://forum.gamer.com.tw/C.php?bsn=972&snA=2070, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/new-game.ts, https://github.com/oama1111/rich4-remake-public/blob/main/docs/original-screens.md
- **土地权限（地契期限）** [开局设置] (high) 买地或设施当天起计算的持有期限，到期当天地主归零、房子保留。判定用等于比较，错过那一天就永不到期。 | 数值: 无限期/二年/一年/六个月/三个月/一个月（按日历月加：+2年/+1年/+6月/+3月/+1月）；默认无限期 | src: https://forum.gamer.com.tw/C.php?bsn=972&snA=2070, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/facility.ts
- **游戏时间** [胜负条件] (high) 到期结束，在场总资产最高者获胜。只在日推进时判定。 | 数值: 无限期/730/365/182/91/30 天（二年/一年/六个月/三个月/一个月） | src: https://forum.gamer.com.tw/C.php?bsn=972&snA=2070, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/setup.ts, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/victory.ts
- **胜利条件（资产目标）** [胜负条件] (high) 在场首富的总资产达到“倍数×本局总资金”时结束，首富获胜。设为无限时只靠破产分胜负。 | 数值: 无限/100倍/50倍/10倍/5倍/3倍；萌娘百科另列 60000/100000/200000/1000000/2000000（疑似版本混淆） | src: https://forum.gamer.com.tw/C.php?bsn=972&snA=2070, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/setup.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **破产结束条件** [胜负条件] (medium) 某人破产后，在场真人数为 0 则结束（判负，即使还剩电脑）；只剩 1 人则判胜；否则清算后继续。 | 数值: 终局码 1=真人全出局，2=单真人局胜，3=多真人局胜 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/bankruptcy.ts
- **开局点券与道具** [开局设置] (medium) 点券从 0 开始。逆向显示开局每人发 6 件道具各 1 件。 | 数值: 点券0；道具：机器娃娃、路障、地雷、定时炸弹、遥控骰子、机器工人 各1 | src: https://zh.wikipedia.org/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/tools.ts
- **开局日期与位置** [开局设置] (medium) 起始日期取系统当天并限制范围；没有固定起点，轮到谁的第一回合就用降落伞把他随机放到一个空格上，并随机定一个来路方向。 | 数值: 日期范围 1998-01-01..2010-01-01（2010 年后恒为 2010-01-01） | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/setup.ts, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/start-placement.ts, https://forum.gamer.com.tw/C.php?bsn=972&snA=2070
- **回合与天数** [回合流程] (high) 座位依次行动；游标绕回首位时日期加 1 天，即全员各走一回合 = 1 天。 | 数值: 1轮=1天 | src: https://forum.gamer.com.tw/C.php?bsn=972&snA=2070, https://github.com/oama1111/rich4-remake-public/blob/main/docs/PRD.md
- **骰子数量** [骰子与交通] (high) 步行固定 1 颗；机车可选 1–2 颗；汽车可选 1–3 颗。每颗 1–6，点数和为步数。遥控骰子可指定 1–6。 | 数值: 步行1、机车≤2、汽车≤3 | src: https://zh.wikipedia.org/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://richman.fandom.com/zh/wiki/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://baike.baidu.com/item/%E5%A4%A7%E5%AF%8C%E7%BF%814/7390694
- **交通工具获得与损毁** [骰子与交通] (high) 通过开局设定、百货公司用点券购买、抢夺卡获得。被地雷、定时炸弹、飞弹、核弹炸到时车毁，变回步行。车辆能撞飞恶犬，但要付油费。 | 数值: 机车80点、汽车150点；全局库存各10；每种道具最多持有9件 | src: https://www.bilibili.com/read/cv28566011/, https://baike.baidu.com/item/%E5%A4%A7%E5%AF%8C%E7%BF%814/7390694, https://forum.gamer.com.tw/C.php?bsn=972&snA=2070
- **行走方向与岔路** [移动] (medium) 只向前走，排除回头路和被封的支路。岔路由系统随机选择，不问玩家；死路时原路返回。玩家只能用转向卡、传送机等改变方向。 | 数值: 每步 rand()%候选数；台湾图2个岔路各封一条 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/state/reduce.ts, https://github.com/oama1111/rich4-remake-public/blob/main/docs/PRD.md
- **日推进顺序（每日结算）** [日期结算] (high) 日推进依次执行：日期+1 → 胜负判定 → 物价指数 → 股票行情（休市不走）→ 节日送卡 → 15 日分红和乐透开奖 → 跨月月结 → 跨月重摆礼物宝箱 → 涨价/查封倒数和地契到期。 | 数值: 15日分红+开奖；每月1日月结 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/state/reduce.ts, https://forum.gamer.com.tw/C.php?bsn=972&snA=2070, https://www.bilibili.com/read/cv28566011/
- **月结（存款利息与颁奖）** [日期结算] (high) 跨月时存款乘 1.1，有贷款者不发利息。结算屏显示利息、本月意外损失和意外之财、倒楣天数，并评出“本期悲情人物”和“本期冠军”。 | 数值: 月息10%；悲情分=损失−之财+倒楣天数×物价×2500+霉运×10，领先次高>40%才颁 | src: https://forum.gamer.com.tw/C.php?bsn=972&snA=2070, https://www.bilibili.com/read/cv28566011/, https://zh.wikipedia.org/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **休市日与节日** [日期结算] (medium) 星期日和各地图节日股市休市，不跑行情。圣诞节等节日每人送 1 张卡。闰年只判能否被 4 整除。 | 数值: 1998-01-01=星期四；每图最多24条节日 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/places/calendar.ts, https://forum.gamer.com.tw/C.php?bsn=972&snA=2070
- **物价指数** [经济] (high) 每日按在场者平均总资产除以开局资金更新，只升不降。所有金额都乘物价指数。 | 数值: 开局1；新值=floor(平均资产/开局资金)；B站称正常上限107374 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/wealth.ts, https://www.bilibili.com/read/cv28566011/
- **贷款** [银行] (high) 只能停在银行时借，额度等于总资产减现有贷款，借款进存款，90 天无息。到期前 3、2、1 天提醒，到期强制扣回，扣穿即破产。借贷期间不发存款利息。 | 数值: 额度=总资产−贷款；期限90天（遇假日顺延） | src: https://zh.wikipedia.org/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://www.bilibili.com/read/cv28566011/, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/places/bank.ts
- **付款级联与破产判定** [破产] (high) 应付款先扣现金，不足扣存款，再不足就当场破产。不会自动借款，也不会自动卖地。免费卡可抵一次大额付款或破产前的付款。 | 数值: 免费卡门槛：>2000×物价 或 超过剩余资金 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/bankruptcy.ts, https://baike.baidu.com/item/%E5%A4%A7%E5%AF%8C%E7%BF%814/7390694, https://forum.gamer.com.tw/C.php?bsn=972&snA=2070
- **破产清算与拍卖** [破产] (high) 股票卖掉，钱进乐透奖池；地产变无主但房屋等级保留；卡片和道具变卖。释放的地产超过 3 处时随机拍卖其中 3 处，款进奖池。若破产导致终局则跳过清算。 | 数值: 最多拍3处（仅当释放>3处） | src: https://zh.wikipedia.org/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://baike.baidu.com/item/%E5%A4%A7%E5%AF%8C%E7%BF%814/7390694, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/state/reduce.ts
- **乞丐** [破产] (medium) 破产者棋子留在图上成为乞丐。别人停在同一格时要施舍一笔钱（进奖池），乞丐随后换位置。 | 数值: 施舍=1000×物价指数 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/beggar.ts, https://api.xiaoheihe.cn/maxnews/app/share/detail/2723710
- **住院天数** [停留天数] (high) 受伤后送医院，住院期间地产不收过路费（公司照收）。 | 数值: 地雷3、恶犬3、定时炸弹(38格引爆)5、飞弹/核弹3（B站写5天，有冲突）、外星人3、魔法屋3 | src: https://baike.baidu.com/item/%E5%A4%A7%E5%AF%8C%E7%BF%814/7390694, https://forum.gamer.com.tw/C.php?bsn=972&snA=2070, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/tool-effects.ts
- **坐牢天数** [停留天数] (high) 犯罪或被陷害后送监狱。已在牢中再判刑则加刑累计。落在监狱格或医院格不会被关，而是打开保释菜单。 | 数值: 陷害卡5（对自己4）、魔法屋3、命运3/5/7/9、新闻董事长5；保释他人30点、恶人300点 | src: https://forum.gamer.com.tw/C.php?bsn=972&snA=2070, https://www.bilibili.com/read/cv28566011/, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/confinement.ts
- **其他停留状态** [停留天数] (medium) 旅馆住宿、消失（出国或被绑架）、冬眠、梦游、停留、乌龟等状态。刑满后还要多花一个回合走回棋盘，这一回合不掷骰。 | 数值: 旅馆转盘1/2/3/4天；保险转盘3/5/10/15/20/30天；冬眠5；梦游5；神明7（死神13）；同盟7；查封/涨价5；工程车7 | src: https://baike.baidu.com/item/%E5%A4%A7%E5%AF%8C%E7%BF%814/7390694, https://www.bilibili.com/read/cv28566011/, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/facility.ts
- **原版地图清单** [地图] (high) 原版 4 张图，另有资料片 4 张。Steam 版改名为“关卡一~八”。 | 数值: 台湾、中国大陆、日本、美国；资料片：星际、武侠/仙剑、恐龙、岛屿/梦幻乐园 | src: https://zh.wikipedia.org/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://richman.fandom.com/zh/wiki/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://baike.baidu.com/item/%E5%A4%A7%E5%AF%8C%E7%BF%814/7390694
- **各地图规模** [地图] (medium) 每张图的节点数、住宅地块数、设施大地数（每块占 2 格）、上市企业数、景观数。 | 数值: 台湾103/50/4/3/21；中国144/73/8/4/26；日本110/49/5/6/16；美国118/55/8/6/16；资料片135/47/5/3/2、135/60/3/12/143、141/55/6/3/154、101/0/20/7/79 | src: https://github.com/oama1111/rich4-spec/blob/main/docs/systems/map-format.md, https://github.com/oama1111/rich4-remake-public/blob/main/docs/map-format.md
- **地图上的上市企业** [地图] (high) 各图地图上可踩的企业（股市中蓝字），与实体公司落点收费方式一一对应。 | 数值: 台湾：中国信托/台湾人寿/大宇百货；中国：上海银行/中国人寿/王府井百货/中国石油；日本：富士银行/三井生命/三越百货/日产建设/SEGA/丰田汽车；美国：花旗银行/乔治亚人寿/环球百货/联合航空/福特汽车/IBM | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/data/src/stocks.ts, https://www.bilibili.com/read/cv28566011/
- **路段（同区）与过路费** [地图] (high) 同名地块属于同一路段。过路费等于地主在该路段所有地块的租金表值之和再乘物价。连锁店按全图连锁店数计费。 | 数值: 租金表6档；连锁店2000×数量×物价；最高5级 | src: https://github.com/oama1111/rich4-spec/blob/main/docs/systems/land-rent.md, https://www.bilibili.com/read/cv28566011/
- **台湾图地块样本** [地图] (medium) 台南市 4 块地的地价、房价、租金表（其中 1 块房价不同，为原版数据瑕疵）。 | 数值: 地价1500；房价300（第1块500）；租金[300,750,2000,4800,10000,18000] | src: https://github.com/oama1111/rich4-remake-public/blob/main/docs/known-deviations.md
- **17类落点** [地图] (high) 停留格的种类，由节点 flags 低字节决定。 | 数值: 地产/普通/新闻/命运/监狱/医院/企鹅挖宝/七彩气球/喜从天降/乐透/50点/30点/10点/卡片/银行/百货公司/魔法屋 | src: https://github.com/oama1111/rich4-spec/blob/main/docs/systems/game-loop.md, https://richman.fandom.com/zh/wiki/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **电脑个性** [电脑AI] (high) 每个角色有固定个性，决定电脑出卡、害人、买股票的倾向，是原版唯一的“难度”来源。 | 数值: 大老奸：约翰乔/忍太郎/钱夫人/金贝贝；普通人：沙隆巴斯/阿土伯/莎拉/宫本/小丹尼；乖宝宝：糖糖/乌咪/孙小美；闸门：凶狠度−个性≥2不做、=1概率1/3 | src: https://www.bilibili.com/read/cv28566011/, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/ai/personality.ts, https://github.com/oama1111/rich4-remake-public/blob/main/docs/original-screens.md
- **电脑买地/盖房/借贷/炒股** [电脑AI] (medium) 电脑的买地、盖房、借贷、炒股、骰子数都按固定阈值和比例决定，每回合在用卡和用道具之间二选一，从不使用时光机。 | 数值: 买地保留额=min(开局资金×5%,7000)×物价；借贷比例0–100%；炒股比例0–45%；背炸弹引信<15只掷1颗 | src: https://github.com/oama1111/rich4-spec/blob/main/docs/systems/ai.md, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/ai/dice-policy.ts, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/places/bank.ts

## open_questions
- 各地图完整格子表（每块地的名称、地价、房价、6 档租金表、坐标、邻接关系，以及设施大地和企业的数值）在公开网页和逆向文档里都没找到。只查到台湾台南市一组样本。需要从正版 MAP.MKF 或 MAPDAT.MKF（资源号 = 图号×2+1）按已公开格式解析。
- 地价范围有冲突：B站攻略写“地价 100–600”，逆向样本是台南市 1500、测试参数写“地价 1000~8000”。原版实际显示值待核实。
- 开局每人发 6 件道具（机器娃娃、路障、地雷、定时炸弹、遥控骰子、机器工人）目前只有逆向工程这一个来源，没有找到社区交叉证实。
- 萌娘百科的胜利条件“60000/100000/200000/1000000/2000000”与二进制倍率表（原总资金的 100/50/10/5/3 倍，巴哈 FAQ 印证）不一致。萌娘正文无法抓取，版本出处待查（疑似 4 Fun）。
- “1 天 = 全员各走一回合”已确认。但刑满后要多丢一回合走回棋盘，“N 天刑期”实际等于 N 还是 N+1 个自己回合，需要实机核对。
- 月结屏的“本期悲情人物”“本期冠军”是否附带奖金或奖品，逆向资料里没看到。
- 没有发现单独的“年底结算”，是否确实不存在待确认。
- 巴哈称星期例假日股市和银行都休息，逆向资料只确认股市在星期日和节日休市。周六是否休市、银行在假日能否存取款、能否借贷，待核实。
- 玩家行动顺序：按选角顺序还是座位顺序，是否会随机，未查到明确说明。
- 标题页“日期更改”功能的具体范围和效果未核实。
- B站称“汽车不会触发命运住院”，只有这一个来源。
- 资料片 4 张地图名称各来源不统一（Fandom、维基、百度百科各不相同），图号 5/6/7 与名称的对应仍需核对。
- 搜索摘要提到“台湾地图有 29 个土地和 4 个商业设施”，与二进制统计的 50 块住宅不符，可能出自 4 Fun。
- 原版 IPX 联机的具体规则（能否中途托管，掉线如何处理）没有找到资料。

## sources
- https://forum.gamer.com.tw/C.php?bsn=972&snA=2070
- https://www.bilibili.com/read/cv28566011/
- https://www.bilibili.com/opus/875661802094985219
- https://baike.baidu.com/item/%E5%A4%A7%E5%AF%8C%E7%BF%814/7390694
- https://zh.wikipedia.org/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814
- https://richman.fandom.com/zh/wiki/%E5%A4%A7%E5%AF%8C%E7%BF%814
- https://www.jendow.com.tw/wiki/%E5%A4%A7%E5%AF%8C%E7%BF%814
- https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814
- https://api.xiaoheihe.cn/maxnews/app/share/detail/2723710
- https://github.com/oama1111/rich4-remake-public
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/setup.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/new-game.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/victory.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/calendar.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/places/calendar.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/monthly.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/bankruptcy.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/confinement.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/blocking.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/turn-start.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/state/reduce.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/places/bank.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/wealth.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/beggar.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/facility.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/tools.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/start-placement.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/ai/personality.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/ai/dice-policy.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/data/src/characters.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/data/src/stocks.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/data/src/tools.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/docs/map-format.md
- https://github.com/oama1111/rich4-remake-public/blob/main/docs/PRD.md
- https://github.com/oama1111/rich4-remake-public/blob/main/docs/known-deviations.md
- https://github.com/oama1111/rich4-remake-public/blob/main/docs/original-screens.md
- https://github.com/oama1111/rich4-spec
- https://github.com/oama1111/rich4-spec/blob/main/docs/systems/map-format.md
- https://github.com/oama1111/rich4-spec/blob/main/docs/systems/land-rent.md
- https://github.com/oama1111/rich4-spec/blob/main/docs/systems/ai.md
- https://github.com/oama1111/rich4-spec/blob/main/docs/systems/game-loop.md
- https://github.com/oama1111/rich4-spec/blob/main/docs/systems/economy.md
- https://github.com/mytbk/rich4
- https://github.com/mytbk/rich4/blob/master/docs/map.txt
- https://github.com/mytbk/rich4/blob/master/docs/rich4_cfg.txt