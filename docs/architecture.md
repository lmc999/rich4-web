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
  timerPreset: 'fast'|'normal'|'slow'|'off';       // 默认 normal；单机默认 off；只有一名真人时实际不计时（§5.9）
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

- **有效计时档位**：截止时间按 `effectiveTimerPreset(settings.timerPreset, 真人座位数)` 计算——真人座位 ≤ 1 时为 off（只有一名真人、其余都是电脑的房间和单机一样不限时）；托管中的真人算真人，电脑补位、被踢、对局中离开的座位与已淘汰（破产、投降）的真人不算。对局中有人离开 / 被踢 / 破产 / 投降 / 回来使结果改变时重新计算当前待决策的截止时间（design/net.md §5.4），`RoomView.effectiveTimerPreset` 下发结果。
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
- 交付: tools/extract/test/local/taiwan.local.test.ts（原计划放在 packages/shared/src/data/maps/，实际随提取器的本地测试放在 tools/extract）、engine/golden/taiwan.test.ts；tools/extract/maps/taiwan.overrides.json 定稿；docs/VERIFY.md 中 V-R 条目的状态；docs/DEVIATIONS.md 定稿；rich4-data/ 本机数据包
- 验证: 1) npm run extract -- all && npm run extract -- pack --out rich4-data/ 返回 0。2) RICH4_DATA_DIR=./rich4-data npx vitest run --project shared -t taiwan 通过：validateMap 无 error、计数正确、三组样本正确、有 2 处封路，golden 事件序列快照稳定；未提供数据时这些测试自动 skip。3) RICH4_DATA_DIR=./rich4-data npm run sim -- --map taiwan --games 1000 --workers 8 --policy original 输出 rejects=0，结束率达标。4) 手动：RICH4_DATA_DIR=./rich4-data npm run dev，选台湾图开局，对照 .cache/extract/preview/taiwan.svg 和原版截图，检查朝向、路网、地块和企业位置。5) VERIFY.md 中每个 V-R 条目都有结论，或已明确标为「按默认 ⚑ 保留」。

### M10 体验打磨：美术、音频、横屏、完整 E2E 与性能
- 范围: 程序化美术迭代：建筑等级外观、12 个角色的 rig、神明、NPC；AudioEngine、BGM 与 SFX 素材登记、ZzFX 预设、角色咕哝音；手机横屏细节，包括 safe-area、捏合缩放、44px 触控目标；三档画质与自动选档；WebGL 上下文丢失后重建；Credits 页面；角色名 original/alt 切换；性能与首屏包体积预算；完整 E2E 与视觉回归。
- 交付: apps/client/src/game/procedural/**、audio/**、assets/credits.json、scripts/check-credits.ts；i18n/locales/zh-CN/characters.{original,alt}.json；e2e/specs/{solo-soak,mobile-layout,visual}.spec.ts；scripts/check-bundle.ts
- 验证: 1) 在 mcr.microsoft.com/playwright:v1.63.0-noble 容器中执行 npm run test:e2e，全部 12 个 spec 通过，visual 基线稳定。2) npm -w @rich4/client run build && npm run check:bundle：首屏 JS gzip 后不超过 450KB。3) npm -w @rich4/client run check:credits 通过，每个素材都已登记且许可证在白名单内。4) npm run test:e2e -- e2e/specs/mobile-layout.spec.ts：iPhone 15 横屏时主要按钮可见且可点，竖屏时出现旋转遮罩。5) 手动：在 iOS Safari 和 Android Chrome 真机横屏各打一整局，覆盖音频解锁、切到后台再回来触发 resync、捏合缩放；用 VITE_NAMESET=alt 构建后角色名全部替换；打开 ?bench=1 自动对局 60 秒，帧时间 p95 小于 20ms。

### M11 Docker 部署与上线
- 范围: Dockerfile（node:24-slim 三阶段构建）、.dockerignore、deploy/docker-compose.yml（app 加 caddy；/data 读写，/data-rich4 只读）、Caddyfile、nginx 示例配置、.env.example；每日备份；优雅停机；压测；上线检查清单（HMAC 密钥、ADMIN_TOKEN、TRUST_PROXY、域名与证书）。
- 交付: Dockerfile、.dockerignore、deploy/{docker-compose.yml,Caddyfile,nginx.conf.example,.env.example}；apps/server/scripts/loadtest.ts；docs/deploy.md（数据包 rsync 流程与运维说明）
- 验证: 1) docker build -f deploy/Dockerfile -t rich4:local . 成功（Dockerfile 实际放在 deploy/，见 §25）。执行 docker run --rm rich4:local sh -c 'find / -xdev \( -iname "*.mkf" -o -iname "rich4.exe" -o -name "taiwan.map.json" \) 2>/dev/null | wc -l'，输出应为 0，确认镜像里没有任何原版派生数据。2) cp deploy/.env.example deploy/.env 并填好密钥，执行 docker compose -f deploy/docker-compose.yml up -d；然后 curl -kfsS https://localhost/healthz 和 https://localhost/readyz 都返回 200，curl -kfsS https://localhost/api/maps 的结果里有 taiwan。3) E2E_BASE_URL=https://localhost npm run test:e2e -- e2e/specs/turn-cycle.spec.ts e2e/specs/reconnect.spec.ts 通过。4) 对局进行中执行 docker compose -f deploy/docker-compose.yml restart app，客户端能自动恢复（epoch 加 1，玩家重连后对局继续）。5) npm run loadtest -- --url https://localhost --rooms 200：/admin/stats 中事件循环延迟 p99 小于 50ms。6) 运行满 24 小时后，/data/backup/ 下出现 rich4-YYYYMMDD.db。


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
- 界面音（`director.uiCue`：按钮、倒计时最后 5 秒）尚未接到组件（倒计时提示音已由 §26 接上：中央倒计时最后 10 秒 `countdown` / `countdownFinal`）；他人的保释 / 小游戏场所曲只在本人决策时播放；隐藏标签页 EventPlayer 走 instant，不放事件声音（设计如此）。
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

## 24. 原版皮肤第三波接通与 M9 台湾图终验（2026-09-28）

本轮把第三波（地基 ui/classic/common + decisions、A11 通用对话框与弹窗、A12 两组场所屏、A13 小游戏原版视图、A14 标题 / 选人 / 开局设定 / Loading / 片头）接成一条完整流程，修掉接缝上的问题，完成 M9 台湾图终验（golden + 实机核对清单），并在本机真实素材包上从门禁页走到终局。素材包内容与含原版素材的截图始终不入库（`.cache/w3/`）。

### 24.1 接通

- **决策注册表**（`ui/classic/decisions/registry.ts`）：23 种 DecisionKind 全部有原版场景，dialogs 16（TURN_MENU、BUY_LAND、BUY_FACILITY、UPGRADE_LAND/FACILITY、BUILD_FACILITY、FACILITY_TYPE、RESEARCH、USE_FREE_CARD、SCAPEGOAT、DEATH_GOD_TARGET、DISCARD_CARD、BIRTHDAY_PICK、SUBSCRIBE_SHARES、CONSTRUCTION_PICK、MINIGAME）+ venues/a 4（BANK_ATM、BANK_COUNTER、SHOP、LOTTERY）+ venues/b 3（MAGIC_CAST、AUCTION_BID、BAIL），三处合并无冲突（`decisions.dom.test` 新增「23 种全部登记」断言）。**没有常驻回退到 React 对话框的种类**；只在以下情况整体回退程序化对话框：没有素材包或皮肤判定为程序化、所需逻辑键缺失 / 所在组缺失 / 置信度 guess（本机真实素材包里 23 种的必需键全部可用：guess 条目只有角色表情、工程车姿势、部分 FX、命运插图与乐透彩带，都不是必需键）、精灵加载失败、准备超过 4 秒、场景渲染抛错。TURN_MENU 的股市（Panel#75）与公佈欄（Panel#73）是回合菜单的子页（`dialogs/TurnMenuFull.tsx` 套 ClassicStockSheet / ClassicBoardSheet），缺任一套素材时整个回合菜单回退。原版场景里没有原版图的次要按钮（乐透「機選 / 不買」、拍卖「按起拍价出价」、公佈欄的挂牌 / 买下 / 翻页、回合菜单的「股市 / 公佈欄 / 投降」木牌）是同色系 CSS 文字钮，属于场景的一部分，不算回退。
- **观战版拍卖厅**：新增 `ui/classic/AuctionWatch.tsx`（AuctionWatchMount），经典布局在拍卖进行中（公开竞价横幅或别人有 AUCTION_BID）而本人没有任何决策时，在舞台上叠 venues/b 的只读 ClassicAuctionWatch；本人在横幅里仍是竞拍中时也不显示（两次重问之间不闪）；素材（拍卖厅图集 + 在场玩家的 Q 版小人）不可用就不挂，只剩公开竞价横幅。
- **弹窗**：PopupLayer 的 board 放置位置懒加载 `ui/classic/popups/ClassicPopupHost`（A11）：新闻板、神明 / 老虎机、出卡、终局排名换原版画面（命运插图与各条命运的对应未核实，命运整体回退程序化弹窗）；轮盘、月结颁奖在事件之后演出；工具列的查询 / 托管 / 存读档换成原版资产表、托管对话框、Data#479 存读档窗。乐透开奖 → venues/a 的 ClassicLotteryDraw，本轮补上 `minMs` 与 `onSkip`（原版演出盖住了弹窗层的「跳过」，改用场景自带的 lottery-draw-skip）。
- **小游戏**：MINIGAME 的原版场景（dialogs/Minigame.tsx）→ `startPlayerMinigame`；宿主按皮肤选原版视图（A13，入场 READY GO 在开局前播完，DEV-19），观战与回放同样走原版视图；GameScreen 进入对局时 `installMinigames`。
- **标题 / 选人 / 大厅**：routes 的首页、房间、单机三条路由换成 SkinHome / SkinRoom / SkinSolo（A14），判定只看素材包；进入对局后画面选择固定。
- **场景音乐**：沿用 app/audioWiring 的 UI 状态 → 场景曲（标题 track10、开局设定、棋盘轮播、各场所曲、结算）。本轮补：片头播放期间（`uiStore.introPlaying`，IntroVideo 挂载时置位）标题画面按 `screen: 'none'` 不放曲，片头结束才放标题曲（A14 遗留）。
- **门禁浮层**：`mountAccessGate` 自挂的全屏门禁浮层（standalone）在页面另有宿主（房间页、对局页）时让位（accessStore 记 `hosts`），同一时刻只有一份门禁页（A14 遗留）。
- **文案**：classic 命名空间补 `calc.clear / calc.back`（计算器与 ATM 的 C、← 键读屏名称，原先是字面「C」与借用的「删除」），zh-TW 由 gen-zh-tw 生成。

### 24.2 本轮修复

- **回合菜单退场中又展开，子页请求丢失**（真实素材包巡检发现）：Esc 收起回合菜单后、退场动画还没播完就点工具列的股市 / SALE，退场中的旧层取走了子页请求，新展开的回合菜单只剩默认的卡片欄；而且 motion 的 AnimatePresence 对「同 key 子元素在退场中重新加入」处理不好（退场播完后整层消失，直到下一次重渲染）。ClassicDecisionLayer 改为：回合菜单每次展开用新 key（`seat:TURN_MENU:<展开次数>`，其他种类仍按「座位:种类」保留同一实例，拍卖重问不重建场景），退场中的层不再接子页请求。E2E `skin-classic-dialogs` 新增回归用例（房主页带界面动画）。
- **开局 Loading 只见黑底文字**：Data#560 整图在对局页挂上 Loading 时才开始下载。选人大厅挂载时先 `ensureClassicImage(title.loading)` 并用 `new Image()` 把整图下载进浏览器缓存。
- **手机紧凑工具列「更多」里的 LOAD / SAVE**：原版存读档窗原先由 ClassicPopupHost 在 document 捕获阶段截下工具列点击（A11 的重定向），菜单项自己的 onClick 因此不执行，「更多」菜单不收起、Esc 关不掉存读档窗。改为显式的请求通道 `ui/classic/popups/screenRequests.ts`：ClassicLayout 的 onTool('load' | 'save') 先 `requestClassicScreen`，ClassicPopupHost 登记的处理函数在素材就绪时接管并返回 true，否则外壳照旧开程序化存读档窗；去掉 document 级的点击捕获。
- **大厅座位牌文字溢出到相邻牌**：`.plateSeat` 改 `grid-template-columns: 44px minmax(0, 1fr)` + `overflow: hidden`，长昵称与电脑个性在牌内省略。
- **过时与偶发的测试**：`decisions.dom.test`「未登记的 kind」改注入空注册表；`skin-classic-shell` 的「查询」接受原版资产表或程序化面板；`bank-stock` 的 P2 改停 4 号卡片格（2 号新闻偶发法院拍卖，同 venues-a）；server 的 `full-game-4p`（房间种子随机，资金 1 万时偶尔以 lastStanding 提前结束，实测 89–96 批）只对打满 30 天的对局要求批次数 > 100。
- **文档**：design/minigames-ai.md 与 research/r_minigames_chars.md 按 exe 更正「企鹅记忆阶段亮出种类」（0x413f39(1)）与「接物者（不是财神）按分数换表情」（0x414a10）；DEVIATIONS 新增 DEV-19（READY GO 在开局前播完）、DEV-20（程序化皮肤的企鹅记忆阶段仍只画土堆）。

### 24.3 M9 台湾图终验：golden

- `packages/shared/src/engine/golden/taiwan.test.ts`：有 `RICH4_DATA_DIR`（相对路径按当前目录与仓库根解析，要有 manifest 里的 taiwan 条目）时，在台湾图上用固定种子跑 4 局 4 电脑对局（30 / 91 / 182 / 365 天；角色各不相同；最后一局第 268 天以 lastStanding 结束）。四个座位都由 OriginalAiPolicy 代打，rng 派生与服务器 AiDriver 相同（座位视角 projectState + makeAiContext）；每一步 `checkInvariants`、每 50 步 `explainState`，AI intent 被拒 0 次；同一种子重跑一遍结果完全相同。
- 快照 `golden/__golden__/taiwan.json` 只含哈希、计数与事件类型名（ENGINE_VERSION、mapHash、每局的 actions / days / reason / 事件总数 / 各类型次数 / 前 160 个事件类型 / 每 400 个事件的链式哈希 / 终局状态哈希），不含原版数据；check-no-original 放行。数据包 mapHash 与快照不同时 skip 并提示重新生成；ENGINE_VERSION 与快照不同时失败（规则变更升版本要一起刷新）。缺数据（CI）时整组 skip。
- 刷新：`RICH4_UPDATE_GOLDEN=1 RICH4_DATA_DIR=./rich4-data npx vitest run --project shared src/engine/golden/taiwan`。
- 2026-09-30 起泛化为 `golden/maps.test.ts`，四张原版图表驱动，刷新时必须用 `RICH4_GOLDEN_MAPS` 点名要重写的图（§27.6）；taiwan.json 内容不变。

### 24.4 实机核对清单

- 新增 `docs/verify-checklist.md`：VERIFY 里方式含 P 且未 ✅ 的 V-R1–V-R28（外加 V-E4、V-C3）逐项写清在原版 v2.06 里怎么操作（开局设置、怎么弄到卡与道具、存档复现、计数方法）、观察什么、我们当前的默认行为与对应的 RuleConfig 开关；另附原版界面的目视项 V-U1–V-U12（只影响画面）。
- `docs/VERIFY.md`：开头链接核对手册；V-R18 改 🟡（图标帧号已由 exe 载入点定出，名称与分值待截图）；新增「原版界面（V-U）」一节与「终验记录」（M9 golden）。

### 24.5 本机真实素材包巡检（rich4-assets + 口令门禁 + 台湾图，生产构建）

- **方式**：`test/w3-tour.spec.ts` + `test/w3-tour.config.ts`（服务器 :3519 挂 `RICH4_ASSETS_DIR=./rich4-assets`、`RICH4_DATA_DIR=./rich4-data`、`ACCESS_MODE=passcode`、`RICH4_TEST_MODE=1`；前端先 `vite build` 再 `vite preview` :5519——巡检期间改前端源码不会触发 HMR 整页重载）。房主 + 经邀请链接进房的 P2 + 2 个电脑，原版节奏，带声音；P2 平时由脚本代打，需要它出场时暂停。房主按回合用 debug:act 传送 + 强制骰子触发场景，每步截图，失败只记日志并按默认处理恢复。两种视口各跑一遍：desk（房主 1920×1080、P2 844×390）与 mobile（房主 844×390、P2 1920×1080）。截图与 summary.json 在 `.cache/w3/tour-{desk,mobile}*/`（含原版素材，不入库）。
- **覆盖**：门禁页 → 片头（Start.avi，可跳过）→ 标题（OPTION 面板）→ 开局设置（台湾、2 电脑、胜利条件 10 倍）→ 选人大厅（邀请链接带 `#g=` 授权，P2 经片段过门禁进房、选角、准备）→ Loading（Data#560）→ 对局；回合菜单卡片欄 / 道具欄、股市（行情表与详情）、公佈欄（板面与类别）、资产表、存读档窗、托管对话框、查税卡目标面板与出卡演出、买地、升级、银行 ATM 与柜台、商店（卡片 / 道具两页）、乐透投注（号码 + YES/NO）与开奖（摇奖机 FLC）、魔法屋（悬停提示、确认、施法 FLC）、监狱（保释 / 雇恶人）、医院、新闻板、命运板、拍卖（P2 的原版拍卖厅竞价 + 房主的观战版拍卖厅）、买设施、兴建设施、轮盘（旅馆盘）、老虎机（小财神）、月结颁奖、三个小游戏（原版视图：READY GO、游玩、结算大号分数）、投降与死神附身对象、终局排名。
- **结果**：遇到的 17 种决策（TURN_MENU、BUY_LAND、UPGRADE_LAND、UPGRADE_FACILITY、BANK_ATM、BANK_COUNTER、SHOP、LOTTERY、SUBSCRIBE_SHARES、MAGIC_CAST、BAIL、AUCTION_BID、BUY_FACILITY、BUILD_FACILITY、FACILITY_TYPE、MINIGAME、DEATH_GOD_TARGET）在各次巡检里全部是原版场景（多数种类两种视口都出现过；房主与 P2 两页分别记录），0 次回退；三个小游戏都是 `data-view=original`；控制台 0 错误（pageerror / console.error / 看门狗 / 场景回退告警都没有）。音频引擎 running：棋盘曲 track03→04→05 轮播，进银行、商店、乐透、魔法屋、监狱、医院、拍卖、小游戏时切到场所曲，离开后棋盘曲从断点续播；语音与音效正常触发。
- **巡检发现并已修复**：回合菜单退场中又展开丢子页请求（24.2 第 1 条）；Loading 只见黑底；大厅座位牌文字溢出；手机「更多」菜单里的 LOAD / SAVE（24.2）；观战版拍卖厅的卖方显示为「无（公开拍卖）」（拍卖卡拍无主地时地块没有主人：改用公开竞价横幅的 sellerName）、顶部状态条压住价格牌标题（竞价中领先者已写在价格牌上，状态条只在成交 / 流拍时显示）；价格牌标题「台北市 2 0 級」易读成「20 级」（地名与等级之间加分隔点）。
- **没有触发到的决策**（巡检里自然对局没遇到，由 DOM 测试与合成包 E2E 覆盖）：RESEARCH、USE_FREE_CARD、SCAPEGOAT、DISCARD_CARD、BIRTHDAY_PICK、CONSTRUCTION_PICK。
- **巡检脚本自身的失败**（不是产品缺陷）：电脑对房主用了停留卡、偶发地让强制骰子没走到目标格；小财神当时不在路上；只剩一个真人时不能投降（`canSurrender` 要求至少两个真人，按设计），终局改用「资产 10 倍」胜利条件触发；两次巡检共用服务器时先结束的一方会关掉服务器。

### 24.6 验证

- `npm run check` 全绿：typecheck、lint（1223 个文件）、vitest 290 个文件 2850 通过 2 跳过（台湾 golden 在没有 RICH4_DATA_DIR 时整组 skip）；check-determinism OK（193）、check-no-original OK（1499）、check-deps OK（1155）、zh-TW 最新（17）。
- 台湾 golden：`RICH4_DATA_DIR=./rich4-data npx vitest run --project shared src/engine/golden/taiwan` 通过（4 局，AI intent 被拒 0 次）。
- client-browser（`RICH4_CHROMIUM_PATH` 指向 chromium-1228）：12 个文件 60 通过 1 跳过。
- E2E 默认配置（`CI=1 npx playwright test -c e2e/playwright.config.ts`）：38 通过、2 跳过（skin-classic-venues-a 只在原版配置下跑）；原版皮肤配置（`-c e2e/playwright.original.config.ts`，合成素材包 + 口令门禁）：37 通过、3 跳过（chat-spectate、skin-original-board、skin-procedural-fallback 只适用于默认配置）。两套都含新增用例 `skin-classic-dialogs`「回合菜单 Esc 收起后（退场动画中）立即从工具列打开股市、公佈欄」。

### 24.7 遗留

- 只在本人的决策上显示原版场景：别人（含电脑）的场所决策只有拍卖有观战版；原版「所有人同屏看场所屏」的其余场所（银行、商店、乐透、魔法屋、监狱医院）观战者仍只看到棋盘与横幅。
- 手机横屏（倍率 0.8125）下原版 12px 正文约 9.75 CSS 像素，讲话框与提示框偏小；计算器数字键与 C / ←、货架行、号码格、股市行做不到 44px，靠透明数字框与原生下拉框代替（地基与 A12 遗留；计算器 MAX / ↵ 已补到 44，见 24.8）。
- toast（「開始拍賣」「進入小遊戲」等）叠在原版场景顶部，偶尔压住场景标题。
- 原版场景里没有原版图的次要按钮是 CSS 文字钮；MINIGAME 开局对话框只有「不玩了」（倒计时结束自动开局）。
- 原版界面坐标与语义的目视项见 VERIFY「原版界面（V-U）」与 verify-checklist §4；规则实机项见 verify-checklist §2。

### 24.8 第三波复核修复（2026-09-28）

- **焦点与热键**：Stage4x3 弹出时焦点若在场景外的文字输入元素（聊天框等 INPUT / TEXTAREA / SELECT / contenteditable）上就不抢焦点（`common/focus.ts`）；YesNoBox 的 Y / N 只认焦点在所属场景里的按键（不认落在 body 上的），← → 仍可在 body 上移焦点。回归：聊天框里打 `you` 不再买下地。
- **手机热区**：回合菜单一排文字钮只往上补（正下方是卡片欄）；场景关闭钮从场景顶边往下补到 --hit（存读档、托管窗）；计算器 MAX / ↵ 的扩展区往上盖过计量条到 56 逻辑像素（手机上计量条只显示，数值用液晶屏输入框或 MAX 设定，C / ← 由输入框的系统键盘代替）；股市 EXIT、「卖出」只往下补；开局设置「快速局」与行高同为 56；大厅抽屉里的「允许观战」行与勾选框 44。E2E（screens、venues-a）量了这些控件。
- **整体回退**：命运插图对应未核实（guess），命运弹窗整体走程序化（删掉原版紫板上的程序化问号插图）。
- **场景逻辑**：百货「卖道具」货架分页（持有种类可到 13 种，一页 8 行），原生下拉框列出全部；认购场景计算器、消息框与 YES 提交同一个数（清到 0 时 YES / ↵ 不可按）。
- **路由**：素材包发现的等待起点全局共用（之后的路由不重新等 6 秒）；`usePinnedScreens` 让首页 / 房间大厅 / 单机页离开 pending 后固定画面（超时判成程序化后素材包才就绪不再中途换画面；单机页连降级也不换），改皮肤设置或门禁状态时重新判定；房间页判定中先进房，已在对局中就不等判定直接挂对局页；对局页地图载入前沿用当前主题（不再 zh-TW → zh-CN → zh-TW 闪一下）。
- **工具列接管**：资产表、托管对话框的精灵还在加载时先收起程序化面板，等精灵就绪（最多 3 秒）再开原版界面，等不到才照旧开程序化面板。
- **小游戏**：回放模式开播前至少留够入场 FLC 时长（READY GO 从第 0 帧播）；喜从天降 HUD 时间按 timeLeft / 2 向下取整；被炸爆炸借用 Data#485 的依据补上（fcn.00414f20 @0x415016 载入、fcn.00412b66 @0x412d2b 播放，写进 frames.ts 与 catalog）。
- **文档与测试**：轮盘资源号顺序更正为航空 / 旅馆 / 购物中心 / 保险（ui.md、original-skin.md §4.2、catalog 描述）；合成包里与原版不同的取值（大号数字、接物者、转盘锚点）不再标「同原版」；skinStore 重置后才完成的旧 PackClient import 作废（修掉 screens 片头 dom 测试随文件组合变红）；skin-classic-venues-a 改为 page.route 供包，默认配置（CI）也跑，并断言股市是原版场景；新增原版存读档窗（真服务器存档）、出卡演出、观战版拍卖厅、15 日乐透开奖与 1 日月结颁奖的 E2E（终局排名仍只有 DOM 测试与巡检覆盖）；外壳 E2E 只认原版资产表；小游戏手机用例改为页面内探针量尺寸并点「不玩了」；cards.spec 在原版配置下偶发（本轮复跑稳定复现）撞上回合菜单的退场层（decision-TURN_MENU-exit 里有同名 inv-card-*），改为先等退场的原版场景卸载再展开。VERIFY V-R4 / V-R12 / V-R17 补上「⚑ 保留」结论，verify-checklist 补齐 V-C3、V-U2 子项与本机原版皮肤的启动命令。
- **验证**：`npm run check` 全绿（vitest 291 个文件 2863 通过 2 跳过）；client-browser（minigames、ui/classic）通过；E2E 默认配置 42 通过（skin-classic-venues-a 不再跳过）、原版皮肤配置 39 通过 3 跳过（只适用于默认配置的 3 个）。

## 25. M11「Docker 部署与上线」实施记录与本机实机验证（2026-09-28）

本轮完成 M11 的交付物，并在本机 Docker Desktop 上按「### M11 Docker 部署与上线」的 6 条验证逐条实跑，另做生产形态检查、备份恢复演练与原版皮肤浏览器巡检。环境：compose 项目 `rich4-m11`，只绑 `127.0.0.1:8080/8443`，口令门禁 + 真实素材包 `rich4-assets`（packId e6f3322db57bdedd）+ 台湾图 `rich4-data`。密钥与口令都在本机随机生成，只放在 `.cache/m11/`（不入库、不进镜像）；截图与日志在 `.cache/m11/`。上线步骤、检查清单、运维与故障排查见 `docs/deploy.md`。

### 25.1 交付物

- **镜像**：`deploy/Dockerfile`（node:24-slim 三阶段；构建上下文与构建产物各查一遍原版文件与派生数据；deps 阶段 `--ignore-scripts` 并删掉类型声明、source map、文档；OCI label；以 node 用户运行，`/data` 属主 node）；根目录 `.dockerignore`；`deploy/scan-image.sh`（最终文件系统、`docker history`、`docker save` 逐层三道扫描，含先加后删的层）。
- **编排**：`deploy/docker-compose.yml`（端口 `HTTP_PORT` / `HTTPS_PORT` / `BIND_ADDR` 插值；app 以 `/readyz` 做健康检查，caddy 等 app 健康后才启动；json-file 日志轮转；根文件系统只读、去掉全部 capability、禁止提权；`stop_grace_period: 30s`）；`deploy/docker-compose.e2e.yml`（只限本机：127.0.0.1、`SITE_ADDRESS=localhost`、`RICH4_TEST_MODE=1`，env 只读 `.cache/m11/e2e.env`）；**新增** `deploy/docker-compose.nginx.yml`（已有 nginx 的主机：不起 caddy，app 发布到 127.0.0.1:3000）；`deploy/Caddyfile`（安全响应头、去掉 Server / Via、HSTS 只发给非 localhost、请求体 4 MB、/pack 不再压缩）；`deploy/nginx.conf.example`；`deploy/.env.example`。
- **服务器**：`config.ts` 新守卫——`NODE_ENV=production` 下 `RICH4_TEST_MODE=1` 只在显式设置且为 localhost 的 `PUBLIC_URL` 下接受；测试模式把同 IP 的并发连接与建房额度放宽 100 倍（`app.ts` 的 `TEST_MODE_IP_RELAX`，压测与 E2E 都来自同一个 IP）。
- **压测**：`apps/server/scripts/loadtest.ts`（`npm run loadtest`），爬坡建房、稳态运行、读 `/admin/stats` 判定，收尾解散房间并核对房间数。
- **E2E 远程模式**：`E2E_BASE_URL` / `E2E_PASSCODE` / `E2E_RESTART_CMD`（`e2e/fixtures/remote.ts`、`access.ts`、`room.ts`），新增 `e2e/specs/deploy-restart.spec.ts`。
- **文档**：`docs/deploy.md`；design/net.md §8.5 补第 5 步（停机时 HTTP 连接的宽限与强制断开）。

### 25.2 与规格不一致之处

- **构建命令**：Dockerfile 放在 `deploy/`，验证 1 的命令是 `docker build -f deploy/Dockerfile -t rich4:local .`（M11 验证 1 已改正）。Dockerfile 不写 `# syntax=` 指令，免得构建时再拉 docker/dockerfile 前端镜像（基础镜像只用 node:24-slim 与 caddy:2），代价是要求 Docker 25+；审查修复后 compose 网络开启 IPv6（自动分配 ULA 子网、ip6tables 缺省开启），部署要求提高到 Docker Engine 27+（25.7）。
- **验证 2、3、5 的形态**：挂了素材包就必须开门禁，所以 `/api/maps` 要先用口令换 cookie，E2E 加 `E2E_PASSCODE`，压测加 `ACCESS_PASSCODE`（或 `--passcode`）与 `ADMIN_TOKEN`。E2E 要用 `debug:act`、压测的 200 个房间来自同一个 IP，两者都只在测试模式下可行，所以验证 2–6 对着 `docker-compose.e2e.yml` 起的实例跑，地址是 `https://localhost:8443` 而不是 `https://localhost`；不开测试模式的生产形态另做了检查（25.4）。
- **验证 6「运行满 24 小时」**：备份在启动 30 秒后第一次检查、之后每小时检查「当天是否已有」，所以起服 30 秒后就有当天的 `rich4-YYYYMMDD.db`（日期按容器时区 UTC），不用等 24 小时；另外补了恢复演练。
- **事件循环延迟的口径**：`/admin/stats` 用 `monitorEventLoopDelay({ resolution: 20 })`，读数包含 20 ms 的采样间隔本身（容器里空闲 p50 约 22–26 ms、p99 约 31 ms）。验收阈值 50 ms 与接口口径都没改（保守读数），在 deploy.md 注明。
- **规格之外新增**：`docker-compose.nginx.yml`（让已有 nginx 的主机不用改 compose 文件）、`RICH4_TEST_MODE` 生产守卫、测试模式放宽同 IP 额度、停机日志 `shutdown: rooms suspended`。

### 25.3 实机验证发现并修复的问题

- **优雅停机被 keep-alive 连接拖到 25 秒强制退出**：第一次跑验证 4 时，app 日志停在 `shutdown: notifying clients`，25 秒后 `shutdown timed out, forcing exit`，快照与自动存档那一步之后的关库都没走完（房间靠逐条写入的 journal 恢复，数据没丢，但重启停机 27.8 秒）。原因：`io.close()` 要等 HTTP 服务器的全部连接断开；Caddy 到 app 的 keep-alive 连接池里（重启前采样到 34 条），停机瞬间有请求在途的连接处理完后按 Fastify 的 keepAliveTimeout（72 秒）继续挂着，页面的重连请求又经它进来（engine.io 关闭后照样受理新握手）。修复（`app.ts` 的 close）：宽限期内每 100 ms 断开变空闲的连接，`SHUTDOWN_HTTP_GRACE_MS`（3 秒）后 `closeAllConnections()`；状态在此之前已刷盘。回归测试 `restart-recovery.test.ts`「优雅停机不被在途请求的 keep-alive 连接拖住」用一条只发了半截请求头的连接复现（修复前 20 秒超时，修复后按时完成并能恢复房间）。修复后 4 次 E2E 重启里有 2 次仍走到 3 秒强制断开（从 SIGTERM 到新进程监听 5.7–5.9 秒），另 2 次 0.2 秒内停完（约 3 秒）。**这次修复并不完整**（审查第 5 条）：已升级为 WebSocket 的连接不在 `http.Server` 的连接跟踪里，`closeAllConnections()` 断不开，不回应关闭帧的 WebSocket 仍会把停机拖满 25 秒；补救见 25.7。
- **WebSocket 被拦时前端不降级长轮询**：客户端 `transports: ['websocket', 'polling']` 而没开 `tryAllTransports`，engine.io-client 在 WebSocket 握手失败时直接报错重连，每次都只试 WebSocket。用 `test/m11-ws-block-proxy.mjs`（拦掉 Upgrade、其余转发给 Caddy 的本机代理）实测：60 秒内试了 12 次 WebSocket、0 次长轮询，建房一直超时。修复：`net/socketTransport.ts` 加 `tryAllTransports: true`（单测断言选项）；复测 `test/m11-ws-fallback.spec.ts`：WebSocket 被拦后走长轮询（11 个 polling 请求 200），2.5 秒建房进大厅。注意：握手失败后退到长轮询的那条连接不会再升级到 WebSocket，直到下一次重连。
- **停机日志**：补一行 `shutdown: rooms suspended`（房间数、对局中房间数、是否写快照与自动存档、耗时），运维能从 `docker compose logs app` 确认优雅停机走完了刷盘。

### 25.4 实测数据

- **镜像**（验证 1）：`docker images` 406 MB，压缩后约 91 MB，容器内 `du` 297 MB（本项目部分：node_modules 26 MB、public 17 MB（其中 193 个前端 source map 约 11 MB）、server 4 MB）；10 层。`deploy/scan-image.sh rich4:local` 退出 0（最终文件系统、history、全部 10 层都没有命中）；规格里的 `find / -xdev … | wc -l` 输出 0。
- **HTTP 面**（验证 2，`test/m11-final-http.sh`，28 项全部通过，最终镜像上复跑一遍）：`/healthz`、`/readyz` 200；门禁开启时 `/api/maps`、`/pack/manifest.json`、素材文件未带 cookie 均 401（401 也带 nosniff 与 CORP），错误口令 401；口令登录后 cookie 为 `HttpOnly; SameSite=Lax; Secure; Max-Age=2592000`，`/api/maps` 含 taiwan；manifest `private, no-cache`、按 Accept-Encoding 返回服务器预压缩的 br（Caddy 不再压）；素材包 mp4 与 m4a 的 `Range: bytes=100-1123` 经 Caddy 返回 206、`Content-Range: bytes 100-1123/<manifest 字节数>`、Content-Length 1024、不压缩，越界 416，素材文件 `private, max-age=2592000`；前端 JS 由 Caddy 压成 zstd、`public, max-age=31536000, immutable`，index.html `no-cache`；首页与 /api 带 nosniff、Referrer-Policy same-origin、X-Frame-Options DENY、CSP frame-ancestors 'none'，没有 Server / Via，localhost 不发 HSTS；HTTP/2；`/admin/stats` 无 token 401、带 token 200。
- **E2E**（验证 3）：`turn-cycle`（original / compact 两种节奏）与 `reconnect` 3 passed（1.2 分钟），修复后的最终镜像上复跑同样 3 passed。
- **重启恢复**（验证 4）：`deploy-restart.spec.ts` 共跑 6 次全部通过（修复前 2 次、修复后 4 次）：页面出现断线遮罩后自动重连、同房同座、epoch 恰好加 1、seq 不变、view 与 HUD 与重启前逐字相同、有 serverRestored 系统消息、对局继续。app 日志：`shutdown: rooms suspended {rooms, playing, snapshot:true, autosave:true, ms 9–19}` → `shutdown complete` → 新进程 `rooms restored [<code>:journal …]`。SIGTERM 到新进程开始监听：修复前 27.8 秒（1 次）或约 3 秒（1 次，碰巧没有在途连接），修复后 2.95–5.87 秒。
- **压测**（验证 5，`npm run loadtest -- --url https://localhost:8443 --rooms 200`，每房 1 个真人 bot + 3 个电脑，爬坡 20 秒、稳态 120 秒，经 Caddy；`test/m11-final-loadtest.sh` 同时每 2 秒采 docker stats），连跑两轮都 PASS：

  | 轮次 | 服务器事件循环 p99 / max | game:act ack p50 / p99 | app 容器 CPU 峰值（均值） | app 内存峰值 | caddy CPU / 内存峰值 | 错误 |
  |---|---|---|---|---|---|---|
  | 1 | 33.72 / 44.7 ms | 5.74 / 20.68 ms | 41.5%（29.1%） | 458 MiB（RSS 498 MB） | 7.5% / 154 MiB | 0 |
  | 2 | 32.10 / 39.06 ms | 5.88 / 22.89 ms | 39.1%（27.6%） | 476 MiB（RSS 517 MB） | 7.0% / 106 MiB | 0 |

  两轮都是 200/200 开局，ack 超时、app:error、seq 缺口、意外断线全为 0，收尾后房间数回到压测前（8，都是之前 E2E 留下的暂停房间）、连接数 0。容器里空闲时 p99 就有约 31 ms（macOS 上 Docker 虚拟机的调度抖动加 20 ms 采样间隔），负载只让它上升 1–3 ms，瓶颈不在服务器，没有做优化。
- **备份**（验证 6，`test/m11-final-backup.sh`）：首次起服 30 秒后 `/data/backup/rich4-20260928.db` 出现（node:node 644）。恢复演练：签发邀请码 before-backup → 让 app 重新写当天备份（8 个房间、408 个自动存档）→ 再签发 after-backup → 停 app、用一次性容器把备份拷成 `rich4.db` 并删掉 -wal / -shm → 起 app：启动日志恢复 8 个房间（epoch 各加 1），存档 408 个、邀请码只剩 before-backup，与备份一致。另外演练了从异地副本恢复（`docker compose cp` 拷出、app 停着时拷回数据卷），并确认恢复会撤销备份之后做过的吊销（epoch 回到 0），已写进 deploy.md。
- **生产形态**（只用 `deploy/docker-compose.yml`，`deploy/.env` 设 127.0.0.1:8080/8443、`SITE_ADDRESS=localhost`、`PUBLIC_URL=https://localhost:8443`）：容器里 `RICH4_TEST_MODE` 未设置、日志没有测试模式告警；`test/m11-final-prodcheck.ts`（用 Caddy 内部 CA 根证书正常校验 TLS）建房、补 3 个电脑、开局正常，`debug:act` 2 秒内没有 ack（未注册），正常对局推进到 seq 10。`ACCESS_MODE=off` 仍挂素材包：app 以 2 退出反复重启，日志「启用原版素材包（RICH4_ASSETS_DIR=/assets-rich4）时必须设置访问门禁：ACCESS_MODE=passcode 或 invite…当前不满足：NODE_ENV=production；TRUST_PROXY=1；HOST=0.0.0.0 不是回环地址；未设置 RICH4_ASSETS_ALLOW_UNGATED=1」，经 Caddy 访问 502。`RICH4_TEST_MODE=1` + `PUBLIC_URL=https://rich4.example.com`：以 2 退出，日志「环境变量无效：NODE_ENV=production 时 RICH4_TEST_MODE=1 只允许用于本机验证，PUBLIC_URL 必须显式设为 localhost…」。换回正常配置后恢复健康。管理接口：签发 / 列出邀请码、吊销后旧 cookie 401。`docker-compose.nginx.yml`：只起 app、发布在 127.0.0.1:3000，`/healthz` 200、`/api/maps` 401。
- **原版皮肤巡检**（`test/m11-tour.spec.ts`，真实 Chrome 经 Caddy 访问生产形态实例，截图在 `.cache/m11/tour/`）：桌面 1920×1080 走 門禁 → 片頭（跳过）→ 標題 → 開始遊戲 → 開局設定（台灣、3 電腦、不限時）→ 選人 → 開局 → Loading → 对局；手机横屏 844×390 走 門禁 → 片頭 → 標題 → 單機對戰 → 对局。最终镜像上两种视口各打 4 个本人回合，分别买地 2 块与 1 块；遇到的决策（BUY_LAND、BANK_ATM、LOTTERY，前一轮另有 BUY_FACILITY）全部是原版场景；控制台 0 错误；`/pack` 请求约 310 个（200 与 206），0 个 4xx/5xx；皮肤判定 applied=original、pack=ready、failedGroups 空、原版棋盘；手机横屏无横向滚动。门禁页本身是程序化画面（登录前拿不到素材包，按设计）。

### 25.5 验证

- `npm run check` 全绿：typecheck、lint（1229 个文件）、vitest 294 个文件 2882 通过 2 跳过（含新增的停机回归测试，server 与 server-real 各一遍；socketTransport 单测 6 通过）、check-determinism OK（193）、check-no-original OK（1535）、check-deps OK（1159）、zh-TW 最新（17）。收尾时有一次整体运行在 `server` 的 `integration/minigame.test.ts`「replay：不直播…」失败（`bombRun` 找不到可达的炸弹格，取决于随机的房间种子；该文件本轮未改动，单独连跑 6 次都通过），重跑全绿，记入遗留。
- Docker：`docker build -f deploy/Dockerfile -t rich4:local .`、`bash deploy/scan-image.sh rich4:local`（0）、规格的 `find … | wc -l`（0）；验证 2–7 的命令与结果见 25.4，日志在 `.cache/m11/final/`。

### 25.6 遗留

- `deploy/nginx.conf.example` 没有用 `nginx -t` 校验过（本机没有 nginx，按约束不用其他镜像），只做了人工审阅；真实域名下的 Let's Encrypt 签发、ICP 备案与 HSTS 也只能在云主机上验证（本机只有 localhost 内部 CA；HSTS 由上一阶段用临时 caddy + 内部证书的 rich4.example.com 验证过）。
- ~~前端构建开着 source map~~：已按用户决定（2026-09-28）去掉——`vite.config.ts` 默认不生成（本机排查用 `RICH4_SOURCEMAP=1` 构建），`deploy/Dockerfile` 构建后检查前端产物里没有 `*.map` 与 `sourceMappingURL=`；`/assets/` 同时排除在 SPA 回退之外，缺失的带哈希产物（旧 chunk、不存在的 .map）返回 404 而不是 index.html。镜像的 public/ 从 17 MB 降到 5.8 MB，`docker images` 406 MB → 392 MB。服务端 `server/main.mjs.map` 保留（不对外提供，只用于堆栈）。socket.io-client / engine.io-client 被锁文件标成生产依赖，也进了 server 的运行时依赖（约 1.5 MB）。
- Caddy 在 80 端口自动跳转 HTTPS 的响应仍带 `Server: Caddy`（去掉 Server 头的配置只作用于 https 站点）。
- 停机时有连接要等 3 秒强制断开（修复后 4 次 E2E 重启里有 2 次）：来源没有查清。审查指出当时的强制断开够不着 WebSocket，最坏情况其实仍是 25 秒；25.7 补上之后最坏情况才真正是 3 秒。审查修复后 7 次 E2E 重启里仍有 2 次走满 3 秒，新加的日志显示剩下的是 3 条普通 HTTP 连接、没有 WebSocket——推测是停机期间页面重连发起的 engine.io 新握手（engine.io 关闭后照样受理）留下的长轮询；停机开始时让 engine.io 拒绝新握手可以消掉这 3 秒，本轮没做（会改变重连期间客户端看到的错误，需要单独验证）。
- 两轮压测之后空闲时 heapUsed 约 122 MB、RSS 约 540 MB（刚启动时 53 MB / 175 MB），没有确认是尚未回收的垃圾还是泄漏，需要长时间运行观察 `/admin/stats`；Docker 内存上限建议至少 1 GB。
- 压测收尾解散房间会给每个房间写 `auto:<code>` 自动存档（压测只能对测试模式实例跑，不会碰正式库）。
- WebSocket 被拦的降级只用本机代理模拟验证过，没有在真实的公司代理 / CDN 后面试过。
- E2E 远程模式只跑了 turn-cycle、reconnect、deploy-restart；其余 spec 没有逐个在远程模式下验证。
- `apps/server/test/integration/minigame.test.ts` 的 `bombRun` 偶发失败：随机房间种子生成的企鹅棋盘上偶尔没有从起点可直达的炸弹格（`expected -1 to be greater than or equal to 0`），测试应改为固定种子或在找不到时换一种结束方式。
- 仓库根目录三个被 git 跟踪的反汇编片段文件（`0x10800000`、`0x10800020`、`0x45382e`，调试遗留）已被 `.dockerignore` 排除，是否从 git 删除待定。

### 25.7 审查修复（M11 审查 16 条）

逐条独立核实后修复；复核在本机 compose 项目 `rich4-m11fix`（127.0.0.1:8080/8443，e2e 覆盖文件，口令门禁 + 真实素材包 + 台湾图）上实跑，日志在 `.cache/m11/fix/`。

- **镜像扫描规则统一**（第 1、12 条）：新增 `scripts/scan-tree.ts`，直接调用 `check-no-original.ts` 的纯函数（路径、MKF/PE/FLIC/SPR 魔数、不分大小写的 `RICH4_DERIVED` 音视频标记、全部 12 个素材包 schema 含带连字符的 id、gzip/brotli 变体解压后再判、sha256 禁单），另加镜像 / 构建产物档的路径规则（任何一级 `original` / `rich4-data` / `rich4-assets` 目录、`.rich4-extract.json`、素材包命名 `<名字>.<8 位十六进制>.<扩展名>[.br|.gz]`、一切音视频与 MIDI）与压缩包展开（tar、tar.gz/br、zip 逐条目再查；xz/7z 等展不开的在 `app/` 与构建产物里判命中）。它只用 Node 内置模块与可擦除的 TS 语法，`node:24-slim` 里直接 `node scripts/scan-tree.ts` 运行（类型剥离，`check-no-original.ts` 改为带 `.ts` 后缀导入 `lib/cli.ts`）。`deploy/scan-image.sh` 的三道检查都改用它（服务器上不必装 Node：在官方 node:24-slim 容器里 `--network none` 运行），禁单并入 tools/extract 指纹、本机素材包 manifest（含 `.cache/**`）与本机 `original/` 下全部文件的哈希；环境错误一律退出码 2（`set -E` + ERR trap）。Dockerfile 的构建上下文与产物检查也改用它（构建产物档）。回归：`scripts/__tests__/scan-tree.test.ts`（9 例，含命令行经 Node 类型剥离运行、gzip 层 tar、路径清单）；`test/m11fix-scan-selftest.sh` 在 rich4:local 上叠一层合成「泄漏」（审查自测的 11 个文件形态加改名的派生 opus、voice-map JSON、带 rich4-assets 路径的 zip、xz、按禁单哈希的文件、先加后删的 Data.MKF，共 17 种，不含任何原版字节），scan-image.sh 退出 1、17 种全部命中（34 处），`TMPDIR` 不可用时退出 2；自测镜像已删除。正式镜像 scan 退出 0（10 层，基础层 apt 日志 `eipp.log.xz` 只告警）。
- **客户端真实 IP**（第 2、11、13 条）：compose 默认网络 `enable_ipv6: ${ENABLE_IPV6:-true}`（本机 Docker Desktop 实测自动分配 ULA /64，caddy 仍经 IPv4 连 app）；Caddyfile 全局 `servers { trusted_proxies static {$CADDY_TRUSTED_PROXIES}; trusted_proxies_strict }`，反代时 `header_up X-Forwarded-For {client_ip}`（缺省不信任任何代理，与原来等价）；app 在生产环境第一次把握手的客户端 IP 解析成本机或私有地址时 warn 一次（`io.ts` 的 `privateClientIpWarner`，单测）。实测：缺省配置下带不同 XFF 的请求在 app 日志里全是 `172.20.0.1`，一个「客户端」错 6 次口令后另一个带正确口令的也被 429（复现审查）；`CADDY_TRUSTED_PROXIES=private_ranges` 后 app 日志按 XFF 分开，另一个客户端正确口令 200，`XFF: 1.2.3.4, 192.0.2.99, 10.0.0.5` 取 `192.0.2.99`（从右往左第一个不可信地址）。E2E 后日志里恰好一条 `client ip resolves to a private address`（Docker Desktop 的端口转发本来就这样）。deploy.md 新增 §7.1（IPv6、前置反代、CDN 三种形态）。Linux 主机上 IPv6 经 NAT 保留源地址这一点本机无法复现。
- **.gitignore**（第 3 条）：补 `.env.*`、`*.env`（放行两个 `.env.example`）、`*.db`、`*.db-wal`、`*.db-shm`、`*.r4save`；`git check-ignore` 核对 deploy/.env.bak、deploy/.env.prod、deploy/prod.env、.env.local、rich4-20260928.db、deploy/rich4.db、backup.r4save 均已忽略，已跟踪文件没有被新规则误伤。异地恢复改从 `/srv/rich4-backups/` 拷入。
- **ADMIN_TOKEN 不上命令行**（第 4 条）：deploy.md、.env.example、compose 文件头的管理命令一律 `sed -n 's/^ADMIN_TOKEN=/Authorization: Bearer /p' deploy/.env | curl -fsS -H @- …`；本机对容器实测 stats、列出与签发邀请码都 200。
- **停机不再被 WebSocket 拖住**（第 5 条）：`app.ts` 在 `upgrade` 时登记连接，宽限期满（3 秒）与 `closeAllConnections()` 一起销毁。回归测试「优雅停机不被不回应关闭帧的 WebSocket 拖住」（直连 engine.io websocket 后一字不回）：去掉修复时 20 秒超时，修复后按时完成并能恢复房间。宽限期满时另记一条 `shutdown: grace period over, forcing connections closed`（剩余连接数、其中的 WebSocket 数）。实机：3 条 websocket 客户端被 `kill -STOP` 后 `restart app` 共 3.6 秒（`rooms suspended` 到 `shutdown complete` 3.0 秒；审查实测修复前 25.3 秒）；7 次 E2E 重启里 5 次在 0.3 秒内 `shutdown complete`，2 次走到 3 秒强制断开（其中一次日志为 `connections: 3, websockets: 0`：剩下的是普通 HTTP 连接），SIGTERM 到新进程监听 2.9–7.1 秒。
- **文档与运维**（第 6–10 条）：最低内存改为 2 GB（1 GB 主机加 swap，或本机构建后 `docker save | ssh … docker load`、服务器 `up --no-build`；复核：构建阶段容器限 768 MB 时 `npm run build` 被杀 137，1.2 GB 通过、峰值 1.08 GB）；所有 compose 命令改为「仓库根目录 `.env` 写 `COMPOSE_FILE`、命令不写 `-f`」，nginx 模式只改这一行（实测带 nginx 覆盖文件的项目再次 `up -d --wait` 后 127.0.0.1 端口仍在、只有 app）；升级后 Caddyfile 有改动要 `restart caddy`（实测换 inode 后 `up -d` 与容器内 `caddy reload` 都不生效，`restart caddy` 生效）；异地备份改为每小时 `docker compose cp app:/data/backup/. /srv/rich4-backups/`（不再按日期拼文件名，实测可重复拷贝）；两个只读挂载改为 `create_host_path: false`，§2 先 `mkdir -p rich4-data rich4-assets`（实测目录缺失时 `up` 报 `bind source path does not exist`，不再自动建目录）。
- **压测判定**（第 14、15 条）：判定抽成 `apps/server/scripts/loadtestVerdict.ts`（单测 5 例）：`app:error`、非预期的 `game:act` 错误码（INVALID_ACTION、RATE_LIMITED、STALE_DECISION、NOT_YOUR_DECISION 之外）、其余请求出错、再来一局失败都判 FAIL；有功能性错误时读不到 `/admin/stats` 也判 FAIL（退出码 1），只缺 p99 读数才是 UNKNOWN（2）。复核：压测中 SIGKILL 服务器，loadtest 退出 1、`verdict: FAIL`（修复前 2 / UNKNOWN）；对容器 30 房 30 秒冒烟 PASS。
- **deploy-restart 用例**（第 16 条）：等断线遮罩时同时盯着重启命令，命令非 0 退出立即带退出码与输出失败，命令成功后 30 秒仍没断线也带输出失败。复核（本机测试模式服务器）：`E2E_RESTART_CMD='echo MARKER >&2; exit 3'` 报「重启命令失败…exit 3…MARKER」；`E2E_RESTART_CMD=true` 报「重启命令已成功退出，但之后 30 秒内页面没有出现断线遮罩」。远程模式对容器共跑 8 次，7 次通过；1 次在重启之前就失败：`if (debug) expect(before.server.lots.L1?.owner).toBe(String(seatA))` 得到座位 3（P2）而不是 P1——用例假定 P1 第一回合固定买下 L1，随机对局里 L1 偶尔先落到别人手里，与本轮改动（重启命令的监视）无关，留作遗留。

## 26. 用户反馈修复：选人提交与画面中央的决策倒计时（2026-09-28）

用户在线上（原版皮肤、真实素材包）反馈两点：「选的是忍太郎，头像却是金贝贝」；「决策时间的倒计时应在画面中央，最后 10 秒发出急促的提示音」。

- **头像问题的根因不在素材映射**：角色号 → 头像 Data#2、讲话头像 map#15+c、侧视走动 jump#5+3c+v、棋盘姿态 Data#87+21c+k 等映射（original-skin.md §4.3、docs/research/original-assets/*.md）逐一与真实素材包核对，全部正确，没有文档需要更正。根因在选人流程：选角光标（预览、名字）与已提交给服务器的角色是两回事，单击头像只移动光标，直接按 OK / 準備时座位 characterId 仍为 null，`Room.start` 给它随机分配了角色。修复：`ui/lobby/characterPick.ts` + `useCharacterPick.ts`（两种皮肤共用），开始 / 准备前先提交光标上的角色，提交失败就不开始 / 不准备；原版选人画面单击没被选走的头像即选定（同原版）。规则写在 client.md §5.5、original-skin.md §4.3。
- **中央决策倒计时**：`ui/common/useDecisionCountdown` + `DecisionCountdown`（程序化挂载）/ `ui/classic/ClassicCountdown`（原版，portal 到舞台容器）。只跟随本人、有截止时间的决策；按校准后的服务器时钟每跨一个整秒更新；最后 10 秒变红并每秒一声 ZzFX `countdown`，最后 3 秒 `countdownFinal` 双响；提交 / 到点立即停，同一秒不重复、后台回来不补播。位置后来按用户要求改为**始终在画面正中央、不避让**（用户看过避让版后要求先试的方案，见本节末条）。设计见 client.md §5.1 / §7.3、original-skin.md §4.2。单机默认不限时（timerPreset off），这时没有倒计时。
- **联调验证**：`npm run check` 全绿（vitest 300 个文件 2930 通过 2 跳过）；E2E 默认配置 44 通过 1 跳过、原版配置 41 通过 4 跳过（跳过均为按配置的既有 skip），新增 `decision-countdown`、`skin-classic-character` 两种配置都通过。真实素材包实测（`test/pc-final-check.mjs`，端口 3501/5501，截图与记录在 `.cache/pc/final/`，不入库）：原版与程序化皮肤、1920×1080 与 844×390 各一遍，「单击忍太郎 → 直接 OK」进局为忍太郎（服务器座位、座位条与资料栏 face72 帧 2、棋盘 `char.2.*`、买地讲话头像 `portrait.speaker.2/0` 一致），P2「▶ 翻到金貝貝 → 直接準備」进局为金貝貝；fast 档回合菜单放到超时，音频引擎日志里 `zzfx.countdown` 在距截止 9996、8997 … 3996 ms 各一声，`countdownFinal` 在 2998、1998、998 ms 各两声（间隔约 131 ms；四轮都落在整秒边界前 10 ms 以内），数字在剩 10 秒时变红、到点后 17–37 ms 内消失（采样间隔 40 ms）；提交后不再响；与回合菜单、买地、银行、拍卖叠加时倒计时 `pointer-events: none`，与可见按钮的矩形都不相交（程序化手机横屏在对话框上方放不下时按设计隐去）；控制台 0 错误。
- **复审修复**（9 条 minor，逐条复核后都属实）：
  - 选人：已准备的非房主玩家再移动光标（程序化单击头像、原版 ◀ ▶ / 单击被选走的头像），预览换成新角色，但开局由房主发起、不会替他提交光标——同一类「看到 A、进局 B」。现在移开已提交的角色就先取消准备（`characterPick.unreadyOnMove`，`usePickCursor` 的移动光标），再按准备时提交新角色；原版单击没被选走的头像是「移动 + 提交」，保持准备。原版「◀ ▶ 翻看后点選這個」补了 DOM 用例。
  - 同屏倒计时一致：`URGENT_MS = COUNTDOWN_URGENT_S × 1000`（圆环、原版侧栏「輪到你了 N 秒」、等待条都 10 秒变红）；`useRemainingMs` 仍 200ms 轮询但不越过下一个整秒边界，与中央倒计时同一时刻换秒；圆环的跳动改为每秒换 key、在整秒边界放大。
  - 提示音去重键只看截止时间（`beepKey`）：回合菜单里用卡、买股票后服务器换 decisionId 重发、截止时间不变时同一秒不重响；定时器仍按「决策 + 截止时间」重启。
  - 断线（连接状态 reconnecting / closed / connecting）时中央倒计时不显示、不响，取消没响的双响第二声；重连后按 resetTo 带回的截止时间重新计时。
  - 倒计时的避让摆放（原版铺满舞台的场景登记小牌位置 `common/sceneCover` / Stage4x3 `countdownBadgeAt`；程序化对话框正上方、放不下时叠到圆环左边；停靠栏开着时挪位）在复审中细化过，之后按用户要求改为始终在画面正中央，这些避让代码与数据已全部删除（见本节末条）。
  - 验证：`npm run check` 全绿；E2E 两种配置全量各跑两遍（结果见本轮汇报）；真实素材包截图 `test/fix-cd-shots.mjs`、断线 `test/fix-cd-disconnect.mjs`（端口 3801 / 5801，输出在 `.cache/pc/fix/`，不入库）。
- **倒计时改为始终在画面正中央（用户要求先试，有调整用户会再提）**：用户看过避让版（等掷骰在中线偏上、决策框 / 场所开着时缩成小牌挪开）后要求「始终显示在画面正中央」。
  - 位置：原版在 640×480 舞台正中 (320,240)，随舞台等比缩放；程序化在棋盘视口（右栏以外、顶栏以下、行动区以上，与镜头的有效可视区同一块）的正中。等掷骰、决策对话框、回合菜单展开、原版铺满舞台的场所（银行、股市、拍卖、魔法屋、公佈欄…）、手机横屏、日志 / 聊天停靠栏开着时位置、大小都一样，没有小牌形态；会压在对话框内容上，但 `pointer-events: none`，点击照样落到下面。
  - 层级：原版仍经 portal 挂到经典舞台容器（场景 48 之上、抽屉 70 之下）；程序化整层改为 portal 到 `document.body`（z 45）——对局页 `.game` 是 `position: fixed`、自成层叠上下文，留在里面盖不过挂在 body 上的 radix 模态面板（回合菜单的卡片 / 股票 / 公布栏子页）。右栏宽、顶栏高与 HUD 共用 `hud.module.css` 的 `.hudGeom`（与 `.game` 同一套断点）；手机竖屏的旋转提示期间隐去。「轮到你了」横幅不再让位，数字始终显示且在横幅之上（桌面两种皮肤的截图里两者不重叠；844×390 时横幅下缘贴着数字上缘，数字画在横幅之上、完整可见）。
  - 字号：原版 64 逻辑像素（1920×1080 为 144px、844×390 为 52px；56 / 64 / 72 对比后取 64）；程序化 `clamp(56px, 12vh, 108px)`（1280×800 为 96px、844×390 为 56px）。描边按 em 给（0.05em），加一层淡投影；最后 10 秒变红并每秒脉动（prefers-reduced-motion 时不动）。显示条件、提示音、读屏播报不变。
  - 删除：`ui/classic/common/sceneCover.ts`（只为倒计时服务，整个删掉）及其单测、Stage4x3 / DecisionStage 的 `countdownBadgeAt`、各场景 layout 里的小牌坐标（股市 `STOCK.badge/ring`、拍卖、魔法屋、公佈欄、托管设置、存读档）、`countdownPlace` / `dialogAnchor` / `anchorAboveDialog`、停靠栏挪位（`--dock-w`、`data-dock`）、横幅让位（`data-yield`）与小牌样式。侧栏「輪到你了 N 秒」与对话框圆环保持（整秒对齐、10 秒变红）。
  - E2E `decision-countdown` 改为两名真人（P2 另开页面，只在轮到自己时自动应答；单真人房间不再有计时），断言 P1 的倒计时中心与舞台 / 棋盘视口中心偏差 ≤ 3px，等掷骰、展开回合菜单、最后 10 秒、买地对话框时位置与字号不变。
  - 验证：`npm run typecheck`、`npm run lint` 通过；vitest client-unit + client-dom 101 个文件 1219 通过；`decision-countdown` 默认配置与原版配置（CI=1）各通过；真实素材包截图（`test/center-cd-shots.mjs`，端口 3311 / 5311，输出在 `.cache/cs/center/`，不入库）：原版 1920×1080 / 844×390、程序化 1280×800 / 844×390，等掷骰、回合横幅、回合菜单展开、股市、停靠栏、最后 10 秒 / 3 秒、买地、银行、魔法屋、拍卖，所有截图里倒计时中心与画面正中偏差为 0，控制台 0 错误。
- **只有一名真人时不限时（用户要求，和单机一样）**：房间只有一名真人、其余座位都是电脑时自动不计时；`/solo` 本来就是 off，不变。规则写在 design/net.md §5.4「有效计时档位」。
  - 规则（服务器权威）：`shared/net/timing.ts` 新增 `isHumanSeatControl`（`human` 与 `autopilot:manual` / `afk` / `disconnect` 算真人；`ai`——电脑补位、被踢——与 `autopilot:left`——对局中离开——不算；观战者不占座位）与 `effectiveTimerPreset(preset, 真人座位数)`（≤ 1 时 off）。`GameRunner.effectiveTimerPreset()` 按座位控制方式判定，`syncPending` 用它计算截止时间；`setControl` 前后比较，结果变化时 `retime`：变为不限时取消截止时间、超时定时器与 TURN_MENU 计时链，变为有时限从现在（动画没播完则从播完时）起按档位给完整时限、计时链从头开始；小游戏窗口不受影响，电脑 / 托管代打的决策只改截止时间。离开、回来经 `game:pending` 下发，踢人随 `SYS_SET_CONTROLLER` 那一批 `game:batch` 下发。房间设置不变；`RoomView.effectiveTimerPreset`（可选字段）下发判定结果，大厅里按座位上的真人数推算。存档与快照不另存判定结果，读档（未认领、补电脑的真人座位是 `ai`）与重启恢复（沿用快照里的控制方式）都重新推导，旧存档无需迁移。只剩的那名真人断线照断线宽限转托管、全员离线照 `pauseWhenAllAway` 暂停，与单机一致。
  - 客户端：计时显示本来就跟随决策的 `deadlineAt`（null 即不限时），单真人时原版侧栏自动显示「輪到你了 不限時」、没有中央倒计时，无需改倒计时组件。建房、房主改设置与大厅设置显示的决策计时下方加一行小字「只有一名真人时不计时」（`lobby:settings.timerHint`，zh-TW 由 `npm run i18n:zh-tw` 生成）：程序化 `RoomSettingsFields` / `LobbyView`，原版 `settingsFields` 的 `SelectSpec.hint` + `RowField`（开局设置面板里排在行下方；手机横屏两列面板塞进标签下方，下拉框占两行，行高仍 56）；大厅里当前座位只有一名真人（有效档位 off 而设置不是 off）时这行字高亮（`data-active`）。
  - 测试：`shared/net/contracts.test.ts`（规则）；`server/test/unit/GameRunner.untimed.test.ts`（单真人开局无截止时间且久等不超时、两真人按档位、一人离开后当前决策截止时间取消且之后不再给、回来后从现在起重新计时、动画未播完从播完时起算、被踢、托管 / 断线托管 / AFK 仍算真人、只剩的真人断线照宽限转托管、暂停中离开与回来、开局即为 `autopilot:left` 的座位、计时链重来）；`Room.test.ts`（大厅推算、离开 / 回来 / 踢人、单机 off、读档只一人入座时不限时）；`restore.test.ts`（重启恢复后离开的座位不算真人、回来恢复计时）；集成 `untimed-solo.test.ts`（server 与 server-real 两个 project）；DOM 测试两种皮肤的说明与高亮；E2E `untimed-solo.spec.ts`（一名真人 + 3 电脑 fast 档等 17 秒不超时、侧栏不限時、没有中央倒计时；两名真人有倒计时，P2 离开后取消）。检查了依赖计时的既有用例：`timeout-ai` 本来就是两名真人，服务器集成测试里测超时的都是 ≥ 2 名真人，`decision-countdown` 由另一代理改为两名真人；`apps/server/scripts/loadtest.ts` 的判定不变，只在说明里注明 `--humans 1`（默认）的房间不计时。
  - 验证：`npm run typecheck`、`npm run lint`、`check:deps` / `check:zh-tw` / `check:determinism` / `check:no-original` 通过；`npx vitest run`（全部 project）302 个文件 2965 通过 2 跳过；E2E 全量（CI=1）默认配置 46 通过 1 跳过、原版配置 43 通过 4 跳过（跳过均为按配置的既有 skip），含新增 `untimed-solo`。真实素材包目视（`test/solo-untimed-shots.mjs`，端口 3321 / 5321，截图在 `.cache/cs/solo/`，不入库）：原版与程序化 1920×1080 各一遍——一名真人 + 3 电脑（档位 normal）大厅说明高亮、开局后原版侧栏「輪到你了 不限時」、没有中央倒计时、决策 `deadlineAt` 为 null；两名真人有倒计时（28 秒），P2 离开后 P1 同一决策的截止时间变为 null、倒计时消失、侧栏变「不限時」；原版 844×390 开局设置两列面板里说明在「決策計時」标签下方，行高不变；控制台 0 错误。
- **两项联调验证**（「始终正中央」与「只有一名真人时不限时」合在一个工作区）：逐文件核对共享文件没有互相覆盖（`lobby.json` 只多一条 `timerHint`；client.md §5.1 / §5.5、architecture §5.8 / §26 两路各改各的段落；`GameScreen` / `ClassicLayout` 两路都没改）。`npm run check` 全绿（vitest 302 个文件 2965 通过 2 跳过）；E2E 全量（CI=1）默认配置 46 通过 1 跳过、原版配置 43 通过 4 跳过（跳过均为按配置的既有 skip），一次通过、没有偶发失败。真实素材包目视（`test/final-cs-check.mjs`，端口 3331 / 5331，截图与记录在 `.cache/cs/final/`，不入库）：原版与程序化、1920×1080 与 844×390 各一遍——一名真人 + 3 电脑（fast 档）全程没有中央倒计时、截止时间与提示音请求都是 0（音频引擎在运行），原版侧栏「不限時」、对话框圆环 ∞，等过 fast 档时限不超时；两名真人（normal 档）P1 的倒计时在等掷骰、回合菜单、股市、买地、银行、魔法屋、拍卖时中心都与画面正中重合（偏差 0、字号不变），数字下压着的按钮命中测试都落在按钮上，用鼠标点在数字上点着了「關閉」、股票行、ATM 键、魔法效果、银行操作钮；最后 10 秒变红，提示音在剩 10…4 秒各一声、3 秒双响，比对应的整秒边界晚 ≤ 6ms；P2 在 P1 回合菜单最后 10 秒离开后 12–33ms 内有效档位变 off，倒计时消失、不再响，侧栏「不限時」，过了原截止时间也不超时；控制台 0 错误。
- **复审修复**（上面两项合入后的 7 条审查发现，逐条复核；用户要求倒计时「始终正中央、不避让」，建议避让的一律不改）：
  - 真人被淘汰后仍算真人座位（major，属实）：`GameRunner.effectiveTimerPreset()` 只看座位控制方式，破产 / 投降出局的真人仍算真人，场上只剩一名真人对电脑时照常计时，出局者关页面转断线托管后另一名真人还会连续超时被转成 `autopilot:afk`。修复：真人座位还要求引擎里这名玩家 `alive`（`isHumanSeat`）；`apply` 提交新状态后比较前后结果，变了就 `retime`（放在 `SYS_SET_CONTROLLER` 之前，踢人仍由 `setControl` 自己比较），并经新增的 `RunnerHooks.timerPresetChanged` 让房间先于这一批广播 `room:state`。重启恢复与读档从状态推导，天然正确；大厅推算不变。规则写进 net.md §5.4。测试：`GameRunner.untimed.test.ts` 新增 3 条（stub 引擎里付不起过路费破产、之后另一名真人不限时、出局者断线托管也不超时不进 AFK；别人的决策进行中有真人投降——包装引擎——当前决策截止时间立即取消；三名真人出局一人仍计时），`Room.test.ts` 1 条（破产后 `room:state` 先于 `game:batch`、有效档位 off）；去掉修复后这些用例都失败。
  - 程序化窗口宽 1024–1279 时倒计时偏下约 20px（两条 minor，属实，同一原因）：倒计时层下缘写死一行行动区的高度，带文字标签的行动区在这些宽度折成两行（高 106px）。修复：`GameScreen` 把给镜头量的 `insets`（顶栏、底栏实际高度）传给 `DecisionCountdown`（`hudBars`），层的上下缘内联给出，行动区折行、等待条出现时都跟着变，与镜头有效可视区始终同一块；CSS 里的值只作还没量到时的缺省。E2E `decision-countdown` 的「画面正中」改按底栏（行动区的父元素）上缘算，并加一档 1100×800（程序化断言行动区确实折成两行）再换回原尺寸。
  - 程序化倒计时（body 上 z 45）压在系统菜单、设置之上，与原版相反（major，属实）：`Modal` 新增 `layer="system"`（遮罩 46、面板 47），系统菜单、设置、托管设置用它；数字仍压在回合菜单的卡片 / 股票 / 公布栏等决策面板上（不避让），只是不压系统界面，两种皮肤一致。
  - 数字压住决策对话框中央的关键文字（反馈，不改代码）：按用户「先试、不避让」保留，场景与截图列给用户决定。
  - 大厅「现在就不计时」只靠颜色和粗细表达（minor，属实）：此刻适用时文字换成「现在只有一名真人：开局后不计时」（`lobby:settings.timerHintActive`），两种皮肤的大厅、房主改设置、建房（电脑补满其余三个座位）都一样；判定抽成 `lobby/settingsDraft` 的 `soloHumanNow` / `draftSoloHuman` / `timerHintActive`。
  - 原版手机横屏开局设置的说明约 9 CSS 像素（minor，属实）：两列面板里计时档位这一行占满整行（`settingsFields.WIDE_FIELDS` 把它排在演出节奏之后、落在左列，14 项 + 快速局仍是 8 行），说明排在下拉框右边、字号 14 逻辑像素（844×390 实测 11.4 CSS 像素），在「：」处折行、不越出行。
  - 顺带发现、未改（已另开任务建议）：左手模式下镜头 insets 仍按右栏在右边算，跟随的角色不在棋盘视口正中；原版皮肤从系统菜单点「托管设置」，原版托管画面开在系统菜单下面（改层级之前就是这样）。
  - 验证：`npm run check` 全绿（vitest 302 个文件 2975 通过 2 跳过）；E2E 全量（CI=1）默认配置 45 通过 1 跳过 1 失败——失败的是 `skin-classic-dialogs`「原版老虎机」（观战页 30 秒内没出现老虎机，与本轮改动无关），单独重跑该文件两遍 10/10 通过；原版配置 43 通过 4 跳过（跳过均为按配置的既有 skip）。`decision-countdown` 在去掉 `hudBars` 时会失败（1100×800 偏下），修复后两种配置都通过。真实素材包目视（`test/review-fix-shots.mjs`，端口 3361 / 5361，截图与记录在 `.cache/cs/fix/`，不入库）：程序化 1280×800 起换 10 档窗口（含行动区两行的 1200×800、1100×800、1100×700、1024×768、1194×834、1024×600），倒计时中心与棋盘视口中心偏差都是 0；系统菜单、设置、托管设置打开时数字中心处最上层是对话框（两种皮肤），回合菜单的股市面板上最上层仍是数字；台湾图真引擎里 P2 身无分文落到 P1 的地上破产后，P1 立刻变不限时（侧栏「輪到你了 不限時」、没有中央倒计时），P2 关页面转断线托管后又等 33 秒，P1 的回合菜单没被代决、仍是 human；大厅与建房的说明按预期换文字；原版 844×390 开局设置里说明实际 11.4 CSS 像素、在下拉框右边、不越出行；控制台 0 错误。

## 27. 原版另外 3 张图（大陆 / 日本 / 美国）接入实施记录（2026-09-30）

接入 v2.06 的另外 3 张原版图：大陆 `china`（gm 1）、日本 `japan`（gm 2）、美国 `usa`（gm 3），显示名 中国大陆 / 日本 / 美国（繁体 中國大陸 / 日本 / 美國）。范围：MapDef 与数据包、原版皮肤素材（地面、小地图、住宅、企业 / 景观精灵、节日插画、开局设置背景）、原版选关界面与 Fly*.avi 飞行动画、引擎与表现层对新结构的适配、golden 与自对弈。按五个轨道并行：T1 数据管线、T2 原版素材、T3 选图与飞行动画、T4 引擎与表现适配、T5 golden / 自对弈 / 文档汇总。

用户已定的取舍：三张图的数据基线都用 v206-mapdat（VERIFY V-M1）；原版文案瑕疵照原样保留（DEVIATIONS 附表）；联机由房主自选地图，不做通关记录与「下一关」列表（DEV-23）；飞行动画只在客户端播、可以跳过，读档 / 重连 / 观战不播（DEV-24）；开局设置去掉 StageBanner；V-M7（环路关押格）、美国 kind 2 节日、街道价格样本、命运 33–36 按图文案、日本股市电子业图标先按现状或 exe 证据实现并用测试锁定，登记待用户在原版核实（VERIFY、verify-checklist §5）；开局设置头像格的位置差异不在本轮范围。

**台湾不变**：`rich4-data/maps/taiwan.map.json` 逐字节不变（sha256 `14ef91e8…6c10`，mapHash `3c2f31eb…a551`），`__golden__/taiwan.json` 不变——已部署服务器上的房间快照与存档按 mapHash 引用地图。

### 27.1 冻结的接口约定

- **id 与 gm**：taiwan 0、china 1、japan 2、usa 3；`MapDef.globalMapId = gm`；顺序即原版关卡顺序（exe 0x46aac4 第 9–12 项、0x4070e1），`tools/extract` 的 MAP_KEYS、客户端 STAGE_MAPS、SaveLoadScreen 与 golden 的 MAPS 同序。
- **素材键**（台湾的键全部不变）：地面 `map.<id>.ground`（map#2gm，2×2 切片）、小地图 `map.<id>.minimap`（map#8+gm）、住宅 `map.<id>.house.<L>`（map#27+5gm+L−1）；企业 / 景观精灵键名仍是 `board.landmark.<res>`，只有一张图用的归 `map.<id>` 分组，多图共用的 {75,80,82,84,87,132,144} 归新分组 `board.landmarks`；节日插画沿用全局编号 `illustration.holiday.<res−4>`，res = [4,28,47,67][gm] + slot（exe 0x473098），每图节日数 [24,19,19,20]，Data#66（七夕，节日表没有对应项）不收；开局设置背景台湾 `title.setup.bg`（jump#0）、其他 `title.setup.bg.<id>`（jump#1–3）；飞行动画 `video.flytw / flychina / flyjp / flyus`（exe 0x472f78）。
- **i18n 键**：`lobby:maps.<id>`；`events:holiday.<id>.h<slot>`；`fate:33–36.byMap.<gm>`。

### 27.2 数据管线（T1，`tools/extract`）

- **地图键**：`map/pack.ts` 的 MAP_KEYS 为四张图；`resolveMapKeys` 接受键名、gm 数字与 `all`（报错列出四个键），只要一张图的地方用 `resolveMapKey`（拒绝 `all`）。`map/i18n.ts` 的 MAP_NAMES 增加 中國大陸 / 日本 / 美國（zh-CN 由 opencc 生成）。
- **pack**：不带 `--map` 时只打最近一次 `map build` 报告为 exit 0 的图，其余告警跳过；显式 `--map` 时条件不满足报 `E_PACK_BUILD`。`map build` 中途抛错也写构建报告，旧的 map.json 不会被打进去。
- **企业↔股票核对**（`exe/mapData.ts`）：结果分 OK / KNOWN / BAD，只有 BAD 让 `map build` exit 1；白名单 KNOWN_NAME_MISMATCHES 只有一项：gm 1 C4「王井府百貨」对股票下标 2「王府井百貨」（@source MapDat[1]、v3.11 companies#4，股票表 0x47ce92 + 432）。
- **样本**（`verify/samples.ts`）：`runMapSamples(raw, spec)` 按图规格 MAP_SAMPLES 驱动（`runTaiwanSamples` 保留为包装，`samples.map0.json` 逐字节不变）。新图断言：计数、关押格 8001 / 8002 的节点与景观名、封路的确切边（大陆 28→136、日本 78→79、美国无）、bit31 格（日本 23–29，其余 0）、各企业 industry / stockIndex / assetValue、已知瑕疵（按来源给期望）；街道样本留了 ⚠️ 占位（VERIFY V-M9）。台湾 bit31 格 17 个只在 local 测试断言，没加进台湾样本规格（保持 samples.map0.json 不变）。
- **map build / provenance**：`--map all` 逐图构建，一张图出错不影响其余各图；样本对所有图生成；台湾仍写 `docs/research/provenance-summary.md`（逐字节不变，核对时要带 `--strict4 --preview`），其他图写 `docs/research/provenance-<key>.md`；构建报告增加 `exit` 与 `companyStocks`。
- **placeLands**：放宽只针对严格候选为空（拥挤）的地块，按轮次扩大；I_LAND_FAR 只列最终距期望格超过 2 的地块。台湾不进放宽分支（按 sha 核对）。
- **`extract all`**：依次 map raw（gm 0–3，`--sources all`）→ map diff 0–3 → exe tables → `map build --map all --strict4 --preview`，任何一步失败即停，退出码取最大值，不自动 pack。map diff 的 exit 4 只在该图的规则差异正好等于已知清单 `ACCEPTED_RULE_DIFFS`（大陆 `companies#4.name`、日本 `lands#17.rent`）、且 overrides 的 `source.id` 是清单的基线 `v206-mapdat` 时视为已处理（否则大陆、日本的已知差异会让 `all` 在真实数据上永远 exit 4）；清单之外的规则差异照样停下（审查修复）。`pack` 与 `<out>/manifest.json` 已有条目合并，只替换本次打包的图；不带 `--map` 时要跳过的图已在 manifest 里就报 `E_PACK_DROP`，`--replace` 才整份重写（审查修复：此前 `pack --map china` 会把 manifest 覆盖成只剩大陆）。`verify --samples` 放开到 `--map 0..3`。
- **几何 overrides**（`tools/extract/maps/{china,japan,usa}.overrides.json`，已冻结）：基线 v206-mapdat、`expectResourceSha256` 取完整值、格点固定 T=48 identity，原点大陆 (32,39) / 日本 (17,41) / 美国 (34,6)，`terrain.margin` 4，expect 计数；再用 nodeCell / edgeRoute / lot 迭代：大陆 nodeCell 75/76/90/121/122/135、edgeRoute 26-27/79-80/121-122、lot C1/C2/F7；日本 nodeCell 11/57/101/103、edgeRoute 60-61、lot C2；美国 nodeCell 32/36/48/53/66/89、edgeRoute 1-2、lot C2。结果：三张图偏侧住宅地 0、W_TILES_TOUCH 0、I_LAND_FAR 0、facing 假设启用、企业都是 2×2；剩余告警都在允许清单内（大陆 W_LINK_ONEWAY / W_DEADEND / W_COMPANY_REMOTE_FRONT，日本另有 W_NAME_EMPTY，美国 W_COMPANY_REMOTE_FRONT / W_NAME_EMPTY）。每条 override 都做过逐条去掉的对照，理由写在 notes。之后再改几何，要重建素材包与对应图的 golden（`maps.local.test.ts` 锁定了 dataHash）。
- **各图数据包**：

  | 图 | 节点 / 住宅 / 设施 / 企业 / 景观 | dataHash（mapHash） | 文件 sha256 |
  |---|---|---|---|
  | taiwan | 103 / 50 / 4 / 3 / 21 | `3c2f31eb596b…a551`（不变） | `14ef91e8…6c10`（不变） |
  | china | 144 / 73 / 8 / 4 / 26 | `a36d1285be25…4363` | `58bd4313…138d` |
  | japan | 110 / 49 / 5 / 6 / 16 | `0fc7c82a5d02…5a48` | `fe439cb6…1474` |
  | usa | 118 / 55 / 8 / 6 / 16 | `52a0d97ced74…5ed2` | `f0b9a5f7…232b` |

- **测试**：单测 `mapKeys.test.ts`、`placeLandsRelax.test.ts`，补了 samples / exeTables / cli / mapBuild.cli；本机测试 `maps.local.test.ts`（22 条）锁定三张新图的构建结果与 dataHash，并回归台湾 sha、dataHash 与 bit31 格。文档：data-pipeline.md §2、§3、§8.2、§10.1、§10.2，README 的提取一节。

### 27.3 原版素材（T2，`tools/extract/src/assets`）

- **资源目录**（`catalog.v206.ts`）：ORIGINAL_MAPS（taiwan / china / japan / usa = gm 0–3）与每张图的企业 / 景观精灵集合；每张图生成地面、小地图、住宅五级；共用精灵进 `board.landmarks`，只有一张图用的进 `map.<id>`（台湾旧键全部保留，只有 75/80/84/87/144 换了分组）。节日插画收 Data#4–86（不收 #66），置信度 exe（0x473098 + fcn.00450a17 返回的 slot），改正了旧文档差一位的区间（日本 47–65、美国 67–86）。开局背景 jump#1–3 → `title.setup.bg.<id>`（exe 0x406c05、0x40549c、0x40730c）。命运插图 Data#436–475 按 exe 0x473dd8 表升为 exe（k < 33 用表[k]，k ≥ 33 用表[k+4gm]）。排除表删掉「其他地图」几段：map#1/3/5/7（地图结构）继续排除，map#69–74、83、86、88、100 标为四张图都不引用，Data#66 标为七夕。覆盖率仍为 100%。
- **构建**（`build.ts`、`commands/assets.ts`）：逐图生成皮肤，MapDef 按 mapId 读 `--map-data` 目录下的 `<id>.map.json`（默认 `rich4-data/maps`，给单个文件时按旧用法只作台湾）；MapDef 的 id / gm 与目录不符直接失败，精灵集合逐图核对；缺某张图的 MapDef 只跳过它的皮肤并告警，`--strict` 时失败（exit 2）；报告里新增 `maps`（已建、已跳过的图与各图 binding 计数）。`verify` 遇到「有地面没有皮肤」的图只告警；`preview` 每张图读自己的 MapDef 渲染棋盘（新图取中心、医院、监狱，日本另加快艇段镜头）。
- **合成包**：`title.setup.bg.china/japan/usa` 占位（换天色、左上角画 gm 个白块）与四张图首末 slot 的节日插画占位；不含 `video.fly*`（客户端 FlyVideo 在 E2E 里走缺条目跳过）。
- **binding 计数**（企业 / 地块 / 节点）：taiwan 3/54/103（不变）、china 4/81/144、japan 6/54/110、usa 6/63/118。试跑（调研版 MapDef）完整包 2382 个条目、4527 个文件、212.89 MB，比只有台湾时多 129 个条目、13.26 MB；分组体积（试跑报告，按 10⁶ 字节计）：`map.china` 3.87 MB、`map.japan` 4.02 MB、`map.usa` 3.49 MB，`illustration.holiday` 0.61 → 2.17 MB（82 个文件），`title` 多 0.87 MB，`board.landmarks` 0.35 MB（7 个精灵），`map.taiwan` 4.30 → 4.06 MB；台湾皮肤 JSON 逐字节不变（sha256 `ca179eee…`）。正式包由 Build 阶段在 T1 冻结的 MapDef 上带 `--video --strict` 重建：`npm run extract -- assets build --out rich4-assets/ --video --strict` exit 0（2 分 35 秒，清掉 15 个旧产物：台湾住宅 sprites/map/27–31 的旧 atlas JSON 及其 .br / .gz），packId `daa850ef3a455b4a`（旧 `932c2c2602ab571f`），manifest sha256 `581f4047…13c8`；2382 个条目、4527 个文件、212.89 MB（按 1048576 字节计；盘上连 .br / .gz 238.30 → 251.88 MB），与试跑包的 packId 与文件表逐项相同——调研版与终版 MapDef 文件 sha 不同，但皮肤绑定只看世界坐标、朝向与 resourceSha256，这几项相同。四张图的皮肤：`taiwan.skin.ca179eee`（不变）、`china.skin.931e2b05`、`japan.skin.d0143fbd`、`usa.skin.e9cacd29`，用客户端同一个 `checkMapSkinBinding` 核对四张图都绑定成功。旧条目 2253 个一个不缺，换分组的只有 `board.landmark.75/80/84/87/144`（map.taiwan → board.landmarks）；另有 70 个旧条目只改了来源说明（`illustration.fate.*` guess → exe，`illustration.holiday.0–23` 与 `title.setup.bg` 升 exe，`map.taiwan.house.1–5` 的 src 多一条 VA 0x407a98），像素不变。分组增量：`map.china` +3.69 MB、`map.japan` +3.84 MB、`map.usa` +3.33 MB、`illustration.holiday` 0.58 → 2.06 MB（82 个文件，键 0–82 缺 62 即 Data#66）、`title` +0.83 MB、`board.landmarks` +0.33 MB、`map.taiwan` 4.10 → 3.87 MB；`video.flytw / flychina / flyjp / flyus` 四段都在（各 6688 ms）。`assets verify --out rich4-assets/ --full` exit 0（0 处不符），`assets preview` 873 张联系表、52 张棋盘渲染，逐图目视通过（`.cache/maps/assets/` 的联系表，本机）。之后任何流程重建都应得到同一个 packId（构建是确定性的）。
- 文档：original-skin.md §6「按地图素材与选关流程」；ui.md、design-draft.md 的节日区间。部署：数据包一变素材包必须重建，且要带 `--video`（deploy.md §9.6）。

### 27.4 选关界面与飞行动画（T3，客户端）

- **选关**（`ui/classic/screens/layout.ts`）：STAGE_MAPS = taiwan / china / japan / usa（下标即 gm）；新增 `stageOf`、`setupBgKey`、`FLY_VIDEO` / `flyVideoKey`、`stageCheck`。竖栏按 exe 贴在整屏 (445,10)（0x404f71；此前目视值 448），关卡行点击区按竖栏坐标推算，即整屏 (457,31+32k)–(625,62+32k)（exe 0x46aac4 第 9–12 项），勾画在竖栏内 (150,20+32k)（y 表 0x46ab2c），即整屏 (595, 30+32k)。点关卡行播 `click`（全局 UI 音效表第 1 项，exe 0x405439 push 0x47f602），不是下拉框的 `move`。手机横屏 / 粗指针下关卡行只读（32 高、四行紧挨，缩放后约 25 CSS 像素），开局设置用两列面板里的地图下拉、大厅的房主用左抽屉「房间设置」的地图下拉选图。**去掉 StageBanner 与 SETUP_BANNER**：原版开局设置没有这条横幅，Panel 帧 11–14 只在「下一关」列表里用。
- **开局设置**（`ClassicCreate.tsx`）：关卡行改成按钮，只有 `/api/maps` 里存在且 playable 的图可点，其余变暗、禁用；点选写 `draft.mapId`（与左侧地图下拉双向同步）、播 `move` 音效、打勾、背景换 jump#gm。新组件 `parts.SetupBg`：jump#0 垫底，该图的 `title.setup.bg.<id>` 不可用时回退 jump#0（exe 0x406c05 / 0x40549c）；`SCREEN_KEYS` 仍只要求 `title.setup.bg`。建房缺省地图改取服务器的 `defaultMap`（`settingsDraft` 新增 `FALLBACK_MAP_ID`、`mapAfterList`；`defaultMap` 不可开局时取列表里第一张可开局的图），程序化皮肤的 `CreateRoomForm` 同样。
- **选人大厅**（`ClassicLobby.tsx`）：背景跟随房间地图；房主点关卡行发 `room:updateSettings {game:{mapId}}`，非房主与读档后的大厅只读；`ClassicRoomScreen` 的进房中 / 出错画面在已知房间时用该图背景；标题画面仍是 jump#0。
- **节日插画**：`assets.holidayArtKey(globalMapId, holiday)` = `illustration.holiday.<[0,24,43,63][gm]+slot>`（exe 0x473098），slot 超出 [24,19,19,20] 返回 null（fixture 等没有 gm 的图也是 null）；`CalendarPanel` 传入 `map.def.globalMapId`。三张新图的节日名（`events:holiday.<id>.h<slot>`）是我们自写的，对照节日插画目视：日本 h1、h2 都写「新年」，大陆 h6 写「党的生日」，美国 h0 写「除夕」，没有原版文案出处（TODO，待用户过目）。
- **飞行动画**（新文件 `screens/FlyVideo.tsx`，DEV-24）：`IntroVideo` 泛化出 `videoUrl(key)` 与共用的 `VideoOverlay`。只在原版房间页播，条件是本页亲眼看到大厅 → 对局（或单机页刚建房开局留下的 `rich4.flyFresh` 记号）；读档开局（开局前大厅里有 `loadedSave`）、刷新 / 重连 / 中途进房、观战、`?anim=instant`、素材包缺条目都不播；按「房间码:epoch」记在 sessionStorage（读写都容错）。可跳过（按钮与 Esc / Enter / 空格，在捕获阶段接管，不会同时触发空格掷骰）；轮到本人决策时跳过钮醒目（`data-urgent`）；5 秒还没开始、或超过条目时长 + 3 秒都直接结束；叠在 Loading 之上（z 205）；浏览器不许有声自动播放时照片头的做法静音播放。MapDef 与状态里都没有「读档恢复」字段（服务器开局时清掉 `loadedSave`），所以「新局」用「本页见过大厅 → 对局且大厅里没有 loadedSave（或单机记号）」判断，再以 `view.clock.elapsedDays === 0` 兜底。
- **暂缓回放**：新接口 `EventPlayer.hold(): () => void`（解除函数幂等，`player.held` 可读）：暂缓期间批次照常入队、积压照常累计，全部解除后接着播，积压按现有追帧规则加速或跳过；`reset`（快照）照常直达，`dispose` 清掉所有持有者。播放期间 `uiStore.introPlaying` 为真，`audioWiring` 在对局中返回 `screen: none`，不放棋盘曲，播完由导演层切回 `game`（原版 0x41525d 飞行动画后从棋盘曲第 0 首开始，未与原版对照，VERIFY V-U10）。
- **素材预取**（`skin/resolve.ts`、`skinStore.ts`、`PackClient.ts`）：对局时预取「当前地图组 + `board.landmarks`」（`SHARED_BOARD_GROUPS` / `mapWarmGroups`），不预取其他三张图的组；素材包里有 `board.landmarks` 而它加载失败时，与地图组失败一样判 group-missing、回退程序化棋盘；旧素材包没有这个组时忽略。
- **i18n 与开发页**：`lobby:maps` 加 china / japan / usa；`classicScreens` 加 `fly.*` 与带图名的 `stageNone`；`events` 加三张图的节日名；`ui` 的 `dev.map.taiwanHint` 改为通用的 `dataHint`；`dev/mapSource.ts` 的 MAP_CHOICES 加三张图，`dev/MapPreview.tsx` 对所有原版图显示数据提示。只重生成这 4 个命名空间的 zh-TW。
- **顺带修复**：原版全屏视频层与 Loading 整图在手机横屏和桌面上被上下裁切（视频元素高度按宽度推出，812×375 下为 812×609）；改为绝对定位后按 4:3 留黑边，片头也一并修好。
- **测试**：`screens.test.ts`（关卡行与勾按 exe、STAGE_MAPS / setupBgKey / flyVideoKey、flyMedia、shouldPlayFly 矩阵）；`screens.dom.test.tsx`（defaultMap 缺省、点关卡同步下拉 / 勾 / 背景、不可开局变暗、背景回退 jump#0、大厅房主改图 / 非房主与读档只读）；`flyVideo.dom.test.tsx` 7 例（新局播一次、ended / 出错 / Esc 结束且 Esc 不外传、醒目跳过钮、读档不播、刷新 / 观战不播、instant / 缺条目 / fixture 不播、单机记号）；`classic.test.ts`（台 h0→0、h23→23；陆 h0→24、h18→42；日 h0→43、h18→61；美 h0→63、h19→82；越界 / null）；`classic.dom.test.tsx`；`EventPlayer.test.ts`（hold）；`audioWiring.test.ts`；`resolve.test.ts` 与 `skinStore.dom.test.tsx`（board.landmarks 预取与失败回退、不预取其他图）；`stores.test.ts`（mapAfterList）；`lobby.dom.test.tsx`；`keys.test.ts`；E2E `skin-classic-screens`「选关」（拦截 `/api/maps` 返回四张图，美国不可开局、缺省大陆）与 `lobby.spec`（建房缺省地图 = `/api/maps` 的 defaultMap）。

### 27.5 引擎与表现层适配（T4）

- **日历**（`engine/rules/calendar.ts`）：文件头注释改写：v2.06 反汇编 fcn.00450a17 0x450b12–0x450b6c 直接看到「w < 当月 1 日的星期 → 7」的写法，美国图 kind 2 落到星期日的原版缺陷在 v2.06 上也有了静态证据（不再只是从 v3.11 推断）。`calendar.test.ts` 新增 5 组美国用例（HolidayDef 字面量）：1998-01-18、1998-09-06 都是星期日；11 月第 4 个星期四 1998 年为 11/26，2002 年落到 11/24 星期日；2001 年 5 月第 5 个星期一不命中（1998 年落在 5/31 星期日）；5 月第 2 个星期日各年都正确（VERIFY V-M10）。
- **行业测试图**：新 fixture `test-industries`（`test-map-industries.json`，dataHash `c5d05173…`）：航空、电子、汽车、石油（流通股 0，同中國石油）、建设五家企业；同时有环路式医院（20 既是保释格也是关押格）与台湾式监狱（16 保释，16→25 封路，26 在支线尽头关押）。只给测试用，没有注册进 `buildFixtureMaps`（`/api/maps` 与 E2E 不受影响），另加 `buildTestOnlyFixtureMaps`，由 `npm run fixtures` 一起写出。`mapIndex.test.ts` 测两种关押结构的 jailGate / hospitalGate / holdTile、前进候选与 placeableTiles（按 V-M7 锁定现状）；`engine/scenario/industries.scenario.test.ts` 9 例：航空转盘 0–3 与出国 n 天（回来仍在原节点）；电子、汽车（机车）、石油（汽车，3 步）按座驾系数 × 步数收费，步行免费；石油只能现场认购；建设公司选地、董事长免费加 2 级；环路医院出院（来路与保释格相邻时沿用来路，否则取 nb[0]）；台湾式监狱（命运 33 关进支线尽头 26，获释搬到 16，往 17 走）；环路关押格同格（被关的人不算在棋盘上，路过的人会被问保释）。test-industries 自对弈：random + check-fold 120 局、original 60 局、basic 3 人 40 局全部结束，rejects / invariantErrors / errors 都是 0。
- **原版棋盘**：`game/orig/confinedSpread.browser.test.ts` 确认「同格多人按座位错开」对被关的棋子同样生效；`OrigBoardView.landmarkWorld` 仍未启用（V-M7 ①）。
- **股市行业图**（`venues/a/layout.ts` stockIndustryFrame）：从按股票序号取模改为按所属企业的行业码查 exe 表 0x4733b7（Panel#75 帧 3–11 已目视核对），日本图（gm 2）电子业改用帧 8（0x42947c–0x42948a）；反汇编 0x429450 另外表明没有企业的股票原版不画行业图。**台湾显示因此有三处变化**：臺灣人壽 帧 4 → 5，大宇百貨 帧 5 → 4，9 支没有企业的股票不再有图（纠正原来的取模错误，VERIFY V-U4 待用户截图确认）。
- **拍卖缩图**（`venues/b/auctionLayout.ts`）：`mapStyleIndex` 改按 `globalMapId`（exe 0x43ad6e：Panel#26 帧 29 + 5·gm + L），不再按 id 子串。
- **命运 33–36 按图**：调试脚本从 rich4.exe v2.06 读出处理函数表 0x473d14 表项 37–48 的原文（与 tables.v206.json 逐项一致），反汇编确认分派为 k + 4·gm（0x44c5c7 / 0x44c6a0）；`zh-CN/fate.json` 增加 `33–36.byMap.1–3`（zh-TW 只重生成 fate.json）；`eventText` 的 fateTitle / fateShown.text 按 globalMapId 选文案；变体各有自己的语音（voice 0222–0233），`soundMap` 的命运语音按图换成 `fate.<k+4gm>`；`presentation/names.ts` 给 NameKit 加可选的 `globalMapId()`，`logFormat` 与 `handlers/events` 改用 `shown.text`。
- **原版命运板没有接回**（可选项）：原版皮肤的命运弹窗仍整体回退到程序化弹窗，33–36 的按图插图（0x473dd8）没有接；要接回得新做版式（TODO，VERIFY V-M11 / V-U12）。
- **长名称**：按 12px 字宽与栏宽估算，「拉斯維加斯 N」约 71px，资产表、公布栏、股市、建设公司选地都放得下，没有改布局。
- 规则没有改动，ENGINE_VERSION 不变（0.4.0），台湾 golden 不变。V-M7 核实后如要改：`flow/turn.ts:71-80`、`mapIndex.ts:68-71`、`decisions/targets.ts:144-146`；影响台湾 golden 时升 ENGINE_VERSION，用 `RICH4_GOLDEN_MAPS=all` 刷新快照；画法按截图结论启用 landmarkWorld。（释放位置与方向已按 exe 改完，见 §29；放置规则与画法仍按本条）

### 27.6 golden 与自对弈（T5）

- **golden 泛化**：`packages/shared/src/engine/golden/taiwan.test.ts` 改为 `maps.test.ts`，按 MAPS = taiwan / china / japan / usa 表驱动：`dataDirFor(id)`（RICH4_DATA_DIR 里含这张图的数据包目录）、`loadMap(dir, id)`（fixture + 这一张原版图）；每张图各有 `__golden__/<id>.json` 与各自的 mapHash 守卫；数据包里没有这张图或还没有快照时单独 skip，mapHash 不同时 skip 并提示重新生成。四张图共用同一组 4 局（种子 7a1a0001–4，30 / 91 / 182 / 365 天，角色各不相同），快照格式不变。新增 `RICH4_GOLDEN_MAPS`（逗号分隔；不设或 `all` 为全部）：只跑点名的图；**`RICH4_UPDATE_GOLDEN=1` 必须同时点名**，否则直接失败、不写任何文件，免得顺手改掉 taiwan.json。刷新命令：`RICH4_UPDATE_GOLDEN=1 RICH4_GOLDEN_MAPS=china,japan,usa RICH4_DATA_DIR=./rich4-data npx vitest run --project shared src/engine/golden`。
- **三份新快照**（ENGINE_VERSION 0.4.0，四局 AI intent 被拒 0 次，同种子重跑完全相同）：

  | 图 | mapHash | 30 天 | 91 天 | 182 天 | 365 天局 |
  |---|---|---|---|---|---|
  | taiwan（不变） | `3c2f31eb596b…` | 182 action | 524 | 960 | 1657 action，第 268 天 lastStanding |
  | china | `a36d1285be25…` | 185 | 522 | 1006 | 1965 action，打满 365 天 |
  | japan | `0fc7c82a5d02…` | 188 | 501 | 994 | 1283 action，第 229 天 lastStanding |
  | usa | `52a0d97ced74…` | 173 | 515 | 972 | 1000 action，第 182 天 lastStanding |

  四局里的小游戏（MINIGAME_ENDED）：台湾 0、大陆 54、日本 50、美国 38；企业收费（COMPANY_FEE）：台湾 50、大陆 35、日本 60、美国 56。
- **自对弈**：`apps/server/scripts/simulate.ts` 新增 `--stats`（各事件类型次数、COMPANY_FEE 按行业码、CONFINED 按「地点 / 起因」、各决策种类次数；不影响 finalHash / journalHash，已核对有无 `--stats`、单线程与 `--workers 4` 的哈希相同），注释补上原版四张图。批跑脚本 `test/maps-t5-sim.sh`（本机，输出 `.cache/maps/t5/sim/`）：每张图 original 1000 局（`--workers 8 --time-limit 730`）、random + `--check-fold` 300 局、basic 3 人 100 局，同参数各跑两次核对 finalHash。**24 次运行全部 exit 0**：每组 finished = 局数、rejects = 0、invariantErrors = 0、errors = 0，两次的 finalHash 与 journalHash 都一致（本机负载约 13–14，original 1000 局每次 6–8.5 分钟，没有降局数）：

  | 图 | original 1000 局：平均天数 / 每局 action / 结束原因 | finalHash | random + check-fold 300 局 | finalHash | basic 3 人 100 局 | finalHash |
  |---|---|---|---|---|---|---|
  | taiwan | 345.1 / 1730 / lastStanding 1000 | `29bb577e41ff6d7b` | 131.5 / 2996 | `561347e28d5fcc2f` | 377.5 / 1335（timeLimit 1） | `0c351829d954eb65` |
  | china | 497.0 / 2444 / lastStanding 951、timeLimit 49 | `0439f98f34480dde` | 194.5 / 4564 | `59bf0c092a1ad9b7` | 546.7 / 1922（timeLimit 8） | `fcb4984078e02f90` |
  | japan | 318.7 / 1635 / lastStanding 1000 | `804bcebbf73e8034` | 131.1 / 3016 | `2c7c8c261bacdde3` | 441.8 / 1573（timeLimit 2） | `f0c3a79dfa0d1c57` |
  | usa | 361.7 / 1817 / lastStanding 997、timeLimit 3 | `ec7cad5fa24d9945` | 132.0 / 2967 | `86ed861c36c80d54` | 470.2 / 1678（timeLimit 3） | `14b95df28490de48` |

  每局平均事件次数（original 1000 局；括号里是 random / basic 3 人）：

  | 图 | 小游戏 MINIGAME_ENDED | 企业收费 COMPANY_FEE（按行业） | 其他 |
  |---|---|---|---|
  | taiwan | 0.12（0.18 / 0.16） | 保险 24.4 | — |
  | china | 33.9（14.0 / 29.7） | 保险 18.0、石油 6.2 | — |
  | japan | 26.0（10.9 / 34.0） | 电子 9.4、保险 11.9、汽车 4.5、建设 9.4 | 建设公司选地 CONSTRUCTION_PICK 13.1 |
  | usa | 23.9（7.9 / 29.9） | 航空 8.7、电子 10.6、保险 13.3、汽车 4.5 | 航空出国（CONFINED away / airline）7.2 |

  - 小游戏：台湾的三种小游戏格在医院支线上（释放时直接回到保释格），一局平均不到 1 次；三张新图的小游戏格在主环路上（日本在快艇段），原版 AI 局每局 24–34 次，真人局的节奏与计时压力会明显上升（TODO）。
  - 百货、银行没有企业收费（行业收费种类为 none），表里不列。basic 策略的 3 人局在四张图（含台湾）上都没有 COMPANY_FEE 事件，与地图无关，本轮没有深究。
  - 关押（CONFINED）每局（original）：三张新图住院多于台湾（身上的炸弹爆炸 6.4–8.5 次、路面物件 5.6–7.4 次；台湾 5.5、5.1 次），命运坐牢日本、美国少于台湾（3.9、3.2 次；大陆 6.0、台湾 5.5 次）；统计原文在本机 `.cache/maps/t5/sim/summary.txt`（`node test/maps-t5-sim-summary.mjs` 生成）。
- 脚本：`simulate.ts` 的 `--map` 注释补上 taiwan / china / japan / usa。`loadtest.ts` 按房间轮换地图是可选项，没做（TODO）；服务器代码不改，`DEFAULT_MAP` 仍为 taiwan。

### 27.7 验证

- T5：`npx vitest run --project shared src/engine/golden`：没有 RICH4_DATA_DIR 时四张图 skip（1 通过 4 跳过）；`RICH4_DATA_DIR=./rich4-data` 时 5 条全过，连跑两遍稳定；`git diff` 里 `__golden__/taiwan.json` 为空（sha256 `b6075520…a112` 不变）。`npx vitest run --project shared` 83 个文件 820 通过 4 跳过。`npm run typecheck`、`npm run lint`（1269 个文件）、`check:no-original`（1693 个文件，含三份新快照）、`check:determinism`、`check:deps`、`check:zh-tw` 通过。自对弈见 §27.6。
- T1、T2 的验证见各自交接（数据包 `extract all` / `map build --strict4` / `verify --samples --map 0..3` / `pack`，`tools/extract` 单测与本机测试，素材试跑出包与 `assets verify --full`）。
- T3：`npm run typecheck`；`npx vitest run --project client-unit --project client-dom` 106 个文件 1344 通过；client-browser 13 个文件 65 通过 1 跳过；`check:zh-tw`、`check:deps`、`check:no-original`；本机手测（调研版数据包 + 叠加素材包）逐图截图。T4：`npx vitest run --project shared` 819 通过 1 跳过；台湾 golden 通过、`taiwan.json` 不变；`check:determinism`；`gen-fixtures --check`；`sim --map test` 200 局 random + check-fold 与 test-industries 三种策略自对弈全部结束、rejects / invariantErrors / errors 为 0；venues / presentation / game/orig 24 个文件 256 通过。
- **集成**（2026-09-30，端口 5815 / 3815）：
  - 逐文件核对各轨道没有互相覆盖：`cli.ts` 的 assets 用法已含 T2 的 `--strict` 与 preview 的 `--map-data`；T3 在独占路径外的小改（EventPlayer.hold、audioWiring、uiStore 注释、MapPreview、stores.test、lobby.dom.test）与 T4 的 presentation 改动（names / soundMap / logFormat / handlers/events / eventText）互不重叠；zh-TW 各命名空间与 zh-CN 一致（`check:zh-tw`）。工作区里另有修棋盘画布放大、收起座驾、toast 等会话的未提交改动（含 `flow/turn.ts`、`decisions/*`、`DEVIATIONS` 的 DEV-22、`design/client.md`），没有动。
  - 修正一处：T3 在 `e2e/specs/lobby.spec.ts` 加的「建房表单缺省地图 = defaultMap」断言在原版皮肤配置下失败——原版的开局设置是单独画面，没有第二个 `home-create` 可点；改为原版皮肤按 `create-cancel`（EXIT）回标题，程序化皮肤照旧再点一次「建房」收起表单。两种配置单独重跑都通过。
  - 数据包：四张图 `map build --strict4 --preview` 都 exit 0，产物与 `rich4-data/maps/` 逐字节相同（台湾 `14ef91e8…6c10`），四份 provenance 不变；`pack` 打到临时目录与 `rich4-data/` 逐字节相同（manifest `52ca1711…a86c`）；`verify --samples --map 0/1/2/3` 全过，`samples.map0.json` 仍为 `e60f74c5…`。
  - `npm run check` 全绿（vitest 319 个文件 3207 通过 5 跳过；lint 1274 个文件）；`--project extract` 55 个文件 523 通过 1 跳过；client-browser（`RICH4_CHROMIUM_PATH` 指向本机 chromium_headless_shell-1228）13 个文件里 `fx.browser.test.ts` 一条在负载约 13 时 30 秒超时，单独重跑 4/4 通过，其余 64 通过 1 跳过；golden：`RICH4_DATA_DIR=./rich4-data` 5 条全过，`taiwan.json` sha256 仍为 `b6075520…a112`。
  - E2E（`CI=1`）：默认配置 52 通过 1 跳过（deploy-restart 需要 `E2E_RESTART_CMD`）；原版配置 48 通过 4 跳过（按配置的既有 skip）1 失败（上面的 lobby.spec，修正后重跑通过）。`skin-classic-screens`「选关」与 `skin-pack-load` 两种配置都通过。
  - 真实素材包巡检（`RICH4_DATA_DIR=rich4-data`、`RICH4_ASSETS_DIR=rich4-assets`、免门禁；`test/maps-final-inspect.mjs`、`maps-final-confine.mjs`、`maps-final-names.mjs`，截图在本机 `.cache/maps/final/`）：四张图在桌面 1280×800 与手机横屏 812×375 下——开局设置点关卡后地图下拉同步，勾在舞台 (598, 30 + 32k)（审查修复后竖栏按 exe 移到 x 445，勾在 (595, 30 + 32k)），背景 `title.setup.bg.<id>`（台湾 `title.setup.bg`），大厅背景跟随；开局播对应的 flytw / flychina / flyjp / flyus（播放中暂缓回放，跳过后解除；手机横屏 4:3 留黑边），刷新不重播；皮肤判定 original、packId `daa850ef3a455b4a`、没有失败分组；日历节日插画 大陆 10/1 → `illustration.holiday.33`、日本 12/25 → `.61`、美国 7/4 → `.75`、台湾 10/10 → `.10`；股市行业图 台湾 臺灣人壽 帧 5、大陆 石油 帧 9、日本 ＳＥＧＡ 帧 8、美国 ＩＢＭ 帧 7；天使卡把一条街升到 2 级后拍卖，拍卖缩图 Panel#26 帧 31 / 36 / 41 / 46（= 29 + 5·gm + 2），成交后住宅换成买家的主人色；存档窗缩图 `ui.saveLoad/2–5`；「地圖」大图与小地图；日本快艇段 23–29 的快艇姿态；命运 33 的按图文案（大陆「街頭鬧事」、日本「誘騙未成年人」、美国「非法持有槍械」）；被关棋子画在关押格上，另一名玩家传送到同一格时按座位错开（房主暂停后截图）；获释后第一步 大陆 63→62、日本 55→54、美国 85→84、118→117，台湾医院 23 获释搬到保释格 16，与 §27.5 锁定的现状一致（V-M7 待用户核实）；托管期间大陆、日本各触发一次小游戏（MINIGAME_ENDED）；原版资产表里「拉斯維加斯 2」「喬治亞人壽」「ＳＥＧＡ」「王府井百貨」都不溢出；四张图切到程序化皮肤各看一遍棋盘。全程控制台 0 错误。
  - 回归（`test/maps-final-regress.mjs`）：台湾 30 天局托管到结束，第 10 天手动存档，新建房间读档开局不播飞行动画、托管到结束（两局排名完全相同）；早先版本留下的台湾自动存档（engine 0.4.0、第 23 天，`test/maps-final-old-save.mjs` 按导出格式写成 .r4save）导入后签名不同显示为非官方存档，读档开局 mapHash `3c2f31eb…` 没有失配，从第 23 天继续到第 26 天；旧素材包（packId `932c2c2602ab571f`，只有台湾皮肤）配新客户端：台湾原版棋盘，大陆 / 日本 / 美国经典界面 + 程序化棋盘（boardReason `map-missing`），开局背景回退 jump#0，节日插画回退为节日名，飞行动画照播，不崩溃、控制台 0 错误。
  - 没有覆盖到的：住宅 3–5 级只在素材联系表里看过（牌堆里天使卡只有 2 张，局内只升到 2 级）；小游戏画面、航空转盘、建设公司选地没有在真实新图上截图（由场景测试、自对弈统计与 fixture 图的 E2E 覆盖）；观战不播飞行动画只有 DOM 测试。

### 27.8 遗留

- 待用户在原版核实：VERIFY V-M1、V-M7、V-M9、V-M10、V-M11、V-U4、V-U10、V-U12（verify-checklist §5）。核实结论改规则、影响台湾 golden 时升 ENGINE_VERSION，并用 `RICH4_GOLDEN_MAPS=all` 刷新快照。
- 三张新图的街道价格没有独立样本（MAP_SAMPLES 留了位）。
- 开局设置头像格 (4,10) / (4,321) 的差异、机舱跳伞序列、`loadtest --map` 轮换、小游戏频率对真人局的影响：见 TODO「原版另外 3 张图」。
- 线上部署等用户同意（deploy.md §9.6）。

## 28. 用户反馈修复：收起载具、百货按原版、联机隐藏手牌（2026-10-01）

本节之后以代码和本节为准；与 §5.7、§20 等处「手牌默认公开还原原版」的说法冲突时以本节为准。

### 28.1 收起载具（V-R29）

- 原版：骑机车 / 坐汽车时真人道具欄右下角（格号 14）画 Panel#11 图 15 / 16（「车 + 禁止圈」），点一下调道具函数表第 14 项 0x4467b1：
  身上的车回背包、改为步行、1 颗骰子，不说台词、不扣道具、不结束回合、次数不限；工程车不能收起；原版电脑从不收起。
- 引擎：新 intent `STOW_VEHICLE`（TURN_MENU，非终结）；`TurnMenuOptions.vehicle?: {current, canStow}`（可选，旧存档没有时客户端不显示入口）；
  `effects/items/vehicle.ts stowByHand` 复用 `stowVehicle`（车回背包，同种满 10 台时回共享库存）；`VEHICLE` 事件新增可选字段 `stowed`，
  只在真人收起时出现，客户端据此不弹提示、不放音效、日志记「收起××，改为步行」。电脑策略不变，golden 不变；`randomIntent` 的候选含 STOW_VEHICLE。
- 界面：原版皮肤道具欄第 15 格固定画 ui.itemBar 帧 15 / 16（`stow-vehicle-icon`）；程序化背包页「收起X，改为步行」（`inv-stow-vehicle`）。
- ~~未做（docs/TODO.md）：梦游卡结束后原版会恢复座驾；工程车模式下原版仍能用机车 / 汽车道具直接顶掉工程车；收起时的通用换车闪光。~~（2026-10-03 已按原版改，§34）

### 28.2 百货道具按原版（V-R30）

- 引擎 `flow/shop.ts`：SHOP_BUY_ITEM 的 qty 必须为 1；本次进店买过的道具不能再买；真人只能买进店时有库存的（`listed`）。
  `decisions/economy.ts` 给道具行加 `listed`、`bought`，`maxQty` 只会是 0 / 1；两者都从本次交易记录推出，不新增帧字段。
  原版电脑本来就一次买 1 个、不重复买（0x42e620..0x42e6ea），所以规则对所有座位统一生效，golden 实测不变。卖道具仍允许 qty > 1（DEV-27）。
- 界面：两种皮肤都去掉库存与数量钮，买过的行变灰（原版灰字 #a0a0a0、描边 #101010）；原版货架行不再写持有数。
- ENGINE_VERSION 暂未升：随下一项规则改动（监狱 / 医院获释位置，docs/TODO.md）一起升 0.5.0 并刷新四张图的 golden（已在 §29 完成）。

### 28.3 联机隐藏手牌（DEV-25）

- 规则：`net/room.ts effectiveHandVisibility`——座位上真人 ≥ 2 时 `handVisibility` 锁定为 `private`，写进房间设置，随快照与存档保存，只会从公开改为私密。
  `Room.launch`（开局、读档开局）与 `Room.restore`（重启恢复，按座位上的真人占用计数）都按这条规则锁定。
- 投影（`view/project.ts`）：他人的 `cards` / `items` 为 null，另给 `cardCount` / `itemCount`；私密时 `GameView.pools` 为 null、事件去掉 `post.pools`；
  他人的 `hostility` 只保留「对观察者本人」一项（抢夺卡结算时敌意增量等于被抢物的标价，第三方可据此反推种类），观战者全为 0。
  事件 privacy 改为 `'redactHand'`：CARD_GAINED / CARD_LOST / SHOP_TRADE / CHAIRMAN_GIFT / ITEM_GAINED / ITEM_LOST 对非本人置 null；
  SHOP_OPENED.shelf 只给进店的人；CARD_USED 只在抢夺卡抢道具时把道具种类限给双方。view、batch、catchup、快照、观战、时光机都走同一投影。
- 公开保留：卡片张数与道具总数、正在骑的交通工具、点券、出卡 / 用道具 / 被动卡亮卡、公布栏、研究所成果；抢夺卡与命运「生日」的对手清单
  只在 DecisionForYou 里发给出卡人本人（与原版「先看清单、可以取消、不扣卡」的信息量相同）。
- 电脑：纯电脑座位用全量视图，决策不变；真人座位的托管与超时代打按房间设置降级。
- 泄漏扫描：`view/handLeaks.ts findHandLeaks`，服务器集成测试、客户端 viewFold 测试与 E2E（hand-privacy.spec）共用。
- 大厅说明：两种皮肤的房间设置下加一行（`room-hand-hint`）：真人 ≥ 2 或房间已锁定私密时为「他人无法查看自己手牌及道具」并高亮，
  否则为「两名以上真人时，他人无法查看自己手牌及道具」（settingsDraft.handPrivateNow）。
- 已知仍可推断的途径（未处理，见 TODO）：点券变化反推成交价、研究所成果、命运 / 魔法屋「卖光」金额、免费卡 / 嫁祸卡的决策种类与停顿。

## 29. 用户反馈修复：监狱 / 医院获释位置按原版（2026-10-02）

用户反馈：进监狱或医院后，人物应出现在监狱 / 医院设施外的第一格，而网页版获释后出现在画着铁栏 / 红十字的保释格大圆盘上。
本节之后以代码和本节为准；与 §17、§27.5、design/engine.md 旧版「获释搬到保释格、恢复保存的朝向（或取 nb[0]）」的说法冲突时以本节为准。

### 29.1 取证（VERIFY V-M7，v2.06 radare2）

- 被关：节点写成关押格（type 8001 / 8002，`MapIndex.jailHold` / `hospitalHold`；监狱 0x43c34c、医院 0x43d9d9），来路写 0（0x43c359 / 0x43d9e6）。
- 获释 0x40d184（期满、新闻 0、保释都走这里）：只置 +0x15 bit4（走回棋盘）并按景观→关押格算朝向，**不改节点与来路**；画面上从景观走 1 步到关押格。
- 下一次起步 0x40bc10–0x40bc89：候选 = 邻格 ≠ 来路且未封，`rand() % n`，0 个候选才掉头；来路 0 → 全部未封邻格都是候选。
- 走到关押格只调附身神明作用 0x40edf3 与工程车 0x447634，不触发落点事件。关押期间不画棋子（0x4082a5–0x4082c3）。
- 各图：台湾监狱 1、医院 23 在封死支线的尽头（支线 1→…→12、23→…→16，共 25 格，含全图仅有的 3 个小游戏格 25 / 101 / 71），从环路进不去；
  大陆监狱 144、日本监狱 84 同为支线尽头；大陆医院 63、日本医院 55、美国医院 85 与监狱 118 在环路上（关押格就是落点码 5 / 4 的格）。

### 29.2 引擎（ENGINE_VERSION 0.5.0）

- `flow/turn.ts release()`：jail / hospital 分支改为 `node = prevNode = 关押格`（hotel / away 不变），清 `savedPrevNode`，`returning = true`；@source 见函数注释。
  `prevNode == node` 等价于原版来路 0：`MapIndex.forwardCandidates(at, prev)` 只排除 `to === prev` 与封路的边，四张图与 fixture 都没有自环，
  所以全部未封邻格都是候选；`rules/movement.ts nextTile` 只有 1 个候选也照样消耗一次 `fork` 随机数，每步随机数消耗规律与原版一致。
  走回棋盘那一回合仍是 `LAND{stage:'object', skipSquare:true}`：只做物件结算、神明显灵与工程车，不触发关押格的落点事件（关押格本来不能放物件）。
- `flow/confine.ts applyConfinement` 不再写 `savedPrevNode`；字段保留、恒为 null（state.ts、validate/schema.ts、setup.ts 不改），`STATE_SCHEMA_VERSION` 仍为 1，不写迁移。
  旧快照：在押的人本来就在关押格（M6 起 applyConfinement 就写关押格），获释时清掉旧值；旧版本里刚获释、站在保释格上的人照常从那里继续
  （`test/jail-legacy-restore.ts` 模拟 0.4.0 快照经 migrateState + validateState 后继续推进：通过）。
- `ENGINE_VERSION` 0.4.0 → 0.5.0，同时承认 §28.2 的百货规则（version.ts 写明两项）。服务器重启恢复按 `RoomManager.rulesVersion`（major.minor）判定：
  0.4 ≠ 0.5 → 进行中的房间走 `migrated`（只迁移快照、不重放 journal，`migrateState` 同版本原样返回、`validateState` 通过），由 `restore.test.ts` 覆盖，
  真实引擎的升级路径另有集成用例 `restart-recovery.test.ts`（§29.8）；存档按原样读取。
- 测试辅助 `testing/scenario.ts bench()` 与客户端 `realEngineM7.test.ts` 不再写 `savedPrevNode`。
- AI 不改：`ai/view.ts lookbehind` 在获释后来路 = 节点 = 关押格时得到 `[关押格, 未封邻格…]`，与原版 v3.11 0x40b343 在来路 0 时相同（节点 0 是全 0 哨兵、没有邻接，第一格回落为关押格，之后排除 0 = 全部未封邻格；§29.9）。

### 29.3 golden（四张图刷新）

`RICH4_UPDATE_GOLDEN=1 RICH4_GOLDEN_MAPS=taiwan,china,japan,usa RICH4_DATA_DIR=./rich4-data npx vitest run --project shared src/engine/golden`，
再不带 UPDATE 跑两遍（`RICH4_GOLDEN_MAPS` 不设 / `all`）均通过；mapHash 不变，四张图 16 局 AI intent 被拒 0 次，每步不变量检查通过。
变化原因：获释后的位置与第一步方向改变，之后的随机序列与对局走向全部不同（前 160 个事件类型不变，第 0 或第 1 个 400 事件检查点起分歧）。
台湾的 3 个小游戏格都在医院支线上，此前几乎走不到，刷新后开始出现小游戏。各局 事件数 / CONFINED / RELEASED / MINIGAME_ENDED（旧 → 新）：

| 图 | 一个月 | 三个月 | 半年 | 一年 |
|---|---|---|---|---|
| 台湾 | 833→833 / 3→3 / 3→3 / 0→0 | 2610→2457 / 10→12 / 10→15 / 0→7 | 5082→5199 / 19→21 / 33→23 / 0→8 | 7681→9744 / 21→33 / 27→41 / 0→23（268 天 lastStanding → 365 天 timeLimit） |
| 大陆 | 832→832 / 2→2 / 1→1 / 2→2 | 2508→2472 / 12→9 / 11→10 / 6→8 | 5156→5086 / 16→16 / 16→16 / 18→22 | 10335→10106 / 36→36 / 48→39 / 28→19 |
| 日本 | 861→871 / 3→3 / 3→3 / 4→3 | 2589→2610 / 11→8 / 13→8 / 10→8 | 4563→5166 / 13→13 / 14→13 / 14→11 | 6172→9486 / 22→30 / 25→37 / 22→31（229 天 lastStanding → 365 天 timeLimit） |
| 美国 | 835→835 / 2→2 / 2→2 / 3→3（事件逐个相同，只有终局哈希因版本号变化） | 2498→2556 / 13→13 / 14→15 / 2→7 | 4993→5026 / 18→17 / 24→25 / 16→16 | 4780→8529 / 17→24 / 25→45 / 17→23（182 → 334 天，仍 lastStanding） |

（RELEASED 含旅馆、出国期满；比较脚本 `test/jail-golden-diff.mjs`。）

### 29.4 客户端

- 不用改代码：两种皮肤的棋子位置都跟引擎走。RELEASED 的 post 只有 `returning`（节点没变），`syncFromPost` 不重新摆放、舞台 `syncWorld` 同步到的仍是关押格；
  RETURNED `placeActor(座位, 关押格)`；之后 MOVE_SEGMENT 从关押格起步。逐一核对过 `handlers/status.ts`、`handlers/turn.ts`、`game/orig/**`（OrigBoardView / OrigActor / poses / OrigStage）
  与程序化棋盘（BoardStage、PlayerActor、LandmarkView），没有「获释跳到保释格」的逻辑（旧位置完全来自引擎的 post）。
- 关押期间的显示保持现状（原版皮肤画关押姿态、程序化画关押窗口气泡，与同格棋子错开）；原版其实不画，登记 DEV-29。
  （2026-10-03 已按原版改：关押期间不画、获释时从景观走一步出来，§32。）

### 29.5 测试

- `engine/scenario/industries.scenario.test.ts`「关押结构与释放方向」改写：环路医院 20 获释后 node = prevNode = 20（关押前来路两种都试），
  `force('fork', 0 / 1)` 分别走到 19 / 21；台湾式监狱获释仍在 26，`force('fork', 0)` 被消耗（单候选也取随机数），掷 2 点 26 → 25 → 16。
- 新增 `engine/scenario/jailRelease.local.test.ts`（有 RICH4_DATA_DIR 时运行，16 例）：四张图各自用命运 33 坐牢 / 命运 12 住院，RETURNED 在关押格，
  台湾 1 → 2 → 34 → 4 → 33 → 3 → 32、23 → 24 → 99 → 25 → 26 → 100 → 101，大陆 144 → 143 …、日本 84 → 83 …；环路上的 63 / 55 / 85 / 118 两个方向。
- `scenario/buy-upgrade-toll.test.ts` 地契到期用例：原来整月自然推进，新轨迹里新闻先把 L1 清掉了；改为 setDate 到到期前一天再推进一天（断言不变）。
- 客户端：新增 `presentation/handlers/release.test.ts`（真实引擎 × handler，台湾式监狱 26 与环路医院 20：被关、获释、走回棋盘都在关押格，从不摆到保释格 16，
  下一次 walk 的路径以关押格开头）；`m6m7.test.ts` 的 RELEASED 假 post 改为不带 node、断言不重新摆放。
- E2E：`skin-classic-venues-b.spec.ts` 新增「获释留在关押格」（2 名真人，魔法屋坐牢 → 保释 → 获释后两页 view 与棋盘上都在 14、来路 14、非关押外观；
  下一回合强制岔路 0 往回走到 13）。
- 顺带修了 `apps/server/test/integration/full-game-4p.test.ts` 的偶发失败：§28.3 起他人的敌意按观察者裁剪，终局视图比较时一并去掉 `hostility`（与本改动无关，随机种子下约 1/3 失败）。

### 29.6 验证

- `npm run typecheck`、`npm test`（329 个文件、3262 例通过；client-browser 未装默认浏览器时自动排除）、`check:determinism`、`check:no-original`、`check:deps`、`check:zh-tw` 通过；
  `npm run lint`（`biome check .`）在本机被另一会话新建的 `.claude/worktrees/*/biome.json`（嵌套根配置）挡住，改为对 apps / packages / tools / e2e / scripts / test / deploy 运行，通过
  （整体验证时在 `biome.json` 的 files.includes 加了 `!!**/.claude/worktrees`，扫描器不再进入 Claude Code 的工作树，`npm run lint` 直接通过，见 §29.8）。
- `RICH4_DATA_DIR=./rich4-data npx vitest run --project shared`：88 个文件、867 例通过（含 golden 与 jailRelease.local）。
- client-browser（本机没有 Playwright 1243 的浏览器，用 `RICH4_CHROMIUM_PATH` 指向已装的 Chrome for Testing 1228）：64 例通过、1 例跳过，`audioEngine.browser.test.ts` 在整组运行时偶发顺序断言失败，单独重跑两次通过（与本改动无关；用 1228 的 headless shell 时 fx / OrigStage 两例超时，换完整版 Chrome 后通过）。
- E2E：原版配置 `skin-classic-venues-b` 4 例通过；默认配置下新用例通过。
- 真实素材包（packId `daa850ef3a455b4a`，实现端口 4111 / 6111，`test/jail-impl-shots.mjs`）：台湾坐牢（关押格 1，获释后乘快艇沿支线走到 32）、
  住院（关押格 23，获释后走到企鹅挖宝格 101）、大陆医院 63（获释后一次走向 62 一侧到 57，一次强制岔路 0 走到 64），原版与程序化皮肤，控制台 0 错误；
  截图在本机 `.cache/jail/impl/`（含原版素材，不入库）。

### 29.7 遗留

- ~~DEV-29：原版关押期间不画棋子、获释时从景观走一步出来；要不要照做由用户决定。~~（2026-10-03 用户要求照做，已按原版改，§32）
- V-M7 ③：关押格能否放物件、能否作跳伞落点仍待核。
- ~~AI `lookbehind` 在来路 = 关押格时的起点~~、~~关押期间被魔法屋「转向」改过来路~~：审查时核实两条都与原版无差异，已关闭（§29.9）。
- ~~AI `lookbehind` 一般情形与原版差一格~~（与获释无关，复核时发现，§29.9）：已按原版改，见 §31。

### 29.8 整体验证（2026-10-03）

验证端口 4121 / 6121。验证期间另一会话在工作区改了 §30 的文件（`shared/view/pacing.ts` 与客户端若干文件，引擎不依赖它们）：`npm run check` 与两套 E2E 全量在那之前开跑；
之后的真实素材包目视、读档 / 恢复与补跑都在「HEAD + 本节改动」的本机快照副本里进行（生产构建 + `vite preview`，不受热更新打断）。

- `npm run check` 全绿：`biome.json` 的 files.includes 加 `!!**/.claude/worktrees`（Claude Code 的工作树自带 `biome.json` 根配置，`biome check .` 报「嵌套根配置」退出；
  `!!` 让扫描器整个跳过该目录），lint 1286 个文件；vitest 329 个文件通过 1 跳过、3262 例通过 21 跳过；determinism / no-original / deps / zh-tw 通过。
  在快照副本里再跑一遍也全绿（两条 extract 用例在自对弈同时进行的高负载下超时，单独重跑通过）。
- golden：`RICH4_DATA_DIR=./rich4-data npx vitest run --project shared src/engine/golden` 连跑三遍 5 例通过，快照文件不变；`npx vitest run --project extract` 55 个文件 529 例通过。
- 自对弈（`npm run sim -- --engine-only --map <id> --data-dir rich4-data --workers 8 --stats --json`，时限缺省 730 天）：每组同参数两次，16 次运行全部 exit 0、
  finished = 局数，rejects / invariantErrors / errors 全为 0，两次的 finalHash 与 journalHash 一致。每局小游戏（括号里是 §27.6 的旧值）：

  | 图 | original 500 局：平均天数 / finalHash | 小游戏 | random + `--check-fold` 200 局：平均天数 / finalHash | 小游戏 |
  |---|---|---|---|---|
  | taiwan | 375.9 / `857789583b8571fc` | 15.64（0.12） | 152.4 / `a980c4513d7e62e0` | 9.07（0.18） |
  | china | 514.8 / `e1c3b1000783481c` | 30.54（33.9） | 188.7 / `9646d6170b534826` | 12.03（14.0） |
  | japan | 314.4 / `e4ac159ce2275255` | 23.15（26.0） | 118.4 / `26dcd8bad624f431` | 8.09（10.9） |
  | usa | 385.1 / `600aa508fcb9bccb` | 27.51（23.9） | 134.6 / `2ba641cec6a3760c` | 9.48（7.9） |

  `test/jail-verify-sim.ts` 按同一套种子重放 original 500 局（四张图的 finalHash 与上表一致），统计坐牢 / 住院获释：全部 RETURNED 都在关押格（保释 / 出院格 0 次）；
  台湾监狱 3931 次、医院 9331 次，获释后从关押格起步的第一步全部走进支线（2 / 24；其余是起步前又被关或对局结束）；台湾 500 局每局都有小游戏。
  支线尽头的大陆 144、日本 84 同样全部走进支线；环路上的关押格两个方向各约一半：大陆 63 → 62 / 64 = 5963 / 5928，日本 55 → 54 / 56 = 4359 / 4204，
  美国 85 → 84 / 86 = 5081 / 4985，美国 118 → 1 / 117 = 1425 / 1431。
- E2E（`CI=1`）：默认配置 56 通过 1 跳过（deploy-restart 需要 `E2E_RESTART_CMD`）；原版配置 52 通过 4 跳过（按配置的既有 skip）1 失败——`skin-original-stage`「cards 类」
  断言都已走完，收尾 `context.close()` 写 trace 时 ENOSPC（本机磁盘一度写满），单独重跑该文件 2 / 2 通过。两套里「获释留在关押格」都通过。
- 真实素材包目视（`test/jail-verify-shots.mjs`，原版皮肤 1920×1080，P1 每回合先摆到安全格再掷骰，P2 获释后强制掷 1 点看第一步）：台湾坐牢（关押格 1）、住院（23，画在 PARK 圆盘上）、
  大陆医院 63、日本监狱 84、美国医院 85——关押期间在关押格上画关押姿态（DEV-29），获释后人在关押格、换回常态，保释 / 出院格 12 / 16 / 78 的大圆盘上没有人；
  第一步：台湾 2 / 24、日本 83（各 2 次），大陆 63 五次 62、62、64、64、62，美国 85 五次 84、86、84、86、86；控制台 0 错误。截图在本机 `.cache/jail/verify/shots/`（不入库）。
- 0.4.0 兼容：
  - 存档：取早先会话数据库里 0.4.0 写下的存档（只读），按导出格式导入新版本、新建房间读档继续玩（`test/jail-verify-compat.mjs oldsave`）。大陆存档（第 10 天，1 号在监狱 144、
    2 号在医院 63，计数都是 0x80，带旧 `savedPrevNode`）读档后两人获释都在关押格，1 号 144 → 143 → 142 → 141 → 140、2 号 63 → 62，玩到第 14 天；
    台湾存档（第 11 天，0 号住院 23、2 号坐牢 1）获释后 23 → 24 → 99 → 25 → 26 → 100 → 101、1 → 2 → 34 → 4 → 33 → 3，玩到第 22 天；控制台 0 错误。
  - 进行中房间：同一台湾房间 0.4.0 的快照（数据库副本，座位令牌换成测试令牌，`test/jail-verify-restore-db.mjs`）启动时日志 `rooms restored ["145051:migrated"]`，
    真人回到房间后对局继续，获释同样留在关押格、玩到第 22 天。
  - 集成用例 `apps/server/test/integration/restart-recovery.test.ts`「真实引擎、规则次版本升级」：把快照改写成 0.4.0 写下的样子（1 号在关押格、计数 0x80、带旧 `savedPrevNode`，
    快照后另有一条 journal）→ 重启恢复为 `migrated`、journal 不重放 → 两人重连自动应答，1 号获释那一批的快照里 node = prevNode = 关押格、`savedPrevNode` 清空，
    第一步是关押格的邻格，对局再走 10 批以上、没有缺号。把 `release()` 换回旧实现时这条用例失败（prevNode 为 13）。

### 29.9 审查修复（2026-10-03）

- **遗留两条前提不成立，已关闭**（docs/TODO.md 同步）：
  - 魔法屋「转向」改不到在押的人：效果 7 在 `data/tables/magic.ts` 里 `skipConfined = true`，`effects/magic` applyToTarget 先跳过计数非 0 的人；
    原版 v2.06 0x431523 也一样（0x43152a `cmp dword [eax + 0x493942], 0` / `jne 0x431475`，即 +0x32 计数非 0 就跳过）。
    转向卡（`cards/control.ts`）与传送机（`items/research.ts` teleportCandidates）都经 `actorsInRange` → `boardPlayers`（`isOnBoard` 要求没有主阻碍）取目标，在押的人选不到。
    逐一核对引擎里所有写 `prevNode` 的地方：关押期间除调试 teleport 外没有路径会改在押者的来路，所以「被转向后再获释」这种叠加情形在原版和这里都不会出现。
    release() 里重写 prevNode 只对 0.4.0 旧快照起作用（旧快照里它本来也已是关押格），保留，不改。
  - AI `lookbehind` 在获释后的起点：v3.11 0x40b343 从来路格起步（读 0x496b76）、排除当前格（0x496b74），0 个候选回落为被排除的格、1 个候选不取随机数；
    原版来路 0 时节点 0 是全 0 哨兵（docs/research/g_map.md「1 基 + 哨兵」），第一格回落为关押格，之后从关押格出发、排除 0，即全部未封邻格。
    我们 prev = node = 关押格时 `nodes = [关押格, 未封邻格…]`，完全一致。
  - 回归：`effects/cards.test.ts` 新增「6 转向 / 11 传送机：在押的人不是候选」（陷害卡关进 14 后，回合菜单里转向卡、传送机的演员候选只有 0、1 号，对 2 号使用报 INVALID_TARGET，
    2 号 node = prevNode = 14 不变）；`effects/magic.test.ts` 效果 7 补断言在押的 2 号 node = prevNode = 14。分别做变异：`isOnBoard` 不看主阻碍时前一例失败，效果 7 的 skipConfined 改为 false 时后一例失败。
- **复核时另外发现**（与获释无关，未改，docs/TODO.md）：一般情形下原版 lookbehind 的输出从「来路格再往后一格」开始（三个调用方 v3.11 0x4212ad / 0x4213e0 / 0x42158f 都是 lookbehind(6)，用 out[0..5] = 往回第 2–7 格），
  我们第一格是来路格本身（往回第 1–6 格），电脑放路障（阶段二）/ 地雷 / 定时炸弹的选格差一格；改了会改变 AI 决策与四张图 golden，由用户决定。
- **@source 偏移统一**：`flow/turn.ts` release() 注释原写「不改节点 +0x1c 与来路 +0x1e」，那是按 0x493900 算的；同一行的 +0x15 与 confine.ts 的 +0x32 都按玩家记录基址 0x493910（步长 0x68，
  0x431548 从 +0x00 取名字指针）。改为「节点 +0x0c 与来路 +0x0e（VA 0x49391c / 0x49391e）」：r2 复核 0x40d197 `or byte [ebx + 0x493925], 0x10`、0x43c352 写 0x49391c（关押格）、
  0x43c35b 写 0x49391e（0）；v3.11 同一记法（基址 0x496b68，lookahead 0x40b221 读 0x496b74 为节点、0x496b76 为来路）。
- 验证：`npm run check` EXIT 0（typecheck 四个工作区；lint 1291 个文件；vitest 331 个文件通过 1 跳过、3348 例通过 21 跳过；determinism / no-original / deps / zh-tw 通过）；
  `RICH4_GOLDEN_MAPS=taiwan,china,japan,usa RICH4_DATA_DIR=./rich4-data npx vitest run --project shared src/engine/golden` 连跑两遍 5 例通过、快照 sha256 不变（引擎行为没变，不需刷新）；
  `RICH4_DATA_DIR=./rich4-data npx vitest run --project shared` 88 个文件 876 例通过；E2E `skin-classic-venues-b`（含「获释留在关押格」）`CI=1` 原版配置与默认配置各 4 / 4 通过。

## 30. 用户反馈修复：随机事件的原版画面（命运板、得卡亮卡，2026-10-03）

用户反馈：游戏中一些随机事件显示的卡片没有贴图。复现（本机原版包 `daa850ef3a455b4a`，两名真人、私密手牌）：原版皮肤的命运
整体回退到程序化翻面卡（没有插图，浅色字压在奶油底上几乎看不见）；卡片格与聖誕節得卡只有问号 FLIC、🃏 飘字与 toast；魔法屋
是自绘女巫卡片；新闻 / 命运板与卡片插画在慢网络下先空框。取证（v2.06 radare2）：命运板 fcn.0044c4a0、插图表 0x473dd8、亮卡函数
fcn.00440bac 的 10 个直接调用点里得卡只有卡片格 0x41abfa 与聖誕節 0x450e29。本节只改表现层与演出预算：**引擎规则、golden、
ENGINE_VERSION 不变**；素材包没有新登记的键，`rich4-assets/` 没有重建（仍是 `daa850ef3a455b4a`）。

### 30.1 命运板（`ui/classic/popups/FateBoard.tsx`）

- 板面 Panel#66 图1（`ui.newsBoard` 第 1 帧）贴 (0,0)；插图 `illustration.fate.<FATE_ART_TABLE[slot] − 436>` 不透明贴 (25,44)；
  slot = 命运处理函数表下标（`eventText.fateVariantSlot`：k < 33 为 k，33–36 为 k + 4·gm）；`layout.ts` 的 FATE_ART_TABLE 与
  tools/extract 资源目录同值（那边由本机测试逐项对 exe 核对）。
- 标题照原版字体（28px 粗体 #F0F0F0、#101010 的 (1,1) 阴影、字距 −1）写在 (24,330)；正文 20 / 16px 与金额写在标题下方、头像左侧
  （DEV-30）；表情头像 = 抽到命运的人的讲话头像（`portrait.speaker.<角色>`）图 `FATE_FACE[slot]`，按锚点画在 (390,344)，不进素材判定。
- 加持（FATE.blessing 不为 null）：第二个弹窗 `phase: 'blessing'`，宝石消息框画在 (220,129)（与亮卡同一个 `ShowBox`）。
- 跳过照原版：没有最短时间，任意鼠标键 / 按键放开就结束（`PopupScene.anyInputSkips`），跳过时 `ctx.audio.stopVoice()` 停掉语音
  （`AudioPort.stopVoice`，DEV-33）。原版命运板没有音效，只有语音；翻牌声 ZzFX `card` 只属于程序化翻面卡（§30.6）。
- 素材判定：`popupKeys('fate')` = `[ui.newsBoard, illustration.fate.<n>]`（加持段 `[ui.common]`）；素材不全时仍回退程序化翻面卡，
  这时卡面字色写死为墨色（`ui/popups/popups.module.css` 的 `.flipFace` / `.card`，魔法屋的程序化结果条同样修好）。

### 30.2 命运节拍（shared/view/pacing.ts，服务器截止时间同表）

- `FATE_VOICE_MS[49]`：Speaking#0185–0233 的时长（素材包 durationMs，1282–3816 ms），与 `ORIGINAL_FLICS` 记 FLIC 原长同一种做法。
- `fateShowMs(slot, blessing, profile)`：original = 板子 max(1.6 秒, 语音) → 加持消息框 1.5 秒 → 停 0.8 秒 → 收尾 0.1 秒
  （停顿时板子在不在、停顿放在哪，按各条命运的处理函数，§30.6）；compact 总长仍是 2.25 秒（有加持时板子 1.35 + 消息框 0.9）+ 收尾 0.2 秒。
- FATE 的 original 预算 = max(2600, 停留 + 加持 + 0.8 + 0.1 + 余量 0.1)，33–36 取四张图里最长的语音（事件不带地图）；compact 不变。
  程序化皮肤在 original 节奏下同样按这个节拍停留（翻面卡含加持结果，停满全程）。

### 30.3 得卡亮卡（`presentation/handlers/misc.ts` CARD_GAINED）

- 只有 `source` 为 square / holiday 时亮卡（`pacing.CARD_GAIN_SHOW_SOURCES`）：卡片格先等 FLIC Data#495（`stage.eventFlic`），
  聖誕節先 `board.focus(得卡人, 300 ms)`；然后放 Effect#62（`soundMap.CARD_SHOW_SFX`）、弹 `cardCast{variant:'gain', gainFrom}`
  停 `CARD_SHOW_MS[pacing].gainMs`（original 1.5 秒、compact 1.2 秒），亮完说按卡价分档的事件槽台词（`soundMap.cardGainVoice`，
  timed；卡价 > 100 槽 0、51–100 槽 0 / 1 二选一、1–50 槽 2）。原版皮肤亮卡时不弹 toast、不飘 🃏（日志照记）。
- 私密手牌：别人与观战者收到的 card 为 null → `popupKeys` 只要 `ui.common`，画「XX 得到一張卡片！」的消息框、不贴卡图，
  时长相同，不说分档台词（DEV-31）。其余来源与程序化皮肤保持 toast + 🃏（原版皮肤不飘 🃏 / 🎁：`popupStore.classicPopupHostActive`）。
- 预算：卡片格 FLIC 之后的等待两种节奏都按 original 的亮卡 1.5 + 0.1 秒预留（`FLIC_RESERVES.CARD_GAINED.extraMs`，客户端
  `game/fx/timings` 的 `ORIG_FLIC_WAITS.CARD_GAINED.after` 同值），original = 994 + 1600 + 100 = 2694、compact = 500 + 1600 + 100 = 2200；
  聖誕節 original 2000、compact 1700；其余来源 700 不变。预算与卡号无关（所有观察者同一预算）。

### 30.4 其他

- 魔法屋点名 / 施法：原版皮肤用宝石消息框 `MagicBox`（DEV-32）。
- 新闻 / 命运板下垫黑（`layout.ts` BOARD_UNDERLAY）：原版两块板都由 fcn.00454a55 整张不透明拷贝，素材包按 rgb0-backdrop 抠掉的
  像素（插图框下沿的阴影条）原来会透出棋盘（新闻板同样，旧问题）。
- 预取（`ClassicPopupHost`）：空闲时 `ui.common` 与 `ui.newsBoard` 的图集页直接下载位图，卡片插画之后再低优先级逐张预取本图会用到的
  命运插图（`fateArtPrefetchKeys(gm)`，台湾 32 张）与 36 张新闻插图。
- 董事长赠品：toast 写出卡名 / 道具名（`events:log.CHAIRMAN_GIFT_gift`，看得到的人才有）。
- 合成素材包（`tools/extract` syntheticUi）补上 40 张命运插图占位（按插图号画），E2E 原版配置下命运板可用。

### 30.5 验证

DOM：`ui/classic/popups/eventCards.dom.test.tsx`（49 个 slot 的素材键、板面 / 插图 / 标题 / 头像画点、加持框、跳过、得卡亮卡与私密消息框、
魔法屋消息框、预取）；handler：`presentation/handlers/eventCards.test.ts`；pacing：`shared/view/pacing.test.ts`；OrigStage 预算
（`handlers/budget.test.ts`，原版画面判定打开时命运板与得卡亮卡也在预算内、FLIC 原速）；E2E：`e2e/specs/skin-classic-event-cards.spec.ts`
（命运板插图键与文件、卡片格得卡本人亮真卡 / 别人与观战者只见消息框）、`skin-classic-dialogs`（命运改为原版板）。本机真实素材包截图与
拼图在 `.cache/evcard/impl/`（m-impl-montage.png、m-before-after.png）。剩余待核实见 VERIFY V-U13–V-U15、docs/TODO.md 末节。

整体验证（2026-10-03）：`npm run check` 全绿（vitest 331 个文件 3347 例）；`vitest --project extract` 55 个文件全过；golden 四张图
（RICH4_DATA_DIR）5/5 通过、本修复不涉及引擎（engine 不依赖 shared/view）。E2E 原版配置（skin-classic-event-cards、
skin-classic-dialogs、skin-classic-cards、skin-classic-venues-b、hand-privacy、events、cards、skin-original-stage）17 例与默认配置
（skin-classic-event-cards、skin-classic-dialogs、skin-classic-cards、hand-privacy、events、cards）11 例全过。本机真实素材包
（packId daa850ef3a455b4a，未重建）两名真人 + 观战、手牌私密、1920×1080 与手机横屏 844×390 实测（脚本 `test/evcard-verify.mjs`，
产物 `.cache/evcard/verify/`）：命运板四张图 33–36 的插图都按 slot 取对（台湾 33 / 36 → #464 / #467、大陆 34 / 35 → #468 / #469、
日本 33 / 35 → #471 / #466、美国 33 / 36 → #473 / #475），插图解码为 388×251，表情头像与 FATE_FACE 一致；original 节奏板子停留
实测 = max(1.6 秒, 语音) + 0.8 秒（误差 ≤ 15 ms），加持（小穷神附身后命运 14）板子 2.96 秒 → 消息框 1.5 秒，compact 节奏 2.25 秒 /
1.35 + 0.9 秒；本页点一下即结束且语音 cancelled，别的页面照常看完；卡片格与聖誕節亮卡 1.5 秒（compact 1.2 秒），本人卡图正确，
别人与观战者只见「得到一張卡片！」、没有卡图与 toast；魔法屋点名 / 施法是宝石消息框；董事长赠品（卡 / 道具）、魔法屋得卡、礼物盒只有
本人的 toast；拦掉 Panel#66 图集时命运回退程序化翻面卡，字色为墨色、看得清；开局空闲预取本图 32 张命运插图、36 张新闻插图、30 张卡图
与 Panel#66 图集。

### 30.6 审查修复（2026-10-03）

- **板面接住输入**（DEV-35）：新闻板、命运板（加持消息框、亮卡、魔法屋消息框不盖工具列，不变）在 440×480 板面上放一层透明的
  接住层（`PopupScene` 的 `shield`，`ClassicPopupHost.boardShield`）：只读场景整体 `pointer-events: none`，原先点板子顶部会同时点到
  板子下面看不见的工具列钮（复现：点 (260,20) 开出资产表、点左上开出说明框，(80–120,20) 直接切换托管）。接住层吞掉按下 / 放开 /
  点击 / 右键（不往下传、不弹浏览器菜单）；命运板放开即跳过（`useAnyInputSkip` 照旧在窗口捕获阶段听），新闻板可跳过之后点板子
  等于点跳过钮。板子期间经典快捷键暂停：`keyboard.useSwallowHotkeys` 在窗口捕获阶段对快捷键 preventDefault（`useClassicHotkeys` 与
  原版棋盘自己的 < > 监听都看 defaultPrevented），场景根另标 `data-input-shield` 供 `shouldHandleHotkey` 认；打字、按钮上的按键照常。
- **命运板之后的画面**（DEV-34，逐项地址见 VERIFY V-U13）：`events.ts` 的 `FATE_AFTER_BOARD[49]` 记各处理函数参数 1 的画面——
  redraw（一开始就重画地图）、focusLot（第 0、1 条先移镜头到地块）、keep（第 2–5、8 条没有加持时留板）。原版皮肤：keep 照旧停
  「语音 + 0.8 秒」再同步；其余（含所有有加持的）板子只停语音长度、有加持时接消息框，之后同步；FATE 自己的 post 有可见变化
  （`postShowsEffect`：贷款、股票、点券…）时再停 0.8 秒，否则不空等——真实引擎多数命运先发 FATE 再执行效果（`test/evcard-fate-posts.ts`：
  罚金 / 奖金在随后的 MONEY、关押在 CONFINED、拆屋 / 征收在 LOT_MUTATED + MONEY），效果事件紧接着板子演出。拆屋 / 征收：
  `LOT_MUTATED` 的 cause 为 fate 时先 `focus({lot}, 300)`，震屏后 0.4 + 0.3 秒的等待期间对同一点再 focus（镜头动画期间跟随不抢镜头），
  镜头停在地块上看着它变样（原版 fcn.004501ac 震动 + 停 400 → 重画 → 0x44a9b6 停 300），共 1.0 秒 ≤ 预算 1.2 秒。程序化皮肤不变。
- **原版命运板不放翻牌声**：soundMap 的 FATE 音效改为 `FATE_FLIP_SFX`（ZzFX `card`，timed：事件开始时导演层不放），FATE 的 handler
  只在程序化翻面卡时经 `ctx.audio.cue` 放；原版命运板 fcn.0044c4a0 只有语音（fcn.0044e2e3 → fcn.00452b5d）。
- 测试：`ui/classic/popups/eventCards.dom.test.tsx`（接住层的位置、吞掉的事件、跳过、快捷键；加持框 / 亮卡没有接住层；新闻板
  最短时间前后）、`ui/classic/popups/boardShield.browser.test.ts`（真实 Chromium 命中测试：点 (260,20) 落在接住层、工具列收不到、
  按 M 不触发快捷键；对照组没有接住层时落到工具列钮上）、`presentation/handlers/eventCards.test.ts`（FATE_AFTER_BOARD 表、各类节拍与
  时间线、加持时效果在消息框之后、LOT_MUTATED 的镜头、原版命运板没有 cue）、`audio/director.test.ts`（FATE 开始时不放音效）、
  E2E `skin-classic-event-cards.spec.ts`（命运板期间另一名玩家点「托管」的位置、观战者点「查询」的位置：只结束各自的命运板，托管不变、
  不开资产表）。本机真实素材包实测 `test/evcard-fix.mjs`：重画类（命运 14）板子 2.95 秒（语音 2957 ms）、关板后 0.1 秒罚金的金币声；
  留板类（命运 3）4.51 秒；征收（命运 1）关板后镜头移到地块并停约 0.7 秒；新闻板最短时间前点板子不跳过、之后点板子即结束；
  音频日志里命运开头只有 voice.0199，没有 zzfx.card。产物 `.cache/evcard/fix/`（taiwan-desktop、japan-mobile）。
- 验证（2026-10-03）：`npm run check` 全绿（vitest 331 个文件 3359 例）；E2E 原版配置（skin-classic-event-cards、skin-classic-dialogs、
  skin-classic-cards、hand-privacy、events、cards、skin-original-stage、skin-classic-shell）16 例全过、默认配置（同上去掉
  skin-original-stage，加 skin-original-board）15 例全过；把接住层临时去掉时 skin-classic-event-cards 失败（另一名玩家点板子把托管切成
  开），确认这条 E2E 能抓住回归。浏览器测试（client-browser）本机的 Playwright Chromium 版本对不上，`npm test` 不跑，用
  `RICH4_CHROMIUM_PATH=<本机 Chromium>` 单独跑 `src/ui` 4 个文件 13 例全过。

## 31. AI 后瞻（lookbehind）与放置类道具选格按原版（2026-10-03）

用户要求修 §29.9 复核时发现的「AI `lookbehind` 一般情形与原版差一格」。只改电脑策略（`packages/shared/src/ai`），引擎规则、state 结构、
mapHash 都不变；ENGINE_VERSION 仍是 0.5.0（尚未上线，`engine/version.ts` 的 0.5.0 说明补了一句），四张图 golden 再刷新一次。

### 31.1 取证（radare2；AI 以 v3.11 为基线，v2.06 核对）

- **前瞻 / 后瞻是同一段循环**：v3.11 前瞻 0x40b221 与后瞻 0x40b343 只有开头两条读取互换——前瞻起点 = 节点 0x496b74、排除 = 来路 0x496b76；
  后瞻起点 = 来路（0x40b376）、排除 = 节点（0x40b381）。n > 8 截成 8（0x40b360，输出缓冲 0x48b8b4 是 8 个 u16，先清零）。每一步
  （0x40b397–0x40b450）取节点记录 +0x18 的 4 个邻接槽，跳过 0、跳过排除格、跳过静态封路（+0x24 & (0x40000000 >> 槽)）：0 个候选 → 输出排除格；
  1 个 → 直接取，不调 rand；≥2 个 → `rand() % n`（0x456f2d）并置「遇到过岔路」；然后排除格 = 当前、当前 = 输出。所以后瞻的 out[0] 是来路格的
  下一格（往回第 2 格），来路格本身不在输出里；来路格是死路时 out[0] 回落为当前格。
- **获释特例**：被关时来路写 0（v3.11 0x43d630 / 0x43ecdc；v2.06 0x43c35b / 0x43d9e8），获释不改。起点 0 是全 0 哨兵节点（没有邻接），
  0 个候选 → out[0] = 关押格；之后排除 0，即全部未封邻格。我们来路 = 节点 = 关押格，结果同为 [关押格, 未封邻格…]（§29.9 已核，这次保持）。
- **三个调用方**（v3.11 路障阶段二 0x4212ad、地雷 0x4213e0、定时炸弹 0x42158f）都是 lookbehind(6)，不看返回的岔路标记，接着调 0x409ef9 取候选表
  （0x48b8c4）：视野内、+0x24 & 0xffff00 为 0 的节点按投影后的像素位置写进 440×440 缓冲（下标 sy × 440 + sx，0x40a028–0x40a046），再逐行、
  行内从左到右扫出（0x40a05c–0x40a09e）。随后**遍历候选**、候选等于 out[0..5] 之一才往下看——路障：我的住宅，路段过路费（0x419744）> 6000 × PI
  且严格大于当前最高；地雷：先看是不是监狱 / 医院关押格且有人在押（0x421446 / 0x421469 比 0x48bae0 / 0x48bae2，命中直接选），再把对手的
  住宅 / 设施格放进池；炸弹：命中的都放进池；池非空取 `rand() % n`。
- **v2.06 没有后瞻**：同三处（0x420a1e / 0x420b6c / 0x420d19）调用的是前瞻 0x40ae1d(6)，候选表 0x409b04（同一算法，写 0x488650），比对是排除语义——
  路障阶段二要求前方 6 格里没有同一块地的格，地雷是对手的地且不在前方 6 格里（没有监狱 / 医院优先），炸弹在视野内除前方 6 格外随机取。
  项目的 AI 以 v3.11 为基线（research/g_arbitration「实现时以 v3.11 为基线」，design/minigames-ai.md 的地址也都是 v3.11），照 v3.11 改；
  版本差异记入 docs/TODO.md，要不要改由用户决定。

### 31.2 实现

- `ai/view.ts`：前瞻 / 后瞻共用 `walk(at, excl, n, rng)`（最多 8 格，at = 0 视为哨兵、0 个候选）；`origPrev()` 把我们在关押 / 获释时写的
  「来路 = 节点」换回原版的 0。`lookbehind = walk(origPrev, node)`、`lookahead = walk(node, origPrev)`。前瞻行为不变：
  `test/lookbehind-equivalence.ts` 在四张原版图与 fixture 图的全部 (节点, 来路) 组合 × 25 个种子上比对，新 lookahead 与旧实现逐项相同；
  新 lookbehind(6) 一般情形 = 旧 lookbehind(7) 去掉第一格，来路 = 节点时与旧实现相同，随机数的消耗也相同。
- `AiView.tilesInView(tiles)`：只留视野内的格，按视角 0 的线性投影排序——sy = 25·y − 11·x、sx = 34·x + 14·y（亚格矩阵 v3.11 0x474910 视角 0
  = [−34, 11, −14, −25]，v2.06 0x4727bc 相同，与逐格表 0x46ccf0 每格的增量一致，只差表里的舍入），同一位置按 id。视野仍是世界坐标方窗（DEV-04）。
  视角 0 里世界坐标的同一行是右高左低，同一条横街上 x 大的格先扫到。`lotsInView` 仍按世界坐标先 y 后 x（没改，横街上与原版行序相反，
  留给 V-E10 / A11 换投影版时一起改）。
- `ai/items.ts behindCands`：lookbehind(6) 后按 `tilesInView(回合菜单的合法格)` 的顺序留下在后瞻里的格；路障阶段二、地雷、定时炸弹都改用它。
  带来的变化：同额路障取行序靠前的格（原来取后瞻里更近的格）；池里同一格只算一次（原来后瞻原路返回时同一格会重复计权）；
  监狱 / 医院优先按候选顺序。随机数派生（`turnRng('item:2b' / 'item:3' / 'item:4' / 'item:<n>:pick')`）与取数时机不变。
- 文档：`DEVIATIONS.md` DEV-04 补「AI 按屏幕行序遍历候选」一句；`design/minigames-ai.md` §8.2 的 lookahead / lookbehind 与 §9.6 道具表 2、3 同步。

### 31.3 测试

- `ai/view.test.ts`（新）：一般情形 5 号格来路 4 → [3, 2, 1, 18, 17, 16]（4 → 19 静态封路不算候选、不取随机数；n = 10 截成 8 格）；
  岔路 14 号格来路 13 → 候选 [20, 12]，脚本 rng 断言取数次数与 n（[2] / [2, 2]）；获释（来路 = 节点 = 14）→ [14, 15, …] / [14, 13, …]，
  第二格起才取随机数；0 个候选（test-allkinds 死路 26）→ 第一格回落为当前格 [25, 24, 23, 22, 21, 8]，外推途中原路返回 [24, 25, 26, 25, 24, 23]；
  lookahead 获释时在全部邻格里随机、没落地时都为空；`tilesInView` 的视角 0 行序。
- `ai/items.test.ts`：路障阶段二——来路格上我的高租金地不放（来路格不在后瞻里）；逆着走时 L2（6）/ L3（7）同街同额取行序靠前的 7，不是后瞻里更近的 6；
  地雷——来路格上对手的地不放。
- 变异：把旧 lookbehind 临时换回，view / items 共 5 例失败（获释那一例照样通过——它本来就与原版一致）；只把遍历顺序换回后瞻输出顺序，路障同额 1 例失败；
  排序换成世界坐标先 y 后 x，2 例失败。都已恢复。

### 31.4 golden（四张图刷新）

`RICH4_UPDATE_GOLDEN=1 RICH4_GOLDEN_MAPS=taiwan,china,japan,usa RICH4_DATA_DIR=./rich4-data npx vitest run --project shared src/engine/golden`，
再不带 UPDATE 跑两遍均通过、四个快照 sha256 不变；mapHash 不变，16 局 AI intent 被拒 0 次。每局在第 0 个 400 事件检查点内就分歧（开局第 0 天
就有人放炸弹）。各局 事件数 / 路障 / 地雷 / 炸弹 放置次数（旧 → 新；`test/lookbehind-golden-places.ts` 按 golden 的同一组对局重放，终局哈希与快照一致，
`test/lookbehind-golden-diff.ts` 比较）：

| 图 | 一个月 | 三个月 | 半年 | 一年 |
|---|---|---|---|---|
| 台湾 | 833→800 / 1→0 / 3→2 / 2→2 | 2457→2671 / 3→2 / 3→3 / 4→5 | 5199→5167 / 6→5 / 7→4 / 10→5 | 9744→9053 / 11→9 / 7→7 / 8→8（365 天 timeLimit → 357 天 lastStanding） |
| 大陆 | 832→833 / 1→1 / 3→3 / 3→4 | 2472→2457 / 2→3 / 3→4 / 4→6 | 5086→4985 / 7→2 / 5→4 / 5→5 | 10106→9580 / 4→9 / 9→8 / 10→8 |
| 日本 | 871→858 / 2→2 / 3→3 / 3→4 | 2610→2538 / 2→2 / 4→5 / 4→7 | 5166→5030 / 8→5 / 6→8 / 6→8 | 9486→7846 / 13→9 / 10→8 / 11→11（365 天 timeLimit → 294 天 lastStanding） |
| 美国 | 835→840 / 2→2 / 3→3 / 3→3 | 2556→2440 / 1→1 / 4→4 / 4→4 | 5026→5011 / 5→4 / 6→6 / 7→5 | 8529→8803 / 9→9 / 5→7 / 8→10（334 天 lastStanding → 365 天 timeLimit） |

位置：改前后瞻类放置（地雷、炸弹、路障阶段二）落在「往回第 1 格 = 来路格」的四张图共 17 / 11 / 15 / 13 次，改后 0 次，全部落在往回第 2–7 格
（美国一年局出现往回第 7 格）。按「同局、同天、同座、同种」对得上的放置里，四张图分别有 10 / 15 / 12 / 19 次落格不同
（例：日本一个月局第 0 天 2 号的炸弹 60（往回第 1 格）→ 57（往回第 4 格），美国同局 2 号 58（往回第 1 格）→ 60（往回第 3 格），
大陆同局 3 号 88（往回第 2 格）→ 92（往回第 6 格）），其余随对局走向不同而无从对照。路障阶段一（前方 4 格）不受影响，
次数变化来自对局走向不同。

### 31.5 自对弈

`npm run sim -- --engine-only --map <图> --data-dir rich4-data --games 500 --policy original --workers 8 --stats` 与
`--games 200 --policy random --check-fold --workers 8`，四张图各跑两遍（`test/lookbehind-sim.sh`，输出在 `.cache/lookbehind/sim/`）：
全部 finished = 局数、rejects / invariantErrors / errors 都是 0，两遍 finalHash 与 journalHash 都相同。

| 图 | original 500 局 finalHash（平均天数；OBJECT_PLACED / ROADBLOCK_HIT / BOMB_ATTACHED） | random 200 局 finalHash（--check-fold） |
|---|---|---|
| 台湾 | `0aec5587ae6ff8d4`（381.7 天；14332 / 4667 / 3837） | `a980c4513d7e62e0` |
| 大陆 | `3c3f4621cc90de45`（517.8 天，42 局 timeLimit；18580 / 6132 / 4986） | `9646d6170b534826` |
| 日本 | `686b17518710dccb`（306.8 天；13673 / 4402 / 3645） | `26dcd8bad624f431` |
| 美国 | `c37d5bbeb275d4f5`（383.1 天；15674 / 5036 / 4271） | `2ba641cec6a3760c` |

（random 策略不经过电脑道具判据，只证明引擎侧没有被带坏；跑自对弈期间 `ai/view.ts`、`ai/items.ts` 与开始时逐字节相同。）

### 31.6 验证

- `npm run typecheck`、`npm run lint`（1295 个文件）EXIT 0；`npm run check:determinism` OK（193 个文件）；`npm run check:no-original` OK。
- `npx vitest run --project shared`：88 个文件通过 1 跳过，869 例通过 20 跳过；`RICH4_DATA_DIR=./rich4-data` 时 89 个文件 889 例全过
  （含四张图 golden）。自对弈同时跑时曾有 2 例（items 5 / 6、12）因机器负载超时，负载降下来后重跑通过。
- `npx vitest run --project server --project server-real`：69 个文件 411 例全过。
- `test/lookbehind-equivalence.ts`：全部一致。没有跑 E2E（AI 改动不涉及客户端；E2E 由主会话统一跑）。

### 31.7 遗留

- v2.06 / v3.11 的后瞻差异（31.1 末条），要不要改由用户决定（docs/TODO.md）。
- 地雷 / 定时炸弹的监狱 / 医院优先：原版比关押格，我们比 kind 为 jail / hospital 的格（保释格 / 出院格）；我们的引擎不许在关押格放物件，
  照原版改这条分支就永远不命中，和 V-M7 ③ 一起定（docs/TODO.md）。
- 原版候选表不看占用（0x409ef9 只按 +0x24 & 0xffff00 过滤），我们用回合菜单的合法格（空道路格 ∩ 范围），原版选中被占格时的结果没核；
  `lotsInView` 的行序见 31.2。

## 32. 用户反馈修复：关押期间不画棋子、获释时从建筑里走出来（2026-10-03）

用户要求按原版修：被关期间不画棋子，获释时从建筑里走一步出来（§29.4 当时保留现状、登记 DEV-29）。本节只改表现层与演出预算：
**引擎规则、golden、ENGINE_VERSION 不变**；素材包没有新登记的键，`rich4-assets/` 没有重建。

### 32.1 取证（v2.06 radare2 复核；玩家记录基址 0x493910、步长 0x68，与 §29.9 同一记法）

- 绘制循环 0x4082a5–0x4082c3：坐标 +0x08 为 0 不画；主阻碍计数 +0x32 按 dword 比较（住旅馆 +0x32、消失 +0x33、坐牢 +0x34、
  住院 +0x35 四个字节）不为 0、且 +0x15 没有 bit5 就跳过。附身物件循环 0x408be6 只看这个 dword，不为 0 一律不画（附身神明、身上炸弹）。
- 被关：监狱 0x43c34c–0x43c37d（节点写关押格、来路 0、+0x1b = 0xf、坐标写景观表 [0x495c20] + 0x38 即景观 2），医院 0x43d9d9–0x43da0a
  （+0x1c 即景观 1）。已经关着时（0x43c307 / 0x43d994 计数不为 0）只加天数、镜头移到人所在处（fcn.0041cc56），不再播警车 / 救护车。
- 住旅馆 fcn.0040d06b（0x41a0be）：站在门前且是当前玩家时置 bit5、朝向 = 节点 → 旅馆，当回合走进去；否则坐标直接写成旅馆坐标
  （设施表 [0x495c3c] + 56·idx）。
- 回合开始 fcn.0041c058 按计数 0x80 获释：住旅馆 0x41c09e → fcn.0040d184；消失 0x41c0ce → fcn.0040cfab（直接清计数、放回节点，
  播 Data#492 / #517 的 UFO / 飞机动画，不走出来）；坐牢 0x41c105 → fcn.0043c4ea、住院 0x41c139 → fcn.0043db7a，都调 fcn.0040d184。
  保释对话框也调 fcn.0043c4ea（0x43bf94）。恶人（座位 ≥ 4）在 0x43c50b 之后直接放在关押格（0x43c525–0x43c572），不走出来。
- fcn.0040d184：+0x15 |= 0x10，朝向 = fcn.00453614(节点坐标 − 当前坐标)，不改节点与来路。fcn.0040d7e5：bit4 / bit5 时只走 1 步（0x40d7fd–0x40d806）。
- fcn.0040bb40：bit4 分支起点 = 当前坐标、终点 = 节点坐标（0x40bba3–0x40bbcc）；bit5 起点 = 节点、终点 = 设施坐标（0x40bbd1–0x40bc0b）；
  有 bit4 / bit5 时每 tick 走距离 × 0.125 分之一（0x40bd5a，即 8 px / tick；平常按速度表 0x472884 [8,12,16,8]），tick 数 = 距离 / 8 经
  fcn.0045641c 截断取整（0 记 1，0x40be03）；每 tick 先减剩余再走，剩余 < tick 数 >> 1 时 bit4 清计数 dword（0x40beb1，从此画出来）、
  bit5 清 bit5（0x40bebb，从此不画）；剩余 ≤ 0 落到终点；bit4 / bit5 时不按来路改朝向（0x40befb）。走到关押格不触发落点事件（§29.1）。
- tick = 20 ms × 分频表 0x46a9d0 [6,4,2][速度]（与掷骰同一个 tick，original 节奏 80 ms、compact 40 ms）。
- 四张图的走出距离（景观 → 关押格，世界像素）：台湾监狱 110 / 医院 93、大陆 91 / 96、日本 66 / 91、美国 130 / 86，即 8–16 tick；
  旅馆到门前格 74–80 px（9–10 tick）。

### 32.2 实现

- 状态（`game/actors/ActorStatus.ts`）：ActorStatus 加 `hotel`；`insideOf` / `hotelAt` 给出人在哪栋建筑里——坐牢 / 住院在景观里，
  住旅馆在门前格（`TileDef.ref.lot`）所属的旅馆里；找不到旅馆（死神替人付费、旅馆被拆）时为 `here`（停在原格、同样不画）。
- 原版皮肤：`OrigActor.setInside(world)` 把画点放到景观 / 旅馆上（镜头跟随、气泡锚点都在这里），本体、名牌、附身神明、炸弹与引信都不画，
  节点不变；`walkOut(to, {tickMs, onShow})` 按原版 tick 匀速走、朝向 = 景观 → 格、前 `walkOutSwitchTick` 个 tick 不画、过半出现并调 onShow，
  走到停在格上；`walkIn(world)` 反过来。棋盘上不再选原版关押姿态库（char.<c>.hospital / jail）。`OrigStage.syncWorld` 按状态 setInside
  （景观坐标取 `OrigBoardView.landmarkWorld`，旅馆取 `lotWorld`）；同格错开（`OrigRenderer.spreadActors`）跳过看不见的人（出国、乞丐同样跳过）；
  快照之后获释还没走的人（来路 = 关押格本身）朝向按景观 → 关押格（`OrigBoardController.facingFrom`）。
- 程序化皮肤：删掉关押窗口气泡；`PlayerActor.setInside(cell)` 整个棋子（人物、载具、头顶挂件、影子、名牌）不画，画点放在建筑中心；
  `walkOut` 从建筑中心跳 1–3 下到格上（每下 STEP_MS，`fx/timings` 的 `WALK_OUT_HOPS_MAX`），过半出现、冒一小把星光；`walkIn` 反过来。
- StagePort（`presentation/handlers/stage.ts`）新增 `walkOut` / `walkIn` / `holdInside`，两种舞台与测试舞台都实现。
- handler：
  - CONFINED：已经关着（加刑）时不再派警车 / 救护车，只移镜头、冒气泡；
  - TURN_STARTED：本回合获释（坐牢 / 住院 / 住旅馆计数为 0x80）时 `holdInside(seat)`——引擎在 TURN_STARTED 之前推进计数，清零写在
    TURN_STARTED 的 post 里，留置让人在 RELEASED 走出之前一直留在建筑里；`walkOut` 开始、批尾整体同步（`syncView`）、reset / 跳过（`clear`）时解除；
  - RELEASED：坐牢 / 住院 / 住旅馆调 `walkOut`，出现那一刻才把舞台同步到获释后的显示态；出国 / 航空回来仍是开门闪光，加跳一下（从 RETURNED 挪来）；
  - RETURNED：只确认停在格上、停 0.2 秒（原版走出这一步后回合就结束）；
  - HOTEL_STAY：站在门前时 `walkIn`，否则直接不见。
- pacing（`shared/view/pacing.ts`）：`WALK_OUT`（8 px / tick；监狱 / 医院最多 16 tick、旅馆 10 tick）、`walkOutTicks` / `walkOutSwitchTick` /
  `walkOutMs`；RELEASED 的 original 预算 = max(1 秒, 走出 + 0.1 秒收尾 + 余量)，坐牢 / 住院 1480 ms，住旅馆、消失与恶人 1 秒；compact 仍是常数
  1 秒（最远 16 × 40 ms 加收尾也放得下）；RETURNED 800 → 400 ms。服务器截止时间按同一张表；新闻 / 命运条目没有动。

### 32.3 测试

- `shared/view/pacing.test.ts`：tick 数（截断、至少 1、上限）、换显隐的 tick、两种节奏的 RELEASED / RETURNED 预算；穷举测试把 RELEASED 列为 original 放宽的事件。
- `game/actors/ActorStatus.test.ts`（新）：insideOf / hotelAt / statusOf 的 hotel。
- `game/actors/PlayerActor.test.ts`：在建筑里整个棋子不画、没有窗口气泡；walkOut 前半程不画、过半出现（onShow 一次）；中止直接落到格上；walkIn。
- `presentation/handlers/m6m7.test.ts`：CONFINED（警车之后才同步成关押；加刑不派警车）、RELEASED（出现那一刻才换掉关押状态、没有开门闪光、
  不重新摆放）、出国回来与保释、RETURNED、TURN_STARTED 的留置、HOTEL_STAY 门前才走进去。
- `presentation/handlers/release.test.ts`：真实引擎（坐牢 26、环路医院 20）下被关之后到获释之前舞台看到的都是关押状态，RELEASED 先 walkOut
  再同步成获释，观战者同一套调用；新增「真实引擎 × 真 OrigStage」：经事件前后同步（同 wrap），被关之后一直在景观里——包括获释那一回合
  TURN_STARTED 已清计数之后——RELEASED 走出来一次，之后在格上（去掉 TURN_STARTED 的留置时这一例失败）。
- `presentation/handlers/budget.test.ts`：RELEASED 四种来源都在预算内；原版舞台按原版 tick 走完 16 tick（过半在第 9 个 tick）不超预算。
- 浏览器（client-browser）：`game/orig/jailWalkOut.browser.test.ts`（由 `confinedSpread.browser.test.ts` 改写）——住院 / 坐牢 / 住旅馆时本体、名牌、
  附身神明、炸弹、引信都不画、画点在景观 / 旅馆上、路过同格的人不错开；走出的时长、出现时刻、朝向与终点；中止后直接在关押格；重新进房后的朝向。
  `game/fx/fx.browser.test.ts`：程序化关押期间整个棋子不画、没有窗口气泡；walkOut 前半程不画、过半出现、停在格上。

### 32.4 验证

- `npm run typecheck`、`npm run lint`（1295 个文件）通过。
- `vitest --project client-unit` 70 个文件 683 例、`client-dom` 46 个文件 804 例、`server` 51 个文件 327 例、`server-real` 18 个文件 84 例、
  `shared` 的 `src/view` 4 个文件 60 例通过。
- client-browser（本机没有 Playwright 1243 的浏览器，`RICH4_CHROMIUM_PATH` 指向已装的 Chrome for Testing 1228）：14 个文件 71 例通过、1 例跳过，
  `audioEngine.browser.test.ts` 在整组运行时偶发失败、单独重跑通过（同 §29.6，与本改动无关）。
- 真实素材包（packId `daa850ef3a455b4a`，本机端口 4321 / 6321，`test/jail-walkout-shots.mjs`，原版皮肤 1920×1080、original 节奏）：
  台湾坐牢（关押格 1，13 tick，走出 1023 ms）、台湾住院（23，11 tick，873 ms）、大陆医院 63（环路，12 tick，958 ms）各一组：关押期间关押格与景观上都没有人
  → 走出前半程看不见 → 过半出现、走在景观与关押格之间（台湾监狱 1 是快艇节点，出来就在快艇上）→ 停在关押格；控制台 0 错误。另用 `--skin=procedural`
  看了一组台湾坐牢的程序化实现。截图与逐帧数据在本机 `.cache/jailview/`（含原版素材，不入库）。E2E 由主会话统一跑。

### 32.5 遗留

- 出国 / 航空回来：原版 fcn.0040cfab 播 UFO / 飞机动画（Data#492 / #517，flic-map 置信度 guess），我们仍是开门闪光加跳一下（docs/TODO.md）。
- 住旅馆只在门前时走进去；死神替人付旅馆费时原版把付费人的坐标写成旅馆、节点改成当前玩家的节点（fcn.0040d06b 0x40d116–0x40d147），
  我们不搬节点（引擎规则未动），付费人在原格不画。
- 走出这一步放在 RELEASED 事件里（原版是获释回合的移动，0x40d7e5），网页版的名牌、聊天气泡、「自由啦！」气泡是自有的；镜头在 TURN_STARTED 对准建筑。

## 33. 用户反馈修复：命运 / 新闻改成原版原文、新闻板照原版版式（2026-10-03）

用户要求两件事：命运正文改成原版的一两行 28px 短句；新闻板照原版版式（分类名、标题、没有打字机、逐人名单与小头像、停到语音播完
且至少 2.4 秒、任意时候放开即结束）。（编号说明：任务原定写成 §31，但 §31 已被同日的 AI 后瞻修复占用（docs/TODO.md、§29.7 引用），
§32 是关押期间不画棋子，这里顺延为 §33。）本节只改表现层、i18n 与演出预算：**引擎规则、golden、ENGINE_VERSION 不变**；新增的
`selectors.newsRowAmount` 是只读选择器，没有动 `effects/news`；素材包没有新登记的键，`rich4-assets/` 没有重建。

### 33.1 原文（exe v2.06 radare2）

- 来源：命运处理函数表 0x473d14（49 项）、新闻处理函数表 0x473c48（36 项）里各处理函数参数 0 分支 `push` 的格式串，开头 `#NNNN` 是
  当场播的语音号（fcn.0044e2e3 0x44e32a–0x44e375）：命运 0x463979–0x463e07（#0185–#0233，slot 0–48，33–36 的按图变体是 slot 37–48
  0x463cfb–0x463e07）、新闻 0x46347c–0x4638cc（#0149–#0184）；新闻分类 = 字节表 0x473cd8[id] → 指针表 0x473cfc（6 个名字
  0x463444–0x463473，无責任新聞 / 政府公告 / 社會新聞 / 路況報導 / 氣象報導 / 財經新聞）；逐人行 0x4635ea「%s繳交%d元」（新闻 11–13）、
  0x46377f「%s得到%d元」（新闻 23）。`test/fatenews-orig-text.ts` 从 exe 逐项列出地址、语音号与原文（`--check-locales` 与入库的 zh-TW
  逐条比对：93 条，0 条不一致）。例：fate:14 = 0x463af8（#0199），fate:33.byMap.2 = 0x463d5f（#0226），news:30 = 0x463833（#0179）。
- i18n（`locales/zh-CN/{fate,news}.json`）：zh-TW 就是 Big5 解码后的原文，`%d` / `%s` 按原位换成 `{{amount}}` `{{days}}` `{{pct}}` `{{who}}`
  `{{lot}}` `{{company}}` `{{stock}}`；zh-CN 用 opencc tw → cn 生成（与 tools/extract 地图文案同一种做法），再由 `npm run i18n:zh-tw`
  （cn → twp）转回繁体，往返与原文逐字相同；opencc 处理不好的两条（「電線桿」「污水」）进 `zhTw.ts` 的键覆盖表。原文里写死的数照抄
  （例如新闻 27「暫停交易１０天」实际停 15 天、全角数字、命运 34「防礙風化」的错字）。
- 插值：数字照 sprintf `%d` 写成不带千分位的整数（`eventText.origInt`）；命运的金额、天数是加持之前的（原版先写字、参数 1 才判加持再
  加倍；罚金 / 冒贷 low、奖金 high 的事件金额已 ×2，`fateBaseAmount` 还原）；新闻的 `%s` 是地产 / 企业记录里的名字（`NameKit.lotName`，
  不加我们给同名地块编的序号，例：「墾丁房屋鬧鬼」而不是「墾丁 3」）。
- 我们的命运短标题（`fate:<id>.title`）只留给程序化翻面卡、日志与读屏，33–36 的标题按原文主题改了几条；新闻的自拟内文（`body`）删掉，
  日志改为「新闻「<标题>」」（原文的换行在日志里换成空格，`eventText.oneLine`）。shared 的新闻 / 命运数据表没有动。

### 33.2 命运板（`ui/classic/popups/FateBoard.tsx`）

- 原文整句从 (24,330) 起左上对齐写成 28px 粗体 #F0F0F0、#101010 的 (1,1) 阴影、字距 −1（`./boardText`：fcn.0044e200(28, …, 3, 0)），
  `white-space: pre` 不自动换行，两行的行距 = 字高（DrawText 的 tmHeight，細明體按 −h 建字没有 internal leading，⚑ 推定）。
  句中金额包在 `fate-amount` 里（同色，只为测试与读屏定位）；短标题是视觉隐藏的 `fate-title`；原先标题下方另起的 20 / 16px 正文与金额行
  （`FATE_BOARD.body`、`fateBodySize`）删掉。插图、表情头像、加持消息框、跳过、预取都不变（§30）。

### 33.3 新闻板（`ui/classic/popups/NewsBoard.tsx`、`layout.ts`）

- 分类名 (24,8)、原文标题 (24,310)，都是 28px（同命运板的字）；整块画好才拷上屏幕，没有打字机（读屏与画面是同一个 `news-headline`）。
- 受影响玩家按各新闻处理函数参数 0 分支（`layout.ts` 的 `NEWS_BOARD_LISTS`）：11–13 税、23 储金红利逐行 24px 写在 (24, 346 + 32·i)
  （0x4487b8 mov edi,0x15a … add edi,0x20），讲话头像按锚点画在 (390, 358 + 32·i)，税用图3、红利用图4；0–3 获释 / 延长只画头像，从 (390,328)
  起每人 +42（0x447aaa mov esi,0x148 … add esi,0x2a，获释图4、延长图3）；16 / 17 豪雨 / 塞车只画头像 (390, 358 + 32·i) 图2；8–10 得奖的一人
  (390,328) 图4；其余新闻不画人。
- 逐人行的金额：引擎先发 NEWS 再逐人收税 / 发红利（NEWS 的 post 里还没有这些变化），所以按公布时的显示态算：`engine/selectors`
  新增 `newsRowAmount(w, map, id, seat)`，与 `effects/news` 的 TAX_BASES、bonusInterest 同一公式；`realEngineM7.test` 对 11、12、13、23
  逐条核对与引擎随后实际收付（MONEY）的金额相同。handler 把行文（`news:<id>.row`）放进 `AffectedRow.line`。
- 跳过：新闻板也照原版从一开始任意鼠标左 / 右键或按键放开即结束（`ClassicPopupHost` 的 `anyInputSkips` 加上 news），不再画网页版的跳过钮、
  没有 1.5 秒最短时间；跳过时停掉语音（DEV-35、DEV-33）。板面接住指针、暂停快捷键照旧（§30.6）。
- 声音：原版新闻板只有语音、没有音效。soundMap 的 NEWS 音效改为 `NEWS_STING_SFX`（ZzFX news，timed：事件开始时不放），只在程序化新闻弹窗时
  由 handler 放。

### 33.4 节拍（`shared/view/pacing.ts`，服务器截止时间同表）

- `NEWS_VOICE_MS[36]`：Speaking#0149–0184 的时长（素材包 durationMs，1346–3935 ms），同 `FATE_VOICE_MS` 的做法。
- `newsShowMs(id, profile)`：original = 板子 max(2.4 秒, 语音) + 收尾 0.2 秒（fcn.00452c39(2400) 0x44a308–0x44a30d，之后参数 1 执行效果，
  没有命运板那 0.8 秒）；compact 仍是 3.4 秒 + 0.2 秒。NEWS 的 original 预算 = max(compact 3800, 停留 + 收尾 + 余量 0.1 秒)，只有语音 3.935 秒的
  新闻 29 放宽到 4235；compact 不变。程序化皮肤在 original 节奏下同样按这个停留（最短 1.5 秒后可点跳过）。多数新闻在 original 节奏下比以前
  短 1 秒（2.4 秒，原先一律 3.4 秒）。

### 33.5 程序化皮肤

- `NewsPopup`：标题用原文（打字机保留，`white-space: pre-line` 显示两行），没有内文；税 / 储金红利的受影响玩家写原版的逐人行。
- `FatePopup`：正文用原文（`pre-line`），标题与金额行（实际收付）、加持结果照旧。

### 33.6 验证（2026-10-03）

- `npm run typecheck`、`npm run lint` 通过；`npx vitest run --project client-unit --project client-dom` 116 个文件 1487 例全过（中途一次整跑时
  `ui/decisions/realEngineCombat.dom.test.tsx` 一例因机器负载（两套 E2E 在后台跑）超时，单独重跑 47 例全过，与本次改动无关）；
  `npx vitest run --project shared packages/shared/src/view …news.test.ts …fate.test.ts` 6 个文件 97 例全过；`--project scripts` 5 个文件 100 例全过；
  `npm run check:zh-tw`、`npm run check:deps` 通过；`npx tsx test/fatenews-orig-text.ts --check-locales` 93 条 0 不一致。E2E 没有在本任务里跑（由主会话统一跑）。
- 新增 / 改写的测试：`ui/classic/popups/eventCards.dom.test.tsx`（命运板原文的位置、字号、行距、字距、两行与句中金额；新闻板分类名 / 标题画点、
  没有打字机、税行与头像的坐标与图号、只画头像的四类、任意放开即结束且板面照样接住）、`ui/classic/popups/popups.dom.test.tsx`、
  `ui/popups/popups.dom.test.tsx`、`presentation/handlers/eventCards.test.ts`（命运原文与加持前的数、新闻板节拍、跳过停语音、提示音只在程序化
  弹窗）、`presentation/eventText.test.ts`、`handlers/i18nKeys.test.ts`、`handlers/realEngineM7.test.ts`（逐人行金额对引擎）、`shared/view/pacing.test.ts`。
- 本机真实素材包（packId daa850ef3a455b4a，未重建；服务器 4311 + 构建后的客户端 6311，脚本 `test/fatenews-shots.mjs`，两名真人，1920×1080）：
  台湾 24 项、大陆 / 日本 / 美国各 4 项检查全过——命运 25「意外獲得遺產10000元」、17 两行「請所有人吃大餐 / 花費6000元」、33「酒醉大鬧警局坐牢3天」，
  大陆 34 / 36 → slot 38 / 40「違法聚眾示威坐牢5天」「盜賣國寶坐牢9天」，日本 33 / 35 → slot 41 / 43，美国 36 / 34 → slot 48 / 46；新闻 11 两行
  「<人>繳交<n>元」在 y=346 / 378 + 头像图3，23 两行「得到」+ 图4，0（在押的人获释）头像在 (390,328)，8（买地之后）得奖一人，16 两个步行者头像图2，
  14 两行标题带地块原名；新闻板停留实测 2398–2414 ms（语音 < 2.4 秒的）与 2828–2843 ms（新闻 16，语音 2831），另一名玩家点一下板子 5–7 ms 内结束；
  原版新闻板开头没有 ZzFX news。截图 `.cache/fatenews/{taiwan,china,japan,usa}-desktop/`（整页与 640×480 舞台裁切各一张）。

### 33.7 遗留

- 两行原文的行距按 tmHeight = 字高推定，没有和原版实机截图逐像素对过（VERIFY V-U13）。
- 原版储金红利（新闻 23）给每个没有贷款的在场玩家都列一行（存款为 0 时「得到0元」），引擎的 affected 只含红利 > 0 的人（不改引擎）。
- 手机横屏（844×390）这次没有截图（脚本支持 `mobile` 参数，本机那一轮卡在开房间，未查原因）。
- `test/evcard-fix.mjs` 第 3 个场景（新闻板最短时间前点板子不跳过）是 §30.6 的旧行为，脚本没有改。

## 34. 座驾按原版：梦游卡停放与装回、工程车被机车 / 汽车顶掉、只换外观的切换（2026-10-03）

用户要求：docs/TODO.md「收起载具相关的原版差异」四条全部按原版做；取证时新发现的载具差异也一并按原版改（卖光时工程车折成 12 号道具、
工程车到期恢复原骰子数、用道具换车不再另加提示与闪光，见 34.1–34.3）。引擎规则变了（梦游卡停放座驾、工程车模式下能用机车 / 汽车），
**ENGINE_VERSION 0.5.0 → 0.6.0**，四张图 golden 刷新；`PlayerState` 新增字段 `parked`，`STATE_SCHEMA_VERSION` 仍为 1（旧快照由
migrateState 补缺省值）。本节之后以代码和本节为准；与 §28.1「未做」、design/engine.md 旧版「梦游时交通工具退回背包」
「正开着工程车时机车 / 汽车不可用」的说法冲突时以本节为准。

### 34.1 取证（radare2；v2.06 为主基线，v3.11 逐处核对相同；记法同 §29.9 / §32.1）

玩家记录基址 v2.06 0x493910 / v3.11 0x496b68，步长 0x68：+0x11 座驾模式（0 步行、1 机车、2 汽车，工程车 = 天数 << 2 | 3，用道具时写 0x1f
即 7 天）、+0x12 骰子数、+0x37 梦游计数、+0x64 / +0x65 工程车到期要换回的座驾与骰子数、+0x66 / +0x67 **梦游前的座驾与骰子数**；
背包 v2.06 0x495f07 + 道具号（每座位 0x14 字节，机车 0x495f0c、汽车 0x495f0d、工程车道具 0x495f13；v3.11 0x49915b + 道具号）。
反汇编脚本 `test/vehstow-r2.sh`、`test/vehstow-orig-dump.sh`（输出 `.cache/vehstow/`，不入库）。

- **梦游卡**（卡片函数表 0x473b84 第 16 项 0x442e15）：免罪 / 嫁祸之后 0x442f97–0x44301f：梦游计数写 4 / 5，+0x42（本月倒楣天数）+5，
  **+0x66 / +0x67 = 模式 / 骰子数**（独立字段，不是背包）；模式不为 0 时：1 → 背包机车 +1、2 → 背包汽车 +1（`inc byte`，不看上限），
  模式写 0、骰子写 1；工程车的模式字节（含天数）整个存进 +0x66，背包不变。之后只调 0x40b425 刷新外观。复仇反弹 0x44304d–0x4430d2 对出卡者
  做同样的事。v3.11 0x44435e–0x4443e7（复仇 0x44441d）。
- **结束**：回合开始 fcn.0041c058 里 0x41c1aa–0x41c27b（整段在主阻碍计数 dword +0x32 为 0 时才执行，0x41c161；关押期间梦游暂停）：
  梦游计数带 0x80 时清 0；`+0x66 & 3` 为 1 且背包机车 ≠ 0、为 2 且背包汽车 ≠ 0、或为 3（工程车）→ 模式 = +0x66（整字节，含工程车天数）、
  骰子 = +0x67，模式 1 / 2 时背包 −1；否则模式 0、骰子 1。之后调 0x40b425。v3.11 0x41c9a7–0x41ca77。
  → 背包里还有那台车才装回（背包 −1、骰子数照旧）；工程车直接装回。
- **工程车倒数**：同一函数更后面的 0x41c4a6–0x41c58c（不受主阻碍限制）：模式 & 3 == 3 时 −4，天数位为 0 就按 +0x64 & 3 换回（1 / 2 要背包 ≠ 0、
  背包 −1，否则步行），之后只调 0x40b425。梦游期间模式是 0，**不倒数**；醒来那一回合先装回（0x41c1aa）再倒数（0x41c4a6），**这一回合算一天**。
  v3.11 0x41cca3–0x41cd8c。
- **冬眠卡**（第 15 项 0x442d23）0x442dca–0x442dda：梦游清 0、冬眠写 5、+0x42 +5；+0x66 不动，但装回只在计数 0x80 时发生，以后再也读不到
  → 取消梦游时**不装回**（机车 / 汽车已在背包里，工程车就此没了）。跳过受困者（0x442da0）。
- **梦游中再中梦游卡**：0x442fb2 无条件把当前模式（0，步行）存进 +0x66 → 第一次停放的座驾被覆盖（机车 / 汽车留在背包里，工程车没了）。
- **梦游期间的其他事**：落点事件整个跳过（既有）；魔法屋 / 命运 32 卖光 fcn.0x4446de（魔法屋 0x431612、命运 0x44c09a；破产 0x40cc53 / 0x40ede0）
  只看 +0x11（步行），背包里停放的机车 / 汽车一起卖掉 → 醒来时背包 0，仍步行；停放的工程车不受影响 → 照样装回。抢夺卡 0x442a76 → 0x440596
  → 0x444641（被抢者背包 ≠ 0 才 −1）同理。地雷 / 炸弹 / 飞弹毁车 0x40c7cd 只看 +0x11 → 停放的座驾不受影响。r_items §5.5 记的社群说法
  「先梦游再抢夺汽车会出现 255 辆汽车」在两版代码里找不到（装回前 0x41c1dd / 0x41c1f9 先比较背包 ≠ 0）。
- **机车 / 汽车道具**（道具函数表 0x473c01 第 5 / 6 项）：机车 0x4459e9 只比较模式 ==1（不可用，返回 0）、==2（背包汽车 +1），其余（步行、工程车）
  直接写 1、骰子 2，调 0x40b425 / 0x41cc56 后说道具台词 0x44d870（0x445a77）、背包机车 −1；汽车 0x445aa4 对称（==2 不可用、==1 背包机车 +1、
  写 2、骰子 3，台词 0x445b2f）。工程车天数在模式字节里，被覆盖即作废；+0x64 只在工程车倒数（要求模式 & 3 == 3）时读、下次用工程车道具时
  重写，不再起作用；开工程车时收进背包的车留在背包里，工程车道具不退还。v3.11 0x446e4a / 0x446f05 相同。道具欄 fcn.00446948 只在第 15 格
  （收起）看模式，不按模式把道具置灰。
- **电脑**：v3.11 道具判据跳表 0x4753a0：机车 0x421644 要求模式 & 3 == 0、汽车 0x421675 要求 < 2、工程车 0x421e20 要求 ≠ 3——开着工程车时
  不用机车 / 汽车；v2.06 跳表 0x473228（0x420db7 / 0x420de8 / 0x421596）相同。**电脑策略不用改**。
- **画面与音效**：刷新外观 fcn.0040b425 按模式 & 3 重新载入姿态库（0x44ec68），当前玩家时（0x488884）把行进循环音 0x472880 换成 0xb + 模式
  （0x452a09 停、0x4529ee 循环播；网页版的行进音按座驾选，soundMap `MOVE_SEGMENT`），没有一次性音效。各条路径：
  - 机车 / 汽车 / 工程车道具：0x40b425、0x41cc56(0,0,1) 整屏重画（第 3 个参数 bit0 置位时直接调 0x407ebd 重画、不看 x / y，不移镜头，0x41cc57–0x41cc71）、
    0x44d870 说道具台词（台词表 0x47e03a 第 4 / 5 / 11 项）；真人从道具欄点用时没有提示，电脑用道具前先出 1.5 秒「使用%s」消息框
    （0x446c17，所有道具通用）；
  - 收起 0x4467b1：0x40b425、0x41cc56(0,0,1) 整屏重画，不说台词（§28.1）；
  - 梦游卡：只调 0x40b425（之前那句 0x44d870(目标, 1, 事件槽 21) 是被梦游的反应台词，网页版随 STATUS_SET 播）；醒来、工程车到期、卖光：只调 0x40b425；
  - 命运 10 / 11（命运函数表 0x473d14）：0x44b4e0–0x44b559 / 0x44b5f1–0x44b659 直接写模式 0、骰子 1，**不走毁车 0x40c7cd**（没有 +0x15 bit6 的
    烧焦外观），0x40b425、0x41cc56 重画（命运 10 参数 3 另重画地图），说事件槽台词（命运 10 槽 3 / 4 随机二选一 0x44b52f、命运 11 槽 3 0x44b63d，台词表 0x47db2a），库存 +1；
  - 地雷 / 炸弹 / 飞弹 / 核弹 / 骑车摔伤：0x40c7cd 置 +0x15 bit6（烧焦外观）再 0x40b425——网页版的车毁演出保留。
- **卖光遇到工程车**：fcn.004446de 模式 & 3 为 1 / 2 / 3 时背包机车 / 汽车 / 12 号道具 +1（0x444718 / 0x444720 / 0x444728），模式写 0、
  骰子写 1、刷新外观；再逐个道具按「数量 × 价格」（道具表 0x47d640 + 8·i 的 +7 字节，12 号 150）累计、前 8 种回库存、背包清 0，
  调用方把返回值加到点券（魔法屋 0x43111d、命运 32 0x44c0a2，`add word`）。→ 工程车折成 12 号道具一起卖，多得 150 点券、不回库存。
  v3.11 0x445b66–0x445bae 相同。
- **工程车到期换回的骰子数**：用工程车道具时 +0x65 = 当时的骰子数（0x446600），到期换回机车 / 汽车时骰子 = +0x65（0x41c529），不是上限。
- **顺带发现、未改**（docs/TODO.md，待用户决定）：「本月倒楣天数」（+0x42，月结 0x436ed8 × PI × 2500）原版中梦游 / 冬眠卡 +5、关押 +天数，
  我们只在关押期间每回合 +1。

### 34.2 引擎（ENGINE_VERSION 0.6.0）

- 状态：`PlayerState.parked: { vehicle: 'moto' | 'car' | 'engineer'; dice; engineer: EngineerState | null } | null`（原版 +0x66 / +0x67；
  工程车时 engineer 是停放时的天数与换回目标）。schema 同步；不变量 8b：开工程车 ⇔ `engineer` 非空；`parked` 非空时必须在梦游、步行，
  停放的工程车 ⇔ `parked.engineer` 非空。
- `effects/common.ts`：`stowVehicle(ctx, seat, 'hand' | 'sleepwalk')`——'sleepwalk' 先把原座驾、骰子数、工程车状态记进 `parked`（步行时写 null，
  所以梦游中再中卡会覆盖），机车 / 汽车回背包（`bagVehicle`，同种满 10 台回库存——原版没有上限，但背包最多只能到 10，到不了这条路），
  步行、1 颗骰子，发 `VEHICLE{walk,1,via:'sleepwalk',from}`；'hand' 照旧发 `stowed`。`destroyVehicle(ctx, seat, via?)`：via 'fate' 只用于
  命运 10 / 11（`effects/fate` loseVehicle）。
- `effects/cards/harm.ts`：梦游卡的 apply / revenge 两处改用 'sleepwalk'；`effects/cards/control.ts` 冬眠卡取消梦游时 `parked = null`；
  `flow/liquidation.ts` 出局清算时 `parked = null`。
- `flow/turn.ts start`：梦游计数 0x80 → 0（`tickActorCounters`，关押期间不倒数）的那一回合，在 TURN_STARTED 之前把 `parked` 取下（随
  TURN_STARTED 公布），TURN_STARTED 之后 `wakeVehicle`：机车 / 汽车背包里有才装回（背包 −1、骰子数照旧，`VEHICLE{via:'wake'}`），没有就不发事件；
  工程车直接装回并调 `tickEngineer` 算本回合的一天，到期则随后的 `restoreEngineer` 换回原车（两条 VEHICLE：wake、expire）。梦游期间 `engineer`
  为 null，`tickEngineer` 不倒数。
- `effects/items/vehicle.ts`：机车 / 汽车道具只在已经骑着同一种时不可用；开着工程车时 `bagVehicle` 不收任何东西、`engineer = null`（顶掉、不退还）。
  `restoreEngineer` 发 `VEHICLE{via:'expire',from:'engineer'}`。
- 魔法屋「卖光道具」发 `VEHICLE{walk,1,via:'sold',from}`（`sellAllItemsDetailed` 改为返回 `vehicleFrom`）；命运 32 照旧随 FATE 的 post 公布。
  开着工程车时按原版折成 12 号道具一起卖（得 150 点券、不回库存，魔法屋随后多一条 `ITEM_LOST{12}`），原先是直接作废。
- 工程车到期的骰子数：`EngineerState` 新增 `dice`（原版 +0x65），用工程车道具时记下当时的骰子数，到期换回机车 / 汽车时恢复它（换不回、
  步行时 1）；梦游停放的工程车连同 `dice` 一起停放。电脑总按上限掷，所以电脑对局里与旧版的「按上限」相同。
- 事件：`VEHICLE` 新增可选 `via`（'sleepwalk' | 'wake' | 'expire' | 'sold'）与 `from`；`VEHICLE_DESTROYED` 新增可选 `via: 'fate'`；
  `isQuietVehicleSwitch(e)`（engine/types/events.ts）= 带 stowed / via，客户端与 pacing 共用这条判断。
- pacing：`VEHICLE` 预算一律 `VEHICLE_QUIET_MS` = 200 ms（原先 900）；`VEHICLE_DESTROYED` 不变（命运失车停 0.8 秒在预算内）。
- 电脑策略不变（34.1）；`--policy random` 的候选里开着工程车时多了机车 / 汽车道具。
- 旧快照：`migrate/v1.ts identityV1` 给缺 `parked` 的玩家补 null、给缺 `dice` 的工程车状态（`engineer` 与 `parked.engineer`）补换回座驾的
  上限（含时光机锚点里的世界）；0.5.x 中梦游卡时座驾没有停放、梦游结束不装回，到期时按上限设骰子数，两者都与旧行为一致。服务器重启恢复：0.5 ≠ 0.6 → `migrated`（只迁移快照、不重放 journal）。读档：`SaveService` 原先只在
  stateVersion 更旧时迁移，同版本的旧存档会因缺字段校验失败——改为同版本也经 migrateState（state 自带的 v 与存档的 stateVersion 不符、或迁移抛错时保持原样，
  留给后面的检查报 invalidState，原有的错误原因不变）。`STATE_SCHEMA_VERSION` 仍为 1。

### 34.3 客户端（两种皮肤共用 handler）

- `presentation/handlers/items.ts`：`VEHICLE` 各条路径（含用道具换车）都只换外观——把 post 同步到 store 与舞台，再调舞台的 `vehicle`；
  两种舞台的 `vehicle()`（OrigStage / BoardStage）改为只换姿态库 / 载具图，不闪光、不跳（`FX_VEHICLE_MS` 删掉）。不弹「换乘交通工具」提示
  （那句只进日志）。原版用道具换车另整屏重画一次，网页版棋盘每帧重画，没有对应动作；原版也不移镜头。
  `ITEM_USED` 遇到换车道具（5 / 6 / 12，shared `isVehicleItem`）不画道具名气泡、不播施放演出，`soundMap` 不放施放音效 magic，只说道具台词
  （既有的道具台词机制：voice `{k:'item'}`，取自 exe 道具台词表 0x47e03a）；「XX 使用了机车」提示保留（所有道具通用，对应原版电脑用道具时的
  「使用%s」消息框，真人原版没有）。
  `VEHICLE_DESTROYED{via:'fate'}`：不提示、不飘「车毁了！」、不播车毁，同步外观后停命运效果后的 0.8 秒（original；compact 0.15 秒）。
- `soundMap.ts`：VEHICLE 一律不出声（原先放 ding）；命运失车不放爆炸声，说事件槽台词（机车 `spendSmall0` / `spendSmall1` 二选一，汽车 `spendSmall0`）。
  pacing 的 VEHICLE 预算一律 `VEHICLE_QUIET_MS` = 200 ms。
- `logFormat.ts` 与 i18n `events:log.VEHICLE_*`：用道具换车「换乘交通工具（n 颗骰子）」；收起「收起××，改为步行」；梦游「梦游，××收回道具栏，改为步行」
  （工程车「工程车停下」）；醒来「梦游结束，换回××」；到期「工程车到期，换回×× / 改为步行」；卖光「××一并卖掉，改为步行」；
  命运失车「失去××，改为步行」。zh-TW 由 `npm run i18n:zh-tw` 生成。
- 两种皮肤共用这些 handler，舞台的 `vehicle()` 两边一起改。

### 34.4 测试

- `engine/effects/sleepwalkVehicle.test.ts`（新，14 例）：机车中卡——停放、背包 +1、骰子数 1 照旧，梦游 5 个回合后第 6 个回合装回（背包 −1，
  VEHICLE 在 TURN_STARTED 之后）；汽车被抢夺卡抢走后醒来仍步行、不发 VEHICLE；工程车停放期间天数 7 不变、醒来那一回合 6；醒来当回合到期
  （wake → expire 两条）；步行中卡不停放、梦游中再中卡覆盖；冬眠卡取消；复仇卡反弹双方各自停放与装回；飞弹炸到梦游者不毁停放的车；
  关押期间 0x80 不醒；不变量；工程车被机车 / 汽车顶掉（菜单可用、天数作废、背包里的汽车还在、之后不再倒数）；同一种仍不可用；到期事件带 via；
  到期换回机车时骰子数恢复成开工程车前的 1 颗（不是上限 2），醒来当回合到期同样恢复。
- 改写：`stowVehicle.test.ts`（梦游卡的 VEHICLE 带 via、真人收起不停放）、`magic.test.ts`（卖光 via sold；开着工程车时折成 12 号道具卖掉、
  得 150 点券、ITEM_LOST{12}、库存不变）、`fate.test.ts`（10 / 11 via fate，骑车摔伤不带）、`items.test.ts`（到期 via expire）、
  `api.test.ts`（0.5.x 快照缺 parked 与 engineer.dice：直接校验不通过，migrateState 补 null / 上限，含锚点）、版本号两处。
- 服务器：`integration/restart-recovery.test.ts` 新增「0.5.0 写下的快照、玩家没有 parked」：恢复为 migrated、parked 补 null、0.5.0 中卡的人醒来
  不发 VEHICLE、对局继续无缺号；`integration/save-load.test.ts` 新增「0.5.0 的存档」：真实引擎导入（compatible）、读档开局、parked 为 null。
- 客户端：`handlers/vehicleStow.test.ts` 改写（各来源含用道具换车：只调舞台 vehicle、不提示、不出声；换车道具的 ITEM_USED 没有气泡、施放与 magic
  音效、只说道具台词，飞弹照旧；命运失车的台词）；`handlers/budget.test.ts` 加入各种切换与命运失车。
- E2E：`vehicle-stow.spec.ts` 新增「梦游卡」：1 真人 + 1 电脑、开局汽车，真人对电脑用梦游卡 → 电脑步行、停放汽车、背包 +1、日志「梦游，汽车收回道具栏」；
  空走到电脑醒来 → 日志「梦游结束，换回汽车」，全程没有「换乘」提示（按配置的缺省皮肤：默认配置程序化、原版配置原版）。
- 调试脚本：`test/vehstow-legacy-restore.ts`（0.5.0 快照经 migrateState + validateState 后继续推进：OK）、`test/vehstow-golden-diff.mjs`、
  `test/vehstow-golden-vehicles.ts`、`test/vehstow-sim.sh`、`test/vehstow-dbg-revenge.ts`。

### 34.5 golden（四张图刷新）

`RICH4_UPDATE_GOLDEN=1 RICH4_GOLDEN_MAPS=taiwan,china,japan,usa RICH4_DATA_DIR=./rich4-data npx vitest run --project shared src/engine/golden`，
再不带 UPDATE 跑两遍均 5 / 5 通过、四个快照 sha256 不变；mapHash 不变，16 局 AI intent 被拒 0 次，每步不变量检查通过。
`test/vehstow-golden-vehicles.ts` 按 golden 的同一组对局重放（16 局终局哈希与快照一致），统计座驾切换。各局 事件数 / 天数（旧 → 新）
与首个不同的 400 事件检查点（`test/vehstow-golden-diff.mjs`）：

| 图 | 一个月 | 三个月 | 半年 | 一年 |
|---|---|---|---|---|
| 台湾 | 800 / 30 天，检查点全同 | 2671 / 91，全同 | 5167 / 182，#6 起不同 | 9053 → 9566，357 天 lastStanding → 365 天 timeLimit，#15 起分歧 |
| 大陆 | 833，全同 | 2457，全同 | 4985，全同 | 9580 / 365，#9 起不同 |
| 日本 | 858，全同 | 2538，全同 | 5030 / 182，#7 起不同 | 7846 → 7787，294 → 296 天（仍 lastStanding），#8 起分歧 |
| 美国 | 840，全同 | 2440，全同 | 5011，全同 | 8803 / 365，#13 起不同 |

- 检查点全同的局只是终局哈希因 `state.engine` 版本号变化；事件数不变而检查点不同的局，是事件里多了 `via` 字段——台湾半年（命运 10 / 11 各 1 次
  `VEHICLE_DESTROYED{via:'fate'}`）、大陆一年（命运失车 2 次）、日本半年（魔法屋卖光 1 次 `via:'sold'`、命运失车 2 次）、美国一年
  （卖光 1 次、工程车到期 3 次 `via:'expire'`、命运失车 1 次），对局走向不变。
- 规则改变对局走向的只有两局：台湾一年第 220 天 1 号骑机车中梦游卡（停放，骰子 1），第 225 天醒来装回机车（旧版会一直步行）；日本一年
  第 121 天 0 号坐汽车中梦游卡，第 126 天醒来装回汽车。16 局共用了 12 次梦游卡，其余 10 次没有停放座驾（目标在步行，或打在恶人身上、被免罪 / 嫁祸挡掉）。
- 16 局里电脑一次也没有在开工程车时用机车 / 汽车（34.1：原版电脑不会），冬眠卡取消停放 0 次，醒来时背包里已经没有车 0 次。
- 补上「卖光时工程车折成 12 号道具」「工程车到期恢复原骰子数」（`EngineerState.dice`）之后再刷新一次：大陆、日本两份快照逐字节不变；
  台湾、美国只有一年局变了——事件数、类型计数、天数都不变，只是事件里的工程车状态多了 `dice`（台湾第 21 个检查点起、美国第 19 个起；
  美国终局哈希不变，台湾终局时还有人开着工程车，终局哈希变）。16 局里没有开着工程车被卖光的情形；电脑开工程车前总按上限掷，到期恢复的骰子数
  与旧版的「按上限」相同。之后不带 UPDATE 连跑两遍 5 / 5 通过，sha256：台湾 `5035b4c8…`、美国 `b897a440…`，大陆 `0c8c246e…`、日本 `3573d4af…` 不变。

### 34.6 自对弈

`npm run sim -- --engine-only --map <图> --data-dir rich4-data --games 500 --policy original --workers 7 --stats` 与
`--games 200 --policy random --check-fold --workers 7`，四张图各跑两遍（`test/vehstow-sim.sh`，输出在 `.cache/vehstow/sim/`；时限缺省 730 天）：
16 次运行全部 exit 0、finished = 局数，rejects / invariantErrors / errors 都是 0，两遍的 finalHash 与 journalHash 都相同。
跑自对弈期间 `packages/shared` 的代码与开始时逐字节相同（只改注释的几处在跑完之后才改）。下表是补上卖光工程车、工程车骰子数之后的最终结果：

| 图 | original 500 局 finalHash（平均天数；VEHICLE / VEHICLE_DESTROYED） | random 200 局 finalHash（--check-fold，平均天数） |
|---|---|---|
| 台湾 | `f8b3b56e1937e913`（379.0 天；7877 / 3639） | `cf2c98484af718a2`（150.7） |
| 大陆 | `e2921d141617a095`（513.1 天，38 局 timeLimit；10256 / 4844） | `7df55b9024739ed5`（189.3） |
| 日本 | `ed8369cafba34756`（306.6 天；6664 / 2901） | `257d5323f64ad716`（119.0） |
| 美国 | `6cce97b089904625`（382.1 天；8131 / 3702） | `2fc4a80153fbbe96`（134.6） |

（§31.5 的旧值：original 台湾 `0aec5587ae6ff8d4` 381.7 天、大陆 `3c3f4621cc90de45` 517.8、日本 `686b17518710dccb` 306.8、美国 `c37d5bbeb275d4f5` 383.1；
random 台湾 `a980c4513d7e62e0`、大陆 `9646d6170b534826`、日本 `26dcd8bad624f431`、美国 `2ba641cec6a3760c`。random 也变了：开着工程车时多了
机车 / 汽车两个候选，且醒来装回改变对局走向。本节第一版（只做 TODO 四条时）的 original 是台湾 `8d7d62394ee9bad8`、大陆 `c0cfda005fbc28e7`、
日本 `f7fc99061abf0fbd`、美国 `0f499d1b1b86db4a`，补上两条之后 original 全变——卖光时工程车多得 150 点券，状态与事件里的工程车多了 `dice`；
random 四张图与第一版相同。）

另用 `test/vehstow-golden-vehicles.ts <标签> <图> 60` 每张图跑 60 局一年局（原版电脑 AI，种子 7a1b0000 起）统计座驾切换（第一版时跑的，四张图合计）：
共用梦游卡 283 次，打到骑车的人停放 111 次（机车 54、汽车 56、工程车 1，每张图分别见 `.cache/vehstow/golden/vehicles-extra60.json`），醒来装回 98 次
（机车 48、汽车 49、工程车 1）；醒来时背包里已经没有车 4 次（都是机车：停放后被卖光、抢走）；冬眠卡取消停放 6 次；其余 3 次没有走到醒来（对局结束、
出局清算或梦游中再中卡）；魔法屋卖光座驾 88 次（其中工程车 1 次）；工程车到期 126 次；命运 10 / 11 失车 216 次；**开着工程车时用机车 / 汽车 0 次**（原版电脑不会）；AI intent 被拒 0 次。

### 34.7 验证（2026-10-03，最终一轮）

- `npm run check` EXIT 0：typecheck 四个工作区；lint 1299 个文件；vitest 334 个文件通过 1 跳过、3418 例通过 21 跳过；determinism（193 个文件）/
  no-original（1788）/ deps（1214）/ zh-tw 通过。
- `RICH4_DATA_DIR=./rich4-data npx vitest run --project shared`：90 个文件 904 例全过（含四张图 golden）。第一轮自对弈同时跑时曾有 1 例
  （`ai/items.test.ts`「12 工程车」）、client-dom 的 `realEngine*.dom.test.tsx` 7 例因机器负载超时，单独重跑通过，负载降下来后整跑全过。
- golden：34.5 两次刷新后都不带 UPDATE 连跑两遍，最后改完注释再跑两遍，5 / 5 通过、快照 sha256 不变。
- 自对弈：34.6，16 次运行全部通过、两遍哈希一致。
- 旧快照：`npx tsx test/vehstow-legacy-restore.ts` OK（0.5.0 快照缺 parked 与 engineer.dice，直接校验不通过；migrateState 后通过、不变量为空，
  engineer.dice 补成 3；中卡的人醒来仍步行、不发 VEHICLE；开工程车的人照常倒数）；服务器 `restart-recovery`（migrated 路径）与
  `save-load`（0.5.0 存档导入读档）新用例通过。
- E2E（`CI=1`，端口 3100 / 5174 / 3110 / 5184 事先确认空闲）：`vehicle-stow.spec.ts` + `skin-classic-dice.spec.ts` 默认配置 5 / 5 通过、
  原版配置 5 / 5 通过（含新增的「梦游卡」）。原版配置有一次 `skin-classic-dice` 第一例卡在 `browser.newContext` 超时（机器负载下浏览器没起来，
  与本改动无关），重跑 5 / 5 通过。之后只改了卖光工程车那句日志的措辞，E2E 用例走不到。全量 E2E 没有跑。

### 34.8 遗留

- 「本月倒楣天数」原版中梦游 / 冬眠卡 +5、关押时 +天数，我们只在关押期间每回合 +1（与载具无关，docs/TODO.md 待用户决定）。
- 用道具换车时网页版仍有「XX 使用了机车」提示（所有道具通用的 ITEM_USED 提示，对应原版电脑用道具时的 1.5 秒「使用%s」消息框；真人用时原版没有），
  原版皮肤没有做成原版的消息框；原版那次整屏重画网页版没有对应动作（棋盘每帧重画）。
- V-R31：只做了 exe 静态分析，没有在原版里实际看过（verify-checklist V-R31）。
- 收起座驾（`stowVehicle 'hand'`）与梦游停放时机车 / 汽车回背包仍按同种满 10 台回库存（原版 `inc byte` 不看上限，但背包里的车最多只能到 10 台，
  这条分支到不了）。
