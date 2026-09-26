# 大富翁4：特殊格子与随机事件规格

> **版本**：只讲原版《大富翁4》（1998，PC，v3.x）。凡是出自《大富翁4 Fun》或其他代的资料，都另外标注。
> **资料来源分级**：
> - **[EXE]**：来自对 `rich4.exe` 的逆向。数据取自开源复刻项目 oama1111/rich4-remake-public，里面的事件文案、系数、跳表都标了原版虚拟地址（VA）。这是第三方逆向，但可信度最高。
> - **[截图]**：百度贴吧玩家 2013 年实机截图整理的帖子。
> - **[百科/攻略]**：萌娘百科、Fandom/维基、B站、cr173、百度经验、网易号、巴哈姆特等。
>
> 下文所有 **“×p”** 表示乘以当前 **物价指数**。物价指数 = 所有玩家总资产 ÷ 初始总资产，开局为 1。

---

## 0. 地图特殊格总表（落点跳表共 17 种）[EXE，与百科互证]

原版“停下来”时的处理函数是一张 17 项的跳表（VA 0x4197e9），索引就是格子的 `specialKind`：

| kind | 格子 | 停下时的效果 | 路过时 |
|---|---|---|---|
| 0 | 普通地产/公司 | 走地产流程（买地、盖房、过路费） | — |
| 1 | 公园 PARK | **什么都不发生**（纯安全落脚点） | 无 |
| 2 | 新闻 NEWS | 从 36 张新闻牌堆抽 1 张，可能影响个人、区域或全体 | 无 |
| 3 | 命运 “？” | 从 37 张命运牌堆抽 1 张，只作用于自己 | 无 |
| 4 | 监狱 | 若有人在押：可花点券保释。玩家 30 点，小偷或强盗 300 点 | 无 |
| 5 | 医院 | 若有人住院：可花点券保释。玩家 30 点，流氓或间谍 300 点 | 无 |
| 6 | 企鹅挖宝（小游戏） | 玩小游戏得点券 | 无 |
| 7 | 七彩气球（小游戏） | 同上 | 无 |
| 8 | 喜从天降（小游戏） | 同上 | 无 |
| 9 | 乐透彩券行 | 花 1000 元买 1 个号码 | 无 |
| 10 | 得 50 点 | 点券 +50 | 无 |
| 11 | 得 30 点 | 点券 +30 | 无 |
| 12 | 得 10 点 | 点券 +10 | 无 |
| 13 | 卡片 CARD | 随机得 1 张卡 | 无（EXE 显示只在停下时触发） |
| 14 | 银行 BANK | 先 ATM（存款/取款），再柜台（贷款、还款或特别融资，三选一） | **有：ATM 存取款** |
| 15 | 百货公司 On sale | 用点券买卖卡片和道具；控股者进店时随机获赠 1 件 | 无 |
| 16 | 魔法屋 | 女巫转盘，选出一类人并对他们施法 | 无 |

**原版没有的格子**：机会、税务格、传送点、起点奖金格都不存在（跳表只有以上 17 种）。
- “传送机”是研究所造的道具。
- “所得税/地价税/证交税”只以新闻事件的形式出现。
- 旅馆、购物中心、加油站、研究所是大块商业用地上盖的设施；保险、电脑、航空、建设等是上市公司。它们都属于地产或公司，不是特殊格。

### 0.1 路过（不停留）就会触发的东西 [EXE]

走子过程中，每走一格都会跑一次“逐格处理”（VA 0x41b42d）。**真正路过就生效的只有三样**：

1. **银行格：弹出 ATM，可存款或取款。**
   - 条件：还有剩余步数，没在梦游，并且银行格上没放路障。
   - 若玩家正被“拒绝往来”：只弹一个提示框（约 1000ms）。
   - 真人：弹模态 ATM 窗，办一笔或关窗后继续走。
   - 电脑：按自己的现金/存款比例自动重新分配。
2. **路障：唯一会在半路拦人的物件**，把你当场拦停。
3. **身上的定时炸弹**：超过其他玩家时可以转给对方。

其余东西**都要停下来才生效**：新闻、命运、乐透、卡片、得点格、小游戏、监狱/医院探视、魔法屋、百货公司、公园、宝箱、礼物、地雷、恶犬、神明附身、乞丐施舍。

- 注意：萌娘百科写地雷“任意人经过即爆炸”。但 EXE 里的地雷分支带 `if (moving) return`，也就是只在停下时引爆。cr173 攻略也写的是“停留在放有地雷的路上”。
- 萌娘和维基写监狱/医院/乐透是“经过”时触发。但 EXE 里这三个都挂在停下时的跳表上。网易号攻略写的是“进去可以选择”，与 EXE 一致。

---

## 1. 新闻（NEWS）

### 1.1 抽取机制 [EXE]

- **开局洗一次牌**：36 个新闻编号被随机排成一副牌，之后用游标依次抽。
- **抽到当前不可行的事件**：直接跳过，但游标照样前进。例如“无人在押”时抽到“无罪开释”。
- **抽到底就回到开头**，不会重新洗牌。所以每一轮 36 张里，每张最多出现一次。
- **命运牌堆机制相同**，只是有 37 张。百度经验上的“命运排列顺序解析”列出了固定顺序，正好印证这一点。
- **新闻不受神明加持影响**。EXE 里只有命运事件会查加持。萌娘说天使/福神能躲过新闻住院，与 EXE 不符，见“待确认问题”。
- 文案：`%s` 是地名、公司名或人名，“×p”表示乘物价指数。

### 1.2 新闻完整列表（36 项，按 EXE 编号）

| # | 原文（BIG5 繁体） | 效果 | 数值 | 可行条件 |
|---|---|---|---|---|
| 0 | 獄中囚犯無罪開釋 | 所有在押**玩家**立即获释 | — | 有玩家在押 |
| 1 | 獄中囚犯延長刑期3天 | 所有在押玩家刑期 +3 天 | +3 天 | 有玩家在押 |
| 2 | 住院中病患提前出院 | 所有住院玩家立即出院 | — | 有玩家住院 |
| 3 | 住院中病患延長住院3天 | 所有住院玩家 +3 天 | +3 天 | 有玩家住院 |
| 4 | 外星人攻打地球 | 随机选一处已建房的地块或设施作爆心，打一发“重击”：范围内房屋和设施受损、交通工具被毁，**被炸到的人住院 3 天**。不记敌意 | 半径 100 像素方窗（截图帖说约 3 格）；住院 3 天 | 场上有房屋 |
| 5 | 外星怪獸襲擊%s 摧毀建築一棟 | 随机选一处已建房的地块或设施，**整栋清除**。EXE 显示地主归属也会被清空 | — | 场上有房屋 |
| 6 | %s公告地價調漲30% | 随机选一块地：**同名路段所有地块**的地价 ×1.3。若选中设施，只改那一处 | ×1.3（取整） | 恒可 |
| 7 | 公開拍賣%s 公有土地一處 | 随机一块**无主**地或设施，立即开拍卖（无卖家） | 起拍价按拍卖规则 | 有无主地 |
| 8 | 公開表揚第一大地主 %s獲得%d元獎勵 | 土地+设施数最多者得奖金，进现金；并列时取第一个 | **10000×p** | 有人有地 |
| 9 | 公開補助土地最少者 %s獲得%d元補助 | 土地数最少者得补助；并列时取最后一个 | **5000×p** | 有人有地 |
| 10 | 公開表揚股市第一大戶 %s獲得%d元獎勵 | 持股总数最多者得奖金 | **10000×p** | 有人持股 |
| 11 | 所有人繳交所得稅5% | 每人交**现金**的 5%，进公库（即乐透奖池） | 现金×5%，不乘 p | 恒可 |
| 12 | 所有人繳交地價稅5% | 每人交房地产价值的 5%，进公库。房地产价值 = Σ(地价 + 等级×房价) | 价值×5%，取整后 ×p | 有人有地 |
| 13 | 所有人繳交證交稅5% | 每人交持股市值的 5%，进公库 | 市值×5%×p | 有人持股 |
| 14 | %s房屋鬧鬼 地價下跌30% | 与 #6 对称：同名路段地价 ×0.7 | ×0.7 | 恒可 |
| 15 | %s一處民宅瓦斯爆炸 房屋失火 | 随机一块**已建房的住宅用地**拆房。土地不会丢失（截图帖佐证） | — | 场上有房屋 |
| 16 | 豪雨特報 行人休息一回合 | 所有步行的玩家停 1 回合 | 1 回合 | 有人步行 |
| 17 | 交通阻塞 汽車停止一回合 | 所有骑机车或开汽车的玩家停 1 回合（截图帖确认机车也停） | 1 回合 | 有人乘车 |
| 18 | %s強烈地震房屋倒塌 | 随机选一处：同名路段所有地块房屋 −1 级（商业用地清为空地）；若选中设施则只改那一处 | −1 级 | 恒可 |
| 19 | %s山洪爆發土地流失 | 随机一块地或设施被完全清除，**土地变回无人购买状态** | — | 恒可 |
| 20 | 超級颱風侵襲%s 多處房屋受損 | 以随机一处为中心的范围伤害：住宅和设施 −1 级，**不伤人** | 半径 100 像素方窗 | 恒可 |
| 21 | 龍捲風侵襲%s 摧毀房屋一棟 | 随机一处拆房 | — | 恒可 |
| 22 | 銀行擠兌停止放款15天 | 全体玩家 15 天内不能贷款，ATM 只能存不能取 | 15 天 | 恒可 |
| 23 | 銀行加發10%儲金紅利 | **没有贷款的**玩家得存款 10%，**直接进存款** | 存款×10% | 恒可 |
| 24 | 股市低迷不振重挫崩盤 | 12 支股票全部标记利空（跌停）1 天，并立即重算股价 | 效果相当于“超级黑卡” | 恒可 |
| 25 | 股市氣勢如虹全面上漲 | 12 支股票全部标记利多（涨停）1 天 | 效果相当于“超级红卡” | 恒可 |
| 26 | 股市暫停交易10天 | 全股市休市 | 10 天（EXE 实现上约 11 天） | 恒可 |
| 27 | %s股票暫停交易10天 | 随机 1 支股票停牌，股价冻结在开盘价 | 文案写 10 天，EXE 的立即数是 15 | 恒可 |
| 28 | %s股票恢復上市交易 | 随机 1 支停牌股复牌 | — | 有停牌股 |
| 29 | %s違法超貸 經營者%s坐牢5天 | 随机一家**有主的上市公司**，其董事长坐牢。可以被免罪卡或嫁祸卡抵挡 | 坐牢 5 天 | 有有主企业 |
| 30 | %s工廠排放污水 罰款10000元 | 随机一家公司的盈余 −10000，该股利空 3 天 | 10000（**不乘 p**，由公司承担并影响股东分红） | 恒可 |
| 31 | %s海外投資 獲利20000元 | 公司盈余 +20000，利多 3 天 | 20000 | 恒可 |
| 32 | %s海外投資 虧損20000元 | 公司盈余 −20000，利空 4 天 | 20000 | 恒可 |
| 33 | %s違規開發山坡地 罰款10000元 | 同 #30 | 10000 | 恒可 |
| 34 | %s製造噪音公害 罰款5000元 | 同 #30 | 5000 | 恒可 |
| 35 | %s獲利調高一倍 | 公司盈余翻倍，股东每月 15 日分红随之翻倍；利多天数 = 原盈余 ÷ 10000 | ×2 | 有盈余超过 10000 的公司 |

**交叉验证**：
- 贴吧截图帖与 EXE 文案逐条吻合，包括以下数字：
  - 税率 5%
  - 表扬奖金 10000
  - 地价 ±30%
  - 挤兑 15 天、休市 10 天、超贷坐牢 5 天
  - 公司罚款 10000/5000
- 截图里的“补助 15000”应是 5000×p 在物价指数为 3 时的结果。
- **乐游网 962.net 的“新闻大全”数值与 EXE 和截图都冲突**：所得税写 10%、闹鬼写跌 90%、表扬股市大户写 5000、休市写 1~7 天。判定为不可信。
- 贴吧有 4Fun 玩家留言说 4Fun 没有“股市全面上涨/崩盘”新闻。这是 **4Fun 的差异**，与原版无关。

---

## 2. 命运（“？”）

### 2.1 神明加持（只有命运事件查）[EXE]

每个玩家有两个隐藏数值：
- **财运**（player+0x46）：管“奖金”和“罚金”。
- **福运**（player+0x48）：管“劫难”。

两个数值都只由神明附身时增减：

| 神明 | 财运 | 福运 |
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

判定分档：
- **值 > 100**：必定进入“高档”。
- **50 < 值 ≤ 100**：50% 概率进入高档，否则不变。
- **0 ≤ 值 ≤ 50**：不变。
- **值 < 0**：进入“低档”。

三种事件类别在高档和低档下的结果：

| 类别 | 高档 | 低档 | 提示语 |
|---|---|---|---|
| 奖金（reward） | 奖金加倍 | 奖金作废 | 「%s保佑 獎金加倍！」/「%s作祟 獎金作廢！」 |
| 罚金（penalty） | 免付罚金 | 罚金加倍 | 「免付罰金」/「罰金加倍」 |
| 劫难（misfortune） | 逃过此劫 | 天数或损失加倍 | 「逃過此劫」/「倒霉加倍」 |

这套规则与萌娘和 B站 对神明效果的描述一致（例如大财神“命运奖励加倍”、衰神和恶魔“坏事加倍”）。

### 2.2 命运完整列表（37 项，按 EXE 编号）

| # | 原文 | 效果 | 数值 | 加持类别 | 可行或替换条件 |
|---|---|---|---|---|---|
| 0 | 強制拆除房屋一棟 | 随机拆掉自己一栋已建住宅（等级归 0，土地保留）。EXE 显示会按“等级×房价”补偿现金 | — | 不查 | 自己有已建住宅 |
| 1 | 強制徵收土地一處 | 自己的一块**空地**被收回，变无主。EXE 显示按地价补偿 | — | 不查 | 自己有空地 |
| 2 | 人頭被盜用冒貸%d元 | 贷款凭空增加（无息但占用贷款额度）；有保险可理赔 | **10000×p** | 罚金 | — |
| 3 | 支票跳票 銀行拒絕往來一個月 | 30 天内不能用银行任何功能（ATM 和柜台） | 30 天 | 罚金 | — |
| 4 | 侵入銀行電腦 挪用其他人存款%d% | 每个对手存款的 10% 转入**自己的存款** | 10% | 不查 | — |
| 5 | 今天是你生日 向每人收取一張卡片 | 每个有卡的对手给你 1 张。真人自己挑，电脑随机取 | 每人 1 张 | 不查 | 对手手里有卡 |
| 6 | 強迫出國觀光%d天 | 离开地图 3 天，期间不能收过路费、交易或用卡；有保险按天数理赔 | 3 天 | 劫难 | — |
| 7 | 被外星人綁架%d天 | 同 #6 | 3 天 | 劫难 | — |
| 8 | 股票違約交割損失股票%d% | 每支持股损失 10%，进公库 | 10% | 罚金 | 自己持股 |
| 9 | 變賣所有股票求現 | 按市价强制卖光所有股票，钱进存款 | — | 罚金 | 自己持股 |
| 10 | 機車被偷遺失 | 失去机车，改为步行 | — | 劫难 | 骑机车；开汽车时改为 #11；步行时跳过 |
| 11 | 汽車撞電線桿全毀 | 失去汽车，改为步行 | — | 劫难 | 开汽车；骑机车时改为 #10 |
| 12 | 掉進水溝就醫%d天 | 住院 | 3 天 | 劫难 | 步行；骑机车时改为 #13；**开汽车时跳过**（萌娘也说开汽车不会触发） |
| 13 | 騎機車摔傷住院%d天 | 住院 | 3 天 | 劫难 | 骑机车 |
| 14 | 行人闖越馬路罰款%d元 | 罚款进公库 | **3000×p** | 罚金 | 按交通方式三选一：步行为 #14，机车为 #15，汽车为 #16 |
| 15 | 騎機車未戴安全帽 罰款%d元 | 同上 | 3000×p | 罚金 | 同上 |
| 16 | 汽車超速罰款%d元 | 同上 | 3000×p | 罚金 | 同上 |
| 17 | 請所有人吃大餐 花費%d元 | 只扣自己的钱，进公库，**不分给其他玩家** | **6000×p** | 罚金 | — |
| 18 | 亂丟垃圾罰款%d元 | 罚款 | **600×p** | 罚金 | — |
| 19 | 你家小狗亂大小便 罰款%d元 | 罚款 | **1500×p** | 罚金 | — |
| 20 | 在路邊撿到%d元 | 进现金 | **1000×p** | 奖金 | — |
| 21 | 在路邊撿到%d元 | 进现金 | **2000×p** | 奖金 | — |
| 22 | 在路邊撿到%d元 | 进现金 | **3000×p** | 奖金 | — |
| 23 | 遺失錢包損失%d元 | 损失 | **1000×p** | 罚金 | — |
| 24 | 遺失錢包損失%d元 | 损失 | **2000×p** | 罚金 | — |
| 25 | 意外獲得遺產%d元 | 进现金 | **10000×p** | 奖金 | — |
| 26 | 被倒會損失%d元 | 损失 | **8000×p** | 罚金 | — |
| 27 | 發票中獎%d元 | 进现金 | **4000×p** | 奖金 | — |
| 28 | 發票中獎%d元 | 进现金 | **6000×p** | 奖金 | — |
| 29 | 發票中獎%d元 | 进现金 | **8000×p** | 奖金 | — |
| 30 | 付保險金%d元 | 付款进公库（不是付给保险公司） | **5000×p** | 罚金 | — |
| 31 | 領取保險金%d元 | 进现金 | **5000×p** | 奖金 | — |
| 32 | 變賣所有卡片道具 | 所有卡片和道具按变卖价强卖，所得折成**点券**。玩家公认最狠的一条 | — | 劫难 | — |
| 33 | 酒醉大鬧警局坐牢%d天 | 坐牢 | **3 天** | 劫难 | 仅原版四张地图（推断） |
| 34 | 防礙風化坐牢%d天 | 坐牢 | **5 天** | 劫难 | 同上 |
| 35 | 走私毒品坐牢%d天 | 坐牢 | **7 天** | 劫难 | 同上 |
| 36 | 販賣大補帖坐牢%d天 | 坐牢 | **9 天** | 劫难 | 同上 |

**#33~36 按地图换文案，天数不变。** EXE 的槽位公式是 `编号 + 4×地图低位`。下面把地图低位 0~3 对应到台湾/中国/日本/美国，这一步是**推断**：

| 地图（推断） | 3 天 | 5 天 | 7 天 | 9 天 |
|---|---|---|---|---|
| 0 台湾 | 酒醉大鬧警局 | 防礙風化 | 走私毒品 | 販賣大補帖 |
| 1 中国 | 酒醉大鬧警局 | 違法聚眾示威 | 獵捕保育動物 | 盜賣國寶 |
| 2 日本 | 誘騙未成年少女（拘役） | 防礙風化 | 走私毒品 | 施放毒氣 |
| 3 美国 | 非法持有槍械 | 毆打警員 | 獵捕保育動物 | 盜賣國家機密 |

**交叉验证**：
- 萌娘的命运一览表、百度经验和乐游网（同文）的 32 条顺序表、贴吧截图帖与 EXE 的金额系数全部一致：600/1000/1500/2000/3000/4000/5000/6000/8000/10000 × 物价指数。
- 坐牢天数 3/5/7/9 和住院 3 天也全部一致。
- 百度经验明确写了：“所有‘块’字前的数统统 ×物价指数”。
- cr173 攻略的“命运”清单把新闻和命运混在一起，并且没有数值，只能作为参考。

---

## 3. 魔法屋 [EXE + 网易号 + cr173 + 萌娘 + B站]

### 3.1 流程

**第一步：目标转盘（女巫选人）。** `rand()%12` 从 12 条条件里随机抽一条。若没人符合就重抽（原版没有重抽次数上限）。同一条条件最多选中 **4 人**。

| # | 条件 | 判据 |
|---|---|---|
| 0 | 財產最多的人 | 总资产最大，并列全算，不排除 0 |
| 1 | 土地最多的人 | 土地+设施数最多，0 不参选 |
| 2 | 房屋最多的人 | 已建房的土地数最多 |
| 3 | 現金最多的人 | — |
| 4 | 存款最多的人 | — |
| 5 | 點券最多的人 | — |
| 6 | 走路的人 | — |
| 7 | 騎機車的人 | — |
| 8 | 開汽車的人 | — |
| 9 | 神明附身的人 | — |
| 10 | 所有男生 | — |
| 11 | 所有女生 | — |

**第二步：效果转盘（选择施法方式）。** 12 项效果，**对名单里每个人逐一执行**（包括可能选中自己）：

| # | 效果 | 细节 |
|---|---|---|
| 0 | 變賣所有卡片 | 所得折成点券 |
| 1 | 抽取命運三張 | 目标连续触发 3 次命运，按目标自己的神明加持判定 |
| 2 | 立刻坐牢三天 | 坐牢 3 天；电脑对施法者敌意 +90×p |
| 3 | 原地停留一回合 | 停留 +1 回合 |
| 4 | 存入所有現金 | 现金全部转入存款 |
| 5 | 就地加蓋房屋 | 目标所在地块免费加盖 1 层 |
| 6 | 得一張卡片 | 随机 1 张，手牌上限 15 张 |
| 7 | 向後轉 | 掉头；受困中的人不受影响 |
| 8 | 變賣所有道具 | 所得折成点券；交通工具也会被卖掉 |
| 9 | 就地拆除房屋 | 目标所在地块拆 1 级；设施也拆 |
| 10 | 住院檢查三天 | 住院 3 天 |
| 11 | 拍賣當格土地 | 拍卖目标脚下的地产 |

**谁来选效果**：
- **真人**：在女巫窗口里自己点，12 项都能选。所有攻略都描述成“玩家选择施魔方式”。
- **电脑**：若名单里有自己，固定选 #6“得一張卡片”。否则 `rand()%11`，抽到 6 改成 7。所以电脑**从不**选“得一張卡片”害别人，也永远选不到 #11“拍賣當格土地”。

### 3.2 其他要点

- 魔法屋的坐牢和住院会过一道免罪卡、嫁祸卡的判定（EXE）。但网上另有说法称“无法被免罪卡和嫁祸卡防御”，见“待确认问题”。
- **死神**（仅适用于 ≥2 名真人玩家的局）：一名真人按下投降后，魔法屋女巫会问他要把死神附身在谁身上，受害者从其他玩家中选。有人 >1 的门槛。死神持续 13 天。巴哈姆特、B站、萌娘三方都有记载。
- 常见玩法：开局选“存入所有现金”让电脑没现金买地；对手被拒绝往来时让他“存入所有现金”，他就取不出来。

---

## 4. 乐透（彩券行）[EXE + 网易号 + 维基/Fandom + B站 + cr173]

- **号码**：共 36 个（显示为 1~36）。每个号码同时只能属于一人，已售出的号码不能再买。
- **购买**：
  - 每次停在彩券行只能买 **1 注**，需要从未售出的号码里挑一个。
  - 多次停留可以累积持有多个号码，没有持号上限。
  - 票价 **1000 元，不乘物价指数**，直接从现金扣，不会动用存款，也不会导致破产。
  - 真人现金 ≥1000 就能买；电脑要现金 >1000，并且由系统在未售出的号码里随机替它选。
  - 现金不足时，卖票的猫小姐会提示“现金不足，请下次再来”（cr173）。
  - 票款进公库，也就是奖池。
- **开奖**：每月 **15 日**，先做上市公司分红，再开奖。
  - 一张都没卖出：不开奖。
  - 所有人持号都 ≤10 个：在全部 36 个号码里随机开，**可能无人中奖**。
  - 任一人持号 >10 个：只在已售出的号码里开，**必定有人中奖**。
- **派彩**：中奖者独得开奖时的**整个奖池**，直接进现金。之后奖池归零，所有号码清空，大家重新买号。
- **无人中奖**：奖池和所有已买的号码原样保留到下一期，号码继续有效。
- **奖池来源**：所有收款方为“公库”的支出。包括：
  - 命运罚金、请客、付保险金
  - 新闻里的三种税
  - 乞丐施舍
  - 破产变卖所得
  - 票款
  
  因为罚金多半按物价指数放大，奖金也会随物价水涨船高。
- **破产**：破产玩家持有的号码被释放，其他人可以重新购买。

---

## 5. 银行 [EXE + 维基/Fandom + B站 + cr173 + 萌娘]

- **路过**：只能用 ATM，存款或取款，办一笔。存取款没有手续费。
- **停下**：先用 ATM，再到柜台。柜台只能办一次，三选一：
  - **贷款**：额度约等于总资产（Fandom：“與玩家資產相等的金額”；B站：“现金+存款等量”）。**期限 3 个月**（EXE：90 天，逐日顺延跳过星期日和假日）。**无利息**，到期强制还款。有贷款期间领不到存款利息，也领不到新闻 #23 的储金红利。
  - **还款**。
  - **特别融资**：只有银行董事长能用，可以挪用其他人存款的总和。
    - 若别人取款时银行存款不够，要由董事长垫付。
    - 董事长易主时，必须立刻归还所有挪用款。
- **存款利息**：每月 1 日，**没有贷款的人**存款 ×1.1，即 **10%**。
- **拒绝往来**（命运 #3）：30 天内 ATM 和柜台都不能用，只显示剩余天数。
- **挤兑**（新闻 #22）：15 天内全员不能贷款，ATM 只能存款。

---

## 6. 医院与监狱 [EXE + 维基/Fandom + 萌娘 + 网易号 + cr173]

### 6.1 结构与入狱/住院方式

- 两处是镜像结构，各有 8 个位子：0~3 给玩家，4~7 给四大恶人。
- 开局时小偷、强盗在监狱，流氓、间谍在医院。
- **停在监狱或医院格本身不会被关，也没有住院费或医药费**。EXE 否定了“住院费”和“踩监狱格入狱”这两种旧说法。
- 被关进去时，棋子会被传送到监狱或医院格。

**关押来源与天数**：

| 来源 | 地点 | 天数 |
|---|---|---|
| 命运犯罪 | 坐牢 | 3/5/7/9 天 |
| 命运掉水沟、骑机车摔伤 | 住院 | 3 天 |
| 新闻 #29 违法超贷 | 坐牢 | 5 天 |
| 新闻 #4 外星人攻打地球 | 住院 | 3 天 |
| 新闻 #1、#3 延长 | 在押或住院者 | +3 天 |
| 魔法屋 | 坐牢或住院 | 3 天 |
| 陷害卡（EXE） | 坐牢 | 对他人 5 天，对自己 4 天 |
| 地雷、恶犬 | 住院 | 3 天 |
| 飞弹、核弹、定时炸弹（B站/cr173） | 住院 | 5 天 |

- 若已经在里面又被判：天数直接累加。

### 6.2 在押或住院期间

- 不能移动，不能收过路费，不能交易、参加拍卖、使用卡片或道具（萌娘）。
- 天数在自己回合开始时递减。
- 神明影响（只对命运事件生效）：福神、天使可能免灾；衰神、恶魔、死神让天数加倍。

### 6.3 提前出来的办法

- **保释**：别的玩家停在监狱或医院格时，可以花 **30 点券** 保释某位玩家。真人需要点券 ≥30；电脑需要 >30，并且有 50% 概率根本不理会。
- **新闻 #0 或 #2**：所有在押或住院的玩家一次性全部放出。

### 6.4 雇用恶人

- 停在监狱可以花 **300 点券** 雇小偷或强盗；停在医院可以雇流氓或间谍。
- 电脑要点券 ≥700 才会去雇。

### 6.5 保险理赔

- 前提：持有有效保险（保险公司有主时，停在该公司会被迫按转盘天数投保）。
- 每次坐牢、住院或延长，赔 **2000×天数×p**，由保险公司支出。
- EXE 显示出国观光和外星人绑架也会理赔。

---

## 7. 其他特殊格

- **得点格**：+50 / +30 / +10 点券，只有这三档（EXE，萌娘为 10/30/50）。cr173 写有 20 点格，与 EXE 冲突。
- **卡片格 CARD**：按牌库剩余张数加权随机给 1 张卡。
  - 手牌上限 15 张。EXE 显示满了会先弃掉最便宜的一张；B站说“替换第一张”。
- **小游戏（游乐场，三种）**：企鹅挖宝、七彩气球、喜从天降。
  - 限时游戏，得分就是点券，上限 **999**。
  - 电脑玩家或关闭动画时直接给 **50~69 点**（EXE：50+rand%20）。萌娘说 50~70，cr173 说 50~60 多。
- **公园**：停下没有任何事发生，也不收费。
- **百货公司**：用点券买卖 30 种卡和道具。
  - 控股的董事长每次进店随机获赠 1 件。
  - 买卖产生的盈余在 15 日分红。
  - 进店卖货的价格规则属于卡片/道具专题，本主题不展开。
- **地图物件（不是格子，停下才触发）**：
  - 宝箱：+500 点券。
  - 礼物：随机 1 个道具。
  - 每月各刷新 1 个（B站：1 号刷新）。

---

## 8. 月度时间表 [EXE + B站 + 萌娘]

- **每月 1 日**：
  - 发存款利息，只给没有贷款的人，10%。
  - 刷新宝箱和礼物。
  - 上月评选“悲情人物”和“冠军”。
- **每月 15 日**：上市公司分红，然后乐透开奖。
- **12 月 25 日**：圣诞老人给每人 1 张随机卡片（萌娘；仙剑地图除外）。

---

## 9. 设计实现建议（按上述规格）

1. 新闻和命运各用一副**开局洗好、循环使用**的牌堆。抽牌时跳过不可行的事件。
2. 金额统一用 `factor × 物价指数`。企业罚款、乐透票价、税率、百分比类**不乘**物价指数。
3. 命运事件先做神明加持判定，再执行效果。新闻不做加持判定。
4. 按“停下才触发”与“路过触发”区分格子逻辑：路过只处理银行 ATM 和路障。
5. 联机版的魔法屋：由施法者（真人）从 12 项效果里自选。女巫只负责随机选“对谁”。

## entries
- **特殊格总表（17 种 specialKind）** [特殊格子] (high) 落点跳表只有 17 种：0 普通地产、1 公园、2 新闻、3 命运、4 监狱、5 医院、6 企鹅挖宝、7 七彩气球、8 喜从天降、9 乐透、10/11/12 得 50/30/10 点、13 卡片、14 银行、15 百货公司、16 魔法屋。原版没有机会、税务、传送点、起点奖金格 | 数值: 17 种（0..16） | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/special-square.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://richman.fandom.com/zh/wiki/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **路过即触发的格子与物件** [特殊格子] (high) 只有三样路过就生效：银行格（路过时开 ATM 存取款；梦游中不开；银行格上有路障时不开；被拒绝往来时只弹提示）、路障（半路拦停）、身上的定时炸弹（超过别人时可转给对方）。其余格子和物件（新闻、命运、乐透、卡片、得点、小游戏、监狱/医院、魔法屋、百货、公园、宝箱、礼物、地雷、恶犬、神明、乞丐）都要停下才触发 | 数值: 路过银行：真人办一笔存款或取款 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/state/bank-passby.test.ts, https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/object-landing.ts, https://www.163.com/dy/article/GQB1C7G70546O9E5.html
- **公园 PARK** [特殊格子] (high) 停下没有任何效果，也不收费，是安全落脚点 | 数值: 0 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/special-square.ts, https://www.163.com/dy/article/GQB1C7G70546O9E5.html, https://www.bilibili.com/opus/875661802094985219
- **新闻格 NEWS** [特殊格子] (high) 停下时从 36 张新闻牌堆抽 1 张，可能影响全体、区域或个人。牌堆开局洗一次后循环使用，抽到不可行事件就跳过 | 数值: 36 项 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/events/deck.ts, https://tieba.baidu.com/p/2543457805, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **命运格（问号）** [特殊格子] (high) 停下时从 37 张命运牌堆抽 1 张，只作用于自己；先做神明加持判定 | 数值: 37 项（另有按地图换文案的 12 个变体） | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://jingyan.baidu.com/article/e9fb46e1a5a9297521f766db.html, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **得点格（点券格）** [特殊格子] (high) 停下得点券。只有 50/30/10 三档 | 数值: +50 / +30 / +10 点券（cr173 说有 20 点，与 EXE 和萌娘冲突） | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/special-square.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://www.cr173.com/html/15938_1.html
- **卡片格 CARD** [特殊格子] (medium) 停下时按牌库剩余张数加权随机得 1 张卡。手牌上限 15 张，满了先弃掉最便宜的一张（EXE） | 数值: 1 张；手牌上限 15 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/special-square.ts, https://zh.wikipedia.org/zh-cn/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://www.bilibili.com/opus/875661802094985219
- **小游戏格（游乐场：企鹅挖宝、七彩气球、喜从天降）** [特殊格子] (high) 停下玩限时小游戏，得分就是点券。电脑玩家或关闭动画时自动给分 | 数值: 得分上限 999；自动给 50~69 点（50+rand%20） | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/places/minigame.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://www.cr173.com/html/15938_1.html
- **百货公司 On sale** [特殊格子] (medium) 停下时用点券买卖卡片和道具。控股的董事长进店时随机获赠 1 件；买卖盈余在 15 日分红 | 数值: 卡片 30 种（cr173） | src: https://richman.fandom.com/zh/wiki/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://www.bilibili.com/opus/875661802094985219, https://www.cr173.com/html/15938_1.html
- **宝箱与礼物（地图物件，不是格子）** [特殊格子] (high) 停下才拾取。宝箱给 500 点券；礼物随机给 1 个可售道具。每月刷新 | 数值: 宝箱 500 点；每月 1 个，1 号刷新 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/object-landing.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://www.bilibili.com/opus/875661802094985219
- **新闻/命运牌堆机制** [通用机制] (high) 开局用 rand 洗出 36 张（新闻）和 37 张（命运）的固定顺序，游标依次取；不可行的也会让游标前进；到底回绕，不重洗 | 数值: 新闻 36 张；命运 37 张 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/events/deck.ts, https://jingyan.baidu.com/article/e9fb46e1a5a9297521f766db.html
- **神明加持（只作用于命运事件）** [通用机制] (medium) 财运管奖金和罚金，福运管劫难。值 >100 必定高档；50<值≤100 有 50% 高档；值 <0 低档。奖金：高档加倍、低档作废。罚金：高档免付、低档加倍。劫难：高档逃过、低档加倍。新闻不查加持 | 数值: 财运/福运修正：小财神 +100、大财神 +150、小福神 +100、大福神 +150、小穷神 −60、大穷神 −100、小衰神 −60、大衰神 −100、天使 +60/+60、恶魔 −60/−60、死神 −200/−200 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/blessing.ts, https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/objects.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **新闻0 獄中囚犯無罪開釋** [新闻事件] (high) 所有在押玩家立即获释。只有监狱里有玩家时才可能抽到 | 数值: — | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/7806365715, https://www.cr173.com/html/15938_1.html
- **新闻1 獄中囚犯延長刑期3天** [新闻事件] (high) 所有在押玩家刑期 +3 天 | 数值: +3 天 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/7806365715
- **新闻2 住院中病患提前出院** [新闻事件] (high) 所有住院玩家立即出院 | 数值: — | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://www.cr173.com/html/15938_1.html, https://tieba.baidu.com/p/7806365715
- **新闻3 住院中病患延長住院3天** [新闻事件] (high) 所有住院玩家 +3 天 | 数值: +3 天 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/7806365715
- **新闻4 外星人攻打地球** [新闻事件] (medium) 以随机一处已建房的地产为中心打一发重击：范围内房屋和设施受损、车辆被毁，被炸到的人住院 | 数值: 半径 100 像素方窗（贴吧说约 3 格）；住院 3 天 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805, http://www.962.net/gl/13261.html
- **新闻5 外星怪獸襲擊%s 摧毀建築一棟** [新闻事件] (medium) 随机一处已建房的地产整栋清除；EXE 显示归属也被清空 | 数值: 1 栋 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805
- **新闻6 %s公告地價調漲30%** [新闻事件] (high) 随机一处：同名路段所有地块地价 ×1.3；若选中设施，只改那一处 | 数值: +30% | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805, http://www.962.net/gl/13261.html
- **新闻7 公開拍賣%s公有土地一處** [新闻事件] (high) 随机一块无主地产立即公开拍卖 | 数值: — | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805
- **新闻8 公開表揚第一大地主** [新闻事件] (high) 土地数最多者得奖金，进现金 | 数值: 10000×物价指数（贴吧截图 10000） | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805, http://www.962.net/gl/13261.html
- **新闻9 公開補助土地最少者** [新闻事件] (high) 土地数最少者得补助；并列时取最后一个 | 数值: 5000×物价指数（截图的 15000 应是物价指数为 3 时） | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805, http://www.962.net/gl/13261.html
- **新闻10 公開表揚股市第一大戶** [新闻事件] (high) 持股总数最多者得奖金 | 数值: 10000×物价指数（乐游网写 5000，不采信） | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805
- **新闻11 所有人繳交所得稅5%** [新闻事件] (high) 每人交现金的 5%，进公库（乐透奖池） | 数值: 现金×5%，不乘物价（乐游网写 10%，不采信） | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805
- **新闻12 所有人繳交地價稅5%** [新闻事件] (high) 每人按房地产价值交税，进公库 | 数值: Σ(地价+等级×房价)×5%，再 ×物价指数 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805
- **新闻13 所有人繳交證交稅5%** [新闻事件] (high) 每人按持股市值交税，进公库 | 数值: 市值×5%×物价指数（EXE） | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805
- **新闻14 %s房屋鬧鬼 地價下跌30%** [新闻事件] (high) 同名路段地价 ×0.7 | 数值: −30%（乐游网写 90%，不采信） | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805
- **新闻15 %s一處民宅瓦斯爆炸 房屋失火** [新闻事件] (medium) 随机一块已建房的住宅用地拆房，土地不丢 | 数值: — | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805
- **新闻16 豪雨特報 行人休息一回合** [新闻事件] (high) 所有步行的玩家停 1 回合 | 数值: 1 回合 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805, http://www.962.net/gl/13261.html
- **新闻17 交通阻塞 汽車停止一回合** [新闻事件] (high) 所有乘车（机车和汽车）的玩家停 1 回合 | 数值: 1 回合 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805
- **新闻18 %s強烈地震房屋倒塌** [新闻事件] (high) 同名路段所有地块 −1 级（商业用地清为空地）；若选中设施，只改那一处 | 数值: −1 级 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805
- **新闻19 %s山洪爆發土地流失** [新闻事件] (high) 随机一块地产被完全清除，变回无主土地 | 数值: — | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805
- **新闻20 超級颱風侵襲%s 多處房屋受損** [新闻事件] (medium) 范围伤害：住宅和设施 −1 级，不伤人 | 数值: 半径 100 像素方窗 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805
- **新闻21 龍捲風侵襲%s 摧毀房屋一棟** [新闻事件] (high) 随机一处拆房 | 数值: 1 栋 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805
- **新闻22 銀行擠兌停止放款15天** [新闻事件] (high) 全体不能贷款，ATM 只能存款 | 数值: 15 天 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **新闻23 銀行加發10%儲金紅利** [新闻事件] (high) 没有贷款的玩家得存款 10%，进存款 | 数值: 存款×10% | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, http://www.962.net/gl/13261.html, https://www.cr173.com/html/15938_1.html
- **新闻24 股市低迷不振重挫崩盤** [新闻事件] (high) 12 支股票全部利空（跌停）1 天，立即重算股价 | 数值: 全市场 1 天 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805
- **新闻25 股市氣勢如虹全面上漲** [新闻事件] (high) 12 支股票全部利多（涨停）1 天 | 数值: 全市场 1 天 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805
- **新闻26 股市暫停交易10天** [新闻事件] (high) 全股市休市 | 数值: 10 天（EXE 实现上约 11 天；乐游网写 1~7 天，不采信） | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805
- **新闻27 %s股票暫停交易10天** [新闻事件] (medium) 随机 1 支股票停牌，股价冻结在开盘价 | 数值: 文案写 10 天；EXE 立即数是 15 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts
- **新闻28 %s股票恢復上市交易** [新闻事件] (medium) 随机 1 支停牌股复牌；需要有停牌股才可能抽到 | 数值: — | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts
- **新闻29 %s違法超貸 經營者%s坐牢5天** [新闻事件] (high) 随机一家有主的上市公司，其董事长坐牢；可被免罪卡或嫁祸卡抵挡 | 数值: 5 天 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805, http://www.962.net/gl/13261.html
- **新闻30/33/34 工廠排放污水、違規開發山坡地、製造噪音公害** [新闻事件] (high) 随机一家公司的盈余被扣（不乘物价），影响股东每月 15 日分红；该股利空 3 天 | 数值: 污水 10000、山坡地 10000、噪音 5000 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805
- **新闻31/32 %s海外投資 獲利、虧損20000元** [新闻事件] (high) 公司盈余加减；获利时利多 3 天，亏损时利空 4 天 | 数值: ±20000（不乘物价） | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, http://www.962.net/gl/13261.html, https://www.cr173.com/html/15938_1.html
- **新闻35 %s獲利調高一倍** [新闻事件] (high) 公司盈余翻倍，分红随之翻倍；只选盈余超过 10000 的公司 | 数值: ×2；利多天数 = 原盈余 ÷ 10000 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805
- **命运0 強制拆除房屋一棟** [命运事件] (medium) 随机拆掉自己一栋已建住宅，土地保留；EXE 显示按等级×房价补偿现金 | 数值: — | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805, https://jingyan.baidu.com/article/e9fb46e1a5a9297521f766db.html
- **命运1 強制徵收土地一處** [命运事件] (medium) 自己一块空地变无主；EXE 显示按地价补偿 | 数值: — | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **命运2 人頭被盜用冒貸** [命运事件] (high) 贷款凭空增加（罚金类加持） | 数值: 10000×物价指数 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://jingyan.baidu.com/article/e9fb46e1a5a9297521f766db.html
- **命运3 支票跳票 銀行拒絕往來一個月** [命运事件] (high) 期间不能用银行任何功能 | 数值: 30 天 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **命运4 侵入銀行電腦 挪用其他人存款** [命运事件] (high) 每个对手存款的 10% 转入自己的存款 | 数值: 10% | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805, https://jingyan.baidu.com/article/e9fb46e1a5a9297521f766db.html
- **命运5 今天是你生日 向每人收取一張卡片** [命运事件] (high) 每个有卡的对手给 1 张；对手都没卡时不可行 | 数值: 每人 1 张 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://jingyan.baidu.com/article/e9fb46e1a5a9297521f766db.html
- **命运6/7 強迫出國觀光、被外星人綁架** [命运事件] (high) 离开地图，期间不能收过路费、交易或用卡（劫难类加持） | 数值: 3 天 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://jingyan.baidu.com/article/e9fb46e1a5a9297521f766db.html
- **命运8 股票違約交割損失股票** [命运事件] (high) 每支持股损失 10%；需要持股才可行 | 数值: 10% | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **命运9 變賣所有股票求現** [命运事件] (high) 按市价卖光所有股票，钱进存款 | 数值: — | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **命运10/11 機車被偷遺失、汽車撞電線桿全毀** [命运事件] (high) 按当前交通工具二选一，失去座驾改为步行；步行时不可行 | 数值: — | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/events/fortune.ts, https://tieba.baidu.com/p/2543457805, https://jingyan.baidu.com/article/e9fb46e1a5a9297521f766db.html
- **命运12/13 掉進水溝就醫、騎機車摔傷住院** [命运事件] (high) 步行时掉水沟，骑机车时摔伤；开汽车时不可行 | 数值: 住院 3 天 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://jingyan.baidu.com/article/e9fb46e1a5a9297521f766db.html
- **命运14/15/16 行人闖越馬路、騎機車未戴安全帽、汽車超速** [命运事件] (high) 按交通方式三选一罚款 | 数值: 3000×物价指数 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805, https://jingyan.baidu.com/article/e9fb46e1a5a9297521f766db.html
- **命运17 請所有人吃大餐** [命运事件] (high) 只扣自己的钱，进公库，不分给他人 | 数值: 6000×物价指数 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://jingyan.baidu.com/article/e9fb46e1a5a9297521f766db.html
- **命运18 亂丟垃圾罰款** [命运事件] (high) 罚款 | 数值: 600×物价指数 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://jingyan.baidu.com/article/e9fb46e1a5a9297521f766db.html
- **命运19 你家小狗亂大小便罰款** [命运事件] (high) 罚款 | 数值: 1500×物价指数 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://jingyan.baidu.com/article/e9fb46e1a5a9297521f766db.html
- **命运20/21/22 在路邊撿到錢** [命运事件] (high) 进现金（奖金类加持） | 数值: 1000 / 2000 / 3000 ×物价指数 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://jingyan.baidu.com/article/e9fb46e1a5a9297521f766db.html
- **命运23/24 遺失錢包** [命运事件] (high) 损失 | 数值: 1000 / 2000 ×物价指数 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://jingyan.baidu.com/article/e9fb46e1a5a9297521f766db.html
- **命运25 意外獲得遺產** [命运事件] (high) 进现金 | 数值: 10000×物价指数 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://jingyan.baidu.com/article/e9fb46e1a5a9297521f766db.html
- **命运26 被倒會損失** [命运事件] (high) 损失 | 数值: 8000×物价指数 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://jingyan.baidu.com/article/e9fb46e1a5a9297521f766db.html
- **命运27/28/29 發票中獎** [命运事件] (high) 进现金 | 数值: 4000 / 6000 / 8000 ×物价指数 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://jingyan.baidu.com/article/e9fb46e1a5a9297521f766db.html
- **命运30 付保險金** [命运事件] (high) 付款进公库（不是付给保险公司） | 数值: 5000×物价指数 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://jingyan.baidu.com/article/e9fb46e1a5a9297521f766db.html
- **命运31 領取保險金** [命运事件] (high) 进现金 | 数值: 5000×物价指数（贴吧截图 5000） | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805, https://jingyan.baidu.com/article/e9fb46e1a5a9297521f766db.html
- **命运32 變賣所有卡片道具** [命运事件] (high) 所有卡片和道具按变卖价强卖，所得折成点券（劫难类加持） | 数值: — | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://tieba.baidu.com/p/2543457805, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **命运33~36 坐牢四档（按地图换文案）** [命运事件] (medium) 坐牢。台湾：酒醉大鬧警局、防礙風化、走私毒品、販賣大補帖。中国：酒醉、違法聚眾示威、獵捕保育動物、盜賣國寶。日本：誘騙未成年少女、防礙風化、走私毒品、施放毒氣。美国：非法持有槍械、毆打警員、獵捕保育動物、盜賣國家機密。地图与地区的对应是推断 | 数值: 3 / 5 / 7 / 9 天 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://jingyan.baidu.com/article/e9fb46e1a5a9297521f766db.html
- **魔法屋流程与目标条件** [魔法屋] (high) 停下后女巫随机抽 1 条条件（没人符合就重抽），名单最多 4 人。12 条条件：財產最多、土地最多、房屋最多、現金最多、存款最多、點券最多、走路的人、騎機車的人、開汽車的人、神明附身的人、所有男生、所有女生。随后对名单里每个人执行所选效果 | 数值: 目标条件 12 条；名单最多 4 人 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/places/magic-house.ts, https://www.cr173.com/html/15938_1.html, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **魔法屋效果选择方式** [魔法屋] (medium) 真人从 12 项效果里自己点选。电脑：名单里有自己就固定选“得一張卡片”，否则 rand%11 且 6 改 7，因此电脑永远选不到“拍賣當格土地” | 数值: 效果 12 项；电脑实际只会选 10 项 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/places/magic-house.ts, https://www.163.com/dy/article/GQB1C7G70546O9E5.html, https://www.cr173.com/html/15938_1.html
- **魔法屋效果 0 變賣所有卡片 / 8 變賣所有道具** [魔法屋] (high) 目标的全部卡片或道具按价格卖掉，所得折成点券；交通工具也会被卖 | 数值: — | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/magic-house.ts, https://www.163.com/dy/article/GQB1C7G70546O9E5.html, https://www.cr173.com/html/15938_1.html
- **魔法屋效果 1 抽取命運三張** [魔法屋] (high) 每个目标连续触发 3 次命运 | 数值: 3 张 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/magic-house.ts, https://www.163.com/dy/article/GQB1C7G70546O9E5.html
- **魔法屋效果 2 立刻坐牢三天 / 10 住院檢查三天** [魔法屋] (high) 目标坐牢或住院；EXE 显示会经过免罪卡、嫁祸卡的判定 | 数值: 3 天 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/places/magic-house.ts, https://www.163.com/dy/article/GQB1C7G70546O9E5.html, https://www.bilibili.com/opus/875661802094985219
- **魔法屋效果 3 原地停留一回合 / 7 向後轉** [魔法屋] (high) 目标停留 +1 回合，或掉头；受困中的人不掉头 | 数值: 1 回合 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/magic-house.ts, https://www.cr173.com/html/15938_1.html
- **魔法屋效果 4 存入所有現金** [魔法屋] (high) 目标的现金全部转入存款 | 数值: 100% | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/magic-house.ts, https://www.bilibili.com/opus/875661802094985219, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **魔法屋效果 5 就地加蓋房屋 / 9 就地拆除房屋** [魔法屋] (medium) 目标脚下的地产 +1 层（免费）或拆 1 层，设施也适用 | 数值: ±1 层 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/magic-house.ts, https://www.cr173.com/html/15938_1.html
- **魔法屋效果 6 得一張卡片** [魔法屋] (high) 目标随机得 1 张卡 | 数值: 1 张；手牌上限 15 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/magic-house.ts, https://www.cr173.com/html/15938_1.html
- **魔法屋效果 11 拍賣當格土地** [魔法屋] (medium) 拍卖目标脚下的地产；只有真人会选到 | 数值: — | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/magic-house.ts, https://www.163.com/dy/article/GQB1C7G70546O9E5.html
- **魔法屋召唤死神（投降机制）** [魔法屋] (high) 局中有 ≥2 名真人时，一名真人投降后，女巫让他从其他玩家中选一人让死神附身 | 数值: 死神 13 天 | src: https://forum.gamer.com.tw/C.php?bsn=972&snA=2175, https://www.bilibili.com/opus/875661802094985219, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **乐透：购买规则** [乐透] (high) 停在彩券行每次买 1 注，从未售出的号码里挑一个；可以多次累积持号。真人需要现金 ≥1000，电脑需要 >1000 并随机选号 | 数值: 号码 36 个（1~36）；1000 元一注，不乘物价 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/places/lottery.ts, https://www.163.com/dy/article/GQB1C7G70546O9E5.html, https://zh.wikipedia.org/zh-cn/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **乐透：开奖、派彩与滚存** [乐透] (high) 每月 15 日分红后开奖。持号都 ≤10 个时在 36 号里随机开，可能无人中奖；有人持号 >10 个时只在已售号码里开，必定有人中奖。中奖者独得全部奖池，进现金，之后奖池和号码全部清零；无人中奖则奖池和号码都保留到下期 | 数值: 每月 15 日；门槛 10 个号码 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/places/lottery.ts, https://www.bilibili.com/opus/875661802094985219, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **乐透：奖池来源** [乐透] (high) 所有收款方为“公库”的支出：命运罚金、请客、付保险金、三种税、乞丐施舍、破产变卖所得，加上票款。破产者的号码会被释放 | 数值: — | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/places/lottery.ts, https://richman.fandom.com/zh/wiki/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://www.bilibili.com/opus/875661802094985219
- **银行：路过与停下** [银行] (high) 路过只能用 ATM 存取一笔。停下先 ATM，再到柜台三选一：贷款、还款或特别融资（只限董事长，可挪用他人存款总和） | 数值: 柜台每次只能办 1 项 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/state/bank-passby.test.ts, https://www.163.com/dy/article/GQB1C7G70546O9E5.html, https://www.bilibili.com/opus/875661802094985219
- **银行：贷款与利息** [银行] (high) 贷款额度约等于总资产，无息，3 个月到期强制还款。存款利息每月 1 日发放，只给没有贷款的人 | 数值: 贷款期 90 天（跳过星期日和假日）；利息 10%/月 | src: https://richman.fandom.com/zh/wiki/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://www.bilibili.com/opus/875661802094985219, https://www.cr173.com/html/15938_1.html
- **医院与监狱：入院入狱与天数** [医院监狱] (high) 停在监狱或医院格不会被关，也没有医药费。关押来源：命运犯罪 3/5/7/9 天；水沟、摔伤、地雷、恶犬、魔法屋、外星人攻打 3 天；违法超贷和陷害卡 5 天；飞弹、核弹、定时炸弹 5 天。再次被判时天数累加 | 数值: 各有 8 个位子（4 个玩家位 + 4 个恶人位） | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/confinement.ts, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://richman.fandom.com/zh/wiki/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **医院与监狱：保释与雇用恶人** [医院监狱] (high) 其他玩家停在该格时可花点券保释在押或住院的玩家，或雇用恶人（监狱：小偷、强盗；医院：流氓、间谍）。电脑有 50% 概率不理会；电脑要点券 ≥700 才雇恶人 | 数值: 保释玩家 30 点；雇恶人 300 点 | src: https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/visit.ts, https://richman.fandom.com/zh/wiki/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://www.163.com/dy/article/GQB1C7G70546O9E5.html
- **医院与监狱：受困期间与保险理赔** [医院监狱] (high) 受困期间不能移动、收过路费、交易、参加拍卖或使用卡片道具；天数在自己回合开始时递减。投保者每次被关或加刑都获理赔 | 数值: 理赔 = 2000×天数×物价指数 | src: https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://www.bilibili.com/opus/875661802094985219, https://github.com/oama1111/rich4-remake-public/blob/HEAD/docs/gaps/04-events-places-gods.md
- **月度与节日时间表** [通用机制] (medium) 每月 1 日发利息（无贷款者）、刷新宝箱和礼物、评选悲情人物和冠军；每月 15 日上市公司分红后乐透开奖；12 月 25 日圣诞老人给每人 1 张随机卡（仙剑地图除外） | 数值: 1 日；15 日；12/25 | src: https://www.bilibili.com/opus/875661802094985219, https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://github.com/oama1111/rich4-remake-public/blob/HEAD/docs/gaps/04-events-places-gods.md

## open_questions
- 魔法屋的真人路径：名单里包含施法者自己时，是否也强制变成“得一張卡片”？EXE 里的电脑路径是强制的；真人路径（who_plays==1）在此之前就分流了。复刻项目的差距文档说该字段语义静态无法裁决，需要实机验证。
- 魔法屋的坐牢/住院能否被免罪卡或嫁祸卡抵挡：EXE 显示会经过 0x441210 的免罪→嫁祸判定，但网上另有摘要称“无法被免罪卡和嫁祸卡防御”，需要实机测试。
- 新闻的住院/坐牢类事件是否受天使或福神保护：EXE 显示新闻事件不做神明加持判定，但萌娘写“被天使或福神附身的玩家可逃过命运或新闻触发的住院特殊事件”。
- 命运 #33~#36（坐牢四档）的可行性闸 word[0x4991b6]：推测是“原版地图组 vs 超时空之旅资料片”，未证实。地图低位 0~3 对应台湾/中国/日本/美国也是推断。萌娘把“非法持有枪械”标成中国大陆限定，与 EXE 槽位（美国组）冲突。
- 新闻 #11/#12/#13（三税）有一个全局开关 byte[0x46caf8]，可能整段跳过扣税，其写入者和语义尚未确定。
- 外星人攻打地球、超级台风的实际影响范围：EXE 给的是“半径 100（像素方窗）”，贴吧说外星人攻打约 3 格，尚未换算成标准格数。
- 卡片格是路过还是停下触发：cr173 写“经过 CARD 标记时就能获得”，EXE 的落点跳表显示只在停下时触发，建议实机确认。
- 手牌满 15 张时再得卡：EXE（据复刻项目）是“先弃最便宜的一张”，B站 攻略写“替换第一张卡片”。
- 得点格是否存在 20 点档：cr173 写有 10/20/30/50，萌娘和 EXE 只有 10/30/50。
- “天”的时间单位：一般理解为每轮所有玩家各走一次算 1 个游戏日，本次没有找到明确的一手说明。股市暂停交易、挤兑、拒绝往来等天数的精确递减时机也需实机确认（EXE 显示休市实际约 11 天）。
- 新闻 #27“股票暂停交易10天”：文案写 10 天，EXE 的立即数是 15，实际停牌天数待实机确认。
- 强制拆除房屋、强制征收土地是否按房价或地价补偿现金：只有 EXE 逆向资料这么说，玩家攻略都没有提到。
- 各地图的节日表（除圣诞节外的节日是否也发卡片或有其他效果）尚未整理，只知道每张地图各有 24 条节日记录。
- 乐游网 962.net 的“新闻大全”数值（所得税 10%、闹鬼跌 90%、表扬大户 5000、休市 1~7 天）与 EXE 和截图冲突，来源不明，可能是转载错误或其他版本。

## sources
- https://github.com/oama1111/rich4-remake-public
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/event-table.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/docs/gaps/04-events-places-gods.md
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/places/lottery.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/places/magic-house.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/data/src/magic-house.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/special-square.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/visit.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/confinement.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/blessing.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/objects.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/events/deck.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/events/news.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/events/fortune.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/places/minigame.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/state/bank-passby.test.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/object-landing.ts
- https://tieba.baidu.com/p/2543457805
- https://tieba.baidu.com/p/7806365715
- https://zh.moegirl.org.cn/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814
- https://jingyan.baidu.com/article/e9fb46e1a5a9297521f766db.html
- http://www.962.net/gl/58246.html
- http://www.962.net/gl/13261.html
- https://www.cr173.com/html/15938_1.html
- https://www.bilibili.com/opus/875661802094985219
- https://www.163.com/dy/article/GQB1C7G70546O9E5.html
- https://richman.fandom.com/zh/wiki/%E5%A4%A7%E5%AF%8C%E7%BF%814
- https://zh.wikipedia.org/zh-cn/%E5%A4%A7%E5%AF%8C%E7%BF%814
- https://forum.gamer.com.tw/C.php?bsn=972&snA=2175
- https://github.com/mytbk/rich4