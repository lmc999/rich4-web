# 大富翁4 复刻：规则引擎与游戏状态模型设计

> **实施记录**：与本文不一致的实际做法见 architecture §17.2（M1）、§18.1（M4 经济），以那里为准。

> 范围包括 `packages/shared/src/engine/**`（纯函数、确定性规则引擎）、`packages/shared/src/data/**`（带出处的数据表和地图 JSON 契约）、引擎对外 API，以及测试。
>
> 规则基准是**原版程序的实际行为**，数值取自 v3.11 逆向资料，按 v2.06 核实。几处与说明书明显冲突的规则做成房间可选的「说明书规则」开关。岔路**始终随机**，所以没有选方向的决策。首张地图为原版台湾图（global_map_id 0）。
>
> 已与 `design_net.md §12`（EngineApi）、`design_client.md §13`（事件必须带后置绝对值、options 必须带全渲染所需数值）对齐。第 19 节列出需要其他两份设计跟着修改的地方。

---

## 0. 结论速览

| 主题 | 结论 |
|---|---|
| 执行模型 | `applyAction(state, action)` 先对 state 做 `structuredClone` 得到草稿，在草稿上执行，入参永远不被修改。内部是一个**显式帧栈解释器**：`state.flow: Frame[]` 可以序列化，里面没有闭包，所以任意决策点都能存档，也能中途插入破产、拍卖、被动卡询问 |
| 决策 | `state.pending: PendingDecision[]` 支持多个座位同时决策（拍卖）。决策 id 为 `d${counter}`，确定性生成。每个决策带 `options`（渲染和 AI 需要的全部数值与合法候选）、`defaultIntent`、`publicInfo`。**不存在 CHOOSE_PATH**，岔路由引擎 RNG 决定 |
| 事件 | `GameEvent` 是以 `type`（SCREAMING_SNAKE）区分的联合类型。**`post` 字段由引擎在 `emit` 时对比公开世界自动生成**，内容是本事件之后受影响实体各字段的绝对值。客户端 viewReducer 直接调用 shared 的 `applyPostPatch`，从结构上保证「逐个折叠事件 = 批尾快照」 |
| 隐藏信息 | `state.secret` 存 RNG、新闻和命运牌序、时光机锚点、调试强制队列。牌堆剩余张数、商店货架是公开的 |
| 数值 | 金额按 int32 语义，通过 `int32.ts` 辅助函数计算，默认回绕（和程序一致），可配置为饱和。点券按 uint16。股价以「分」为单位存整数。只有股价动量和同盟分账（`Math.fround`）用浮点，只做 IEEE 四则运算，不用超越函数 |
| RNG | 使用可序列化的 xoshiro128**，对外提供 `rand15()`（0..32767，模拟 Watcom `rand()` 的取值范围），公式里照原版写成 `rand()%n`。每次取随机数都带 purpose 标签，测试可以按语义强制结果（骰子、转盘、岔路） |
| 回合与日期 | 座位依次行动 → 在场恶人（4..7）各走一次 → `DAY` 帧日推进 → 回到座位 0。阻碍类计数器采用原版「两段式」编码（减到 0 时置 0x80 标记待释放，下一回合才真正释放，并且这一回合不掷骰） |
| 效果系统 | 30 张卡、13 种道具、13 种神明/物件、36 条新闻、37 条命运、魔法屋 12×12 都写成「数据表（带 @source）+ 按 kind 注册的处理函数」。穷举由 `satisfies` 在编译期检查 |
| 规则开关 | `RuleConfig` 提供 `PROGRAM`（默认）和 `MANUAL` 两个预设，外加联机适配项（目标范围、时光机模式、溢出模式） |
| 测试 | 按系统拆分的规则单测（台北、台南、新竹样本）；场景 DSL（固定种子 + `SYS_DEBUG` 强制结果）；fast-check 不变量测试（资金守恒台账、牌堆守恒、道具池守恒、股本守恒）；随机合法 intent 与 AI 自对弈 fuzz；post 折叠一致性测试；golden 重放 |

---

## 1. 规则基准与冲突裁决

凡是在 critique.json 里有冲突的项，都在这里定出默认值（PROGRAM）和说明书开关值（MANUAL）。**标 ⚑ 的需要用正版文件核实**，见第 18 节。

| # | 规则 | PROGRAM（默认） | MANUAL 开关 | 依据 |
|---|---|---|---|---|
| 1 | 路过还是停下触发 | 路过触发的只有：银行 ATM、路障拦停、身上定时炸弹的倒数和转移。地雷、恶犬、神明、礼物、宝箱、乞丐、卡片格等全部**停下才触发** | — | squares_events §0.1、items、deities（多数主题 + EXE 分支） |
| 2 | 飞弹、核弹住院天数 | 3 天 | 3 天（说明书也是 3 天） | critique 已抽查说明书 OCR |
| 3 | 定时炸弹爆炸范围 | 携带者住院 5 天、车毁，所在格那块地产降 1 级 | `bombBlast:'manual3x3'`：半宽 100 的方窗内所有人住院、房屋降 1 级 | items §5.4 |
| 4 | 工程车 | 落点是别人已有建筑的地产时，直接拆到 0 级（地主保留），持续 7 个自己的回合 | `engineeringVehicle:'manual'`：经过和停留的对手房屋各拆 1 级 | items §5.12、说明书 |
| 5 | 红卡、黑卡 | 事件字节 0x20 / 0x02：当天涨停一次，下一个自然日倒数时再涨停一次；后写覆盖前写 | `redBlack:'manual'`：3 个开市日；红黑互相抵消 | cards §7、stocks §4.5 |
| 6 | 福神买地 | 照付全价，买地、盖房成功后额外送 1 级 | `fortuneGodLand:'manual'`：大福神买地免费，小福神买地半价 | deities §7.3/7.4 |
| 7 | 小穷神过路费 | ×1.5（`t + (t>>1)`） | ×2 | deities §5 |
| 8 | 星期日银行 | 营业（代码不检查星期日） | `sundayBankClosed:true`：ATM 和柜台都只弹提示 | stocks §1.3 |
| 9 | 手牌已满又得到卡 | 自动弃掉最便宜的一张（同价取靠前的卡槽） | `handFull:'choose'`：弹 DISCARD_CARD 让玩家选 | cards §2.6 |
| 10 | 神明加持是否作用于新闻 | 只作用于命运 | `blessingOnNews:true` | squares §1.1 |
| 11 | 送神符能否送走死神 | 能（白名单里有死神） | `deathGodDispellable:false` | deities §8 |
| 12 | 罚款能否用免费卡、嫁祸卡 | 不能（程序里能证实的只有过路费和查税） | `freeCardOnFines:true` | cards §5 ⚑ |
| 13 | 个股停牌天数 | 15（立即数） | 10（文案） | squares #27 ⚑ |
| 14 | 机器娃娃步数 | 9 | 9 | 代码和说明书一致 |
| 15 | 胜负阈值 | 资产 ≥ 目标值。并列时取座位靠前者 | — | critique 已核实 |
| 16 | 拍卖卡能拍哪些地 | 脚下任何地，包括自己的和无主的。钱归用卡者；流拍则该地变为无主 | — | 说明书 OCR |
| 17 | 建设公司董事长加盖 | +2 级（exe 调用两次，g_map §4.3，A 级证据） | `constructionChairmanLevels:1`（PTT「附送加盖一次」） | property 与 stocks 冲突；M4 按 exe 裁决，见 architecture §18.1 |
| 18 | 电脑每回合用卡、用道具 | 由 AI 策略负责，引擎不限制 | — | 属于 AI 领域 |
| 19 | 总资金默认档 | 200000（exe 默认档位下标 1，VERIFY V-E4；存档见到的 300000 推测来自沿用上局设置，实机待 V-R15） | — | rules §1、architecture §5.3 |
| 20 | 联机：卡片、道具的目标范围 | `targetRange:'window'`：以使用者为中心、半宽 220 世界单位的方窗 | `'global'` | 原版为 440×440 视窗 |
| 21 | 联机：时光机 | `timeMachine:'global'`：全局锚点，取最近一次真人座位掷骰前的世界 | `'perSeat'` 或 `'disabled'` | 见 §10.10 |
| 22 | int32 溢出 | `intOverflow:'wrap'`（和程序一致） | `'saturate'` | property §2 |

---

## 2. 目录与文件职责

```
packages/shared/src/
  engine/
    index.ts                 # export const engine: EngineApi；再导出 types、selectors、applyPostPatch、EVENT_META、allowedIntents、PlayerIntentSchema
    version.ts               # ENGINE_VERSION='0.1.0'、STATE_SCHEMA_VERSION=1、dataHash()
    api.ts                   # createGame / applyAction / getPendingDecisions / getResult / validateState / migrateState
    errors.ts                # EngineRuleError{rule,msg}、EngineInvariantError
    types/
      ids.ts                 # SeatIndex、ActorRef、NodeId、LotKey、CardId、ItemId、GodKind、DateNum、Party…
      state.ts               # GameState 及全部子类型（§4）
      config.ts              # GameConfig、RuleConfig、PlayerSetup、AiProfile、PRESETS、validateConfig
      frames.ts              # Frame 联合类型（§6）
      decision.ts            # DecisionKind、DecisionOptionsMap、PendingDecision、TargetCandidates
      intent.ts              # PlayerIntent、SystemAction、GameAction；zod：PlayerIntentSchema
      events.ts              # GameEvent 联合类型、PostPatch、EVENT_META（分类、脱敏、是否需要 reset）
    core/
      ctx.ts                 # Ctx：草稿 s、events、rng、emit（自动生成 post）、ask、push/pop、pay/mint/burn、confine…
      flow.ts                # run()、resumeDecision()、unwindActor()、FRAME_HANDLERS 注册表（satisfies 穷举）
      clone.ts               # cloneState（structuredClone）；开发模式下 deepFreeze 入参
      int32.ts               # add32/sub32/mul32(Math.imul)/divTrunc/toU16/clampMode
      rng.ts                 # xoshiro128**：seedFromHex、next32、rand15、int(n)=rand15()%n、shuffle、weighted
      random.ts              # ctx.roll(purpose,…) 语义层：dice/fork/wheel/deck…，并读取 secret.debugQueue
      postPatch.ts           # publicWorld()、diffPublic()、applyPostPatch()（客户端 viewReducer 直接复用）
      ids.ts                 # nextDecisionId、nextFrameId、nextObjectId、nextListingId
    rules/                   # 纯计算器：不压帧、不发事件，便于单测和客户端预览
      wealth.ts              # netWorth(s,seat)、updatePriceIndex(s)
      toll.ts                # 住宅过路费（同名路段累加、连锁店）、涨价、同盟分账、神明修正、九种免收
      facilityFee.ts         # 旅馆、购物中心、加油站费用；设施等级上限
      companyFee.ts          # 行业收费公式（航空、电子、保险、汽车、石油、建设、门派）
      purchase.ts            # 买地价、加盖价、canBuy/canBuild（梦游、衰神、死神、土地公、现金）；福神加成
      landMutation.ts        # mutateLot(mode 0 拆一级 / 1 清除 / 2 夷平)、levelUp、streetOf
      payment.ts             # transfer / mint / burn（级联扣款、破产标记、月度损益累计）
      counters.ts            # tick2(c)（两段式）、isBlocked、displayRemaining
      blessing.ts            # evalBlessing(value, rng) → 'high'|'none'|'low'；applyBlessing(category, amount/days)
      hostility.ts           # addHostility（对盟友产生正敌意时解除同盟）、同盟每日衰减
      inventory.ts           # receiveCard（满手自动弃牌）、takeCardFromDeck(weighted)、receiveItem（上限 9、道具池）、sellValue
      movement.ts            # nextNode（随机岔路，死路掉头）、reverse、forwardPath（机器娃娃）、placeParachute
      geometry.ts            # inWindow(a,b,half)、nearest(…)、respawnNode(ref,300)
      calendar.ts            # DateNum 运算、weekday（1998-01-01 为星期四）、leap%4、isMarketClosed、loanDue、addTenure
      stock.ts               # tickSize、tickMarket、limitUp/Down、refreshQuota、trade、chairmanOf、dividends
      lottery.ts             # drawNumber(rules)
      victory.ts             # checkDayEnd、checkAfterBankruptcy、ranking
    flow/                    # 帧处理器（解释器本体）
      root.ts turn.ts move.ts land.ts day.ts villain.ts
      ask.ts                 # 通用单问答帧 ASK 及 ASK_RESOLVERS[kind]
      toll.ts fee.ts pay.ts confine.ts bankruptcy.ts auction.ts surrender.ts
      bank.ts shop.ts
    squares/                 # 17 类落点处理器：SQUARE_HANDLERS[0..16] + property/facility/company
      index.ts property.ts facility.ts company.ts park.ts news.ts fate.ts jail.ts hospital.ts
      minigame.ts lottery.ts points.ts cardSquare.ts bank.ts shop.ts magic.ts
    effects/
      cards/index.ts         # CARD_EFFECTS: { [C in CardId]: CardEffect<C> } satisfies 穷举
      cards/{money,land,control,stock,god,harm,passive}.ts
      items/index.ts         # ITEM_EFFECTS
      items/{objects,vehicle,weapons,research}.ts
      gods/index.ts          # GOD_EFFECTS：onAttach / tollModifier / manifest / 离场换搭档
      objects.ts             # 停留时的物件结算：地雷、恶犬、地面炸弹、礼物、宝箱、神明
      news/index.ts          # NEWS_HANDLERS[effect.k]
      fate/index.ts          # FATE_HANDLERS[effect.k]
      magic/index.ts         # MAGIC_CONDITIONS[12]、MAGIC_EFFECTS[12]
      villains/index.ts      # VILLAIN_ACTIONS、乞丐
      timeMachine.ts
    decisions/
      build.ts               # 各 kind 的 options 构造（计算价格、过路费预览、候选）
      targets.ts             # 卡片、道具的目标候选（视窗、合法性）
      allowed.ts             # ALLOWED_INTENTS: { [K in DecisionKind]: IntentType[] }
      defaults.ts            # defaultIntent 构造
      timing.ts              # DECISION_TIMING_CLASS（给 net/timing.ts 查表）
    selectors/index.ts       # 客户端和 AI 共用：calcToll、netWorth、buyPrice、upgradeCost、streetLots、lotsInWindow、marketOpen…
    validate/{schema.ts, invariants.ts}
    migrate/{index.ts, v1.ts}
    testing/                 # 仅测试和脚本使用（exports 单独子路径 '@rich4/shared/engine-testing'）
      builders.ts scenario.ts randomIntent.ts debug.ts miniMap.ts
  data/
    source.ts                # Src 类型与 @source 约定
    setup.ts economy.ts cards.ts items.ts characters.ts gods.ts facilities.ts companies.ts
    news.ts fate.ts magic.ts stocks/index.ts stocks/taiwan.ts
    calendar/holidays.ts calendar/lunar.ts
    maps/types.ts maps/schema.ts maps/index.ts maps/validate.ts
    maps/generated/taiwan.json      # 由提取脚本生成（不含图片和音频）
    maps/test/mini.json             # 手工小地图（CI 不依赖正版文件）
tools/extract/                      # 构建期提取脚本（读取 .original/，只输出 JSON）
```

---

## 3. 基础约定

- **纯函数与确定性**
  - engine 目录里禁止使用 `Math.random`、`Date`、`performance`、`Intl`，禁止 `Math.sin/cos/pow/exp/log/hypot`，禁止 `for…in`，禁止对 state 调用 `Object.keys`。靠 biome 的 `noRestrictedGlobals` 加一个 grep 测试来保证。
  - state 里只放 JSON 值：不用 `Map`、`Set`、`undefined`（一律用 `null`）。集合一律用数组，排序比较器最后按 seat 或 id 打破平局。
- **数值**
  - `add32(a,b)=(a+b)|0`，`mul32=Math.imul`，`divTrunc(a,b)=Math.trunc(a/b)`（int32 范围内结果精确）。
  - `intOverflow:'saturate'` 时改用 `clamp(±2147483647)`。
  - 点券用 `toU16`：wrap 模式下 `&0xffff`，saturate 模式下 `min(65535)`。
  - 百分比一律写成整数形式，例如 `divTrunc(x*11,10)`，结果和原版 double 乘法相同（原因：1.1 的 double 值略大于 1.1，截断时不会跨过整数）。
  - 同盟分账用 `Math.trunc(total * Math.fround(ally/total))`。
- **RNG**
  - `secret.rng: [u32,u32,u32,u32]`。`seedFromHex(seed)` 用 splitmix32 展开，全零时替换成常量。
  - 语义层：
    - `ctx.dice()` = `rand15()%6+1`
    - `ctx.pick(purpose,n)` = `rand15()%n`（和原版一样，只有 1 个候选也要消耗一次）
    - `ctx.slot(digits)`：每位 `rand15()%10`
    - `ctx.weighted(counts)`
  - 调试队列 `secret.debugQueue: {purpose, values}[]`，只有 `config.debug=true` 时才能写入，按 purpose 逐个出队，直接替换语义结果。
- **ID**
  - 座位 0..3；恶人为 `'thief'|'robber'|'thug'|'spy'`（原版演员号 4..7）。
  - `NodeId`、`LandId`、`FacilityId`、`CompanyId` 沿用地图的 1 基编号。
  - `LotKey = \`L${id}\`|\`F${id}\``。
  - `DateNum = y*10000+m*100+d`。
  - 决策 id 为 `d${++counters.decision}`，帧 id 为 `++counters.frame`，物件 id 为 `++counters.object`。
- **日期**
  - 闰年只判能否被 4 整除；星期以 1998-01-01 为星期四推算。
  - 地契到期日按原版不夹日：1/31 买入、期限一个月，得到 2/31，这一天永远不会等于真实日期，所以永不到期。

---

## 4. GameState 完整类型（`engine/types/state.ts`）

```ts
export interface GameState {
  v: number;                         // STATE_SCHEMA_VERSION
  engine: string;                    // 创建或迁移时的 ENGINE_VERSION
  dataHash: string;                  // 数据表 + 地图内容哈希（FNV-1a 64 hex）
  config: GameConfig;                // 开局后只读
  status: 'playing' | 'over';
  result: GameResult | null;
  clock: ClockState;
  econ: EconomyState;
  players: PlayerState[];            // 按 seat 升序，2..4 人；seat 不要求连续
  villains: VillainState[];          // 固定顺序 [thief, robber, thug, spy]
  lands: LandState[];                // 下标 = id-1
  facilities: FacilityState[];
  companies: CompanyState[];
  objects: RoadObject[];             // 路面物件，每个节点至多 1 个（不含神明）
  gods: GodSlot[];                   // 固定 14 槽：kind 1..12 各 1 个，死神 2 个
  beggars: { seat: SeatIndex; node: NodeId }[];
  stocks: StockState[];              // 12 支
  pools: { cards: number[]; items: number[] };   // 下标 = id（0 不用）。cards 是剩余张数，items 只统计 1..8 的共享库存
  lottery: { owners: (SeatIndex | null)[] };     // 36 个号码（下标 0 对应显示的 1 号）
  noticeBoard: Listing[];            // 公布栏
  flow: Frame[];                     // 解释器帧栈（不下发给客户端）
  pending: PendingDecision[];        // 当前待决策（数组）
  counters: { action: number; decision: number; frame: number; object: number; listing: number };
  secret: SecretState;               // 永不下发
}

export interface ClockState {
  date: DateNum; weekday: 0|1|2|3|4|5|6; elapsedDays: number;
  turnNo: number;                    // 每个演员（玩家或恶人）回合开始时 +1
  cursor: { t: 'seat'; seat: SeatIndex } | { t: 'villain'; idx: 0|1|2|3 } | { t: 'day' };
  marketOpen: boolean;               // 今日是否开市（日推进时计算）
  holiday: string | null;            // 今日节日 key
}

export interface EconomyState {
  initialFund: number; priceIndex: number;
  pool: number;                      // 公库，即乐透奖池
  bankRunDays: number;               // 新闻 22：停止放款，ATM 只能存
  marketClosedDays: number;          // 新闻 26：全面停市
  ledger: { minted: number; burned: number };    // 资金守恒台账（测试用，公开）
}

export type Vehicle = 'walk' | 'moto' | 'car' | 'engineer';
export interface Counters2 {         // 原始编码：低 7 位 = 天数；0x80 = 待释放（两段式）
  hotel: number; away: number; jail: number; hospital: number;   // 主阻碍：住旅馆、消失、坐牢、住院
  hibernate: number; sleepwalk: number; stay: number; tortoise: number;
}

export interface PlayerState {
  seat: SeatIndex; character: CharacterId; controller: 'human' | 'ai';
  aiProfile: AiProfile;              // 个性、是否用卡、是否用道具、现金比例、炒股比例、借贷比例（托管对话框可改）
  alive: boolean; out: null | 'bankrupt' | 'surrender';
  // 资金
  cash: number; deposit: number; loan: number; loanDue: DateNum;  // loanDue 为 0 表示无贷款
  finance: number;                   // 特别融资余额（已计入 deposit）
  points: number;                    // uint16
  // 位置与行进
  placed: boolean; node: NodeId; prevNode: NodeId;
  savedPrevNode: NodeId | null;      // 关押期间保存朝向，释放时恢复
  vehicle: Vehicle; diceCount: 1 | 2 | 3;
  engineer: { days: number; restore: 'walk' | 'moto' | 'car' } | null;
  st: Counters2;
  returning: boolean;                // 刚释放、本回合走回棋盘（原版 +0x15|=0x10）
  bankReject: number;                // 拒绝往来天数（普通倒数）
  insuranceDays: number;
  alliance: { seat: SeatIndex; days: number } | null;
  god: { kind: GodKind; days: number } | null;
  bomb: { fuse: number } | null;     // 挂在身上的定时炸弹（与神明槽相互独立）
  luck: { bad: number; wealth: number; fortune: number }; // 衰运、财运、福运（神明附身时累加）
  hostility: [number, number, number, number];            // 我对 seat j 的敌意
  cards: CardId[];                   // ≤15，顺序即卡槽顺序
  items: number[];                   // 长度 14，下标 = ItemId；机车、汽车装备中不计入
  holdings: { shares: number; costCents: number }[];       // 12 支
  quota: number[];                   // 12 支，本回合可买量
  monthly: { loss: number; gain: number; badDays: number; interest: number };
  turn: { forcedSteps: number | null; teleportedSelf: boolean; cardsUsed: number; itemsUsed: number }; // 回合临时状态，回合开始时清零
}

export interface VillainState {
  kind: VillainKind; home: 'jail' | 'hospital';
  onBoard: boolean; node: NodeId; prevNode: NodeId; homeNode: NodeId; leftHome: boolean;
  employer: SeatIndex | null;
  st: Pick<Counters2, 'jail' | 'hospital' | 'hibernate' | 'sleepwalk' | 'stay' | 'tortoise'>;
}

export interface LotMark { kind: 'raise' | 'seal'; days: number }   // 涨价卡、查封卡
export interface LandState {
  id: LandId; owner: SeatIndex | null; level: 0|1|2|3|4|5; chain: boolean;
  landPrice: number;                 // 运行期地价，初值来自地图；新闻 6/14 会改写
  mark: LotMark | null; tenure: DateNum; // tenure 为 0 表示无限期
  lastToll: number;                  // 上一次收到的过路费（间谍偷租金用）
}
export type FacilityType = 'park' | 'hotel' | 'mall' | 'gas' | 'lab';
export interface FacilityState {
  id: FacilityId; owner: SeatIndex | null; level: 0|1|2|3|4|5; type: FacilityType; // level 0 时 type='park'
  landPrice: number; mark: LotMark | null; tenure: DateNum; lastFee: number;
  research: { project: 1|2|3|4|5; days: number } | null;
}
export interface CompanyState {
  id: CompanyId; stock: number;      // 对应股票下标 0..11
  reserved: number;                  // 公司保留股，现场认购的来源
  surplusMonth: number; surplusTotal: number;  // 本月盈余（15 日分红）、累积盈余；可以为负
}

export type RoadObjectKind = 'roadblock' | 'mine' | 'bomb' | 'gift' | 'chest';
export interface RoadObject { id: number; kind: RoadObjectKind; node: NodeId; placedBy: SeatIndex | null }
export interface GodSlot {
  slot: number; kind: GodKind;       // 1 小财 2 大财 3 小福 4 大福 5 小穷 6 大穷 7 小衰 8 大衰 9 天使 10 恶魔 11 恶犬 12 土地公 15 死神
  where: { t: 'absent' } | { t: 'road'; node: NodeId } | { t: 'attached'; seat: SeatIndex };
}

export interface StockState {
  idx: number; priceCents: number; prevCents: number; openCents: number;
  momentum: number;                  // 动量，唯一允许的浮点字段（double，只做四则运算）
  up: number; down: number;          // 利多/利空剩余天数（原版事件字节的两个半字节）
  suspend: number;                   // 停牌剩余天数
  float: number;                     // 市场流通可买股数
  chairman: SeatIndex | null;        // 董事长（持股最多，平手保留现任）
  history: number[];                 // 最近 144 个开市日收盘价（分）
}

export interface Listing {
  id: number; seller: SeatIndex; price: number;
  asset: { t: 'stock'; stock: number; shares: number } | { t: 'lot'; lot: LotKey }
       | { t: 'card'; card: CardId } | { t: 'item'; item: ItemId; qty: number };
}

export interface SecretState {
  rng: [number, number, number, number];
  newsOrder: number[]; newsCursor: number;        // 36 张，开局洗一次，循环抽，不重洗
  fateOrder: number[]; fateCursor: number;        // 37 张
  timeAnchor: TimeAnchor | null;
  debugQueue: { purpose: RandPurpose; values: number[] }[];
}
export interface TimeAnchor {
  takenAtTurn: number; seat: SeatIndex;
  world: PublicWorld & { flow: Frame[]; decks: Pick<SecretState, 'newsOrder'|'newsCursor'|'fateOrder'|'fateCursor'> };
}
export type PublicWorld = Omit<GameState, 'secret' | 'flow' | 'pending' | 'counters'>;

export interface GameResult {
  reason: 'timeLimit' | 'wealthTarget' | 'lastStanding' | 'noHumansLeft';
  code: 1 | 2 | 3;                   // 原版终局码：1 真人全出局，2 单真人局胜，3 多真人局胜
  winner: SeatIndex | null; date: DateNum; elapsedDays: number;
  ranking: { seat: SeatIndex; netWorth: number; alive: boolean }[];
}
```

说明：

- 监狱、医院各有 8 个床位（0..3 给玩家，4..7 给恶人）。这些床位**不单独存储**，由 `st.jail/hospital` 和恶人状态推导，避免出现两份数据不一致。
- 公司的「经营者」统一用 `stocks[company.stock].chairman` 表示。
- `players.cards` 在引擎里始终是完整数组。私密手牌模式下，由 net 的投影把它替换成 `cardCount`。

---

## 5. 配置与开局

```ts
export interface GameConfig {
  mapId: 'taiwan' | 'mini';
  initialFund: 300000 | 200000 | 100000 | 50000 | 30000 | 10000;   // 默认 200000（V-E4）
  vehicle: 'walk' | 'moto' | 'car';
  tenure: 'unlimited' | '2y' | '1y' | '6m' | '3m' | '1m';
  timeLimitDays: 0 | 730 | 365 | 182 | 91 | 30;                    // 0 表示无限期（说明书默认）
  winMultiple: 0 | 100 | 50 | 10 | 5 | 3;                          // 0 表示无限（说明书默认）
  startDate: DateNum;                // 由服务器传入当天日期；引擎夹到 [19980101, 20100101]
  rules: RuleConfig;
  debug: boolean;                    // 为 true 时才接受 SYS_DEBUG（E2E、测试模式）
}
export interface RuleConfig {
  preset: 'program' | 'manual' | 'custom';
  redBlack: 'program' | 'manual'; fortuneGodLand: 'program' | 'manual'; smallPoorToll: 'x1.5' | 'x2';
  engineeringVehicle: 'program' | 'manual'; bombBlast: 'program' | 'manual3x3';
  sundayBankClosed: boolean; handFull: 'autoCheapest' | 'choose'; blessingOnNews: boolean;
  deathGodDispellable: boolean; freeCardOnFines: boolean; stockSuspendDays: 15 | 10;
  constructionChairmanLevels: 1 | 2;
  targetRange: 'window' | 'global'; windowHalf: number;            // 默认 220
  timeMachine: 'global' | 'perSeat' | 'disabled';
  intOverflow: 'wrap' | 'saturate';
  endWhenNoHumans: boolean;          // 原版为 true：真人全部出局即结束
}
export const PROGRAM_RULES: RuleConfig; export const MANUAL_RULES: RuleConfig;
export interface PlayerSetup { seat: SeatIndex; character: CharacterId; controller: 'human' | 'ai'; aiProfile?: Partial<AiProfile> }
```

`createGame(config, setups, seedHex)` 的步骤：

```
1  validateConfig（人数 2..4、角色不重复、seat 不重复）。map = MAPS[config.mapId]。rng = seedFromHex(seedHex)
2  date = clampStart(config.startDate)；weekday = weekdayOf(date)；econ = {PI:1, pool:0, ledger:0}
3  每个座位：
     fund = initialFund
     真人：cash = divTrunc(fund, 2)
     电脑：cash = divTrunc(fund × profile.cashRatio, 100)
     deposit = fund − cash
     道具 1,2,3,4,8,9 各 +1，道具池 1..8 相应 −1                        @source mytbk csrc/game_init.c
     vehicle = config.vehicle；机车或汽车时道具池 5 或 6 −1；diceCount = 步行 1 / 机车 2 / 汽车 3
     placed=false；node=0；卡片为空；点券 0；holdings 和 quota 为 12 个 0
4  恶人：小偷、强盗在监狱，流氓、间谍在医院；onBoard=false，homeNode = 对应的监狱或医院格
5  地块、设施、企业按地图初始化（landPrice 从地图拷贝）；股票按 data/stocks/taiwan.ts 初始化：
     float = 流通股；公司保留股 = 10000 − 流通股；history = [初始价]
6  牌堆：pools.cards[c] = deckCount[c]（合计 100）；pools.items[1..8] = 10 − 已发出的数量
7  物件：随机放置 小财神(1)、小福神(3)、小穷神(5)、小衰神(7)、天使(9)、恶犬(11)、礼物、宝箱（互不重叠的可放置节点）
8  secret：newsOrder = shuffle(0..35)；fateOrder = shuffle(0..36)（Fisher–Yates，使用 rng.int）
9  clock.cursor = 第一个座位；flow = [ROOT]；run(ctx)（运行到第一个待决策为止）
10 返回 state。另外提供 createGameWithEvents(...) → {state, events}，可选择使用
```

---

## 6. 流程机：可序列化的帧栈解释器

### 6.1 帧类型（`types/frames.ts`，节选）

```ts
type Base = { fid: number };
export type Frame = Base & (
  | { k: 'ROOT'; stage: 'seat' | 'villains' | 'day'; nextSeatFrom: number; villainIdx: number }
  | { k: 'TURN'; seat: SeatIndex; stage: 'start' | 'menu' | 'rolled' | 'landed' | 'end' }
  | { k: 'MOVE'; actor: ActorRef; remaining: number; total: number; seg: NodeId[];
      mode: 'normal' | 'sleepwalk' | 'return' | 'villain'; bankPassed: boolean }
  | { k: 'LAND'; actor: ActorRef; node: NodeId; steps: number;
      stage: 'beggar' | 'object' | 'square' | 'tail' | 'lab' | 'done'; skipSquare: boolean }
  | { k: 'ASK'; seat: SeatIndex; kind: SimpleAskKind; data: AskData; stage: 'ask' | 'done' }
  | { k: 'TOLL'; payer: SeatIndex; lot: LotKey; stage: 'compute' | 'free' | 'scapegoat' | 'pay' | 'done'; q: TollQuote | null }
  | { k: 'FEE'; payer: SeatIndex; lot: LotKey; feeKind: 'hotel' | 'mall' | 'gas' | 'company'; stage: string; q: FeeQuote | null }
  | { k: 'PAYX'; payer: SeatIndex; to: Party; amount: number; reason: MoneyReason; passive: PassiveSet; stage: string }  // 带被动卡的一般付款
  | { k: 'CONFINE'; actor: ActorRef; where: 'jail' | 'hospital' | 'away' | 'hotel'; days: number; cause: Cause;
      passive: boolean; blessing: boolean; stage: 'exempt' | 'scapegoat' | 'bless' | 'apply' | 'done' }
  | { k: 'CARD'; seat: SeatIndex; card: CardId; target: CardTarget; stage: string; data: Record<string, number | null> }
  | { k: 'ITEM'; seat: SeatIndex; item: ItemId; target: ItemTarget; stage: string; data: Record<string, number | null> }
  | { k: 'GOD'; seat: SeatIndex; slot: number; stage: 'displace' | 'attach' | 'power' | 'done'; cursor: number }
  | { k: 'NEWS'; id: number; stage: string; data: NewsData }
  | { k: 'FATE'; seat: SeatIndex; id: number; stage: string; data: FateData }
  | { k: 'MAGIC'; caster: SeatIndex; cond: number; targets: SeatIndex[]; effect: number | null; idx: number; stage: string }
  | { k: 'BANK'; seat: SeatIndex; mode: 'pass' | 'stop'; stage: 'atm' | 'counter' | 'done' }
  | { k: 'SHOP'; seat: SeatIndex; shelf: CardId[]; stage: 'gift' | 'open' | 'done' }
  | { k: 'AUCTION'; lot: LotKey; seller: SeatIndex | null; start: number; price: number; leader: SeatIndex | null;
      bidders: { seat: SeatIndex; st: 'active' | 'passed' | 'quit' }[]; unsold: 'ownerless' | 'keep'; stage: 'ask' | 'wait' | 'settle' }
  | { k: 'BANKRUPT'; seat: SeatIndex; cause: Cause; stage: 'detach' | 'endcheck' | 'liquidate' | 'auctions' | 'beggar' | 'done'; auctionLots: LotKey[] }
  | { k: 'SURRENDER'; seat: SeatIndex; stage: 'liquidate' | 'auctions' | 'target' | 'done'; auctionLots: LotKey[] }
  | { k: 'DAY'; stage: DayStage; cursor: number }
  | { k: 'VILLAIN'; v: VillainKind; stage: 'start' | 'moving' | 'act' | 'done' }
);
```

帧里只放可序列化的原始数据。一个帧只要可能被决策打断，就必须把游标（`stage`、`cursor`、`idx`）写在帧里，这样从任意中断点读档都能继续执行。

### 6.2 解释器（`core/flow.ts`）

```ts
export interface FrameHandler<F extends Frame> {
  step(ctx: Ctx, f: F): void;                                     // 推进一步：可能压子帧、ask、ctx.pop(f)
  resume?(ctx: Ctx, f: F, a: GameAction, d: PendingDecision): void; // 消费本帧发出的决策
}
export const FRAME_HANDLERS = { ROOT, TURN, MOVE, /*…*/ } satisfies { [K in Frame['k']]: FrameHandler<Extract<Frame, { k: K }>> };

function run(ctx: Ctx) {
  let guard = 0;
  while (ctx.s.pending.length === 0 && ctx.s.status === 'playing') {
    if (++guard > 200_000) throw new EngineInvariantError('FLOW_LOOP');
    const f = ctx.s.flow[ctx.s.flow.length - 1];
    if (!f) throw new EngineInvariantError('FLOW_EMPTY');       // ROOT 永不出栈
    if (actorGone(ctx, f)) { ctx.pop(f); continue; }             // 演员已破产的帧直接丢弃（TURN 帧除外，它转入 end）
    FRAME_HANDLERS[f.k].step(ctx, f as never);
  }
}

export function applyAction(state: GameState, action: GameAction) {
  const s = cloneState(state); const ctx = new Ctx(s, state /* 作为 diff 的影子基线 */);
  if (isSystemAction(action)) handleSystem(ctx, action);
  else {
    const d = s.pending.find(p => p.id === action.decisionId);
    if (!d) throw new EngineRuleError('STALE_DECISION');
    if (d.seat !== action.seat) throw new EngineRuleError('NOT_YOUR_DECISION');
    if (!ALLOWED_INTENTS[d.kind].includes(action.type)) throw new EngineRuleError('INTENT_NOT_ALLOWED');
    validateIntent(ctx, d, action);                               // 取消或判定失败时抛错，卡片不扣
    const f = s.flow.find(x => x.fid === d.frameId)!;
    ctx.clearPending(d.id);                                       // 并发帧（拍卖）由 resume 自行决定清除哪些 pending
    FRAME_HANDLERS[f.k].resume!(ctx, f as never, action, d);
  }
  run(ctx);
  ctx.flushSync();                                                // 还有未随事件公布的公开变化时，补发 SYNC{post}（开发模式告警）
  s.counters.action++;
  return { state: s, events: ctx.events };
}
```

- `ctx.ask(frame, seat, kind, options, defaultIntent, publicInfo, extra?)` 把决策压入 `pending`，id 为 `d${++counters.decision}`。**只在确实有选择时才问**：例如买不起就不问，手里没有被动卡就不问被动卡。
- **破产打断**：`ctx.pay()` 发现付不起时压入 `BANKRUPT` 帧并返回 `{bankrupt:true}`，调用方的 handler 必须立刻 `return`。BANKRUPT 帧处理完后调用 `unwindActor(seat)`：删掉栈里 `actor==seat` 的 MOVE、LAND、CARD 等帧；如果破产者就是当前回合的演员，把他的 TURN 帧改为 `stage='end'`。
- **游戏结束**：设 `status='over'`、`result`，清空 `pending`，run 循环随之退出。

---

## 7. 回合与日推进

### 7.1 ROOT 轮转

```
ROOT.step:
  stage 'seat'：从 nextSeatFrom 起按 seat 升序找下一个在场玩家；找到就压 TURN(seat)，
                并把 nextSeatFrom 设为 seat+1；越过最后一个座位则进入 'villains'
  stage 'villains'：按 idx 0..3 依次，对 onBoard 且有雇主的恶人压 VILLAIN 帧；做完进入 'day'
  stage 'day'：压 DAY 帧；DAY 完成后 nextSeatFrom=0，回到 'seat'
```

原版的 cursor 回到 0 号座位时推进一天。所以不论 0 号座位是否在场，每经过一轮都日推进一次。恶人在座位轮转结束后、日推进之前行动（oama reduce.ts，npcRoundStep）。

### 7.2 回合开始（`TURN.stage='start'`，VA 0x41c84f beginActorTurn）

```
0 若 !placed（首回合）：跳伞到随机可落脚节点（可走、非景观、无物件），来路设为随机邻格；emit PARACHUTE ⚑是否结算落点
1 refreshQuota：对每支股票，float ≤ 1000 时 quota = float；否则 quota = floor(float×(1000+rand15()%2000)/10000)   @0x42915a
2 贷款检查（loanDue>0）：剩余天数 = daysBetween(date, loanDue)
     3/2/1 天 → emit LOAN_REMINDER
     ≤0 → 按银行口径付款（先扣存款、再扣现金）归还全部贷款，burn；扣不出来就破产                      @0x41c86d
3 tickActorDay：
     主阻碍 hotel/away/jail/hospital 执行 tick2：
       c==0 → 不变
       c==0x80 → 置 0 并 release()：离开监狱或医院闸门、恢复 savedPrevNode 朝向、returning=true
       否则 c-1；结果为 0 时改成 0x80
     若主阻碍都为 0，再对 hibernate/sleepwalk/tortoise 执行 tick2（关押期间不倒数）；stay 总是执行 tick2
     alliance.days--（到期解除；双方敌意各 −20×PI）；insuranceDays--；bankReject--；god.days--（到 0 离场，搭档刷出）
     名下研究所 research.days--（到 0 交付道具 8+project，满 9 个则作废）；engineer.days--（到 0 恢复原交通工具）
4 若任一主阻碍 ≠ 0 → emit TURN_BLOCKED{remaining=(raw&0x7f)+1}，stage='end'
  若 returning → 走回棋盘：在当前节点只做物件结算（地雷、神明、礼物等，路障除外），不掷骰，stage='end'   @0x418f04
  若 hibernate ≠ 0 → TURN_BLOCKED{reason:'hibernate'}，stage='end'
  若 sleepwalk ≠ 0 → 自动掷 1 颗骰子，压 MOVE(mode='sleepwalk')，stage='landed'
  否则 stage='menu'
```

**两段式语义带来的回合数**（和原版编码一致，不需要额外解释）：

- 坐牢 N 天 = N 个被阻碍的回合 + 1 个走回棋盘的回合（不掷骰）。
- 停留卡：对自己写 0x80，本回合立即生效；对别人写 1，下回合 1→0x80 时生效。两者都是停留 1 次。
- 乌龟卡：对自己 2、对别人 3，两者都是乌龟步 3 次。
- 冬眠 5 天：跳过 5 个回合。

### 7.3 行动阶段（`TURN.stage='menu'`）

- 发出 `TURN_MENU` 决策，options 见 §9.3。
- 非终结 intent（USE_CARD、USE_ITEM、STOCK_*、BOARD_*、SET_DICE）执行完后回到 menu，重新发出新 id 的 TURN_MENU。
- 终结 intent：`ROLL`、遥控骰子（选点即掷）、对自己用传送机（本回合视为已掷骰）、`SURRENDER`。

### 7.4 掷骰（ROLL）

```
if rules.timeMachine!=='disabled' && player.controller==='human'：secret.timeAnchor = 由 applyAction 入参（掷骰前世界）构造
steps =
  st.stay ≠ 0      → 0（原地停留，仍然进行落点结算）
  st.tortoise ≠ 0  → 1（不掷骰；遥控骰子不在可用候选中）
  forcedSteps      → forcedSteps（遥控骰子，只用 1 颗骰子）
  否则             → Σ dice()，共 diceCount 颗（步行 1，机车 ≤2，汽车 ≤3，工程车 1）
emit DICE_ROLLED{dice[], steps, forced}
steps==0 → 直接压 LAND(node=当前)；否则压 MOVE(normal, remaining=steps, total=steps)
TURN.stage='landed'（MOVE 与 LAND 都出栈后进入 'end'）
```

### 7.5 逐格移动（MOVE）：路过与停下的划分

| 情形 | 路过（remaining>0） | 停下（remaining==0） |
|---|---|---|
| 路障 | **拦停**：移除（道具池 +1），remaining=0，照常结算该格 | 同左 |
| 身上的定时炸弹 | 每走一步 fuse−1；到 0 爆炸（住院 5 天、车毁、所在格地产降 1 级；可切换 manual3x3），移动终止；否则同格有别的玩家（在场、身上无炸弹、未受困）时转给座位号最小者，fuse 不重置 ⚑先倒数还是先转移 | 同左 |
| 银行（kind 14） | 未梦游且银行格上没有路障时：处于拒绝往来就只 emit BANK_REJECTED；否则压 BANK(pass)，发 BANK_ATM 决策，暂停移动 | 转入落点 BANK(stop) |
| 地雷、恶犬、神明、礼物、宝箱、乞丐、地面炸弹、各类特殊格 | 无效果 | 落点结算 |

```
MOVE.step:
  while remaining > 0:
    next = nextNode(node, prevNode)：
      候选 = adj 中非 0、≠prevNode、未被静态封堵的节点
      候选为空 → 退回 prevNode；否则 = 候选[pick('fork', 候选数)]（只有 1 个候选也消耗一次随机数）
    prevNode=node；node=next；seg.push(next)；remaining--；同步附身物（神明、炸弹）的位置
    炸弹倒数与转移 → 爆炸则 emitSeg(); push CONFINE(hospital,5,'bomb'); return
    路障 → emitSeg(); remaining=0; break
    银行路过 → emitSeg(); push BANK(pass); return          // BANK 完成后回到本帧继续走
  emitSeg()（emit MOVE_SEGMENT{actor, path:seg, remaining}）; seg=[]
  replace 自身为 LAND(node, steps=total)
```

乌龟模式不掷骰，只走 1 步。梦游模式不开 ATM，落点时跳过特殊格（见 7.6）。

### 7.6 落点顺序（LAND，@0x41b077 settle）

```
'beggar'：节点上有别人的乞丐 → PAYX(1000×PI → 公库)；乞丐移到随机节点                         @beggar.ts
'object'：该节点物件（每个节点至多 1 个）：
     地雷 → 移除（池 +1），车毁；CONFINE(hospital,3)（不走被动卡）→ 本 LAND 结束
     恶犬 → 步行：住院 3 天，恶犬离场、土地公刷出，本 LAND 结束；有交通工具：撞飞（离场、土地公刷出），继续
     地面定时炸弹 → 身上没有炸弹时挂上身（fuse 38）                                             @0x41bfd2
     礼物 → 按道具池剩余量加权随机给 1 个（1..8；池空或持有已满则没有）
     宝箱 → 点券 +500                                                                          @0x41bcb6
     神明（未附身）→ 压 GOD 帧（挤走旧神 → 附身 7/13 天 → 立即发威）
'square'：节点 kind：
     梦游中 → 特殊格（1..16）全部跳过；地产只结算过路费（不能买、不能盖）
     否则 SQUARE_HANDLERS[kind]
'tail'：神明显灵（天使 +1 级、恶魔 −1 级、土地公强占）→ 工程车拆房（PROGRAM：别人已有建筑的地产 → 0 级）⚑两者先后
'lab'：自己的研究所、未被查封、未梦游 → RESEARCH 决策
```

### 7.7 回合结束

`TURN.stage='end'`：清空 `turn.*`，emit `TURN_ENDED`，出栈，交回 ROOT。

### 7.8 恶人回合（VILLAIN，@0x40dd1f）

- 计数器 tick 与玩家相同。步数：`stay` 生效时为 0，乌龟为 1，否则 `rand15()%9+2`（2..10）。
- 岔路规则同 7.5；路障能拦住除小偷以外的恶人；恶人不开 ATM。
- 停下后：
  - 梦游中的恶人只检查是否到家。
  - 地雷：小偷拿走；其他恶人住院 3 天。
  - 恶犬：住院 3 天。
  - 然后执行 `VILLAIN_ACTIONS[kind]`（§10.9）。
- 离开过家（leftHome）后再次停在家格，就回到监狱或医院，雇主清空。

### 7.9 日推进（DAY，由 DayStage 游标驱动，可被分红破产、拍卖打断）

```
'date'     date+1；elapsedDays+1；weekday；emit DAY_ADVANCED
'victory'  时间到（elapsed ≥ limit 且首富资产 > 0）或 首富资产 ≥ multiple×initialFund
           → 设 result（在场首富获胜，平手取座位靠前者），GAME_OVER，结束
'pi'       PI = max(PI, divTrunc(divTrunc(Σ在场 netWorth, 在场人数), initialFund))；有变化才 emit      @rich4_update_price_index
'market'   marketClosedDays>0 → −1（从 1 到 0 的这一天仍然休市，所以文案 10 天实际约 11 天）；bankRunDays>0 → −1
           每支股票：suspend−1，up−1，down−1（周日也倒数）；marketOpen = 非星期日 且 非休市节日 且 marketClosedDays==0
           开市 → tickMarket（§11.5），emit MARKET_TICK
'holiday'  holidays[mapId] 命中：圣诞节（仅地图 0–3）每位在场玩家从牌堆加权抽 1 张；农历新年只 emit（BGM 标志）
'd15'      日期为 15 日：分红（按座位净额结算，§11.4；合计为负时先存款后现金扣，扣不出来才破产）→ 乐透开奖
'month'    日期为 1 日（跨月）：月结（无贷款者存款 ×1.1、评本期冠军和悲情人物、清零月度累计）→ 礼物、宝箱收回后重新随机摆放
'lots'     涨价/查封 days−1，到 0 清除；地契 tenure==date → 地主清空、等级保留、研究所的研发作废（RESEARCH_CANCELLED）
'end'      emit DAY_END（服务器用它触发自动存档），出栈
```

### 7.10 其他终局判定

- 破产后（BANKRUPT 的 'endcheck' 阶段）：
  - 在场真人数为 0 且 `endWhenNoHumans` → `noHumansLeft`（code 1）。
  - 在场只剩 1 人 → `lastStanding`（code 2 或 3）。
  - 以上两种情况**跳过清算**，地产原样保留。
- 总资产（§11.1）用 int32 计算，不乘物价指数。

---

## 8. 落点处理器（`squares/`，节点 flags 低字节 0..16）

| kind | 处理 |
|---|---|
| 0 地产 | 住宅：无主 → 满足 `canBuy`（未梦游、无土地公、无衰神或死神、现金 ≥ 价格）时发 BUY_LAND，否则 emit `INVEST_BLOCKED` 或 `CANNOT_AFFORD`；自己的 → 等级<5、非连锁店、现金足够时发 UPGRADE_LAND；别人的 → TOLL 帧。设施：无主 → BUY_FACILITY（价 = 设施地价×PI，与现有等级无关，exe 0x41a86b）；自己的 0 级 → BUILD_FACILITY（选类型，费用 = 地价×PI）；自己的 ≥1 级且未到上限 → UPGRADE_FACILITY（费用 = rate0×PI）；别人的 → FEE 帧（旅馆、购物中心、加油站；公园和研究所不收费）。企业：见下表 |
| 1 公园 | 无事发生 |
| 2 新闻 | 游标取下一张，不可行就跳过（游标照样前进），然后压 NEWS 帧 |
| 3 命运 | 同上，压 FATE 帧（先做加持判定） |
| 4 监狱 / 5 医院 | 不会被关。建筑内有别的受困玩家且自己点券 ≥30，或有可雇恶人且点券 ≥300 → BAIL 决策 |
| 6 企鹅挖宝 / 7 七彩气球 / 8 喜从天降 | 真人座位 → MINIGAME 决策（seed 由 rng 派生）；电脑座位 → 直接得 `50+rand15()%20` 点 |
| 9 乐透 | 现金 ≥ 1000 且有未售号码 → LOTTERY 决策 |
| 10/11/12 | 点券 +50/+30/+10 |
| 13 卡片 | 按牌堆剩余张数加权抽 1 张（满手时按规则处理） |
| 14 银行 | 压 BANK(stop)：先 ATM 再柜台 |
| 15 百货公司 | 压 SHOP：百货公司董事长进店时，先 50% 得一张随机卡、50% 得一个随机道具；货架 `rand15()%10+6` 张，从牌堆按张数加权、不放回地抽 |
| 16 魔法屋 | 压 MAGIC：抽条件（没人符合就重抽，最多 4 人）→ MAGIC_CAST 决策 |

**企业格**（`companyFee.ts`，行业码；费用进公司的 `surplusMonth` 和 `surplusTotal`；没有董事长就不收费；董事长本人停上去免费并享受特权；所有人都可以接着认购）：

| 行业 | 非董事长停留 | 董事长停留 |
|---|---|---|
| 1 航空 | 转盘得 n（⚑数值未知）；n>0 时付 `n×地价×PI`，并消失 n 天 | — |
| 3 电子 | `地价×elapsedDays`（不乘 PI） | — |
| 4 保险 | 转盘天数 d（⚑疑为 5/3/30/20/15/10）；付 `d×地价×PI`；insuranceDays=d ⚑覆盖还是累加 | 免费投保 d 天 |
| 5 汽车 / 6 石油 | 非步行时付 `地价×2^(交通等级−1)×步数×PI`（机车 1、汽车 2、工程车 4） | — |
| 11 建设 | CONSTRUCTION_PICK：选自己一块住宅 +1 级，付 `该地地价×PI`（⚑是否强制） | 免费 +1 级（可配为 2） |
| 12 门派 | `地价×步数×PI` | — |
| 2/7/8/9/10 | 不收费 | — |

- 认购：停在 ★ 公司、公司保留股 > 0 → SUBSCRIBE_SHARES 决策。每股单价 = `int(公司价值/10000)`；上限 `min(1000, 现金/单价, 保留股)`；用现金支付，钱 burn，不计入公司盈余。
- 设施收费：
  - 旅馆：`rate[level]×PI×N`（N 为 1..4，12 格转盘 4/3/2/3），涨价 ×2；强制住宿 N 天；不能用免费卡，可以嫁祸；大财神使费用为 0 时不住宿。
  - 购物中心：`rate[level]×PI×M`（M=1..6），涨价 ×2。
  - 加油站：`步数×500×k×PI`，步行免费。
  - 九种免收条件同住宅；设施收费不做同盟分账。

---

## 9. 决策模型

### 9.1 PendingDecision

```ts
export interface PendingDecision<K extends DecisionKind = DecisionKind> {
  id: string; frameId: number; seat: SeatIndex; kind: K;
  options: DecisionOptionsMap[K];            // 可能含私密信息，只下发给 seat
  publicInfo: { kind: K; seat: SeatIndex; lot?: LotKey; amount?: number; labelKey?: string };
  defaultIntent: PlayerIntent;               // 超时或兜底时使用，必须合法
  minigame?: { minigameId: 'penguin' | 'balloon' | 'fortune'; seed: number; params: MinigameParams };
  timing: 'menu' | 'confirm' | 'pick' | 'shop' | 'bank' | 'auction' | 'minigame' | 'lottery';
}
```

### 9.2 DecisionKind 全表

| DecisionKind | 触发 | options（节选） | allowedIntents | defaultIntent |
|---|---|---|---|---|
| TURN_MENU | 回合行动阶段 | 见 9.3 | ROLL, SET_DICE, USE_CARD, USE_ITEM, STOCK_BUY, STOCK_SELL, BOARD_LIST, BOARD_DELIST, BOARD_BUY, SURRENDER | ROLL |
| BANK_ATM | 路过或停在银行 | mode, cash, deposit, canWithdraw（挤兑时为 false）, reserveShortfallPayer | ATM{op,amount}, SKIP | SKIP |
| BANK_COUNTER | 停在银行，ATM 之后 | loanLimit=netWorth−loan, loanBlocked(挤兑/拒绝往来), dueDate预览, repayMax, financeLimit(董事长才有，=其他在场玩家存款和) | LOAN, REPAY, FINANCE, SKIP | SKIP |
| BUY_LAND | 无主住宅 | price, cash, level, street:{lots,owners}, tollAfter, fortuneBonus | CONFIRM, DECLINE | DECLINE |
| UPGRADE_LAND | 自己的住宅 | cost, fromLevel, toLevel(+福神加成), tollBefore/After | CONFIRM, DECLINE | DECLINE |
| BUY_FACILITY | 无主设施 | price, cash, level, type | CONFIRM, DECLINE | DECLINE |
| BUILD_FACILITY | 自己的 0 级设施 | cost, types:[{type,cap,feePreview}] | BUILD_FACILITY{type}, DECLINE | DECLINE |
| UPGRADE_FACILITY | 自己的设施 | cost, from/to, cap | CONFIRM, DECLINE | DECLINE |
| FACILITY_TYPE | 免费首建（天使显灵、魔法屋加盖） | types | CHOOSE_FACILITY_TYPE | {type:'park'} |
| RESEARCH | 自己的研究所 | level, current:{project,days}, projects:[1..level] | RESEARCH{project}, SKIP | 最高档 |
| SHOP | 百货公司 | points, handCount, shelf:[{idx,cardId,price}], items:[{id,price,pool,own,maxQty}], sell:{cards[{slot,cardId,value}], items[{id,count,unitValue}]} | SHOP_BUY_CARD, SHOP_BUY_ITEM, SHOP_SELL_CARD, SHOP_SELL_ITEM, LEAVE | LEAVE |
| LOTTERY | 乐透格 | cash, price:1000, sold:(seat\|null)[36], pool | LOTTERY_BUY{number}, SKIP | SKIP |
| BAIL | 监狱或医院格 | points, inmates:[{seat,remaining}], villains:[{kind,available}], costs:{bail:30,hire:300} | BAIL{seat}, HIRE{villain}, SKIP | SKIP |
| MINIGAME | 小游戏格（真人座位） | minigameId, maxScore | 仅服务器：MINIGAME_RESULT, MINIGAME_SKIP | MINIGAME_SKIP |
| MAGIC_CAST | 魔法屋 | condition, targets[], effects:[0..11 + 说明] | MAGIC_CAST{effect} | 名单含自己 → 6，否则 3 |
| CONSTRUCTION_PICK | 建设公司格 | lots:[{lot,level,cost}] | PICK_LOT{lot} (+SKIP ⚑) | 最便宜的一块 |
| SUBSCRIBE_SHARES | ★ 公司格 | unitPrice, max, cash, reserved | SUBSCRIBE{shares}, SKIP | SKIP |
| USE_FREE_CARD | 过路费、设施费、查税（罚款按开关） | amount, reason, payer | CONFIRM, DECLINE | CONFIRM |
| SCAPEGOAT | 持嫁祸卡且被陷害、梦游、收费、查税等命中 | context, amount/days, candidates:SeatIndex[] | SCAPEGOAT{target}, DECLINE | DECLINE |
| AUCTION_BID | 拍卖（多人并发） | lot, start, price, leader, increments:[0?,100,500,1000,5000,10000], cash, seller | BID{inc}, PASS, QUIT | PASS |
| BIRTHDAY_PICK | 命运「生日」（真人） | victims:[{seat,cards:[{slot,cardId}]}] | PICK_CARDS{picks} | 每人取 0 号卡槽 |
| DISCARD_CARD | handFull='choose' | hand:[{slot,cardId,price}], incoming | DISCARD{slot} | 最便宜的一张 |
| DEATH_GOD_TARGET | 投降之后 | candidates | DEATH_GOD_TARGET{seat} | 资产最高的对手 |

**没有以下决策**：CHOOSE_PATH（岔路随机）；转盘和老虎机（结果由 RNG 决定，客户端只演出，真人点「停」不影响结果）；免罪卡、复仇卡（自动生效）。

### 9.3 TURN_MENU options 与目标候选

```ts
interface TurnMenuOptions {
  dice: { allowed: (1|2|3)[]; current: number; locked: null | 'stay' | 'tortoise' | 'sleepwalk' };
  cards: { slot: number; card: CardId; usable: boolean; reason?: ReasonKey; targets: TargetCandidates }[];
  items: { item: ItemId; count: number; usable: boolean; reason?: ReasonKey; targets: TargetCandidates }[];
  stock: { open: boolean; reason?: 'sunday' | 'holiday' | 'halted';
           rows: { idx: number; priceCents: number; changePct10: number; quota: number; float: number;
                   limitUp: boolean; limitDown: boolean; suspended: boolean; shares: number; costCents: number;
                   maxBuy: number; maxSell: number; chairman: SeatIndex | null }[]; deposit: number };
  board: { listings: ListingView[]; mine: number; canList: boolean; caps: { lotMarket: Record<LotKey, number> } };
  canSurrender: boolean; timeMachine: { usable: boolean; anchorTurn: number | null };
}
type TargetCandidates =
  | { t: 'none' } | { t: 'seat'; seats: SeatIndex[] } | { t: 'actor'; actors: ActorRef[] }
  | { t: 'lot'; lots: LotKey[]; needType?: LotKey[] }            // needType：0 级设施首建时需要附带类型
  | { t: 'underfoot'; lot: LotKey; types?: FacilityType[] } | { t: 'lotPair'; from: LotKey; to: LotKey[] }
  | { t: 'lotOrObject'; lots: LotKey[]; objects: number[] } | { t: 'stock'; stocks: number[] }
  | { t: 'node'; nodes: NodeId[] } | { t: 'anyNode' } | { t: 'dice'; values: (1|2|3|4|5|6)[] }
  | { t: 'rob'; victims: { seat: SeatIndex; cards: { slot: number; card: CardId }[]; items: { item: ItemId; count: number }[] }[] }
  | { t: 'teleport'; sources: TeleportSource[]; roads: NodeId[]; lands: LotKey[] };
```

- 候选全部由引擎计算（视窗半宽 `windowHalf`，以使用者棋子的世界坐标为中心）。客户端只负责高亮，并提供 DOM 备用列表。
- 私密手牌模式下，`rob.victims[].cards` 只下发给决策者（它本来就在 options 里）。

### 9.4 PlayerIntent（`types/intent.ts`；zod 模式只包含玩家 intent）

```ts
export type PlayerIntent =
  | { type: 'ROLL' } | { type: 'SET_DICE'; count: 1 | 2 | 3 }
  | { type: 'USE_CARD'; slot: number; card: CardId; target: CardTarget }
  | { type: 'USE_ITEM'; item: ItemId; target: ItemTarget }
  | { type: 'STOCK_BUY' | 'STOCK_SELL'; stock: number; shares: number }
  | { type: 'BOARD_LIST'; asset: Listing['asset']; price: number } | { type: 'BOARD_DELIST' | 'BOARD_BUY'; listingId: number }
  | { type: 'SURRENDER' } | { type: 'CONFIRM' } | { type: 'DECLINE' } | { type: 'SKIP' } | { type: 'LEAVE' }
  | { type: 'BUILD_FACILITY' | 'CHOOSE_FACILITY_TYPE'; facility: FacilityType }
  | { type: 'ATM'; op: 'deposit' | 'withdraw'; amount: number }
  | { type: 'LOAN' | 'REPAY' | 'FINANCE'; amount: number }
  | { type: 'SHOP_BUY_CARD'; shelfIdx: number } | { type: 'SHOP_SELL_CARD'; slot: number }
  | { type: 'SHOP_BUY_ITEM' | 'SHOP_SELL_ITEM'; item: ItemId; qty: number }
  | { type: 'LOTTERY_BUY'; number: number } | { type: 'BAIL'; seat: SeatIndex } | { type: 'HIRE'; villain: VillainKind }
  | { type: 'MAGIC_CAST'; effect: number } | { type: 'RESEARCH'; project: 1 | 2 | 3 | 4 | 5 }
  | { type: 'PICK_LOT'; lot: LotKey } | { type: 'SUBSCRIBE'; shares: number }
  | { type: 'BID'; inc: 0 | 100 | 500 | 1000 | 5000 | 10000 } | { type: 'PASS' } | { type: 'QUIT' }
  | { type: 'SCAPEGOAT'; target: SeatIndex } | { type: 'PICK_CARDS'; picks: { from: SeatIndex; slot: number }[] }
  | { type: 'DISCARD'; slot: number } | { type: 'DEATH_GOD_TARGET'; seat: SeatIndex };
export type SystemAction =
  | { type: 'MINIGAME_RESULT'; seat: SeatIndex; decisionId: string; score: number }
  | { type: 'MINIGAME_SKIP'; seat: SeatIndex; decisionId: string }
  | { type: 'SYS_SET_CONTROLLER'; seat: SeatIndex; controller: 'human' | 'ai' }   // 被踢以后转为纯电脑；影响真人计数和时光机
  | { type: 'SYS_SET_AI_PROFILE'; seat: SeatIndex; profile: AiProfile }
  | { type: 'SYS_DEBUG'; op: DebugOp };              // 需要 config.debug：forceNext/setCash/teleport/give/setDate
export type GameAction = (PlayerIntent & { seat: SeatIndex; decisionId: string }) | SystemAction;
```

### 9.5 拍卖并发协议（AUCTION 帧，公开竞价、按服务器到达顺序处理）

```
起拍价 start = mul32(divTrunc(地价×(2+等级), 2), PI)      // 即 trunc(地价×(1+0.5×等级))×PI
参与者：除卖方外所有在场、未受困的玩家（原地主可以参加）⚑受困者能否参加
step('ask')：eligible = st=='active' 且 ≠leader 且 现金 ≥ (leader ? price+100 : start) 的参与者
  为空 → 'settle'
  否则对每个 eligible 同时 ask AUCTION_BID（每人各自一个 id、各自计时）→ 'wait'
resume：
  BID{inc}：inc==0 只在 leader==null 时合法；newPrice = (leader==null ? start : price) + inc，且 ≤ 出价者现金
            price=newPrice；leader=seat；所有 'passed' 恢复为 'active'（原版：PASS 只保持到下一次有人成功加价）
            清掉本帧其余所有 pending（其他人正在提交的请求会得到 STALE_DECISION）；emit AUCTION_BID → 'ask'
  PASS：该人 st='passed'；只移除他自己的 pending
  QUIT：st='quit'（永久退出）
  本帧已没有 pending → 'ask'（会发现 eligible 为空 → settle）
settle：有 leader → 用现金付给卖方（没有卖方则进公库），地产归 leader，等级保留，tenure 重算；
        无 leader → 若 unsold='ownerless'（拍卖卡）则该地变为无主、tenure 清零；emit AUCTION_ENDED
```

- 拍卖来源：拍卖卡（卖方为出卡者）、破产清算和投降（最多 3 块，钱进公库）、新闻 7（无卖方）、魔法屋 11（无卖方 ⚑）。
- 服务端为每个并发决策独立计时（net §5.4 已支持）。超时默认 PASS。

---

## 10. 效果系统

### 10.1 注册表接口

```ts
export interface CardEffect<C extends CardId> {
  id: C; passive: boolean;
  candidates(ro: RoCtx, seat: SeatIndex): TargetCandidates;          // 用于 TURN_MENU options
  validate(ro: RoCtx, seat: SeatIndex, t: CardTarget): ReasonKey | null; // 不为 null 时抛 EngineRuleError，卡保留
  start(ctx: Ctx, seat: SeatIndex, t: CardTarget): void;              // 扣卡（回牌堆）、emit CARD_USED、执行或压 CARD 帧
  step?(ctx: Ctx, f: CardFrame): void; resume?(ctx: Ctx, f: CardFrame, a: GameAction): void;
}
export const CARD_EFFECTS = { 1: equalWealth, /* … */ 30: tortoise } satisfies { [C in CardId]: CardEffect<C> };
// ITEM_EFFECTS、GOD_EFFECTS、NEWS_HANDLERS、FATE_HANDLERS、MAGIC_EFFECTS、VILLAIN_ACTIONS 形式相同
```

「已选定合法目标但结果无变化」时照样扣卡（例如天使卡打满级地块）。验证失败或取消时不扣卡。

### 10.2 30 张卡（data/cards.ts 数值来自 exe 卡表 @mytbk rich4_card_table.c，⚑需与 v2.06 对比）

| id | 卡 | 目标 | 效果（PROGRAM） | 敌意（被害者对出卡者） |
|---|---|---|---|---|
| 1 | 均富 | 无 | 所有在场玩家现金相加后平均（divTrunc），每人现金设为平均值 | 高于平均者：(现金−平均)/100 |
| 2 | 均贫 | 视窗内对手 | 两人现金相加除以 2 | 同上 |
| 3 | 购地 | 脚下他人的住宅或设施 | 付 `(地价+等级×房价)×PI` 给原主（现金不足则失败，卡保留），tenure 重算 | 地价×PI×(等级+2)/5 |
| 4 | 换地 | 脚下地块与视窗内同类的另一地块 | 交换 owner（tenure 跟地走 ⚑） | 无 |
| 5 | 换屋 | 同上 | 交换 等级+连锁店（设施为 等级+类型），不检查等级上限 | 无 |
| 6 | 转向 | 视窗内任何演员（含自己、恶人，不含娃娃） | 反向，来路随机重设 | 无 |
| 7 | 改建 | 脚下 ≥1 级（不论谁的地） | 住宅：在普通和连锁店之间切换（变连锁店时等级取 min(等级,1)）；设施：改为指定类型（公园、加油站取 min(等级,1)） | 无 |
| 8 | 拍卖 | 脚下任何地产 | 压 AUCTION（卖方 = 出卡者，流拍则变无主） | — |
| 9 | 天使 | 视窗内地产 | 住宅：同名路段每块 +1 级（满级跳过，连锁店只能 0→1）；设施：+1 级（0 级需附带类型） | 无 |
| 10 | 恶魔 | 视窗内地产 | 住宅：同名路段全部夷平到 0、连锁店复位，地主保留；设施：只夷平这一处 | 每块有主地：等级×30×PI |
| 11 | 怪兽 | 视窗内他人已有建筑 | mutate mode 2（夷平，地主和 tenure 保留） | 等级×30×PI |
| 12 | 拆除 | 视窗内他人已有建筑，或路障、地雷、地面炸弹 | 建筑按 mode 0 拆一级；物件移除后回道具池 | 30×PI |
| 13 | 抢夺 | 视窗内对手 + 指定 1 张卡或 1 个道具 | 抢卡：满手先弃自己最便宜的；抢道具：自己已有 9 个则该道具回池 | 所抢物品的标价 |
| 14 | 停留 | 视窗内任何演员 | stay = 对自己 0x80，对别人 1 | 无 |
| 15 | 冬眠 | 所有对手 | hibernate=5，并清除梦游。跳过：自己、已出局、不在棋盘上（受困、消失、未落地）、住旅馆中；在场恶人也冬眠 | 每人 150×PI |
| 16 | 梦游 | 视窗内对手或恶人 | CARD 帧的伤害链（10.3）：梦游 5 天（被嫁祸回出卡者为 4 天），交通工具退回背包、骰子数改为 1；目标冬眠中则无效但扣卡 | 150×PI |
| 17 | 陷害 | 同上 | 伤害链：坐牢 5 天（被嫁祸回出卡者为 4 天） | 150×PI |
| 18–21 | 复仇、嫁祸、免费、免罪 | 被动卡，不能主动打出 | 见 10.3 | — |
| 22 | 送神符 | 自己 | 有炸弹就送走炸弹；神明属于 {5,6,7,8,10,15} 时送走（开关可排除 15）；什么都没送走则失败、卡保留 | — |
| 23 | 请神符 | 自动选择 | 视窗内欧氏距离最近、未被附身的可附身神明（平手先比 y 再比 x）→ 压 GOD 帧；没有则失败 | — |
| 24/25 | 红卡、黑卡 | 任意股票 | PROGRAM：up=2、down=0（黑卡相反），立即按前日价重定 ±10%，覆盖当日走势点；MANUAL：3 个开市日，红黑互相抵消 | 无 |
| 26 | 查税 | 视窗内对手 | 查税链：税额 = divTrunc(现金,5) → 免费卡 → 税额 >2000 可嫁祸（按新目标现金重算，嫁回出卡者则不收）→ 税款进出卡者**存款** | 税额/100 |
| 27/28 | 涨价、查封 | 视窗内地产 | 住宅：同名路段 mark = {raise 或 seal, 5}；设施：只标这一处；PROGRAM 下后写覆盖前写 | 无 |
| 29 | 同盟 | 视窗内对手 | 先解除双方各自的旧同盟，再互相绑定 7 天 | 无 |
| 30 | 乌龟 | 视窗内任何演员 | tortoise = 对自己 2，对别人或恶人 3 | 无 |

- `addHostility` 对盟友写入正敌意时，同盟立即解除。
- 牌堆守恒：使用、被动消耗、卖出、弃牌、没收的卡都回到牌堆。

### 10.3 被动卡：触发点与顺序（`flow/confine.ts`、`flow/toll.ts`、`effects/cards/harm.ts`）

| 触发点 | 免罪 21 | 免费 20 | 嫁祸 19 | 复仇 18 | 依据 |
|---|---|---|---|---|---|
| 陷害卡、梦游卡命中玩家 | ①自动，优先，消耗后结束 | — | ②问目标（候选：在场、非自己，可以是出卡者）| ④最终目标 == 原目标且原目标持复仇卡 → 出卡者受同样惩罚 5 天 | @0x44476a、@0x4442f2 |
| 查税卡 | — | ①问 | ②税额 >2000 时问 | — | cards §5 |
| 住宅过路费、购物中心费、加油站费 | — | ①费用 ≥2000×PI 或 > 现金+存款时问 | ②问 | — | @0x419e34、@0x41a60e |
| 旅馆费 | — | ✗ | 问 ⚑被嫁祸后谁去住宿 | — | property §6.2 |
| 新闻 29 董事长超贷坐牢 | 自动 | — | 问 | — | squares #29 |
| 魔法屋 坐牢、住院 | 自动 ⚑ | — | 问 ⚑ | — | 0x441210 |
| 命运 33–36 坐牢 | 自动 ⚑ | — | 问 ⚑ | — | cards §5 事件 |
| 命运、新闻的罚款 | — | 由 `freeCardOnFines` 决定 | 同左 | — | 说明书 |

- 伤害链阶段顺序：'hostility' → 'exempt' → 'scapegoat' → 'apply' → 'revenge'。
- 死神代付发生在过路费链路的 'pay' 之前：场上有人被死神附身、且付款人不是他时，由死神附身者代付。

### 10.4 13 种道具（data/items.ts；exe 道具表；1..8 共享库存各 10 个；每种最多持有 9 个）

| id | 道具 | 目标 | 效果 |
|---|---|---|---|
| 1 | 机器娃娃 | 无 | 从脚下沿前进方向走 9 步（岔路随机），清掉沿途未附身的物件和神明（神明离场后搭档刷出）；用完回池 |
| 2/3/4 | 路障、地雷、定时炸弹 | 视窗内的空节点：无人、无物件、无神明、未设禁放位 | 放到地上（放置者记在 placedBy） |
| 5/6 | 机车、汽车 | 无 | 装备：原交通工具退回背包（可以因此达到第 10 台），diceCount 设为该交通工具上限 |
| 7 | 飞弹 | 任意节点 | 以节点坐标为中心、半宽 100 的方窗：地产 mode 0；窗内演员车毁、住院 3 天；物件和未附身神明清除。敌意：地主 30×PI，被炸者 90×PI |
| 8 | 遥控骰子 | 点数 1..6 | forcedSteps=v，立即执行 ROLL；乌龟生效时不可用 |
| 9 | 机器工人 | 视窗内地产 | +1 级，不看归属；0 级设施需附带类型 |
| 10 | 时光机 | 无 | §10.10 |
| 11 | 传送机 | 演员、未附身神明、物件、房屋 → 空道路或空地 | 被传送者不触发落点、过路费、炸弹倒数；对自己使用则本回合视为已掷骰 |
| 12 | 工程车 | 无 | 保存原交通工具（机车或汽车退回背包），骰子 1 颗，持续 7 个自己的回合；停在别人已有建筑的地产上 → 夷平到 0（PROGRAM） |
| 13 | 核子飞弹 | 任意节点 | 半宽 220：地产 mode 1（清为无主）；窗内人员车毁、住院 3 天；物件和神明清除（施放者也在判定范围内） |

商店只卖 1..8（池 > 0 的才上架）；卖出得 `divTrunc(单价×数量×9,10)` 点券，1..8 回池，9..13 直接消失；百货公司盈余 += 点券价×10。

### 10.5 神明（data/gods.ts：好坏、搭档、天数、三项运势、过路费修正、发威、显灵）

| kind | 神 | 发威（附身时） | 过路费（付款方） | 其他 |
|---|---|---|---|---|
| 1 小财神 | 3 位老虎机 X（0..999，不乘 PI），每位在场对手付 X 给他（进现金） | ÷2（`t>>1`） | 财运 +100 |
| 2 大财神 | 4 位老虎机，得 X（mint） | 0 | 财运 +150 |
| 3 小福神 | 从牌堆抽 1 张 | — | 投资后多送 1 级；福运 +100 |
| 4 大福神 | 抽 2 张 | — | 同上；福运 +150 |
| 5 小穷神 | 付给每位对手 X（进对方存款） | ×1.5（或 ×2） | 财运 −60 |
| 6 大穷神 | 付 X 给银行（burn） | ×2 | 财运 −100 |
| 7 小衰神 | 随机丢 1 张卡 | — | 禁止一切投资；福运 −60 |
| 8 大衰神 | 丢 floor(n/2) 张（n>1 时） | — | 同上；福运 −100 |
| 9 天使 | 无 | — | 显灵：落点 +1 级（在买地、付费之后）；财运、福运各 +60 |
| 10 恶魔 | 无 | — | 显灵：落点有建筑就 −1 级（自己的也拆）；财运、福运各 −60 |
| 11 恶犬 | 不附身，步行被咬住院 3 天 | — | 搭档是土地公 |
| 12 土地公 | 无 | — | 显灵：不是自己的地就强占（先照付过路费），普通买地被屏蔽；住旅馆时跳过 |
| 15 死神 | 没收全部卡片和道具（回牌堆、道具池，不折点券） | 本人按原价付；当地主时免收；**别人的过路费由他代付** | 禁止投资；13 天 |

- 衰运（bad）：小财、小福 −100，大财、大福 −200，小穷、小衰、恶魔 +100，大穷、大衰 +200，土地公 −500，死神 +1000，天使 −100。衰运只用于 AI 估值和悲情人物评分。
- 附身时把三项运势加上去，离身时减回来。
- 离场（期满、被挤走、送神、娃娃扫走、被炸、恶犬离场）后，搭档在随机节点刷出：可走、无禁放位、无人、无物件，并且与参照点在 X 或 Y 方向上相距 ≥300（最多尝试 64 次，之后改为任意合法节点）。
- 每对搭档同一时刻最多一个在场。

### 10.6 新闻 36 条（data/news.ts：`{id, textKey, effect, feasible, src}`；按 effect.k 分派处理函数；PROGRAM 下不做加持判定）

| # | effect.k | 参数与规则 |
|---|---|---|
| 0/2 | releaseAll | 监狱或医院里的所有玩家立即释放（可行条件：有人受困） |
| 1/3 | extendAll | 所有受困者 +3 天（有保险者照赔） |
| 4 | alienAttack | 随机选一处已有建筑的地产为中心、半宽 100：地产 mode 1；窗内的人住院 3 天、车毁；清物件和神明 |
| 5 | monster | 随机一处已有建筑的地产 → mode 1 |
| 6/14 | streetPrice ×13/10、×7/10 | 随机地产：住宅改同名路段的 landPrice（divTrunc）；设施只改这一处 |
| 7 | publicAuction | 随机无主地产 → AUCTION（无卖方） |
| 8 | rewardTopLandlord | 地产数最多者（并列取第一个）mint 10000×PI 到现金 |
| 9 | subsidyFewest | 有地者中地产数最少者（并列取最后一个）得 5000×PI |
| 10 | rewardTopShareholder | 持股总数最多者得 10000×PI |
| 11 | incomeTax | 每人付 divTrunc(现金,20) → 公库（不乘 PI） |
| 12 | landTax | 每人付 `divTrunc(Σ(地价+等级×房价),20)×PI` → 公库（可能破产） |
| 13 | stockTax | 每人付 `divTrunc(持股市值,20)×PI` → 公库 |
| 15 | gasExplosion | 随机一块已有建筑的住宅 → mode 0 |
| 16/17 | stayByVehicle | 步行者、或骑车开车者：stay=1 |
| 18 | earthquake | 随机地产：住宅则同名路段各 mode 0；设施只这一处 |
| 19 | flood | 随机任一地产 → mode 1 |
| 20 | typhoon | 随机中心、半宽 100：所有地产 mode 0，不伤人 |
| 21 | tornado | 随机一处 → mode 0 |
| 22 | bankRun | bankRunDays=15 |
| 23 | bonusInterest | 无贷款者 mint 存款的 1/10 |
| 24/25 | marketAll down/up | 12 支全部 down=1 或 up=1，立即重算价格 |
| 26 | marketHalt | marketClosedDays=10 |
| 27/28 | suspend / resume | 随机一支停牌 `stockSuspendDays` 天；随机一支停牌股复牌 |
| 29 | overLoanJail | 随机一家有董事长的公司，董事长 CONFINE(jail,5, passive) |
| 30/33/34 | companyFine | 盈余 −10000、−10000、−5000（不乘 PI），down=3 |
| 31/32 | overseas | +20000 且 up=3；−20000 且 down=4 |
| 35 | doubleProfit | 本月盈余 >10000 的公司：盈余 ×2，up = min(15, 原盈余/10000) |

- 抽牌：游标前进；不可行就继续取下一张，最多 36 次。
- 事件里的地名、公司名、人名都通过 `params` 带给客户端做 i18n 插值。

### 10.7 命运 37 条（data/fate.ts：`{id, effect, blessing: 'reward'|'penalty'|'misfortune'|null, amountPI?, src}`）

| # | 规则 |
|---|---|
| 0 | 随机拆掉自己一栋已有建筑的住宅（level=0），按 等级×房价 补偿现金 ⚑ |
| 1 | 自己一块空地被征收，变无主，按地价补偿 ⚑ |
| 2 | 冒贷：loan += 10000×PI（罚金类加持）；没有到期日时设置到期日 |
| 3 | 银行拒绝往来 30 天（罚金类加持） |
| 4 | 每位对手存款的 1/10 转入自己的存款 |
| 5 | 生日：每位有卡的对手给自己 1 张。真人弹 BIRTHDAY_PICK；电脑随机拿 |
| 6/7 | 出国或被外星人绑架：CONFINE(away,3)（劫难类加持） |
| 8 | 每支持股损失 1/10（退回市场流通），价值进公库 |
| 9 | 按市价卖光全部持股，钱进存款 |
| 10/11 | 失去机车、汽车（按交通工具在两者间互换；步行时不可行；劫难类加持） |
| 12/13 | 住院 3 天（开汽车时不可行，骑机车时改为 13） |
| 14/15/16 | 罚 3000×PI → 公库（按交通工具三选一） |
| 17/18/19 | 罚 6000、600、1500 ×PI → 公库 |
| 20/21/22/25/27/28/29/31 | 得 1000、2000、3000、10000、4000、6000、8000、5000 ×PI（奖金类加持，mint 到现金） |
| 23/24/26/30 | 损失 1000、2000、8000、5000 ×PI → 公库 |
| 32 | 卖掉全部卡片和道具，按 ×0.9 折成点券（劫难类加持） |
| 33–36 | CONFINE(jail, 3/5/7/9, passive ⚑)（劫难类加持）；文案按地图换，只在地图 0–3 可行 |

加持判定：值 >100 必定为 high；50<值≤100 时有 50% 为 high（消耗随机数）；0..50 为 none；<0 为 low。

| 类别 | high | low |
|---|---|---|
| 奖金 | ×2 | 作废 |
| 罚金 | 免付 | ×2 |
| 劫难 | 逃过此劫 | 天数 ×2 |

### 10.8 魔法屋（data/magic.ts）

- 条件：`rand15()%12` 抽取，没人符合就重抽，每条最多选 4 人。
  0 财产最多（并列都算）、1 地产最多（0 不参选）、2 房屋最多、3 现金最多、4 存款最多、5 点券最多、6 步行、7 骑机车、8 开汽车、9 神明附身、10 男生、11 女生。
- 效果（按名单逐人执行）：
  - 0 卖掉所有卡，**按原价**折成点券 ⚑
  - 1 连抽 3 次命运（按目标自己的加持判定）
  - 2 坐牢 3 天（passive ⚑）
  - 3 stay=1
  - 4 现金全部存入存款
  - 5 脚下地产 +1 级（0 级设施弹 FACILITY_TYPE）
  - 6 得 1 张卡
  - 7 转向（受困者不受影响）
  - 8 卖掉所有道具，含交通工具
  - 9 脚下地产 −1 级
  - 10 住院 3 天（passive ⚑）
  - 11 拍卖脚下地产（无卖方 ⚑）
- 电脑怎么选效果属于 AI 策略；引擎的 defaultIntent 见 9.2。

### 10.9 四大恶人与乞丐（effects/villains，@oama npc-actions.ts；收益一律交给雇主）

| 恶人 | 家 | 停下时的行为 |
|---|---|---|
| 小偷 | 监狱 | 同格座位号最小、且不是雇主的玩家：点券减半（`>>1`），被偷的点券给雇主；拿走节点上的礼物、宝箱、路障、地雷、地面炸弹交给雇主；路障拦不住他 |
| 强盗 | 监狱 | 停在银行时，每位非雇主的对手付存款的 20% 给雇主（现金优先，可能破产）；并从同格受害者手里随机偷 1 张卡 |
| 流氓 | 医院 | 停在别人的地产（不是雇主的）：住宅收 `Σ同名路段且同一地主的 landPrice × PI`，设施收 `landPrice × PI`；也偷卡 |
| 间谍 | 医院 | 停在公司（雇主不是董事长）：拿走公司的本月盈余（为负时反过来由雇主付给公司）；停在住宅或设施：拿走 lastToll 或 lastFee ⚑（程序中未证实）；也偷卡 |

- 雇用：BAIL 决策里的 HIRE 花 300 点券，恶人从家格出发，**当场立即走一次**（oama），雇主 = 雇用者。
- 恶人被地雷、恶犬、飞弹送医院 3 天，或被陷害坐牢 5 天，释放后仍在棋盘上，雇主不变 ⚑。
- 乞丐：破产者的棋子留在原节点。别人停在同一节点时施舍 1000×PI 进公库，之后乞丐移到随机节点。

### 10.10 时光机的联机语义（effects/timeMachine.ts）

- **锚点**
  - 真人座位（controller=human）提交 ROLL 时，用 applyAction 入参（掷骰前的世界）生成锚点：`world = publicWorld(state) + flow + 新闻命运的牌序和游标`。锚点**不含** rng、上一个锚点、counters。
  - `global` 模式：全场只有一个锚点，每次真人掷骰都覆盖（和原版一致）。
  - `perSeat` 模式：每个座位一个锚点，存放在 `secret.timeAnchors[seat]`。
- **使用**：只有真人能用，只能在 TURN_MENU 中使用。
  1. 恢复锚点世界。
  2. rng 保持当前值，作为后续的延续点，不回滚。
  3. counters 保持当前值（决策 id 不回退）。
  4. 在恢复后的世界里，使用者的时光机数量 −1（最低为 0）。
  5. 用扣减后的世界更新锚点（反复使用不会让时光机「回来」）。
  6. 清空 pending，重新运行帧栈（锚点时刻的 TURN 帧处于 menu 阶段，所以轮到锚点座位重新行动）。
- 事件：发 `TIME_REWOUND{bySeat, toTurnNo, resetsView:true}`，再发一个完整的 `SYNC`。客户端遇到它直接 `reset(batch.view)`。
- AI 永不使用。
- 服务器 journal 里照常记录这个 action，所以重放仍然确定。

### 10.11 路面物件与定时炸弹

- 每个节点至多 1 个物件；可放置节点 = 可走 + 无禁放位（bit31）+ 无人 + 无神明。
- 路障、地雷、定时炸弹的地图上限都是 10（和道具池共同保证）。定时炸弹的槽位同时计入地面上的和挂在身上的。
- 每月 1 日，礼物、宝箱各重新摆放 1 个（先移除旧的）。

---

## 11. 金钱、银行、股市、乐透、月结

### 11.1 资产与物价指数（rules/wealth.ts，@rich4_calculate_player_wealth）

```
netWorth = cash + deposit − loan
         + Σ trunc(持股 × 股价分 / 100)
         + Σ 自有住宅 (landPrice + (chain ? 房价 : 等级×房价))
         + Σ 自有设施 (landPrice + 等级×rate0)
```

- 全程 int32 计算，不乘 PI。
- 特别融资不扣除（它已计入 deposit，所以会虚增银行董事长的资产，和原版一致）。
- PI 计算见 7.9。

### 11.2 付款（rules/payment.ts）

```ts
type Party = { seat: SeatIndex } | { company: CompanyId } | 'pool' | 'bank';
transfer(ctx, from: Party, to: Party, amount, o: { order: 'cashFirst' | 'depositFirst'; credit: 'cash' | 'deposit';
         reason: MoneyReason; accident: boolean }): { paid: number; bankrupt: boolean }
```

- **玩家付款**：按 order 顺序扣两个口袋；两个都扣不够时，`paid` = 他还剩的全部，并压入 BANKRUPT。收款方只收到 `paid`。
- **公司付款**：可以为负，不会破产。
- **公库和银行**：`'bank'` 表示 mint 或 burn，计入 ledger。
- **只能用现金的消费**（买地、盖房、买设施、购地卡、乐透、认购、公布栏）走 `spendCash()`：`价格 > 现金` 就失败，不会破产，钱 burn。
- `accident=true` 时累计付款方的 `monthly.loss` 和收款玩家的 `monthly.gain`。

### 11.3 银行

- **ATM**：存、取各一笔，无手续费。
  - 挤兑期间只能存。
  - 其他玩家取款后，若其他在场玩家的存款合计 < 董事长的融资余额，差额由董事长按银行口径（先存款后现金）垫付，同时融资余额相应减少。
- **柜台**（只有停下才能办，三选一，每次限一笔）：
  - **贷款**：金额 ≤ netWorth − loan；贷款期间借款进存款（mint）。第一次借款时设置到期日 = 90 天后，落在休市日（星期日或休市节日）就顺延到下一个开市日；追加借款不延期。
  - **还款**：先扣存款、再扣现金（burn）；还清后到期日清零。
  - **特别融资**：只有银行董事长可以办；上限为其他玩家存款合计；进存款并累加到 finance；没有期限。董事长易主时**不**强制归还（oama）。
- **利息**：每月 1 日，loan==0 的玩家存款 += divTrunc(存款,10)（mint）。
- **保险理赔**：被关押、出国、住旅馆且 insuranceDays>0 时，赔 2000×天数×PI，从保险公司的本月盈余付到现金。

### 11.4 分红与乐透（15 日）

- **分红**（exe 0x42ba97，按座位净额结算）：对每家公司，T = 在场玩家持股合计。
  - T>0：每位股东应分 `trunc(本月盈余 × f32(持股 / T))`（比例先存成 float32，常比精确值少 1），累加到该座位的合计；之后本月盈余清零。
  - T=0：保留盈余。
  - 全部公司算完后逐座位一次入账：合计为正进存款；为负按先存款后现金扣，扣不够才破产（原因记第一家亏损公司）。
    例：A 公司 −20000、B 公司 +50000 → 净得 +30000，不破产。整次分红只发一个 DIVIDENDS（rows 按公司、座位逐条列出）。
- **乐透**：没有卖出任何号码就不开奖。
  - 有人持号 >10 个：只在已售号码里开。
  - 否则：在 1..36 里随机开。
  - 中奖者拿走整个公库（进现金）；公库清零，所有号码清空。
  - 无人中奖：公库和号码原样保留到下一期。

### 11.5 股市（rules/stock.ts；价格单位为分）

```
tickMarket(rng):
  G = (rand15() − 16384) / 4097
  for s in stocks:
    prev = s.priceCents; s.prevCents = prev
    if s.suspend > 0：rate = 0
    elif s.up > 0 || s.down > 0：rate = s.up > 0 ? 10 : −10
    else：
      shock = (rand15() − 16384) / 1171
      rate = s.momentum + shock × vol + G
      均值回归：有公司的股票 anchor = 公司价值/10000，上下界 3.0 / 0.85；否则 anchor = 初始价，上下界 8.0 / 0.5
        prev 高于上界：rate>0 时减半，否则加倍
        prev 低于下界：反过来
    s.momentum = clamp(rate, −10, 10)
    raw = prev × (100 + s.momentum) / 100
    tick = tickCents(raw)                       // raw 按元计 <5 → 1，<15 → 5，<50 → 10，<150 → 50，其余 100（单位：分）
    s.priceCents = clamp(prev + trunc((raw − prev) / tick) × tick, 100, 999900)
    history.push（最多保留 144 个）
```

- 涨停、跌停的判定：当日价与「前日价 ±10% 后按档位截断的价格」比较。涨停不能买，跌停不能卖。
- 买入扣存款，卖出进存款；金额 = trunc(价×股数/100)。同时增减 float 和 quota；平均成本用 costCents 累计。
- 董事长：持股严格最多的人。平手时保留现任；没有现任时取座位靠前者；没人持股时为 null。

### 11.6 月结（1 日）

- 发利息。
- 本期冠军：资产最高者。
- 悲情人物：`分数 = loss − gain + badDays×PI×2500 + luck.bad×10`；最高分超过次高分的 1.4 倍才颁发。
- 清零 monthly；emit `MONTHLY_REPORT{rows, champion, tragic}`（没有奖金 ⚑）。

---

## 12. GameEvent（types/events.ts）

### 12.1 公共结构与 post 自动生成

```ts
export interface EventBase { type: string; post?: PostPatch }
export interface PostPatch {                    // 事件发生后，受影响实体各字段的绝对值
  players?: { seat: SeatIndex; set: Partial<PlayerState> }[];
  villains?: { kind: VillainKind; set: Partial<VillainState> }[];
  lands?: { id: LandId; set: Partial<LandState> }[]; facilities?: { id: FacilityId; set: Partial<FacilityState> }[];
  companies?: { id: CompanyId; set: Partial<CompanyState> }[]; stocks?: { idx: number; set: Partial<StockState> }[];
  objects?: RoadObject[]; gods?: GodSlot[]; beggars?: GameState['beggars'];       // 这三项整表替换
  clock?: Partial<ClockState>; econ?: Partial<EconomyState>; pools?: GameState['pools'];
  lottery?: GameState['lottery']; noticeBoard?: Listing[]; status?: GameState['status']; result?: GameResult | null;
}
// core/postPatch.ts
export function diffPublic(prev: PublicWorld, cur: PublicWorld): PostPatch | undefined; // 实体级比较，字段级 set（数组、对象字段整体替换）
export function applyPostPatch<V extends PublicWorldLike>(view: V, p: PostPatch): V;      // 客户端 viewReducer 直接调用
```

- `ctx.emit(e)`：`e.post = diffPublic(shadow, publicWorld(draft))`，然后把 shadow 中发生变化的实体更新为草稿里对应实体的克隆。
- handler 必须**先改状态、再 emit**。
- applyAction 结束时如果还有没被任何事件公布的变化，自动补一个 `SYNC`，开发和测试模式下视为缺陷。
- 这样可以保证：`fold(applyPostPatch, 投影(旧世界), events) == 投影(新世界)`。

### 12.2 分类、脱敏与事件清单

`EVENT_META: { [T in GameEvent['type']]: { cat: EventCat; privacy: 'public' | 'redactCards'; resetsView?: true } }`

- 所有事件都公开；`post.players[].set.cards` 在私密模式下，对非本人统一改写为 `cardCount`。
- 小游戏 seed 只放在决策里，不进入事件。

| 分类 | 事件（主要字段） |
|---|---|
| turn | GAME_STARTED、TURN_STARTED{actor,turnNo}、PARACHUTE{seat,node,prev}、TURN_BLOCKED{seat,reason,remaining}、RELEASED{actor,from}、RETURNED{seat,node}、TURN_ENDED |
| move | DICE_SET{seat,count}、DICE_ROLLED{seat,dice,steps,forced}、MOVE_SEGMENT{actor,path,remaining}、ROADBLOCK_HIT{actor,node}、REVERSED{actor}、LANDED{actor,node} |
| money | MONEY{from,to,amount,paid,reason,ref}、LOAN{seat,amount,due}、REPAY、LOAN_REMINDER{seat,daysLeft}、LOAN_FORCED、ATM{seat,op,amount}、FINANCE、RESERVE_SHORTFALL{chairman,amount}、INSURANCE_PAYOUT |
| property | LAND_BOUGHT{seat,lot,price}、LOT_LEVEL{lot,from,to,cause}、FACILITY_BUILT{lot,type}、LOT_MUTATED{lot,mode,cause}、TOLL_PAID{payer,owner,ally,amount,allyAmount,lots,mods}、TOLL_EXEMPT{payer,lot,reason}、FEE_PAID{payer,lot,feeKind,wheel,amount}、HOTEL_STAY{seat,days}、COMPANY_FEE{seat,company,industry,amount,wheel}、SUBSCRIBED{seat,stock,shares,unit}、INVEST_BLOCKED{seat,god}、CANNOT_AFFORD、MARK_SET/MARK_EXPIRED{lots,kind}、TENURE_EXPIRED{lots}、RESEARCH_STARTED/DONE/CANCELLED |
| card/item | CARD_GAINED{seat,card,source}、CARD_LOST{seat,card,cause}、CARD_USED{seat,card,target}、CARD_NO_EFFECT、PASSIVE{seat,card,context}、ITEM_GAINED/LOST/USED、VEHICLE{seat,vehicle,dice}、VEHICLE_DESTROYED、OBJECT_PLACED/REMOVED{obj,cause}、DOLL_WALK{path,cleared}、BOMB_ATTACHED/TRANSFERRED/EXPLODED、STRIKE{center,half,kind,lots,actors}、TELEPORTED、TIME_REWOUND{bySeat,toTurnNo}（resetsView）、SHOP_OPENED{shelf}、SHOP_TRADE、CHAIRMAN_GIFT |
| god | GOD_ATTACHED{seat,kind,displaced}、GOD_POWER{seat,kind,slot:{digits,value},transfers}、GOD_LEFT{seat,kind,reason}、GOD_SPAWNED{kind,node}、GOD_MANIFEST{seat,kind,lot,effect}、DOG_BITE、DOG_KNOCKED、DEATH_GOD_SUMMONED |
| status | CONFINED{actor,where,days,total,cause}、BLESSING{seat,category,result}、STATUS_SET{actor,status,value}、ALLIANCE_FORMED/BROKEN/EXPIRED、BANK_REJECTED |
| event | NEWS{id,params,affected}、FATE{seat,id,amount,blessing}、MAGIC_CONDITION{cond,targets}、MAGIC_CAST{caster,effect}、LOTTERY_TICKET{seat,number}、LOTTERY_DRAW{number,winner,prize}、MINIGAME_STARTED{seat,minigameId}、MINIGAME_RESULT{seat,score,points,skipped}、BAIL{by,seat}、VILLAIN_HIRED{by,kind}、VILLAIN_ACTION{kind,victim,what,amount}、VILLAIN_HOME、BEGGAR_ALMS{payer,beggar,amount,newNode} |
| stock | STOCK_TRADED{seat,stock,shares,priceCents,amount}、CHAIRMAN_CHANGED{stock,from,to}、STOCK_FLAG{stock,up,down,byCard}、SUSPENDED/RESUMED、MARKET_TICK、MARKET_CLOSED{reason}、LISTING_ADDED/REMOVED/SOLD |
| auction | AUCTION_STARTED{lot,seller,start,bidders}、AUCTION_BID{seat,price}、AUCTION_PASS、AUCTION_QUIT、AUCTION_ENDED{winner,price} |
| day | DAY_ADVANCED{date,weekday,elapsed}、PRICE_INDEX{from,to}、HOLIDAY{key,cards}、DIVIDENDS{rows}、MONTHLY_REPORT{rows,champion,tragic}、OBJECTS_RESPAWNED、DAY_END |
| end | BANKRUPT{seat,cause,creditor}、LIQUIDATION{seat,stocks,lots,auctionLots}、BECAME_BEGGAR、SURRENDERED、GAME_OVER{result}、CONTROLLER_CHANGED、SYNC |

客户端 handler 注册表、`estimateAnimMs` 和音效表都用 `satisfies` 对 `GameEvent['type']` 做穷举。

---

## 13. EngineApi 契约与导出（对齐 net §12）

```ts
export interface EngineApi {
  readonly ENGINE_VERSION: string; readonly STATE_SCHEMA_VERSION: number;
  createGame(config: GameConfig, players: PlayerSetup[], seed: string): GameState;
  applyAction(state: GameState, action: GameAction): { state: GameState; events: GameEvent[] }; // 非法时抛 EngineRuleError{rule}
  getPendingDecisions(state: GameState): PendingDecision[];   // 游戏结束时为 []
  getResult(state: GameState): GameResult | null;
  validateState(state: unknown): state is GameState;
  migrateState(state: unknown, fromVersion: number): GameState;
}
// 其他导出：PlayerIntentSchema（zod）、ALLOWED_INTENTS、DECISION_TIMING_CLASS、EVENT_META、applyPostPatch、publicWorld、
// selectors（calcToll、netWorth、buyPrice、upgradeCost、streetLots、lotsInWindow、marketOpen、loanLimit）、
// internal.applyInPlace（模拟脚本用，省去克隆）、engine-testing 子路径（builders、scenario、randomIntent、debug）
```

- 全部同步执行。单个 action 目标 <5ms（其中 structuredClone 约 1ms）。
- 引擎 RNG 与 AI 的 Prng 相互独立。
- `ENGINE_VERSION` 使用 semver：规则或数据变化时升次版本号，state 结构变化时升 `STATE_SCHEMA_VERSION` 并补一个迁移函数。

---

## 14. 数据表与地图 JSON

- **出处标注**（data/source.ts）：

```ts
export type Src = { exe: '2.06' | '3.11'; va: string } | { manual: number } | { url: string } | { verify: string };
export interface Sourced { src: Src[]; confidence: 'high' | 'medium' | 'low' }
```

  每条数据都实现 `Sourced`，同时在 JSDoc 里写 `@source`。测试断言每条至少有 1 个非 verify 的来源。

- **各数据文件**：
  - cards.ts：30 条，{id, key, price, deckCount, f7, passive, target}
  - items.ts：13 条，{price, poolInit, shopSellable, research}
  - characters.ts：12 名，按原版编号 0..11，{gender, personality 0 乖宝宝 / 1 普通人 / 2 大老奸, loanRatio, cashRatio, stockRatio, color}，文案 key 走 i18n
  - gods.ts、facilities.ts：等级上限；旅馆 12 格转盘；购物中心 1..6；加油站系数；研究项目
  - companies.ts：行业码与收费种类
  - news.ts、fate.ts、magic.ts
  - economy.ts：全部常数，例如 LOAN_DAYS 90、BAIL 30、HIRE 300、TICKET 1000、CHAIN_TOLL 2000、FREE_THRESHOLD 2000、BOMB_FUSE 38、CHEST 500、DOLL_STEPS 9、MISSILE_HALF 100、NUKE_HALF 220、WINDOW_HALF 220、RESPAWN_DIST 300、NPC_STEPS [2,10]、HAND_MAX 15、ITEM_MAX 9、SELL_RATE 9/10 ……
  - setup.ts：开局选项表
  - stocks/taiwan.ts：12 支，{name, init, float, vol, company?}
  - calendar/holidays.ts（⚑）、lunar.ts（1998–2100 农历表）

- **地图 JSON 契约**（data/maps/types.ts，由 zod schema 校验）：

```ts
export interface MapData {
  id: 'taiwan'; globalMapId: 0;
  source: { file: 'map.mkf'; exeVersion: '2.06' | '3.11'; resource: number; sha256: string; extractor: string };
  nodes: MapNode[];          // 下标 = id-1
  lands: { id: LandId; name: string; street: string; landPrice: number; housePrice: number; rent: [number, number, number, number, number, number]; nodes: NodeId[] }[];
  facilities: { id: FacilityId; name: string; landPrice: number; rates: [number, number, number, number, number, number]; nodes: NodeId[] }[];
  companies: { id: CompanyId; name: string; industry: number; landPrice: number; companyValue: number; stock: number; nodes: NodeId[] }[];
  landscapes: { id: number; name: string; x: number; y: number }[];
  jailGate: NodeId; hospitalGate: NodeId; jailSquares: NodeId[]; hospitalSquares: NodeId[];
}
export interface MapNode {
  id: NodeId; x: number; y: number; name: string;           // 原版世界坐标；Big5 转 UTF-8
  adj: [NodeId, NodeId, NodeId, NodeId]; blocked: [boolean, boolean, boolean, boolean]; // 静态封堵 ⚑字段位置待定
  type: 'special' | 'land' | 'facility' | 'company' | 'landscape'; ref: number | null; special: number | null; // 0..16
  noPlace: boolean; water: boolean; walkable: boolean;
}
```

- `validateMap()` 检查：邻接对称、编号范围、每处设施 2 个节点、同名地块归并为路段、闸门节点存在。
- 台湾图还要断言数量：103 个节点、50 块住宅、4 处设施、3 家企业、21 个景观。
- 地块样本：
  - 台北市：地价 2500，rent [500,1200,3000,7500,16000,30000]
  - 新竹市：地价 1000，rent [200,500,1200,2800,6000,10000]
  - 台南市：4 块，地价 1500，房价 300（第一块是 500），rent [300,750,2000,4800,10000,18000]
- 提取脚本 `tools/extract/`：读取 `/.original/{v2.06,v3.11}/`（加入 gitignore），输出 `data/maps/generated/taiwan.json`，另外输出 `tools/extract/out/exe-tables.{206,311}.json`（卡、道具、角色、股票、选项表），供对比测试使用。不输出任何图片或音频。

---

## 15. validateState / migrateState

`validateState(x)` 先做 zod 结构校验，再逐项检查不变量（任一失败即返回 false，并在开发模式下给出原因）：

1. JSON 可以往返；金额、天数都是安全整数（`momentum` 除外）。
2. 牌堆守恒：对每种卡，`pools.cards[c] + Σ手牌中该卡数量 == deckCount[c]`，合计 100。
3. 道具池守恒（1..8）：`池 + Σ背包 + 装备中的机车汽车 + 地面路障、地雷、炸弹 + 身上的炸弹 == 10`。
4. 股本守恒：`Σ持股 + float + 该公司 reserved == 10000`。
5. 资金台账：`Σ(cash + deposit) + pool + Σ本月盈余 == 初始总额 + minted − burned`。
6. 地产合法：地主是在场座位或 null；等级不超过类型上限；连锁店等级 ≤1；0 级设施的 type 为 park。
7. 每个节点至多 1 个物件；每对神明搭档至多 1 个在场；被附身的神明与玩家的 `god` 字段一致。
8. `jail > 0` 或 `hospital > 0` 的玩家位于对应闸门节点。
9. `status=='playing'` 时 pending 非空，且每个 pending 指向的 frameId 存在；ROOT 在栈底。

`migrateState`：`MIGRATIONS[v](state)` 依次串联到最新版本；每一步有自己的 fixture 测试。

---

## 16. 测试方案（vitest 5 + fast-check 4）

1. **规则单测**（`engine/rules/*.test.ts`，按系统分文件）
   - toll：台南 4 块同属一个地主，等级 [1,3,0,0] → (750+4800+300+300)×PI；连锁店 2000×n；涨价只翻倍地主那一份；同盟分账（fround）；四种神明修正；九种免收按顺序判定。
   - wealth、PI：手工样本；int32 回绕与饱和两种模式。
   - calendar：1998-01-01 为星期四；2100 年按闰年处理；贷款到期日顺延；2/31 永不到期。
   - counters：坐牢 N 天 = N+1 个不掷骰的回合；停留卡对自己和对别人都是 1 次；乌龟卡都是 3 次；冬眠 5 次。
   - stock：档位、涨跌停判定、上下限、额度公式、负分红、董事长平手。
   - 其他：facility（旅馆转盘 12 格的分布）、company 各公式、lottery、blessing 档位、inventory（满手弃最便宜的、同价取靠前卡槽）、payment（级联、银行口径、部分支付后破产）。
2. **效果单测**：30 张卡、13 种道具、13 种神明、36 条新闻（含可行性判定）、37 条命运（含加持）、12 个魔法屋效果，每项至少 1 个用例。
3. **场景测试**（`testing/scenario.ts` DSL，使用小地图）：

```ts
scenario('陷害被嫁祸回出卡者 → 4 天', s => s.players('human','human','ai').give(0,{cards:[17]}).give(1,{cards:[19]})
  .turn(0).useCard(17,{seat:1}).expectAsk(1,'SCAPEGOAT').act(1,{type:'SCAPEGOAT',target:0})
  .expect(st => st.players[0].st.jail === 4).expectEvents(['CARD_USED','PASSIVE','CONFINED']));
```

   - 强制结果统一用 `SYS_DEBUG{op:'forceNext', purpose:'dice'|'fork'|'wheel'|'slot'|…, values}`。
   - 覆盖：破产清算 + 3 块拍卖；并发竞价（按到达顺序、PASS 被新出价重置）；路过银行 ATM 中断后继续移动；炸弹转移与爆炸；时光机回滚（rng 继续、决策 id 不回退）；读档后在任意 pending 处继续。
4. **属性测试**：随机种子 × `randomIntent`（从 options 里均匀抽合法 intent），每个 action 之后跑 `validateState`；同种子、同 action 序列两次运行的状态哈希必须一致；存档往返 `JSON(parse(stringify))` 后继续执行，结果与不存档一致。
5. **AI 自对弈 fuzz**（scripts/simulate，夜间运行）：4 个 AI（shared/ai 的 AiPolicy，缺失时用 randomIntent 顶替）× 1000 局，用 `internal.applyInPlace` 加速。断言：不抛异常；在限定天数内结束；不变量成立；每批事件的 post 折叠结果等于投影。
6. **post 一致性**（和客户端 viewReducer 同一个函数）：20 个种子 × 300 回合，逐个 action 断言 `fold(applyPostPatch, publicWorld(prev), events) ≡ publicWorld(next)`。另外，除时光机外不允许出现 SYNC。
7. **golden 重放**：固定种子和脚本，快照事件类型序列和状态哈希。规则变化时必须更新快照并升级 ENGINE_VERSION。
8. **数据与地图**
   - 每条数据都有 src；卡片合计 100 张；新闻 36 条、命运 37 条、角色 12 名。
   - `taiwan.json` 存在时跑 validateMap 和样本断言（`describe.skipIf(!hasTaiwan)`），CI 只用小地图。
   - v2.06 与 v3.11 的表做差分，生成报告。

---

## 17. 实现顺序（按依赖分层）

1. **L0 基础**：types/ids、int32、rng、clone、calendar、data 骨架（setup、economy、cards、items、characters、gods）、MapData schema 与 validateMap、小地图。
2. **L1 规则计算器**：wealth、toll、facilityFee、companyFee、purchase、landMutation、payment 与台账、counters、inventory、movement、geometry、blessing、hostility（全部配单测）。
3. **L2 解释器与最小可玩**：Ctx、flow、postPatch、ASK；ROOT、TURN、MOVE、LAND；地产格（买、盖、收过路费）、1 公园、10–13 格；BANKRUPT（先不做拍卖）；DAY 的 date、victory、pi、lots 阶段；createGame、applyAction、validateState；testing 工具包（builders、SYS_DEBUG、randomIntent）和 fuzz。**做完这一层就交给 net 替换 stubEngine。**
4. **L3 经济**：银行（ATM、柜台、贷款、融资、利息）、股市（tick、交易、额度、董事长、分红）、乐透、百货与商店、企业格、设施（旅馆、购物中心、加油站、研究所）、保险、月结。
5. **L4 对抗**：30 张卡（含被动卡链路）、13 种道具与路面物件、神明（发威、显灵、换搭档）、关押与保释、乞丐。
6. **L5 事件**：新闻、命运、魔法屋；四大恶人；AUCTION（并发）与清算拍卖；投降与死神；时光机；公布栏。
7. **L6 收尾**：节日与农历；migrateState；接入台湾地图（依赖提取脚本）与 golden；MANUAL 预设；性能（applyInPlace）；与 v2.06 数据表对比。

---

## 18. 需要从用户正版文件核实的项

**A. 静态提取（脚本自动完成，放进 `/.original/`）**

1. v2.06 的 `map.mkf` 资源 1（台湾图）：
   - 节点：坐标、名称、邻接、type、flags 低字节、bit31 禁放。
   - **两个岔路的静态封堵位在哪个字段**。
   - 水路段标记；监狱、医院闸门（type 8002/8001）以及监狱格、医院格。
2. 住宅 0x34、设施 0x38、企业 0x34 记录的完整字段偏移：地价、房价、rent[6]、设施 rate[6]（+0x22 地价、+0x24 rate0）、企业行业码、**公司价值**、股票索引（+0x19）、费率。
3. v2.06 与 v3.11 exe 数据表对比：
   - 卡表（嫁祸、红卡、涨价、同盟四张卡的价格）、道具表、角色表（@0x47e80c：个性、借贷、现金、炒股比例、颜色）。
   - 股票表 game_stocks（台湾 12 支）。
   - 开局选项表 @0x46cb94（资金档位与**默认索引**）、游戏时间、地契、胜利倍数表。
4. 新闻 36 条、命运 37 条的文案与系数（Big5 字符串与立即数），以及魔法屋 12 条件、12 效果表。
5. 台湾图节日表（24 条：日期、休市、送卡、BGM）；农历节日在 exe 里怎么表示。
6. 转盘数值：旅馆 12 格排列、保险天数、**航空转盘**、购物中心倍数。
7. 常数复核：炸弹 38、娃娃 9、飞弹半宽 100、核弹半宽 220、视窗 440、神明重生距离 300、恶人步数 rand%9+2、小游戏 50+rand%20、乐透 36 个号码和 1000 元、保释 30 与 300、贷款 90 天、乞丐 1000、个股停牌 15。

**B. 实机验证（用户在 v2.06 里操作，或提供 save*.dat；可以写一个导入脚本，把存档变成 GameState 用来对比资产和物价）**

1. 坐牢 N 天实际经过几个回合；停留卡、乌龟卡的次数；陷害被嫁祸回来是 4 天。
2. 首回合跳伞之后，是否立即掷骰、是否结算落点。
3. 梦游者落点：是否付过路费，是否触发地雷和神明。
4. 定时炸弹：先倒数还是先转移；爆炸是否伤及同格或 3×3 范围。
5. 满手时拿到第 16 张卡，是否弹窗让玩家选弃哪张。
6. 星期日 ATM 和柜台能否使用。
7. 魔法屋：名单里有自己时，真人能否选全部效果；坐牢、住院能否被免罪卡、嫁祸卡挡掉；「拍卖当格」的钱归谁。
8. 命运坐牢能否用免罪卡；罚款能否用免费卡。
9. 投降流程：拍卖范围；投降者是否变成乞丐。
10. 四大恶人：雇用后何时移动；间谍偷租金是否存在；恶人被关押释放后的去向。
11. 红卡、黑卡实际有效天数；个股停牌是 10 天还是 15 天。
12. 大财神附身时住旅馆是否不用住宿；死神能否被送神符送走、会不会被其他神挤掉。
13. 保险重复投保是覆盖还是累加；航空消失天数。
14. 月结冠军、悲情人物有没有奖金；点券超过 65535 时的行为。
15. 默认总资金（开局设置界面的默认项）；受困玩家能否参加拍卖、能否被选为嫁祸目标。
16. 工程车拆房与神明显灵的先后；换地卡是否交换地契期限。

---

## 19. 对其他设计的修正与对齐

- **design_client**
  - 删除 `chooseDirection` 和 `ForkChooser`（岔路随机）。
  - 决策注册表的键改为本设计的 `DecisionKind`（SCREAMING_SNAKE），handler 注册表的键改为 `GameEvent['type']`。
  - `viewReducer` 直接调用 shared 的 `applyPostPatch`。
  - 收到 `TIME_REWOUND`（resetsView）时执行 `reset(batch.view)`。
  - 地图没有网格或矩形 footprint，只有原版世界坐标加节点图；地产就是路上的格子（设施占 2 个相邻节点），建筑放在哪里由渲染层根据道路走向推导。
  - 转盘和老虎机不是决策，只是演出。
- **design_net**
  - timing 表去掉 `CHOOSE_PATH`，改为引用 `DECISION_TIMING_CLASS`。
  - 小游戏：`controller=='ai'` 的座位由引擎直接结算，不产生决策；只有真人座位会收到 MINIGAME 决策。
  - 投影时，除了去掉 `secret`，还要去掉 `flow`、`counters`、`pending`（pending 另走 PendingView）；私密模式下还要按 `EVENT_META.privacy` 改写 `post`。
  - 被踢成纯电脑的座位要发 `SYS_SET_CONTROLLER`；托管（autopilot）**不**改变 controller。
  - `RoomSettings.game` 就是本设计的 `GameConfig`（包括 `startDate` 与 `rules`）；房间 UI 提供 PROGRAM/MANUAL 预设，以及 timeMachine、targetRange 开关。


## key_decisions
- 引擎内部采用可序列化的显式帧栈解释器（state.flow: Frame[] + state.pending[]）；applyAction 先 structuredClone 得到草稿，再在草稿上执行 — 大富翁4 会在结算中途插入多种交互：路过银行 ATM、被动卡询问、破产清算、多人拍卖、日推进里的负分红破产。用帧栈加阶段游标，任意中断点都能原样存档、读档、重放，而且不需要闭包。复制草稿后可以直接写命令式规则代码，入参不被修改，实现成本最低
- 事件的后置绝对值（post）由 emit 时对公开世界做实体级 diff 自动生成；客户端 viewReducer 直接复用 shared 的 applyPostPatch — 客户端要求事件携带后置值。靠手写很容易漏或写错，自动 diff 从构造上保证「逐个折叠事件 = 批尾快照」。一致性测试只需要防止回归，不必逐个事件核对字段
- 岔路一律由服务器 RNG 执行 rand()%候选数，只有 1 个候选也消耗一次；DecisionKind 里没有 CHOOSE_PATH — 这是用户已确认的决定，也符合原版程序行为。玩家只能通过转向卡、停留卡、乌龟卡、传送机、路障间接控制路线
- 规则默认按 PROGRAM 预设（原版程序行为），说明书冲突项集中在 RuleConfig 里做成 MANUAL 开关（红黑卡天数、福神买地、小穷神倍率、工程车、炸弹范围、周日银行、满手弃牌、新闻是否受加持、死神能否送走、罚款能否用免费卡、停牌天数、建设公司董事长） — 满足「规则基准 = 程序实际行为，明显冲突可选说明书规则」。所有开关只在一个地方判定，测试可以对两个预设分别跑
- 停下才触发为主：路过只触发银行 ATM、路障拦停、身上炸弹的倒数和转移；地雷、恶犬、神明、礼物、宝箱、乞丐和全部特殊格都要停下才触发 — critique 裁决：多数主题和 EXE 分支都支持停下触发，rules_map §3 需要更正
- 阻碍类计数器按原版两段式编码实现（低 7 位为天数，0x80 为待释放，释放后那一回合走回棋盘、不掷骰）；停留、乌龟、陷害的自用值与他用值直接沿用 exe 写入值 — 不用额外解释「N 天到底等于几个回合」，把原版编码搬过来就能得到原版的回合数（坐牢 N 天 = N+1 回合；停留和乌龟的自用、他用次数相同）
- RNG 用可序列化的 xoshiro128**，提供 0..32767 的 rand15() 以保留原版 rand()%n 公式的取值范围；每次取数都带 purpose 标签，测试通过 SYS_DEBUG 调试队列按语义强制结果 — 服务器权威模式不需要和原版随机序列逐位一致（mytbk 链接的 rand 本来就不同），xoshiro 质量更好；按语义强制结果能让场景测试和 E2E 稳定复现
- 金额按 int32 语义计算（Math.imul、|0、trunc），默认回绕，可配置为饱和；股价以分为单位存整数；浮点只用于股价动量和同盟分账（fround），并且只做四则运算 — 忠实还原 32 位整数行为（包括 2^31 上限），同时保证 V8、JSC、SpiderMonkey 结果逐位一致；百分比统一改写成整数形式，可以证明结果与原版 double 截断相同
- 被动卡按触发点表实现：陷害或梦游的顺序是 免罪（自动）→ 嫁祸（问）→ 施加 → 复仇（自动）；过路费和设施费是 免费（问，≥2000×PI 或付不起）→ 嫁祸（问）；查税是 免费 → 嫁祸（税额>2000，转移后重算） — 依据 oama passive.ts 的调用点和 cards §5 的汇编顺序。只有手里有卡、确实可以选择时才发决策，避免空问答拖慢节奏
- 拍卖采用多人并发、按服务器到达顺序处理的公开竞价：成功加价后清除其他人的待决策并重新发起，PASS 在有人加价后恢复为可出价，QUIT 永久退出 — 满足 pending 数组的并发要求，结果只取决于 journal 里的 action 顺序（确定性），也对应原版「PASS 只保持到下一次有人成功加价」
- 时光机在联机中的定义：锚点是真人座位提交 ROLL 前的世界（不含 RNG），默认全局单锚点（原版），可选 perSeat 或 disabled；恢复时 RNG 和决策计数器都不回退，并发出 TIME_REWOUND 让客户端 reset — 按 nurockplayer 与 oama 的逆向：恢复整个世界，但随机数作为延续点继续；决策 id 不回退可以避免服务器的 STALE 判定出现冲突
- 恶人每轮在座位轮转之后、日推进之前各走一次，步数为 rand%9+2；四人各自的行为按 oama npc-actions 实现，收益一律交给雇主 — 填补 critique 标为 critical 的四大恶人缺口；实现细节有逆向依据，缺依据的点标 ⚑ 列入实机验证
- 资金守恒改用台账（ledger.minted / ledger.burned）加 transfer、mint、burn 三种原语，任何资金变动都必须经过它们 — 让「Σ现金+存款 + 公库 + 公司本月盈余 == 初始 + 铸造 − 销毁」成为可以逐步断言的不变量，fuzz 能立刻发现规则里凭空产生或丢失的钱
- 地图 JSON 保留原版世界坐标加节点图（4 个邻接、静态封堵、禁放、17 类落点），由构建期脚本从用户正版 map.mkf 提取；CI 使用手工小地图 — 引擎的范围判定（飞弹半宽 100、视窗 220、神明重生距离 300）依赖原版坐标；CI 和开源仓库不依赖版权文件；台湾图数量和地块样本作为提取正确性的断言

## contracts
- 引擎导出 engine: EngineApi（createGame / applyAction / getPendingDecisions / getResult / validateState / migrateState / ENGINE_VERSION / STATE_SCHEMA_VERSION），全部同步执行，入参 state 不会被修改，非法 action 抛 EngineRuleError{rule}。
- getPendingDecisions 返回 PendingDecision[]；拍卖时同时有多个；游戏结束时为 []。每项都有确定性 id（d${n}）、frameId、seat、kind、options、publicInfo、defaultIntent、timing，小游戏还带 minigame{minigameId, seed, params}。
- DecisionKind 共 23 种（TURN_MENU、BANK_ATM、BANK_COUNTER、BUY_LAND、UPGRADE_LAND、BUY_FACILITY、BUILD_FACILITY、UPGRADE_FACILITY、FACILITY_TYPE、RESEARCH、SHOP、LOTTERY、BAIL、MINIGAME、MAGIC_CAST、CONSTRUCTION_PICK、SUBSCRIBE_SHARES、USE_FREE_CARD、SCAPEGOAT、AUCTION_BID、BIRTHDAY_PICK、DISCARD_CARD、DEATH_GOD_TARGET），没有 CHOOSE_PATH，也没有转盘或老虎机决策。
- GameAction = (PlayerIntent & {seat, decisionId}) | SystemAction；PlayerIntentSchema（zod）只包含玩家 intent；MINIGAME_RESULT、MINIGAME_SKIP、SYS_SET_CONTROLLER、SYS_SET_AI_PROFILE、SYS_DEBUG 只能由服务器产生，SYS_DEBUG 还要求 config.debug=true。
- ALLOWED_INTENTS[kind] 和 DECISION_TIMING_CLASS[kind] 由引擎导出，服务端用它们做第 7 步校验和查超时表。
- GameEvent 是以 type（SCREAMING_SNAKE）区分的联合类型；凡改变公开状态的事件都带 post: PostPatch（受影响实体各字段的绝对值），由引擎自动生成；客户端 viewReducer 必须直接使用 shared 的 applyPostPatch。
- EVENT_META[type] = {cat, privacy, resetsView?}：私密手牌模式下，net 的 projectEvent 必须把 post.players[].set.cards 改写为 cardCount；TIME_REWOUND 带 resetsView，客户端直接用批尾 view 做 reset。
- state.secret（rng、新闻和命运牌序、时光机锚点、调试队列）、state.flow、state.counters、state.pending 都不能进入 GameView；publicWorld(state) 给出可以下发的世界。
- 引擎每次日推进结束都 emit DAY_END（服务器用来触发自动存档）；游戏结束时 emit GAME_OVER 并设置 result。
- 座位 controller（human/ai）在开局时由 PlayerSetup 决定，只有 SYS_SET_CONTROLLER 能修改；托管和超时代打不改变 controller。controller=ai 的座位遇到小游戏由引擎直接结算，不发决策。
- GameConfig（包括 startDate、initialFund、vehicle、tenure、timeLimitDays、winMultiple、rules: RuleConfig、debug）就是 net 的 RoomSettings.game；startDate 由服务器传入当天日期，引擎夹到 1998-01-01..2010-01-01。
- selectors（calcToll、netWorth、buyPrice、upgradeCost、streetLots、lotsInWindow、marketOpen、loanLimit）作为纯函数导出，供客户端预览和 AI 使用；options 里已经包含渲染所需的全部数字与合法候选，客户端不需要重新实现规则。
- AI 领域只通过 AiPolicy.decide(view, decision) 返回 PlayerIntent，与真人走同一条校验管线；引擎不限制 AI 每回合的用卡、用道具次数（那是 AI 策略的责任），AI 用独立的 Prng，不消耗引擎 RNG。
- 地图 JSON（data/maps/generated/<id>.json）遵循 MapData schema：原版世界坐标、4 个邻接加静态封堵、17 类落点、禁放、闸门节点，以及地块、设施、企业表；提取脚本只输出 JSON，不输出任何图片或音频。
- 每条数据表记录都带 src（exe 版本 + VA、说明书页码或 URL，另可加 verify）和 confidence；测试断言没有缺失。
- 存档中的 GameState 可以在任意 pending 点读回并继续执行；stateVersion 较旧时用 migrateState 迁移，dataHash 不一致时只告警。
- internal.applyInPlace（原地执行、不克隆）只给 scripts/simulate 和 fuzz 使用，服务端正式路径必须用 applyAction。

## risks
- 原版台湾图的部分字段偏移还未解明（住宅地块、设施、企业记录的全部字段，静态封堵位，公司价值）。如果提取脚本没能拿到这些字段，地产收费和股价锚点会不准。缓解：先用小地图把引擎做完，提取阶段用台北、台南、新竹样本和数量断言做验收
- 所有逆向数值都来自 v3.11，v2.06 可能有差异（例如 Fandom 与 exe 有 4 张卡价格不一致）。缓解：提取脚本同时导出两版的 exe 表并生成差分报告，数据表按 v2.06 改正并标注出处
- 有多处规则只有单一逆向来源，或者没有任何来源（四大恶人细节、航空转盘、保险是否累加、魔法屋的被动卡检查、间谍偷租金），可能与原版不一致。缓解：全部标 ⚑，列入实机验证清单；做成数据表参数，改起来成本低
- 每次 applyAction 都要 structuredClone 一个 100–200KB 的 state（全局时光机锚点会让体积翻倍）。夜间 1000 局 fuzz 会比较慢。缓解：模拟脚本用 applyInPlace；锚点只保存必要部分；以后可以换成 Immer 式的结构共享
- 自动 diff 生成 post 依赖「先改状态、再 emit」的纪律。如果 handler 先 emit 后修改，改动会落进下一个事件或 SYNC，导致动画与 HUD 数字错位。缓解：开发模式下出现 SYNC 即告警，一致性测试禁止非时光机的 SYNC
- 帧栈解释器的中断和展开逻辑复杂（破产发生在移动中、日推进中、拍卖中），容易留下孤儿帧或死循环。缓解：validateState 检查 pending 与 frame 的对应关系；run 循环设守卫上限；fuzz 在任意 pending 处存档再读档继续执行
- int32 回绕是原版行为，但后期可能出现负资产，导致物价指数和胜负判定异常，玩家会觉得是 bug。缓解：提供 saturate 开关，房间 UI 标注说明
- 并发拍卖在网络抖动下会频繁出现 STALE_DECISION（有人加价后其他人的请求作废），体验可能不好。缓解：客户端收到 STALE 后自动刷新；服务端对拍卖决策使用较短的超时，并允许一键跟价
- 全局时光机在多真人联机下会回滚其他真人的操作，可能引起争议。缓解：房间设置里提供 perSeat 或 disabled，多真人房间默认建议关闭（需要用户拍板）
- 把原版数据（地名、价格、事件文案系数）提交到仓库有版权灰区，尽管都是事实性数据、不含素材。缓解：提取的 JSON 与原版素材分离，文案走 i18n 并可重写；是否提交 generated JSON 需要用户确认
- 节日表和农历换算缺少数据，会影响休市日、贷款到期日顺延和圣诞送卡；除了星期日，其余休市节日在核实之前只能先按手工录入的台湾节日处理

## open_questions
- 提取出的 data/maps/generated/taiwan.json（原版地名、价格、租金表等事实性数据）要提交进 git，还是每次构建前从 .original/ 本地生成（这样 Docker 构建需要额外步骤）？
- 多真人联机时时光机默认用哪种模式：全局单锚点（原版，会回滚其他真人的操作）、每座位各自锚点，还是默认关闭？
- 卡片和道具的目标范围：默认用以使用者为中心、半宽 220 世界单位的方窗（还原原版视窗，AI 也按这个规则），还是联机时放宽为全图？
- 开局默认总资金取 300000（存档实证）还是 200000（选项表索引 1）？需要用户在原版开局界面看一眼默认项。
- int32 溢出默认回绕（原版行为）还是饱和到 2147483647（体验更好）？
- 是否允许用户提供原版 save*.dat，由我们写导入工具把存档转成 GameState，对比资产、物价指数和过路费的计算结果？这是核实第 18 节 B 类问题最高效的办法。
- 真人每回合能用几张卡、几个道具，原版没有资料，本设计默认不限制。是否需要给联机加上限（例如 1 卡 + 1 道具，与电脑对齐）？
- 投降（召唤死神）需要至少 2 名真人。联机时如果一名真人断线转托管，是否仍算真人？本设计按 controller 判断，托管不改变 controller。
- v1 是否只做台湾图？是否需要在 data 层先为中国、日本、美国图预留行业类型（航空、汽车、石油、电子、建设等收费规则已经实现，只缺各图数据）？
- 魔法屋「拍卖当格土地」和投降清算的拍卖款归属（进公库还是归原地主）在资料里不明确，本设计默认进公库，是否接受？