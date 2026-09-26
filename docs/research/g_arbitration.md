# 大富翁4 版本基线、规则冲突裁决与回合/天数语义（实现规格）

> 适用：网页版 4 人联机复刻。只针对大富翁4原版；v3.11（超时空之旅合版）的逆向数据会逐条标注。排除《4 Fun》。
> 冲突处理原则：**默认采用 v3.11 exe 的实际行为**（有机器码证据）。说明书的写法做成房间开关（`rulesPreset: "manual"` 或逐项开关）。
> 证据的代号：**M** = 说明书 OCR（1998）；**MY** = mytbk/rich4 的反汇编（零售 v3.11）；**OA** = oama 的 rich4-spec 与 rich4-remake-public（同一作者，算一个来源，也是 v3.11）；**NU** = nurockplayer/richman4-remake（基于 Steam 系安装包里 Game 与 MultiverseJourney 两个 exe）；**BH** = 巴哈姆特攻略帖；**FD** = Fandom。

---

## 0. 版本基线（结论）

1. **逆向资料都基于 v3.11。** MY 的 README 写明零售版 rich4.exe 为 v3.11，大小 588 KiB，SHA256 前缀 `5a90aee2…`。OA 记录的是 602,112 字节，也就是同一份 588 KiB 文件。NU 手上有两个 exe：`Game`（SHA256 前缀 110b29f9…）和 `MultiverseJourney`（前缀 50cb24bb…）。MJ 版卡表的文件偏移 0x7e3f2，换算成 VA 正好是 0x47fdf2，所以 MJ 与零售 v3.11 的数据段布局相同。
2. **两版一致的数据：** 卡片表 30×8 字节（v3.11 在 VA 0x47fdf2）、道具表 13×8 字节（VA 0x47fee2）、开局三张表（总资金 / 期限 / 财富倍率）、12 人角色表。依据是 NU 对 Game 与 MJ 两个 exe 的逐字节比较，结论为“两版各 43 筆完全相同”。
3. **找不到公开的零售 v2.06 与 v3.11 的规则级 exe 对比。** 搜过 MY 的 issues、巴哈、PTT，结果如下：
   - PTT 被 Cloudflare 拦截，没有绕过。
   - 巴哈只提到文件层面的差异：v2.06 独有 `MapDat.mkf`，装 3.11 时必须删掉。
   - 巴哈 FAQ 称 v2.x 主程序有“无法获得公司盈余”的 bug，资料片修正了。这一条**没有经过 exe 验证**。
   - 资料片新增四个关卡：星际、南岛、恐龙、仙剑。
4. **FD 的卡价是 wiki 错误，不是版本差异。** FD 写嫁祸 30、红卡 30、涨价 30、同盟 70；exe 表是 40、50、35、40。以下三个来源的全部 30 张卡价都与 exe 一致：OA 读的 v3.11 表、NU 的 Game 与 MJ 两版表、BH 2019 年的 FAQ 全表。说明书只写功能，不写价格。
5. **因此：** 下文凡是“exe 行为”都指 **v3.11**。v2.06 的代码行为只在“数据表”这一层被证实与 v3.11 相同，其余属于 open question。

## 1. 数据表（两版一致，高可信）

**卡片：卡号 / 名称 / 点券价 / 初始公共池张数**

1 均富 200/1；2 均贫 200/2；3 购地 35/4；4 换地 25/4；5 换屋 20/4；6 转向 20/3；7 改建 15/8；8 拍卖 20/3；9 天使 160/2；10 恶魔 180/1；11 怪兽 60/2；12 拆除 15/5；13 抢夺 25/4；14 停留 20/4；15 冬眠 100/2；16 梦游 25/4；17 陷害 20/4；18 复仇 20/4；19 嫁祸 40/4；20 免费 25/4；21 免罪 25/4；22 送神符 10/3；23 请神符 20/3；24 红卡 50/3；25 黑卡 30/3；26 查税 35/4；27 涨价 35/3；28 查封 35/3；29 同盟 40/2；30 乌龟 70/3。

- 复仇、嫁祸、免费、免罪四张**不能主动使用**，是被动触发。

**道具：名称 / 价 / 池**

机器娃娃 15/10；路障 30/10；地雷 25/10；定时炸弹 25/10；机车 80/10；汽车 150/10；飞弹 100/10；遥控骰子 30/10。以下只能由研究所产出，商店不卖：机器工人 30、时光机 40、传送机 95、工程车 150、核子飞弹 250。

**上限与买卖：**
- 手牌上限 15 张；每种道具背包上限 9 个。
- 卖回价 = trunc(标价×数量×0.9)，来源 NU。

## 2. 逐条裁决（默认 = exe；括号内为开关名）

**a 红卡 / 黑卡**（开关 `redBlackCard: exe | manual3`）
- 使用时把该股的走势字节写成红 `0x20` / 黑 `0x02`，并**立即**按开盘价 ±10% 跳价，即当天涨停或跌停。
- 每次日推进时，先把计数减 1，再算行情；计数仍非 0 就再 ±10%。
- 所以一共 2 次：当天一次 + 下一天一次。下一天如果是星期日、节日或全面停市，计数照样减，但不跳价，实际只有 1 次。
- 再次使用是**覆写**：同色会重置计数并再按开盘价 +10%，不叠加；异色直接改成反向。不是“抵消为 0”。
- 休市日：AI 的判定会拒用；人类打开的选股窗显示“本日休市”，选不了股，卡不消耗。
- 说明书写“涨停板三天、重复使用可相抵消”。`manual3` 模式：当天 + 之后 2 个交易日，异色互相抵消为无效。

**b 神明的财运 / 福运加持：只作用于命运事件**
- 37 个命运事件中有 28 个调用判定函数 0x44b896，新闻事件一个都没调用。
- 读的字段：奖金、罚金读“财运 B”，劫难读“福运 C”。
- 判定规则：数值 >100 必定生效；50 到 100 之间用 rand&1 抛硬币；0 到 50 无效果；<0 反向（奖金作废、罚金加倍、倒霉加倍）。
- 各神明的 B / C 值：

| 神明 | B（财运） | C（福运） |
|---|---|---|
| 小财神 | +100 | 0 |
| 大财神 | +150 | 0 |
| 小福神 | 0 | +100 |
| 大福神 | 0 | +150 |
| 小穷神 | −60 | 0 |
| 大穷神 | −100 | 0 |
| 小衰神 | 0 | −60 |
| 大衰神 | 0 | −100 |
| 天使 | +60 | +60 |
| 恶魔 | −60 | −60 |
| 死神 | −200 | −200 |

- 推论（仅为推断）：说明书说小神“有时”、大神“必定”，只在好神的这套加持机制里成立。

**c 福神 / 衰神 / 财神 / 穷神**（开关 `godsManual`：大福神买地免费 + 小穷神×2）
- **福神：** 大福神买地**照常扣钱**。小福神和大福神的效果完全相同：成功购地、付费建造、升级之后，额外免费加一级（受等级上限），没有概率。
- **衰神、死神：** 小衰神、大衰神、死神附身时，一般的购地、建造、升级**一律**“投资失败”，没有概率。购地卡不受这条限制。
- **过路费（按付款方身上的神算，作用于合并后的总额，设施和企业收费也算，全部必定生效）：**
  - 小财神：⌊toll/2⌋
  - 大财神：免付
  - 小穷神：toll + ⌊toll/2⌋（1.5 倍）
  - 大穷神：×2
- 说明书写的“有时显灵”没有任何来源给出概率数值，不建议实现。
- 附加（只有 OA 一个来源）：土地公附身期间不能买无主地。

**d 工程车**（开关 `engineeringVehicle: exe | manualPassDemolish1`）
- 交通方式变成工程车，只掷 1 颗骰；原来的车退回背包。
- 持续 7 个自己的回合，包括使用当回合；受困的回合也计数。到期恢复原车，原车不在背包就改为步行。
- **只在每回合的最终落点判定：** 落点是住宅或设施、主人不是自己（无主也算）、等级 >0，就把它**拆成 0 级**。拆除清掉连锁店和设施种类，但保留地主，并让地主对你的敌意加 30×物价指数。
- 经过的格子不拆。
- 说明书写的是“走到哪拆到哪、拆一级、七回合”。

**e 定时炸弹**（开关 `timeBombArea: exe | manual3x3`）
- 放在路上时无主。**停在**那一格的人拾取，引信 38 步。
- 携带者每走一步引信减 1。途中与同格的其他在局玩家相遇时，转给其中下标最小、且身上没挂物件的那一位。
- 归零爆炸，**只影响携带者**：座驾报废、住院 5 天、停止移动。所在格的住宅或设施降 1 级（连锁店直接变 0 级；设施降到 0 级时清掉种类）。
- **不是 3×3，也不伤及他人。** 说明书写 3×3，BH 写 9×9（存疑）。
- 送神符能送走身上的炸弹；拆除卡能拆路面上的炸弹。

**f 星期日**（开关 `bankClosedOnHoliday`）
- 股市在星期日和各地图节日表上的日期休市：不跳价、不能买卖，红黑卡计数照扣。新闻“全面停市”写入 10，实际关 11 天。
- **银行不关门**：星期日也能存取、贷款、用柜台。唯一受影响的是贷款到期日：遇到星期日或节日会顺延到营业日。
- 说明书和 BH 写的是银行星期日也休息。

**g 手牌满 15 张**（开关 `handFullPolicy: dropCheapest | playerChoose`）
- 任何得卡途径（卡片格、福神、抢夺、百货赠卡等）在已有 15 张时，都先**自动丢掉手中最便宜的一张**（同价时丢槽位靠前的），新卡一定进手。
- 商店在 15 张时不能买卡。
- 说明书写“必须选择抛弃”；BH 写“自动替换最后一张”。

**h 总资金**
- 可选档位：300000 / 200000 / 100000 / 50000 / 30000 / 10000。
- **首次新局默认第 1 档 = 200000。** “重新开始”沿用上一局的设置。
- oama 复刻里写的 300000，是从存档读出来的玩家选择，不是默认值。
- 开局分配：真人现金和存款各半；电脑按角色的现金比例分配（50/40/70/60/40/70/50/40/60/50/55/80）。
- 总资金同时是物价指数的除数：资金越少，通胀越快。

**i AI 每回合行动**
- 用 `rand()&1` 二选一：用卡（最多 8 张候选，只用第一张通过判定的，≤1 张）或用道具（最多 4 个候选，≤1 个）。两者互斥，并且消耗一次随机数。
- 股票交易每回合都会单独跑，与上面独立。
- AI 从不使用时光机和四张被动卡。

**j 拍卖卡**
- 不选目标，只拍自己**脚下**那一格的住宅或设施，企业不行。自己的地、别人的地、无主的地都能拍。
- 底价 = trunc(地价×(1+等级×0.5))×物价指数。
- **使用者本人不能出价**：MY 中参与者状态码 7 对应使用者本人。以下几类人也不能出价：现金 ≤ 底价，或正处于住宿、消失、坐牢、住院、冬眠、梦游。
- 成交款全部进使用者的存款，原地主拿不到钱。流标则该地变为无主，建筑保留。
- 冲突：NU 的实现保留了使用者一列。

**k 送神符 / 死神**
- 送神符只能送走**自己身上**的小穷神、大穷神、小衰神、大衰神、恶魔、**死神**，以及携带中的定时炸弹（两者可以一张卡同时送走）。好神送不走；什么都没送走时卡不消耗。
- 死神持续 13 天，附身时立即清空全部卡片和道具，不折算点券。附身期间：
  - 自己的地免收租。
  - **别人付过路费时由死神附身者代付**（提示“死神显灵 由X赔偿”）。
  - 不能一般地买地、盖房。
  - 自己付过路费**不加倍**。
  - 命运事件中的罚金、倒霉按上面的加持规则加倍。

**l 经过触发还是停下触发**
- **停下才触发：** 神明、恶犬（步行者住院 3 天，有车则把狗撞跑）、礼物（随机道具）、宝箱（500 点券）、地雷（毁车 + 住院 3 天）、捡起定时炸弹、乞丐（付 1000×物价）。
- **经过就触发：**
  - 路障：移除路障，并截停在该格，该格照常结算。
  - 银行：经过时打开 ATM 存取款；停在银行格还可以贷款。
  - 身上的炸弹：每走一步倒数一次，同格时可转手。
- 17 类落点事件（地产、新闻、命运、卡片格、点券格、乐透、商店、魔法屋、监狱和医院的保释格、小游戏）都只在最终停下时触发。
- 天使、恶魔、土地公的地产效果只作用于落点那一格，不是沿途每一格。

**m 岔路**（开关 `forkChoice: random | playerChoose`，后者是非原版的 house rule）
- 人类和电脑走的是同一段代码。候选格 = 4 个邻接槽，去掉空槽、来的那一格、被封的槽。
- 没有候选就原路返回；有候选就 `rand()%n` 随机选。**没有任何让玩家选路的交互。**
- 8 张地图一共只有 10 个封路位，全在岔路节点上。例如台湾图的两个岔路各封了一条，所以玩家“感觉不到有岔路”。
- 能影响方向的只有转向卡；能决定步数的只有遥控骰子。
- 没有找到实机录像佐证；BH 也说“方向与步数皆乱数”。

## 3. 回合与天数语义（一轮 = 一天）

**3.1 行动游标与“天”（MY 0x418ebd）**

```
endTurn():
  if cur<4 && P[cur].flags&0x30:   # 刚播完“走回棋盘/走进旅馆”动画
     恢复朝向; 天使恶魔土地公落点效果; 工程车落点判定; flags&=0x0f
     return                        # 游标不前进：同一玩家接着进行他的正常回合
  wrapped=false
  loop: cur++; if cur==numPlayers: cur=4; if cur==8: cur=0; wrapped=true
        跳过：不在场的四大恶人槽；已出局玩家
  if wrapped: advanceDay()   # 日期+1 → 胜负判定 → 物价指数(只升) → 停市/停牌/红黑卡减计数
                             # → srand → 行情 → 节日 → 15日分红+乐透 → 跨月利息结算 → 地契到期
  turnStartTick(cur)
```

- 开局时 cur=0；座位 = 选角顺序，固定不随机。
- 一个“天” = 全部在局玩家各走一次 + 在场的四大恶人（槽位 4..7）各走一次。

**3.2 turnStartTick 的顺序（v3.11）**
1. 还款日检查。
2. 住宿、消失、坐牢、住院四个计数：值为 0x80 就释放；否则减 1，减到 0 时写成 0x80。
3. 冬眠、梦游、停留、乌龟、拒贷、停贷、同盟、保险计数：值为 0x80 就清 0；否则减 1，减到 0 时写成 0x80。被关押期间冬眠和梦游暂停倒数。
4. 神明任期：直接减 1，减到 0 神明离开并成对重生。
5. 工程车：值减 4，不够时还原原车。
6. 研究所倒数。

- 判定“受影响”的条件：计数 ≠ 0（包括 0x80）。
- 状态框显示剩余天数 =（raw&0x7f）+1，含本回合。

**3.3 各状态的实际效果**

| 状态 | 写入值 | 实际效果 |
|---|---|---|
| 坐牢、住院 N 天 | 陷害他人 5，陷害自己（被嫁祸回来）4；命运酒醉 3 或 6；新闻超贷 5；恶犬、地雷、飞弹、核弹 3；炸弹 5；魔法屋 3 | 之后 N 个自己回合被跳过。第 N+1 个自己回合开头释放：先播从绿岛或医院大楼走回监狱或医院格的动画，**同一回合继续正常行动**。重复入狱时新值 =（旧值+新天数）&0x7f，可能回绕成 0。 |
| 停留卡 | 他人 1，自己 0x80 | 双方都**少走 1 次**：自己是本回合，他人是其下一个回合。按“前进”之前的卡、道具、股市操作仍可做；落点事件不重新触发（只有 OA 一个来源）。 |
| 乌龟卡 | 他人 3，自己 2 | 双方都是 **3 次“只走 1 步”**，自己的 3 次含本回合。走这一步不掷骰；已设定的遥控骰子点数保留到之后使用。 |
| 冬眠卡 | 所有其他未被关押的存活玩家 5 | 每人跳过 5 个自己回合，并取消其梦游。 |
| 梦游卡 | 他人 5，自己 4 | 期间强制步行、1 颗骰子乱走，不能买地、盖房、用卡，也不能收租。 |
| 神明 | 7，死神 13 | 附身当回合 + 之后 6 个回合（死神 + 12 个），第 7 个（死神第 13 个）自己回合一开始就离开。受困期间照样倒数。 |
| 工程车 | — | 使用当回合 + 之后 6 个回合，共 7 个回合。 |
| 同盟 | 7 | 按两段式计数倒数。 |

**3.4 “施加在自己身上时少写 1”的规律**
- 陷害 4 对 5、梦游 4 对 5、乌龟 2 对 3、停留 0x80 对 1，都是同一个规律：当前行动者已经在用本回合，本回合算第 1 天。
- 这样施卡者与后行座位的受害者会在同一天回到棋盘。这是推断。

**3.5 受困期间能做什么**
- 整个回合被跳过（弹框 1.5 秒后直接换人），不能主动用卡、道具、股市、银行。
- 被动卡（免罪、嫁祸、复仇、免费）照常触发。
- 被关押或冬眠、梦游的地主不能收租。

**3.6 真人每回合最多用几张卡**
- exe 里没有找到次数上限，只要求在按“前进”之前使用；卡和道具都能多次用。
- 建议提供房间开关 `maxCardsPerTurn`，默认不限。
- AI 每回合最多 1 张卡或 1 个道具。

## 4. 房间配置建议（默认值 = exe）

```json
{"rulesPreset":"exe","startFund":200000,"redBlackCard":"exe","godsManual":false,
 "engineeringVehicle":"exe","timeBombArea":"exe","bankClosedOnHoliday":false,
 "handFullPolicy":"dropCheapest","auctionCasterMayBid":false,"forkChoice":"random",
 "maxCardsPerTurn":null,"maxToolsPerTurn":null}
```

`rulesPreset:"manual"` 会同时切换：`redBlackCard=manual3`、`godsManual=true`、`engineeringVehicle=manualPassDemolish1`、`timeBombArea=manual3x3`、`bankClosedOnHoliday=true`、`handFullPolicy=playerChoose`。

## 5. 实现时最该对照的文件
- github.com/mytbk/rich4 asm/rich4.asm：0x418ebd 换人、0x40c05c 走子与岔路、0x448a7e 工程车落点、0x40fa61 衰神禁买。
- github.com/mytbk/rich4 asm/rich4_player_core_actions.asm：0x41b42d 逐步处理（物件、炸弹、银行、乞丐）。
- github.com/oama1111/rich4-spec docs/systems/cards.md、gods.md、places.md、stocks.md（§7）。
- github.com/nurockplayer/richman4-remake docs/original-oddities.md、original-statuses.md、original-engineering-vehicle.md、original-road-hazards.md。
- github.com/oama1111/rich4-remake-public packages/core/src/state/reduce.ts、rules/toll-flow.ts、rules/object-landing.ts。

## entries
- **版本基线：v2.06 与 v3.11** [版本] (medium) MY 与 OA 的逆向对象都是零售 v3.11（588 KiB）。NU 另有 Steam 系的 Game 和 MultiverseJourney 两个 exe，其卡表、道具表、开局表、角色表两版逐字节相同；MJ 的卡表文件偏移 0x7e3f2 正好对应 VA 0x47fdf2。找不到公开的零售 v2.06 与 v3.11 规则级 exe 对比。已知差异只有：v2.06 独有 MapDat.mkf；资料片加了 4 张地图；巴哈称 v2.x 有“拿不到公司盈余”的 bug，资料片修正（未经 exe 验证）。实现时以 v3.11 为基线。 | 数值: mytbk rich4.exe SHA256 前缀 5a90aee2；NU Game SHA256 前缀 110b29f9，MJ 前缀 50cb24bb；卡表 VA 0x47fdf2（Game 文件偏移 0x7c152 / MJ 文件偏移 0x7e3f2），道具表 VA 0x47fee2 | src: https://github.com/mytbk/rich4/blob/master/readme.rst, https://github.com/oama1111/rich4-spec/blob/main/README.md, https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-inventory.md
- **卡价：Fandom 与 exe 的差异裁决** [数据表] (high) Fandom 的 嫁祸30 / 红卡30 / 涨价30 / 同盟70 是 wiki 错误，不是版本差异。v3.11 exe 表、NU 的 Game 与 MJ 两版表、巴哈 2019 FAQ 的全部 30 张卡价三者一致：嫁祸40 / 红卡50 / 涨价35 / 同盟40。说明书不列价格。 | 数值: 30 张卡价见 overview §1；手牌上限 15；每种道具上限 9；卖回价 ×0.9 | src: https://github.com/oama1111/rich4-spec/blob/main/docs/systems/cards.md, https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-inventory.md, https://forum.gamer.com.tw/C.php?bsn=972&snA=2070
- **a 红卡 / 黑卡 的天数与重复使用** [卡片] (high) exe：写入走势字节（红 0x20 / 黑 0x02），并立刻按开盘价 ±10% 跳价（当天涨停或跌停）。每次日推进先把半字节减 1，再算行情；仍非 0 就再 ±10%。所以一共 2 次：当天 + 下一天；下一天若休市，计数照减但不跳价。重复使用是覆写：同色重置计数，异色改方向，不是抵消为 0。休市日：AI 拒用，人类选不了股，卡不消耗。说明书与巴哈写“涨/跌停三天、重复使用可相抵消”，做成开关 redBlackCard=manual3。仅在 v3.11 上验证过。 | 数值: ±10%（常量 0x41200000）；红 0x20→0x10→0，黑 2→1→0；日推进顺序：先减计数（0x41cffb），再算行情（0x41d076） | src: https://github.com/oama1111/rich4-spec/blob/main/docs/systems/stocks.md, https://github.com/oama1111/rich4-spec/blob/main/docs/systems/cards.md, https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-inventory.md
- **b 神明的财运/福运加持：只作用于命运** [神明/事件] (high) 判定函数 0x44b896 的 15 处直接调用全在命运代码里，加上 2 条共享尾，共覆盖 28 个命运事件；新闻代码中为 0 处。奖金、罚金读财运 B（玩家 +0x46），劫难读福运 C（+0x48）。规则：>100 必定生效；50 到 100 用 rand&1；0 到 50 无效果；<0 反向。“汽车超速罚款”一条原版就没有接上加持。 | 数值: B/C：小财+100/0，大财+150/0，小福0/+100，大福0/+150，小穷−60/0，大穷−100/0，小衰0/−60，大衰0/−100，天使+60/+60，恶魔−60/−60，死神−200/−200 | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_fortune.asm, https://github.com/mytbk/rich4/blob/master/asm/rich4_news.asm, https://github.com/oama1111/rich4-spec/blob/main/docs/systems/fortune.md
- **c 福神 / 衰神 / 财神 / 穷神 的持续效果** [神明] (high) exe：大福神买地照常扣钱。小福神与大福神效果相同：成功购地、建造、升级后白送 1 级，没有概率（fcn_0040f8be 中 rand 只用来选台词）。小衰神、大衰神、死神附身时，一般的购地、建造、升级一律失败，没有概率（fcn_0040fa61），购地卡除外。过路费按付款方身上的神调整：小财 ⌊½⌋、大财 0、小穷 toll+⌊toll/2⌋、大穷 ×2，同样没有概率。说明书写“大福神买地免费”“小衰神、小穷神有时显灵”“小穷神租金加倍”；巴哈写小穷神“加半倍”，与 exe 一致。开关 godsManual。“有时”的概率没有任何来源给出数值。 | 数值: 小穷神 999→1498；神明持续 7 天 | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_gods.asm, https://github.com/mytbk/rich4/blob/master/asm/rich4.asm, https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-gods.md
- **d 工程车** [道具] (medium) exe：交通方式变 0x1f，只掷 1 颗骰，原车退回背包。每个自己回合开始时值减 4，共 7 个自己回合（含使用当回合、含受困回合），到期恢复原车或改为步行。只在每回合的最终落点判定（0x448a7e，调用点在落点尾块和释放后回棋盘）：落点是住宅或设施、主人不是自己（无主也算）、等级>0，就执行 0x40ab4a(格, 2)，拆成 0 级（清连锁店和设施种类，保留地主），地主对你敌意 +30×物价。经过的格子不拆。说明书写“走到哪拆到哪、拆一级、开七回合就报废”。开关 engineeringVehicle。OA 的规格误把 0x448a7e 标成“步行”，且未发现拆除效果，属于未解条目。 | 数值: 7 回合；1 颗骰；拆到 0 级；敌意 30×物价；加油站费用倍率 4 | src: https://github.com/mytbk/rich4/blob/master/asm/rich4.asm, https://github.com/mytbk/rich4/blob/master/asm/rich4_player_utils.asm, https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-engineering-vehicle.md
- **e 定时炸弹的范围** [道具] (high) exe：停下时拾取，引信 38 步；每走一步减 1；与同格的在局玩家相遇时转给其中下标最小、身上没挂物件者。归零爆炸只处理携带者：毁车、住院 5 天、停止移动，所在格建筑降 1 级（mode 0：连锁店变 0 级；设施到 0 级时清种类）。没有 3×3 范围，不影响其他玩家。说明书写 3×3、“车毁屋塌人住院五天”；巴哈写 9×9（存疑）。开关 timeBombArea。 | 数值: 引信 38 步（0x26）；住院 5 天；建筑 −1 级 | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_player_core_actions.asm, https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-road-hazards.md, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/object-landing.ts
- **f 星期日与节日** [日历/银行/股市] (medium) exe：股市在星期日（wday==0）和各地图的 24 项节日表日期休市：不跳价、不能买卖，停市、停牌、红黑卡计数照扣。银行在星期日不关门：0x4523d5 只被股市、日历绘制、贷款到期日三处调用；贷款到期日遇星期日或节日顺延。说明书与巴哈写银行也休息。开关 bankClosedOnHoliday，默认 false。“银行不关门”是根据代码中找不到相关检查得出的。 | 数值: 新闻全面停市写入 10，实际关 11 天；贷款期 90 天 | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_ui_bank.asm, https://github.com/mytbk/rich4/blob/master/asm/rich4_stocks.asm, https://github.com/oama1111/rich4-spec/blob/main/docs/systems/stocks.md
- **g 手牌满 15 张** [卡片] (high) exe（add_card 0x4412e4）：已有 15 张时先自动移除手中价格最低的一张（价格相同取槽位靠前的），新卡一定入手；商店在 15 张时不能买卡。说明书写“必须选择抛弃”（由玩家选）；巴哈写“自动替换最后一张”。开关 handFullPolicy，默认 dropCheapest。 | 数值: 上限 15；最低价比较初值 10000 | src: https://github.com/oama1111/rich4-spec/blob/main/docs/systems/cards.md, https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-inventory.md, https://forum.gamer.com.tw/C.php?bsn=972&snA=2070
- **h 总资金默认值** [开局] (high) 开局表为 300000 / 200000 / 100000 / 50000 / 30000 / 10000。首次新局 dw_46cb40=1，即默认 200000；“重新开始”沿用本局设置。oama 复刻 setup.ts 写的 300000 取自存档里玩家选的值，不是默认值。真人现金、存款各半，电脑按角色比例；总资金同时是物价指数的除数。其余默认：4 人、步行、土地永久持有、期限无限、胜利条件无（与说明书一致）。 | 数值: 默认 200000；期限表 0/730/365/182/91/30；倍率表 0/100/50/10/5/3 | src: https://github.com/mytbk/rich4/blob/master/csrc/game_init.c, https://github.com/nurockplayer/richman4-remake/blob/main/docs/calendar-and-setup.md, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/setup.ts
- **i 电脑每回合用卡、用道具** [AI] (high) exe（0x418e18）：每回合先做股票交易，再用 rand()&1 二选一：奇数走用卡（最多 8 张候选，只用第一张通过判定的，≤1 张），偶数走用道具（最多 4 个候选，≤1 个）。两者互斥，并且消耗一次随机数。AI 从不用时光机，也不主动用 4 张被动卡。 | 数值: 卡候选 8，道具候选 4 | src: https://github.com/mytbk/rich4/blob/master/asm/rich4.asm, https://github.com/oama1111/rich4-spec/blob/main/docs/systems/game-loop.md, https://github.com/oama1111/rich4-spec/blob/main/docs/systems/ai.md
- **j 拍卖卡的目标与参与者** [卡片] (medium) exe：不选目标，只拍脚下那一格的住宅或设施，企业不行。自己的地、别人的地、无主的地都可以拍。底价 = trunc(地价×(1+等级×0.5))×物价。使用者本人不能出价（参与者状态码 7）；现金 ≤ 底价、住宿、消失、坐牢、住院、冬眠、梦游者也不能出价。成交款进使用者存款，原地主不收钱；流标则变为无主、建筑保留。说明书与 Fandom 也写“使用卡片者不参与”；NU 的实现保留了使用者一列，属于冲突。开关 auctionCasterMayBid，默认 false。 | 数值: 加价档 100 / 500 / 1000 / 5000 / 10000（来自 NU） | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_ui_auction.asm, https://github.com/oama1111/rich4-spec/blob/main/docs/systems/cards.md, https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-auctions.md
- **k 送神符与死神** [神明/卡片] (high) 送神符只能送走自己身上的 {小穷、大穷、小衰、大衰、恶魔、死神} 和携带中的炸弹，一张卡可同时处理；好神送不走；什么都没送走时卡不消耗。死神 13 天，附身时清空全部卡片和道具，不折算点券。附身期间：自己的地免收租；别人付过路费时由死神附身者代付（_rich4_find_other_death_attached_player，住宅 / 设施 / 企业三处调用）；不能一般购地、建造；自己付过路费不加倍；命运罚金、倒霉加倍。死神的来源：魔法屋诅咒、认输投降。 | 数值: 13 天；送神白名单种类 {5,6,7,8,10,15} | src: https://github.com/oama1111/rich4-spec/blob/main/docs/systems/gods.md, https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-gods.md, https://github.com/mytbk/rich4/blob/master/asm/rich4_player_core_actions.asm
- **l 经过触发还是停下触发** [移动] (high) exe：逐步处理函数 0x41b42d 里，神明、恶犬、礼物、宝箱、地雷、炸弹拾取、乞丐都要求剩余步数 [0x48baf8]==0，即停下才触发。路障在途中触发：移除并截停。银行在途中触发 ATM。身上的炸弹每步倒数、同格可转手。17 类落点事件（含卡片格）只在停下时触发。天使、恶魔、土地公只作用于落点那一格。 | 数值: 恶犬、地雷住院 3 天；宝箱 500 点券；乞丐 1000×物价 | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_player_core_actions.asm, https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-road-hazards.md, https://github.com/oama1111/rich4-spec/blob/main/docs/systems/tools.md
- **m 岔路选路** [移动] (high) exe（0x40c05c，loc_0040c196）：人类和电脑用同一段代码。候选 = 邻接槽，去掉空槽、来的那一格、封路位；没有候选就原路返回，有候选就 rand()%n。没有任何让玩家选路的交互。8 张地图共 10 个封路位，全在岔路节点。能影响方向的只有转向卡。没有找到实机录像；巴哈 FAQ 称“方向与步数皆乱数”。开关 forkChoice，默认 random；playerChoose 是非原版的 house rule。 | 数值: 4 个邻接槽；封路位 bit(30−slot) | src: https://github.com/mytbk/rich4/blob/master/asm/rich4.asm, https://github.com/oama1111/rich4-spec/blob/main/docs/systems/map-format.md, https://github.com/oama1111/rich4-remake-public/blob/main/docs/known-deviations.md
- **三-1 回合、天与行动顺序** [回合] (high) 游标顺序：玩家 0..n−1 → 四大恶人槽 4..7 → 回到 0 时推进一天（日期、胜负、物价、计数、行情、节日、15 日分红与乐透、跨月结算、地契），然后对新的当前者执行 turnStartTick。开局 current=0；座位 = 选角顺序，不随机；出局者跳过。说明书写明“每一个人物都前进过一回合便算一天”。 | 数值: 8 个行动位 | src: https://github.com/mytbk/rich4/blob/master/asm/rich4.asm, https://github.com/mytbk/rich4/blob/master/csrc/game_init.c, https://github.com/oama1111/rich4-spec/blob/main/docs/systems/stocks.md
- **三-2 坐牢/住院 N 天实际缺席几回合** [回合] (medium) 计数在自己回合开始时递减：N→…→1→0x80，这 N 个回合都被跳过。第 N+1 个回合遇到 0x80 就释放：先播走回监狱或医院格的动画。MY 的 0x418ebd 在这种受阻分支里不推进游标，所以同一玩家接着进行正常回合，实际缺席 N 个回合。NU 的实现相同：释放后当回合就掷骰。状态框显示（raw&0x7f）+1，也与 N 吻合。OA 的 places.md 认为缺席 N+1，但它自己也写了“不推进游标”，属于冲突。重复入狱时（旧值+新天数）&0x7f。 | 数值: 陷害他人 5 / 自己 4；酒醉 3（或 6）；超贷 5；狗、雷、飞弹、核弹 3；炸弹 5；魔法屋 3 | src: https://github.com/mytbk/rich4/blob/master/asm/rich4.asm, https://github.com/nurockplayer/richman4-remake/blob/main/game/core/game_state.gd, https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-statuses.md
- **三-3 停留卡与乌龟卡的回合数** [回合/卡片] (high) 停留卡：自己写 0x80，他人写 1。计数在回合开始时先把 0x80 清零再减 1；走子闸门 0x4012a7 / 0x40dd1f 判断 ≠0 就不走。结果双方都少走 1 次：自己是本回合，他人是其下一个回合，且不重新触发落点。乌龟卡：自己写 2，他人写 3；≠0 时本回合只走 1 步且不掷骰。结果双方都是 3 次“1 步”，自己的含本回合。数值在 mytbk 的卡片汇编中逐一核对过。 | 数值: 停留 0x80 / 1；乌龟 2 / 3；显示天数 =（raw&0x7f）+1 | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_card_tingliuka.asm, https://github.com/mytbk/rich4/blob/master/asm/rich4_card_wuguika.asm, https://github.com/oama1111/rich4-spec/blob/main/docs/systems/cards.md
- **三-4 被嫁祸回到自己身上为何是 4 天** [回合] (medium) 陷害（mytbk 汇编：最终目标==施卡者时 push 4，否则 push 5）和梦游都是自己 4、他人 5。乌龟 2 对 3、停留 0x80 对 1，也是同一规律：当前行动者的本回合算作第 1 天，这样施卡者与后行座位的受害者会在同一天回到棋盘。这一解释是推断。 | 数值: 4/5、2/3、0x80/1 | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_card_xianhaika.asm, https://github.com/oama1111/rich4-spec/blob/main/docs/systems/places.md, https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-sleep-cards.md
- **三-5 神明 7 天与冬眠 5 天何时递减** [回合] (medium) 两者都在持有者或受害者自己回合开始时（0x41c84f）递减。神明是直接减 1，到 0 立即离开并成对重生：有效期 = 附身当回合 + 之后 6 个回合（死神 13 天对应 + 12 个回合），受困期间照样倒数。冬眠用两段式计数，受影响的是所有其他未被关押的存活玩家，各跳过 5 个回合；被关押期间暂停倒数；冬眠会取消梦游。工程车共 7 个回合；同盟 7 天，两段式计数。 | 数值: 神 7 / 死神 13；冬眠 5；梦游 5 或 4；同盟 7 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/object-landing.ts, https://github.com/oama1111/rich4-spec/blob/main/docs/systems/gods.md, https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-gods.md
- **三-6 受困期间的操作与每回合出卡数** [回合] (low) 被关押、冬眠的回合被整体跳过（弹框 1.5 秒后换人），不开放主动卡、道具、股市、银行；被动卡照常触发；这些地主不收租。人类出卡：exe 里没有找到每回合次数上限，只能在按“前进”之前使用，卡和道具都可多次。AI 每回合 ≤1 张卡或 ≤1 个道具。建议提供房间开关 maxCardsPerTurn，默认不限。 | 数值: — | src: https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-statuses.md, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/state/reduce.ts, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/toll-flow.ts

## open_questions
- 零售 v2.06 与 v3.11 的 rich4.exe 还没有人做过规则级 diff。红卡天数、神明、银行星期日、工程车等在 v2.06 里是否与说明书一致，目前未知。需要取得 v2.06 exe 后对 0x444f25 / 0x40f8be / 0x448a7e / 0x41b697 等位置做对比。
- NU 的 Game（本体）exe 对应哪个补丁版本（2.00 / 2.02 / 2.06 还是 Steam 重建），版本号未能确认。
- 被关押者释放当回合能否立即行动：MY 反汇编和 NU 的实现都是能行动（缺席 N 回合），OA 的 rich4-spec 认为不能（缺席 N+1 回合）。需要实机录像确认。
- 拍卖卡使用者能否竞拍：MY 的参与者状态码 7 表示不能，说明书和 Fandom 也写不能；NU 的实现文档写“保留施卡者列”。需要看实机录像或逐条读完 0x43bde5。
- 卡片格是经过就领卡还是停下才领：exe 的落点分派表显示只在停下时；NU 对说明书第 18–19 页的解读是经过即可领。说明书 OCR 该段残缺。
- 定时炸弹转手的条件：OA 称 +0x15 只对当前回合行动者非 0，因此几乎不会转手；但 MY 的乞丐逻辑用 +0x15==0 判定出局者，说明它是“在局”标志。需要实测。
- 说明书写的“有时显灵”（小福神、小衰神、小穷神）在 exe 的持续效果里没有概率；除命运加持的 50~100 区间外，没有任何来源给出概率数值。
- 停留卡用在自己身上时，是否会重新触发当前格的落点事件（例如再次加盖）：只有 OA 的复刻代码认为不会，需要实机确认。
- 人类能否在别人的回合或自己受困期间，用快捷键打开股市交易：NU 注明未知。
- 巴哈 FAQ 称 v2.x 有“无法获得公司盈余”的 bug、资料片已修正，以及“旅馆企业无效果”：两条都未经 exe 验证。
- 岔路随机、红黑卡实际天数、工程车只在落点拆除：没有找到公开的原版实机录像佐证。

## sources
- https://archive.org/download/Richman-4-Manual/%E5%A4%A7%E5%AF%8C%E7%BF%814%E8%AA%AA%E6%98%8E%E6%9B%B8_djvu.txt
- https://github.com/mytbk/rich4/blob/master/readme.rst
- https://github.com/mytbk/rich4/issues
- https://github.com/mytbk/rich4/blob/master/csrc/game_init.c
- https://github.com/mytbk/rich4/blob/master/asm/rich4.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_player_core_actions.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_player_utils.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_gods.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_fortune.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_news.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_ui_bank.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_ui_auction.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_ai_use_card.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_stocks.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_card_tingliuka.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_card_wuguika.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_card_xianhaika.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_card_mengyouka.asm
- https://github.com/oama1111/rich4-spec/blob/main/README.md
- https://github.com/oama1111/rich4-spec/blob/main/docs/systems/cards.md
- https://github.com/oama1111/rich4-spec/blob/main/docs/systems/game-loop.md
- https://github.com/oama1111/rich4-spec/blob/main/docs/systems/places.md
- https://github.com/oama1111/rich4-spec/blob/main/docs/systems/gods.md
- https://github.com/oama1111/rich4-spec/blob/main/docs/systems/stocks.md
- https://github.com/oama1111/rich4-spec/blob/main/docs/systems/fortune.md
- https://github.com/oama1111/rich4-spec/blob/main/docs/systems/data-tables.md
- https://github.com/oama1111/rich4-spec/blob/main/docs/systems/tools.md
- https://github.com/oama1111/rich4-spec/blob/main/docs/systems/ai.md
- https://github.com/oama1111/rich4-spec/blob/main/docs/systems/bank.md
- https://github.com/oama1111/rich4-spec/blob/main/docs/systems/map-format.md
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/setup.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/cards/stay.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/cards/tortoise.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/toll-flow.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/object-landing.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/blessing.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/state/reduce.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/data/src/event-table.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/docs/audit-gods-text-vs-effect.md
- https://github.com/oama1111/rich4-remake-public/blob/main/docs/known-deviations.md
- https://github.com/nurockplayer/richman4-remake/blob/main/docs/calendar-and-setup.md
- https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-inventory.md
- https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-statuses.md
- https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-gods.md
- https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-engineering-vehicle.md
- https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-road-hazards.md
- https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-sleep-cards.md
- https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-oddities.md
- https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-auctions.md
- https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-fate.md
- https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-news.md
- https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-companies.md
- https://github.com/nurockplayer/richman4-remake/blob/main/docs/manual-rules.md
- https://github.com/nurockplayer/richman4-remake/blob/main/game/core/game_state.gd
- https://richman.fandom.com/zh/wiki/%E5%A4%A7%E5%AF%8C%E7%BF%814/%E5%8D%A1%E7%89%87%E4%B8%80%E8%A6%BD
- https://forum.gamer.com.tw/C.php?bsn=972&snA=2070
- https://forum.gamer.com.tw/C.php?bsn=972&snA=2175
- https://forum.gamer.com.tw/C.php?bsn=972&snA=2227
- https://zh.wikipedia.org/wiki/%E5%A4%A7%E5%AF%8C%E7%BF%814
- https://store.steampowered.com/app/2093880/Richman_4__Multiverse_Journey/