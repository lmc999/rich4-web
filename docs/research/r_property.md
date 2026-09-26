# 大富翁4：地产与建筑（可直接用作设计规格）

## 0. 证据来源与可信度说明

- **主证据（A）**：公开的逆向工程资料，对象是原版 `rich4.exe`（v3.11，含资料片、共 8 张地图）。
  - `oama1111/rich4-spec`：附虚拟地址的逆向规格，并用原版机器码做了差分测试。
  - `oama1111/rich4-remake-public`：1:1 复刻源码，每条规则都附 `@source VA`。
  - 两者是同一作者，按**一个来源**计。
- **社区佐证（B）**：
  - B 站蓝水夜《大富翁4 图文攻略》（cv28566011）。
  - 巴哈姆特「大富翁四商業用地使用教戰」「五個冷知識」「最大物價指數」。
  - 中文维基「大富翁4」、网易号文章。
- 萌娘百科、百度百科、Fandom 大宇大富翁 wiki 被 403 或 Cloudflare 验证拦截，**未能交叉核对**。
- 凡是只有逆向一方的数值，confidence 都标 medium。逆向与社区一致的标 high。
- 巴哈「21 張地圖土地價格」一帖是《大富翁4 Fun》的数据，**不属于原版**，只用于佐证台北地价同为 2500。

---

## 1. 地块种类与基础数据

地图上与地产相关的格子分三类。节点 `type` 字段的编码是：住宅 `2000+i`、设施 `4000+i`、企业 `6000+i`。

| 类别 | 原版称呼 | 占格 | 能否购买 | 说明 |
|---|---|---|---|---|
| 普通土地 / 住宅用地 | 住宅地 | 1 格 | 可买，可盖 0~5 级；可用改建卡改成连锁店 | 每块地有**区名**（例如「台北市」），同一区通常有好几块同名地 |
| 大块地 / 商业用地 | 設施 | 2 格（地图统计：118 个设施节点对应 59 个设施） | 可买，再建五种建筑之一 | 公園、旅館、購物中心、加油站、研究所 |
| 上市企业格 | 企業（銀行、百貨、航空等） | — | **不能当地产买**，归属由股票最大股东决定 | 本主题只涉及建设公司 |

8 张地图的数量：

- 住宅地块：50 / 73 / 49 / 55 / 47 / 60 / 55 / 0。
- 设施：4 / 8 / 5 / 8 / 5 / 3 / 6 / 20。

**每块住宅地的地图烘焙数据**（地图文件自带，与等级无关）：

- `land_price`（地价，u16）
- `house_price`（房价，u16，即每级升级费的基数）
- `rent[0..5]`（6 档**按等级的租金表**，u16，严格递增）

实测示例（地图 0）：

| 地块 | 地价 | 租金表 rent[0..5] |
|---|---|---|
| 台北市 ×4 块 | 2500 | 500, 1200, 3000, 7500, 16000, 30000 |
| 新竹市 | 1000 | 200, 500, 1200, 2800, 6000, 10000 |

- 0 级租金恰好是地价的 20%。
- 租金表**不是由公式算出来的**，复刻时必须按每块地单独配置。
- 各地图完整的房价和租金表需要从原版 `MAP.MKF` 提取（见 open_questions）。

**运行期字段**（地图文件里全是 0）：

- `owner`：0 表示无主，否则为玩家序号 +1。
- `level`：0~5。
- `type`：0 表示住宅，1 表示连锁店。
- `price_status`：0x50 表示涨价中，0x51 表示查封中，高 4 位是剩余天数。
- `flast`：地契到期日。

**设施数据**：

- `land_price`（地价）。
- `rate[0..5]`：其中 `rate[0]` 就是房价（加盖费基数），`rate[1..5]` 是 1~5 级费率。
- 实测形如 `[1000, 750, 1750, 4000, 8000, 15000]`。
- 巴哈攻略称设施地价最低为 4000。

> 注：B 站攻略说「地价从 100-600 不等」，与逆向实测（台北 2500、新竹 1000）以及 4Fun 数据（台北 2500）都矛盾，不采用。

---

## 2. 物价指数（PI）——所有金额的乘数

- **更新时机**：每天推进时更新。
- **公式**：`PI = max(旧PI, trunc( trunc(Σ在场玩家总资产 / 在场人数) / 开局资金 ))`。
  - 两次都是整数除法、向零取整。
  - **只升不降**。
- **作用对象**：买地价、升级费、所有过路费、拍卖起拍价、税金等，全部要乘 PI。
- 资产和过路费都是 32 位有符号整数，超过 2,147,483,647 会回绕成负数。
  - 社区实测过路费最高 2,147,368,000。
  - 最大 PI 为 107374（巴哈、B 站），理论最高 214748（B 站）。

---

## 3. 普通地产：购买与升级

### 3.1 等级（6 档，0~5）

| 等级 | 名称 |
|---|---|
| 0 | 空地 |
| 1 | 平房 |
| 2 | 店铺 |
| 3 | 商场 |
| 4 | 商业大楼 |
| 5 | 摩天大楼（最高） |

依据：B 站攻略、搜索摘要，逆向中 `level < 5` 才可续建，维基记为「最高五層」。

### 3.2 落点判定（只有「停在」该格才触发，经过不触发）

**无主地：可购买**

- 价格 = `(地价 + 房价 × 当前等级) × PI`。
  - 无主地可能带着旧房子，例如破产释放或地契到期留下的，这时房子要连同地价一起买。
- 以下情况不能买：
  - 梦游中；
  - 被土地公附身（因为土地公会直接强占，见 §8）；
  - 被小衰神、大衰神或死神附身（这三者禁止一切买地和盖房）。
- **只能用现金**，存款不算。
  - 判定为 `价格 > 现金` 时不能买，恰好相等可以买。
  - 现金不足时提示「您的現金不足！」。
  - 买地盖房**不会导致破产**。

**自己的地：可加盖一层**

- 费用 = `房价 × PI`。**每一级都一样**，不随等级递增。
- 每次停留只能盖 1 层。
- 以下情况不能盖：已满 5 级；是连锁店；梦游中；衰神或死神附身；现金不足。
- **福神**（小、大都算）附身时，以下五种操作都会**额外白送一层**：买地、买设施、设施首建、设施加盖、自有地升级。

**别人的地**：付过路费，见 §4。

### 3.3 电脑是否购买

条件为 `现金 + 存款 − 价格 > min(trunc(开局资金 × 5%), 7000) × PI`。

- 原版没有估值或同区协同的判断，只看买完之后还剩多少钱。

---

## 4. 住宅过路费

### 4.1 基础公式（calculate_land_toll，VA 0x419744）

```
落点是住宅（type==0）：
  base = Σ rent[level]
         对象 = 同一地主拥有的、**同名（同区）**、且 type==0 的所有地块
落点是连锁店（type!=0）：
  base = 2000 × 该地主拥有的连锁店总数（全地图，不看区名）
toll = base × PI
```

- 所谓「连成一片」的加成，**是把同区每块地的等级租金直接相加**，而不是乘一个系数。
  - 社区说法「连成一片一起收、金额翻倍」只是粗略描述。
- 空地（0 级）只要有主，也会收 `rent[0] × PI`。
- 连锁店**不计入**区段租金的累加。所以把某区的一块房子改成连锁店，会降低该区其余地块的过路费。

### 4.2 加成与分账

**涨价**

- 条件：落点那块地的 `price_status ≠ 0`（涨价中）。
- 效果：**地主那一份** ×2。

**同盟**（同盟卡，7 天）

- 地主有盟友时，再按同样规则算出**盟友名下同名地块**（或盟友的连锁店）的租金，加进总额。
- 分账方式：
  - 盟友应得 = `trunc(总额 × (盟友份 / 总额))`，其中比例按单精度浮点计算；
  - 地主应得 = 总额 − 盟友应得；
  - 先付给地主，再付给盟友。
- 盟友之间互相免收过路费。

**神明（看付款方身上附的神）**

| 神明 | 效果 |
|---|---|
| 小财神 | ÷2（算术右移） |
| 大财神 | 免付（=0） |
| 小穷神 | ×1.5（`toll + (toll >> 1)`） |
| 大穷神 | ×2 |
| 福神 | 不影响过路费 |

### 4.3 免收条件（VA 0x41d559，按判定顺序）

1. 落点地块处于查封中（高、低两个半字节都非 0）；
2. 地主与付款人同盟；
3. 地主被死神附身；
4. 地主**住旅馆中**；
5. 地主消失中（出国、被绑架）；
6. 地主**坐牢中**；
7. 地主**住院中**；
8. 地主冬眠中；
9. 地主梦游中。

维基「坐牢、住院时他人免付過路費」与此一致。

### 4.4 付款流程

- 走通用付款函数：先扣现金，不足扣存款，两者都空就**破产**（贷款额度不会被动用）。
- 付款前，付款人可以打出被动卡：
  - **免费卡**：电脑在 `过路费 > 现金` 或 `过路费 > (rand%3000+3000)×PI` 时使用；
  - **嫁祸卡**：可转给别人付。
- 被死神附身的玩家会替其他人付钱。

---

## 5. 连锁店

- **产生方式**：对**自己脚下**、等级 ≥1 的住宅使用改建卡（15 点）。
  - 效果是 `type ^= 1`；变成连锁店时，等级高于 1 的一律压到 1。
  - 对连锁店再用一次改建卡会变回住宅，保持 1 级。
- **限制**：连锁店不能升级。天使卡或机器工人只能把 0 级连锁店提到 1 级。
- **过路费**：`2000 × 拥有连锁店数 × PI`。涨价时地主那一份 ×2，同盟时盟友的连锁店也会并入。
  - 巴哈、B 站均记为「2000 元/家」。
- **估值**：`地价 + 房价`，不乘等级。
- **被拆时**：拆除卡、飞弹等「拆一级」效果会直接**夷平成 0 级住宅**。

---

## 6. 大块地（商业用地 / 设施）

### 6.1 取得与建造

| 步骤 | 条件 | 费用 |
|---|---|---|
| 买无主设施地 | 停在上面；不在梦游中，没有土地公附身 | `设施地价 × PI` |
| 首建（0→1 级，选类型） | 停在自己的 0 级设施地 | **再付一次** `设施地价 × PI` |
| 加盖（≥1 级） | 停在自己的设施上，且未到该类型上限 | `房价(rate[0]) × PI` |

- 首建由真人从五种建筑里选一种。
- 电脑首建用 `rand()%4+1` 决定类型，所以**电脑永远不盖公园**。
- **类型等级上限**：公园 1、旅馆 5、购物中心 5、加油站 1、研究所 5。
- 设施收费**没有同盟分账**。
- 查封、同盟、死神及地主受阻这几条免收规则同样适用于设施。

### 6.2 五种建筑

| 建筑 | 最高等级 | 对他人的收费 | 其他效果 |
|---|---|---|---|
| 公園 | 1 | 不收费 | 无；只能靠改建卡改成别的建筑，或拆掉后重建 |
| 旅館 | 5 | 转盘得 N（1~4），`费 = rate[等级] × PI × N`（涨价时 ×2），**并强制住宿 N 天** | 住宿期间不能行动、不能收租；免费卡对旅馆无效；大财神让费用归 0 时也不必住宿 |
| 購物中心 | 5 | 转盘得消费倍数 M（1~6，均匀），`费 = rate[等级] × PI × M`（涨价时 ×2） | 无 |
| 加油站 | 1 | `掷骰总步数 × 500 × k × PI`；步行不收费 | k 取决于付款人的交通工具：机车 1、汽车 2、工程车 4 |
| 研究所 | 5 | 不收费 | 业主停在自己的研究所上（未被查封、未梦游）可以选择研发项目 1..等级 |

**旅馆转盘**：12 格，随机起点顺时针走到第一个数字。

| 天数 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| 概率 | 4/12 | 3/12 | 2/12 | 3/12 |

- 期望约 2.33。
- 巴哈攻略按「平均 2.5」估算。

**加油站**：

- 机车每步 500，汽车每步 1000（与巴哈一致）。
- 按逆向，工程车每步 2000。

**研究所的研发项目**：

| 项目 | 道具 | 卖出点数（九折） |
|---|---|---|
| 1 | 机器工人 | 27 |
| 2 | 时光机 | 36 |
| 3 | 传送机 | 85 |
| 4 | 工程车 | 135 |
| 5 | 核子飞弹 | 225 |

- 这 5 种道具的标价分别为 30、40、95、150、250 点，商店买不到。
- **研发一律 5 天**，只在业主自己的回合倒数，到期直接发给业主。
- 研究所被拆到低于项目等级时，研发作废。
- 电脑固定选当前最高一档。

**住旅馆的附带影响**：

- 该玩家记一笔「本月意外损失」：`2000 × 天数 × PI`。投保了保险的话，按这个数额理赔。
- 敌意：+20 × 天数 × PI。

**研究所策略**：巴哈建议用最便宜的 4000 地来盖研究所。

### 6.3 设施相关的卡片与道具

- **改建卡**：对脚下 ≥1 级的设施使用，可以改成任意一种类型。
  - 改成公园或加油站时，等级压到 1；其他类型保留原等级。
  - 电脑用改建卡时：自己的公园改成 `rand%4+1`；对手的设施改成**公园**。
- **换屋卡**会连同设施类型一起互换，而且不检查等级上限（原版如此）。

---

## 7. 其他加盖途径

| 途径 | 效果 |
|---|---|
| 天使卡（160 点） | 选一块地，**同名整区所有地块各 +1 级**，不看归属；对设施只 +1 级。设施为 0 级时首建公园（电脑拿自己设施用时随机选类型） |
| 机器工人（研究所 1 级道具） | 选一块地**免费 +1 级**，不看归属，不花钱 |
| 天使（神明）附身 | 每次落脚，在该格加盖一层（不看归属） |
| 建设公司（企业，行业 11） | 别人停在上面：选自己的一块地免费 +1，再付 `该地地价 × PI` 的工程费给董事长；董事长本人停上去免费加盖（社区说法为「可升两层」） |
| 福神附身 | 买地、盖房时多送一层 |
| 魔法屋 | 选项里有「就地加盖房屋」 |

---

## 8. 破坏与降级规则

内部有一个通用的 `mutate_land` 函数，分三种模式：

- **模式 0（拆一级）**：
  - 住宅：`level − 1`；
  - 连锁店：直接变成 0 级住宅；
  - 设施：`level − 1`，降到 0 级时类型变回公园。
- **模式 1（清除）**：`owner`、`level`、`type`、地契全部清零，也就是**变成无主空地**。
- **模式 2（夷平）**：`level` 变 0，`type` 变回住宅或公园，**归属保留**。

拆设施到 0 级（模式 0/2）以及设施被清除（模式 1）时，原版会把**全场被关押的玩家**设为次日释放。这是逆向发现，已做差分验证。

| 手段 | 作用范围 | 效果 | 其他 |
|---|---|---|---|
| 拆除卡（15 点） | 一处地产或设施；不能对自己的、不能对空地；也可以拆路障、地雷、定时炸弹 | 模式 0：住宅 −1 级，连锁店夷平，设施 −1 级 | 敌意 30×PI |
| 怪兽卡（60 点） | 一处 | 模式 2：直接夷平到 0，**地仍归原主** | 敌意 等级×30×PI |
| 恶魔卡（180 点） | **同名整区**所有住宅地（设施只影响一处） | 全部夷平到 0，连锁店退回住宅，归属不变 | 每块有主地记敌意 等级×30×PI |
| 飞弹（道具，100 点） | 以目标为中心的方窗（半宽 100 像素，社区说约 3×3） | 窗内每块住宅和设施 −1 级（连锁店夷平），**归属保留**；窗内的人住院 3 天并毁掉交通工具 | 社区说住院 5 天，存在矛盾 |
| 核子飞弹（研究所 5 级） | 整个 440×440 画面 | 窗内地产**变成无主空地**（owner、level、type、地契全清）；人住院 3 天 | 社区说「范围 9×9、住院 5 天」 |
| 工程车（研究所 4 级） | 持续 7 天 | 社区说：行进途中把经过的**对手房屋拆成空地** | 逆向只确认了 7 天期限，以及作为交通工具时按 k=4 付油费；拆房机制逆向**未决** |
| 恶魔（神明）附身 | 每次落脚 | 该格若有房屋就拆一层（空地不拆） | 敌意 30×PI |
| 新闻 4「外星人攻打地球」 | 随机一处有房的地为中心，半径 100 | 重击：同核弹，变为无主空地；范围内的人住院 3 天 | 不记敌意 |
| 新闻 5「外星怪兽袭击」 | 随机一处有房地产或设施 | 模式 1，清成无主空地 | — |
| 新闻 15「民宅瓦斯爆炸」 | 随机一块有房的住宅 | −1 级 | — |
| 新闻 18「强烈地震」 | 随机抽中住宅时影响**同名整区**；抽中设施时只影响该处 | 各 −1 级 | — |
| 新闻 19「山洪爆发土地流失」 | 随机任一地产或设施 | 模式 1，变成无主 | — |
| 新闻 20「超级台风」 | 随机中心，半径 100 | 窗内所有地产和设施 −1 级 | 不打人，不记敌意 |
| 新闻 21「龙卷风」 | 随机任一地产或设施 | −1 级 | — |
| 命运「强制拆除房屋一栋」 | 该命运卡自身的效果 | — | — |

---

## 9. 所有权转移、交易、拍卖

### 9.1 地产类卡片

| 卡片 | 点数 | 效果 | 限制与说明 |
|---|---|---|---|
| 购地卡 | 35 | 对脚下**他人的**住宅或设施强制购买，价格 `(地价 + 房价 × 等级) × PI`，付给原主 | 只用现金；无主地、自己的地、现金不足时都失败且不扣卡 |
| 换地卡 | 25 | 两块地（或两处设施）互换**归属**，房子跟着地走 | 必须站在其中一块上使用 |
| 换屋卡 | 20 | 两处互换**房屋**（类型和等级），归属不变 | — |
| 涨价卡 | 35 | 同名整区 5 天，地主那一份过路费 ×2 | 与查封卡写入同一个字节，后用者覆盖前者 |
| 查封卡 | 35 | 同名整区 5 天停收过路费 | 被查封的研究所不能研发 |

### 9.2 拍卖系统（run_auction）

**触发来源**：拍卖卡（20 点，只能拍对手的地）、破产清算、新闻 7「公开拍卖公有土地一处」、魔法屋。

**起拍价与竞价**：

- 起拍价 = `trunc(地价 × (1 + 等级 × 0.5)) × PI`，先取整再乘 PI。
- 加价档：+100、+500、+1000、+5000、+10000。另有 PASS 和「放弃」两个按钮。
- PASS 只保持到下一次有人成功加价为止。
- 不能出价超过自己的现金。

**成交与流拍**：

- 成交款付给**发起人**：用拍卖卡时是用卡者（社区说法为「拍卖金额归自己所有」）。
- 新闻 7 和破产清算没有卖方，成交款进公库（乐透奖池）。
- 发起人不能参与竞价；原地主可以举牌买回自己的地。
- 用拍卖卡时如果**流拍**，这块地**变成无主**。

**电脑的心理价位**：

```
factor   = rand/32767 × 0.3 + 0.5
scarcity = 6 − 4 × 无主地比例
v1 = ((等级 >> 1) + 1 + 已拥有同名块数) × 起拍价 × PI × scarcity × factor
v2 = 地价 × PI × (3 + rand/65536)
心理价位 = min(v1, v2, 现金)
```

### 9.3 公布栏（玩家间二级市场，快捷键 X）

- 每人 7 个挂牌槽，可以挂股票、地产或设施、道具、卡片。
- 真人自行输入标价。系统显示「市价」`(地价 + 等级 × 房价) × PI`，输入上限为市价的 10 倍。
- 买家**用现金**付给卖家。
- 电脑每回合有 1/4 概率买别人挂的股票或地产。买地产的条件：`3 × 估值 > 标价` 且 `现金 > 2 × 标价`。

### 9.4 空地被占领与所有权丢失

**土地公附身**：落脚格如果不是自己的，**直接归自己，不付钱**（别人的也照占）。

- 设施也照占。
- 住旅馆期间不触发（社区：「旅馆要先住宿再占领」）。
- 被占的地主只增加敌意，**不获得补偿**。
  - rich4-spec 的 gods.md 把这笔记成「补偿金」，复刻方后续审计已更正为敌意更新 0x40df69。

**地契年限**（开局设置「土地权限」）：

- 选项：无限期 / 2 年 / 1 年 / 6 个月 / 3 个月 / 1 个月。
- 买地（包括拍卖得到无主地、土地公强占）时写入到期日。
- 到期当天变为**无主，房子保留**。判定是日期相等，不是「已过期」。

**破产**：

- 名下所有住宅和设施变为**无主（等级保留）**，地契清零。
- 股票卖出，所得进公库；卡片和道具变卖。
- 释放的地产数 **> 3 处**时，从中随机抽 **3 处**依次拍卖，成交款进公库。**≤ 3 处则一处都不拍**。
- 维基记为「破產（限三次）」。
- 如果这次破产导致对局结束，则整个清算跳过，地产原样保留。

**其他**：新闻 5、19 以及核弹会把地清成无主。

### 9.5 变卖与抵押

- 原版**没有抵押系统**，也**不能把地产卖回给银行**。已查过银行、破产、公布栏的相关流程。
- 地产变现只有三种途径：公布栏挂牌、拍卖卡（只能拍对手的地）、破产清算。
- 银行贷款额度按「总资产」计算（包含地产）：
  - 期限 90 天，无利息；
  - 贷款进入存款账户；
  - 到期还不上就破产。

---

## 10. 资产估值与税

- **总资产** = 现金 + 存款 − 贷款 + Σ 股票市值 + 各项地产，其中地产按以下方式计：
  - 住宅：`地价 + 等级 × 房价`；
  - 连锁店：`地价 + 房价`；
  - 设施：`地价 + 等级 × 房价`；
  - **这一步不乘 PI**。
- **新闻 12「地价税 5%」**：`trunc(Σ(地价 + 房价 × 等级) × 0.05) × PI`，交给公库。
- **新闻 6 / 14**：随机抽一块地，**同名整区地价 ×1.3 或 ×0.7**（抽中设施则只影响该处）。
  - 只改地价，**租金表不变**，所以过路费不受影响。
  - 地价变化会影响买地价、拍卖价、估值和地价税。
- **流氓（恶人）**勒索保护费：逆向为 `Σ 同名同主地价 × PI`，社区说法为「地价 × 5 × 级别」，两者冲突。

---

## 11. 复刻实现要点（状态字段建议）

- **住宅地块**：`{id, name(区名), landPrice, housePrice, rent[6], owner, level, type(0住宅/1连锁), priceStatus, tenure}`。
- **设施地块**：`{id, name, landPrice, rate[6](rate[0]=房价), owner, level, type(0公園/1旅館/2購物中心/3加油站/4研究所), priceStatus, tenure, researchProject, researchDays}`。
- **所有「路段 / 整区」效果都按区名匹配**，包括：过路费累加、涨价卡、查封卡、天使卡、恶魔卡、地震、新闻 6/14、流氓。
- **两种付钱方式要区分**：
  - 买东西（买地、盖房、买设施）**只扣现金，失败即放弃**；
  - 付费（过路费等）按现金→存款的顺序扣，扣不出来就破产。


## entries
- **地产等级与名称** [普通地产] (high) 住宅地有 6 档等级：0 空地、1 平房、2 店铺、3 商场、4 商业大楼、5 摩天大楼。只能在 level<5 时续建，等级越高租金越高。 | 数值: 6 档（0~5），最高 5 级 | src: https://www.bilibili.com/opus/875661802094985219, https://zh.wikipedia.org/wiki/%E5%A4%A7%E5%AF%8C%E7%BF%814, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/land.ts
- **买地价格** [普通地产] (medium) 停在无主地上可以购买，价格包含地上已有的房子。只用现金，存款不算，现金恰好等于价格也能买。梦游、土地公附身、衰神或死神附身时不能买。 | 数值: 价格 = (地价 + 房价 × 当前等级) × 物价指数；判定为 价格 > 现金 时不能买 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/land.ts, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/purchase.ts
- **升级（加盖）费用** [普通地产] (medium) 停在自己的住宅地上，每次可以加盖 1 层。每一级费用相同，不随等级递增。连锁店、满级、梦游、现金不足时不能盖。 | 数值: 每级费用 = 房价(house_price) × 物价指数 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/land.ts, https://github.com/oama1111/rich4-remake-public/blob/main/docs/audit/provenance-econ.md
- **租金表（按等级）** [普通地产] (medium) 每块地自带 6 档租金表，属于地图数据，不是由公式计算出来的。租金严格递增，地价越高的区租金整体越高。 | 数值: 地图 0 实测：台北市 地价 2500，租金 [500, 1200, 3000, 7500, 16000, 30000]；新竹市 地价 1000，租金 [200, 500, 1200, 2800, 6000, 10000]；0 级租金为地价的 20% | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/toll.test.ts, https://github.com/oama1111/rich4-spec/blob/main/docs/systems/land-rent.md, https://forum.gamer.com.tw/C.php?bsn=972&snA=2030
- **住宅过路费公式（同区累加）** [过路费] (high) 停在别人的住宅上时，把地主名下所有同名（同区）住宅的 rent[level] 相加，再乘物价指数。空地（0 级）也收 rent[0]。连锁店不计入。只有停留才收，经过不收。 | 数值: toll = Σ rent[level] × PI | src: https://github.com/oama1111/rich4-spec/blob/main/docs/systems/land-rent.md, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/toll.ts, https://www.bilibili.com/opus/875661802094985219
- **连锁店** [过路费] (high) 对自己脚下等级 ≥1 的住宅使用改建卡，可改成连锁店，等级压到 1。连锁店不能升级。踩到任意一家，都要按地主全图连锁店的总数收费。连锁店不计入区段累加，被拆一级即变回 0 级住宅。 | 数值: toll = 2000 × 连锁店数 × PI；改建卡 15 点；估值 = 地价 + 房价 | src: https://github.com/oama1111/rich4-spec/blob/main/docs/systems/land-rent.md, https://forum.gamer.com.tw/C.php?bsn=972&snA=2175, https://www.bilibili.com/opus/875661802094985219
- **涨价 / 查封标记** [过路费] (high) 涨价卡和查封卡都作用于同名整区，持续 5 天，每天递减。涨价中的落点地块，地主那一份过路费 ×2（盟友份不翻倍）；查封中免收过路费，被查封的研究所也不能研发。两张卡写入同一个字节，后用的覆盖先用的。 | 数值: 涨价写 0x50、查封写 0x51，均为 5 天；涨价 ×2；两卡各 35 点 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/land-mutation.ts, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/rent.ts, https://www.bilibili.com/opus/875661802094985219
- **同盟对过路费的影响** [过路费] (high) 盟友之间互相免收过路费。地主有盟友时，盟友名下同名地块的租金也并入总额，再按两份租金的比例分账：先付地主，再付盟友。 | 数值: 盟友应得 = trunc(总额 × float32(盟友份 / 总额))；同盟卡 40 点、7 天（社区） | src: https://github.com/oama1111/rich4-remake-public/blob/main/docs/money-flow.md, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/rent.ts, https://www.bilibili.com/opus/875661802094985219
- **神明对过路费的修正** [过路费] (high) 按付款方身上附的神明修正过路费，住宅和设施都适用。福神不影响过路费。 | 数值: 小财神 ÷2；大财神 0；小穷神 ×1.5（toll + toll>>1）；大穷神 ×2 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/god-toll.ts, https://www.bilibili.com/opus/875661802094985219
- **免收过路费的九种情形** [过路费] (high) 按以下顺序判定，命中任一条就免收：落点查封；地主与付款人同盟；地主被死神附身；地主住旅馆；地主消失中；地主坐牢；地主住院；地主冬眠；地主梦游。住宅和设施都适用。 | 数值: 9 条 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/toll-flow.ts, https://zh.wikipedia.org/wiki/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **付款与破产的区别** [规则] (medium) 买地、盖房、买设施只扣现金，现金不足就放弃，不会破产。过路费等付款先扣现金、再扣存款，两者都不够就破产，不会动用贷款。 | 数值: 无 | src: https://github.com/oama1111/rich4-remake-public/blob/main/docs/money-flow.md, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/bankruptcy.ts
- **物价指数** [经济] (high) 每天更新一次，只升不降。所有地价、升级费、过路费、起拍价都要乘它。 | 数值: PI = max(旧, trunc(trunc(Σ在场资产 / 人数) / 开局资金))；最大实测 107374，理论 214748；32 位上限 2147483647 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/wealth.ts, https://forum.gamer.com.tw/C.php?bsn=972&snA=2034, https://www.bilibili.com/opus/875661802094985219
- **大块地：购买、首建、加盖** [商业用地] (medium) 大块地占 2 格。停在无主的设施地上可以购买；停在自己 0 级的设施地上，选一种建筑首建；之后每次停留可加盖一层。电脑首建用 rand%4+1，所以永远不盖公园。 | 数值: 购买 = 设施地价 × PI；首建（0→1）= 设施地价 × PI；加盖 = rate[0](房价) × PI；等级上限：公园 1、旅馆 5、购物中心 5、加油站 1、研究所 5 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/facility.ts, https://www.bilibili.com/opus/875661802094985219, https://zh.wikipedia.org/wiki/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **公园** [商业用地] (high) 不向任何人收费，只有 1 级，不能升级，要改建成别的建筑只能用改建卡或拆掉重建。电脑会用改建卡把对手的设施改成公园。 | 数值: 最高 1 级；收费 0 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/facility.ts, https://www.163.com/dy/article/HJ95G6PE0546O9E5.html, https://forum.gamer.com.tw/G2.php?bsn=972&sn=14581
- **旅馆** [商业用地] (high) 对手停在上面时转盘得 N，按单价乘 N 付住宿费，并强制住宿 N 天。住宿期间不能行动，也不能收租。免费卡对旅馆无效。大财神让费用归 0 时也不必住宿。 | 数值: 费 = rate[等级] × PI（涨价 ×2）× N；N 为 1~4，概率 1 天 4/12、2 天 3/12、3 天 2/12、4 天 3/12；本月意外损失 2000 × N × PI | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/facility.ts, https://www.bilibili.com/opus/875661802094985219, https://forum.gamer.com.tw/G2.php?bsn=972&sn=14581
- **购物中心** [商业用地] (high) 对手停在上面时转盘得消费倍数 M，按单价乘 M 付购物费。 | 数值: 费 = rate[等级] × PI（涨价 ×2）× M；M 为 1~6 均匀分布，期望 3.5；最高 5 级 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/facility.ts, https://www.bilibili.com/opus/875661802094985219, https://forum.gamer.com.tw/G2.php?bsn=972&sn=14581
- **加油站** [商业用地] (high) 按付款人这一掷走的总步数和所乘交通工具收费，步行不收费。只有 1 级。 | 数值: 费 = 步数 × 500 × k × PI，k：机车 1、汽车 2、工程车 4；即机车每步 500、汽车每步 1000 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/god-toll.ts, https://forum.gamer.com.tw/G2.php?bsn=972&sn=14581
- **研究所** [商业用地] (high) 不收费。业主停在自己的研究所上（未被查封、未梦游）时，可以选择研发项目 1..等级。研发只在业主自己的回合倒数，完成后把道具交给业主。研究所被拆到低于项目等级时研发作废。电脑固定选最高一档。 | 数值: 研发一律 5 天；1 级机器工人、2 级时光机、3 级传送机、4 级工程车、5 级核子飞弹；标价 30/40/95/150/250 点，卖出九折 27/36/85/135/225 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/facility.ts, https://forum.gamer.com.tw/G2.php?bsn=972&sn=14581, https://www.bilibili.com/opus/875661802094985219
- **改建卡（设施一支）** [卡片] (high) 对脚下 ≥1 级的设施使用，可以改成任意一种类型。改成公园或加油站时等级压到 1，其他类型保留原等级。不看归属。 | 数值: 15 点 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/cards/rebuild.ts, https://www.bilibili.com/opus/875661802094985219
- **天使卡** [卡片] (high) 同名整区所有住宅地各 +1 级，不看归属。连锁店只能从 0 升到 1。对设施只 +1 级，设施为 0 级时首建。 | 数值: 160 点 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/cards/registry.ts, https://www.bilibili.com/opus/875661802094985219
- **机器工人 / 建设公司 / 福神 / 天使神** [加盖途径] (medium) 机器工人：任选一块地免费 +1 级，不看归属。建设公司：别人停上去时选自己的一块地 +1 级，并向董事长付工程费；董事长本人停上去免费加盖。福神附身：买地和盖房多送一层。天使附身：每次落脚在该格加盖一层。 | 数值: 工程费 = 该地地价 × PI | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/tool-effects.ts, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/god-manifest.ts, https://www.bilibili.com/opus/875661802094985219
- **拆除卡** [破坏] (high) 对一处地产或设施拆一级：住宅 −1 级；连锁店直接变成 0 级住宅；设施 −1 级，降到 0 级时变回公园类型。不能对自己的地和空地使用。也能拆路障、地雷、定时炸弹。 | 数值: 15 点；敌意 30 × PI | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/land-mutation.ts, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/cards/land-cards.ts, https://www.bilibili.com/opus/875661802094985219
- **怪兽卡** [破坏] (high) 把一处建筑直接夷平到 0 级，连锁店和设施类型一并复位，地仍归原主。 | 数值: 60 点；敌意 等级 × 30 × PI | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/cards/monster.ts, https://www.bilibili.com/opus/875661802094985219
- **恶魔卡** [破坏] (high) 同名整区所有住宅夷平到 0 级，连锁店退回住宅，归属不变。对设施只夷平一处。 | 数值: 180 点；每块有主地敌意 等级 × 30 × PI | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/cards/registry.ts, https://www.bilibili.com/opus/875661802094985219
- **飞弹** [破坏] (medium) 以目标为中心的方窗内，每处住宅和设施 −1 级（连锁店夷平），归属保留。窗内的人住院并毁掉交通工具。 | 数值: 100 点；半宽 100 像素（社区说约 3×3）；住院 3 天（逆向）/ 5 天（B 站），存在矛盾；地主敌意 30 × PI，被炸者敌意 90 × PI | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/tool-effects.ts, https://github.com/oama1111/rich4-spec/blob/main/docs/systems/tools.md, https://www.bilibili.com/opus/875661802094985219
- **核子飞弹** [破坏] (medium) 作用于整个 440×440 画面，范围内的地产变成无主空地（owner、level、type、地契全部清零），范围内的人住院。 | 数值: 研究所 5 级；标价 250 点；住院 3 天（逆向）/ 5 天（B 站）；敌意 等级 × 30 × PI | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/tool-effects.ts, https://github.com/oama1111/rich4-spec/blob/main/docs/systems/tools.md, https://www.bilibili.com/opus/875661802094985219
- **工程车** [破坏] (low) 社区说法：7 回合内把经过的对手房屋拆成空地。逆向只确认持续 7 天（每天 −4），且作为交通工具时加油费倍率为 4；拆房机制逆向未决。 | 数值: 7 天；标价 150 点 | src: https://www.bilibili.com/opus/875661802094985219, https://github.com/oama1111/rich4-spec/blob/main/docs/systems/tools.md
- **新闻事件：拆房与地价** [破坏] (medium) 4 外星人：重击，地产清成无主，范围内的人住院 3 天。5 怪兽：随机一处有房地产清成无主空地。15 瓦斯爆炸：一块有房住宅 −1 级。18 地震：抽中住宅时同名整区 −1 级。19 山洪：随机任一地产变无主。20 台风：半径 100 内全部 −1 级。21 龙卷风：随机一处 −1 级。6 / 14：同名整区地价 ×1.3 / ×0.7，租金表不变。12 地价税。 | 数值: 新闻 6 ×1.3；新闻 14 ×0.7；新闻 12 地价税 = trunc(Σ(地价 + 房价 × 等级) × 5%) × PI | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/data/src/event-table.ts, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/events/news-effects.ts
- **购地卡 / 换地卡 / 换屋卡** [交易] (high) 购地卡：对脚下他人的住宅或设施强制购买，只用现金，钱付给原主。换地卡：两处互换归属，房子跟着地走。换屋卡：两处互换房屋类型和等级，归属不变；设施也适用，且不检查等级上限。 | 数值: 购地卡 35 点，价格 (地价 + 房价 × 等级) × PI；换地卡 25 点；换屋卡 20 点 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/cards/buy-land.ts, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/cards/swap-and-stock.ts, https://www.bilibili.com/opus/875661802094985219
- **拍卖系统** [交易] (medium) 由拍卖卡（只能拍对手的地）、破产、新闻 7、魔法屋触发。成交款付给发起人；新闻 7 和破产没有卖方，成交款进公库。发起人不能参与竞价，原地主可以举牌。用拍卖卡时流拍，这块地变成无主。 | 数值: 拍卖卡 20 点；起拍价 = trunc(地价 × (1 + 等级 × 0.5)) × PI；加价档 100 / 500 / 1000 / 5000 / 10000 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/auction.ts, https://www.bilibili.com/opus/875661802094985219, https://zh.wikipedia.org/wiki/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **破产清算** [交易] (medium) 破产者名下地产全部变为无主，但等级保留，地契清零。释放的地产超过 3 处时，从中随机抽 3 处依次拍卖，成交款进公库；不超过 3 处则一处都不拍。若这次破产导致对局结束，则跳过清算，地产原样保留。股票卖出所得进公库。 | 数值: 释放 >3 处才拍，只拍 3 场 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/bankruptcy.ts, https://zh.wikipedia.org/wiki/%E5%A4%A7%E5%AF%8C%E7%BF%814
- **公布栏（玩家间二级市场）** [交易] (medium) 每人 7 个挂牌槽，可以挂股票、地产或设施、道具、卡片。真人自行定价，买家用现金付给卖家。电脑每回合有 1/4 概率购买别人挂的股票或地产。 | 数值: 地产市价 = (地价 + 等级 × 房价) × PI；标价上限为市价 × 10；电脑购买地产条件：3 × 估值 > 标价 且 现金 > 2 × 标价 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/places/notice-board.ts, https://github.com/oama1111/rich4-remake-public/blob/main/docs/original-ui.md
- **土地公强占** [空地占领] (high) 被土地公附身的玩家，落脚格如果不是自己的，就直接归自己，不付钱（别人的地和设施也照占），被占的地主只增加敌意。住宿中不触发。附身期间不能正常买无主地。 | 数值: 敌意 = 地价 × PI × (等级 + 2) / 5（有取低 32 位的 bug） | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/god-manifest.ts, https://github.com/oama1111/rich4-spec/blob/main/docs/systems/gods.md, https://www.bilibili.com/opus/875661802094985219
- **地契年限（土地权限）** [空地占领] (medium) 开局可设置地契期限，买地时写入到期日。到期当天变为无主，房子保留。 | 数值: 选项：无限期 / 2 年 / 1 年 / 6 个月 / 3 个月 / 1 个月 | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/facility.ts
- **抵押与变卖** [交易] (medium) 原版没有抵押，也不能把地产卖回给银行。地产只能通过公布栏、拍卖、破产转手。银行贷款额度按总资产计算（包含地产）。 | 数值: 贷款期限 90 天，无利息 | src: https://github.com/oama1111/rich4-remake-public/blob/main/docs/gaps/01-land-economy.md, https://www.bilibili.com/opus/875661802094985219
- **资产估值** [经济] (medium) 总资产 = 现金 + 存款 − 贷款 + 股票市值 + 地产。地产部分不乘 PI。 | 数值: 住宅 = 地价 + 等级 × 房价；连锁店 = 地价 + 房价；设施 = 地价 + 等级 × 房价 | src: https://github.com/oama1111/rich4-spec/blob/main/docs/systems/economy.md, https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/wealth.ts
- **电脑买地与建设策略** [AI] (medium) 电脑只看买完之后还剩多少钱，没有估值或同区协同的判断。电脑首建设施时随机选旅馆、购物中心、加油站或研究所，不盖公园。 | 数值: 买地条件：现金 + 存款 − 价格 > min(trunc(开局资金 × 5%), 7000) × PI | src: https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/purchase.ts

## open_questions
- 各地图（8 张）每块住宅地的房价（house_price）和完整租金表，以及每处设施的地价和费率表：公开资料只有地图 0 台北市（地价 2500）和新竹市（地价 1000）的租金表，其余需要从原版 MAP.MKF 提取。
- B 站说「地价从 100-600 不等」，与逆向实测（台北 2500、新竹 1000）以及 4Fun 数据冲突，原因未查明。
- 飞弹和核子飞弹的住院天数：逆向为 3 天（push 3），B 站攻略说 5 天；影响范围的社区说法（3×3、9×9）与逆向的像素方窗如何换算，未实机确认。
- 工程车的拆房机制：逆向只确认持续 7 天和油费倍率 4，「经过对手房屋拆成空地」的具体判定（经过还是落脚、是否只拆对手、拆到几级）逆向未决。
- 163 文章称公园有「提高周围小建筑过路费」的隐藏属性，逆向的过路费函数中没有找到对应逻辑，疑为误传，未实机验证。
- 社区说涨价卡和查封卡「相互使用可完全抵消」，逆向显示两者写同一个字节、后者覆盖前者，是否恢复成普通状态有冲突。
- 恶魔、天使附身的效果是只在落脚时触发，还是经过也触发：rich4-spec 的 gods.md 表格写「移動時沿路破壞」，复刻源码只在落点尾块触发。
- 流氓勒索保护费的公式：逆向为 Σ同名同主地价 × PI，B 站为「地价 × 5 × 级别（0 级算 1）」，两者冲突。
- 魔法屋的「拍卖当格土地」「就地加盖 / 拆除房屋」是否可达：复刻文档称抽签为 rand()%11，第 11 项永远抽不到；社区列出了这些选项。
- 研究所正在研发时再次停留并选择新项目，是否覆盖原研发（逆向写入逻辑显示会覆盖，未实机确认）。
- 建设公司董事长到底是「免费加盖一层」还是「可升两层」（社区说可升两层，复刻审计记为「自家公司盖两次」）。
- 萌娘百科、百度百科、Fandom 大宇大富翁 wiki 被 403 或 Cloudflare 拦截，未能交叉核对；Fandom 提到的连锁店基础租金 5000 应属其他版本，未确认。
- 地价、房价在游戏 UI 中的显示单位和格式（原版地产信息面板的截图）未取得。

## sources
- https://github.com/oama1111/rich4-spec/blob/main/docs/systems/land-rent.md
- https://github.com/oama1111/rich4-spec/blob/main/docs/systems/economy.md
- https://github.com/oama1111/rich4-spec/blob/main/docs/systems/map-format.md
- https://github.com/oama1111/rich4-spec/blob/main/docs/systems/gods.md
- https://github.com/oama1111/rich4-spec/blob/main/docs/systems/tools.md
- https://github.com/oama1111/rich4-remake-public
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/toll.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/rent.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/land.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/purchase.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/facility.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/god-toll.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/god-manifest.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/land-mutation.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/toll-flow.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/auction.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/bankruptcy.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/wealth.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/rules/tool-effects.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/cards/rebuild.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/cards/monster.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/cards/land-cards.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/cards/buy-land.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/cards/swap-and-stock.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/cards/turn-and-house.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/core/src/places/notice-board.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/data/src/event-table.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/data/src/cards.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/packages/data/src/tools.ts
- https://github.com/oama1111/rich4-remake-public/blob/main/docs/money-flow.md
- https://github.com/oama1111/rich4-remake-public/blob/main/docs/gaps/01-land-economy.md
- https://github.com/mytbk/rich4
- https://www.bilibili.com/opus/875661802094985219
- https://forum.gamer.com.tw/G2.php?bsn=972&sn=14581
- https://forum.gamer.com.tw/C.php?bsn=972&snA=2175
- https://forum.gamer.com.tw/C.php?bsn=972&snA=2034
- https://forum.gamer.com.tw/C.php?bsn=972&snA=2030
- https://zh.wikipedia.org/wiki/%E5%A4%A7%E5%AF%8C%E7%BF%814
- https://www.163.com/dy/article/HJ95G6PE0546O9E5.html
- https://tw.news.yahoo.com/richman-4-034800709.html