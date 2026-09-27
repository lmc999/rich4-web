# 大富翁4 网页复刻：总体架构与实施方案（docs/architecture.md 初稿）

> 编写日期 2026-09-26。项目目录 `<repo>`（目前为空）。本机环境：macOS、Node v24.9.0 / npm 11.6、radare2 6.2（可选）。
> **定位**：这是 5 份领域设计（engine、data-pipeline、minigames-ai、net、client）的上位文档，领域设计原文归档到 `docs/design/`。本文件与领域设计有冲突时一律以本文件为准，各领域设计要按 §14 的修订清单同步更新。
> 规则细节（帧栈、30 张卡、新闻和命运表、提取算法、AI 判据、渲染细节等）不在本文重复，按「见 design/xxx.md §n」引用。

---

## 0. 已锁定决策与裁决原则

**用户决策（不可推翻）**
1. 全部自研，不复用 GPL 代码。规则数值参考说明书和公开逆向资料重新录入，并标注出处（`@source`）。
2. 规则基准是原版程序的实际行为（逆向资料以 v3.11 为主，用 v2.06 核实）。与说明书明显冲突的几项做成房间可选的 MANUAL 预设。
3. 岔路始终随机，由服务器 RNG 决定，不存在任何选方向的决策。
4. 首张地图是原版台湾图（global_map_id 0：103 节点 / 50 住宅地 / 4 设施 / 3 企业）。数据由构建期脚本从用户正版文件中提取，只输出 JSON，不含任何图片或音频。
5. 美术自制，程序化 SVG/Pixi 绘制。沿用原作 12 个角色名，文案走 i18n，可以一键改名。
6. 电脑优先，手机横屏可玩，竖屏只提示旋转。交付 Docker 镜像 + compose + Caddy。
7. 功能全要：电脑补位和单机、断线重连加 AI 托管、存档读档、聊天、表情、观战。

**裁决原则（解决冲突时依次考虑）**
① 用户决策；② 原版程序行为（证据等级 A 高于 B，B 高于说明书）；③ 联机公平与可测试性；④ 实现成本。
字段命名冲突按领域归属裁决：规则语义归 engine；地图和数据表格式归 data；小游戏和 AI 归 minigames-ai；传输、编排、持久化归 net；渲染和交互归 client。

---

## 1. 系统总览

```
用户 Windows PC（Steam appid 2059810）──手工只读拷贝──► original/{Game,MultiverseJourney}/   (gitignore)
                                                            │
                                    tools/extract（构建期，tsx，纯 TS）
                    ┌──────────────── 核对 ───────────────┤ 生成
                    ▼                                      ▼
packages/shared/src/data/tables/*.ts          rich4-data/{manifest.json, maps/taiwan.map.json}   (gitignore；部署时挂只读卷)
(手录全局表 + @source/@verify)                docs/research/{version-diff,provenance-summary}.md (入库)
                    │                                      │
packages/shared ────┴── engine = createEngine(DataRegistry) ◄── apps/server/DataRegistry（fixture 始终可用 + RICH4_DATA_DIR）
  util / geom / data / engine / view / net / minigames / ai / save          │
                                                                          apps/server：Fastify 5 + Socket.IO 4.8
                                                                          Room → GameRunner（无 IO）→ AiDriver / Deadlines / MinigameReferee
                                                                          persistence：node:sqlite（journal + 快照 + 存档）
                                                                                   │ typed events + ack（WS，可降级为长轮询）
apps/client：socketTransport → router → zustand stores → EventPlayer(handlers + applyPostPatch)
             → Pixi v8 等角棋盘 / React 19 HUD 与对话框 / MiniGameHost / AudioEngine
```

**权威链**：客户端只发 intent。服务器依次执行 `applyAction`，拿到带 `post` 后置值的 `events`，按观察者投影成 `game:batch`。客户端逐个事件播放，每播完一个就提交 `applyPostPatch`，批尾用 `batch.view` 对账。

---

## 2. Monorepo 目录树（到关键文件）

```
rich4/
├─ package.json                  # workspaces ["packages/*","apps/*","tools/*"]；engines.node ">=24.9"；scripts 见 §9.1
├─ package-lock.json  .nvmrc(24)  tsconfig.base.json(strict, bundler, verbatimModuleSyntax)  biome.json  vitest.config.ts
├─ .gitignore                    # original/ .cache/ rich4-data/ **/*.mkf **/*.MKF **/RICH4.EXE **/SAVE*.DAT dist coverage test-results
├─ .dockerignore  Dockerfile  .github/workflows/{ci.yml,nightly.yml}
├─ docs/
│  ├─ architecture.md            # 本文件
│  ├─ DEVIATIONS.md              # 有意偏差清单（§7.3），每条对应一个开关或说明
│  ├─ VERIFY.md                  # 待核实清单（§11），每条带状态、结论、证据
│  ├─ design/{engine,data-pipeline,minigames-ai,net,client}.md
│  └─ research/{version-diff.md,provenance-summary.md}   # 由 extract 生成后入库（不含整图数据）
├─ deploy/{docker-compose.yml,Caddyfile,nginx.conf.example,.env.example}
├─ scripts/{dev.mjs,gen-fixtures.ts,check-determinism.ts,check-no-original.ts,check-deps.ts,check-bundle.ts}
├─ original/                     # gitignore；用户正版文件，保留 Steam 相对路径（§12）
├─ .cache/extract/               # gitignore；raw JSON、预览 SVG、表抽取结果
├─ rich4-data/                   # gitignore；manifest.json + maps/taiwan.map.json
├─ packages/shared/              # @rich4/shared：纯 TS、零 IO，exports 直接指向源码
│  ├─ package.json               # exports ".", "./util", "./geom", "./data", "./engine", "./engine-testing", "./view", "./net", "./minigames", "./ai", "./save"
│  └─ src/
│     ├─ util/ rng/xoshiro.ts  rng/watcom.ts  hash.ts(fnv1a32/64, mix32, splitmix32)  int32.ts  canonicalJson.ts
│     ├─ geom/viewWindow.ts      # inViewWindow(center, p, half)：引擎算目标候选和 AI 算视野共用这一个函数
│     ├─ data/
│     │  ├─ source.ts            # Src / Sourced 类型，@source/@verify 约定
│     │  ├─ tables/ economy setup cards items characters(含 resolveTraits) gods facilities companies news fate magic emotes index(TABLES, tablesHash)
│     │  ├─ calendar/lunar.ts    # 1998–2100 农历表
│     │  └─ maps/ types.ts schema.ts(zod) validate.ts mapIndex.ts registry.ts
│     │           fixtures/{ascii.ts, testMap.ts, test-map.json, test-map-allkinds.json}
│     ├─ engine/                 # 结构见 design/engine.md §2（data 部分已移出）
│     │  ├─ index.ts api.ts(createEngine) version.ts errors.ts
│     │  ├─ types/{ids,state,config,frames,decision,intent,events}.ts
│     │  ├─ core/{ctx,flow,clone,random,postPatch,ids}.ts
│     │  ├─ rules/{wealth,toll,facilityFee,companyFee,purchase,landMutation,payment,counters,blessing,hostility,inventory,movement,calendar,stock,lottery,victory}.ts
│     │  ├─ flow/{root,turn,move,land,day,villain,ask,toll,fee,pay,confine,bankruptcy,auction,surrender,bank,shop}.ts
│     │  ├─ squares/{index,property,facility,company,park,news,fate,jail,hospital,minigame,lottery,points,cardSquare,bank,shop,magic}.ts
│     │  ├─ effects/{cards,items,gods,news,fate,magic,villains}/index.ts  effects/{objects,timeMachine}.ts
│     │  ├─ decisions/{build,targets,allowed,defaults,timing}.ts
│     │  ├─ selectors/index.ts   validate/{schema,invariants}.ts   migrate/{index,v1}.ts
│     │  └─ testing/{builders,scenario,randomIntent,debug}.ts        # 子路径 engine-testing，只给测试和脚本用
│     ├─ view/ types.ts(GameView) project.ts(projectState/projectEvent) pacing.ts(EVENT_BUDGET_MS/estimateAnimMs)
│     ├─ net/  protocol.ts schemas.ts errors.ts room.ts timing.ts limits.ts
│     ├─ minigames/ index.ts types.ts replay.ts validate.ts hash.ts
│     │        penguin/{constants,geometry,sim,bot}.ts balloon/{constants,sim,bot}.ts xicong/{constants,sim,bot}.ts
│     │        __golden__/{penguin,balloon,xicong}.json  verify/exeFacts.test.ts
│     ├─ ai/   types.ts rng.ts view.ts(AiView) policy.ts(OriginalAiPolicy) basic.ts(BasicAiPolicy)
│     │        preRoll.ts cards.ts items.ts stock.ts decisions/*.ts verify/*.test.ts testing/selfplay.ts
│     └─ save/ format.ts migrate.ts
├─ apps/server/                  # @rich4/server，结构见 design/net.md §2，增量如下
│  ├─ build.mjs(esbuild)  src/{main,app,config}.ts
│  ├─ src/data/DataRegistry.ts   # 加载 fixture 和 RICH4_DATA_DIR/manifest.json；复算 sha256；执行 validateMap
│  ├─ src/http/{static,health,maps,saves,admin}.ts
│  ├─ src/net/{io,sessions,guard,rateLimit}.ts  src/net/handlers/{lobby,room,game,minigame,chat,saves,time,debug}.ts
│  ├─ src/rooms/{RoomManager,Room,RoomBroadcaster,roomCode,ChatLog}.ts
│  ├─ src/game/{GameRunner,AiDriver,Deadlines,MinigameReferee,RingBuffer}.ts   # 禁止 import node:* 和 socket.io
│  ├─ src/persistence/{db,SaveRepository,RoomStore,JsonFileStore,codec}.ts
│  ├─ src/infra/{clock,logger,shutdown}.ts
│  ├─ scripts/{simulate,replay,loadtest,botplay,bench-engine}.ts
│  └─ test/helpers/{startTestServer,botClient,manualScheduler,stubEngine}.ts  test/unit/*  test/integration/*
├─ apps/client/                  # @rich4/client，结构见 design/client.md §2，改动如下
│  ├─ vite.config.ts index.html public/audio/bgm/ assets/{credits.json,sfx/,icons/} scripts/check-credits.ts
│  └─ src/
│     ├─ net/{transport.ts, socketTransport.ts, clock.ts, router.ts}          # 不再有 wsTransport 和 localTransport
│     ├─ store/{connection,room,game,map,ui,settings,chat}Store.ts
│     ├─ game/ GameRenderer.ts layers.ts iso/{projection,depth,picking}.ts camera/{Camera,gestures}.ts
│     │        board/{BoardView,GroundLayer,RoadPainter,LotView,FacilityView,CompanyView,LandmarkView,RoadObjectView,TileMarkers,Decorations}.ts
│     │        actors/ fx/ dice/ anim/{AnimClock,tween,easing}.ts procedural/{building,character,icons}/ minimap/
│     ├─ presentation/{EventPlayer,UiPresenter,soundMap,logFormat}.ts handlers/{index,turn,move,property,money,card,item,god,status,event,stock,auction,day,end}.ts
│     ├─ minigames/host/{MiniGameHost,FixedStepLoop,InputRecorder,SpectatorFeed}.ts  {penguin,balloon,xicong}/{view.ts,input.ts,Hud.tsx}  registry.ts
│     ├─ ui/decisions/{DecisionLayer.tsx, registry.ts, 各对话框见 §5.4}
│     ├─ ui/{hud,panels,popups,lobby,social,system,screens,components,theme}/
│     ├─ audio/{AudioEngine,bgm,sfx,zzfxPresets,voiceBabble,manifest}.ts
│     ├─ i18n/locales/zh-CN/{ui,game,cards,items,gods,tiles,events,news,fate,magic,minigames,characters.original,characters.alt}.json
│     └─ dev/{Gallery,MapPreview,DebugPanel}.tsx testHooks.ts
├─ tools/extract/                # @rich4/extract（private；任何 app 都不得依赖它），结构见 design/data-pipeline.md §2
│  ├─ known-files.json  fingerprints.lock.json  anchors/{tables,seeds,constants}.json  maps/taiwan.overrides.json
│  ├─ src/{cli,context}.ts  io/ fingerprint/ bin/ mkf/ pe/ exe/ map/ verify/ report/
│  └─ test/{helpers,unit,local}/
└─ e2e/ playwright.config.ts fixtures/room.ts
        specs/{lobby,turn-cycle,timeout-ai,reconnect,chat-spectate,bank-stock,cards,minigame,save-load,solo-soak,mobile-layout,visual}.spec.ts
```

---

## 3. 分层与依赖规则（`scripts/check-deps.ts` + Biome noRestrictedImports）

| 模块 | 允许依赖 | 禁止 |
|---|---|---|
| shared/util | 无 | 任何其他模块 |
| shared/geom | util | |
| shared/data | util、geom | engine、view、net、ai |
| shared/engine | util、geom、data | view、net、ai、minigames、node:*、DOM、Date、Math.random |
| shared/view | engine（types、postPatch、EVENT_META、publicWorld）、data | |
| shared/minigames | util | engine、data |
| shared/ai | util、geom、data、view、engine/types、engine/selectors | engine/core、flow、effects；GameState 类型；state.secret |
| shared/net、shared/save | engine/types、view/types、minigames/types、ai/types、data | engine 实现 |
| apps/server | shared 全部（engine-testing 只能在 test/ 和 scripts/ 中使用） | `src/game/*` 不得引入 node:* 和 socket.io |
| apps/client | shared 的 util、geom、data、view、net、minigames、engine/types、engine/selectors | engine/core、flow、effects、testing；ai；node:* |
| tools/extract | shared/data/maps、shared/util | apps/* |

---

## 4. 全局约定

- **命名**
  - `GameEvent.type`、`DecisionKind`、`PlayerIntent.type`、`SystemAction.type` 一律用 SCREAMING_SNAKE。
  - Socket.IO 事件名用 `domain:camelCase`。
  - 数据 id、文件名用 camelCase；React 组件用 PascalCase.tsx。
  - 座位统一用 `SeatIndex = 0|1|2|3`，不再使用 PlayerId、SeatId。
- **确定性**（`engine/`、`minigames/`、`ai/` 三个目录）
  - 禁用 `Math.random`、`Date`、`performance`、`Intl`，以及 `Math.sin/cos/tan/pow/exp/log/hypot/round`（minigames 目录还禁 round）和 `for…in`。
  - state 里只放 JSON 值：用 null，不用 undefined；不用 Map 或 Set；排序的比较器最后必须按 seat 或 id 定序。
  - 由 `npm run check:determinism`（grep 加 AST 检查）强制执行。
- **数值**
  - 金额按 int32 语义：`add32`、`Math.imul`、`divTrunc`，由 `intOverflow` 控制溢出（默认 saturate，见 DEV-01）。点券范围 0..65535。
  - 股价以「分」为单位存整数。浮点只出现在股价动量和同盟分账（`Math.fround`）两处，并且只做四则运算。
- **RNG**：三套互不共享状态。
  - `util/rng/xoshiro.ts`：只给引擎用。状态存 `state.secret.rng`；语义层有 `rand15/pick/dice/weighted`，每次取数带 purpose 标签，另有 `debugQueue`。
  - `util/rng/watcom.ts`：给小游戏 sim 和 AI 用，与原版 `rand()%n` 的分布一致。
  - AI 的种子按 `(aiSeed, seat, decisionId | turnIndex+salt)` 派生，其中 `aiSeed` 存在 `secret` 里，只有 AiDriver 能读。
- **ID**
  - 决策 id 为 `d${n}`，帧、物件、公布栏挂牌用 counters 自增。
  - `TileId` 就是原版节点号（1 基）。`LotId` 形如 `` `L${n}` | `F${n}` | `C${n}` ``。`DateNum = y*10000+m*100+d`。
- **时间**
  - 引擎内没有真实时间。`startDate` 由服务器传入，引擎把它夹到 1998-01-01..2010-01-01 之间。
  - 所有截止时间都由服务器计算，客户端倒计时用 `time:ping` 校准时钟偏移。
- **出处**：`data/tables` 里每条记录都实现 `Sourced{src[], confidence}`，JSDoc 写 `@source` 和 `@verify`。测试断言每条至少有 1 个不是 verify 类的来源。
- **i18n**
  - 引擎和数据只给 id 或 nameKey。
  - 地图文案来自 `MapDef.strings`（zh-TW 为原文，zh-CN 由 opencc 转换）。
  - 角色名来自 `characters.original.json`；构建变量 `VITE_NAMESET=alt` 可整体换成 `characters.alt.json`。

---

## 5. 核心契约

### 5.1 MapDef（唯一的地图契约，`shared/src/data/maps/types.ts`，schemaVersion 1）

```ts
export type TileId = number;                                    // 原版节点号，1 基；fixture 同样 1 基
export type LotId = `L${number}` | `F${number}` | `C${number}`;  // 住宅地 / 设施 / 企业
export interface Cell { x: number; y: number }                  // 渲染网格：+x 为屏幕 SE，+y 为 SW
export interface World { x: number; y: number }                 // 原版世界坐标；fixture 取 cell×32。引擎范围判定只用它
export interface Rect { x: number; y: number; w: number; h: number }
export type TileKind = 'property'|'plain'|'park'|'news'|'fate'|'jail'|'hospital'|'penguin'|'balloon'|'xicong'
  |'lottery'|'points50'|'points30'|'points10'|'card'|'bank'|'shop'|'magic';
export interface TileLink { to: TileId; slot: 0|1|2|3; blocked: boolean; via?: Cell[] } // blocked 表示从本格经这个槽出发被禁止
export interface TileDef {
  id: TileId; cell: Cell; world: World; kind: TileKind; landingCode: number;          // landingCode 保留 0..16 原值
  ref?: { lot?: LotId; landmark?: string };
  links: TileLink[];      // 按原版槽号升序，只含非 0 槽。岔路候选 = 此顺序去掉来路和 blocked 后的结果，再取 rand15()%n
  noItems: boolean;       // 原版 flags bit31：不能随机放物件、神明、礼物，也不能作为开局落点
  holdFor?: 'hospital' | 'jail'; nameKey?: string; src?: { flags: number };
}
interface LotBase { id: LotId; world: World; rect: Rect; frontTiles: TileId[]; facing?: number; nameKey: string }
export interface LandLot extends LotBase { kind: 'land'; streetId: string; landPrice: number; housePrice: number; rent: [number,number,number,number,number,number] }
export interface FacilityLot extends LotBase { kind: 'facility'; landPrice: number; housePrice: number; rateWindow: [number,number,number,number,number,number] } // [0]=housePrice，[1..5]=各级费率
export interface CompanyDef extends LotBase { kind: 'company'; industry: number; industryKey: IndustryKey; stockIndex: number; tollBase: number; assetValue: number }
export interface LandmarkDef { id: string; kind: 'hospital'|'jail'|'scenery'; rect: Rect; nameKey: string; holdTile?: TileId }
export interface StreetDef { id: string; nameKey: string; lots: LotId[] }        // 按原版名称字节完全相等分组
export interface StockDef { index: number; nameKey: string; hasCompany: boolean; float: number; initPriceCents: number; volatility: number; volatilityF32: string }
export interface HolidayDef { slot: number; month: number; day: number; kind: number; flagsRaw: number; closed?: boolean; giveCard?: boolean; bgm?: boolean; lunar?: boolean }
export interface MapDef {
  schemaVersion: 1; id: string; globalMapId: number | null; nameKey: string;
  grid: { w: number; h: number }; terrain: string[]; tiles: TileDef[]; roadCells: Cell[];
  lots: (LandLot | FacilityLot)[]; companies: CompanyDef[]; landmarks: LandmarkDef[]; streets: StreetDef[];
  stocks: StockDef[]; holidays: HolidayDef[]; decorations: { kind: 'tree'|'rock'|'flower'; cell: Cell; variant: number }[];
  strings: Record<'zh-TW' | 'zh-CN', Record<string, string>>;
  meta: { source: { id: string; fileSha256: string; resourceSha256: string } | { fixture: true };
          counts: MapCounts; dataHash: string /* 规范化 JSON 的 sha256 */; generator: string };
}
// mapIndex.ts：纯函数，用 WeakMap 缓存
export interface MapIndex { def: MapDef; tile(id: TileId): TileDef; forwardCandidates(at: TileId, prev: TileId): TileId[];
  streetLots(streetId: string): LotId[]; lotsInWindow(c: World, half: number): LotId[]; placeableTiles(): TileId[];
  jailGate: TileId; hospitalGate: TileId;       // 保释格：落点码 4/5（台湾 12/16），停下时打开保释菜单
  jailHold: TileId; hospitalHold: TileId }      // 关押格：type 8002/8001（台湾 1/23），坐牢/住院者被搬到这里
export function buildMapIndex(def: MapDef): MapIndex;
export function validateMap(def: MapDef, o?: { strict4?: boolean; expect?: Partial<MapCounts> }): { ok: boolean; issues: MapIssue[] };
```

- 格式规则和 issue code 见 design/data-pipeline.md §8.4、§9。
- 台湾图优先用 `--strict4`（不允许对角 link）。确实无法消除时允许 via 连接格：via 不是游戏格，只用于画路和行走插值。
- fixture 有两张：`test`（20 格）和 `test-allkinds`（26 格，覆盖全部 17 类落点、死路和 via），由 ASCII 生成器产出，布局见 data-pipeline.md §11。fixture 的槽号固定为 N=0、E=1、S=2、W=3。

### 5.2 DataRegistry 与 EngineApi

```ts
// shared/src/data/maps/registry.ts
export interface DataRegistry {
  tablesHash: string;                                         // FNV-1a 64(规范化 TABLES)，同步计算
  getMap(id: string, mapHash?: string): MapIndex;             // 地图不存在或 hash 不符时抛 DataError('MAP_UNAVAILABLE')
  listMaps(): { id: string; mapHash: string; nameKey: string; counts: MapCounts; fixture: boolean }[];
}
export function createRegistry(maps: MapDef[]): DataRegistry;  // 由调用方先执行 validateMap
export const fixtureRegistry: DataRegistry;                    // 内含 test 和 test-allkinds

// shared/src/engine/api.ts
export function createEngine(reg: DataRegistry): EngineApi;
export interface EngineApi {
  readonly ENGINE_VERSION: string; readonly STATE_SCHEMA_VERSION: number;
  createGame(config: GameConfig, players: PlayerSetup[], seedHex: string): GameState;
  applyAction(state: GameState, action: GameAction): { state: GameState; events: GameEvent[] }; // 非法时抛 EngineRuleError{rule}
  getPendingDecisions(state: GameState): PendingDecision[];   // 数组，可以多人并发；游戏结束时为 []
  getResult(state: GameState): GameResult | null;
  validateState(state: unknown): state is GameState;          // zod 结构校验 + 不变量（design/engine.md §15）
  migrateState(state: unknown, fromVersion: number): GameState;
}
```

- **约束**
  - 同步执行；入参不修改（开发模式下 deepFreeze）。
  - 每个座位同一时刻至多 1 个 pending。
  - 决策 id 确定并单调递增，时光机回滚也不回退。
  - `applyAction` p50 < 5ms。
- **其他导出**：`PlayerIntentSchema`（zod，只含玩家 intent）、`ALLOWED_INTENTS`、`DECISION_TIMING_CLASS`、`EVENT_META`、`publicWorld`、`applyPostPatch`、selectors（`calcToll/netWorth/buyPrice/upgradeCost/streetLots/lotsInWindow/marketOpen/loanLimit`，都显式接收 `MapIndex`）；`internal.applyInPlace` 只给 simulate 和 fuzz 用；`engine-testing` 子路径提供 builders、scenario、randomIntent、debug。

### 5.3 GameState、GameConfig、RuleConfig

- GameState 结构见 design/engine.md §4。本文的修订：
  - `dataHash` 改为 `dataRef: { mapId; mapHash; tablesHash }`。
  - `PlayerState.aiProfile` 改为 `aiTraits: AiTraits`。
  - `PlayerState.turn` 增加 `log: TurnLogEntry[]`，取值为 `'stockBuy'|'stockSell'|'boardList'|'boardBuy'|'card'|'item'`。
  - `diceCount` 持久保存。
  - `SecretState` 增加 `aiSeed: number` 和 `timeAnchors?: (TimeAnchor|null)[]`（perSeat 模式用）。
  - `state.flow/pending/counters/secret` 永远不下发。

```ts
export interface GameConfig {
  mapId: string;                        // 'test' | 'test-allkinds' | 'taiwan'
  initialFund: 300000|200000|100000|50000|30000|10000;   // 默认 200000（exe 默认档位下标 1，V-E4；实机待 V-R15）
  vehicle: 'walk'|'moto'|'car'; tenure: 'unlimited'|'2y'|'1y'|'6m'|'3m'|'1m';
  timeLimitDays: 0|730|365|182|91|30; winMultiple: 0|100|50|10|5|3;   // 0 表示无限（说明书默认值）；大厅另提供「快速局 1 年/10 倍」预设
  startDate: DateNum;                   // 服务器传入当天日期，引擎夹到 [19980101, 20100101]
  minigames: 'play'|'skip';             // skip 相当于原版关闭「動畫過程」
  rules: RuleConfig; debug: boolean;    // debug 只在 RICH4_TEST_MODE 下为 true，这时才接受 SYS_DEBUG
}
export interface PlayerSetup { seat: SeatIndex; character: CharacterId; controller: 'human'|'ai'; ai?: SeatAiConfig }
```

RuleConfig 字段见 design/engine.md §5。预设与默认值见 §7.1。

### 5.4 决策模型

```ts
export interface PendingDecision<K extends DecisionKind = DecisionKind> {
  id: string; frameId: number; seat: SeatIndex; kind: K;
  options: DecisionOptionsMap[K];      // 渲染和 AI 所需的全部数值与合法候选（可能含私密信息）
  publicInfo: DecisionPublicInfo;      // 所有观察者可见：{kind, seat, lot?, amount?, labelKey?}
  defaultIntent: PlayerIntent;         // 必须合法
  timing: DecisionTimingClass;         // 'menu'|'confirm'|'pick'|'shop'|'bank'|'auction'|'lottery'|'minigame'
  budgetKey?: string;                  // key 相同的连续决策继承剩余时间（TURN_MENU：'turn:<turnNo>:<seat>'）
  minigame?: { minigameId: MinigameId; seed: number; params: MinigameParams };
}
```

**DecisionKind 共 23 种**，这是唯一清单。前端注册表和 AI 的 HANDLERS 都要用 `satisfies` 覆盖全部 23 种。

| DecisionKind | 触发 | timing | 前端组件 | AI 处理（design/minigames-ai.md §9） |
|---|---|---|---|---|
| TURN_MENU | 回合行动阶段 | menu | ActionPad + InventoryPanel/StockPanel/BoardPanel + TargetPicker | preRoll（硬币互斥：本回合只用卡或只用道具） |
| BANK_ATM | 路过或停在银行 | bank | BankDialog(atm) | atm（现金比例重分配） |
| BANK_COUNTER | 停在银行，ATM 之后 | bank | BankDialog(counter) | bankCounter |
| BUY_LAND / BUY_FACILITY | 无主地 | confirm | BuyLotDialog | buyLand（保留额阈值） |
| UPGRADE_LAND / UPGRADE_FACILITY | 自己的地 | confirm | UpgradeDialog | 能盖就盖 |
| BUILD_FACILITY / FACILITY_TYPE | 0 级设施首建 / 免费首建 | pick | FacilityBuildDialog | rng%4+1，从不盖公园 |
| RESEARCH | 自己的研究所 | pick | ResearchDialog | 最高档 |
| SHOP | 百货公司 | shop | ShopDialog | shop（电脑座位面对整副牌堆） |
| LOTTERY | 乐透格 | lottery | LotteryDialog | 现金>1000 时随机买一个号 |
| BAIL | 监狱或医院格 | pick | BailDialog | 按个性保释或雇恶人 |
| MINIGAME | 6/7/8 格，仅 controller=human | minigame | MinigameIntro（倒计时 + 跳过）→ MiniGameHost | MINIGAME_DECLINE |
| MAGIC_CAST | 魔法屋 | pick | MagicHouseDialog | 名单有自己 → 6，否则 rng%11（6 改为 7） |
| CONSTRUCTION_PICK | 建设公司 | pick | LotPickDialog | 租金最高的住宅 |
| SUBSCRIBE_SHARES | ★ 公司格 | confirm | SubscribeDialog | 按现金减 30% 保留额计算 |
| USE_FREE_CARD | 过路费、设施费、查税 | confirm | PassiveCardDialog | 金额 > 现金，或 > rng 阈值 |
| SCAPEGOAT | 持嫁祸卡且被命中 | pick | PassiveCardDialog | 陷害、梦游一律用 |
| AUCTION_BID | 拍卖，多人并发 | auction | AuctionDialog | 心理价位固定 |
| BIRTHDAY_PICK | 命运「生日」，真人座位 | pick | BirthdayPickDialog | 随机 |
| DISCARD_CARD | handFull='choose' | pick | DiscardDialog | 弃最便宜的一张 |
| DEATH_GOD_TARGET | 投降之后 | pick | SeatPickDialog | 用 defaultIntent（AI 永不投降） |

补充说明：

- 以下内容**不存在**：选岔路（CHOOSE_PATH/chooseDirection/ForkChooser）、选小游戏、遥控骰子对话框（它是 TURN_MENU 里道具的目标 `{t:'dice'}`）。转盘、老虎机、贷款提醒也只是事件演出。
- 未知的 kind 由 `GenericChoice` 兜底（只在开发期告警）。
- options 的结构见 design/engine.md §9.2–9.3。TURN_MENU 的 options 增加 `turnLog`。

### 5.5 Intent 与 Action

```ts
export type PlayerIntent =
  | { type: 'ROLL'; dice?: 1|2|3 }                       // dice 可选：引擎校验不超过交通工具上限，并写入 player.diceCount
  | { type: 'USE_CARD'; slot: number; card: CardId; target: CardTarget } | { type: 'USE_ITEM'; item: ItemId; target: ItemTarget }
  | { type: 'STOCK_BUY'|'STOCK_SELL'; stock: number; shares: number }
  | { type: 'BOARD_LIST'; asset: ListingAsset; price: number } | { type: 'BOARD_DELIST'|'BOARD_BUY'; listingId: number }
  | { type: 'SURRENDER' } | { type: 'CONFIRM' } | { type: 'DECLINE' } | { type: 'SKIP' } | { type: 'LEAVE' }
  | { type: 'BUILD_FACILITY'|'CHOOSE_FACILITY_TYPE'; facility: FacilityType }
  | { type: 'ATM'; op: 'deposit'|'withdraw'; amount: number } | { type: 'LOAN'|'REPAY'|'FINANCE'; amount: number }
  | { type: 'SHOP_BUY_CARD'; shelfIdx: number } | { type: 'SHOP_SELL_CARD'; slot: number } | { type: 'SHOP_BUY_ITEM'|'SHOP_SELL_ITEM'; item: ItemId; qty: number }
  | { type: 'LOTTERY_BUY'; number: number } | { type: 'BAIL'; seat: SeatIndex } | { type: 'HIRE'; villain: VillainKind }
  | { type: 'MAGIC_CAST'; effect: number } | { type: 'RESEARCH'; project: 1|2|3|4|5 } | { type: 'PICK_LOT'; lot: LotId }
  | { type: 'SUBSCRIBE'; shares: number } | { type: 'BID'; inc: 0|100|500|1000|5000|10000 } | { type: 'PASS' } | { type: 'QUIT' }
  | { type: 'SCAPEGOAT'; target: SeatIndex } | { type: 'PICK_CARDS'; picks: { from: SeatIndex; slot: number }[] }
  | { type: 'DISCARD'; slot: number } | { type: 'DEATH_GOD_TARGET'; seat: SeatIndex }
  | { type: 'MINIGAME_DECLINE' };                        // MINIGAME 决策唯一允许的客户端 intent
export type SystemAction =                               // 只能由服务器产生，不在 PlayerIntentSchema 中
  | { type: 'MINIGAME_RESULT'; seat: SeatIndex; decisionId: string; score: number; logHash: number }
  | { type: 'SYS_SET_CONTROLLER'; seat: SeatIndex; controller: 'human'|'ai' }    // 被踢时使用；托管不改 controller
  | { type: 'SYS_SET_AI_TRAITS'; seat: SeatIndex; traits: AiTraits }
  | { type: 'SYS_DEBUG'; op: DebugOp };                  // 要求 config.debug：forceNext/setCash/setPoints/teleport/give/setDate
export type GameAction = (PlayerIntent & { seat: SeatIndex; decisionId: string }) | SystemAction;
```

- **防刷**：每回合的非终结 TURN_MENU 操作不超过 40 次，超出抛 `EngineRuleError('MENU_LIMIT')`。

### 5.6 GameEvent 约定

- 可辨识联合，判别字段是 `type`（SCREAMING_SNAKE）。`EventBase = { type; post?: PostPatch }`。
- **post 由引擎自动生成**：`ctx.emit` 时对公开世界做实体级 diff，得到事件发生后受影响实体各字段的绝对值。handler 必须先改状态再 emit。
- 如果 action 结束时还有未经任何事件公布的变化，引擎自动补一个 `SYNC`。开发和测试模式下，除 `TIME_REWOUND` 之后的那一次外，出现 SYNC 即判为失败。
- 客户端的 viewReducer **就是** shared 的 `applyPostPatch`。结构上保证 `fold(applyPostPatch, view_prev, events) ≡ view_next`。
- `EVENT_META[type] = { cat, privacy: 'public'|'redactCards', resetsView? }` 是脱敏和重置的唯一依据。
- 客户端的 `handlers`、`soundMap`、`EVENT_BUDGET_MS` 都以 `GameEvent['type']` 为键，并用 `satisfies` 穷举。
- 事件清单见 design/engine.md §12.2，本文修订：
  - 删除 `DICE_SET`；`DICE_ROLLED` 增加 `diceCount`。
  - `MINIGAME_RESULT` 事件改名为 `MINIGAME_ENDED{seat, minigameId, mode:'played'|'skipped', score, speechSlot?}`，post 中带点券。
  - `MINIGAME_STARTED{seat, minigameId}` **不带种子**。
  - 引擎每次日推进结束都 emit `DAY_END`，服务器用它触发自动存档。

### 5.7 GameView 与投影（`shared/src/view`）

```ts
export type PlayerView = Omit<PlayerState, 'cards'> & { cards: CardId[] | null; cardCount: number };
export interface GameView extends Omit<PublicWorld, 'players'> { players: PlayerView[] }   // 包含 dataRef、config、pools（牌堆剩余张数）
export type Viewer = { kind: 'seat'; seat: SeatIndex } | { kind: 'spectator' };
export function projectState(s: GameState, v: Viewer, o: { handVisibility: 'public'|'private' }): GameView;
export function projectEvent(e: GameEvent, v: Viewer, o): GameEvent;  // 私密模式下把非本人的 post.players[].set.cards 改写为 cardCount
export function viewerClassKey(v: Viewer, o): string;                   // public 模式下全员共用一个 key
```

- **默认 `handVisibility='public'`**，还原原版同屏体验。
- 私密模式下，抢夺卡能看到的对方手牌只出现在出卡者的 `DecisionForYou.options` 里。

### 5.8 网络协议（Socket.IO 4.8.4；基础类型与语义见 design/net.md §4，下表为最终清单）

**C2S**：全部带 ack，返回 `Result<T>`。

| 事件 | payload（与 net 设计的差异加粗） |
|---|---|
| lobby:list | {} |
| room:create / join / resume / leave / dissolve / updateSettings / takeSeat / toSpectator / selectCharacter / setReady / kick / transferHost / start / rematch / loadSave / claimSeat | 同 design/net.md §4.5 |
| room:setSeatAi | {seat, **ai: SeatAiConfig \| null**} |
| room:assignSeat | 可选功能，v1 不实现 |
| game:act | {decisionId, intent: PlayerIntent, clientActionId}；seat 只从 session 取 |
| game:autopilot | {on, **settings?: TrusteeSettings**} |
| game:pause / game:resync / game:save | 同 net |
| **game:minigameInput** | {sessionId, seq, events: InputEvent[]}，每 200ms 或攒够 8 条发一次；seq=0 表示「已开局」 |
| **game:minigameSubmit** | {sessionId, inputs: InputEvent[], claimedScore, finalHash, clientElapsedMs} → Ack<{score}> |
| saves:list / saves:delete / chat:send / chat:emote / time:ping | 同 net |
| **debug:act** | {op: DebugOp}，只在 `RICH4_TEST_MODE=1` 时注册 |

**S2C**：`room:state`、`room:closed`、`game:snapshot`、`game:batch`、`game:catchup`、`game:pending`、`game:over`、**`game:minigameWatch`（观战票据）**、**`game:minigameFrames`（{sessionId, seq, events}）**、`chat:message`、`chat:history`、`chat:emote`、`session:replaced`、`server:notice`、`app:error`。

**消息体**：沿用 design/net.md §4.4。

```ts
interface GameBatchMsg { epoch; seq; cause: {seat|null; intentType; by: ActorBy}; events: GameEvent[]; animMs; view: GameView;
                         pending: PendingView[]; yourDecision?: DecisionForYou; serverNow }
interface PendingView { decisionId; seat; kind; timing; deadlineAt: number|null; control: SeatControl; publicInfo }
interface DecisionForYou { decisionId; kind; options; defaultIntent; deadlineAt: number|null; minigame?: MinigameTicket }
```

- **客户端规则**
  - epoch 与本地不同，或 `seq !== lastSeq+1`：丢弃这个 batch，发 `game:resync`，服务器回 `game:snapshot`。
  - 短断线后收到 `game:catchup`：落后不超过 8 批时以 2–4 倍速播放，否则直接 reset。
- **HTTP**
  - `GET /healthz`、`GET /readyz`。
  - `GET /api/maps` 列出可用地图。
  - `GET /api/maps/:id?h=<mapHash>` 返回 MapDef，设 `Cache-Control: immutable`。
  - `GET /api/saves/:id/export`、`POST /api/saves/import`。
  - `GET /admin/stats`（需 Bearer ADMIN_TOKEN）。
  - `GET /r/:code`：返回注入了 og 信息的 index.html。

**RoomSettings**（`shared/net/room.ts`）

```ts
interface RoomSettings {
  visibility: 'private'|'public'; allowSpectators: boolean; maxSpectators: number; spectatorChat: 'all'|'spectators'|'off';
  handVisibility: 'public'|'private';              // 默认 public
  timerPreset: 'fast'|'normal'|'slow'|'off';       // 默认 normal；单机默认 off
  timeoutPolicy: 'default'|'ai';                   // 默认 default：单次超时执行 defaultIntent；托管状态才由 AI 代打
  reconnectGraceSec: number; pauseWhenAllAway: boolean; aiPace: 'normal'|'fast';
  minigameSpectate: 'live'|'replay';               // 默认 live
  allowMinigameDecline: boolean;                   // 默认 true
  game: GameConfig;
}
```

- **单机**：`/solo` 路由自动依次执行 `room:create{visibility:'private', allowSpectators:false, timerPreset:'off'}`、3 次 `room:setSeatAi`、`room:start`。v1 没有离线 Worker 模式。
- **限流与大小**：见 design/net.md §4.8。常量放在 `shared/net/limits.ts`，客户端引用同一份。聊天单条 ≤200 字，每 10 秒最多 5 条。

### 5.9 计时（`shared/net/timing.ts` + `apps/server/src/game/Deadlines.ts`）

```ts
export const DECISION_TIMEOUT_S = { menu: 30, confirm: 15, pick: 20, shop: 30, bank: 20, auction: 15, lottery: 15 } as const;
export const PRESET_SCALE = { fast: 0.5, normal: 1, slow: 2, off: null } as const;
export const NET_GRACE_MS = 800, MENU_CHAIN_MIN_S = 8, MENU_TURN_CAP_S = 90, RESUME_MIN_S = 5, RELEASE_MIN_S = 10;
// deadlineAt = now + estimateAnimMs(rawEvents) × animScale + timeout × presetScale；服务器定时器在 deadlineAt + NET_GRACE_MS 才触发
```

- **TURN_MENU 链**：与上一个决策 `budgetKey` 相同时，截止时间 = `max(上一个 deadline, now + 8s)`，但不超过该回合首次出现时间 + 90s。
- **AUCTION_BID**：每人独立计时；每次重新 ask 都重新计 15 秒。
- **MINIGAME**：`deadlineAt = startsAt + maxTicks × tickMs + 5000`，其中 `startsAt = now + animMs + 3000`（3 秒倒计时）。
- **动画预算**：`shared/view/pacing.ts` 导出 `STEP_MS=180`、`EVENT_BUDGET_MS`（例：DICE_ROLLED 900、MOVE_SEGMENT = path×180+250、TOLL_PAID 1100、NEWS 3800、LOTTERY_DRAW 4200、MINIGAME_ENDED 按 mode 取值）和 `estimateAnimMs`。客户端开发模式下实测 handler 时长，超预算 10% 告警。
- **AI 思考延迟**：normal 档 400–1200ms，fast 档 150–300ms，在动画预算之后再加上。

### 5.10 小游戏（`shared/src/minigames`，规则见 design/minigames-ai.md §2–7）

```ts
export type MinigameId = 'penguin' | 'balloon' | 'xicong';            // 企鹅挖宝(6) / 七彩气球(7) / 喜从天降(8)
export type InputEvent = readonly [tick: number, code: InputCode, a: number, b?: number];  // 在第 tick 次 step 之前生效
export interface MinigameSpec { id; tickMs: 50|100; introTicks; playTicks; maxTicks; stage: {w:640;h:480}; acceptedCodes;
  maxInputsPerTick; maxInputsPerSecond; scoreSanityMax; rollbackAttribution }
export interface MinigameSim<S extends SimBase> { spec; init(seed, p): S; step(s, inputs): void; isOver(s): boolean;
  score(s): number; clone(s): S; hash(s): number; validateInput(e): boolean; accepting(s): boolean }
export function replay(sim, seed, p, log): { score; endTick; hash };
export interface MinigameTicket { sessionId; decisionId; seat; minigameId; seed; params: MinigameParams; tickMs; introTicks; maxTicks;
  startsAt; deadlineAt; role: 'player'|'spectator' }
```

- **参数**：企鹅 100ms × (10+150) tick，满分 188；气球 100ms × (5+150) tick，然后清场；喜从天降 50ms × (10+360) tick，炸弹预警概率 30%。
- **不玩分支**（电脑座位、`minigames:'skip'`、托管、超时、主动跳过）：`score = 50 + rand15()%20`，`speechSlot = rand15()&1`，恰好消耗 2 次随机数。controller=ai 的座位由引擎直接结算，不产生决策。
- **裁判流程**：
  - 决策出现时 Referee 开会话。玩家票据经 `DecisionForYou.minigame` 下发；live 模式下观战票据经 `game:minigameWatch` 下发。
  - 输入流实时转发为 `game:minigameFrames`。
  - 提交的 `inputs` 必须以已经上传的流为前缀。
  - 最终以服务器 `replay` 的结果为准，提交系统 action `MINIGAME_RESULT`。
  - 已开局但到期：用已收到的输入重放结算。未开局到期：提交 `MINIGAME_DECLINE`。开局后再发 decline 返回 `MINIGAME_INVALID`。

### 5.11 AI（`shared/src/ai`，规则见 design/minigames-ai.md §8–9）

```ts
export interface AiTraits { personality: 0|1|2; useCards: boolean; useItems: boolean; loanRatio: number; cashRatio: number; stockRatio: number }
export type AiPreset = 'character'|'gentle'|'normal'|'cunning';           // UI 标签：按角色（原版）/乖宝宝·简单/普通人·普通/大老奸·困难
export interface SeatAiConfig { preset: AiPreset; overrides?: Partial<AiTraits> }
export interface TrusteeSettings { personality: 0|1|2; useCards: boolean; useItems: boolean; cashRatio: number; stockRatio: number }
export interface AiContext { seat; traits: AiTraits; rng: AiRng; turnRng(salt: string): AiRng; map: MapIndex; handVisibility }
export interface AiPolicy { readonly id: 'original-v1'|'basic'; decide(view: GameView, d: DecisionForYou, ctx: AiContext): PlayerIntent }
```

- `resolveTraits(characterId, cfg)` 放在 `data/tables/characters.ts`，引擎开局时写入 `aiTraits`。
- 托管设置经 `SYS_SET_AI_TRAITS` 写入 state，会随存档保存。
- AiDriver 调用 `decide` 时用 try/catch 包住。抛异常，或 intent 不能通过 `PlayerIntentSchema`、`ALLOWED_INTENTS`，就退回 `defaultIntent` 并计数 `ai_rejects`。连续失败 3 次则暂停房间。
- 同一个 AiDriver 服务四种情况：纯 AI 座位、托管、`timeoutPolicy='ai'` 下的超时代决、小游戏 decline。

### 5.12 存档与持久化

- **SQLite 表结构、journal 与快照策略、优雅停机、启动恢复**：沿用 design/net.md §8（node:sqlite，WAL 模式；每个 action 追加一条 journal；每 25 个 seq 写一次快照）。
- **存档格式**：

```ts
export interface SaveFileV1 {
  format: 'rich4-save'; schemaVersion: 1; engineVersion: string; stateVersion: number;
  mapRef: { id: string; mapHash: string }; tablesHash: string; savedAt: number; name: string;
  meta: { mapId: string; gameDay: number; date: DateNum; seats: Array<{ characterId; nickname; kind: 'human'|'ai' }> };
  roomSettings: RoomSettings; seats: SaveSeat[]; game: GameState; chatTail?: ChatMessage[];
}
export interface SaveSeat { index: SeatIndex; characterId: CharacterId; nickname: string; kind: 'human'|'ai'; ai?: SeatAiConfig; ownerTokenHash?: string }
```

- 数据库存 `gzip(JSON)`，另存 `HMAC-SHA256` 签名。导出文件为 `.r4save`，内容是 `R4S1.<b64url(gzip)>.<b64url(sig)>`。
- **兼容性**：
  - `stateVersion` 较旧：调用 `migrateState` 迁移。
  - `mapHash` 不符且没有迁移：返回 `SAVE_INCOMPATIBLE`。
  - `tablesHash` 不符：只告警。
  - 签名无效：仍可读取，但标记为「非官方存档」。
- v1 **只有服务器存档**，不做 IndexedDB 本地存档。

---

## 6. 关键流程（摘要）

1. **一个 action**
   - `game:act` → `guard`（限流、zod 校验）→ `GameRunner.submit`（按 net §6.2 的 10 步校验）→ `engine.applyAction`。
   - 然后 seq 加 1，写 journal 和 RingBuffer，重新计算 pending 与截止时间，按 viewerClass 投影后广播 `game:batch`，最后回 ack。
2. **客户端播放**
   - `EventPlayer.enqueue(batch)` → 对每个事件 `await handlers[e.type]` → `view = applyPostPatch(view, e.post)` → 提交到 store。
   - 批尾在开发模式下断言与 `batch.view` 深度相等，然后 `board.sync(batch.view)`，再显示 `yourDecision`（即动画播完才弹决策框）。
   - 页面在后台时切到 instant 模式；`TIME_REWOUND` 直接 reset。
3. **重连**：见 design/net.md §5.2。15 秒宽限期后转 `autopilot:disconnect`，玩家回来自动解除；全员离线则暂停。
4. **小游戏**：见 §5.10。
5. **读档**：见 design/net.md §8.4。房主在大厅加载存档，tokenHash 匹配的成员自动入座，其余座位由新玩家认领或补 AI。开局后 epoch 加 1。
6. **重启恢复**：快照加 journal 尾部重放。恢复出的房间 epoch 加 1，处于暂停状态；第一个真人回来时自动恢复。

---

## 7. 规则基准、开关与有意偏差

### 7.1 RuleConfig 预设（完整裁决见 design/engine.md §1）

| 开关 | PROGRAM（默认） | MANUAL | 核实 |
|---|---|---|---|
| redBlack | 事件字节 0x20：当天加次日倒数，后写覆盖前写 | 3 个开市日，红黑互相抵消 | V-R11 |
| fortuneGodLand | 照付全价，买地、盖房后多送 1 级 | 大福神免费，小福神半价 | — |
| smallPoorToll | ×1.5 | ×2 | — |
| engineeringVehicle | 停在别人有建筑的地上时清到 0 级，持续 7 个自己的回合 | 经过和停留都拆 1 级 | V-R16 |
| bombBlast | 只影响携带者和所在格 | manual3x3 | V-R4 |
| sundayBankClosed | false | true | V-R6 |
| handFull | autoCheapest | choose | V-R5 |
| blessingOnNews / deathGodDispellable / freeCardOnFines | false / true / false | true / false / true | V-R8、V-R12 |
| stockSuspendDays / constructionChairmanLevels | 15 / 2（exe 调用两次，g_map §4.3） | 10 / 1（PTT「附送加盖一次」） | V-R11、V-R19 |
| 联机适配（两个预设相同） | targetRange='window'(windowHalf 220)、timeMachine='global'、intOverflow='saturate'、endWhenNoHumans=true | 同左 | V-E10 |

另外两条定论：
- **停下才触发**：路过只触发银行 ATM、路障拦停、身上定时炸弹的倒数和转移。
- **阻碍计数器**：按原版两段式编码（0x80 为待释放）。

### 7.2 岔路与视野

- **岔路**：`MapIndex.forwardCandidates(at, prev)` 按槽序取候选；候选为空就掉头；否则取 `pick('fork', n)`。只有 1 个候选也要消耗一次随机数。
- **视野**：`geom/viewWindow.ts` 在 v1 用世界坐标方窗，半开区间 −220 ≤ d < 220。拿到 V-E10 的原版视角 0 投影后改为投影版，同时升 ENGINE_VERSION 的次版本号。

### 7.3 有意偏差（DEVIATIONS.md 初始内容）

- **DEV-01**：金额、点券溢出默认饱和，可以切回 `intOverflow:'wrap'`。
- **DEV-02**：引擎 RNG 用 xoshiro128**。`rand15()%n` 分布相同，但序列与原版不同（原版序列本来也无从对拍）。
- **DEV-03**：AI 的随机数按决策派生；排序改为稳定排序（原版 qsort 不稳定）；AI 视野固定用视角 0。
- **DEV-04**：v1 的目标范围和 AI 视野用世界坐标方窗近似原版的 440×440 屏幕视窗。
- **DEV-05**：时光机的联机语义。锚点是真人掷骰前的世界；回滚时 RNG 和决策 id 都不回退，`perSeat` 或 `disabled` 可选。
- **DEV-06**：真人可以在小游戏倒计时阶段主动跳过，由房间设置控制。
- **DEV-07**：企鹅用几何菱形拾取；气球点击按最近 tick 归属。
- **DEV-08**：神明重生尝试 64 次后放宽距离约束。
- **DEV-09**：单次超时默认执行 defaultIntent，不让 AI 代决。
- **DEV-10**：美术、音频全部自制；角色名走 i18n。
- **DEV-11**：AI 不使用特別融資，不做公布栏重新定价（这两块尚未解明）。
- **DEV-12**：证据缺失的规则（在代码和数据中标 ⚑）先按标注的默认值实现，等待 VERIFY。
- **DEV-13～15**（M4 新增，见 §18.1）：住旅馆 1 天也受阻 1 个回合 ⚑；百货公司每次进店最多 60 笔交易；农历覆盖到 2100 年。

---

## 8. 测试策略

| 层 | vitest project 或工具 | 关键用例 |
|---|---|---|
| 规则单测 | `shared` | engine/rules/*（台南样本、两段式计数、1998-01-01 为星期四、int32 两种模式）；effects：30 卡、13 道具、13 神明、36 新闻、37 命运、12 魔法屋效果，每项至少 1 例 |
| 场景 DSL | `shared` | engine-testing 的 `scenario()` 加 `SYS_DEBUG forceNext`：陷害被嫁祸回来 4 天、路过银行后继续移动、并发拍卖、时光机、在任意 pending 处存读档后继续 |
| 不变量与属性测试 | `shared`（fast-check 4） | 每步执行 validateState：牌堆、道具池、股本、资金台账守恒；确定性（同输入同哈希） |
| **跨包一致性** | `shared` + `client-unit` | `postPatch.fold.test.ts`（引擎）和 `viewFold.test.ts`（客户端，用同一个 applyPostPatch）：20 个种子 × 300 个 action |
| 小游戏 | `shared` + `client-browser`（Chromium、WebKit、Firefox） | golden 10×3；三种浏览器引擎的重放哈希一致；非法日志被拒 |
| AI | `shared` | 每个判据至少一正一反两个 fixture；`fuzz.legality`：合法率 100%，p99 < 5ms，访问 secret 时 Proxy 抛错 |
| 服务端 | `server` | unit：GameRunner、Deadlines、AiDriver、MinigameReferee、rateLimit、codec；integration：lobby、full-game-4p（stub 和 real 引擎各一遍）、reconnect、anti-cheat（深度扫描所有 S2C 输出，不得出现 secret、rng、flow、counters、newsOrder）、save-load、restart-recovery、spectator-chat、auction |
| 前端 | `client-unit`、`client-dom`、`client-browser` | EventPlayer、决策组件、Pixi 冒烟、Gallery 截图基线 |
| 提取 | `extract`（CI 只用合成数据）、`test/local/*.local.test.ts`（有 original/ 才跑） | 合成 PE、MKF、地图资源；几何；只读守卫；台湾样本 |
| E2E | Playwright 1.63（4 个 context 加 1 个观战） | 12 个 spec；测试模式开 `RICH4_TEST_MODE=1`，URL 带 `?anim=instant&audio=off`；一律点 DOM 备用按钮 |
| 夜间 | `npm run sim` | 1000 局 × 4 AI：限时局 100% 结束，无限局（封顶 20 年）结束率 ≥ 95%；rejects 为 0；同 seed 两次运行的 finalHash、journalHash 相同 |

---

## 9. 构建、运行与部署

### 9.1 根 scripts

```jsonc
{
  "dev": "node scripts/dev.mjs",                        // 并行启动 server:3000 和 vite:5173（Vite 代理 /socket.io、/api）
  "dev:server": "npm -w @rich4/server run dev",         // tsx watch
  "dev:client": "npm -w @rich4/client run dev",
  "build": "npm -w @rich4/client run build && npm -w @rich4/server run build",
  "typecheck": "npm run typecheck --workspaces --if-present",
  "lint": "biome check .",
  "test": "vitest run --project shared --project server --project client-unit --project client-dom --project extract",
  "test:browser": "vitest run --project client-browser",
  "test:e2e": "playwright test -c e2e/playwright.config.ts",
  "fixtures": "tsx scripts/gen-fixtures.ts",
  "extract": "tsx tools/extract/src/cli.ts",
  "sim": "tsx apps/server/scripts/simulate.ts",
  "replay": "tsx apps/server/scripts/replay.ts",
  "loadtest": "tsx apps/server/scripts/loadtest.ts",
  "bench:engine": "tsx apps/server/scripts/bench-engine.ts",
  "check:determinism": "tsx scripts/check-determinism.ts",
  "check:no-original": "tsx scripts/check-no-original.ts",
  "check:deps": "tsx scripts/check-deps.ts",
  "check:bundle": "tsx scripts/check-bundle.ts",
  "check": "npm run typecheck && npm run lint && npm test && npm run check:determinism && npm run check:no-original && npm run check:deps"
}
```

**依赖版本**（沿用领域设计里 2026-09 实测的版本）：socket.io 与 socket.io-client 4.8.4、fastify 5、@fastify/static 10、zod 4、pixi.js 8.21、react 19.3、zustand 5、radix-ui 1.6、motion 13、i18next 26、wouter 3、zzfx 1.3；开发依赖 vite 8、vitest 5、fast-check 4、@playwright/test 1.63、typescript 7（只做 noEmit 类型检查）、@biomejs/biome 2、tsx 4、esbuild 0.28、opencc-js 1.4（只在 extract 里用）。

不再使用：idb-keyval、fake-indexeddb、howler、@pixi/react、pixi-viewport。

### 9.2 环境变量

```
PORT=3000  HOST=0.0.0.0  PUBLIC_URL=https://rich4.example.com
DATA_DIR=/data                 # 读写：sqlite、备份、崩溃转储
RICH4_DATA_DIR=/data-rich4     # 只读：manifest.json 加 maps/*.map.json；缺失时只提供 fixture 地图并告警
DEFAULT_MAP=taiwan             # 找不到时回退到 test
SAVE_HMAC_SECRET=<≥32 字节>  TRUST_PROXY=1  LOG_LEVEL=info  MAX_ROOMS=500  ROOM_ABANDON_TTL_MIN=30
ADMIN_TOKEN=<可选>  DEV_CORS_ORIGIN=<仅开发>  RICH4_TEST_MODE=0
STORE=sqlite|json  BACKUP_ENABLED=1  BACKUP_KEEP=7     # M5（§18.3）；开发默认 DATA_DIR=.cache/data
RICH4_AI_POLICY=original|basic  RICH4_TIMER_SCALE=<(0,1]，仅 RICH4_TEST_MODE=1 生效>   # §18.6
STATIC_DIR=<前端构建目录，缺省 apps/client/dist>
# 原版皮肤（§22.1；original-skin.md U4 / §3 修正 3）
RICH4_ASSETS_DIR=/assets-rich4   # 只读素材包目录，只认显式设置，目录里有 manifest.json 才启用
RICH4_ASSETS_VERIFY=quick|full   # 启动校验：结构 + 字节数 | 另外逐文件复算 sha256
ACCESS_MODE=off|passcode|invite  ACCESS_PASSCODE_HASH=scrypt:<N>:<r>:<p>:<salt>:<hash>  ACCESS_SECRET=<≥32 字节>
ACCESS_TTL_DAYS=30  ACCESS_GRANTS=1   # 口令 / 邀请码 cookie 有效天数（滑动续期）；允许生成房间邀请授权
RICH4_ASSETS_ALLOW_UNGATED=0     # 仅本机调试：非 production + PUBLIC_URL 为 localhost + TRUST_PROXY=0 时允许有素材包而不设门禁
```

启用素材包（RICH4_ASSETS_DIR 下有 manifest.json）而 ACCESS_MODE=off 时服务器拒绝启动（上面的本机调试例外除外）。
口令哈希与签名密钥用 `npx tsx scripts/access.ts hash [--stdin]` / `secret` 生成；邀请码与吊销见 `scripts/access.ts invite|list|revoke`
或 `ADMIN_TOKEN` 保护的 `/admin/access/*`（§22.1）。

### 9.3 Docker、compose、Caddy

- **Dockerfile**：沿用 design/net.md §10.2 的三阶段构建（`node:24-slim`），增量如下：
  - 各阶段额外 `COPY tools/extract/package.json tools/extract/`，保证 workspaces 的 lockfile 一致。
  - `zod` 列入 `@rich4/server` 的 dependencies，因为 esbuild 把第三方包作为 external。
  - `.dockerignore` 排除 `original/ .cache/ rich4-data/ tools/extract/src tools/extract/test e2e docs`。
- **compose**（`deploy/docker-compose.yml`）：
  - `app`：`init: true`，`stop_grace_period: 30s`，`env_file: .env`，挂载 `rich4-state:/data` 和 `../rich4-data:/data-rich4:ro`。
  - `caddy:2`：映射 80 和 443；Caddyfile 使用 `{$SITE_ADDRESS:localhost}`，`reverse_proxy app:3000`。本地用 Caddy 内部 CA，生产用 Let's Encrypt。
- **数据发布**：用户在本机执行 `npm run extract -- all && npm run extract -- pack --out rich4-data/`，然后 `rsync -a rich4-data/ server:/srv/rich4/rich4-data/`。**原版文件永远不上传。**

---

## 10. 里程碑总览（各里程碑的范围和验证命令见 milestones 字段）

| ID | 标题 | 依赖 | 估算（人周） |
|---|---|---|---|
| M0 | 脚手架与测试地图 | — | 1 |
| M1 | 引擎核心（最小可玩） | M0 | 3 |
| M2 | 服务端联机骨架 | M0（先用 stubEngine，与 M1 并行） | 2 |
| M3 | 前端骨架、棋盘与主循环 | M0，接 M1 和 M2 | 3 |
| D1 | 原版数据提取管线与台湾 MapDef | M0 + 用户拷贝文件（并行轨道） | 1.5 |
| D2 | 版本对比与 exe 常量核实 | D1 | 1 |
| M4 | 经济系统 + AI 经济决策 + 经济面板 | M1–M3 | 2.5 |
| M5 | 持久化、存档读档、社交与观战 | M2、M3 | 1.5 |
| M6 | 卡片、道具、神明、关押 + AI 卡片道具 + 特效 | M4 | 3 |
| M7 | 新闻、命运、魔法屋、恶人、拍卖、投降、时光机、公布栏 | M6 | 3 |
| M8 | 三个小游戏（sim、裁判、观战、宿主） | M3（与 M4–M7 并行） | 2.5 |
| M9 | 台湾图接入与原版核实 | D1、D2、M7 | 1.5 |
| M10 | 体验打磨（美术、音频、横屏、完整 E2E、性能） | M8、M9 | 2 |
| M11 | Docker 部署与上线 | M10 | 0.5 |

关键路径：M0 → M1 → M3 → M4 → M6 → M7 → M9 → M10 → M11。D1 和 D2 从用户拷完文件开始并行推进，M5、M8 是旁支。

---

## 11. 需要从用户正版文件核实的项（VERIFY.md 初始清单）

核实方式分三种：**E** 为 `npm run extract` 自动提取；**R** 为 `r2 -q -c 'pd …'` 人工反汇编核对（v3.11 的 VA 列在 design/minigames-ai.md §11 和 design/engine.md §18）；**P** 为用户在原版 v2.06 里实机操作，或提供 SAVE*.DAT 由导入工具比对。

| ID | 核实项 | 方式 |
|---|---|---|
| V-F1 | Steam 目录结构；`Game/MapDat.mkf` 是否存在、资源数；台湾结构资源是否压缩（压缩则 LZHUF 解码器进入关键路径） | E |
| V-F2 | 两个 RICH4.EXE 的 sha256 是否分别为 `110b29f9…`（v2.06）、`50cb24bb…`（v3.11）；与 mytbk 参考版 `5a90aee2…` 的差异；有无 SteamStub 或其他壳节 | E |
| V-F3 | MKF 索引表最后一项是否为哨兵；map.mkf 资源数（v3.11 应为 298）；两版压缩资源总数（约 878） | E |
| V-M1 | 三个来源（v206-MapDat[0]、v206-map.mkf[1]、v311-map.mkf[1]）的规则字段是否一致；不一致时由用户选基线 | E |
| V-M2 | 住宅地：0x1c 地价、0x1e 房价、0x20 租金[6]；设施：0x22 地价、0x24 rateWindow、0x34 flast | E |
| V-M3 | 企业：0x19 股票下标、0x1a 行业码（7 以外的对应）、0x22 tollBase、0x24 assetValue（台灣人壽是否为 400000） | E |
| V-M4 | flags 低字节与节点名是否一致；bit(30−k) 是否为槽 k 的封路位（台湾应恰好 2 处）；bit31 的节点数 | E |
| V-M5 | +0x1b facing 的语义，及其与地块到路格方向的映射 | E |
| V-M6 | 世界坐标对 32 取模的残差；对角边、长边、同格节点；邻接是否对称 | E |
| V-M7 | 8001/8002 关押格是否可走、是否兼有落点码、引用的景观名 | E |
| V-M8 | 样本：台北、新竹、台南；计数 103/50/4/3/21；Big5 严格解码与回编码 | E |
| V-E1 | 卡片表、道具表两版逐字节比较（裁决 Fandom 上嫁祸、红卡、涨价、同盟 4 张卡的价格） | E |
| V-E2 | 角色表 12×0x68：性格、借贷、现金、炒股比例、颜色、能力位 | E |
| V-E3 | 股票表有 48 项还是 96 项；台湾 12 支；价格是否为整数分；波动系数 | E |
| V-E4 | 开局三张表的数值，以及**默认资金档位的索引**（300000 还是 200000） | E + P |
| V-E5 | 节日表每项 12 字节的布局与标志位（休市、送卡、BGM）；图数；农历节日怎么表示 | E + R |
| V-E6 | 设施等级上限、魔法屋表、商店系数 0.9、月息 1.1、rand 常量、LZHUF 位置码表 | E |
| V-E7 | 新闻 36、命运 37、魔法屋 12 的文案与系数，两版之间的常量差异（funcdiff） | E |
| V-E8 | 转盘数值：旅馆 12 格排列、保险天数、航空转盘、购物中心倍数 | E + R |
| V-E9 | 常量复核：炸弹 38、娃娃 9、飞弹半宽 100、核弹 220、视窗 440、神明重生 300、恶人步数 rand%9+2、乐透 36 个号 / 1000 元、保释 30 / 雇恶人 300、贷款 90 天、乞丐 1000、个股停牌 15 | E + R |
| V-E10 | 视野投影表（0x46ccf0、0x474910），用于替换 geom/viewWindow | E + R |
| V-C1 | 小游戏：who_plays==1 才亲自玩、不玩分支 2 次 rand、企鹅计时/DDA/揭晓期间点击是否被吞、气球生成/命中框/999 夹子/无可用跑道时是否掷 rand、喜从天降炸弹 30%/**静止时能否接住**/更新顺序/财神状态机、「動畫過程」和梦游闸门、v2.06 与 v3.11 是否相同（M1–M21） | R |
| V-C2 | AI：个性闸门、硬币、候选 8/4、买地保留额、骰子策略、银行（借款是否要求贷款==0、30000 是否乘 PI）、股票常量、商店顺序表、保释/魔法屋/乐透/拍卖/公布栏分支、特別融資、核弹阈值（A1–A13） | E + R |
| V-C3 | 工程车与神明显灵的先后；定时炸弹先倒数还是先转移 | R |
| V-R1 | 坐牢 N 天实际经过的回合数；停留卡、乌龟卡的次数；陷害被嫁祸回来是 4 天 | P |
| V-R2 | 首回合跳伞后是否立即掷骰、是否结算落点 | P |
| V-R3 | 梦游者落点：是否付过路费、是否触发地雷和神明 | P |
| V-R4 | 定时炸弹是否伤及 3×3 范围内的其他人 | P |
| V-R5 | 满手时拿到第 16 张卡是否弹窗让玩家选弃哪张 | P |
| V-R6 | 星期日 ATM 和柜台能否使用 | P |
| V-R7 | 魔法屋：名单有自己时能否选全部效果；坐牢住院能否被免罪卡、嫁祸卡挡掉；「拍卖当格」的钱归谁 | P |
| V-R8 | 命运坐牢能否用免罪卡；罚款能否用免费卡 | P |
| V-R9 | 投降流程（拍卖范围、投降者是否变乞丐） | P |
| V-R10 | 四大恶人：雇用后何时移动；间谍偷租金是否存在；被关押释放后的去向 | P |
| V-R11 | 红卡、黑卡实际有效天数；个股停牌是 10 天还是 15 天 | P |
| V-R12 | 大财神附身时住旅馆是否免住宿；死神能否被送神符送走、会不会被其他神挤掉 | P |
| V-R13 | 保险重复投保是覆盖还是累加；航空消失天数 | P |
| V-R14 | 月结冠军和悲情人物有无奖金；点券超过 65535 的行为 | P |
| V-R15 | 默认总资金；受困者能否参加拍卖、能否被选为嫁祸目标 | P |
| V-R16 | 工程车拆房的实际表现；换地卡是否交换地契期限 | P |
| V-R17 | 真人每回合能用几张卡、几个道具 | P |
| V-R18 | 企鹅挖宝与喜从天降的宝物图标和名称对照（截图，只用于核对，不入库） | P |
| V-R19 | 建设公司董事长加盖 1 级还是 2 级；CONSTRUCTION_PICK 能否跳过 | P |

**每条核实结论的回写路径**：先改 `data/tables` 中的数值或 `RuleConfig` 的默认值，再刷新 golden，升 ENGINE_VERSION 的次版本号，最后更新 DEVIATIONS.md 和 VERIFY.md。

---

## 12. 需要用户完成的操作

见 user_actions 字段，概括如下：
1. 从局域网 PC 只读拷贝正版文件，保留 Steam 相对路径，并记录 SHA256。
2. 运行 fingerprint 检查。
3. 查看原版开局设置界面的默认值。
4. （建议）按 V-R 清单在原版里实机核实，并截图小游戏宝物。
5. 对几项默认值拍板。
6. 升级 Node 到 24.21 LTS。
7. 准备部署所需的域名、主机、密钥，并同步 rich4-data。

---

## 13. 风险

见 remaining_risks 字段。最高优先的三项：
- 原版数据的可得性和字段语义，影响台湾图能否按时接入。
- v2.06 与 v3.11 的差异，影响数值基线。
- 帧栈解释器的复杂度，关系到破产、拍卖、时光机等打断路径的正确性。

---

## 14. 对五份领域设计的修订清单

- **engine**
  - 删除 MapData/MapNode 和静态 `MAPS`，改为 `MapDef` + `buildMapIndex` + `createEngine(registry)`。`dataHash` 改为 `dataRef`。
  - `aiProfile` 改为 `aiTraits`；SecretState 增加 `aiSeed`、`timeAnchors`；`turn` 增加 `log`。
  - 删除 `SET_DICE`，改为 `ROLL{dice?}`。新增 `MINIGAME_DECLINE`，删除 `MINIGAME_SKIP`。`SYS_SET_AI_PROFILE` 改名为 `SYS_SET_AI_TRAITS`。`MINIGAME_RESULT` 事件改名为 `MINIGAME_ENDED`。
  - PendingDecision 增加 `budgetKey`；新增 `MENU_LIMIT`。
  - `intOverflow` 默认 saturate，点券同受此开关控制。
  - 数据表目录移到 `data/tables`；股票和节日改从 MapDef 读取；`mini.json` 改为 fixture 的 `test` 和 `test-allkinds`。
  - 电脑座位的 SHOP 面对整副牌堆。
  - 不玩分支固定消耗 2 次随机数。
  - 窗口判定改用 `geom/viewWindow`。
- **data-pipeline**
  - 产物写入 `rich4-data/`，不再写 `src/data/extracted/`。
  - `data/rules/*` 改为 `data/tables/*`；`tools` 统一叫 `items`。
  - TileDef 增加必填 `world`；Lot 和 Company 增加 `world` 锚点。TileKind 的 `gift` 改为 `xicong`。
  - `state.static` 提议作废。
  - 新增 `anchors/constants.json`，覆盖小游戏和 AI 的常量（取代 exeFacts.py）。可选读取 `Panel.mkf` 的 SPR 头部尺寸。
- **minigames-ai**
  - 原版文件目录改为 `original/`，统一用 TS 工具链。
  - DecisionKind 按引擎的 23 种命名。`minigameDecline` 改为 `MINIGAME_DECLINE`；`SET_AI_TRAITS` 改为 `SYS_SET_AI_TRAITS`。
  - 电脑座位遇到小游戏由引擎直接结算。
  - MINIGAME_STARTED 不带票据，观战票据改走 `game:minigameWatch`。
  - AI 超时策略合并到 net 的 `timeoutPolicy`。
- **net**
  - `AiDifficulty` 改为 `SeatAiConfig`；AiContext 换成 §5.11 的定义。
  - MinigameTicket 和 Submission 换成 §5.10 的定义；新增 `game:minigameInput/Frames/Watch` 和 `debug:act`。
  - timing 表改按 timing class 定义，删除 CHOOSE_PATH 和 STOCK_PANEL，新增 budgetKey。
  - 删除 `view/privacy.ts`（改用 EVENT_META）和 `util/prng.ts`。
  - `timeoutPolicy` 默认 'default'。RoomSettings 增加 `minigameSpectate` 和 `allowMinigameDecline`。
  - 新增 DataRegistry、`/api/maps`、`RICH4_DATA_DIR`。
  - `SaveSeat.ai`；存档增加 `mapRef` 和 `tablesHash`。
  - 小游戏的断线和超时结算规则按 §5.10。
- **client**
  - `wsTransport` 和 `localTransport` 改为 `socketTransport`，删除自定义的 ServerMsg/ClientMsg。
  - `EventBatch` 改为 `GameBatchMsg`；`ClientGameState` 改为 `GameView`；viewReducer 就是 `applyPostPatch`。
  - `presentation/timing.ts` 改为 `shared/view/pacing.ts`。
  - MapDef 按 §5.1：无向 links、rect、via、world。RoadPainter 和行走插值支持 via。
  - 决策注册表按 23 种 kind；删除 ForkChooser、MiniGamePickDialog、RemoteDiceDialog。
  - 小游戏的 id、tick、舞台尺寸按 minigames-ai。
  - 竖屏只显示旋转遮罩。
  - 删除 IndexedDB 存档。
  - 聊天限制按 net。
  - 事件名改为 SCREAMING_SNAKE。
  - 定时炸弹倒计时显示按步数递减的 fuse。
  - 角色名文件拆成 `characters.original/alt`。

---

## 15. 关键文件

- <repo>/packages/shared/src/data/maps/types.ts（加 validate.ts、mapIndex.ts、registry.ts、fixtures/testMap.ts）
- <repo>/packages/shared/src/engine/api.ts（加 core/flow.ts、core/ctx.ts、core/postPatch.ts、types/*.ts）
- <repo>/packages/shared/src/net/protocol.ts（加 net/timing.ts、view/project.ts、view/pacing.ts）
- <repo>/apps/server/src/game/GameRunner.ts（加 AiDriver.ts、Deadlines.ts、MinigameReferee.ts、src/data/DataRegistry.ts）
- <repo>/apps/client/src/presentation/EventPlayer.ts（加 ui/decisions/registry.ts、game/board/BoardView.ts、net/socketTransport.ts）
- <repo>/packages/shared/src/minigames/types.ts（加 replay.ts）与 <repo>/packages/shared/src/ai/policy.ts
- <repo>/tools/extract/src/cli.ts（加 map/parseRaw.ts、map/build.ts、exe/locate.ts）


## conflicts_resolved
- **传输层：design_net 用 Socket.IO 4.8 带类型事件（game:batch 等）；design_client 写的是浏览器原生 WebSocket（wsTransport），消息格式为 {t:'events'|'sync'|...}，外加 localTransport 和 Worker** → 统一用 Socket.IO 4.8.4。前端新增 net/socketTransport.ts 包装 socket.io-client，Transport 接口改成按 C2S/S2C 类型化的 request/on。删除 wsTransport、自定义的 ClientMsg/ServerMsg 和 sessionStorage resumeToken。身份和重连沿用 design_net：localStorage 存 token，重连发 room:resume
- **批次格式：design_net 是 {epoch, seq, events, animMs, view, pending[], yourDecision}；design_client 是 {fromVersion, toVersion, events, state, pending(单个)}，同步消息名是 sync/resync** → 采用 GameBatchMsg{epoch, seq, cause, events, animMs, view, pending: PendingView[], yourDecision?, serverNow}。EventPlayer 发现 epoch 不同或 seq≠lastSeq+1 时发 game:resync。批尾以 batch.view 对账。ClientGameState 改为 GameView，PendingDecisionView 拆成公开的 PendingView 和只给本人的 DecisionForYou。原 sync/resync/补发分别对应 game:snapshot、game:resync、game:catchup
- **动画时长预算的文件与命名：shared/view/pacing.ts（estimateAnimMs）和 shared/presentation/timing.ts（batchBudgetMs、EVENT_BUDGET_MS）两套** → 只保留 packages/shared/src/view/pacing.ts，导出 STEP_MS、EVENT_BUDGET_MS（以 SCREAMING_SNAKE 事件名为键，用 satisfies 穷举）和 estimateAnimMs。删除 shared/presentation 目录。决策超时表单独放在 shared/net/timing.ts
- **小游戏 id 三套命名：'balloon'|'fortune'|'penguin'（net/engine）、balloonShoot/fortuneCatch/penguinDig（client）、'penguin'|'balloon'|'xicong'（minigames-ai）；data 的 TileKind 用 'gift' 表示落点码 8** → MinigameId 定为 'penguin'|'balloon'|'xicong'。小游戏归 minigames-ai 领域，而且 fortune 与福神、福运、命运容易混淆。TileKind 相应改成 'penguin'|'balloon'|'xicong'。shared 和 client 下的小游戏目录都按这三个名字建
- **小游戏 tick 与坐标：net 用 tickHz 60；client 用 tickRate 30、虚拟画布 960×540；minigames-ai 用原版定时器周期、640×480** → 按 minigames-ai：每个游戏的 spec.tickMs 企鹅 100、气球 100、喜从天降 50，另有 introTicks、maxTicks；舞台为 640×480 整数坐标。客户端 FixedStepLoop 按 tickMs 推进，渲染用 rAF 插值；气球的点击按最近 tick 归属。MinigameTicket 删掉 tickHz 和 durationTicks
- **小游戏规则：client 设计了炸弹气球、6 tick 冷却、企鹅 6×5 网格与 90 tick 预览、dig 输入、「3 个 15 秒小游戏」和 miniGamePick 决策** → 一律以 minigames-ai 的原版逆向规则为准。玩哪个小游戏由落点码 6/7/8 决定，删除 miniGamePick 决策和 MiniGamePickDialog
- **小游戏消息：client 用 mg.input/mg.frames/mg.submit；net 只有 game:minigameSubmit** → C2S 用 game:minigameInput{sessionId, seq, events} 和 game:minigameSubmit{sessionId, inputs, claimedScore, finalHash, clientElapsedMs}；S2C 用 game:minigameFrames 和 game:minigameWatch（下发观战票据）
- **小游戏断线或超时如何结算：client 说由服务器用 def.ai 跑完；net 说一律 MINIGAME_SKIP；minigames-ai 说已开局的用已上传输入重放，未开局的走不玩分支** → 采用 minigames-ai 的方案，防止玩坏了就断线换 50–69 点券。MinigameBot（原 def.ai）只用于测试和演示
- **电脑座位遇到小游戏：engine 设计是直接结算、不发决策；minigames-ai 设计是统一发决策，由 AI 回答 decline** → controller='ai' 的座位，以及 GameConfig.minigames='skip' 时，引擎直接走不玩分支，不产生决策。controller='human' 的座位（包括托管中、超时的）一律发 MINIGAME 决策，由 AiDriver 或超时逻辑提交 MINIGAME_DECLINE。两条路径的随机数消耗完全相同：score=50+rand15()%20，台词槽=rand15()&1
- **小游戏种子放哪里：engine 放在 PendingDecision.minigame；minigames-ai 放在 secret.minigame，并让 MINIGAME_STARTED 事件带上观战票据** → 种子放在 PendingDecision.minigame（state.pending 从不整体下发）。MINIGAME_STARTED{seat, minigameId} 不带种子。玩家的票据经 DecisionForYou.minigame 下发；观战票据只在 minigameSpectate='live' 时由 MinigameReferee 通过 game:minigameWatch 单独下发
- **小游戏相关的 intent 和事件命名：net 的 MINIGAME_SKIP 是系统 action，minigames-ai 的 minigameDecline 是玩家 intent；引擎事件 MINIGAME_RESULT 与系统 action 同名** → 玩家 intent 定为 MINIGAME_DECLINE，是 MINIGAME 决策唯一允许的客户端 intent，开局后提交会被 Referee 拒绝。系统 action MINIGAME_RESULT{seat, decisionId, score, logHash} 只能由服务器产生。事件改名为 MINIGAME_ENDED{seat, minigameId, mode, score, speechSlot?}。删除 MINIGAME_SKIP
- **不玩小游戏得多少点券：net 写的是 50–70** → 50–69（50+rand%20），与逆向结果一致
- **溢出处理：engine 默认金额 int32 回绕、点券 u16 回绕；minigames-ai 要求点券饱和到 65535** → 统一由 RuleConfig.intOverflow 控制，默认 'saturate'：金额夹在 ±2147483647，点券夹在 0..65535。'wrap' 作为可选的原版行为，登记为 DEV-01。理由：溢出是实现缺陷而非规则，联机长局里出现负资产会破坏物价指数和胜负判定
- **DecisionKind 清单：client 用 camelCase（preRoll、chooseDirection、miniGamePick、remoteDice…）；net 的超时表里有 CHOOSE_PATH、PICK_TARGET、STOCK_PANEL；AI 设计另起了一套名字（PRE_ROLL、FREE_CARD_PROMPT、STEAL_PICK、SLOT_STOP…）** → 以引擎定义的 23 种 SCREAMING_SNAKE 为唯一清单（见 §5.4 表）。删除 CHOOSE_PATH/chooseDirection/ForkChooser（岔路随机，箭头只用来演出结果）、miniGamePick、remoteDice（遥控骰子是 TURN_MENU 里的道具目标 {t:'dice'}），以及 SLOT_STOP、INFO_ACK、LOAN_REMINDER（这些只是事件演出）。AI 的名字对应如下：PRE_ROLL→TURN_MENU，RESEARCH_PICK→RESEARCH，MAGIC_HOUSE_EFFECT→MAGIC_CAST，FREE_CARD_PROMPT→USE_FREE_CARD，SCAPEGOAT_PROMPT→SCAPEGOAT，HAND_FULL_DISCARD→DISCARD_CARD，SHARE_SUBSCRIBE→SUBSCRIBE_SHARES，CONSTRUCTION_TARGET→CONSTRUCTION_PICK，DEATH_TARGET→DEATH_GOD_TARGET，BUILD_FACILITY_TYPE→BUILD_FACILITY 与 FACILITY_TYPE；STEAL_PICK 并入 USE_CARD 的目标 {t:'rob'}。前端决策注册表和 AI HANDLERS 都用 satisfies 覆盖全部 23 种
- **掷骰：engine 有单独的非终结 intent SET_DICE；AI 设计要求 ROLL 自带 dice 参数** → 删除 SET_DICE，改为 ROLL{dice?: 1|2|3}。引擎校验 dice 不超过当前交通工具允许的上限，并写回 player.diceCount。DICE_ROLLED 事件带上 diceCount
- **事件命名风格：client 示例用 camelCase（cashChanged、playerMoved、rentPaid…）；engine 用 SCREAMING_SNAKE** → GameEvent、DecisionKind、PlayerIntent、SystemAction 的 type 一律用 SCREAMING_SNAKE；Socket.IO 事件名用 domain:camelCase。前端 handlers、soundMap、EVENT_BUDGET_MS 都以 GameEvent['type'] 为键并穷举。client 示例名按 engine §12.2 改写，例如 playerMoved→MOVE_SEGMENT，rentPaid→TOLL_PAID
- **事件如何携带后置值：client 要求每个事件手写 delta 加绝对值字段；engine 用自动生成的 post: PostPatch** → 采用 engine 方案：emit 时对公开世界做 diff，自动生成 post。客户端的 viewReducer 直接调用 shared 的 applyPostPatch（由 @rich4/shared/view 再导出）。事件本身只带演出需要的参数
- **事件脱敏表：net 用 view/privacy.ts 的 EVENT_PRIVACY；engine 用 EVENT_META.privacy** → 只保留 engine 的 EVENT_META{cat, privacy, resetsView}。projectEvent 按它在私密模式下把非本人的 post.players[].set.cards 改写成 cardCount。删除 privacy.ts
- **地图契约有三版：engine 的 MapData（世界坐标 + adj[4] + blocked[4]）；data 的 MapDef（cell 网格 + 带 slot、blocked、via 的 links + rect）；client 的 MapDef（有向 next/prev + cells）** → 只保留 data 的 MapDef（schemaVersion 1），并补上引擎需要的必填字段：TileDef.world 和各地块、企业的 world 锚点。links 用无向表示，按原版槽号升序排列，blocked 表示从本格出发方向的静态封路，取代 next/prev；地块用 rect 取代 cells；允许 via 连接格和 roadCells，台湾图优先用 --strict4 提取；前端 RoadPainter 支持 via。引擎内部用 buildMapIndex 建邻接、街道、窗口索引。engine 的 MapData/MapNode 删除
- **地图如何交给引擎：engine 用静态 MAPS[mapId]；data 建议在 state 里挂 state.static 引用；而 gitignore 的台湾 JSON 不能被静态 import** → 改为 createEngine(registry: DataRegistry)。state 只存 dataRef{mapId, mapHash, tablesHash}。服务器的 DataRegistry 注册 fixture 地图，再加上从 RICH4_DATA_DIR 读到并复算 sha256、通过 validateMap 的地图。测试用 fixtureRegistry。客户端通过 GET /api/maps/:id?h= 取 MapDef。selectors 显式接收 MapIndex
- **数据哈希：engine 用一个 FNV-1a 64 覆盖数据表和地图；data 对 MapDef 用 sha256** → 分成两个：mapHash 就是 MapDef.meta.dataHash（sha256，由提取工具生成、服务器复算）；tablesHash 为规范化 TABLES 的 FNV-1a 64，在 shared 里同步计算。读档时 mapHash 不符且没有迁移则报 SAVE_INCOMPATIBLE；tablesHash 不符只告警
- **数据表的位置和命名：engine 放在 data/*.ts，另有 data/stocks/taiwan.ts 和 calendar/holidays.ts；data 设计放在 data/rules/*.ts（用 tools 这个名字），提取结果进 src/data/extracted；engine 的测试图是 maps/test/mini.json** → 手录的全局表放 packages/shared/src/data/tables/*.ts，统一用 items 这个名字。按地图区分的股票和节日只存在 MapDef 里，删除 stocks/taiwan.ts 和 holidays.ts，只保留 calendar/lunar.ts。提取产物直接写到 rich4-data/（gitignore），不进 src，避免被误 import。测试地图用 data 设计的 ASCII 生成 fixture（test、test-allkinds），不再要 mini.json
- **原版文件目录：engine 用 /.original/{v2.06,v3.11}，minigames-ai 用 .original/{v206,v311}，data 用 original/{Game,MultiverseJourney}** → 用 original/ 并保留 Steam 的相对路径（Game/ 是 v2.06，MultiverseJourney/ 是 v3.11），版本由指纹识别，不靠人为改名，避免混淆
- **提取工具语言：minigames-ai 写的是 tools/extract/exeFacts.py（python）；data 设计是纯 TS** → 统一用 TS（tsx）写 @rich4/extract。小游戏和 AI 需要核对的常量写进 tools/extract/anchors/constants.json，由 extract verify 读取。r2 只作可选的人工复核，不引入 python 依赖
- **RNG：net 的 util/prng.ts 用 xoshiro 或 mulberry32；engine 用 xoshiro128** 加 rand15；小游戏和 AI 用 Watcom LCG** → util/rng/xoshiro.ts 只给引擎用（状态可序列化，带 purpose 标签和 debugQueue）；util/rng/watcom.ts 给小游戏 sim 和 AI 用，取值分布与原版 rand()%n 一致。删除 mulberry32 和 util/prng.ts。三者互不共享状态
- **AI 配置：net 用 AiDifficulty easy/normal/hard 和 AiContext{difficulty, rng, characterId}；engine 用 aiProfile 和 SYS_SET_AI_PROFILE；AI 设计用 SeatAiConfig、AiTraits 和 SET_AI_TRAITS** → 删除 AiDifficulty。座位配置用 SeatAiConfig{preset: character|gentle|normal|cunning, overrides?}，UI 上标为「按角色（原版）/简单/普通/困难」。PlayerState.aiTraits 由 data/tables/characters.ts 的 resolveTraits 算出。系统 action 为 SYS_SET_AI_TRAITS。消息改为 room:setSeatAi{seat, ai} 和 game:autopilot{on, settings?}。AiContext 采用 AI 设计 §9.1 的定义
- **AI 随机种子：net 说用房间 seed 加座位号初始化独立 Prng；AI 设计说按 (aiSeed, seat, decisionId 或 turnIndex+salt) 派生** → 采用派生方案，并在 SecretState 里加 aiSeed，只有 AiDriver 能读。AI 的决策作为 action 写进 journal，重放时不需要 AI 的 RNG 状态
- **单次决策超时由谁代决：net 默认 timeoutPolicy='ai'；AI 设计担心 AI 替真人借贷、用卡，建议 conservative** → RoomSettings.timeoutPolicy 默认 'default'：单次超时执行 defaultIntent（不买、不用卡、PASS、ROLL）。只有进入托管状态（afk、disconnect、manual、left）后，才由 OriginalAiPolicy 按该座位的 aiTraits 代打
- **卡片和道具的目标范围与 AI 视野：engine 用世界坐标方窗，半宽 220；AI 设计用规范视角 0 的屏幕投影，±220 半开区间** → 只保留一个实现 shared/geom/viewWindow.ts，引擎计算目标候选和 AI 判断视野都调用它。v1 用世界坐标方窗，判定为半开区间；V-E10 提取出投影矩阵后换成投影版，并升 ENGINE_VERSION。targetRange 默认 'window'，可选 'global'
- **单机模式：client 设计了 localTransport + Worker 纯离线；net 设计 v1 走服务器建私密房间** → v1 的 /solo 自动建私密房间：设 timerPreset=off，补 3 个 AI 后直接开局，存档和重连能力全部复用。删除 localTransport 和 local.worker。GameRunner 继续保持无 IO，留给 v2 迁入 Worker
- **单机存档：client 用 IndexedDB（idb-keyval）；net 用服务器存档** → v1 只做服务器存档，另支持 .r4save 导出和导入。去掉 idb-keyval 和 fake-indexeddb 依赖
- **卡片可见性默认值：client 把它列为开放问题** → handVisibility 默认 'public'，还原原版同屏体验；房间可选 'private'。私密模式下，抢夺卡看到的对方手牌只出现在出卡者的 DecisionForYou.options 里，AI 按 AI 设计 §9.9 降级
- **决策超时表：net 按 kind 列（含 CHOOSE_PATH，以及首次打开股市面板加 30 秒的 STOCK_PANEL）；engine 导出 DECISION_TIMING_CLASS** → 超时表改按 timing class 定义，写在 shared/net/timing.ts：menu 30、confirm 15、pick 20、shop 30、bank 20、auction 15、lottery 15 秒，minigame 按票据计算。TURN_MENU 每次非终结操作后会以新 id 重发，靠 budgetKey 继承剩余时间（最少 8 秒，整回合不超过 90 秒）。引擎另外限制每回合最多 40 次非终结操作。删除 STOCK_PANEL 和 CHOOSE_PATH
- **聊天限制：client 定为 100 字、每 2 秒 1 条；net 定为 200 字、每 10 秒 5 条** → 以 net 为准。常量放在 shared/net/limits.ts，前后端引用同一份
- **手机竖屏：client 设计了完整的竖屏布局；用户决策是竖屏只提示旋转** → 对局页竖屏时显示阻断式旋转提示，不做竖屏 HUD。大厅、房间、设置等 DOM 页面竖屏可用。手机横屏沿用紧凑右栏布局
- **原版派生数据如何部署：data 设计要求镜像只含代码和 fixture；net 的 DATA_DIR 用来放 sqlite** → 分两个目录：DATA_DIR=/data 可读写，放 sqlite 和备份；RICH4_DATA_DIR=/data-rich4 只读，放 manifest 和地图，compose 用 ../rich4-data:/data-rich4:ro 挂载。.dockerignore 排除 original/、.cache/、rich4-data/ 以及 extract 源码。缺少台湾数据时服务器只提供 fixture 地图并告警
- **电脑每回合能用几张卡、几个道具：rules_map 和 AI 设计说是硬币二选一；cards 主题说 1 卡加 1 道具；engine 不设限制** → 引擎对任何座位都不设上限。电脑 AI 按硬币 rand&1 在用卡和用道具之间二选一（有指令级证据）。真人的上限待 V-R17 核实，在此之前只靠 MENU_LIMIT 防刷
- **电脑座位进百货公司：engine 统一先抽货架；AI 设计说电脑直接面对整副牌堆** → 采纳 AI 设计。引擎在 SHOP 帧里按 controller 分支：ai 座位直接面对全部剩余卡种，不消耗抽货架的随机数；human 座位（包括托管中的）抽 rand%10+6 张货架
- **存档中座位和数据哈希的字段：net 用 SaveSeat.aiDifficulty 和单一 dataHash** → 改为 SaveSeat.ai?: SeatAiConfig；SaveFileV1 增加 mapRef{id, mapHash} 和 tablesHash。其余沿用 net §8.3（gzip JSON 加 HMAC 签名，导出为 R4S1 文本）
- **定时炸弹倒计时：client 写的是每天减 1；engine 是每走一步 fuse 减 1，初值 38** → 以引擎为准。前端显示 post 里 player.bomb.fuse 的值
- **时光机在联机中的默认模式：engine 列为待定** → RuleConfig.timeMachine 默认 'global'（原版行为）。房间 UI 在有 2 个以上真人时，提示它会回滚他人的操作，并推荐选 disabled。最终默认值请用户拍板
- **默认总资金：300000（有存档实证）与 200000（选项表索引 1）冲突** → 暂定 300000，GameConfig 提供全部 6 档。V-E4/V-R15 核实后如果不同，只改默认值。**更新（2026-09-27）**：D2 在两版 exe 中确认新开局把资金档位下标写为 1，默认值已改为 200000（g_arbitration §2.h、VERIFY V-E4）；300000 推测来自「沿用上局设置」分支，实机确认留给 V-R15

## milestones
### M0 脚手架与测试地图
- 范围: 初始化仓库：npm workspaces、tsconfig.base、Biome、按 project 划分的 vitest、CI。搭 shared 骨架：util/rng（xoshiro 与 watcom）、hash、int32、geom/viewWindow（世界坐标版）。data/maps：MapDef 类型、zod schema、validateMap、buildMapIndex、registry，以及 ASCII fixture 生成器和两张 fixture 地图（test、test-allkinds）。三个守卫脚本：determinism、no-original、deps。建立 docs 骨架：本文件、DEVIATIONS、VERIFY、design/*。
- 交付: 根目录 package.json、tsconfig.base.json、biome.json、vitest.config.ts、.gitignore、.dockerignore、.nvmrc；.github/workflows/ci.yml；packages/shared/src/{util,geom,data/maps}/**；data/maps/fixtures/{ascii.ts,testMap.ts,test-map.json,test-map-allkinds.json}；scripts/{dev.mjs,gen-fixtures.ts,check-determinism.ts,check-no-original.ts,check-deps.ts}；docs/{architecture.md,DEVIATIONS.md,VERIFY.md,design/*.md}；apps/server、apps/client、tools/extract 三个空包的 package.json
- 验证: 1) node -v 不低于 24.9，npm ci 成功。2) npm run typecheck && npm run lint && npm test 全部通过。其中 npx vitest run --project shared src/data/maps 覆盖两项：validate.test.ts 让 fixture 通过校验，并对 25 种变异分别断言命中预期的 issue code；mapIndex.test.ts 从每个格、每个来向计算前进候选，与手算表一致，并包含被封堵的岔路 04→19。3) npx vitest run --project shared src/util 覆盖 xoshiro 与 watcom 固定种子的 golden 序列，以及状态序列化往返。4) 执行 npm run fixtures && git diff --exit-code packages/shared/src/data/maps/fixtures，重新生成后字节一致。5) npx vitest run scripts/__tests__：往 engine 目录的临时副本植入 Math.random，check-determinism 应报错；check-no-original 应拦下 fake.mkf。6) npm run check:deps 通过。

### M1 引擎核心：最小可玩（对应 engine L0–L2）
- 范围: types、Ctx、帧栈解释器 flow、postPatch 自动 diff、ASK；ROOT/TURN/MOVE/LAND 四类帧；随机岔路与静态封路；住宅地的买地、加盖和过路费（同街累加、连锁店）；1 公园和 10–13 点券/卡片格（卡片只抽不用）；其他特殊格先留空 stub；BANKRUPT（暂不拍卖，地产变无主）；DAY 帧的 date、victory、pi、lots 阶段；createEngine、createGame、applyAction、validateState 和 migrate 骨架；engine-testing 子包（builders、scenario、SYS_DEBUG、randomIntent）；shared/ai 的 BasicAiPolicy。
- 交付: packages/shared/src/engine/{api,version,errors}.ts、types/*、core/*、rules/{wealth,toll,purchase,landMutation,payment,counters,inventory,movement,calendar,victory}.ts、flow/{root,turn,move,land,day,ask,toll,pay,bankruptcy}.ts、squares/{index,property,park,points,cardSquare}.ts、decisions/*、selectors、validate、migrate、testing/*；data/tables 中的 economy、setup、cards、characters（带 @source）；ai/{types,basic}.ts；apps/server/scripts/{simulate,bench-engine}.ts 两个脚本的 engine-only 模式
- 验证: 1) npx vitest run --project shared src/engine 全部通过。规则类：rules/toll.test.ts 覆盖同街累加、连锁店，以及 fixture B 街 housePrice 异常；counters.test.ts 断言坐牢 N 天等于 N+1 个不掷骰回合；calendar.test.ts 断言 1998-01-01 是星期四、2 月 31 日永不到期；int32.test.ts 覆盖 saturate 与 wrap 两种模式。场景类：scenario/{buy-upgrade-toll,bankrupt-midmove,fork-random,blocked-fork}.test.ts。一致性与稳定性：postPatch.fold.test.ts 跑 20 个种子 × 300 个 action，断言 fold(applyPostPatch) 与 publicWorld(next) 相同且没有 SYNC；determinism.test.ts；saveRoundtrip.test.ts；invariants.fuzz.test.ts。2) npm run sim -- --engine-only --map test --games 200 --policy random --time-limit 730 输出 finished=200、invariantErrors=0，退出码 0。3) npm run bench:engine -- --map test-allkinds 在本机测得 applyAction p50 小于 5ms、p99 小于 15ms。

### M2 服务端联机骨架（与 M1 并行，先接 stubEngine）
- 范围: shared/net 下的 protocol、schemas、errors、room、timing、limits；shared/view 下的 types、project、pacing（先填初版预算）。apps/server 部分：Fastify + Socket.IO、SessionRegistry、guard 与 rateLimit、RoomManager/Room/RoomBroadcaster、GameRunner、Deadlines（支持 budgetKey）、AiDriver（先用 BasicAiPolicy）、RingBuffer、断线重连与 catchup、托管状态机、DataRegistry（先只有 fixture）、/api/maps、/healthz、/readyz、debug:act（测试模式）。本里程碑先用内存存储。
- 交付: packages/shared/src/net/*、view/*；apps/server/src/**（persistence 除外）；test/helpers/{startTestServer,botClient,manualScheduler,stubEngine}.ts；test/unit/{GameRunner,Deadlines,AiDriver,rateLimit,roomCode}.test.ts、test/property/lobby.test.ts；test/integration/{lobby,full-game-4p,reconnect,anti-cheat}.test.ts；scripts/botplay.ts
- 验证: 1) npx vitest run --project server test/unit test/property 通过。2) 集成测试分别在 RICH4_TEST_ENGINE=stub 与 RICH4_TEST_ENGINE=real（M1 完成后）下各跑一遍 npx vitest run --project server test/integration/{lobby,full-game-4p,reconnect,anti-cheat}.test.ts，全部通过。anti-cheat 会深度扫描全部 S2C 消息，断言其中没有 secret、rng、flow、counters、newsOrder 等键。3) 手动：先 npm run dev:server，再执行 curl -fsS localhost:3000/healthz、curl -fsS localhost:3000/api/maps（返回里应有 test 和 test-allkinds），最后 npx tsx apps/server/scripts/botplay.ts --url http://localhost:3000 --bots 4 --map test，应当一直跑到 game:over，且每个 bot 收到的 seq 连续无缺口。

### M3 前端骨架、等角棋盘与主循环
- 范围: 对应 client 设计的 F0–F2，按本文修订后实施：socketTransport、stores（含 mapStore，通过 /api/maps 加载地图）；大厅、房间、选角、/solo；等角投影与深度排序、GroundLayer 与 RoadPainter（支持 links 和 via）、地块、设施、企业、地标、角色 rig、Camera；EventPlayer 配合 applyPostPatch 和批尾对账；M1 所涉事件的 handler；HUD；决策层中的 TURN_MENU（掷骰加骰子数选择）、BUY_*、UPGRADE_*，以及 GenericChoice、WaitingBanner 和倒计时；横屏布局与竖屏旋转遮罩；testHooks；/dev/gallery 与 /dev/map。
- 交付: apps/client/src/{net,store,game,presentation,ui/{hud,decisions,lobby,screens,system,components,theme},i18n,dev}/**；e2e/playwright.config.ts、e2e/fixtures/room.ts、e2e/specs/{lobby,turn-cycle,timeout-ai}.spec.ts
- 验证: 1) npx vitest run --project client-unit --project client-dom 通过，覆盖以下内容：EventPlayer 的串行播放、倍速、skipAll、断档时发 resync、决策框在动画播完后才出现；viewFold.test.ts 用真实引擎自对弈，断言每个 batch 都满足 fold(applyPostPatch)==batch.view；iso/projection 与深度排序；各决策组件的渲染与 submit；i18n 键完整。2) npm run test:browser：在 Chromium 的真实 WebGL 下加载 test-allkinds 冒烟，无报错。3) npm run test:e2e -- e2e/specs/lobby.spec.ts e2e/specs/turn-cycle.spec.ts e2e/specs/timeout-ai.spec.ts，其中 turn-cycle 断言 4 个页面上 data-testid 标记的现金、存款、点券和地产归属完全一致。4) 手动：npm run dev 后打开 http://localhost:5173，建房、补 3 个电脑、开始，打 10 个回合，检查骰子、行走、买地、升级、过路费的动画与 HUD 数字同步变化；在第二个浏览器用邀请链接观战，画面应一致；DevTools 切到 iPhone 横屏 844×390 能完整操作，切到竖屏出现旋转遮罩；访问 /solo 能一键开局。

### D1 原版数据提取管线与台湾 MapDef（并行轨道，依赖用户拷贝文件）
- 范围: tools/extract 的 E1–E4 与 E6：CLI 与只读守卫、fingerprint、PE 解析、MKF 容器、map raw/diff/build（包含格点检测、via、匈牙利分配、overrides、预览 SVG）、exe tables（签名定位加 xrefTransfer）、verify（与手录的 data/tables 对比）、pack；只有当 MapDat 是压缩格式时才做 LZHUF 解码器。手录的 data/tables 补齐 items、gods、facilities、companies，并加上 @verify 标注。
- 交付: tools/extract/src/**、known-files.json、anchors/{tables,seeds}.json、maps/taiwan.overrides.json、test/{unit,local}/**；本机产物 rich4-data/{manifest.json,maps/taiwan.map.json}（gitignore）、docs/research/provenance-summary.md；VERIFY.md 中 V-F、V-M、V-E1 至 V-E4 的结论
- 验证: 1) CI 无原版文件时：npx vitest run --project extract 通过，覆盖合成的 PE、MKF、地图资源、几何用例、validateMap 以及只读守卫。2) 本机（需要 original/）：npm run extract -- fingerprint 返回 0（未知哈希需加 --allow-unknown，报告标黄）。然后依次执行 npm run extract -- mkf ls --file original/Game/map.mkf；npm run extract -- map raw --map 0 --sources all && npm run extract -- map diff --map 0，若返回 4，由用户选定基线后写入 overrides；npm run extract -- exe tables --edition all；npm run extract -- verify 应返回 0；npm run extract -- map build --map taiwan --preview 应返回 0，报告中台北、新竹、台南三组样本和 103/50/4/3/21 计数全部为 ✅，且恰好有 2 处静态封路。3) 连续执行两次 map build 后 shasum -a 256 rich4-data/maps/taiwan.map.json 结果不变。4) 人工打开 .cache/extract/preview/taiwan.svg 审阅岛屿朝向和路网。5) npm run check:no-original 通过，git status 中不出现任何原版派生文件。

### D2 版本对比与 exe 常量核实
- 范围: E5：以指针表为种子做 funcdiff，radare2 为可选；anchors/constants.json 覆盖新闻、命运、魔法屋、小游戏（M 系列）和 AI（A 系列）的常量；生成 version-diff.md；把结果回写到 data/tables、minigames/*/constants.ts、ai 常量以及 VERIFY.md。
- 交付: tools/extract/src/exe/{funcdiff,r2,strings}.ts、anchors/constants.json、docs/research/version-diff.md；packages/shared/src/minigames/verify/exeFacts.test.ts、ai/verify/*.test.ts；VERIFY.md 中 V-E5 至 V-E10、V-C1 至 V-C3 的结论
- 验证: 1) npm run extract -- exe diff --r2 生成 docs/research/version-diff.md，种子配对率不低于 95%，未配对项逐一列出。2) npm run extract -- verify --constants 返回 0，所有锚点都已解析。3) npx vitest run --project shared src/minigames/verify src/ai/verify 读取 .cache/extract/tables.*.json 做常量对照，全部通过；缺少文件时自动 skip。4) 按 design/minigames-ai.md §11 的清单人工复核，例如 r2 -q -c 'pd 6 @ 0x41378d' original/MultiverseJourney/RICH4.EXE 以确认 30% 炸弹预警。5) VERIFY.md 中所有 V-E 和 V-C 条目都有 ✅，或有 ❌ 加处理结论。

### M4 经济系统：引擎 L3、AI 经济决策与前端面板
- 范围: 引擎部分：银行（ATM、柜台、贷款到期、特别融资、利息、储备金缺口）、股市（tick、交易、额度、董事长、分红）、乐透、百货与商店（电脑座位面对整副牌堆）、企业格收费与认购、设施（旅馆、购物中心、加油站、研究所）、保险、月结。AI 部分（AI2）：买地、盖房、设施、银行、ATM、商店、乐透、认购、建设公司、研究所、手牌满时弃牌。前端部分：BankDialog、StockPanel、ShopDialog、LotteryDialog、ResearchDialog、SubscribeDialog、FacilityBuildDialog 以及月结弹窗。
- 交付: engine/rules/{stock,lottery,facilityFee,companyFee}.ts、flow/{bank,shop,fee}.ts、squares/{bank,shop,lottery,facility,company}.ts、day.ts 中补齐的 market、holiday、d15、month 阶段；ai/{view,rng,policy,stock}.ts、ai/decisions/*；client 端上述面板与对应 handler；e2e/specs/bank-stock.spec.ts
- 验证: 1) npx vitest run --project shared src/engine -t 'bank|loan|stock|dividend|lottery|shop|company|facility|insurance|monthly' 通过，其中包含以下场景：bank.pass-atm-resume-move、loan.due-forced-repay、dividend.negative-bankrupt、lottery.no-winner-carryover、stock.limit-up-cannot-buy。2) npx vitest run --project shared src/ai -t 'buyLand|bank|shop|lottery|bail|subscribe' 通过，覆盖买地保留额在 PI=1/3、资金 30 万/1 万时的边界，以及商店 460 点券买不到汽车、461 点券能买到。3) npm run sim -- --map test-allkinds --games 200 --policy original --time-limit 365 输出 finished=200、rejects=0、invariantErrors=0。4) npx vitest run --project client-dom -t 'BankDialog|StockPanel|ShopDialog|LotteryDialog' 通过。5) npm run test:e2e -- e2e/specs/bank-stock.spec.ts：用 debug:act 传送到银行，完成存取款、贷款和买卖股票后，4 个页面的数值一致。

### M5 持久化、存档读档、社交与观战
- 范围: persistence 部分：node:sqlite，WAL 模式，journal 加每 25 步一次快照，优雅停机，启动时恢复房间；存档读档，包括入座认领、.r4save 的导出与导入、HMAC 签名。社交与观战：聊天（敏感词过滤、频道）、表情、观战者、托管对话框（TrusteeSettings 通过 SYS_SET_AI_TRAITS 写入）。前端：ChatPanel、EmotePicker、SpectatorList、SaveLoadMenu、ReconnectOverlay、系统菜单。
- 交付: apps/server/src/persistence/*、http/saves.ts、handlers/{saves,chat}.ts、rooms/ChatLog.ts；shared/save/{format,migrate}.ts；test/integration/{save-load,restart-recovery,spectator-chat}.test.ts、test/unit/codec.test.ts；client/ui/{social,system}/**；e2e/specs/{reconnect,chat-spectate,save-load}.spec.ts
- 验证: 1) npx vitest run --project server test/integration/save-load.test.ts test/integration/restart-recovery.test.ts test/integration/spectator-chat.test.ts test/unit/codec.test.ts 通过。其中 restart-recovery 覆盖两种情况：正常关闭后重启，以及跳过刷盘、只靠 journal 重放；两种情况下状态哈希都一致，且 epoch 加 1。2) npm run test:e2e -- e2e/specs/reconnect.spec.ts e2e/specs/chat-spectate.spec.ts e2e/specs/save-load.spec.ts 通过。3) 手动：对局进行中对 dev server 执行 kill -9，然后重启，各页面应自动重连拿到快照，最多丢失最后 1 个 action；房主导出 .r4save，新建房间后导入并读档，玩家按 token 自动入座；用篡改过的文件导入时，大厅显示「非官方存档」。

### M6 对抗系统：卡片、道具、神明、关押，以及 AI 用卡用道具
- 范围: 引擎 L4：30 张卡片（包括被动卡链路：免罪、嫁祸、免费、复仇）、13 种道具与路面物件（路障、地雷、定时炸弹的转移与爆炸、飞弹、核弹、传送机、工程车、机器娃娃）、13 种神明（发威、显灵、搭档重生）、CONFINE 与保释、乞丐、BAIL 决策。AI3：PRE_ROLL 的硬币选择、30 张卡和 13 种道具的使用判据、骰子策略。前端 F3：FxSystem、TargetPicker（带 DOM 候选列表）、InventoryPanel、PassiveCardDialog、BailDialog，以及神明和状态的外观。
- 交付: engine/effects/{cards,items,gods}/**、effects/objects.ts、flow/confine.ts、decisions/targets.ts；ai/{preRoll,cards,items}.ts；client/game/fx/**、ui/panels/InventoryPanel.tsx、ui/decisions/{TargetPicker,PassiveCardDialog,BailDialog}.tsx；e2e/specs/cards.spec.ts
- 验证: 1) npx vitest run --project shared src/engine/effects 通过，按 design/engine.md §10.2 和 §10.4 的表逐行测试，每项至少 1 个用例；同时通过以下场景：passive.frame-scapegoat-4days、passive.revenge、bomb.transfer-then-explode、missile.window、god.displace-partner-respawn、jail.two-phase-release。2) npx vitest run --project shared src/ai -t 'cards|items|preRoll|dice' 与 src/ai/fuzz.legality.test.ts 通过：OriginalAiPolicy 的输出 100% 合法，单次决策 p99 小于 5ms，访问 secret 时抛错。3) npm run sim -- --map test-allkinds --games 500 --policy original 输出 rejects=0、invariantErrors=0。4) npm run test:browser -- -t gallery 截图基线稳定。5) npm run test:e2e -- e2e/specs/cards.spec.ts：用 debug:act 发卡，通过 DOM 候选列表选择目标并出卡，结果在 4 个页面上一致。

### M7 事件与收尾规则：新闻、命运、魔法屋、四大恶人、拍卖、投降、时光机、公布栏
- 范围: 引擎 L5：新闻 36 条、命运 37 条（含加持判定）、魔法屋（12 种条件 × 12 种效果）、四大恶人及其雇用、并发拍卖（到达顺序处理、PASS 被新出价重置）、破产清算时的拍卖、投降与死神、时光机（global、perSeat、disabled）、公布栏、节日与农历。AI4：股票买卖打分、公布栏、拍卖心理价位、魔法屋、保释。前端 F4：NewsPopup、FatePopup、MagicHouseDialog、AuctionDialog、BirthdayPickDialog、LotteryDrawPopup；收到 TIME_REWOUND 时执行 reset。服务端：拍卖决策按人独立计时。
- 交付: engine/effects/{news,fate,magic,villains}/**、effects/timeMachine.ts、flow/{auction,surrender,villain}.ts；data/tables/{news,fate,magic}.ts、calendar/lunar.ts；ai/decisions/{auction,board,magic}.ts；client/ui/popups/**、decisions/{AuctionDialog,MagicHouseDialog,BirthdayPickDialog}.tsx；server/test/integration/auction.test.ts；.github/workflows/nightly.yml
- 验证: 1) npx vitest run --project shared src/engine -t 'news|fate|magic|villain|beggar|auction|surrender|deathGod|timeMachine|noticeBoard' 通过：新闻、命运、魔法屋逐条都有用例；auction.concurrent；timeMachine.global 断言 rng 不回退、决策 id 单调递增，且产生 TIME_REWOUND 加 SYNC。2) npx vitest run --project server test/integration/auction.test.ts：4 个 bot 同时出价，各自独立计时，落后的请求收到 STALE_DECISION。3) client-unit 中的 viewFold 覆盖 TIME_REWOUND 的 reset 路径。4) 夜间任务 npm run sim -- --map test-allkinds --games 1000 --workers 8 --policy original：限时局全部结束，无限局（上限 20 年）结束率不低于 95%，rejects=0；用同一 seed 跑两次，finalHash 与 journalHash 都相同。

### M8 三个原版小游戏
- 范围: MG1–MG3：shared 下 penguin、balloon、xicong 三个 sim，以及 replay、validate、golden、bot；引擎的 MINIGAME 决策与不玩分支；服务端 MinigameReferee（实时输入流、game:minigameWatch/Frames、断线结算、decline 窗口）；客户端 MiniGameHost（FixedStepLoop、InputRecorder、最近 tick 归属、观战缓冲）与三个游戏的 View、Input、Hud，同时适配手机横屏。
- 交付: packages/shared/src/minigames/**（包括 __golden__）；engine/squares/minigame.ts；apps/server/src/game/MinigameReferee.ts、handlers/minigame.ts、test/unit/MinigameReferee.test.ts；apps/client/src/minigames/**；e2e/specs/minigame.spec.ts
- 验证: 1) npx vitest run --project shared src/minigames 通过，包括规则单测、每游戏 10 组 golden、fast-check 的合法与非法日志测试，以及 bot 在 1000 个种子下都能在 maxTicks 内结束。2) npm run test:browser -- -t crossEngine 分别在 client-browser 的 chromium、webkit、firefox 三个 project 上运行，golden 哈希与 node 下的结果一致。3) npx vitest run --project server test/unit/MinigameReferee.test.ts 通过，覆盖：伪造分数时以服务器重放为准；来自未来的 tick 被拒；中途断线按已收到的输入结算；从未开局而到期时走 decline；开局后再发 decline 被拒。4) npm run test:e2e -- e2e/specs/minigame.spec.ts：用 debug 强制落在 6/7/8 号格并注入输入，服务器结算的点券与客户端显示一致，观战者能收到输入帧。5) 手动：在桌面和手机横屏上各玩一遍三个小游戏，另开一个浏览器实时观战，延迟应小于 1 秒。

### M9 接入台湾图并对照原版核实
- 范围: 服务端 DataRegistry 从 RICH4_DATA_DIR 加载台湾图；taiwan 相关的本地测试与 golden 重放；在台湾图上跑 AI 自对弈；前端渲染台湾几何（包括 via），必要时微调 overrides；按 VERIFY.md 的 V-R 清单结合用户实机结果回写 RuleConfig 默认值和数据表；更新 DEVIATIONS.md；把股票和公司名等文案接入 i18n。
- 交付: packages/shared/src/data/maps/taiwan.local.test.ts、engine/golden/taiwan.test.ts；tools/extract/maps/taiwan.overrides.json 定稿；docs/VERIFY.md 中 V-R 条目的状态；docs/DEVIATIONS.md 定稿；rich4-data/ 本机数据包
- 验证: 1) npm run extract -- all && npm run extract -- pack --out rich4-data/ 返回 0。2) RICH4_DATA_DIR=./rich4-data npx vitest run --project shared -t taiwan 通过：validateMap 无 error、计数正确、三组样本正确、有 2 处封路，golden 事件序列快照稳定；未提供数据时这些测试自动 skip。3) RICH4_DATA_DIR=./rich4-data npm run sim -- --map taiwan --games 1000 --workers 8 --policy original 输出 rejects=0，结束率达标。4) 手动：RICH4_DATA_DIR=./rich4-data npm run dev，选台湾图开局，对照 .cache/extract/preview/taiwan.svg 和原版截图，检查朝向、路网、地块和企业位置。5) VERIFY.md 中每个 V-R 条目都有结论，或已明确标为「按默认 ⚑ 保留」。

### M10 体验打磨：美术、音频、横屏、完整 E2E 与性能
- 范围: 程序化美术迭代：建筑等级外观、12 个角色的 rig、神明、NPC；AudioEngine、BGM 与 SFX 素材登记、ZzFX 预设、角色咕哝音；手机横屏细节，包括 safe-area、捏合缩放、44px 触控目标；三档画质与自动选档；WebGL 上下文丢失后重建；Credits 页面；角色名 original/alt 切换；性能与首屏包体积预算；完整 E2E 与视觉回归。
- 交付: apps/client/src/game/procedural/**、audio/**、assets/credits.json、scripts/check-credits.ts；i18n/locales/zh-CN/characters.{original,alt}.json；e2e/specs/{solo-soak,mobile-layout,visual}.spec.ts；scripts/check-bundle.ts
- 验证: 1) 在 mcr.microsoft.com/playwright:v1.63.0-noble 容器中执行 npm run test:e2e，全部 12 个 spec 通过，visual 基线稳定。2) npm -w @rich4/client run build && npm run check:bundle：首屏 JS gzip 后不超过 450KB。3) npm -w @rich4/client run check:credits 通过，每个素材都已登记且许可证在白名单内。4) npm run test:e2e -- e2e/specs/mobile-layout.spec.ts：iPhone 15 横屏时主要按钮可见且可点，竖屏时出现旋转遮罩。5) 手动：在 iOS Safari 和 Android Chrome 真机横屏各打一整局，覆盖音频解锁、切到后台再回来触发 resync、捏合缩放；用 VITE_NAMESET=alt 构建后角色名全部替换；打开 ?bench=1 自动对局 60 秒，帧时间 p95 小于 20ms。

### M11 Docker 部署与上线
- 范围: Dockerfile（node:24-slim 三阶段构建）、.dockerignore、deploy/docker-compose.yml（app 加 caddy；/data 读写，/data-rich4 只读）、Caddyfile、nginx 示例配置、.env.example；每日备份；优雅停机；压测；上线检查清单（HMAC 密钥、ADMIN_TOKEN、TRUST_PROXY、域名与证书）。
- 交付: Dockerfile、.dockerignore、deploy/{docker-compose.yml,Caddyfile,nginx.conf.example,.env.example}；apps/server/scripts/loadtest.ts；docs/deploy.md（数据包 rsync 流程与运维说明）
- 验证: 1) docker build -t rich4:local . 成功。执行 docker run --rm rich4:local sh -c 'find / -xdev \( -iname "*.mkf" -o -iname "rich4.exe" -o -name "taiwan.map.json" \) 2>/dev/null | wc -l'，输出应为 0，确认镜像里没有任何原版派生数据。2) cp deploy/.env.example deploy/.env 并填好密钥，执行 docker compose -f deploy/docker-compose.yml up -d；然后 curl -kfsS https://localhost/healthz 和 https://localhost/readyz 都返回 200，curl -kfsS https://localhost/api/maps 的结果里有 taiwan。3) E2E_BASE_URL=https://localhost npm run test:e2e -- e2e/specs/turn-cycle.spec.ts e2e/specs/reconnect.spec.ts 通过。4) 对局进行中执行 docker compose -f deploy/docker-compose.yml restart app，客户端能自动恢复（epoch 加 1，玩家重连后对局继续）。5) npm run loadtest -- --url https://localhost --rooms 200：/admin/stats 中事件循环延迟 p99 小于 50ms。6) 运行满 24 小时后，/data/backup/ 下出现 rich4-YYYYMMDD.db。


## user_actions
- 在装有 Steam 版大富翁4（appid 2059810）的 Windows PC 上找到安装根目录：Steam 库中右键游戏，选「管理 → 浏览本地文件」。然后在 PowerShell 里执行：Get-ChildItem <根目录> -Recurse -File -Include *.exe,*.mkf | Get-FileHash -Algorithm SHA256，把输出发给我们。
- 以只读方式拷贝文件到本机 <repo>/original/，保留相对路径。必需：Game/RICH4.EXE、Game/map.mkf、Game/MapDat.mkf（原名可能是 MAPDAT.MKF，只要存在就必须拷，它是 v2.06 实际读取的地图）、MultiverseJourney/RICH4.EXE、MultiverseJourney/map.mkf。可选：MultiverseJourney/Data.mkf，用于解码器自检；Panel.mkf，只读取气球精灵的头部尺寸。不要拷：Speaking、Effect、help、jump 等素材 mkf，以及 Media/、DxWnd/、*.avi、*.mid、SAVE*.DAT。传输可以用 SMB 只读共享、scp 或 exFAT U 盘。
- M0 完成后，在本机运行 npm run extract -- fingerprint。如果提示哈希未知，确认是否加 --allow-unknown 继续。
- 在原版 v2.06 的开局设置界面记下默认的总资金、游戏时间和胜利条件，告诉我们。这用来裁决总资金默认值是 300000 还是 200000。
- 可选，但强烈建议：按 docs/VERIFY.md 的 V-R1 至 V-R19 在原版 v2.06 里实际操作并记录结果，或者提供对应时点的 SAVE*.DAT，由导入工具来比对。另外请截图企鹅挖宝和喜从天降的宝物图标，只用来对照名称，不入库。
- 需要你拍板的默认项：1) 如果 v2.06 与 v3.11 的台湾图或数值不一致（提取器会以 exit 4 退出），以哪一版为默认；2) 多真人房间里时光机的默认模式（global、perSeat 或 disabled）；3) 股票和公司是否沿用真实名称，还是默认改为虚构名；4) 提取出的 MapDef 能否在私有仓库入库（开关 RICH4_ALLOW_EXTRACTED_COMMIT）；5) 审阅 .cache/extract/preview/taiwan.svg，确认台湾岛在等角视图中的朝向。
- 建议把本机 Node 升级到 24.21 LTS 或更高（例如 nvm install 24），这样 node:sqlite 不再输出实验性警告。
- 部署前请准备：域名与 DNS 解析、一台装好 Docker 的云主机（如果用中国大陆主机，需要先办 ICP 备案）；用 openssl rand -base64 48 生成 SAVE_HMAC_SECRET，连同 ADMIN_TOKEN 写入 deploy/.env；把本机的 rich4-data/ 用 rsync 同步到服务器。original/ 目录绝对不要上传。

## remaining_risks
- 原版数据可能拿不全：Steam 包里可能没有 MapDat.mkf，或者它是压缩的；住宅地价与房价的偏移、企业 assetValue、封路位、facing、节日表布局都还没解明。结果可能是台湾图接入推迟，或者数值不准。缓解：引擎、服务器、前端全部先在 fixture 上推进，台湾图放到 M9 接入；提取器用三组样本和计数做验收；LZHUF 解码器留作 E6，需要时再做。
- v2.06 与 v3.11 可能有差异：逆向数值大多来自 v3.11，一旦发现差异，需要用户选定基线，并可能连带修改多处常量、golden 和 ENGINE_VERSION。
- 一些规则证据不足，只能先按默认值实现（标 ⚑），包括四大恶人的细节、航空和保险转盘、魔法屋与被动卡的交互、间谍偷租金、红黑卡天数、节日。这些都做成了数据或开关，改起来成本低，但会刷新 golden，也会让旧存档在同一版本号下的重放结果发生变化。
- 引擎用帧栈解释器实现，破产打断、并发拍卖、时光机这类中断和展开逻辑复杂，容易留下孤儿帧或死循环。缓解：validateState 检查 pending 与 frame 的对应关系；run 循环设守卫上限；fuzz 会在任意 pending 处存档再读档继续；夜间跑 1000 局。
- post 自动 diff 依赖「先改状态再 emit」的纪律；每次 action 都要 structuredClone 100–200KB 的 state，时光机锚点还会让体积翻倍。缓解：开发期出现 SYNC 就告警；引擎和客户端两侧都有 fold 一致性测试；模拟脚本用 applyInPlace；以后可以换成结构共享。
- 几何嵌入：台湾图如果有较多对角边、长边或同格节点，就需要大量 override；而等角深度排序依赖「矩形占地 + 4 邻接」的前提，via 连接格可能带来遮挡瑕疵。
- v1 的视野和目标范围用世界坐标方窗近似原版的屏幕投影，可选目标和 AI 行为会与原版有细微差别；等 V-E10 拿到投影表后替换，会改变 golden。
- 小游戏：有几处细节只有单一来源的反汇编读法（静止时能否接住、DDA 取整方式等）；种子下发给客户端，懂技术的玩家可以离线预演出最优输入；live 观战会把企鹅布局泄露给围观者。奖励只是点券，影响有限；比赛房间可以把观战设为 replay。
- AI 规则面很大，而且依赖 GameView 暴露足够多的公开字段，一旦漏字段，AI 规则就会退化，还存在活锁风险。缓解：通过 AiView 适配层集中访问；非法 intent 回退到 defaultIntent；fuzz 要求 100% 合法；自对弈时做活性检测。
- 联机体验上有两处争议点：时光机会回滚其他真人的操作；并发拍卖中网络抖动会频繁触发 STALE_DECISION。缓解：房间设置加警告；客户端收到 STALE 后自动刷新决策。
- 工具链都是新大版本：TypeScript 7 原生编译器、Vitest 5、Vite 8、Biome 2；node:sqlite 在 Node 24.9 上仍是实验特性。缓解：锁定精确版本，必要时退回 TS 6 或 Vitest 4.1，并建议升级到 Node 24.21 LTS。
- 法律：沿用原作 12 个角色名（这是用户的决定，可经 i18n 一键改名），带有「大富翁」字样；MapDef（地名、价格、坐标）会下发到公网所有玩家的浏览器，等于分发了从原作派生的事实数据；股票里的真实公司名有商标风险。对外发布前需要评估。
- 有意偏差可能被原版玩家认为不忠实，例如溢出默认饱和、单次超时保守代决、xoshiro RNG。需要在 DEVIATIONS.md 和房间设置里写清楚，并提供开关。
- 程序化美术的观感和工期不确定；音频在不同平台上表现不一（iOS 需要手势解锁、切后台会暂停）；手机横屏只有约 390px 高，对话框容易拥挤，低端机也可能跑不动。
- 部署合规：在中国大陆需要 ICP 备案；公开聊天属于用户生成内容，有合规要求；部分企业网络会拦截 WebSocket，目前靠长轮询降级。

---

## 16. M0/D1 之后的补充裁决（2026-09-27）

1. **gate 与 hold 的命名**：`MapIndex.jailGate/hospitalGate` 指落点码 4/5 的**保释格**；`jailHold/hospitalHold` 指 type 8002/8001 的**关押格**（landmark.holdTile）。engine.md §14（行 1214）与 g_map.md 把关押格叫 gate 的写法作废，引擎实现以本条为准。
2. **企业的远端前沿格**：同一企业的前沿格若为落点码 14/15（银行格、百货格），允许不与建筑矩形相邻（原版大宇百貨的两个百货格 8、15 分处台湾南北）。validateMap 规则改为：企业至少有一个前沿格与矩形相邻即可，其余不相邻的前沿格报 `W_COMPANY_REMOTE_FRONT`（warn）。
3. **分层**：shared/data 允许依赖 shared/geom（MapIndex.lotsInWindow 复用唯一的窗口判定实现）。
4. **格点**：台湾图实测 T=48（拟合），不是 32；world 坐标 x 向东、y 向南（医院/澎湖在西，绿岛在东南）。前端等角视图应支持 4 个方向旋转（原版可 8 向旋转），默认方向在 M3/M9 对照原版截图确定。
5. **台湾图 stocks/holidays**：由 D2 从 exe 股票模板表（v2.06 VA 0x47CE92；v3.11 VA 0x47F072，每项 36 字节 × 12 × 地图数）与节日表抽取后填入 MapDef；在此之前 DataRegistry 对 `manifest.pending` 中列出的缺项放行，但禁止用该图开局。

## 17. M1/M2/D2/M3a 实施记录（2026-09-27）

实际实现与本文件、design/*.md 不一致之处及原因。本节之后以代码和本节为准；未列出的部分按设计实现。标 ⚑ 的是缺证据时的暂定默认，结论见 VERIFY.md。

### 17.1 契约层（shared 类型，M1/M2 的前置）

- **分层迫使的放置**：MinigameId、MinigameParams、AiTraits、AiPreset、SeatAiConfig、Personality 定义在 `data/tables/ids.ts`（engine 不能依赖 ai/minigames，而 `resolveTraits` 在 data/tables）；`minigames/types.ts` 只能依赖 util，另有一份 MinigameId/MinigameParams，由类型测试保证一致。SeatControl 放在 `view/types.ts`，net 再导出。
- **泛型代替跨层引用**：`DecisionForYou<K, Ticket>`（view 不能依赖 minigames），net 的 `YourDecision = DecisionForYou<DecisionKind, MinigameTicket>`，不按 kind 展开，收窄用 `asAnyDecision`/`isDecisionForYouOf`；`SaveFileV1<TRoomSettings, TChatMessage>`（save 与 net 互不依赖）。
- **state 里只用 null**：凡进入 state 的可选字段改为必填 `| null`（`PendingDecision.budgetKey/minigame`、`publicInfo.lot/amount/labelKey`；`secret.timeAnchors` 必填，非 perSeat 时为 `[]`）。唯一例外是 `ROLL.dice` 与 `EventBase.post`。
- **Intent 与事件**：PlayerIntent 按 type 拆成独立成员（否则 `Extract` 得到 never），zod 一律 strictObject。Party 统一为带标签对象 `{t:'seat'|'company'|'pool'|'bank'}`。`FACILITY_BUILT` 的载荷字段 `type` 改名 `facility`（与判别字段冲突）；`HOLIDAY` 不带 cards，圣诞送卡改发 `CARD_GAINED{source:'holiday'}`；redactCards 类事件固定为 CARD_GAINED/CARD_LOST/SHOP_TRADE/CHAIRMAN_GIFT，载荷为 `seat + card: CardId|null`；新增 `AI_TRAITS_CHANGED`、`DEBUG_APPLIED`（系统 action 改公开状态必须有事件公布，否则触发 SYNC）与 `POINTS_GAINED`（点券格、宝箱）；CONTROLLER_CHANGED、SYNC 归入 cat `'system'`。
- **决策 options**：RESEARCH 不带 cost（调研结论：研发不收费）；MINIGAME 为 `{minigameId, maxScore}`，是否允许放弃由服务器按房间设置处理。`TurnMenuOptions` 增加 `menuActions`，估值上限用数组 `lotCaps`。
- **默认总资金 200000**：exe 默认档位下标为 1（VERIFY V-E4、g_arbitration §2.h），§5.3 与 engine.md 已同步。
- **validateMap**：`W_COMPANY_REMOTE_FRONT` 只对落点码 14/15 生效，且要求该企业至少一个前沿格与建筑相邻，其余不相邻前沿格仍报 `E_LOT_FRONT_NOT_ADJ`（§16.2 的完整含义）。
- **net**：SystemMsgKey 用 camelCase（`playerJoined`）；`game:minigameWatch` 载荷为 `{ticket, mode, log}`；`room:assignSeat` v1 不实现；ErrorCode 增加 `MAP_UNAVAILABLE`、`GAME_OVER`；EngineRule 为已知码加开放字符串。

### 17.2 M1 引擎（engine L0–L2）

- ⚑ **坐牢释放回合**（V-R1）：按 M1 验证清单实现为「N 个受阻回合 + 1 个走回棋盘、不掷骰的回合（RETURNED）」。g_arbitration §3.3 引 MY/NU 认为释放当回合照常行动，两者冲突，待实机。
- ⚑ **跳伞**（V-R2）：落地后不结算落点，随即照常进入回合菜单。⚑ 停留卡走 0 步时照常结算落点（按 engine.md；OA 认为不重复触发）。
- ⚑ **满手**（V-R5）：`handFull='choose'` 在 M6 之前退回 autoCheapest，DISCARD_CARD 决策留给 M6。
- **noHumansLeft 只在本局有真人座位时触发**：全电脑局（模拟、自对弈）否则第一次破产就结束。
- **TOLL_PAID.amount 为实付金额**：付款人破产时小于报价，随后依次发 BANKRUPT、LIQUIDATION、BECAME_BEGGAR。
- **EngineApi 扩充（原签名不变）**：`createEngine(reg, {devChecks?})`，开启后 deepFreeze 入参、出现 SYNC 抛 `EngineInvariantError('UNANNOUNCED_CHANGE')`（服务器在 RICH4_TEST_MODE 下开启）；internal 增加 `createGameWithEvents`、`explainState`、`checkInvariants`。DebugOp.teleport 增加可选 `prev`（决定之后的前进方向）。EngineRule 增加 BAD_CONFIG、BAD_FORCED_VALUE、BAD_STATE、BAD_STATE_VERSION。
- **随机序列**：TURN 开始即刷新本人股票可买量（每支流通股 > 1000 的股票消耗一次 `'quota'`）；神明、礼物、宝箱的开局摆放留到 M6，届时随机序列与 golden 都会变。
- **阶段位置**：`marketOpen` 暂在 DAY 的 `'date'` 阶段计算，M4 实现停市倒数后挪到 `'market'`。
- **其他**：`selectors.streetLots(map, lot)` 的参数是地块 id（按街道 id 仍用 `MapIndex.streetLots`）；AI 买地保留额（5%、7000）放在 `data/tables/economy`，BasicAiPolicy 与原版 AI 共用；数据表的规范入口是 `@rich4/shared/data`，`@rich4/shared/engine` 原样再导出。

### 17.3 M2 服务端联机骨架

- **计时链**：「首次出现时间」取决策在客户端可见的时刻（now + 动画时长），下限为可见时刻 + 8 秒，动画不占思考时间；90 秒整回合上限随计时档位缩放（fast 45、slow 180）。测试专用 `timerScale` 同时缩放决策超时、链上下限、网络宽限、小游戏倒计时与宽限、恢复与解除托管的最短时间（不缩放小游戏游玩时长），生产为 1。
- **小游戏**：截止时间不受 timerPreset 影响（off 档也有，票据的 deadlineAt 必填）。M8 之前没有裁判：`game:minigameInput/Submit` 返回 `MINIGAME_INVALID{reason:'refereeUnavailable'}`，到期执行 defaultIntent（MINIGAME_DECLINE）。
- **M5 之前的存档事件**：返回明确错误而不是挂起（`room:loadSave`、`saves:delete` → SAVE_NOT_FOUND；`room:claimSeat` → BAD_REQUEST{noLoadedSave}；`game:save` → INTERNAL{persistenceUnavailable}；`saves:list` → []），不新增 ErrorCode。journal 只在内存。
- **房间规则**：房主必须是座位上的真人（`RoomYou` 的观战分支写死 `isHost:false`），没有座位真人时房主为空。AI 连续失败 3 次（或兜底 intent 也被拒）以 `paused.reason='host'` 暂停并发 `aiPaused`（RoomView 只有 host/all_away）。暂停期间 deadlineAt 为 null；断线宽限期内显示 min(截止时间, 断线时间 + 宽限)。
- **输入**：`chat:send` 的 schema 允许 800 字，清洗后截到 200 字（net §9「截断」而非拒绝）；握手 auth 用非 strict 的 `z.object`，其余 C2S 一律 strictObject。
- **依赖与装配**：pino 不是依赖，`infra/logger.ts` 自写 pino 兼容 logger 作为 Fastify 的 loggerInstance；`RICH4_TEST_ENGINE=stub` 时 `src/app.ts` 动态 import `test/helpers` 的 stubEngine 与 localPolicy（默认 real；esbuild 产物也包含这段代码，但只在 stub 模式加载）。

### 17.4 D2 数据（exe 表与台湾 MapDef）

- **节日**：台湾写入 23 条而不是 24 条，停用的 slot 12（10/31，bit7）不输出（原版查找时跳过，放进 MapDef 会让按日期命中第一项得到错误结果），slot 保留原下标。HolidayDef 没有星期字段，kind 2 的星期暂存在 `flagsRaw` 16..23 位（`flagsRaw = flags0 | 事件位<<8 | 星期<<16`，与 fixture 的 flagsRaw 约定不同），closed/giveCard/bgm/lunar 总是显式输出；建议 M4 给 HolidayDef 增加 `weekday`。
- **股票**：名称去掉排版空格；`volatility` 取 f32 的最短十进制，位型另存 `volatilityF32`；数据取自与基线同版本的 exe（台湾用 v2.06），并核对 v3.11 一致。
- **范围**：额外抽取农历表（exe 只覆盖 1998–2020）；`build.ts` 删除已成死代码的 IssueClass `'contract'`；`extract verify` 不带参数时同时跑 `--samples` 与 `--tables`。

### 17.5 M3a 前端工程与渲染基础

- **深度排序**：`max(x+y) + bias` 只对边长 ≤ 2 的矩形 footprint 严格正确（台湾图只有 1×1 与 2×2），更大的地块需要拓扑排序。
- **暂缓项**：默认旋转取方向 0，台湾默认朝向留到 M3/M9 对照截图；建筑遮挡淡化留到接入 EventPlayer。
- **开发便利**：vite serve 专用中间件 `/__dev/maps/:id` 直读本机 rich4-data，不进构建产物；`client-browser` project 只在本机有 Playwright Chromium（或设 `RICH4_BROWSER_TESTS=1`、`RICH4_CHROMIUM_PATH`）时加入。
- **重复定义**：CHARACTER_KEYS 在 `game/procedural/character/defs.ts` 复刻一份并由测试对照 shared；`@rich4/shared/data` 现已导出 tables，可以改为直接引用。

### 17.6 联调修正（M1/M2/D2/M3a 接通）

- **tablesHash**：`data/index.ts` 导出 `data/tables`；`fixtureRegistry` 与服务器 DataRegistry 都按 `TABLES` 计算 tablesHash（此前是空对象的哈希）。`state.dataRef.tablesHash` 与 simulate 的 finalHash 因此变化，对局过程不变（`simulate --map test --games 200 --policy random --time-limit 730` 仍是 217575 个 action，finalHash 由 abdc96bccfa0d444 变为 a9de9b5da078fcd8）。
- **view 入口**：`@rich4/shared/view` 导出 `applyPostPatch`、`foldPosts`、`publicWorld`、`diffPublic`，供前端 viewReducer 使用。
- **测试编排**：根 `vitest.config.ts` 直接内联前端三个 project（定义移到 `apps/client/vitest.projects.ts`，与 `apps/client/vitest.config.ts` 共用），根目录的 `--project client-unit` 等原名可用（Vitest 5 会给容器配置的子 project 加前缀）；新增 `server-real` project，用真实引擎（createEngine + BasicAiPolicy）再跑一遍 server 集成测试，`server` project 仍默认 stubEngine。
- **文档同步**：§5.3、engine.md 的默认总资金；data-pipeline §8.4 的 issue code；minigames-ai §9.10 的 `view.clock.turnNo`；net.md 的 SystemMsgKey 示例；VERIFY 的 V-R1/V-R2/V-R5/V-R15 记下暂定实现。

## 18. M3b/M4/M5/M8a/D2b 实施记录与联调（2026-09-27）

本轮并行完成 M3 第二部分（前端主循环与决策对话框）、M4（经济：引擎、数据、原版 AI）、M5（持久化、存档、社交）、M8 第一部分（三个小游戏 sim）、D2 第二部分（exe 常量与事件表），随后统一联调。以下只列与本文件、design/*.md 不一致的实现与原因；标 ⚑ 的是缺证据时的暂定默认，结论见 VERIFY.md；行为上有意与原版不同的已进 DEVIATIONS.md。

### 18.1 M4 经济（引擎、数据、AI）

- **版本与哈希**：ENGINE_VERSION 0.2.0；TABLES 新增 `facilities`、items 增加 `f7`（AI 凶狠度），tablesHash 因此变化（旧存档读档只告警）；STATE_SCHEMA_VERSION 不变（只在帧与 options 里加字段，zod 为宽松校验）。
- **建设公司**：`constructionChairmanLevels` PROGRAM 2 / MANUAL 1（§7.1 已改；exe 调用两次，g_map §4.3）。目标 = 自己非连锁、未满 5 级的住宅 + 自己已建成、未到上限的设施；`canSkip=false` ⚑（V-R19）；没有目标时收 1000 × PI；工程费按付款方神明修正。
- **住旅馆 / 出国**：住 n 天统一为失去 n 个回合（n=1 也写 0x80；原版写 n−1，n=1 等于不受阻）⚑，见 DEV-13、V-R20。航空出国 n 天 = n 个受阻回合 + 1 个走回棋盘的回合（与 V-R1 坐牢语义一致）。
- **银行**：贷款额度 = netWorth − loan（沿用 BankCounterOptions 定义）；特别融资额度 = 其他在场玩家存款合计 − 已融资额（储备金不变量成立的前提），董事长易主不强制归还 ⚑；挤兑期间 ATM 只能存、柜台不放款 ⚑（r_stocks_time 说仍可存取，冲突，见 V-R21）；星期日休息（`sundayBankClosed`）不新增事件，复用 `BANK_REJECTED{reason:'sunday', days:0}`；月息只给贷款为 0 的玩家（V-E6）。
- **研究所**：停在自己的研究所选与进行中相同的项目保留进度，不同项目作废旧项目（RESEARCH_CANCELLED）⚑（V-R22）。
- **认购与企业收费**：只在企业的地产格（落点码 0）问认购，银行格、百货格（落点码 14/15）走各自服务不问；受主阻碍时不问。付款方神明修正（财神、穷神）对设施与企业收费全部生效（g_arbitration §2.c）；企业收费不适用地主受阻类免收，关押中的董事长照收。
- **乐透**：无人中奖仍发 `LOTTERY_DRAW{winner:null, prize:0}`；无人购票不开奖、不发事件。
- **百货公司**：引擎每笔交易后以新 decisionId 重发 SHOP；`ShopOptions.visit` 记录本次进店的交易，AI 据此推算；每次进店最多 60 笔（`SHOP_TRADE_LIMIT`，防刷）见 DEV-14。
- **日推进**：`marketOpen` 挪到 DAY 的 `'market'` 阶段，全面停市从 1 减到 0 的那天仍休市；d15 分红按座位净额结算（见 §19）；节日判定读 `HolidayDef.weekday`（缺省回退 flagsRaw 16..23 位）。
- **农历**：`data/calendar/lunar.ts` 用通行农历年信息表覆盖 1997..2100（exe 表只到 2020），与 exe 逐日数据对照一致；闰月沿用月号（同名节日会命中两次，与 exe 一致）；2100-02-29 按 03-01 换算。见 DEV-15。
- **AI**：`OriginalAiPolicy`（id `original-v1`）用 satisfies 覆盖 23 种决策、返回前按 options 自检；本期覆盖经济决策，BAIL、拍卖、魔法屋、卡片与道具等委托 BasicAiPolicy（M6/M7）。月均盈余 = 累计盈余 ÷ (trunc(已过天数/30) + 1) ⚑；卖股打分按调研方向简化 ⚑（ai/stock.ts 头注释）；选股稳定排序（DEV-03）；AI 仍不用特別融資（DEV-11）。

### 18.2 M3 第二部分：前端主循环、对话框与面板

- **E2E 前端**用 `vite build && vite preview`（不用 dev server：HMR 整页刷新会让同一 token 建第二条连接，把第一条顶掉）；`app/services.ts` 在 HMR 时整页刷新，保证开发期只有一个 GameClient。
- **演出**：骰子为 DOM 叠层（DiceOverlay），不是 Pixi DiceView；动画时钟由 GameClient 持有（rAF + 200ms 定时器兜底，单次最多推进 1 秒；嵌入式浏览器 rAF 被节流时仍按真实时间走）；PlayerActor.walk 用一条时间线驱动整条路径。
- **EventPlayer**：一批开始播放时先收起上一批留下的决策与等待条；自动跳过的条件为队列 > 5 批或积压 > 15 秒（单独一批很长不跳）。
- **TURN_MENU 分工**：平时由行动区直接掷骰与选骰子数；卡片 / 道具 / 股票 / 公布栏按钮展开回合菜单。非本人回合这些按钮打开 ui/panels 的只读面板（PanelHost）。
- **放置**：DecisionLayer、EventLogPanel 放在 ui/hud（client.md 放在 decisions/、panels/）；昵称存在 `rich4.settings`（不是 `rich4.nickname`）；新增界面文案在 lobby.json、hud.json，事件日志在 events.json。
- **节日文案**：键为 `events:holiday.<mapId>.h<slot>`；台湾 23 条节日名按日期、农历标志推定，10/31、11/12 统一写「纪念日」。
- **对话框**：注册表用按 kind 映射的 satisfies（组件拿到收窄后的 options）；`DecisionProps` 增加泛型 K 与可选 `now`；`submit` 返回 Promise 且解析为 false / `{ok:false}` / reject 时解锁；存取款滑条用原生 range；商店、乐透机选先选中再确认；卡片类别配色是前端映射；多做了 BoardPanel（公布栏）；TileInfoPopover 锚点为视口坐标。
- **测试钩子**：开发模式或 `?anim=instant` / `?test=1` 时暴露 `window.__rich4`（store、eventPlayer、board、renderer、client）。

### 18.3 M5 持久化、存档读档、社交与观战

- **表结构**：`room_journal` 主键改为 (code, epoch, seq)（rematch、读档后 seq 从 0 重新计）；`saves` 增加 `verified` 列（列表页不解码 blob；未验证的导入存档 sig 为空）。快照与 journal 策略在 `persistence/RoomPersister.ts`，另有 SaveService、backup、index、types。
- **重启恢复**：seq 沿用快照 + journal 重放后的值，epoch + 1；进行中的对局一律暂停（原先房主暂停保持 host，否则 all_away，第一个真人回来自动继续）；引擎不可用时保留快照（skipped）；迁移失败、状态校验不过或地图缺失时转为存档 `auto:<code>`。关闭（close / shutdown）时不再发 `room:closed{reason:'server'}`。
- **存档安全**：存档正被进行中的对局使用时，导出与另开房间读档返回 `SAVE_FORBIDDEN{reason:'gameInProgress'}`（存档含 state.secret）。存档在库里是明文 gzip，只签名不加密。
- **读档座位**：owner 优先（可把占座真人让到观战、撤掉电脑）；其余真人先来先得坐进未认领的真人座位，坐不下转观战；存档里是真人、由电脑补上的座位只在服务器层代打（不改 state，读档后状态哈希与存档一致）；存档里是电脑、由真人认领的座位开局后提交 `SYS_SET_CONTROLLER{human}`。读档时房间设置整体取存档，chatTail 不回灌。
- **配置**：生产缺 `SAVE_HMAC_SECRET` 抛 ConfigError，开发用存储 meta 里持久化的随机密钥；`DATA_DIR` 默认 `.cache/data`；新增 `STORE=sqlite|json`、`BACKUP_ENABLED`、`BACKUP_KEEP`；敏感词表为 `DATA_DIR/badwords.txt`。
- **shared/net 补充**：`EMOTE_IDS` / `isEmoteId`、`ChatMessageSchema`、`sanitizeSaveName`、`SYSTEM_MSG_KEYS`（增加 `serverRestored`）、`TrusteeSettings` 类型再导出（前端从 net 取，不依赖 shared/ai）。表情校验在 Room 层（未知 id 返回 `BAD_REQUEST{unknownEmote}`）。

### 18.4 M8 第一部分：三个原版小游戏的确定性 sim

- state 用 `number[]` 等纯 JSON 值（设计稿为 TypedArray）；气球 `speedMode` 编码为 0 正常 / 1 ×2 / 2 ÷2。
- ⚑ 喜从天降：财神行走按「frame 0..4 每拍 12px、frame 5 为决策拍」建模（转折点正好是 170/242/…/530）；进入 ending 时接物者停下、不再判定接住；初始接物者与光标 x = 320、初始 spawnFrame = 0；去掉只增减不读取的 bombs 计数；接到炸弹后等屏上掉落物落完才 over（分数在接到炸弹时冻结）。
- 企鹅：`found[81]` 保留每格首次揭晓的结果；`validateInput` 只查格号 0..80（冰屋、无效格由 sim 忽略）。气球：冻结按伪代码先 `freeze--` 再判断移动（点中 ? 当拍起算实际停 19 step）；无可用跑道时不掷选道 rand（开关 `ROLL_LANE_WHEN_NONE`）；点空只发一次 miss fx。
- Watcom rand 只输出状态的 16..30 位，只差 bit31 的两个种子玩法相同：引擎派发小游戏种子时不要依赖 bit31。

### 18.5 D2 第二部分：exe 常量与事件表

- `HolidayDef.weekday`（kind 2 必填、其他 kind 不带），validateMap 新增 `E_HOLIDAY_FIELD`；台湾 MapDef 重建（dataHash `3c2f31eb…a551`，sha256 `14ef91e8…6c10`）。
- 工具链自写 IA-32 解码器（与 r2 指令边界 0 处不一致）；`anchors/constants.json` 155 个锚点，形状为 `{id, value, v206Value?, desc, loc, v311, v206, confirmed, verify, source}`（与 data-pipeline §6.4 示例不同）；没有 anchors/seeds.json（funcdiff 种子取自已定位的表与辅助函数调用点）；`exe diff --r2` 只用 r2 核对指令边界。
- `docs/research/events-from-exe.md` §4 列出与 r_squares_events.md、engine.md 的 15 条出入（新闻 9、12、15、35；命运加持覆盖 33 条；命运 3、8、9、10、11、32 不加倍；命运 32 与魔法屋 0、8 全价折点券；罚金类命运的保险赔付；电脑借款不另设上限等）：M7 录入 news / fate / magic 表时以它为准。

### 18.6 本轮联调与修复

- **原版 AI 上线**：服务器默认策略改为 `OriginalAiPolicy`（`RICH4_AI_POLICY=basic` 可切回 BasicAiPolicy 对照）；`SeatAiConfig.preset` 经 `resolveTraits` 在开局写入 `aiTraits`（已有），托管设置经 `SYS_SET_AI_TRAITS` 覆盖；AiDriver 的 `makeAiContext` / `makeAiRng` 改为 shared/ai 的同一实现；server-real 集成测试与 E2E 的电脑座位也用原版 AI。
- **测试计时**：`RICH4_TIMER_SCALE`（只在 `RICH4_TEST_MODE=1` 时生效，范围 (0, 1]）缩放 Deadlines.timerScale；生产恒为 1。
- **对话框接通**：`/dev/decisions` 路由与首页入口；进入对局后空闲时预取全部对话框 chunk（避免第一次遇到某种决策时闪「加载中」）；GenericChoice 不再单独拆 chunk。
- **回合菜单**：行动区的卡片 / 道具 / 股票 / 公布栏在本人回合直接打开对应子页（`TurnMenuSheetContext`），经快捷入口打开的子页关闭时整个回合菜单收起。EventPlayer 的「一批开始先收起旧决策」对同一座位重发的同种决策（TURN_MENU / SHOP / AUCTION_BID）例外：旧框保持锁定直到批尾换成新决策，否则每笔股票交易、商店交易后对话框与已打开的子页都会被卸载重建。
- **经济演出**（`presentation/handlers/economy.ts`）：股票成交、认购、分红、乐透购票与开奖横幅、月结横幅、百货交易、企业收费（金币飞向董事长）、住旅馆、贷款到期提醒与强制还款、研发交付、董事长赠礼；金额一律按事件 post 飘字与闪动 HUD。日志：分红逐人列出金额（负数为反扣），状态天数带单位。
- **显示修正**：两段式计数器（坐牢、住院、保险、拒绝往来……）统一显示 (c & 0x7f) + 1（与引擎 displayRemaining 一致；此前保险在待释放状态显示 128 天）；贷款徽标带千分位与到期日；地块名在日志与对话框统一按同名编号（`presentation/lotLabels.ts`）；商店卖道具显示精确卖回价 trunc(标价 × 数量 × 0.9)。
- **首屏分包**：vite 的 game 分组不再递归收依赖（首屏不再静态依赖 game 与 pixi chunk）；`packages/shared` 声明 `"sideEffects": false`（首屏 index 从约 98 KB 降到约 68 KB gzip）。
- **新增测试**：client-dom `ui/decisions/realEngine.dom.test.tsx`（真实引擎 options → 对话框 → intent → 引擎执行）；E2E `bank-stock.spec.ts`（银行存取款、贷款、股票买卖后 4 页面 HUD 与服务器快照一致）；server `test/unit/config.test.ts`。

## 19. 审查修复记录（2026-09-27）

逐条复核审查发现后的修复；与本文件或 design/*.md 的出入以本节为准。

- **分红**（engine.md §11.4 已同步）：按 exe 0x42ba97 改为按座位净额结算——全部公司的应分金额先按座位合计，合计为正进存款、为负先存款后现金扣，扣不出来才破产；应分金额 = `trunc(本月盈余 × f32(持股 / T))`。15 日只发一个 DIVIDENDS（rows 带公司），多名股东同时破产时按座位顺序展开。DAY 帧的 d15 cursor 只区分「分红 / 开奖」两步。
- **买无主设施** = 设施地价 × PI（exe 0x41a86b 不读等级）；此前多算了 等级 × rate0。
- **地契到期** 与破产清算、mutate mode 1 共用 `rules/landMutation.releaseLot`：研究所进行中的研发一并作废，到期时给原业主发 RESEARCH_CANCELLED（新业主不继承旧研发）；mode 0 拆到低于项目等级时研发同样作废。
- **百货公司**：SHOP 帧新增 `fullDeck: boolean | null`，进店时按 controller 定下，离店前不随 SYS_SET_CONTROLLER 变化（旧存档缺字段时回退 controller）。
- **kind 2 节日**：照搬 exe 0x4521f0 的日期公式（w < 当月 1 日星期时落到星期日），台湾图不受影响。
- **ENGINE_VERSION 未升**：以上都是规则修正，按 version.ts 的约定应升次版本；与并行里程碑的版本号一并由合并方决定。服务器重启恢复现在按 major.minor 判断能否重放 journal（`RoomManager.rulesVersion`）。
- **存档**：读档 / 导入解压后 JSON 上限 2MB（`SAVE_DECODE_MAX_JSON_BYTES`），`state.engine` 必须是版本号，GameStateSchema 的公开字符串字段有界；由未验证存档读档开局的对局，其手动 / 自动 / 转存档一律不签名（RoomMetaV1 增加 `sourceVerified`）；存档不写观战者专属聊天；读档后断线宽限夹到 5..120 秒（测试模式除外）；兼容性提示 `SaveSummary.warnings`、`RoomView.loadedSave.warnings` 与 gameLoaded 的 `tablesMismatch` 参数下发；导入不再按 UTF-16 二次截断存档名。
- **房间**：对局中踢人、离开立即写快照（座位归属与 journal 里的 SYS_SET_CONTROLLER 同时落盘）。
- **聊天**：敏感词正则不再转义 '-'（u 模式非法转义曾让服务器无法启动），单个词失败只跳过并记日志；清洗额外去掉软连字符、CGJ、Hangul 填充符等，过滤时另在去掉全部 Default_Ignorable_Code_Point 的比对串上匹配（变体选择符、tag 字符插在词中间也能命中）。
- **前端**：服务器主动断开（停机 / 重启）后按 `reconnectInMs` 自动重连；被顶替时请求立即返回 replaced，首页与单机页也挂接管遮罩；昵称变化且不在对局中时重连让握手带上新昵称；时钟只在连接打开时采样、连上后补采 3 次；决策提交锁同时看 `gameStore.submitting`；toast 各自计时；棋盘卸载时 EventPlayer skipAll、handler 的 board 改为实时取值，动画时钟帧回调互相隔离、rAF 先续订后推进，补间出错必 resolve，PlayerActor / Camera 销毁后不再写 Pixi 对象。
- **E2E**：夹具 URL 加 `?test=1`（生产构建也开批尾对账，不一致走 console.error 判失败）；新增 `anim-unmount.spec.ts`（不带 anim=instant，行走中后退 / 前进）。


## 20. M6 / M8 第二部分实施记录与整合实测（2026-09-27）

本轮并行完成 M6「对抗系统」（引擎 L4 + 原版 AI 的卡片 / 道具 / 被动卡判据，ENGINE_VERSION 0.3.0）、M6/M7 事件的前端演出（F3/F4）、M8 第二部分（小游戏引擎决策、服务端裁判、前端宿主）与 M5 的前端（聊天、观战、存档、托管、断线），随后统一接通、修复与实机测试。以下只列与本文件、design/*.md 不一致的实现与原因；标 ⚑ 的是缺证据时的暂定默认，结论见 VERIFY.md；行为上有意与原版不同的已进 DEVIATIONS.md。

### 20.1 契约变更

- **PlayerIntent**：`BAIL{seat}` → `BAIL{target}`，`DEATH_GOD_TARGET{seat}` → `DEATH_GOD_TARGET{target}`（服务器按 `{...intent, seat: 会话座位, decisionId}` 组装 GameAction，intent 里的 seat 会被覆盖，目标座位传不到引擎）。前端 BailDialog / DeathGodTargetDialog 已同步。**GameEvent 载荷与 view/pacing.ts 本轮均未改动。**
- **DebugOp 新增 `clearBoard`**（只在 RICH4_TEST_MODE）：路上的神明回到场外、路面物件收走（路障 / 地雷 / 炸弹回共享库存），经 DEBUG_APPLIED 的 post 公布。E2E 夹具 `startGame` 开局后默认调用，排除开局随机摆放（6 位路面神 + 礼物 + 宝箱）对强制骰子路线的干扰。
- **SYS_DEBUG 重发回合菜单**：`give / setCash / setPoints / clearBoard` 之后，若回合菜单是唯一待决策且 TURN 帧停在 menu 阶段，撤掉它由 run 循环按新状态重新发出（新 decisionId），否则调试发的卡要到下一回合才出现在菜单里。`teleport / forceNext / setDate` 不重发（场景测试常用它们摆局面后再掷骰；需要按新位置算目标时先 teleport 再 give）。只影响测试模式，正式对局与 simulate 不变。
- **反作弊断言**：live 观战（默认设置）按设计经 `game:minigameWatch.ticket.seed` 下发种子（§5.10 已接受的风险）。anti-cheat 集成测试改为：观战者除 minigameWatch 以外的消息不得出现 seed / yourDecision / minigame；观战票据一律 `role='spectator'` 且不会发给本人座位；玩家收到的种子只在 `yourDecision.minigame.seed`。

### 20.2 引擎（M6）要点与暂定默认

- 30 张卡 `effects/cards/*`（CARD_EFFECTS 对 CardId 穷举）、13 种道具 `effects/items/*`、路面物件 `effects/objects.ts`、13 种神明 `data/tables/gods.ts` + `effects/gods/*`；对抗常数表 `data/tables/combat.ts`（combat、gods 进 TABLES，tablesHash 变化）。目标候选统一在 `decisions/targets.ts`，`targetMatches` 同时供引擎校验、AI 自检与前端 TargetPicker 对拍。
- **CONFINE 阶段顺序**：hostility → bless → exempt → scapegoat → apply → revenge（加持判定在查被动卡之前，g_villains §6）。陷害 / 梦游 / 查税的敌意在 `Effect.before` 钩子记账、随 CARD_USED 的 post 公布；CONFINE 的敌意推迟到链中下一次 emit 之前（避免紧接着发出决策时出现未公布的变化 → SYNC）。
- **被动卡询问门槛**：过路费、设施费、企业收费、PAYX、查税在金额 ≥ 2000 × PI 或金额 > 现金 + 存款时问免费卡 → 嫁祸卡；旅馆住宿不能用免费卡。USE_FREE_CARD / SCAPEGOAT 由被收费或被害的一方在出卡者的回合里回答。
- ⚑ 嫁祸只改变谁付钱：旅馆住宿、航空出国、保险投保仍落在落点者身上；设施费、企业费用了免费卡时住宿 / 出国 / 投保一并取消（V-R23）。
- ⚑ 换地卡连同地契期限一起交换；换地、换屋、改建、购地、土地公强占导致研究所换主或改类型时，进行中的研发作废（V-R16）。
- ⚑ 复仇卡触发后出卡者直接受罚 5 天，不再检查出卡者自己的被动卡（V-R24）；⚑ 同盟期间的敌意衰减 −20 × PI 夹到不低于 0，同盟任一方到期即双方同时解除（V-R25）。
- ⚑ 破产时身上的炸弹先放回所在格（格上已有东西或不可放置时回库存并发 `ITEM_LOST{bankrupt}`），然后附身神离场、搭档刷出，再解除同盟（V-R26）。
- ⚑ 传送机的被传送物与目的地都限定在 targetRange 窗口内；搬房屋时地主、等级、类型、地契、研发一起搬（V-R27）。⚑ MANUAL 预设下红黑卡按自然日倒数 3 天、异色互相抵消为 0（V-R11）。⚑ 梦游者停下时照样触发物件、神明与显灵（V-R3）。
- 死神附身者代付别人的过路费（`TollMod` 带 `deathPays`）；住宅过路费的同盟分账用 fround 比例，先付地主再付盟友。`handFull='choose'` 时满手先入手，再压 `ASK DISCARD_CARD`（弹出时手牌暂为 16 张）。
- 路过触发：路障拦停；身上炸弹每步引信 −1、同格有人时转手（V-C3 暂按「先倒数后转手」）。停下触发：地雷、恶犬、地面炸弹拾取、礼物、宝箱、神明。炸弹爆炸分 program / manual3x3；`strike()` 供飞弹、核弹以及 M7 的新闻 4、20 复用。每月 1 日重摆礼物与宝箱。
- 神明：GOD 帧按挤走旧神 → 附身 → 发威；回合开始时神明任期 −1、工程车倒数、同盟两段式倒数；搭档重生在距离 ≥ 300 的格上，试 64 次后放宽（DEV-08）；乞丐换位沿用同一规则（原版候选为 0 时会除零崩溃）。
- M7 之前的占位：拍卖卡（AUCTION 帧）菜单里不可用；时光机不可用（原因 `noAnchor`）；BAIL 里雇恶人（HIRE）一律拒绝，options 的恶人全部 `available=false`；恶人的 MOVE / LAND / VILLAIN 帧仍为 NOT_IMPLEMENTED（本期恶人不会上场）。
- 场景 DSL `scenario()` 默认 `board:'clear'`（M1–M4 的场景测试稳定），`newGame` 仍默认 `'random'`（与正式开局一致）；开局跳伞避开神明所在格。
- **AI**：`ai/preRoll.ts` 硬币 rand & 1 在用卡与用道具之间二选一，候选卡最多 8 张、道具最多 4 种（环形取），过 f7 个性闸门，从不用时光机与被动卡；`ai/cards.ts`、`ai/items.ts` 覆盖 30 张卡与 13 种道具的判据；被动卡与保释在 `ai/decisions/passive.ts`。简化：乌龟卡只对自己使用；涨价卡原版 esi 残值怪癖按有意简化处理；AI 视野固定半宽 220（DEV-03/04）。

### 20.3 小游戏（M8 第二部分）

- **引擎** `squares/minigame.ts`：电脑座位或 `minigames='skip'` 走不玩分支（score = 50 + rand15 % 20、speechSlot = rand15 & 1，恰好 2 次 `'minigameSkip'`，只发 `MINIGAME_ENDED{skipped}`）；真人座位取种子 `next32('minigameSeed') & 0x7fffffff`，发 `MINIGAME_STARTED` 并压 ASK MINIGAME（种子只在 PendingDecision.minigame）。系统 action MINIGAME_RESULT 结束决策；分数截断并夹到各游戏上限（`MINIGAME_SCORE_CAP`，由测试对照 spec.scoreSanityMax）。梦游者不触发。`MINIGAME_RESULT.logHash` 是输入日志的 FNV-1a（`hashLog`），不是终局状态哈希。
- **服务端** `MinigameReferee`：输入 seq 连续、tick 单调且不超前（horizon + 20）、日志合法；提交必须以已上传的流为前缀，结果一律以服务器 replay 为准（客户端分数不一致只记日志）。已开局的会话不再由 AI / 托管 / 超时代答，到期按已收到的输入重放结算（by=system）；真人开局时自动解除托管；开局后 decline 返回 `MINIGAME_INVALID{started}`。会话不随持久化保存：服务器重启后已开局的小游戏按新窗口、新 sessionId 从头开始；同进程暂停期间输入返回 GAME_PAUSED，继续时已开局的按已收到输入结算。
- **投递在传输层**：io.ts 的 emitter 每发一条对局消息就调用 `MinigameRelay.afterEmit`（不经 Room / RoomBroadcaster）——live 模式给其他座位与观战者补发观战票据与已接受的帧，迟到者、重连者自动补发，玩家本人的新连接补发自己的帧用于续玩；replay 模式在「玩过」的结算批次之后下发带完整日志的票据。
- **前端**：`installMinigames(client)` 改为**对局页进入时安装**（GameScreen 的 effect，幂等）；此前只有本人的 MinigameIntro 渲染时才装上，观战者与其他玩家收不到直播遮罩，刷新后服务器补发的自己的帧也会在安装前丢失。宿主在决策出现时后台创建、到 startsAt 才显示；观战遮罩在 startsAt − 3 秒弹出。
- **修复（严重）**：`MiniGameHost` 用 `app.destroy(true)` 销毁小游戏的 Pixi 应用，`true` 会调用 `GlobalResourceRegistry.release()` 清空**整个页面共享**的 Batch 池 / 纹理池，同页还在渲染的棋盘随后执行旧指令时抛「Cannot read properties of null (reading 'geometry' / 'clear')」并停止渲染。本人的小游戏或观战的直播遮罩一关闭就触发（E2E minigame、reconnect 首次整合时复现）。改为 `destroy({ removeView: true }, { children: true })`；client-browser 新增回归用例（旧写法下必现）。
- 点券一律按 u16 饱和累加，不跟随 `rules.intOverflow`（DEV-16）。

### 20.4 前端演出与接通

- **弹窗层**：GameScreen 挂载 `<PopupLayer />`（z-index 50：决策层 40 之上、骰子 55 / 横幅 60 之下），新闻、命运、出卡、神明、乐透、魔法屋、终局弹窗与公开竞价横幅由 handlers 经 `showPopup` 打开；最短展示时间过后出现「跳过」按钮。GAME_OVER 演出期间显示 GameOverScreen，之后由 hud/GameOverPanel 接手。
- **舞台同步**：BoardController 暴露 `stage`（`fx.stageFor(this)` 懒创建的 BoardStage），`syncView` 末尾调用 `stage.syncWorld(view)`：reset / 快照、`?anim=instant`、后台标签页与 TIME_REWOUND 之后，路面物件、神明、恶人、乞丐与角色状态外观立即追上（此前只在 handler 前后同步）。handler 仍经 `wrapHandler` 包装（事件前后同步舞台、时长硬封顶在 EVENT_BUDGET_MS）。
- **粒子预算**：`GameRenderer.particleLimit`（画质档 high 400 / mid 150 / low 0）传给 FxSystem，不再按帧率推断。
- **头顶气泡接通**：ui/social 的 `onHeadBubble`（已过滤屏蔽名单；表情 2 秒、聊天 3 秒）→ BoardCanvas → `BoardController.say` → `PlayerActor.say`：气泡挂在角色上随行走移动，表情放大显示字形，聊天超过 18 字截断；按真实时间消失，同一角色新气泡替换旧的。玩家条的 DOM 气泡改用 `useHeadBubble`（屏蔽名单生效）。
- **镜头锁定**：观战栏「跟随」写 `uiStore.followSeat`；BoardController 增加 `pinned()` 选项，锁定时镜头一直跟该座位，回合切换的 follow 调用不再覆盖；改回「自动」即恢复跟随当前行动者。
- **外观修正**（实机发现）：坐牢 / 住院的窗口气泡抬到楼顶上方（`CONFINE_LIFT` 96 像素），关押期间角色整体深度加 `CONFINED_Z`，不再被医院 / 监狱屋顶挡住；名牌跟着窗口气泡走；同楼多人左右错开 64 像素。附身神明挂到名牌上方（此前被名牌挡住一半）。
- **文案**：事件日志 CONFINED 增加 away / hotel 变体；`minigames.json` 补齐宿主、结算姿势与三个游戏的键，七彩气球说明改为 ×2 / ÷2 / ? 气球（原版没有炸弹球）。
- **工程**：vite `optimizeDeps.include` 加 `react-dom/client`（浏览器模式测试与开发页偶发两份 React）；net/client.ts 的 minigameWatch / minigameFrames 路由注明由小游戏模块经 transport.on 监听。

### 20.5 新增测试

- client-unit `presentation/handlers/realEngine.test.ts`：原版 AI 在 test-allkinds 上自对弈 3 局 × 2500 个 action，按座位 0 视角投影出 1300 余个事件样本（M6 事件每种至多 40 条），逐个交给未封顶的 handler 并接计时舞台：不抛错；日志行、toast、飘字、气泡、弹窗里没有 undefined / NaN / 残留插值 / 未命中的 i18n 键；自然用时 ≤ EVENT_BUDGET_MS（与 EventPlayer 同一容差）。
- client-dom `ui/decisions/realEngineCombat.dom.test.tsx`：25 张可主动使用的卡与 12 种道具逐一走「真实引擎 TURN_MENU → 卡片 / 道具页 → TargetPicker DOM 候选 → 确认 → 引擎执行」，必须被接受并发出 CARD_USED / ITEM_USED；拍卖卡、被动卡、时光机显示为禁用并带原因；另覆盖 USE_FREE_CARD（查税）、SCAPEGOAT（陷害）、BAIL、DISCARD_CARD（16 张）。
- client-browser：`fx.browser.test.ts` 增加 syncView 同步舞台、头顶气泡、关押深度；`minigames/crossEngine.browser.test.ts` 增加宿主关闭不释放全局资源。
- shared：`api.test.ts` 增加 SYS_DEBUG 重发回合菜单与 clearBoard。
- E2E：新增 `cards.spec.ts`（4 个真人；P2 买地后 P1 传送到该地、debug:act 发卡发道具，全部从回合菜单的 DOM 候选列表选目标：购地卡买下 P2 的地、陷害卡送 P2 入狱、放路障、拆除卡拆路障、均富卡；每一步后 4 个页面 HUD 与服务器快照一致、路面物件 / 关押 / 手牌数一致）；`minigame.spec.ts` 增加观战者的 live 遮罩断言；`save-load.spec.ts` 只断言读档前的地块归属（开局随机神明可能显灵改等级，读档前后的完全一致断言不变）。

### 20.6 台湾图实机测试（浏览器面板，RICH4_DATA_DIR=./rich4-data，1 真人 + 3 原版 AI）

逐项操作与观感（桌面 1280×800，小游戏之一在 844×390 横屏）：

- **购地卡**：传送到 AI 的地（台东县 1）→ 卡片页 → 目标面板「作用于脚下的『台东县 1』」→ 使用；地块插上本人旗帜，双方现金正确增减，出卡弹窗（卡面 + 描述 + 目标）约 1.2 秒。
- **陷害卡**：候选列出视窗内的两名对手，选中后对方入狱 5 天（toast「乌咪 入狱 5 天」），角色从路面消失，监狱楼顶出现带头像、铁栏与天数的窗口气泡（本轮修正遮挡后清晰可见）。
- **拆除卡**：放路障后菜单立即刷新为可用，候选里出现「路障」，出卡弹窗写「目标：路障」，路障消失。**均富卡**：4 人现金拉平为 113,875。
- **路障 / 地雷**：候选格列表点选，路面出现条纹路障与深色地雷；之后 AI 也在路上放地雷与炸弹。
- **定时炸弹**：放在前方格、掷 1 点拾取（「身上被放了定时炸弹（38 步）」，HUD 与头顶显示引信），传送到对手身后掷 2 点路过 → 转到对手身上（37 步），随后在三名 AI 之间来回转手，引信归零时在乌咪身上爆炸、住院 5 天。
- **飞弹**：目标下拉选对手所在格 → 「飞弹来袭！」、范围内路上小穷神被打跑（搭档大穷神随后在别处刷出）、对手住院 3 天。
- **神明附身**：传送到小财神 / 大财神前一格掷 1 点 → 神明降临弹窗（台词）→ 发威弹窗（老虎机滚动定格，如「6 9 2 5 → +5,863」）；神明缩小挂在头顶、HUD 显示「大财神 7 天」。另见天使 / 土地公显灵弹窗与光柱、恶犬咬人住院。
- **住院与保释**：停在监狱格弹出保释对话框（在押者「还有 6 天」、保释 30 点券），保释后点券 200 → 170、在押者变为待释放并在下一回合出狱。医院楼顶同样显示住院者窗口气泡。
- **小游戏**：企鹅挖宝（桌面，103 点）、七彩气球（桌面，150 点）、喜从天降（844×390 横屏，37 点）；倒计时 → 全屏宿主 → 结算 → 回棋盘，点券与 toast 一致，观战遮罩按设计弹出。横屏下舞台按 4:3 居中、HUD 与「收起」按钮完整。
- **聊天 / 表情**：表情与聊天在角色头顶出现 Pixi 气泡（跟随角色），玩家条同时出现 DOM 气泡；观战栏切换「跟随 3P」后镜头在其他人的回合仍跟 3P。
- 控制台除开发期 HMR 的一次模块重载报错外无错误。
- 实测后修正：保释对话框里 M7 之前不可雇用的恶人原显示「已经出门了」（引擎只给 `available=false`、没有原因），改为中性的「暂时不能雇用（已经出门或尚未开放）」，「点券不足」只在确有可选项时提示；飞弹「任意格」下拉里的普通道路格原显示「空地 #N」，`tiles:kind.plain` 改为「道路」（台湾图的 13 个普通道路格都不是地块前沿格；其他地图若是，则显示「<地块名>旁 #N」，`presentation/lotLabels.tileLabel`，日志与对话框共用）；地产格仍显示地图里的路段名。
- 遗留的观感问题：844×390 下小游戏开场对话框内容较多时底栏与最后一行键值略有重叠（内容区可滚动）；浏览器面板隐藏时截图滞后，1 秒左右的弹窗只能在放慢动画时钟（`__rich4.client.anim.speed = 0.25`）后截到。

### 20.7 验证

- `npm run check` 全绿；client-browser 全部通过；E2E 10 个 spec 全部通过（lobby、turn-cycle、timeout-ai、bank-stock、anim-unmount、minigame、reconnect、chat-spectate、save-load、cards）。
- simulate（original，限时 365 天）：test-allkinds 500 局 `finished=500 rejects=0 invariantErrors=0 errors=0 actions=796642 finalHash=1be3a315f2c74539`；台湾 50 局 `finished=50 rejects=0 invariantErrors=0 errors=0 actions=74104 finalHash=7c27f741f1cacbd1`（与引擎代理两次运行一致）。

## 21. M7「事件与收尾规则」实施记录与整合实测（2026-09-27）

本轮完成 M7（engine.md §17 L5 + 原版 AI 的 AI4，ENGINE_VERSION 0.4.0），随后把新闻、命运、魔法屋、拍卖、四大恶人、公布栏、投降 / 死神、时光机的真实引擎载荷接到前端演出、日志与文案，并在台湾图实机测试。以下只列与本文件、design/*.md 不一致的实现与原因；标 ⚑ 的是缺证据时的暂定默认，结论见 VERIFY.md；行为上有意与原版不同的已进 DEVIATIONS.md。

### 21.1 引擎与数据（M7）

- **数据表**：新增 `data/tables/news.ts`（36 条）、`fate.ts`（37 条 + v2.06 地图组文案变体 37..48、按座驾换号 10↔11 / 12↔13 / 14–16、`insured` / `passive` 标记）、`magic.ts`（12 条件、12 效果、流程常量）；每条带 effect、params、feasible、加持类别与 src（exe VA + events-from-exe 章节），文案只存 i18n key。TABLES 增加 news / fate / magic，tablesHash 变化。`events.test.ts` 与 `.cache/extract/tables.v206.json` 逐条比对（缓存存在时）。
- **与 engine.md 的出入以 events-from-exe §4 为准**：新闻 9 在全体在场玩家中取最少（含 0 块）；新闻 15 的可行条件收紧为「有等级 > 0 的住宅」（medium）；新闻 27 停牌写 15 天；命运 33 条查加持，其中 3/8/9/10/11/32 只处理免付 / 逃过、不加倍；命运 32 与魔法屋 0/8 按商店价全价折点券；罚金类命运投保期间由保险公司赔同额（加持免付时不赔）；新闻 ×1.3 / ×0.7 / ×0.05 与强盗 ×0.2 用 `Math.trunc(x × f)` 双精度实现（与 x87 结果一致性 medium）。
- **加持**：PROGRAM 下新闻不查加持；MANUAL（`blessingOnNews`）下新闻 1/3（延长刑期）按劫难类 low 天数 ×2、保险按实际天数赔，新闻 16/17（停留）low 不加倍。FATE 事件在加持结果为 none 时 `blessing: null`。
- ⚑ 命运按座驾替换时工程车保持原号（步行专属命运对工程车不可行）；小偷梦游期间不处理物件；间谍盈余为负时雇主先存款后现金反付（可能破产）；强盗抢银行按 0x463b60 = 0.2；魔法屋 11「拍卖脚下地产」流拍后地产变无主（V-R7）；投降者按破产流程变成乞丐（V-R9）。
- **拍卖（AUCTION 帧）**：多人并发出价，每个出价者独立计时；有人加价后同一帧其他人的待答作废（在途请求收到 STALE_DECISION）、按新价重新询问，「这轮不加价」只保持到下一次有人加价；卖方、受困者、现金 ≤ 起拍价者不能出价（DEV-17、V-R15）。拍卖卡开放；破产与投降共用 `flow/liquidation.ts`：释放的地产超过 3 处时随机拍卖 3 处（RandPurpose `'auction'`），成交款进公库。
- **时光机**（DEV-05）：默认 `'global'`（全场一个锚点 = 最近一次真人掷骰之前的世界），也支持 `'perSeat'` / `'disabled'`；回滚时 RNG 与决策 id 不回退，先发 `TIME_REWOUND`，同一批末尾补 `SYNC{reason:'timeRewind'}`；恢复后的世界里使用者的时光机 −1（最低 0）。
- **公布栏**：BOARD_LIST / DELIST / BUY 为 TURN_MENU 非终结操作；挂牌不冻结资产，按挂牌 id 贪心认领持有资产判定是否有效，回合开始撤下失效挂牌（`LISTING_REMOVED{invalid}`）；地产标价上限 = 市价 × 10（medium）；AI 不改价（DEV-11）。
- **恶人**：BAIL 的 HIRE（300 点券）开放；VILLAIN 帧 rand % 9 + 2 步（乌龟卡 1 步），`onNpcStep`、回老家、雇主出局送回都已实现。恶人的回合也发 `TURN_STARTED{actor:{t:'villain'}}`，回合号照常递增。
- **首回合未跳伞者被关押**（remake 适配）：被魔法屋或嫁祸关进监狱 / 医院时直接落在关押格（`placed=true`，之后不再跳伞）；魔法屋「向后转」跳过还没落地的人。
- **契约**：DebugOp 新增 `stackDeck{deck:'news'|'fate', ids}`（把指定的牌换到游标处，只在测试模式）；`AuctionBidOptions` 增加可选 `others`（除自己与领先者外仍可能出价的人数）与 `source`（兼容旧存档与测试桩，引擎总会给出）；以下决策现在由真实引擎发出：MAGIC_CAST、BIRTHDAY_PICK、DEATH_GOD_TARGET、BAIL 的 HIRE、TURN_MENU 的 BOARD_* 与 SURRENDER。**GameEvent 载荷与 view/pacing.ts 本轮均未改动**。`flow/stubs.ts` 已删除，引擎不再抛 NOT_IMPLEMENTED。
- **AI4**：`OriginalAiPolicy` 的 23 种决策全部按原版规则处理，不再委托 BasicAiPolicy。
- **simulate / bench**：simulate 新增 `--max-years`（无限局默认 20 年）、`--min-finish`、`--workers`（worker_threads，结果与并发数无关），输出 finalHash 与 journalHash；bench-engine 新增 `--humans`。

### 21.2 前端接通（本轮整合）

- **文案参数（`presentation/eventText.ts`，日志与演出共用）**：新闻 params 按键名解析（lot / company → 地块名，stock → 股票名，seat → 人名，amount / fine / gain / loss / reward / subsidy → 千分位金额，days / pct 原样），缺失的键给中性占位；新闻分类读 shared 新闻表（不再在客户端手抄一份）。命运金额的含义（补偿 / 奖金为收入，罚金 / 收回的股票为支出，冒名贷款、卖股进存款、折点券各带说明）、色调、加持类别、天数（劫难类 low ×2）、百分比一律读 shared 命运表；罚金 high 显示「免付」、奖金 low 显示「奖金作废」。恶人作案文案按 `what` 取（抢银行没有单一受害人，不再出现「无人」）。
- **日志**：NEWS 记标题与正文、FATE 记标题与正文（不再只有编号）、MAGIC_CONDITION / MAGIC_CAST 记条件、点名的人与效果名、VILLAIN_ACTION 与 toast 同一句话。
- **文案对齐引擎语义**（news / fate / magic / ui.json）：新闻 4（外星人：地产变无主、波及的人住院）、5、15、21（拆一层而不是夷平）、22（挤兑：只收存款）、26/27/29/30–35 带天数、罚款、盈余金额；地名前后留空格（同名编号地块如「台东县 3 一带」）；命运 0/1 带补偿金额、3/6/7/12/13/33–36 带天数、4/8 带百分比、9/13/32 按实际效果改写；魔法屋条件改成完整名词（「现金最多的人」「所有男生」），效果说明补上免罪 / 嫁祸可挡、拍卖成交款归目标本人（流拍变无主）；保释对话框的恶人说明按 g_villains 改写，不可雇用的原因改为「点券不足」；投降确认写明死神附身与清算拍卖。
- **修复（弹窗编号被覆盖）**：`popupStore` 的弹窗实例号原本叫 `id`，与新闻 / 命运 spec 自带的 `id`（编号）合并时覆盖了后者，NewsPopup / FatePopup 的 `data-news` / `data-fate` 显示成实例号。实例号改名 `popupId`，弹窗层与 close / skip 同步。
- **拍卖横幅**：有人加价后，此前「这轮不加价」的竞拍者恢复为竞拍中（与引擎一致）；没有经过演出（后台标签页走 instant、`?anim=instant`、积压跳过、刷新 / 中途进房）时按待决策的 publicInfo 补一条横幅（`derivedAuction`：标的、现价、被问的座位，领先者未知时显示「竞价中」）；PopupLayer 由 GameScreen 传入 map。AuctionDialog 增加「来源」「其他竞拍者」两行。
- **回合菜单入口（实机发现的缺口）**：M3 起 TURN_MENU 平时收起，只有卡片 / 道具 / 股票快捷键能展开对应子页，完整菜单里的「公布栏」「投降」没有任何入口。ActionPad 增加「📋 公布栏」（本人回合直接打开公布栏子页，否则打开只读面板）与「⋯ 更多」（本人回合展开完整回合菜单）。
- **时光机**：目标面板对时光机显示「将回到第 N 回合（最近一次真人掷骰之前），此后所有人的变化都会撤销」（`TurnMenuOptions.timeMachine.anchorTurn`）；无目标说明不再写「这张卡」。
- **恶人回合**：TURN_STARTED 的恶人分支镜头飞到恶人身上并冒「××出动」气泡（此前只等 200ms，恶人在镜头外走路）。
- **i18n**：补 `hud:error.ACCESS_REQUIRED`（另一工作流新增的错误码）。

### 21.3 新增与调整的测试

- client-unit `presentation/handlers/realEngineM7.test.ts`（定向覆盖）：新闻 36 条、命运 37 条逐条经 `stackDeck` + 强制骰子触发（10–16 先换座驾），魔法屋 12 种效果逐一施放，拍卖卡三人出价 / 放弃 / 加价 / 退出并核对竞价横幅状态，四种恶人雇用后原版 AI 接着玩 600 步，投降 + 死神 + 清算拍卖、时光机、公布栏挂牌 / 撤牌 / 成交；每个样本交给未封顶的 handler：不抛错、日志与弹窗文案无 undefined / NaN / 残留插值 / 未命中键、新闻与命运正文不出现缺省占位词、自然用时 ≤ 预算。播放台架移到 `src/test/realEngineHarness.ts`（分层守卫：engine-testing 与 shared/ai 只能在测试目录使用），`realEngine.test.ts` 的自对弈样本把 M7 事件纳入重点类型（每种至多 40 条）。
- client-unit `presentation/eventText.test.ts`；client-dom：`realEngineCombat.dom.test.tsx` 拍卖卡可用、AUCTION_BID 对话框多人出价成交、时光机回到最近一次真人掷骰之前；`realEngine.dom.test.tsx` 的 ATM 路过用例预置命运牌（终点是命运格）；`popups.dom.test.tsx` 弹窗编号不被覆盖、推导横幅；`hud.dom.test.tsx`「更多」「公布栏」入口。
- E2E `e2e/specs/events.spec.ts`：4 个真人（P4 走演出路径），debug:act 触发新闻（所得税）、命运（继承遗产）、魔法屋（DOM 选「现金全部存入」）、拍卖卡（P1–P3 在 AuctionDialog 里出价 / 放弃 / 加价 / 退出，P2 成交、成交款进卖方存款）；每步 4 页面 HUD 与服务器快照一致、显示态与事件日志一致且无坏文案；演出页出现新闻、命运、魔法屋弹窗与竞价横幅。

### 21.4 台湾图实机测试（浏览器面板；RICH4_TEST_MODE=1，2 真人 + 2 原版 AI，第二个真人用 `p2.localhost` 隔离身份）

- **新闻**：预置新闻 6 → 主播弹窗打字机标题「市政规划利好」，正文「台东县 3 一带纳入新建设计划…」，日志「新闻「市政规划利好」：…」。
- **命运**：预置命运 2 → 「身份被冒用」，贷款 +10,000 进 HUD 贷款徽标；魔法屋连抽 3 次命运时依次弹出「清仓大拍卖 +155 点券」「跌进水沟 住院 3 天」「外星人绑架 3 天」「互助会被倒 −8,000」等，日志逐条完整。
- **魔法屋**：条件预置「所有男生」→ 对话框列出点名的两人与 12 种效果说明，施放后弹窗与日志正确。
- **雇恶人**：监狱保释格雇用强盗 / 小偷（点券 −300），恶人从关押格出发；之后「小偷偷走了 小丹尼 一半的点券」「小偷顺手牵走了路上的东西」。
- **拍卖**：台北市 1 出拍卖卡 → 电脑与另一真人竞价，对话框显示来源、卖方、起拍价、其他竞拍者；成交后卖方存款 +成交价、买方插旗。发现后台标签页没有竞价横幅 → 加推导横幅（21.2）。
- **时光机**：目标面板提示回到第 8 回合 → 确认后回到 1 月 2 日第 8 回合，另一真人的雇恶人与之后的拍卖全部撤销。
- **投降**：发现完整回合菜单无入口 → 加「⋯ 更多」（21.2）；投降 → 死神附身对话框选对手 → 糖糖挂上死神（13 天）、投降者出局成乞丐，日志 SURRENDERED → DEATH_GOD_SUMMONED → GOD_ATTACHED → GOD_POWER → LIQUIDATION → BECAME_BEGGAR。
- 控制台无错误；「超过预算」警告只出现在浏览器面板隐藏期间（动画时钟退化为 200ms 定时器，每个 handler 多出一格），与本轮无关。
- 遗留：魔法屋连抽三张命运时，同一人可能先「住院 3 天」再「出国 3 天」，引擎的 `applyConfinement` 对 away 不清 jail / hospital，两个计数同时存在（不变量允许，HUD 同时显示两枚徽章，两者一起倒数）；是否应互斥待 V-R8 / V-R13 实机核对，本轮未改引擎。同格的恶人与玩家名牌重叠。

### 21.5 验证

- `npm run check` 全绿；client-browser 6 个文件 24 通过 1 跳过；E2E 12 个 spec 13 个用例全部通过（新增 events）。
- simulate（original）：test-allkinds 限时 365 天 1000 局 `finished=1000 rejects=0 invariantErrors=0 errors=0 actions=1858538 finalHash=28d1a5559e12c65a journalHash=ccaf5266694b3998`（与引擎代理的运行一致）；台湾 100 局 `finished=100 rejects=0 invariantErrors=0 errors=0 actions=171009 finalHash=b854f624db6574f4 journalHash=5f29333d95a48780`。

### 21.6 M7 审查修复（2026-09-27）

逐条复核审查意见后的处理（GameEvent 载荷与 view/pacing.ts 均未改动；AuctionBidOptions.others 只改了计数口径）：

- **新闻 11/12/13 税款逐人结算**（修复）：NEWS 帧新增 `tax` 阶段（`data.seats` 名单、`data.idx` 游标），公布后一次收一人；有人付不起就先返回，让他的 BANKRUPT 帧跑完（可能直接终局）再收下一人，税额按收的那一刻的状态计算。此前同一步压多个 BANKRUPT 帧、后进先出，剩 2 人都付不起时先结算的是座位号大的人，另一位还没结算的付不起者被判 lastStanding 赢家（1 真人对 1 电脑时应为 noHumansLeft）。没有采用「栈里有 BANKRUPT 帧的座位视为出局」的兜底：月结分红（flow/day.ts）有意按座位倒序压帧、让座位小的先破产，兜底会改变它与原版「当场破产」一致的结果。
- **魔法屋 8 道具全卖**（修复）：座驾改回步行时单独发 `VEHICLE{seat, vehicle:'walk', dice:1}`（`sellAllItemsDetailed` 返回 `vehicleChanged`）；此前工程车 + 空背包的目标一个事件都没有，变化夹带进 TURN_ENDED 的 post。命运 32 随后发 FATE，不变。
- **新闻 1/3 投保理赔**（修复，⚑ V-R28）：exe 的处理函数只加天数、不调保险，PROGRAM 不再理赔；MANUAL（`blessingOnNews`）保留社区说法、按加的天数理赔。
- **新闻 22 挤兑的计数**（确认、暂不改）：原版是每人一份两段式计数，实现为全场按日倒数，抽到新闻者本人及座位在他之前的人少生效最后 1 个回合。改为每人一份要升 state 结构（v2 + 迁移，含锚点）并改银行面板，记为 DEV-18，留待 V-R21 一并处理。
- **电脑保释 / 雇恶人**（修复）：候选按个性组、关在这里的恶人全部列入（不看点券），抽中恶人后才检查点券 ≥ 700；rand 消耗顺序 rand&1 →（个性 1）rand%3 → rand%n 与 g_villains §1 一致。
- **时光机与系统状态**（修复）：回滚不恢复 v / engine / dataRef / config，players 恢复时保留各座位当前的 controller 与 aiTraits（SYS_SET_CONTROLLER 的踢人与读档认领、SYS_SET_AI_TRAITS 的托管设置）。此前被踢的座位回滚后在引擎里变回真人（服务器仍让电脑代打，noHumansLeft 失效、锚点被它的掷骰覆盖），读档认领的座位变回电脑。新增场景测试与服务器集成测试 `integration/time-machine.test.ts`。
- **时光机 perSeat 的锚点**（修复）：回滚时其他座位在恢复点之后（`takenAtTurn ≥ 恢复点`）记下的锚点属于被撤销的时间线，作废；恢复点之前的锚点保留，其中使用者的时光机同样 −1。不再能「前跳」、用掉的时光机也不会因别人回滚而回来。目标面板在 perSeat 下显示「你上一次掷骰之前」（`dlg.target.timeMachinePerSeat`）。
- **锚点校验**（修复）：`secret.timeAnchor / timeAnchors` 由 `TimeAnchorSchema` 严格校验（与 GameState 共用公开世界字段；`timeAnchors` 至多 4 个），`explainState` 另把每个锚点世界拼成 GameState 跑全部不变量（不要求待决策非空），并检查座位集合与对局一致、perSeat 锚点在自己的下标、锚点世界进行中、`takenAtTurn` 与世界回合号一致。导入存档不能再借锚点注入未校验的世界。
- **AUCTION_BID.others**（修复）：改为与「可出价」同一判据（未放弃、未退出、在场且现金 ≥ 下一口价，不含自己与领先者）；出不起下一口价的人不再算入，AI 在只剩一个对手时照规格压最小档。
- **两台电脑 +100 交替加价**（确认是规格行为，暂不改）：原版 AI 规则「只剩一个可出价座位时压成最小档」与 DEV-17「这轮不加价只保持到下一次有人加价」的组合；上一条修复会让这种情形略多。是否放大档位、合并 AI 连续出价的演出或减少对已放弃真人的重问，需要在原版规则与联机体验之间权衡，留给产品决定。
- **拍卖对话框的建筑预览**（修复）：按地块的真实地主上色（`lotStatus(view, lot).owner`），不再用卖方；卖方仍在「卖方」一行显示。

验证：`npm run check` 全绿（223 个文件 2112 通过 1 跳过）；E2E 12 个 spec 13 个用例全部通过；simulate（original）test-allkinds 限时 365 天 1000 局 `finished=1000 rejects=0 invariantErrors=0 errors=0 actions=1855308 finalHash=7564c5f1685091a8 journalHash=f475e533bfa9de40`（AI 保释的随机数消耗与拍卖 others 口径变化，哈希随之改变）；另跑 `--humans 2` 200 局（锚点每 50 步随结构校验检查）`finished=200 rejects=0 invariantErrors=0 errors=0`。

---

## 22. 原版皮肤 A4 / A5 / A9 实施记录与整合实测（2026-09-27）

本轮完成原版皮肤的服务器素材包与访问门禁（A4）、前端素材包与回退矩阵 / FLC 播放器 / BoardSurface 接缝 / zh-TW 管线 / 门禁页（A5）、音频引擎（A9），随后把三者接通并在本机真实素材包上实测。上位裁决见 design/original-skin.md（U1–U6、§3 修正 1–10）；以下只列实现要点、与设计草案不一致之处和原因。素材包内容始终不入库：CI 与 E2E 只用 `npm run extract -- assets synth` 生成到 `.cache/synthetic-pack` 的合成包。

### 22.1 服务器：`/pack/*` 与访问门禁（A4）

- **配置**（§9.2）：`RICH4_ASSETS_DIR` 只认显式设置、目录里有 manifest.json 才启用；`RICH4_ASSETS_VERIFY=quick|full`（任何不符整体不启用）；`ACCESS_MODE=off|passcode|invite`、`ACCESS_PASSCODE_HASH`（scrypt，格式 `scrypt:<N>:<r>:<p>:<salt>:<hash>`，不用设计稿的 `$` 分隔：compose 的 .env 会对 `$` 插值；解析时仍接受 `$`）、`ACCESS_SECRET`（≥32 字节）、`ACCESS_TTL_DAYS=30`、`ACCESS_GRANTS=1`。空字符串视为未设置。**启动守卫**（修正 3）：启用素材包而门禁为 off 时 ConfigError，只有「非 production + PUBLIC_URL 为 localhost + TRUST_PROXY=0 + 显式 RICH4_ASSETS_ALLOW_UNGATED=1」四条同时满足才放行，并打印高亮告警。
- **`/pack/*` 永远注册**（修正 4）：未启用时 404 JSON（reason packDisabled），只提供 manifest 白名单里的文件；带哈希文件 `private, max-age=2592000`，manifest `private, no-cache` + `ETag=packId`、启动时预压缩 br / gzip；单段 Range（206 / 416 / If-Range）；所有 /pack 响应带 nosniff、CORP same-origin、X-Robots-Tag。SPA 回退排除 `/pack` 与 `/api`，`/robots.txt` 为 `Disallow: /`。
- **门禁**：cookie `r4_access=v1.<exp>.<epoch>.<kind>.<HMAC>`（kind p 口令 / i 邀请码 / g 房间授权），HttpOnly、SameSite=Lax、https 时 Secure；`/api`、manifest、GET `/api/access`、Socket.IO 握手响应上滑动续期。口令 scrypt（线程池）+ timingSafeEqual，POST 必须是 application/json。限流：按 IP 退避（前 5 次免费，之后 1s→30s 封顶，30 分钟清零）+ 全局令牌桶软上限（排队，超过 10s 才 429），不做硬锁。**房间授权**（U4）：24 小时、8 次、只存 sha256、绑定 epoch；g 会话不能再生成授权（防链式扩散），已持有效 cookie 的人兑换不消耗次数。邀请码存 sqlite `access_invites/access_meta/access_grants`（`CREATE IF NOT EXISTS`，不升 `DB_SCHEMA_VERSION`；STORE=json 时 `DATA_DIR/access.db`）。`epoch+1` 一键吊销（每秒至多读一次库，另一进程的 CLI 吊销 1 秒内生效）；吊销不强制断开已建立的 Socket（下次握手被拒），免得踢掉进行中的对局。
- **接口**：`GET /api/access`（状态 + `pack: packId|null`，未通过门禁恒为 null）、`POST /api/access {passcode}`（口令模式也接受邀请码）、`/api/access/grant`、`/redeem`、`/logout`；`ADMIN_TOKEN` 保护的 `/admin/access/invites`（GET / POST / DELETE）与 `/admin/access/revoke`（Docker 部署不进容器即可管理）。受保护请求失败 401 `ACCESS_REQUIRED{reason}`；`io.use` 先查门禁（先于 BAD_HANDSHAKE / PROTOCOL_MISMATCH）。
- **CLI**：`npx tsx scripts/access.ts hash [--stdin] | secret | invite | list | revoke`（根 package.json 未加 `npm run access`）。**部署**：`deploy/Dockerfile`（构建期发现原版 / 派生文件即失败，镜像扫描 0）、`deploy/docker-compose.yml`（`../rich4-assets:/assets-rich4:ro`、TRUST_PROXY=1）、`deploy/.env.example`（缺省 ACCESS_MODE=passcode）、`deploy/Caddyfile`（/pack 不再压缩）。

### 22.2 前端：素材包、回退矩阵、FLC、BoardSurface、zh-TW、门禁页（A5）

- **PackClient**（`skin/pack`）：`/pack/manifest.json`（no-cache），404 / 204 / 非 JSON / zod 或一致性校验失败 / 5xx / 网络错误一律按「没有素材包」，401 → 门禁页；逻辑路径经 `manifest.files[].path` 换成带哈希 URL；按组懒加载并逐个校验图集、地图皮肤与映射表；`checkMap`（修正 9：resourceSha256 + 几何摘要）、`usableEntry`（缺失 / 组失败 / guess → null）、`audioFile`、`loadFlic`。
- **皮肤判定**（`skin/resolve.ts` 纯函数矩阵 + `skinStore`）：设置 auto / original / procedural；素材包发现先 GET `/api/access`，门禁开启且已通过（或状态里 `pack` 非空、开发构建、`?pack=1`）才请求 manifest，门禁 off 的生产构建不请求（避免每局一个 404 控制台错误）。原版判定后预取当前地图组，失败记 group-missing 回退。界面语言与主题只在对局页内随判定切换（原版 → zh-TW + `<html data-skin="original" lang="zh-TW">` + `local('MingLiU')` 字体栈；离开对局页恢复）。
- **FLC**（`skin/flic`，自写）：8 位 FLC 全部子块、0xF100 前缀、循环帧与 Panel#20 COPY 怪癖；FlicPlayer 由 AnimClock 驱动、`playFit` 规划（原速 → 加速 ≤2× → trim → 均匀跳帧）。本机 105 段 FLC / 3204 帧块与 extract 解码器逐帧一致。
- **BoardSurface 接缝**（修正 7）：统一旋转口径 0..7（程序化只用偶数）、镜头门面、anchorPos、测试钩子同形；`boardRegistry` 供 A6 注册原版渲染器，未注册或创建失败回退程序化（renderer-unavailable / renderer-failed）。Camera 缩放上下限参数化；EventPlayer 调 handler 时 `ctx.at = {epoch, seq, eventIndex}`。
- **zh-TW**：`scripts/gen-zh-tw.ts` 用 opencc-js cn→twp 生成 15 个 `locales/zh-TW/*.json` 并入库（保护 `{{占位符}}`，再套 `i18n/zhTw.ts` 的词汇与键覆盖表），`--check` 校验新鲜度；client-unit 测试键集、占位符与入库文件一致。改了 zh-CN 语言包要重跑生成器。
- **门禁页**（`ui/access`）：AccessGate（口令表单；`#g=` 片段先清掉再兑换）、AccessGateHost（对局页常驻，门禁开启时每 30 分钟 GET `/api/access` 续期）、`requireAccess`（没有宿主时自挂全屏浮层）；InviteLink 在可以生成授权时直接把邀请框换成 `/r/<code>#g=<token>`（`data-grant="true"`），受邀访客提示不能再生成授权。

### 22.3 音频（A9）

- **AudioEngine**（`audio/`）：master + bgm / sfx / voice / ui 总线（dB 曲线）；首次手势解锁（含 iOS 媒体元素与 audioSession）；后台挂起并记下音乐位置；SFX 解码缓存（按字节 LRU）、同键并发 ≤4、加载超过 400ms 作废；Opus 优先、失败换 m4a；语音单通道按原版阻塞语义（每句至少停留 1000ms），有语音时 BGM 压低 6dB；棋盘曲 `<audio>` + MediaElementSource 流式轮播，场景曲 AudioBuffer loopStart/loopEnd 无缝循环（过长或解码失败退回元素），场景栈续播、noResume（开局设定、结算、节日）。
- **导演层与映射**：`presentation/soundMap.ts` 改为 `{sfx?, voice?, scene?}` 按事件类型穷举；`selectors.ts` 的 sfx / voice / scene 选择（语音按 `mix32(epoch, seq, eventIndex)` 确定性选变体与概率，所有客户端听到同一句）；guess 置信度的原版音效缺省走 ZzFX（18 个自拟预设，随机度 0），flicCovered 的演出在 FLIC 播放器接管后由它出声（`flicSfx`，A8 之前为 false）。
- **来源**：`manifestAudioSource(manifest, urlOf)` 只依赖已校验的 manifest；`loadAudioMaps` 逐张 zod + 交叉引用校验，不合格整张按缺失。试听页 `/dev/audio`（音乐进出场景核对续播、音效集含置信度、12 角色 × 27 槽语音、道具 / 卡片台词、NPC、新闻、事件映射）。

### 22.4 本轮整合：接线

- **音频接到对局**：`app/audio.ts`（首屏只有开关；`?audio=off` 或没有 Web Audio 时不加载）懒加载 `app/audioWiring.ts`：
  - `createAudioSystem({ settings: useSettingsStore })`；`GameClient.setAudio(EventAudioHook)`——`presentation/audioHook.ts` 的 `withEventAudio` 包在全部 handler **最外层**（音效 / 语音在 handler 开始时触发，事件场景曲在 handler 结束、封顶或中止后收起），`ctx.audio` 为 `AudioSystem.port()`，EventPlayer 的 onAbort 与离开房间时 `director.reset()`。包装按需进行、以空对象为 Proxy 目标（测试替身常用 Proxy 充当 HandlerMap，原表可能被冻结）。
  - **素材包**：皮肤判定为原版且素材包就绪时 `applyPack(manifest, { urlOf: PackClient.urlOf, fetchJson })`（映射表 401 → 门禁页），否则只用 ZzFX（没有语音与音乐）。音频跟随 `resolution.skin`：强制程序化或 auto 下地图不匹配时，原版声音也不用。
  - **场景曲**：房间 / 对局 / 结算与当前场所 → `director.setUi`。场所取本人的决策（BAIL 按 options.where 分监狱 / 医院，MINIGAME 取小游戏种类），否则取他人公开的场所决策（银行 ATM / 柜台、商店、乐透、魔法屋、拍卖；他人的保释与小游戏在 publicInfo 里分不清，不算）；节日由 `holidaySceneOf(view, map)`。
  - 测试钩子 `window.__rich4.audio = { state, log, music(), clearLog() }`（只在测试钩子开启时）。
- **设置**：settingsStore 升 v2——`volume.ui`（缺省同音效）、`voiceEnabled`（U1 默认开）、`muteInBackground`（默认开），`migrate` 给旧数据补齐；设置页换成 `AudioSettings`（五路音量、静音、角色语音、后台静音；纵向排列），文案 `hud:settings.audio.*`（zh-TW 词汇表补「台詞」「切到背景」），删掉「音效将在后续版本加入」。
- **`/dev/audio` 路由**：试听页经 skinStore / PackClient 发现素材包（门禁未通过时弹门禁页，通过后自动重新发现），按 packId 重建试听用的音频系统；vite `optimizeDeps.include` 加 `zzfx`（否则 dev 下首次动态 import 触发依赖重新优化并整页重载）。`PackClient.urlOf(packPath)` 给音频来源用。
- **门禁接线**：`main.tsx` 启动时 `bootstrapAccess()`（`#g=` 片段 → 门禁页兑换；门禁开启而未通过 → 门禁页）；Socket.IO 握手 `ACCESS_REQUIRED` 时 `requireAccess('socket')`，socketTransport 把它和版本不符一样视为终态（此前每 3 秒重试一次握手），ReconnectOverlay 对此不显示「正在重连」；地图、地图目录、存档导入导出的 `/api` 返回 401 时 `requireAccess('api')`（`noteApiStatus`）。**需要重新载入时门禁页保持显示直到新页面接手**（此前先收起再 `location.replace`，旧页面在导航途中露出并继续请求；E2E 的 evaluate 也会撞上导航），提交成功后按钮停在「验证中」。
- **地图文案按界面语言**：`pickMapString(strings, key, lang)`；`makeNames` 增加 `lang`（GameClient、等待条、拍卖横幅传 `uiLanguage`），HUD 的名字、股票跑马灯同样取当前语言，`lotLabels` 按语言分别缓存编号表。原版皮肤（zh-TW）下地块 / 股票 / 格子名取 `strings['zh-TW']`。程序化棋盘上的地块标签仍按 BoardView 的 zh-CN（原版棋盘由 A6 负责）。

### 22.5 本轮修复

- **audio/music.ts**：元素模式场景曲在 URL 缺失时提前返回的句柄，stop 访问尚未初始化的 `onEnded`（TDZ ReferenceError；A5 报告的 client-dom 未处理异常，来自 AudioLab 进出场景）。
- **AudioLab 在开发构建里引擎恒为 disposed**：`useMemo` 建的系统在 StrictMode 的第一次卸载时被 dispose、再挂载时沿用。改为在 effect 里创建并在卸载时释放。
- **类型检查**：`audioEngine.browser.test.ts` 引入 `vitest/browser` 后，`@vitest/browser` 的 `toHaveTextContent(string|number)` 先于 jest-dom 载入，`dialogs.dom.test` 里的 RegExp 参数报错。`src/vite-env.d.ts`（位于 src 根目录，先于子目录进入类型程序）先引用 `@testing-library/jest-dom/vitest` 的类型。
- **首屏分包**：`presentation/handlers/gods.ts` 与 `GodBadge` 在运行时引用 `game/actors/godPalettes`（纯数据），它落在 game 分组里，首屏因此 modulepreload 整个 game chunk 与 pixi。game 分组排除这个文件后，首屏 JS gzip 从 450.9 KB 降到 242.4 KB（client.md 预算 450 KB），index.html 不再预载 pixi / game。
- **E2E 适配**：`newPlayer` 增加 `setup(page)`（打开首页之前装 `page.route`；前端启动时就读门禁状态，之后装的路由对缓存的状态不起作用），`skin-pack-load.spec` 改用它；access 夹具的 `accessStatus` 碰上页面跳转时等载入再读，`enterPasscode` 等新页面载入；`access.spec` 改为断言走界面（启动即门禁页、邀请框直接是授权链接、前端兑换并清掉片段）；门禁开启时 `lobby.spec` 的邀请框断言带授权片段，`reconnect.spec` 的恢复提示接受繁体（门禁 + 素材包下对局页是原版皮肤）。

### 22.6 新增与调整的测试

- client-unit：`presentation/audioHook.test.ts`（包装语义、钩子抛错不影响演出、Proxy 形式的 handler 表；GameClient 每个事件经钩子、`ctx.audio` 与 `ctx.at`、reset 与离开房间时 reset）；`app/audioWiring.test.ts`（UI 状态 → 场景、场所取值、素材包选取、wireAudio 接 GameClient / skinStore / 房间与对局 store，撤销后解除）；`stores.test`（音频默认值、v1 → v2 迁移、音量清洗）；`socketTransport.test`（ACCESS_REQUIRED 终态不重试）；`AudioEngine.test`（元素模式缺曲时弹出不抛错）；`eventText.test`（pickMapString、makeNames 按语言取地块名）。
- client-dom：`AudioSettings.dom`（界面音、角色语音开关、后台静音写回 store）；`access.dom`（需要重新载入时门禁页保持显示）；`system.dom`（ACCESS_REQUIRED 不出重连遮罩）；`AudioLab.dom`（StrictMode 下自建系统可用）。
- E2E：新增 `audio.spec`（生产构建懒加载音频、页面点击解锁、事件经导演层放出 ZzFX 音效、设置写回 store、无报错）；`access.spec` 断言走界面。

### 22.7 本机实测（真实素材包 rich4-assets，packId e6f3322db57bdedd；浏览器面板）

服务器 `RICH4_ASSETS_DIR=./rich4-assets ACCESS_MODE=passcode RICH4_DATA_DIR=./rich4-data`（口令哈希与密钥由 `scripts/access.ts` 现场生成，放在 `.cache/`）+ vite dev：

- **门禁页**：打开首页即显示门禁页；错误口令提示「口令不正确」（服务器 401）；正确口令后页面重新载入进入首页，`GET /api/access` 为 `granted, kind p, pack=e6f3322db57bdedd`，`/pack/manifest.json` 200。
- **邀请链接**：房间页邀请框直接是 `/r/<房间>#g=<token>`，下方提示「链接内含访问授权：24 小时内有效，最多 8 次」；用 `p2.localhost` 隔离 cookie 打开该链接，片段被清掉、兑换成 g 会话（canGrant=false）直接进房，房间页提示「不能再生成授权」。
- **/pack 资源与皮肤判定**：台湾图开局后 manifest、三张音频映射表、`maps/taiwan.skin.*.json`、27 个 sprites 图集 JSON / 位图、3 个音频文件全部 200（带哈希文件 `private, max-age=2592000`，manifest `private, no-cache`）；`__rich4.skin`：`skin original / board procedural（renderer-unavailable）`、`lang zh-TW`、failedGroups 为空；界面、日志、跑马灯为繁体；设置页显示「當前介面：原版；棋盤：程式化」「原因：原版棋盤尚未完成，暫用程式化棋盤」。受邀者页面同样判定为原版。
- **音频**：对局中棋盘曲 music.track02 轮播；掷骰 / 走路放 ZzFX（guess 项）、买地放原版 `sfx.049`。`/dev/audio`：解锁后播放棋盘曲、进银行切 music.track14、离开后棋盘曲从断点续播；试听 voice.1050 / 1056 / 1060（opus，200）；控制台除故意输错口令的 401 外没有错误。

### 22.8 验证

- `npm run check` 全绿：typecheck、lint（1020 个文件）、vitest 253 个文件 2380 通过 1 跳过；check-determinism OK（193 个文件）、check-no-original OK（1224 个文件）、check-deps OK（968 个文件）；`npx tsx scripts/gen-zh-tw.ts --check` 最新（15 个文件）。
- client-browser（`RICH4_CHROMIUM_PATH` 指向 chromium-1228）：8 个文件 28 通过 1 跳过（连跑 4 次，第一次有 1 个用例失败、后 3 次全过，未复现）。
- E2E（`CI=1 npx playwright test -c e2e/playwright.config.ts`，门禁 off）：16 个 spec 20 个用例全部通过（含 access ×4、skin-pack-load、skin-procedural-fallback 与新增 audio）。
- E2E（门禁 + 合成素材包：`ACCESS_MODE=passcode ACCESS_PASSCODE_HASH=… ACCESS_SECRET=… RICH4_ASSETS_DIR=.cache/synthetic-pack RICH4_E2E_PASSCODE=…`）：lobby、turn-cycle、reconnect 3 个用例通过；夹具先注入口令，对局页判定为原版皮肤（繁体），邀请框为授权链接。
- 生产构建：首屏 JS gzip 242.4 KB（本轮之前 450.9 KB），音频引擎、接线与试听页各自懒加载。

### 22.9 遗留

- 原版棋盘（A6）、OrigActor / OrigStage（A7 / A8）、路线 A 外壳与原版对话框（A10–A12）未开始：台湾图的棋盘仍回退程序化；FLIC 播放器未接到演出，`flicSfx` 保持 false，flicCovered 的演出仍放 cue 音效。
- 界面音（`director.uiCue`：按钮、倒计时最后 5 秒）尚未接到组件；他人的保释 / 小游戏场所曲只在本人决策时播放；隐藏标签页 EventPlayer 走 instant，不放事件声音（设计如此）。
- guess 置信度的音效 / 语音槽需要人工在 `/dev/audio` 试听核对（A9 清单）；iOS / Android 真机（解锁、切后台、静音键、audioSession）未测，设置里还没有关闭 `audioSession=playback` 的开关。
- 合成素材包不含音频（features.audio/voice/music 为 false），E2E 只覆盖 ZzFX 回退路径；原版声音的 E2E（开局宣言、进银行切曲续播）需要带音频的合成包。
- 根 package.json 不在本轮可改范围：`npm run access`、`gen-zh-tw --check` 进 check、`check:bundle` 都还没有。

## 23. 原版皮肤全流程接通与整合实测（A6–A8 / A10 接线，2026-09-27）

本轮把已完成的原版棋盘（A6 OrigRenderer）、角色（A7 OrigActor）、原版舞台（A8 OrigStage + pacing profile）、路线 A 外壳（A10 ClassicLayout）、音频（A9）与繁体语言包接成一条完整流程，并在合成素材包（CI）与本机真实素材包上各跑了整局。程序化皮肤不变（默认 E2E 全量照旧通过）。素材包内容始终不入库：含原版素材的截图与日志只在 `.cache/w3/`。

### 23.1 接通后的流程

- **判定 → 布局 → 棋盘**：对局页 `useGameSkin` 判定为原版且地图已载入 → `GameScreen` 用 `ClassicLayout`（640×480 舞台 + 联机侧栏）；`BoardCanvas` 经 `skin/boards.createBoard('original')` 调 `skin/renderers.ts` 注册的工厂，建 `OrigRenderer` + `OrigBoardController`，嵌在棋盘视窗（0,40）440×440 里（insets 为 0）；创建失败回退程序化（renderer-failed）。
- **演出**：`GameClient.attachBoard(OrigBoardController)`，EventPlayer 的 handler 经 `BoardPort` / `StagePort` 驱动原版棋盘；`wrapHandler` 在 `syncWorld` 之后调 `stage.beginEvent(e, { audio, budgetMs })`，OrigStage 按当前节奏的预算为 FLIC 计算可用时长（original 原速完整播放，compact 加速 / 跳帧），FLIC 首帧放 flic-map 的同步音效。
- **节奏**：房间设置 `pacing`（默认 original）→ 服务器 `estimateAnimMs(events, pacing)` 扣截止时间；客户端 `budgetMs()` 跟随房间设置，handler 封顶与 OrigStage 用同一个值。
- **音频**：皮肤为原版且素材包就绪时 `applyPack` 换成原版音乐 / 语音 / 音效；场景曲随界面状态切换（房间 → 开局设定曲，对局 → 棋盘轮播，本人的银行 / 医院 / 监狱 / 魔法屋等决策 → 场所曲，离开后棋盘曲从断点续播）；原版棋盘在场时 `flicSfx` 打开，flicCovered 的演出由 FLIC 出声。
- **文字**：对局页原版皮肤下界面、日志、弹窗为繁体（zh-TW），标签页标题同步换成繁体；大厅与首页不受皮肤影响。

### 23.2 本轮修复

- **离开房间后又被拉回房间**（`ui/screens/RoomScreen.tsx`）：进房 effect 的依赖里有 `t`（`useTranslation` 的 t 随语言变化换身份）。原版皮肤下「离开 → room:leave 回包 → 房间状态清空、对局页卸载 → 语言从 zh-TW 切回 zh-CN」的途中 effect 重跑，又发了一次 room:join，玩家回到自己刚离开的座位，房间因此不会「全员离开 → 自动存档并关闭」。改为用 ref 取 t，effect 只随房间号 / 身份变化；`routes.dom.test` 加回归用例（切繁体 → leaveRoom → 切回简体，进房请求仍只有一次）。
- **房间授权被刷到 429**：`InviteLink` 一挂载就生成房间授权（写库，每 IP 每小时 30 个）。经典布局左栏的「邀请朋友」改为展开时才挂载（`classic/SideRails.tsx` 的 InviteDetails），对局页每次载入 / 重连不再各生成一个没人用的授权；`AccessControl` 增加 `grantsPerHour`，`RICH4_TEST_MODE` 下放宽到 100 倍（E2E 的所有页面都来自 127.0.0.1，大厅里每个玩家的邀请框都会自动生成授权）。
- **演出弹窗挡住原版 FLIC**：神明附身等事件的弹窗与神明降临 FLIC 并行，弹窗居中叠在整页上，手机横屏时整个挡住 FLIC。`PopupLayer` 增加 `placement: 'board'`：经典布局把弹窗放进棋盘视窗叠层的下部，按视窗缩放（桌面 1、844×390 约 0.69，下限 0.5），终局画面仍居中；公开竞价横幅留在叠层之外（`classic.dom.test` 加用例）。
- **旋转状态**：`BoardSurface` 增加可选的 `onRotated`，`GameScreen` 在棋盘就绪时接上（渲染器自己处理 `<` `>` 热键时同步小地图与旋转钮）。
- **繁体用字**：`zhTw.ts` 词汇表加「托管 → 託管」（opencc twp 对「进入托管」保留了「托」，与工具列、座位标签的「託管」不一致），重新生成 zh-TW；`skin/theme.ts` 切语言时同时设 `document.title`（`DOC_TITLES`）。
- **E2E 断言过时**：`skin-pack-load.spec` 第 1 段改为断言原版棋盘（board / boardInUse 为 original、`data-layout=classic`、设置页没有回退原因）。
- **server-real 偶发失败**：`integration/minigame.test.ts` 在传送到小游戏格前先 `debug:act clearBoard`（开局随机摆在路上的恶犬是路上神明，偶尔正好在落点附近把人咬进医院，等不到 MINIGAME 决策）；连跑 3 次通过。

### 23.3 原版皮肤 E2E（合成素材包）

- **配置** `e2e/playwright.original.config.ts`：与默认配置同一套用例；服务器 `RICH4_ASSETS_DIR=.cache/synthetic-pack`（启动前 `npm run extract -- assets synth` 现场生成，全为自绘图形）、`ACCESS_MODE=passcode`（测试专用口令，哈希用固定盐确定性生成：配置在 runner 与 worker 各载入一次），并设 `RICH4_E2E_PASSCODE` / `RICH4_E2E_SKIN=original`；端口 3110 / 5184、构建目录 `.cache/e2e-original/dist`，可与默认配置同时跑；视口 1920×1080（1280×800 时经典布局两侧收成抽屉，座位条不可见）。
  用法：`CI=1 npx playwright test -c e2e/playwright.original.config.ts [lobby turn-cycle cards events minigame reconnect save-load]`。
- **夹具**（`e2e/fixtures/room.ts`）：`SKIN_ORIGINAL`、`zh(简, 繁)`（对局页文字按皮肤取写法）、`expectOriginalSkin(page)`；原版模式下 `startGame` 对每个页面断言确实用了原版棋盘、经典布局与繁体界面。
- **用例适配**：events / save-load / bank-stock / timeout-ai / chat-spectate 的界面文字改用 `zh()`；只适用于默认配置的 3 个用例在原版模式下跳过（skin-original-board、skin-procedural-fallback 需要不带素材包的服务器；chat-spectate 断言程序化布局的顶栏与玩家条气泡，经典布局的观战与聊天由 skin-classic-shell 覆盖）。
- **结果**：原版配置全量 26 个用例 23 过、3 跳过（任务要求的 lobby / turn-cycle ×2 / cards ×2 / events / minigame / reconnect / save-load ×2 共 10 个全部通过）；默认配置全量 26 个全过。

### 23.4 本机实测（真实素材包 rich4-assets + 口令门禁，台湾图 4 人：本人 + 3 电脑，原版节奏）

- **方式**：`test/w2-play-dev.sh` 起服务器（`RICH4_ASSETS_DIR=./rich4-assets ACCESS_MODE=passcode`，口令、哈希与密钥由 `scripts/access.ts` 生成在 `.cache/w3/`）与 vite dev；`test/w2-play.mjs` 用本机 Chrome 开局，本人回合点经典外壳的 GO 钮与对话框 DOM（`--cover` 时按天用 debug:act 发卡 / 传送，走 DOM 出陷害卡、放路障、买股票、踩自己的地升级），记录事件类型、原版舞台播放的 FLIC、决策种类、音频日志与控制台错误，首次出现的 FLIC 与决策各截一张图；浏览器面板用于目视静态画面（面板隐藏时页面被判为后台，演出走 instant，逐帧演出看无头截图）。
- **场次**：桌面 1920×1080 22 天两场（自然对局 9.4 分钟；带补充动作 8.2 分钟）；手机横屏 844×390 22 天两场（8.6 / 8.2 分钟）；另有两场调试补充动作用的短局。四场 22 天的对局控制台 0 错误（第一场手机局中途改前端代码触发 HMR，只有 React 依赖数组长度变化的开发期告警）、没有看门狗中止、没有 handler 出错。
- **覆盖**：买地、升级（UPGRADE_LAND）、过路费与免付、银行 ATM / 柜台、股票（认购、买卖、董事长、分红、休市）、卡片（陷害卡 → 入狱 + 警车 FLIC、均富卡、乌龟卡、同盟卡等）、道具（路障、定时炸弹、机器娃娃）、神明（附身 / 发威 / 显灵 / 离开，大小财神、福神、天使、衰神、恶魔、恶犬）、新闻命运（法院拍卖、特赦、强烈地震、台风 STRIKE）、关押（坐牢、住院、获释回到棋盘）、拍卖竞价、乐透开奖、魔法屋；FLIC：开局棋盘伞（角色 0 / 3 / 4 / 5 / 11）、神明降临 10 种（天使、大小财神、大小福神、大小衰神、小穷神、土地公、恶魔）、神明离身烟雾、救护车、警车、小爆炸（地雷 / 路面炸弹）、瓦斯爆炸（身上炸弹）、台风、得卡、得点券。
- **音频**（桌面带补充动作那场）：引擎 running；棋盘曲 track02 → 03 → 04 轮播；进医院 / 魔法屋 / 监狱 / 银行分别切 track26 / 17 / 25 / 14，离开后棋盘曲从断点续播；语音 33 句、音效 289 次。
- **目视结论**：棋盘、建筑、景观、主人标记（每个角色自己的标记：约翰乔牛仔帽、阿土伯斗笠、孙小美红鞋）与原版一致；镜头随当前行动者（逐回合测得镜头中心与行动者锚点相距 0–10 源像素）；跳伞 FLIC 从视窗上方落到落点；神明、救护车、警车 FLIC 在棋盘视窗中央 / 角色处播放，弹窗移到视窗下部后不再挡住；手机横屏两侧收成抽屉，决策对话框覆盖工具列以下整个舞台。截图：`.cache/w3/play-desk-final/`、`.cache/w3/play-mobile-final/`（含原版素材，不入库）。

### 23.5 验证

- `npm run check` 全绿：typecheck、lint（1080 个文件）、vitest 267 个文件 2562 通过 1 跳过；check-determinism OK（193）、check-no-original OK（1302）、check-deps OK（1023）、zh-TW 最新（16）。
- client-browser：10 个文件 41 通过 1 跳过。
- E2E：默认配置 26 过；原版配置 23 过 3 跳过。

### 23.6 遗留

- 决策对话框、目标选择面板、演出弹窗、回合横幅仍是程序化样式（原版风格对话框与场所屏属 A11 / A12）；手机横屏时回合横幅占视窗比例偏大。
- 合成素材包不含音频，E2E 仍只覆盖 ZzFX 回退；原版声音只在本机实测里核对。
- 标题 / 选人 / 开局设定 / Loading / 片头（A14）未做：大厅与首页仍是程序化主题与简体。
