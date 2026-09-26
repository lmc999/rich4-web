# 大富翁4：股票、银行、点券与时间系统规格（面向 4 人网页联机复刻）

## 0. 版本范围与证据等级

- **只针对 PC 版《大富翁4》(1998)**。可执行文件分两个版本：原版 `Game`（4 张图：台湾、中国大陆、日本、美国）和资料片 `MultiverseJourney`（即「超时空之旅」，另加 4 张图：太空、仙剑/武侠、侏罗纪、纯商铺/度假）。两版的规则和数据表相同，只是地图数量不同。**本文数据与手机/Steam 的《大富翁4 Fun》、《大富翁3/5/DS/Online》无关**；超时空之旅地图的内容单独标注。
- 证据分四级：
  - **A**：反编译代码或数据表（mytbk/rich4 反汇编项目，以及 richman4-remake 对原版 exe 的逐地址核对），再加上 1 个以上的社区或百科来源互相印证。
  - **B**：只有反编译或重制项目单方来源。
  - **C**：只有社区说法。
  - **D**：来源之间互相冲突。
- 说明书（Steam 附带的原版 PDF）是扫描图片，无法直接取文字。它的内容通过 richman4-remake 的 `docs/manual-rules.md` 逐页索引间接引用，页码都是纸面页码。

---

## 1. 时间系统

### 1.1 日历
- 使用**真实公历**，包括年、月、日和星期。月份天数按实际日历。闰年规则是「年份能被 4 整除」（代码里连 2100 年也算闰年）。星期以「1998-01-01 是星期四」为基准推算。（A/B）
- 开局日期取自电脑本机日期（`GetLocalTime`），日期存在 RICH4.CFG 的 offset 8–11（日、月、年）。复刻时建议由房主选择开局日期，或者直接用服务器当天日期。（B）
- **所有存活玩家各走完一回合算过一天**（说明书 p.10）。《4 Fun》的社区描述也是「每个人物走一回合算一天」。（A）
- 日期可表示的上限是 9999-12-31（这是实现边界，原版没有对应规则）。

### 1.2 每日推进的顺序
来源：反汇编 `fcn_0041cf67`，在最后一名玩家的回合结束后执行。以下是可以直接照抄的服务器伪代码：
```
day += 1; elapsed_days += 1
if 检查结束条件(期限/资产目标): 结算并结束
更新物价指数（见 §2.3）
股市全面休市倒数：若 closed_days>0 则 -1（归零时先打标记，隔天才真正开市）
对每支股票: 停牌天数 suspension -1；红/黑事件 event 的高 4 位(涨) -0x10、低 4 位(跌) -1
srand(新种子)
if 今天开市（不是周日/节日休市，也没有全面休市）: 股价 tick（§4.5）
节日处理（每张地图有节日表）
if 今天是 15 号: 公司分红（§4.9）+ 乐透开奖
if 换月了: 月底结算（§1.4），并把地图上的「礼物」「宝箱」移到随机的远处空格
```
- 每位玩家的回合开始时，重置该玩家本回合的股票可买额度（§4.3）。

### 1.3 休市日
- **每逢星期日股市休市**（说明书 p.10/p.11，社区也说「星期日和节日为休市日」）。股票界面会显示「本日休市」。（A）
- 每张地图各有一张节日表，最多 24 个节日，其中带「休市」标记的节日也会休市。具体节日清单**未查到**。（B）
- 新闻「股市暂停交易10天」会让全市场停市 10 天。倒数按自然日计算，周日也照样扣。（A）
- 说明书写「周日银行也休息」，但反编译代码的 ATM 和银行入口**都没有检查周日**；周日只影响贷款到期日（到期日落在休市日时会顺延）。这一点有冲突，见 open questions。

### 1.4 每月 15 日
- 公司**分红**：把各公司「本月盈余」按持股比例分给股东（§4.9）。（A）
- **乐透开奖**。奖金没人中就累积到下期。彩票每张 1000 元，只能用现金买，**不乘物价指数**；票款进入公共奖池。破产玩家股票的变现款也进入同一个奖池。（A/B）

### 1.5 月底结算（换月那一天）
- **存款月息 10%**：没有贷款的玩家，`存款 = trunc(存款 × 1.1)`。有贷款的玩家不发利息。反编译里的常数是 double 1.1 和 0.1；说明书 p.10 写「月底存款利息 10%」。（A）
- 结算画面还会评出「本期冠军」（本期资产最多）和「本期悲情人物」（本期累积损失加坐牢/住院等无法行动天数最多）。悲情人物的评分式里含「天数 × 2500 × 物价指数」这一项，其余字段含义未完全解读。（A/B）
- 地图上的「礼物」「宝箱」会被移到离原位置较远的随机空格，重新出现。（B：物件 0xD/0xE 在换月时重新放置，物件和名称的对应是推断）

### 1.6 开局参数与结束条件（大厅设置）
| 项目 | 选项（索引 0→5） | 默认 |
|---|---|---|
| 总资金 initial_fund | 300000 / 200000 / 100000 / 50000 / 30000 / 10000 | 索引 1 = 200000（B） |
| 期限（天） | 不限 / 730 / 365 / 182 / 91 / 30 | — |
| 资产目标倍数 | 不设 / 100× / 50× / 10× / 5× / 3×（按 initial_fund 计） | — |
- 真人玩家开局「现金 = 存款 = 总资金 / 2」。AI 的现金占比由角色决定：约翰乔 50%、沙隆巴斯 40%、忍太郎 70%、钱夫人 60%、阿土伯 40%、莎拉公主 70%、宫本宝藏 50%、糖糖 40%、乌咪 60%、孙小美 50%、小丹尼 55%、金贝贝 80%，其余作为存款。（A：mytbk game_init.c 与 remake 两份反编译一致）
- 开局点券为 **0**（前作是 100）。每人另发 6 个道具：机器娃娃、路障、地雷、定时炸弹、遥控骰子、机器工人。（A）
- 物价指数初始值为 1。
- 每天日期推进后检查结束条件：
  - 已过天数 ≥ 期限，或最高净资产 ≥ 目标倍数 × initial_fund 时，游戏结束。
  - 最高资产者获胜；资产相同时，玩家顺序靠前者获胜。（A）

---

## 2. 资金形态、总资产与物价指数

### 2.1 账户字段（每位玩家）
- `cash` 现金，`deposit` 存款（含特别融资拨入的钱），`loan` 贷款余额，`loan_due_date` 贷款到期日，`financing` 特别融资余额，`points` 点券（uint16，上限理论值 65535），`bank_reject_days` 银行拒绝往来天数，`loan_block_days` 暂停放款天数。
- 股票持仓：12 支股票，每支记录持股数和平均成本（float）。

### 2.2 总资产（净资产）公式
来源：反汇编 `rich4_calculate_player_wealth`，用于判胜负、物价指数、贷款额度和排名。
```
wealth = cash + deposit - loan
       + Σ_12支 trunc(持股数 × 当前股价)
       + Σ_自有住宅 ( 地价 + (连锁店 ? 建屋价 : 等级 × 建屋价) )
       + Σ_自有设施 ( 地价 + 等级 × 设施升级价 )
```
- 注意 1：这里的地价和建屋价是**地图原始的 u16 值，不乘物价指数**。新闻里的地价涨跌会直接改写这个值。
- 注意 2：`financing` 不扣除；融资拨入的钱已经算进 deposit，所以融资会**虚增**银行董事长的总资产。（B）
- 社区的说法是「股票持有量计入总资产，但独立于现金与存款之外」，与此一致。

### 2.3 物价指数 price_index
- **每天**重新计算，只升不降：
  ```
  新值 = floor( floor( Σ存活玩家wealth / 存活人数 ) / initial_fund )
  若 新值 > price_index，则 price_index = 新值
  ```
  （A：反汇编 `rich4_update_price_index`；社区也说「物价指数 = 所有玩家总资产 / 初始总资产」「平均资产加倍则指数上升」）
- **乘物价指数的项目**：买地、建屋、租金、设施费、公司服务费、保险理赠（2000 × 指数 / 天）、新闻奖励和税金、免费卡的触发门槛（2000 × 指数）等。
- **不乘物价指数的项目**：股价、乐透票价（固定 1000）、点券价格。
- 资金是 int32，上限 2147483647，超过会变成负数。社区称物价指数「正常最高 107374，理论最高 214748」，约等于 2³¹ / initial_fund。（C）

### 2.4 付款顺序
- 一般付款（租金、罚款等）先扣现金，不够再扣存款，还不够就破产。说明书以「现金 + 存款」作为破产判定。（B）
- 银行类扣款（到期还贷、融资不足时的垫付）则先扣存款，再扣现金，仍不够就破产。（A）

---

## 3. 银行

### 3.1 经过与停留
- **经过**银行格：打开 ATM，只能存款和提款。
- **停留**在银行格：先打开 ATM，再进入银行柜台，可以借贷款、还贷款；银行董事长还可以办特别融资。（A：说明书 p.18–19，百科/萌百「必须停在银行标志上才能贷款，路过只能存提款」，反汇编的落地和经过调度一致）
- 存提款金额不限，只受现金或存款余额限制。没有手续费。
- 若玩家处于「银行拒绝往来」状态（命运「支票跳票，银行拒绝往来一个月」），ATM 会直接提示「银行拒绝往来，还剩 N 天」，无法使用。（B）

### 3.2 存款利息
- 月底结算时，无贷款者的存款 ×1.1（截断取整）。**不是按日计息**。
- 新闻「银行加发 10% 储金红利」会**立即**给所有无贷款且有存款的玩家加发 10%。（A）

### 3.3 贷款
- 额度：进入银行时计算一次 wealth，**贷款总额最多等于 wealth**（可借 = wealth - 现有贷款）。可以只借一部分。借到的钱**直接存入存款**。（A：百科「与玩家资产相等的金额」，反汇编一致）
- **无利息**。还款期限为 **90 天**（「3 个月」），从第一笔贷款当天起算，追加贷款不会延长期限。到期日若落在休市日，会顺延到下一个非休市日。（A）
- 还款：只能停在银行时还，可以部分还，先扣存款再扣现金，不够不能还。还清后到期日清零。（A）
- 到期还没还清，系统会自动从存款和现金扣款，不够就破产（喜马拉雅问答「钱不够就 game over」）。（A/B）
- 贷款期间**不发月息**。（A）
- 新闻「银行挤兑停止放款 15 天」：15 天内不能贷款，但仍然可以存提款。（A）
- 命运事件：
  - 「人头被盗用冒贷 %d 元」：被强制加一笔贷款，金额未查到。
  - 「支票跳票，银行拒绝往来一个月」。
- AI 贷款逻辑（参考）：AI 身上现金加存款低于 30000，或者按 10% 的随机概率，会借「wealth × 角色贷款比例 / 100」。AI 在距离到期 ≤ 6 天、且现金加存款 ≥ 贷款 × 1.1 时还款。（B）

### 3.4 特别融资（银行董事长特权）
- 只有银行股的「经营者」（持股最多者）停在银行时可以办理。
- 融资上限 = 其他玩家存款总和（PTT：「融资上限是所有人的存款合计」）。
- 融资**无利息、无期限**，拨入存款。（A/C）
- 其他玩家提款导致银行准备金不足时，系统提示「银行资金准备不足 X 元，由经营者 %s 垫付！」，差额从董事长的存款、再从现金扣除，不够就破产，同时融资余额减少。（A：百科、喜马拉雅、反汇编三方一致）
- 还有一条「强制偿还 %d 元 银行特别融资」的流程，触发条件未完全解读。（B）
- 命运「侵入银行电脑，挪用其他人存款 %d%%」：把其他每位玩家存款的 10% 转入自己存款。（B）

---

## 4. 股市

### 4.1 基本参数
- 每张地图有 **12 支上市股票**，每支总股本 **10000 股**。
- 股价有两位小数，范围 **1 ~ 9999**。社区也说「跌不到 1」「一堆公司都可以涨到上限 9999 元」。（A）
- **单日涨跌幅上限 ±10%**：
  - 涨停时不能买，提示「涨停无法买进！」。
  - 跌停时不能卖，提示「跌停无法卖出！」。
  - （A：界面字符串 + 百科「涨停、跌停买进卖出特别设计」）
- **没有任何交易手续费**。（A）
- 价格档位（最小跳动单位），按新价格判断：
  - 低于 5：0.01
  - 低于 15：0.05
  - 低于 50：0.1
  - 低于 150：0.5
  - 其余：1
  - 只把涨跌差额按档位朝零截断。（B）
- 股价走势图保留最近 144 个开市日（界面标题为「半年内股价走势线图」）。
- 大盘指数 = 12 支股价总和 × 10 取整。（B）

### 4.2 股票清单与初始数据
数据取自反编译表 `game_stocks[96]`，每图 12 支。格式为「初始价 / 市场流通股数 / 波动系数」。★ 表示在地图上有实体公司建筑，拥有经营权，公司保留的股份 = 10000 - 流通数，只能到公司现场用现金认购。每图★的数量与地图数据中的公司数一致：台 3、陆 4、日 6、美 6。

**原版 4 图**
- **台湾**：中國信託★ 100/10000/1.0；台灣人壽★ 40/5000/0.6；大宇百貨★ 25/10000/1.5；台積電 180/10000/1.6；大宇資訊 80/10000/1.2；台灣塑膠 60/10000/1.0；裕隆汽車 60/10000/1.4；遠東紡織 27/10000/0.9；統一超商 310/10000/0.7；震旦行 66/10000/1.0；萊爾富 171/10000/1.4；聯合報 280/10000/0.8
- **中国大陆**：上海銀行★ 70/10000/1.2；中國人壽★ 36/5000/1.0；王府井百貨★ 20/10000/1.6；中國石油★ 15/**0**/1.5（全部股份只能现场认购）；聯想科技 300/10000/2.0；頂新食品 296/10000/1.8；東方實業 133/10000/1.4；匯豐證券 170/10000/1.5；大慶石油 121/10000/0.8；長城電機 60/10000/0.4；長江建設 92/10000/0.6；大眾軟件 366/10000/1.0
- **日本**：富士銀行★ 160/10000/0.8；三井生命★ 99/5000/1.4；三越百貨★ 22/10000/2.0；日產建設★ 28/5000/2.0；ＳＥＧＡ★ 300/5000/1.0；豐田汽車★ 35/5000/1.2；松下電機 540/10000/1.0；日立機電 830/10000/1.0；ＳＯＮＹ 300/10000/1.2；三菱工業 225/10000/0.7；任天堂 300/10000/1.0；德間書店 150/10000/0.8
- **美国**：花旗銀行★ 200/10000/1.0；喬治亞人壽★ 55/5000/0.8；環球百貨★ 20/10000/2.0；聯合航空★ 18/5000/1.0；福特汽車★ 16/5000/1.4；ＩＢＭ★ 550/5000/2.0；德州儀器 245/10000/1.5；摩托羅拉（原文字形作「摩扥羅拉」）166/10000/1.3；迪士尼 955/10000/1.4；可口可樂 1030/10000/0.8；麥當勞 1440/10000/1.0；百事可樂 310/10000/1.2

**超时空之旅（资料片，非原版 4 图）**
- **太空**：行星銀行★ 50；銀河保險★ 40（5000）；宇宙百貨★ 25；火星移民 90；隕石礦業 45；星球電視 60；金星科技 60；星海通訊 27；銀河航運 110；月世界旅遊 66；宇宙地產 71；太陽能電力 80
- **仙剑/武侠**（12 支全部是★）：聚寶銀樓 70；狂徒鏢局 70（5000）；南北貨場 20；少林派 250（3000）；武當派 101（3000）；蜀山派 96（5000）；嵩山派 120（6000）；恆山派 47（4000）；泰山派 40（5000）；衡山派 30（4000）；華山派 90（5000）；逍遙客棧 300（4000）
- **侏罗纪**：黃金銀行★ 60；肥龍保險★ 33（5000）；飛龍百貨★ 22；雷龍電子 18；侏羅紀影業 100；長毛象紡織 15；迅猛汽車 40；恐龍蛋食品 30；火山岩保險 100；三葉蟲百貨 25；始祖化石 100；翼龍航空 50
- **纯商铺/度假**：假期銀行★ 100；假期百貨★ 33；狂徒大飯店★ 500（3000）；豪華大飯店★ 100（5000）；第一大飯店★ 130（5000）；金金大飯店★ 150（5000）；世界大飯店★ 70（5000）；百事可樂 66；狄士尼 55；可口可樂 30；麥當勞 44；愛迪達 30

### 4.3 交易规则
- **交易时机**：在自己的回合通过工具栏的「股市/交易」操作（有快捷键）。说明书 p.11 写「股票可随时交易但周日休市」。
  - 周日、节日休市和全面停市期间不能交易。
  - 单支股票被「暂停交易」（停牌）时，这支不能交易，价格冻结。
  - 住院或坐牢期间没有操作阶段，因此实际上不能交易。（A/B）
- **资金来源**：从股市买进**扣存款**，卖出所得**存入存款**，现金不能直接用来买。金额 = trunc(单价 × 股数)。社区「买剩下的会将存款清空」和 fandom 摘要「通常是存款，部分情况需用现金」都与此一致。（A）
- **每回合可买额度**：每位玩家回合开始时，对每支股票：
  ```
  若 市场流通数 ≤ 1000，额度 = 全部流通数
  否则 额度 = floor( 流通数 × (1000 + rand()%2000) / 10000 )，即流通数的 10%~29.99%
  ```
  买进同时扣减流通数和额度，卖出同时增加两者。界面显示为「交易量」。（B）
- 界面同时显示每位玩家的**平均成本**（加权平均）、持股比例、周均价、月均价、历史高低价和涨跌幅。
- **公司现场认购（亲购）**：停在★公司时，可用**现金**按 `int(公司价值 / 10000)` 的每股价格认购公司保留股份，每次造访合计最多 1000 股。认购款**不计入**公司盈余。各公司的「公司价值」存在地图数据里，**本次未取得**。（B；Steam 指南《全图上公司股票现金亲购价》有表但无法访问）
- 破产玩家的股份退回市场，按市价变现的钱进入乐透公共奖池。（B）

### 4.4 价格模型（每个开市日一次 tick）
来源：反汇编 `fcn_004291d6` 与 remake 的 `original_stock_market.gd`。rand 为 0..32767。
```
G = (rand() - 16384) / 4097                 # 全市场冲击，约 ±4
for 每支股票 s:
  prev = s.price; s.prev_price = prev
  if s.suspension > 0:              rate = 0          # 停牌价格不动
  elif s.event != 0:                rate = (s.event & 0xF0) ? +10 : -10
  else:
     shock = (rand() - 16384) / 1171                # 约 ±14
     rate = s.momentum + shock × s.volatility + G    # 动量随机游走，因此会形成趋势（「每支股票总会有一个山峰」）
     # 均值回归：
     if s 有公司: anchor = 公司价值/10000; up=3.0; lo=0.85
     else:        anchor = s.base_price(初始价); up=8.0; lo=0.5
     if prev > up×anchor:   rate = rate>0 ? rate×0.5 : rate×2
     elif prev < lo×anchor: rate = rate>0 ? rate×2   : rate×0.5
  s.momentum = clamp(rate, -10, +10)
  s.price = clamp(按档位截断(prev × (100 + s.momentum)/100), 1, 9999)
  记录走势（保留 144 天）
```
- 涨停/跌停判定：当日价 ≥ prev 涨 10% 后的档位价即为涨停；当日价 ≤ prev 跌 10% 后的档位价即为跌停；价格不变不算涨跌停。
- 复刻建议：用服务器端可存档的伪随机数，股价用「分」为单位的整数保存，避免浮点误差导致 4 个客户端显示不同。

### 4.5 红卡、黑卡与事件天数
- 事件字节 event 的高 4 位表示「强制涨」剩余天数，低 4 位表示「强制跌」剩余天数。每天在 tick **之前**先扣 1，周日也扣。
- 设置事件的当下会立刻以当日基准价重算一次 ±10%，并覆盖当日走势点。
- **红卡**：event = 0x20，**当天加下一个开市日各涨停一次（+10%）**。
- **黑卡**：event = 0x02，同样当天加下一个开市日各跌停（-10%）。
- 重复使用同色卡只重置天数，不叠加；使用反色卡会覆盖。
- 若周六出卡，周日照样扣天数，实际只有周六 1 天有效。
- 真人可以对停牌股出卡，AI 会排除停牌股。
- 点券价格：红卡 50，黑卡 30（数据表）；社区简书写红卡、黑卡都是 30，有冲突。（效果 A/B，价格 D）

### 4.6 影响股市和银行的新闻（新闻格落点抽取，共 36 条，循环抽）
- 「股市低迷不振重挫崩盘」/「股市气势如虹全面上涨」：12 支股票当日一起 -10%/+10%（event 为 1 或 0x10，只持续当天）。（B）
- 「股市暂停交易10天」：全市场停市。（A）
- 「%s股票暂停交易10天」：个股停牌。原文说 10 天，但 remake 按源码写的倒数值是 15，有冲突（D）。另有「%s股票恢复上市交易」解除停牌。
- 「公开表扬股市第一大户，%s获得%d元奖励」：持股**股数**最多者得 10000 × 物价指数，给现金。（B）
- 「公开表扬第一大地主」10000 × 指数；「公开补助土地最少者」5000 × 指数。（B）
- 三种税，都是 **5%**（A）：
  - 所得税：现金 × 5%。
  - 地价税：（地价 + 建筑）原值 × 5% × 物价指数。
  - **证交税**：股票市值 × 5% × 物价指数（B）。社区警告「证交税会把你直接带走」，与乘物价指数一致。
- 「银行挤兑停止放款15天」；「银行加发10%储金红利」。（A）
- 公司新闻：改变该公司的「本月/累积盈余」，并设置对应股票的事件：
  | 新闻 | 盈余变动 | 对股价的影响 |
  |---|---|---|
  | 工厂排放污水罚款 | -10000 | 跌停约 3 天 |
  | 违规开发山坡地罚款 | -10000 | 跌停约 3 天 |
  | 制造噪音公害罚款 | -5000 | 跌停约 3 天 |
  | 海外投资获利 | +20000 | 涨停约 3 天 |
  | 海外投资亏损 | -20000 | 跌停约 4 天 |
  | 获利调高一倍（本月盈余 > 10000 才会发生） | 本月盈余 ×2 | 涨停天数 = 原本月盈余 / 10000 |
  | 违法超贷 | 经营者坐牢 5 天 | — |

  金额数字 A，股价天数 B。
- 命运事件（命运格）：「股票违约交割损失股票%d%」「变卖所有股票求现」。第二条会让高杠杆玩家直接破产（社区）。具体比例和计价**未查到**。

### 4.7 经营权（大股东）与特权
- **持股最多的玩家自动成为该公司的「经营者」（董事长）**。持股相同时保留现任；没有现任时按玩家顺序。没人持股就没有经营者，公司也不收费。经营者停在自己公司免费。（A/B）
- 各类公司的特权和收费（细节属于公司主题，这里只列与股票相关的部分）：
  - **银行**：特别融资（§3.4）。
  - **百货**：经营者停留时免费随机获得一张卡片或一个道具（社区多方一致）。
  - **保险/人寿**：停留者用轮盘决定投保天数（5/3/30/20/15/10 天）；非经营者付「天数 × 费率 × 指数」；住院每天理赔 2000 × 指数，由保险公司的盈余支付。（B）
  - **电脑公司（如 IBM）**：非经营者付「费率 × 已进行天数」（社区「视游戏进行时间收电脑费」，B）。
  - **石油/汽车类**：骑机车或开汽车的人要付油费，约为 700 或 500 × 骰子点数 × 指数，汽车再 ×2，步行免费。（B）
  - **建设公司**：非经营者可以付费给自己的地产升一级；经营者免费升，最多 2 级。PTT 说「附送加盖一次」，有冲突。（B/D）
  - **航空等**：费率 × 骰子点数 × 指数。
- 其他玩家付给公司的费用计入公司的本月盈余和累积盈余，每月 15 日作为分红来源。

### 4.8 分红（每月 15 日）
- 每家公司：
  ```
  若 存活玩家持股合计 T > 0:
     每位股东得 trunc(本月盈余 × 持股 / T)   # 分母是玩家实际持股总数，不是 10000
  ```
  分完后本月盈余清零；无人持股则保留。个人取整后的余数不再另行分配。（A/B）
- **本月盈余为负时股东要按比例赔钱**：先扣存款，再扣现金，不够就破产（百科「股东们也需承担负额盈余」）。
- 界面显示「上市公司分红：人名 × 公司 × 本月盈余 × 红利」表。公司资讯显示保留股份、累积盈余、本月盈余、平均盈余、经营者。

---

## 5. 点券经济
- 点券是独立货币，**不能与金钱互换**（前作可以）。开局 0 点。

### 5.1 取得
| 渠道 | 数量 | 可信度 |
|---|---|---|
| 停在点券格 | +10 / +30 / +50 | A |
| 停在小游戏格：企鹅挖宝（冰上挖宝石）、射气球、喜从天降（福神赐福） | 按成绩给点，「射到多少分就是多少点券」，每局约 15 秒 | A/C |
| 走过地图上的「宝箱」 | **+500**（开局常用遥控骰子去抢），每月底重新出现在远处 | A |
| 商店卖出卡片或道具 | 标价 × 90% 取整（例：核子飞弹 250 → 225） | A |
| 命运「变卖所有卡片道具」 | 全部换成点券 | B |
| 研究所生产的道具（如核子飞弹）再卖掉 | 按上一行规则 | C |

### 5.2 消耗
| 用途 | 价格 | 可信度 |
|---|---|---|
| 商店（点券商店格，只在停留时开店）按标价买卡片或道具 | 见 5.3 | A |
| 医院/监狱保释（办理出院/出狱）其他玩家 | **30 点/人** | B |
| 在医院/监狱雇用「四大恶人」特殊人物 | **300 点** | A |

- 另外，某个特殊人物（疑似小偷）会「偷取某人一半点券」。（B/C）

### 5.3 点券价目（反编译数据表，两版相同）
- **卡片**：均富 200、均贫 200、购地 35、换地 25、换屋 20、转向 20、改建 15、拍卖 20、天使 160、恶魔 180、怪兽 60、拆除 15、抢夺 25、停留 20、冬眠 100、梦游 25、陷害 20、复仇 20、嫁祸 40（简书写 30）、免费 25、免罪 25、送神符 10、请神符 20、红卡 50（简书写 30）、黑卡 30、查税 35、涨价 35、查封 35、同盟 40、乌龟 70。
- **道具**：机器娃娃 15、路障 30、地雷 25、定时炸弹 25、机车 80、汽车 150、飞弹 100、遥控骰子 30、机器工人 30、时光机 40、传送机 95、工程车 150、核子飞弹 250。
- 上限：手牌最多 15 张；每种道具最多 9 个。

### 5.4 数量级
- 一局常见点券量在几十到几百；抢到宝箱一次就是 500。
- 高价卡（均富、均贫、恶魔、天使）约 160–200 点，雇特殊人物 300 点。
- 点券以 16 位整数存储。

---

## 6. 网页 4 人联机实现建议
- 服务器权威：日期、随机数、股价 tick、分红和月息全部在服务器端算，客户端只显示。
- 回合制交易：只在当前玩家的行动阶段开放「股市」面板。每回合开始时生成额度（§4.3），并广播到 4 端。
- 结算事件按 §1.2 的顺序做成事件队列：换日 → 物价指数 → 股市 → 15 日分红和乐透 → 月底利息和冠军评选。每步都推送结果弹窗。
- 数值类型：金额用 int64 并在 int32 上限处截断或保护；股价以「分」为单位的整数存储；点券 uint16。

## 7. 主要冲突与不确定点（详见 open_questions）
红卡价格、个股停牌天数、周日银行是否营业、各公司「公司价值」与收费参数、节日表、命运股票事件的比例，这几项都没有确定答案。


## entries
- **日历与过日规则** [时间系统] (high) 使用真实公历（闰年=年份整除4，星期以1998-01-01周四为基准）；所有存活玩家各走完一回合算过一天；开局日期取电脑本机日期 | 数值: 1回合轮=1天；日期上限9999-12-31 | src: https://github.com/nurockplayer/richman4-remake/blob/main/docs/calendar-and-setup.md, https://github.com/nurockplayer/richman4-remake/blob/main/docs/manual-rules.md, https://github.com/mytbk/rich4/blob/master/asm/rich4_getdate.c
- **每日结算顺序** [时间系统] (high) 日期+1 → 检查结束条件 → 更新物价指数 → 休市/停牌/红黑事件倒数 → 开市日股价tick → 15号分红与乐透开奖 → 换月做月底结算，并重新放置礼物/宝箱 | 数值: 15号：分红+乐透；换月：利息 | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_player_core_actions.asm, https://zh.wikipedia.org/zh-hans/大富翁4
- **休市日** [时间系统/股市] (high) 周日股市休市，界面显示「本日休市」；每张地图另有节日表，标记为休市的节日也休市；新闻可让全市场停市10天（周日也倒数） | 数值: 周日；节日表每图最多24项；全面停市10天 | src: https://github.com/nurockplayer/richman4-remake/blob/main/docs/manual-rules.md, https://github.com/mytbk/rich4/blob/master/asm/rich4.asm, https://github.com/nurockplayer/richman4-remake/blob/main/game/core/news_events.gd
- **开局资金、期限与资产目标** [时间系统/开局] (high) 大厅设置总资金、期限和资产目标倍数；真人开局现金与存款各一半，AI按角色现金比例分配；开局点券为0，物价指数为1 | 数值: 资金 300000/200000(默认)/100000/50000/30000/10000；期限 不限/730/365/182/91/30天；目标 不设/100/50/10/5/3倍；AI现金比例 50/40/70/60/40/70/50/40/60/50/55/80% | src: https://github.com/mytbk/rich4/blob/master/csrc/game_init.c, https://github.com/nurockplayer/richman4-remake/blob/main/docs/calendar-and-setup.md, https://zh.wikipedia.org/zh-hans/大富翁4
- **结束条件判定** [时间系统] (medium) 每天日期推进后，若已过天数≥期限，或最高净资产≥倍数×初始资金，则结束；净资产最高者胜，资产相同时玩家顺序在前者胜 | 数值: 比较用严格大于 | src: https://github.com/nurockplayer/richman4-remake/blob/main/docs/calendar-and-setup.md
- **月底结算：存款利息** [银行] (high) 换月时，没有贷款的玩家存款×1.1并截断取整；有贷款的不发利息。同时评选本期冠军（资产最多）和本期悲情人物 | 数值: 月息10%（常数 double 1.1） | src: https://github.com/mytbk/rich4/blob/master/asm/rich4.asm, https://github.com/nurockplayer/richman4-remake/blob/main/docs/manual-rules.md, https://zh.wikipedia.org/zh-hans/大富翁4
- **银行：经过与停留** [银行] (high) 经过银行格打开ATM，只能存提款；停在银行格时先ATM再进柜台，可借还贷款，银行董事长还可以特别融资；没有手续费 | 数值: 无 | src: https://github.com/nurockplayer/richman4-remake/blob/main/docs/manual-rules.md, https://github.com/mytbk/rich4/blob/master/asm/rich4_player_core_actions.asm, https://zh.moegirl.org.cn/zh-hans/大富翁4
- **贷款** [银行] (high) 停在银行才能借。额度为进入银行时计算的总资产减去已有贷款，借款直接存入存款；无利息；期限从第一笔起算，追加不延期，到期日遇休市日顺延；可部分还款（先扣存款再扣现金）；到期未还清就自动扣款，不足则破产；贷款期间不发月息 | 数值: 额度 = 总资产；期限 90 天（约3个月）；利息 0 | src: https://zh.wikipedia.org/zh-hans/大富翁4, https://m.ximalaya.com/ask/q7328827, https://github.com/mytbk/rich4/blob/master/asm/rich4_ui_bank.asm
- **银行特别融资（银行董事长）** [银行/股市特权] (high) 银行股经营者停在银行时，可无息、无期限地借用其他玩家的存款，拨入自己存款。其他人提款导致准备金不足时，由经营者垫付（先存款后现金，不足则破产）。融资额计入存款，不从总资产扣除 | 数值: 上限 = 其他玩家存款总和 | src: https://zh.wikipedia.org/zh-hans/大富翁4, https://m.ximalaya.com/ask/q7328827, https://disp.cc/ptt/C_Chat/1cCSV60s
- **银行相关新闻与命运** [银行] (medium) 新闻：银行挤兑停止放款（仍可存提款）；银行加发储金红利（立即给无贷款者）。命运：冒贷（强制加贷款）、支票跳票（银行拒绝往来，ATM也不能用）、侵入银行电脑（挪用他人存款） | 数值: 停止放款 15 天；储金红利 10%；拒绝往来 约1个月；挪用他人存款 各10%；冒贷金额未知 | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_news.asm, https://github.com/mytbk/rich4/blob/master/asm/rich4_fortune.asm, https://github.com/nurockplayer/richman4-remake/blob/main/game/core/news_events.gd
- **总资产公式** [总资产] (high) 总资产 = 现金 + 存款 − 贷款 + Σ持股×现价（截断）+ Σ自有住宅(地价 + 等级×建屋价，连锁店只算1份建屋价) + Σ设施(地价 + 等级×升级价)；地价用地图原始值，不乘物价指数；融资不扣除 | 数值: 资金上限 int32 2147483647 | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_calculate_player_wealth.asm, https://github.com/nurockplayer/richman4-remake/blob/main/docs/calendar-and-setup.md, https://www.zhihu.com/question/27850420
- **物价指数** [总资产/经济] (high) 每天重算：floor(存活玩家平均总资产 / 初始资金)，只升不降。乘在地价、建屋、租金、各类费用、新闻奖惩和税金上；股价、乐透票价、点券价格不乘 | 数值: 初值 1；免费卡触发门槛 2000×指数；社区称最高约 107374～214748 | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_update_price_index.asm, https://www.bilibili.com/read/cv28566011, https://www.jianshu.com/p/31547fb1e966
- **股市基本参数** [股市] (high) 每张地图12支股票，每支总股本10000股；股价两位小数；单日涨跌上限±10%；涨停不能买、跌停不能卖；无交易手续费 | 数值: 12支；10000股；价格 1～9999；±10%；手续费 0 | src: https://github.com/nurockplayer/richman4-remake/blob/main/game/core/original_stock_market.gd, https://github.com/mytbk/rich4/blob/master/asm/rich4_ui_stock.asm, https://zh.wikipedia.org/zh-hans/大富翁4
- **原版4图股票清单与初始价** [股市] (high) 台湾、中国大陆、日本、美国各12支；带★的有实体公司和经营权（台3、陆4、日6、美6），公司保留股份 = 10000 − 流通股；完整初始价、流通数、波动系数见总览 §4.2 | 数值: 例：中國信託★100、台積電180、統一超商310、中國石油★15（流通0）、日立機電830、麥當勞1440、可口可樂1030 | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_all_stocks.c, https://github.com/nurockplayer/richman4-remake/blob/main/docs/fidelity.md
- **超时空之旅4图股票清单** [股市（资料片）] (medium) 太空、仙剑/武侠、侏罗纪、纯商铺四图各12支，属于资料片而非原版4图（也不是4 Fun） | 数值: 例：行星銀行★50、少林派★250（流通3000）、狂徒大飯店★500（流通3000） | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_all_stocks.c, https://www.ddooo.com/softdown/105271.htm
- **股票交易时机与资金来源** [股市] (medium) 在自己的回合从工具栏打开股市交易；周日、节日、全面停市和个股停牌时不能交易；住院或坐牢时没有操作阶段。股市买进扣存款，卖出所得存入存款，界面显示平均成本 | 数值: 成交金额 = trunc(单价×股数) | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_stocks.asm, https://github.com/nurockplayer/richman4-remake/blob/main/docs/manual-rules.md, https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-statuses.md
- **每回合可买额度（交易量）** [股市] (medium) 每位玩家回合开始时，每支股票：流通数≤1000则全部可买，否则可买流通数的 10%～29.99%（随机）；买卖同时增减流通数和额度 | 数值: 额度 = floor(流通 × (1000 + rand%2000) / 10000) | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_stocks.asm, https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-companies.md
- **公司现场认购（亲购）** [股市] (medium) 停在★公司时用现金认购公司保留股份；认购款不计入公司盈余 | 数值: 每股 int(公司价值/10000)；每次造访最多 1000 股；各公司的公司价值未知 | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_stocks.asm, https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-companies.md, https://steamcommunity.com/sharedfiles/filedetails/?id=3489536813
- **每日股价波动模型** [股市] (medium) 涨跌率 = 前日涨跌率(动量) + 个股冲击×波动系数 + 全市场冲击，再做均值回归，最后限制在±10%；停牌股涨跌率为0；有红黑事件时强制±10%；按价格档位截断 | 数值: 全市场冲击 = (rand−16384)/4097；个股冲击 = (rand−16384)/1171；有公司的股票：价格>3×锚价时涨幅减半、跌幅加倍，<0.85×锚价时反之；无公司的股票用 8× 和 0.5× 初始价；档位 0.01/0.05/0.1/0.5/1（分界 5/15/50/150） | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_stocks.asm, https://github.com/nurockplayer/richman4-remake/blob/main/game/core/original_stock_market.gd, https://www.xiaopi.com/pc/gl/10461.html
- **红卡／黑卡** [股市/卡片] (medium) 指定一支股票，当天立即涨停（红）或跌停（黑），下一个开市日再涨停或跌停一次；同色卡重复使用只重置天数，反色卡覆盖；周日也扣天数 | 数值: 红卡事件 0x20（2天）、黑卡事件 0x02（2天）；价格：红50点、黑30点（数据表），简书称都是30点 | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_stocks.asm, https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-inventory.md, https://github.com/mytbk/rich4/blob/master/asm/rich4_card_table.c
- **股市相关新闻** [股市/新闻] (medium) 全面崩盘/全面上涨（12支当日±10%）；股市暂停交易；个股停牌与恢复交易；股市第一大户奖励；证交税、所得税、地价税；多种公司盈余新闻（同时驱动对应股票涨跌） | 数值: 停市10天；个股停牌原文10天（remake计数15）；大户奖励 10000×指数；三种税各5%（证交税=股票市值×5%×指数；所得税=现金×5%）；公司新闻 −10000/−10000/−5000/±20000/盈余×2 | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_news.asm, https://github.com/nurockplayer/richman4-remake/blob/main/game/core/news_events.gd, https://disp.cc/ptt/C_Chat/1cCSV60s
- **经营权（大股东/董事长）** [股市特权] (high) 持股最多者自动成为经营者；同额保留现任；没人持股则无经营者且公司不收费；经营者停在自家公司免费。特权：银行→特别融资；百货→免费随机卡片或道具；建设→免费加盖；保险、电脑、汽车/石油、航空等向非经营者收费，收入计入公司盈余 | 数值: 保险天数 5/3/30/20/15/10；保险理赔 2000×指数/天；油费约 700或500×骰子点数×指数（汽车×2） | src: https://www.pttweb.cc/bbs/Old-Games/M.1660361638.A.326, https://www.jianshu.com/p/31547fb1e966, https://zh.wikipedia.org/zh-hans/大富翁4
- **分红（股利）** [股市] (high) 每月15日把各公司本月盈余按持股比例分给股东（分母是玩家实际持股总数），计入存款；盈余为负时股东按比例赔付（先存款后现金，不足则破产）；有股东时分完清零 | 数值: 日期：15号；每人 trunc(盈余×持股/总持股) | src: https://zh.wikipedia.org/zh-hans/大富翁4, https://github.com/mytbk/rich4/blob/master/asm/rich4_ui_stock.asm, https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-oddities.md
- **乐透（与日期、资金相关）** [时间系统] (high) 停在乐透点可以用现金买号码；每月15号开奖，无人中奖则累积；票款和破产玩家的股票变现款进入同一个奖池 | 数值: 每张 1000 元（固定，不乘指数） | src: https://zh.wikipedia.org/zh-hans/大富翁4, https://github.com/mytbk/rich4/blob/master/asm/rich4_ui_letou.asm
- **点券获取** [点券] (high) 点券格（停留领取）；三种小游戏（企鹅挖宝、射气球、喜从天降），按成绩给点，每局约15秒；宝箱（走过拾取，每月重新出现）；商店卖出卡片或道具；命运「变卖所有卡片道具」换点。不能用钱换点券 | 数值: 点券格 +10/+30/+50；宝箱 +500；卖出价 = 标价×90%（取整）；开局 0 点；以uint16存储 | src: https://www.163.com/dy/article/HHK7NHS30546O9E5.html, https://zh.wikipedia.org/zh-hans/大富翁4, https://github.com/mytbk/rich4/blob/master/asm/rich4_player_core_actions.asm
- **点券用途** [点券] (high) 商店（停留时才开）按标价买卡片或道具；医院/监狱保释其他玩家；医院/监狱雇用「四大恶人」特殊人物 | 数值: 保释 30 点/人；雇用特殊人物 300 点；手牌上限 15 张，每种道具上限 9 个 | src: https://www.163.com/dy/article/HHK7NHS30546O9E5.html, https://zh.wikipedia.org/zh-hans/大富翁4, https://github.com/mytbk/rich4/blob/master/asm/rich4_ui_hospital.asm
- **卡片与道具点券价目** [点券] (medium) 商店标价（两版执行文件数据表相同） | 数值: 卡：均富200 均贫200 购地35 换地25 换屋20 转向20 改建15 拍卖20 天使160 恶魔180 怪兽60 拆除15 抢夺25 停留20 冬眠100 梦游25 陷害20 复仇20 嫁祸40 免费25 免罪25 送神符10 请神符20 红卡50 黑卡30 查税35 涨价35 查封35 同盟40 乌龟70；道具：机器娃娃15 路障30 地雷25 定时炸弹25 机车80 汽车150 飞弹100 遥控骰子30 机器工人30 时光机40 传送机95 工程车150 核子飞弹250 | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_card_table.c, https://github.com/mytbk/rich4/blob/master/asm/rich4_tool_table.c, https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-inventory.md
- **特殊人物偷点券** [点券] (low) 某个特殊人物（推测是小偷）遇到玩家时偷走其一半点券 | 数值: 被偷 = 持有点券 / 2（取整） | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_player_core_actions.asm
- **命运：股票事件** [股市/命运] (low) 「股票违约交割，损失股票%d%」和「变卖所有股票求现」会造成持股损失或强制清仓 | 数值: 比例和计价方式未查到 | src: https://github.com/mytbk/rich4/blob/master/asm/rich4_fortune.asm, https://disp.cc/ptt/C_Chat/1cCSV60s

## open_questions
- 说明书写「周日银行／股市休息」，但反编译的ATM和银行柜台入口都没有周日检查（周日只影响贷款到期日顺延）。周日到底能不能存提款和贷款，需要在原版里实测。
- 各地图的节日（休市）表没有解出来：每图最多24项，类型含固定日期等，可能按国家区分。
- 个股停牌新闻原文是「暂停交易10天」，但 remake 按源码写入的倒数值是15。实际是10个交易日、15个自然日，还是别的？
- 红卡点券价格：数据表是50，社区（简书）是30；嫁祸卡：数据表40，简书30。建议以数据表为准，但未在原版商店界面实测。
- 各★公司的「公司价值」（决定亲购每股价格和股价均值回归的锚价）、各公司的收费参数和类型，都存在地图数据里，本次未取得。Steam 指南 3489536813 可能有表，但访问被限流。
- 命运「股票违约交割损失股票%d%」的百分比、「变卖所有股票求现」的计价，以及「人头被盗用冒贷%d元」的金额和期限，都未查到。
- 证交税是否确实为「股票市值×5%×物价指数」？只有 remake 单方来源；社区只说「会被证交税带走」。
- 三个小游戏的点券奖励上限和计分公式未查（属小游戏主题）。
- 宝箱与礼物对应的地图物件编号只是推断（物件0xE：走过得500点、月底重新放置），礼物的具体内容未查。
- 悲情人物评分式中其余字段（反汇编玩家结构 +92/+96/+68）的含义没有完全确认；本期冠军和悲情人物是否有奖励未知。
- 点券以uint16存储，超过65535时是回绕还是封顶，未验证。
- 玩家能否在他人回合（或利用消息窗口的间隙）交易股票未知；按说明书和重制实现，只在自己回合的操作阶段交易。
- 贷款到期的检查时点（每日推进时，还是该玩家回合开始时）未完全确认。
- 物价指数是每天更新（反汇编）还是只在月底公布（社区说法），界面上何时显示变化未实测；计算确实是每天进行的。
- 银行特别融资「强制偿还%d元」的触发条件（例如失去董事长身份）未解读。
- 开局日期是否可在设置界面修改，还是固定为电脑当天日期，未确认。

## sources
- https://zh.wikipedia.org/zh-hans/大富翁4
- https://github.com/mytbk/rich4
- https://github.com/mytbk/rich4/blob/master/asm/rich4_all_stocks.c
- https://github.com/mytbk/rich4/blob/master/asm/rich4_stocks.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_ui_bank.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_ui_stock.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_player_core_actions.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_update_price_index.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_calculate_player_wealth.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_card_table.c
- https://github.com/mytbk/rich4/blob/master/asm/rich4_tool_table.c
- https://github.com/mytbk/rich4/blob/master/asm/rich4_news.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_fortune.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_ui_hospital.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_ui_prison.asm
- https://github.com/mytbk/rich4/blob/master/asm/rich4_ui_letou.asm
- https://github.com/mytbk/rich4/blob/master/csrc/game_init.c
- https://github.com/mytbk/rich4/blob/master/docs/global_vars.txt
- https://github.com/nurockplayer/richman4-remake
- https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-companies.md
- https://github.com/nurockplayer/richman4-remake/blob/main/docs/calendar-and-setup.md
- https://github.com/nurockplayer/richman4-remake/blob/main/docs/manual-rules.md
- https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-inventory.md
- https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-news.md
- https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-oddities.md
- https://github.com/nurockplayer/richman4-remake/blob/main/docs/original-statuses.md
- https://github.com/nurockplayer/richman4-remake/blob/main/docs/fidelity.md
- https://github.com/nurockplayer/richman4-remake/blob/main/game/core/original_stock_market.gd
- https://github.com/nurockplayer/richman4-remake/blob/main/game/core/news_events.gd
- https://github.com/nurockplayer/richman4-remake/blob/main/game/core/fate_events.gd
- https://github.com/nurockplayer/richman4-remake/blob/main/game/core/game_state.gd
- https://m.ximalaya.com/ask/q7328827
- https://www.163.com/dy/article/HHK7NHS30546O9E5.html
- https://www.jianshu.com/p/31547fb1e966
- https://disp.cc/ptt/C_Chat/1cCSV60s
- https://www.pttweb.cc/bbs/Old-Games/M.1660361638.A.326
- https://forum.gamer.com.tw/C.php?bsn=972&snA=1794
- https://www.bituzi.com/2014/05/4.html
- https://sygl.17173.com/content/05192016/161041458.shtml?_platform=PC
- https://www.bilibili.com/read/cv28566011
- https://zh.moegirl.org.cn/zh-hans/大富翁4
- https://cdn.akamai.steamstatic.com/steam/apps/2059810/manuals/%E5%A4%A7%E5%AF%8C%E7%BF%814%E8%AA%AA%E6%98%8E%E6%9B%B8.pdf