# 大富翁4 网页复刻：前端渲染 / UI·UX / 美术与音频管线设计

> **实施记录**：与本文不一致的实际做法见 architecture §17.5（M3a）、§18.2（M3b 主循环与对话框）、§18.6（联调），以那里为准。

> 适用范围：`apps/client`（Vite + React 19 + PixiJS v8），以及本领域需要放进 `packages/shared` 的两块纯函数代码：`presentation/timing.ts`（动画时长预算，服务器和客户端共用）和 `minigames/*`（小游戏确定性模拟）。
> 遵守全局约定：服务器是唯一权威。客户端只发 intent、只播放 events、最终以快照为准。需要玩家决策的地方由 pendingDecision 驱动。
> 2026-09-26 在 npm registry 上核实过的版本见第 14 节。

---

## 0. 结论速览

| 主题 | 结论 |
|---|---|
| 渲染 | **PixiJS v8（8.21.x）以命令式写法**绘制棋盘、特效和小游戏；**React 19 DOM** 负责所有 HUD、对话框、面板、大厅、聊天。棋盘**不用 @pixi/react**。 |
| 状态 | **Zustand v5**，拆成多个 store。React 通过 selector 订阅；Pixi 层用 `store.subscribe` 订阅，不经过 React 渲染。 |
| 事件动画 | `EventPlayer`：批次队列 + 每种事件一个 async handler + 可变速的 `AnimClock` + `AbortSignal` 跳过机制。HUD 读的是按播放进度提交的**显示态 view**，不是最新权威快照 **latest**。每个批次结束时用快照对账；观战、断线重连、后台切回时直接 `reset(snapshot)`。 |
| 决策时限 | 共享的 `batchBudgetMs(events)` 估算一批事件的动画总时长。服务器下发的 deadline = 当前时间 + 动画预算 + 决策时限，所以客户端播完动画后不会吃掉玩家的思考时间。 |
| 美术 | 全部程序化生成：角色用 SVG 纸娃娃 rig（12 个角色 + NPC + 神仙共用一套骨架），建筑用 Pixi Graphics 等角挤出生成器，按等级变高；图标补充 Kenney（CC0）和 Microsoft Fluent Emoji（MIT）。每个素材都登记进 `credits.json`，由 CI 校验。 |
| 音频 | **自研薄封装 `AudioEngine`（基于 Web Audio）**：BGM 用 `<audio>` + MediaElementSource 流式播放，SFX 用解码后的 AudioBuffer，程序音效用 **ZzFX**（MIT）。不依赖 Howler，理由：它自 2023-09 的 2.2.4 后未再发版，维护者长期无更新。 |
| 小游戏 | 规则写在 shared 里，是确定性、定步长、只用整数或定点数的 sim。客户端只提供 View 和 Input 适配器。输入日志上传后由服务器重放验分（防作弊）；观战者用服务器转发的输入帧同步重放。 |
| 适配 | 画布铺满全屏，HUD 用 DOM 叠在上层。按 3 档断点布局，Camera 按 HUD 遮挡区域（insets）计算居中。设备像素比最多取 2，低画质档关粒子、锁 30fps。 |
| 测试 | Vitest 5 分 3 个 project：node 单元测试、jsdom 组件测试、浏览器模式渲染与截图测试。Playwright 1.63 开 4 个 BrowserContext（外加 1 个观战）跑完整联机对局、断线重连和存读档。 |

---

## 1. 技术选型对比与结论

### 1.1 渲染引擎

| 方案 | 优点 | 缺点 | 适配本项目 |
|---|---|---|---|
| **PixiJS v8**（8.21.0，2026-09-25 发布，几乎每月一版） | 专注 2D 渲染和场景图，按模块 tree-shake；支持 WebGL、WebGPU，8.16 起还有实验性 Canvas 回退；v8 自带 ParticleContainer、cacheAsTexture、BitmapText、SVG 转 Graphics；与 React 解耦；官方在 `node_modules/pixi.js/skills` 附带给编码 agent 用的技能文档 | 镜头、补间、场景切换要自己写（约 500 行） | **选用** |
| Phaser 4（4.2.1，2026-04 发布大版本） | 引擎功能齐全：场景、镜头跟随、补间、音频、粒子 | 包体大；有自己的主循环和场景生命周期，和 React、Zustand 是两套世界，要靠 EventBus 同步；v4 渲染器是新重写的，第三方插件生态还在迁移 | 不选。它最擅长的动作小游戏只占我们约 10% 的内容 |
| 纯 Canvas2D | 零依赖，控制力最强 | 深度排序、批渲染、文字缓存、HiDPI、命中检测、粒子都要自己写，开发成本最高 | 不选 |
| @pixi/react 8.0.5（仅支持 React 19） | 能用声明式 JSX 描述场景 | 我们的棋盘本质上是**被命令式动画队列驱动**的（await walk/tween），经过 reconciler 反而会冲突 | 不用在棋盘上。以后简单的静态场景（例如开发用画廊）可以考虑 |

**结论**：React 19 管 DOM UI。Pixi v8 由一个框架无关的 `GameRenderer` 类持有，React 只在 `<BoardCanvas>` 里把它挂载一次，之后永不重渲染。两边通过 Zustand store、`PresentationContext` 服务对象和 `UiPresenter` 通信。

### 1.2 HUD 用 DOM 还是游戏内绘制

- **DOM（React）负责**：信息栏、所有对话框和面板、股市、银行、乐透、新闻弹窗、背包、大厅、聊天（需要输入法 IME）、设置、存读档。理由：中文排版、无障碍、i18n、响应式、表单输入、测试（Testing Library 和 Playwright 都能直接按角色查到元素）。
- **Pixi 负责**：棋盘内的元素，包括飘字（收租 +1,200）、头顶名牌和说话气泡、目标格高亮、岔路箭头、定时炸弹倒计时数字、爆炸和光柱等特效。
- **规定**：所有在画布内完成的决策（选岔路、选目标格）**必须同时提供 DOM 备用按钮**。这既服务无障碍、手机上点不准的情况，也方便 Playwright 直接点。

### 1.3 其他选型

- 路由：`wouter@3`（3.11.0，Unlicense，很小）。只有 `/`、`/r/:code`、`/solo`、`/dev/*` 几个路由。
- UI 基础组件：`radix-ui@1`（1.6.7），用于 Dialog、Tabs、Slider、Tooltip、Popover、ToggleGroup，自带焦点管理和无障碍。
- DOM 动画：`motion@13`（13.4.4，MIT），用于面板进出场、卡片翻转、新闻滑入。
- Pixi 补间：**自己写** `anim/tween.ts`，由 `AnimClock` 驱动。必须支持倍速、中止（skip 时立即 resolve）以及测试里的假时钟，这三点通用库不好控制。GSAP 3.15 是 "no charge" 标准许可，不是 OSI 开源协议，只作备选。
- 样式：CSS Modules + CSS 变量 design tokens（Vite 原生支持）。不上 Tailwind，因为卡通厚描边风格靠少量 token 就能统一。
- 粒子：Pixi v8 自带的 `ParticleContainer` + `Particle`，外加自写的 `fx/Particles.ts` 发射器。`@pixi/particle-emitter` 的 peer 依赖是 `<8.0.0`，**不兼容 v8**，不用。
- 镜头：自写 `Camera`（约 250 行）。`pixi-viewport` 6.0.3 虽然支持 v8，但 2024-11 后没有更新，而我们的需求（跟随、平移、缩放、惯性、HUD insets）很简单。

---

## 2. 目录结构（apps/client 与 shared 中本领域部分）

```
packages/shared/src/
  presentation/
    timing.ts            # EVENT_BUDGET_MS、batchBudgetMs()：服务器算 deadline、客户端控节奏，两边共用
  minigames/
    types.ts             # MiniGameDef / InputLog / MiniGameOutcome
    fixed.ts             # 定点数、整数三角查表（禁止 Math.sin 等）
    balloonShoot/{sim.ts, ai.ts, sim.test.ts}
    fortuneCatch/{sim.ts, ai.ts, sim.test.ts}
    penguinDig/{sim.ts, ai.ts, sim.test.ts}
    registry.ts
  (其余 engine/data/protocol 由其他领域负责；客户端会 import types、data、selectors、protocol)

apps/client/
  index.html
  vite.config.ts           # alias @rich4/shared；按 minigames、audio 手动分 chunk
  vitest.config.ts         # projects: unit(node) / dom(jsdom) / browser(playwright)
  public/
    audio/bgm/*.mp3        # 流式 BGM（不经过 hash，方便 Range 请求）
  assets/
    credits.json           # 素材登记表（来源、作者、许可证）
    sfx/*.mp3|ogg          # 导入后由 Vite 加 hash
    icons/*.svg            # Kenney / Fluent Emoji 精选（已登记）
  scripts/
    check-credits.ts       # CI：assets 与 public 下每个文件都必须登记，且许可证在白名单内
    bake-atlas.ts          # （可选，第二阶段）用 @resvg/resvg-js + free-tex-packer-core 在构建期烘焙图集
  src/
    main.tsx
    app/
      App.tsx  routes.tsx  services.ts      # 服务容器：transport/renderer/eventPlayer/audio/ui
      ErrorBoundary.tsx
    net/
      transport.ts          # Transport 接口
      wsTransport.ts        # 浏览器原生 WebSocket：重连、心跳、序号
      localTransport.ts     # 单机：在 Worker 中跑 GameSession（依赖 shared 的 session core，见 13 节）
      local.worker.ts
      clock.ts              # 服务器时钟偏移（ping/pong）
      router.ts             # ServerMsg 分发到 store、EventPlayer、MiniGameHost
    store/
      connectionStore.ts  roomStore.ts  gameStore.ts  uiStore.ts  settingsStore.ts  chatStore.ts
      selectors.ts
    game/                    # 纯 Pixi，不 import React
      GameRenderer.ts        # Application 初始化、分层、resize、画质档位、上下文丢失恢复
      layers.ts              # ground/marks/objects/fx/overlay
      iso/projection.ts  iso/depth.ts  iso/picking.ts
      camera/Camera.ts  camera/gestures.ts
      board/
        BoardView.ts         # load(map) / sync(state) / 动画原语
        GroundLayer.ts       # 地形 + 道路（分块 cacheAsTexture）
        RoadPainter.ts       # 道路、路口、车道线、特殊格底板
        LotView.ts           # 小地产：地块、旗子、建筑精灵
        BigLotView.ts        # 2x2 商业大块地
        LandmarkView.ts      # 银行/医院/监狱/新闻/乐透/魔法屋/卡片屋/百货/游乐园
        RoadObjectView.ts    # 路障/地雷/定时炸弹/机器娃娃/路上神仙/路上点券
        TileMarkers.ts       # 高亮、目标选择、路径预览、岔路箭头
        Decorations.ts       # 树、水、山、云
      actors/PlayerActor.ts  actors/GodSprite.ts  actors/Vehicle.ts  actors/Bubble.ts
      fx/FxSystem.ts  fx/Particles.ts  fx/FloatingText.ts  fx/Explosion.ts
      fx/LightPillar.ts  fx/Beam.ts  fx/ScreenFlash.ts
      dice/DiceView.ts
      anim/AnimClock.ts  anim/tween.ts  anim/easing.ts  anim/sequence.ts
      procedural/
        textureCache.ts            # key 到 Texture 的缓存，上下文恢复后可整体重建
        building/geometry.ts       # 等角挤出盒子、屋顶、窗格
        building/generate.ts       # BuildingSpec 生成 Texture
        building/styles.ts         # 等级外观表（主题数据）
        character/rig.ts           # 纸娃娃骨架、姿势、帧
        character/parts/*.ts       # 头型/发型/眼/嘴/服装/配件：返回 SVG 片段的函数
        character/defs.ts          # 12 个角色 + NPC + 神仙 + 四大恶人的配置
        character/svg.ts           # characterSvg(cfg, pose, dir, frame) 输出 SVG 字符串
        character/atlas.ts         # 栅格化并打包成运行时图集
        icons/cardFrame.ts         # 卡片框 SVG
        rasterize.ts               # SVG 字符串 → Image → Canvas → Texture
      minimap/MiniMapPainter.ts    # Canvas2D 小地图（DOM 组件使用）
    presentation/
      EventPlayer.ts
      viewReducer.ts        # applyEventToView(view, event)：读事件里的后置值，提交到显示态
      handlers/index.ts     # 对 GameEvent['type'] 穷举（用 satisfies 强制）
      handlers/{turn,dice,move,property,money,card,item,god,hazard,hospitalJail,news,fate,lottery,stock,bank,magic,shop,minigame,endgame}.ts
      UiPresenter.ts        # 可 await 的 DOM 弹窗桥
      soundMap.ts           # 事件到音效的映射
      logFormat.ts          # 事件转中文日志行（i18n）
    minigames/
      host/MiniGameHost.ts  host/InputRecorder.ts  host/SpectatorFeed.ts  host/FixedStepLoop.ts
      balloonShoot/{view.ts,input.ts,Hud.tsx}
      fortuneCatch/{view.ts,input.ts,Hud.tsx}
      penguinDig/{view.ts,input.ts,Hud.tsx}
      registry.ts           # 按 id 懒加载 import()
    ui/
      theme/tokens.css  theme/global.css  theme/fonts.ts
      components/  Button  Panel  Modal  BottomSheet  Countdown  Money  Avatar  CardTile
                   IconButton  Tabs  Stepper  Sparkline  PlayerColorMark  Kbd
      hud/  HudLayout.tsx TopBar.tsx CalendarBadge.tsx StockTicker.tsx PlayerPanel.tsx
            PlayerChips.tsx ActionPad.tsx DiceButton.tsx GodBadge.tsx StatusBadges.tsx
            MiniMap.tsx TurnBanner.tsx WaitingBanner.tsx
      decisions/ DecisionLayer.tsx registry.ts
            PreRollActions.tsx BuyLandDialog.tsx UpgradeDialog.tsx BigLotBuildDialog.tsx
            ForkChooser.tsx TargetPicker.tsx BankDialog.tsx StockTradeDialog.tsx
            LotteryDialog.tsx ShopDialog.tsx MagicHouseDialog.tsx AuctionDialog.tsx
            BailDialog.tsx MiniGamePickDialog.tsx RemoteDiceDialog.tsx GenericChoice.tsx
      panels/ InventoryPanel.tsx StockPanel.tsx BankPanel.tsx PlayerInfoPanel.tsx
              PropertyListPanel.tsx TileInfoPopover.tsx EventLogPanel.tsx
      popups/ PopupLayer.tsx NewsPopup.tsx FatePopup.tsx LotteryDrawPopup.tsx
              CardCastPopup.tsx GodArrivePopup.tsx MonthlyReport.tsx GameOverScreen.tsx Toasts.tsx
      lobby/ HomeScreen.tsx CreateRoomForm.tsx JoinRoomForm.tsx RoomScreen.tsx SeatGrid.tsx
             CharacterPicker.tsx RoomSettings.tsx InviteLink.tsx(+QR) SoloSetup.tsx
      social/ ChatPanel.tsx QuickPhrases.tsx EmotePicker.tsx SpectatorList.tsx
      system/ SystemMenu.tsx SaveLoadMenu.tsx SettingsDialog.tsx ReconnectOverlay.tsx
              RotateHint.tsx AudioUnlockGate.tsx Credits.tsx
      screens/ GameScreen.tsx BoardCanvas.tsx
    audio/ AudioEngine.ts bgm.ts sfx.ts zzfxPresets.ts voiceBabble.ts manifest.ts
    i18n/ index.ts format.ts locales/zh-CN/{ui,game,cards,items,gods,tiles,events,news,fate,magic,minigames}.json
    dev/ Gallery.tsx MapPreview.tsx DebugPanel.tsx testHooks.ts
e2e/                       # 仓库根目录
  playwright.config.ts
  fixtures/room.ts         # fourPlayers / spectator fixture
  specs/{lobby,turn-cycle,timeout-ai,reconnect,chat-spectate,minigame,save-load,solo-soak,mobile-layout,visual}.spec.ts
```

---

## 3. 等角 2.5D 棋盘渲染

### 3.1 地图数据到渲染的契约（向数据/引擎领域提出的最小需求）

```ts
// 定义在 packages/shared/src/data/maps/types.ts（字段名由数据领域定稿，这里列渲染必需项）
export interface MapDef {
  id: string; nameKey: string;
  grid: { w: number; h: number };            // 逻辑网格尺寸（单元格）
  terrain: string[];                          // 每行一个字符串：g 草地 w 水 s 沙 p 广场 m 山 …
  tiles: TileDef[];                           // 可行走的路格（棋盘格）
  lots: LotDef[];                             // 地块（小地产 1x1，大块地 2x2）
  landmarks: LandmarkDef[];                   // 银行/医院/监狱… 的建筑占位
  decorations: { kind: string; x: number; y: number; variant?: number }[];
}
export interface TileDef {
  id: TileId; x: number; y: number;           // 所在网格单元（整数）
  kind: TileKind;                             // road | property | bank | news | fate | lottery | magic | cardShop | mall | park | amusement | hospital | jail | …
  next: TileId[]; prev: TileId[];             // 有向邻接；next 长度 > 1 表示岔路
  lotId?: LotId; landmarkId?: string;
}
export interface LotDef { id: LotId; cells: { x: number; y: number }[]; size: 'small' | 'big'; streetId: string; frontTiles: TileId[] }
export interface LandmarkDef { id: string; kind: LandmarkKind; cells: { x: number; y: number }[] }
```

约束（渲染依赖，建议由 `validateMap()` 校验）：lot 与 landmark 的 footprint 必须是**矩形**；路格之间只能四邻接（等角屏幕上即 4 个斜向方向）；同一个单元格不能同时是路格和地块。

### 3.2 投影、拾取、深度

```ts
// game/iso/projection.ts
export const TILE_W = 128, TILE_H = 64, Z_UNIT = 24;      // 2:1 dimetric；Z_UNIT 为每层楼高度像素
export interface Pt { x: number; y: number }
export function isoToWorld(gx: number, gy: number, gz = 0): Pt {
  return { x: (gx - gy) * (TILE_W / 2), y: (gx + gy) * (TILE_H / 2) - gz * Z_UNIT };
}
export function worldToIso(wx: number, wy: number): Pt {          // 返回小数网格坐标
  const a = wx / (TILE_W / 2), b = wy / (TILE_H / 2);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}
export const cellCenter = (c: Pt) => isoToWorld(c.x + 0.5, c.y + 0.5);
export type IsoDir = 'NE' | 'SE' | 'SW' | 'NW';                 // +x=SE（屏幕右下）, +y=SW（屏幕左下）
export function dirBetween(a: Pt, b: Pt): IsoDir;

// game/iso/depth.ts
export const enum DepthBias { Ground = 0, Marker = 1, RoadObject = 2, Building = 3, Actor = 4, Fx = 5 }
export function depthOf(gx: number, gy: number, bias: DepthBias): number { return (gx + gy) * 8 + bias; }
export function depthOfFootprint(cells: Pt[], bias: DepthBias): number;   // 取 footprint 中 max(x+y)
```

- **深度规则**：`objects` 层设 `sortableChildren = true`。建筑深度取 footprint 中 `max(x+y)`；角色取当前插值位置，行走中取起点和终点的较大值，防止跳层；深度相同时按 bias 排序，角色压过建筑。前提是 footprint 为矩形、角色只走相邻路格，这个排序对 8 邻域都正确（已逐格推演）。
- **遮挡淡化**：当前行动角色若在某建筑之后（深度更小）且包围盒相交，该建筑 alpha 渐变到 0.45。
- **拾取**：每个路格标记 Sprite 设 `eventMode='static'`，hitArea 为菱形 `Polygon`；地块同理。空白处点击用 `worldToIso` 取整后查表。

### 3.3 渲染分层（GameRenderer）

```
stage
 └ world (Camera 控制 position/scale)
    ├ ground     地形 + 道路 + 特殊格底板；静态，按 16×16 单元分块 cacheAsTexture（每块 ≤ 2048px，低于 4096 上限）
    ├ marks      地块归属色带 / 高亮 / 路径预览 / 岔路箭头 / 目标选择（isRenderGroup）
    ├ objects    建筑、地标、路面物件、角色、路上神仙、装饰树（按深度排序）
    ├ fx         粒子、光柱、光束、爆炸（ParticleContainer）
    └ overlay    飘字（BitmapText）、名牌、说话气泡、炸弹倒计时（不排序，始终最上）
 └ screenFx      全屏闪白、暗角（不受镜头影响）
 └ minigameRoot  小游戏场景（进入小游戏时 world.visible=false）
```

`Application.init({ resizeTo: host, autoDensity: true, resolution: min(devicePixelRatio, quality.maxDpr), antialias: quality !== 'low', preference: 'webgl', powerPreference: 'high-performance', background: 0x8fd3f4 })`。WebGPU 放在设置里作实验开关。`ticker.maxFPS` 由画质档决定：高 60、低 30。监听 `webglcontextrestored`，恢复后调用 `textureCache.rebuildAll()`，再 `board.sync(view)`。

### 3.4 道路与岔路

- `RoadPainter` 根据每个路格的 next/prev 连通方向（4 bit）选 16 种路面拼接之一：直路、弯道、T 字、十字、尽头，用 Graphics 画菱形路面、路缘和虚线车道线，烘焙进 ground 分块。
- 特殊格底板用色块加中心图标：命运「?」黄色、新闻「电视」蓝色、乐透「球」粉色、魔法屋「星」紫色、卡片屋「卡」绿色、银行「$」金色、游乐园「摩天轮」橙色，另有医院和监狱。
- **岔路**：遇到 `chooseDirection` 决策时，在 fork 格对应的各个 next 格上显示脉动箭头（marks 层，可点击），另有 DOM 版 `ForkChooser`（↖ ↗ 两个按钮，标注目标方向的地标名称）。角色当前朝向决定"前进"方向（转向卡会改变它），所以箭头在朝向对应的一侧高亮。
- **路径预览**：使用遥控骰子或定点类卡片时，按候选步数用半透明脚印显示可能落点（数据来自 pending.options，客户端不自己算规则）。

### 3.5 地产与建筑外观（程序化，随等级变高）

```ts
// game/procedural/building/generate.ts
export type BuildingKind = 'house' | 'mall' | 'hotel' | 'lab' | 'gas' | 'park' | `landmark:${LandmarkKind}`;
export interface BuildingSpec { kind: BuildingKind; level: number; footprint: 1 | 2; ownerColor: number | null; variant: number }
export function buildingKey(s: BuildingSpec): string;                 // 缓存键
export function drawBuilding(g: Graphics, s: BuildingSpec): { anchorY: number; heightPx: number };
export function getBuildingTexture(r: Renderer, s: BuildingSpec): Texture; // generateTexture({ resolution: 2 }) 后缓存
```

- 几何：`extrudeBox(g, cellsW, cellsD, heightFloors, colors)` 画 3 个面，亮度分别为顶面 100%、左面 85%、右面 70%，外加 2px 深棕描边 `#3A2A1A`。屋顶可选坡顶、平顶、穹顶、塔尖；窗格按楼层 × 面宽排布。
- **小地产等级表**（`styles.ts`，属于主题数据，最高等级跟随 `data.maxHouseLevel`）：

| 等级 | 外观 | 楼层 | 细节 |
|---|---|---|---|
| 0 | 空地：草皮 + 「出售」木牌 | 0 | 已购未建时插玩家颜色旗（带玩家形状标记 ●▲■★） |
| 1 | 平房，坡屋顶为玩家色 | 1 | 1 门 2 窗 |
| 2 | 二层楼 | 2 | 阳台、雨棚为玩家色 |
| 3 | 洋房 | 3 | 屋顶招牌 |
| 4 | 公寓 | 5 | 窗格网，顶部水塔 |
| 5 | 大楼 | 8 | 楼顶天线、玩家色旗、夜灯闪烁 |

- **商业大块地（2x2）**：商场（1–5 级：玻璃幕墙 + 「商场」招牌，楼层 2/3/4/6/8）、旅馆（1–5 级：「HOTEL」霓虹，4 级起有泳池）、研究所（1–5 级：穹顶数量随等级增加，外加天线）、加油站（1 级：雨棚 + 油枪）、公园（1 级：树、喷泉、长椅）。未建时显示大块空地和「招商」牌。
- 地标（银行、医院、监狱、新闻中心、乐透站、魔法屋、卡片屋、百货公司、游乐园）用同一套生成器，每种有固定造型和招牌。
- **升级动画**：搭脚手架 120ms → 尘土粒子 → 新纹理替换，scaleY 按 0.6 → 1.08 → 1.0 弹跳（350ms）→ 飘字「LV3!」。**拆除或炸毁**：抖动后下沉，碎片粒子，最后回到空地或 0 级。

### 3.6 路面物件、神仙、状态

| 物件 | 程序化外观 | 动画 |
|---|---|---|
| 路障 | 红白栅栏 + 锥桶 | 放置时从天而降并弹跳；触发时角色撞上后后仰 |
| 地雷 | 半埋圆盖 + 闪烁红灯 | 触发时爆炸 fx，角色被救护车接走 |
| 定时炸弹 | 圆炸弹 + 引信火花 + BitmapText 倒计时 | 每天减 1 并抖动；爆炸时 3×3 冲击波，镜头震动，范围内建筑降级 |
| 机器娃娃 | 小机器人 | 沿路走 N 格，把沿途物件弹飞 |
| 路上神仙 | 漂浮神仙精灵 + 柔光 + 上下浮动 | 被遇上时降下光柱，缩小后附到角色头顶 |
| 路上点券 | 10/30/50 面额的券币 | 被拾取时向 HUD 点券栏飞行 |

- 附身神仙：`GodSprite` 缩放 0.5 挂在角色头顶，带浮动和对应色光环（财神金、衰神灰紫等）。HUD 的 `GodBadge` 显示图标和剩余天数环。
- 状态外观：冬眠（冰蓝色调 + zzz 气泡）、乌龟（背上龟壳图标）、住院或坐牢（角色从路上消失，出现在医院或监狱建筑窗口的小头像气泡里，显示剩余天数）、有交通工具（机车或汽车精灵垫在角色脚下，行走时有排气粒子）。

### 3.7 玩家棋子与行走

```ts
export interface PlayerActor {
  readonly id: PlayerId; readonly root: Container;
  walk(path: TileId[], o: { stepMs: number; signal: AbortSignal; onStep?: (t: TileId, i: number) => void }): Promise<void>;
  teleport(tile: TileId): void;                       // 用于 sync 或 skip
  setFacing(d: IsoDir): void; setPose(p: Pose): void; // idle|walk|cheer|sad|hurt|sleep|cast
  setVehicle(v: VehicleKind | null): void;
  setGod(g: GodId | null): void; setStatus(s: StatusVisual[]): void;
  say(text: string, ms: number): void; emote(id: EmoteId): void;
  hop(): Promise<void>;                               // 被选中或轮到时跳一下
}
```

- 每一步 `stepMs` 按倍速计算（1x 下 180ms），用抛物线小跳加 squash & stretch。行走帧有 4 帧，只画正面（SE）和背面（NE）两套，左右方向靠 `scale.x=-1` 镜像得到 4 个方向。
- 多名玩家站在同一格时，按座位做 ±12px 偏移，避免重叠。

### 3.8 镜头 Camera

```ts
export class Camera {
  constructor(world: Container, viewport: { w: number; h: number });
  zoom: number; readonly minZoom = 0.4; readonly maxZoom = 1.8;
  setInsets(i: { top: number; right: number; bottom: number; left: number }): void; // 扣除 HUD 遮挡，算有效可视区
  setBounds(worldRect: Rectangle): void;
  follow(target: (() => Pt) | null, lerpPerFrame = 0.12): void;   // 与帧率无关：1-(1-l)^(dt/16.7)
  panTo(p: Pt, ms: number, signal?: AbortSignal): Promise<void>;
  zoomTo(z: number, ms: number, anchor?: Pt): Promise<void>;
  shake(amp: number, ms: number): void;
  fitAll(ms?: number): Promise<void>;                               // 开局俯瞰
  onUserGesture(): void;                                            // 手动拖动后暂停跟随 4 秒
  update(dtMs: number): void;
}
// camera/gestures.ts：Pointer Events 实现单指拖动 + 惯性、双指捏合、滚轮以指针为锚点缩放、双击回到当前玩家；canvas 设 touch-action:none
```

镜头行为：开局 `fitAll`，然后飞向第一个行动的玩家；回合开始时 `panTo` 当前玩家（600ms）；行走时 `follow`；远程事件（导弹目标、炸弹爆炸点、机器娃娃）先 `panTo` 事件点，播完再回到当前玩家；观战者可以点玩家头像切换跟随对象；HUD 有「回到当前」按钮。

### 3.9 小地图（DOM + Canvas2D）

`MiniMapPainter` 按地图数据画菱形格，着色为地块主人颜色，玩家显示为彩点，视口显示为框。显示态变化后节流到 250ms 重绘。点击调用 `camera.panTo`。

---

## 4. 事件动画队列（EventPlayer）

### 4.1 服务器批次与显示态（客户端对协议的期望）

```ts
// 定义在 shared/protocol（由服务器领域定稿；以下为客户端所需的最小字段）
export interface EventBatch {
  fromVersion: number; toVersion: number;
  events: GameEvent[];                  // 已按观察者脱敏
  state: ClientGameState;               // toVersion 时的快照（按观察者脱敏）
  pending: PendingDecisionView | null;  // 本批之后等待的决策（可能属于别人）
}
export interface PendingDecisionView<K extends DecisionKind = DecisionKind> {
  id: string; seat: SeatId; kind: K; options: DecisionOptions[K]; // options 里包含渲染所需的全部数字（价格、过路费、合法目标）
  deadline: number;                                                // 服务器 epoch ms，已计入动画预算
}
```

**对引擎事件的硬性要求**：凡是会改变 HUD 或棋盘可见状态的事件，都要**携带后置绝对值**，例如 `{ type:'cashChanged', playerId, delta:-1200, cash:48800, reason:'rent', to:'p2' }`。这样客户端的 `applyEventToView` 只做字段写入，不用重复实现规则。

### 4.2 核心接口

```ts
// presentation/EventPlayer.ts
export type Speed = 1 | 2 | 3;
export interface PresentationContext {
  board: BoardView; camera: Camera; fx: FxSystem; ui: UiPresenter; audio: AudioEngine; dice: DiceView;
  clock: AnimClock; signal: AbortSignal; me: SeatId | null; role: 'player' | 'spectator';
  t: TFunction; view(): ClientGameState;
}
export type EventOf<T extends GameEvent['type']> = Extract<GameEvent, { type: T }>;
export type EventHandler<T extends GameEvent['type']> = (e: EventOf<T>, ctx: PresentationContext) => Promise<void>;
// handlers/index.ts：引擎每新增一种事件都会在这里触发编译错误
export const handlers = { /* … */ } satisfies { [K in GameEvent['type']]: EventHandler<K> };

export class EventPlayer {
  constructor(deps: { ctx: Omit<PresentationContext, 'signal'>; store: GameStoreApi });
  reset(state: ClientGameState, pending: PendingDecisionView | null): void; // 直达快照（加入/重连/resync/读档/切回前台）
  enqueue(batch: EventBatch): void;                // 检查 fromVersion 连续，断档则发 resync
  skipAll(): void;                                 // abort 当前 handler，清空队列，直达最新快照
  setSpeed(s: Speed): void;
  setInstant(on: boolean): void;                   // 后台标签页或测试 ?anim=instant：只提交不播放
  readonly backlogMs: number;
  onDrained(cb: () => void): () => void;
}

// presentation/viewReducer.ts
export function applyEventToView(v: ClientGameState, e: GameEvent): ClientGameState;  // 纯函数

// game/anim/AnimClock.ts
export class AnimClock { speed: number; now(): number; advance(dtMs: number): void; wait(ms: number, s?: AbortSignal): Promise<void> }
export function tween<T extends object>(obj: T, to: Partial<Record<keyof T, number>>, ms: number,
  o?: { ease?: Ease; signal?: AbortSignal; clock?: AnimClock }): Promise<void>;   // 被 abort 时直接跳到终值并 resolve
```

### 4.3 播放算法

```
enqueue(batch):
  if batch.fromVersion !== lastQueuedVersion → send {t:'resync', haveVersion}；丢弃
  queue.push(batch); lastQueuedVersion = batch.toVersion; pump()

pump():  (串行)
  for batch in queue:
    for e in batch.events:
      if instant || skipping: view = applyEventToView(view, e); continue
      await handlers[e.type](e, ctx)            // 动画、音效、镜头、DOM 弹窗
      view = applyEventToView(view, e)          // "提交点"：HUD 数字在这一刻变化
      store.setView(view); log(e)
    // 批尾对账
    if DEV && !deepEqualVisible(view, batch.state) → console.warn(diff)（CI 中视为测试失败）
    view = batch.state; board.sync(view); store.setView(view)
    store.setPending(batch.pending)              // 决策对话框只在动画追上之后出现
  追帧策略：backlogMs > 6s 时自动 3x；> 15s 或 queue.length > 5 时 skipAll()
```

- handler 内部有细粒度提交：例如 `playerMoved` 每走一格调 `onStep` 局部更新位置，路过银行、收点券时 HUD 同步跳动。
- `reset()` 和 `skipAll()` 的流程：abort 当前 signal → `fx.clear()` → `ui.closeTransient()` → `board.sync(state)`（全部 `teleport`、建筑直接换成终态纹理）→ `camera.follow(当前玩家)`。
- **后台标签页**：浏览器会暂停 rAF，所以监听 `visibilitychange`，隐藏时 `setInstant(true)`，回到前台后恢复。整个过程中只做提交，不堆积动画。
- **观战**：与玩家使用完全相同的流程；中途加入时先收 `sync` 再 `reset`。
- **本地速度**：每个客户端独立设置 1x/2x/3x。服务器不等客户端确认，deadline 按 1x 的预算计算，客户端最慢也能按时播完。

### 4.4 共享时长预算（放在 shared，服务器也用）

```ts
// packages/shared/src/presentation/timing.ts
export const STEP_MS = 180;
export const EVENT_BUDGET_MS: { [K in GameEvent['type']]: number | ((e: EventOf<K>) => number) } = {
  diceRolled: 900, playerMoved: e => e.path.length * STEP_MS + 250, landBought: 900, buildingUpgraded: 1100,
  rentPaid: 1100, cardUsed: 1500, godAttached: 1800, bombExploded: 1700, sentToHospital: 1800,
  newsBroadcast: 3800, fateDrawn: 2600, lotteryDrawn: 4200, dateAdvanced: 500, stockPricesUpdated: 400, /* … */
};
export function batchBudgetMs(events: GameEvent[]): number;   // 服务器：deadline = now + budget + decisionTimeout
```

客户端 handler 在开发模式下测量实际耗时，超过预算 10% 就告警，保证服务器给出的时限可信。

### 4.5 事件到表现的映射（示例；事件名以引擎为准，映射表必须穷举）

| 事件 | 画布表现 | DOM | 音效 | 提交到 view |
|---|---|---|---|---|
| turnStarted | 镜头飞向该玩家，角色跳一下 | TurnBanner「轮到 孙小美」 | 叮 | currentSeat |
| diceRolled | 骰子落定（自己掷时点击即开始乐观旋转） | – | 骰子声（Kenney Casino） | lastDice |
| playerMoved | 逐格行走，镜头跟随，路过格高亮 | – | 脚步声（ZzFX） | 每格更新位置 |
| landBought | 插旗 + 色带铺开 | 飘字 -价格 | 盖章声 | 地块主人、现金 |
| buildingUpgraded / built | 升级动画（3.5） | 飘字 LV | 敲锤声 | 等级 |
| rentPaid | 金币从付款人飞向收款人（贝塞尔曲线，10 枚粒子） | 双方飘字 | 金币声 | 双方现金 |
| cardGained / itemGained | 卡片从格子飞入 HUD 背包 | 背包徽标 +1 | 刷卡声 | 背包 |
| cardUsed | 施放姿势 + 卡片放大翻面 + 光束连到目标 | CardCastPopup（1.2s） | 施法声 | 按效果 |
| itemPlaced | 物件落下并弹跳 | – | 叮 | 路面物件 |
| hazardTriggered / bombExploded | 爆炸、闪白、震屏、碎片 | – | 爆炸声 | 物件、建筑、状态 |
| godEncountered / godAttached / godLeft | 光柱降临 → 缩小附身 / 离开时飞走 | GodArrivePopup（台词） | 仙乐或衰音 | 附身神仙 |
| sentToHospital / sentToJail | 救护车或警车开来接走（沿路疾驰） | toast | 警笛（ZzFX） | 状态、位置 |
| released | 从建筑门口走出 | – | 开门声 | 状态 |
| newsBroadcast | 镜头轻推到新闻中心 | NewsPopup：主播 + 打字机标题 + 受影响玩家列表 | 新闻片头 + BGM 压低 | 按效果 |
| fateDrawn | 头顶问号翻转 | FatePopup 卡片翻面 | 翻牌声 | 按效果 |
| lotteryDrawn（每月） | – | LotteryDrawPopup 摇奖球滚动 | 摇奖声 | 奖池、现金 |
| stockPricesUpdated | – | 跑马灯刷新（红涨绿跌） | 无 | 行情 |
| magicHouseCast | 女巫挥杖，被选中的人头顶出现魔法阵 | MagicHouse 结果条 | 魔法声 | 按效果 |
| miniGameStarted / miniGameResult | 进入小游戏容器 / 奖励券飞入 | 结果面板 | 小游戏 BGM | 点券 |
| playerBankrupt | 角色哭泣、资产变灰、旗子拔除 | 大横幅 | 悲伤声 | 玩家 |
| gameOver | 烟花 | GameOverScreen 排名 + 资产构成 | 胜利 | – |

---

## 5. UI 布局（仿原版信息栏，致敬而非照抄）

### 5.1 桌面（宽 ≥ 1024，横屏）

```
┌───────────────────────────────────────────────────────────────────────────┐
│ [日历牌 1998年3月12日 星期四 · 第23回合] [股市跑马灯 ▲大宇 12.3 ▼…]   [🔊][⚙][≡] │ TopBar 48px
├──────────────────────────────────────────────────────────┬────────────────┤
│                                                          │ PlayerPanel    │
│                                                          │ 大头像(表情)    │
│                                                          │ 名字 + 玩家色    │
│                 Pixi 棋盘（全屏底层）                     │ 现金 48,800     │
│                                                          │ 存款 120,000    │
│                                                          │ 点券 350        │
│                                                          │ [财神 5天][🛵]  │
│                                                          │ 状态: 乌龟 2    │
│                                                          ├────────────────┤
│                                                          │ PlayerChips ×4 │
│ ┌ChatPanel(可折叠)─────┐                                 │ (轮次高亮/离线/托管)│
│ │[全部|观战] 消息… [😀]│                                 ├────────────────┤
│ └─────────────────────┘                                 │ MiniMap        │
│                                        [卡片][道具][股票][查看][托管] [🎲 掷骰] │ ActionPad
└──────────────────────────────────────────────────────────┴────────────────┘
```

- PlayerPanel 默认显示「当前行动者」；点击任一 chip 可切换查看其他玩家（`PlayerInfoPanel` 列出地产、卡片数、股票市值和总资产）。
- 骰子按钮显示当前骰子数（步行 1、机车 2、汽车 3）。不在我的回合或决策未就绪时置灰。
- 决策倒计时：对话框右上角圆环；最后 10 秒变红并每秒跳动一下（与中央倒计时同一个阈值 `COUNTDOWN_URGENT_S`，圆环本身不出声，提示音由下一条的中央倒计时负责）；超时后 toast「已由电脑代为决定」。圆环、原版侧栏「輪到你了 N 秒」、等待条的秒数都用 `useRemainingMs`：200ms 轮询让圆弧平滑，但每次都不越过下一个整秒边界（`msToNextSecond`），与中央倒计时在同一时刻换秒、同一档变红（等待条同样 10 秒变红）。
- 画面正中央的本人决策倒计时（`ui/common/DecisionCountdown` + `useDecisionCountdown`，两种皮肤各一个挂载点）：只在轮到本人、该决策有截止时间、连接在线时显示（观战者、别人的决策、托管中、小游戏、不限时与暂停中、断线重连中不显示）；剩余整秒大号描边数字，**始终在画面正中央、不避让**——这是用户看过上一版（等掷骰在中线偏上、决策框在中央时缩成小牌避让到上方）后要求先试的方案，有调整用户会再提。程序化布局在棋盘视口（右栏以外、顶栏以下、底栏——等待条 + 行动区——以上，与镜头的有效可视区同一块）的正中：右栏宽与 HUD 共用 `hud.module.css` 的 `.hudGeom`，上下缘用 `GameScreen` 给镜头算 insets 的同一组实测值（`hudBars`：顶栏、底栏的实际高度）——窗口宽 1024–1279 时带文字标签的行动区会折成两行、等待条出现时底栏也会变高，写死一行的高度会让数字比镜头中心低约 20px；整层 portal 到 `document.body`（z 45：对局页 `.game` 自成层叠上下文，留在里面盖不过挂在 body 上的 radix 模态面板——回合菜单的卡片 / 股票 / 公布栏子页；系统界面——系统菜单、设置、托管设置，`Modal layer="system"`，遮罩 46、面板 47——在它之上，数字不压系统界面，与原版皮肤一致；手机竖屏旋转提示时隐去），奶油色描深棕边，字号 `clamp(56px, 12vh, 108px)`（1280×800 为 96px、844×390 为 56px）；原版在 640×480 舞台正中 (320,240)，见 original-skin.md §4.2。等掷骰、决策对话框、回合菜单展开、原版铺满舞台的场所、手机横屏、日志 / 聊天停靠栏开着时位置与大小都一样（会压在对话框内容上，只是 `pointer-events: none`，点击照样落到下面）；「轮到你了」横幅显示期间照常显示，层级在横幅之上；最后 10 秒变红、每秒脉动并响一声 `countdown`（最后 3 秒 `countdownFinal` 双响），提交、到点或断线立即停；提示音去重键只看截止时间，同一截止时间下每个整秒最多一声（回合菜单里用卡、买股票后服务器换 decisionId 重发、截止时间没变时不重响），后台回来不补播；不接收指针、不抢焦点，`role="timer"`，只在进入最后 10 秒时经 aria-live 播报一次。
- 非我的决策：底部 `WaitingBanner`「等待 钱夫人 选择是否购买…（12s）」。观战者同样看到。

### 5.2 手机

- **竖屏**：顶部一排 4 个 PlayerChips（头像、现金简写如「4.8万」、轮次高亮）加菜单；中间是画布；底部 ActionBar `[卡片][道具][🎲][股票][更多]`。所有面板和决策改为 BottomSheet，占 70% 高度，按钮不小于 44px。聊天用悬浮按钮加 Sheet。
- **横屏手机**：右栏缩到 200px，信息改为折叠卡片。
- 使用 CSS 容器查询和 `dvh`，处理 `env(safe-area-inset-*)`。HUD 尺寸变化后调用 `camera.setInsets()`。竖屏时给出「建议横屏」的非强制提示（RotateHint）。
- 设置中提供左手模式，把 ActionBar 镜像到另一侧。

### 5.3 决策对话框（按 PendingDecision 类型分发）

```ts
// ui/decisions/registry.ts
export interface DecisionProps<K extends DecisionKind> {
  decision: PendingDecisionView<K>; isMine: boolean;
  submit(action: ActionFor<K>): void;   // 发出 intent 后立即锁定按钮，等 ack 或下一批事件
}
export const decisionRegistry = {
  preRoll: lazy(() => import('./PreRollActions')),       // 掷骰前：用卡、用道具、交易股票、掷骰
  buyLand: lazy(() => import('./BuyLandDialog')),        // 地价、现金、购买后过路费、同街加成
  upgrade: lazy(() => import('./UpgradeDialog')),        // 当前 → 下一级外观预览（生成器实时渲染）、费用、新过路费
  buildBigLot: lazy(() => import('./BigLotBuildDialog')),// 五选一：商场/旅馆/研究所/加油站/公园，含说明
  chooseDirection: lazy(() => import('./ForkChooser')),
  chooseTarget: lazy(() => import('./TargetPicker')),    // player | tile | building | none，候选由 options 给出
  bank: lazy(() => import('./BankDialog')),              // 路过或停留银行：存取款滑条，全存/全取
  stockTrade: lazy(() => import('./StockTradeDialog')),
  lottery: lazy(() => import('./LotteryDialog')),
  shop: lazy(() => import('./ShopDialog')),              // 百货/卡片屋：用点券买卖
  magicHouse: lazy(() => import('./MagicHouseDialog')),  // 女巫条件 + 命运选择
  auction: lazy(() => import('./AuctionDialog')),
  bail: lazy(() => import('./BailDialog')),              // 300 点券放出恶人等
  miniGamePick: lazy(() => import('./MiniGamePickDialog')),
  remoteDice: lazy(() => import('./RemoteDiceDialog')),
  // 引擎未来新增的 kind 先用 GenericChoice（按 options.choices 渲染按钮），保证不卡死
} satisfies { [K in DecisionKind]: LazyExoticComponent<ComponentType<DecisionProps<K>>> };
```

**目标选择流程**：在 InventoryPanel 点一张卡 → `uiStore.targeting = { cardInstanceId, spec }`，spec 取自 `preRoll.options.usable[i].target`，其中候选由引擎计算 → 棋盘高亮候选格或候选玩家，DOM 同时出现候选列表 → 点选 → 确认 → `submit({ type:'useCard', instanceId, target })`。

### 5.4 面板

- **InventoryPanel**：卡片和道具两个 Tab，网格显示 `CardTile`（卡框按类别配色，中间图标，下方名称，角标点券价）。当前阶段不可用的卡置灰，悬停显示原因（来自 options）。
- **StockPanel**：表格列出名称、现价、涨跌幅（红涨绿跌）、持股、成本、盈亏和 `Sparkline`（自写 SVG，最近 30 天）。买卖用 Stepper（按引擎规定的手数），显示总额和手续费。可交易时段由 options 给出。
- **BankPanel**：存款、利率、下次计息日，以及存取款滑条。
- **LotteryDialog**：号码网格，范围来自 `data.lottery`；已被购买的号码显示购买者头像；提供机选按钮；显示当前奖池。
- **NewsPopup**：电视框，左侧新闻主播（NPC rig），右侧打字机标题，下方列出受影响玩家的头像和变化值；最短展示时间过后可点击跳过。
- **MonthlyReport**（月初）：利息、股息、乐透开奖汇总。

### 5.5 大厅、房间、选角

- **HomeScreen**：昵称（存 localStorage）、创建房间、输入房间号加入、单机对战电脑、读取存档、设置、授权与制作人员。
- **CreateRoomForm**：地图、初始资金、胜利条件（破产淘汰、限时天数、资产目标）、决策时限（15/30/60s）、电脑补位与难度、是否允许观战、房间公开或私密。决策计时下方有一行小字「只有一名真人时不计时」（服务器按有效计时档位判定，net.md §5.4）；建房、房主改设置与大厅里的设置显示（两种皮肤）都有。此刻就适用时——大厅里当前座位只有一名真人（`lobby/settingsDraft` 的 `soloHumanNow`：房间档位不是 off 时看 `RoomView.effectiveTimerPreset`，是 off 时按座位上的真人数），或建房时电脑补满其余三个座位——且计时档位不是 off，文字换成「现在只有一名真人：开局后不计时」（`lobby:settings.timerHintActive`）并加深加粗（`data-active`）：文字本身不同，读屏与色弱用户不必靠颜色分辨。原版手机横屏开局设置的两列面板里这一行占满整行（`WIDE_FIELDS` 把它排在左列，不留空格），说明排在下拉框右边、字号 14 逻辑像素（844×390 时约 11 CSS 像素），在「：」处折行。
- **RoomScreen**：4 个座位的 `SeatGrid`。每个座位有 4 种状态：空（邀请或加电脑）、真人（头像、名字、准备✓、延迟 ms）、电脑（难度）、离线。`CharacterPicker` 是 12 个角色的轮播，选定角色会预览待机动画并用 voiceBabble 播一句招呼，被占用的角色置灰。选角光标（预览、名字显示的角色）与已提交给服务器的角色是两回事：开始 / 准备前若光标上的角色还没提交且没被别人选走，先提交它再开始 / 准备（`ui/lobby/characterPick.ts`，两种皮肤共用），提交失败就不开始 / 不准备——界面上看到的就是进局的角色；已准备的非房主玩家（开局由房主发起，不会替他提交光标）把光标移开已提交的角色就先取消准备，再按准备时提交新角色，「已准备 ⇒ 光标 = 进局的角色」始终成立；光标缺省停在已选角色或第一个没被选走的角色上；服务器只给没选角色的电脑座位、单机快速开局（不经过选角）与光标停在被选走角色上的座位随机分配。座位决定玩家颜色。房主可以踢人、调整电脑、开始游戏（全员准备后可用）。`InviteLink` 提供复制按钮和二维码（`qrcode`）。页面还包含观战者列表和房间聊天。

### 5.6 聊天、表情、观战

- 聊天分「全部」和「观战」两个频道，单条最多 100 字，前端限速每 2 秒 1 条（服务器同样校验）。提供 8 条快捷语（「快点啦～」「哈哈哈」「我要破产了」…）。
- 16 个表情（Fluent Emoji 精选），发出后在该玩家角色头顶以气泡弹跳 2 秒。聊天消息也在头顶显示气泡 3 秒。
- 观战栏显示观战人数、名单，以及「跟随：某玩家」切换。观战者没有操作按钮，HUD 右上角标「观战中」。

### 5.7 系统菜单

- **SaveLoadMenu**：联机只允许房主操作，列出服务器端存档槽（槽名、游戏日期、回合、玩家与总资产、真实时间）。单机模式用 IndexedDB（idb-keyval）保存，每回合自动存档一次，另有 3 个手动槽。
- **SettingsDialog**：音量（主、BGM、音效、语音四条滑条，外加静音）、动画速度（1x/2x/3x/仅关键）、镜头自动跟随、画质（高/中/低）、色弱模式（玩家形状标记加强）、语言、左手模式。设置存 localStorage（zustand persist）。
- **ReconnectOverlay**：断线 1 秒后出现半透明遮罩「连接中断，正在重连（第 n 次）…」，下方说明「你的角色已由电脑托管」。

---

## 6. 美术自制方案（低成本、风格统一、许可清晰）

### 6.1 风格指南（全员遵守）

- 所有形状统一 3px 深棕描边 `#3A2A1A`，采用平涂 + 1 个高光色阶 + 1 个阴影色阶（赛璐璐风格），光源在左上。
- 调色板限制在 32 色以内。Q 版比例约 1:1.1（头比身），大眼睛带白色高光，圆角造型。
- 玩家色（兼顾色弱）：P1 红 `#E8453C`●、P2 蓝 `#2F80ED`▲、P3 绿 `#27AE60`■、P4 黄 `#F2B705`★（黄色额外加深描边）。
- UI 皮肤 tokens（`tokens.css`）：

```css
:root{
  --c-sky:#5EC8F2; --c-sun:#FFD84D; --c-cream:#FFF6DC; --c-ink:#3A2A1A; --c-red:#F2545B;
  --c-green:#5CC85A; --c-blue:#3D8BFD; --c-purple:#9B6BFF; --c-orange:#FF9F43;
  --c-up:#E53935; --c-down:#2E9E4F;             /* 股市红涨绿跌 */
  --radius:14px; --border:3px solid var(--c-ink); --shadow-chunky:0 4px 0 var(--c-ink);
  --font-title:"ZCOOL KuaiLe", "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-num:"Fredoka", "ZCOOL KuaiLe", sans-serif;
  --font-body:"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif;
}
```

- 按钮做成胖圆角加厚底阴影，按下时 translateY(2px) 且阴影缩为 2px；面板用奶油底色加厚描边；标题用站酷快乐体；数字用 Fredoka。两者都是 OFL 协议，通过 `@fontsource/*` 按 unicode-range 分片加载。
- 画布里的中文 Text 在创建前先 `await document.fonts.load('32px "ZCOOL KuaiLe"', text)`，保证分片字形已经下载。飘字数字用 BitmapText，预装 `0-9+-,.万LV!` 这些字符。

### 6.2 角色：SVG 纸娃娃 rig（12 个角色 + NPC + 神仙 + 四大恶人共用）

```ts
// game/procedural/character/defs.ts
export interface CharacterConfig {
  id: CharacterId; nameKey: string; babble: { basePitch: number; wave: 'square' | 'triangle' | 'sine'; speed: number };
  skin: string; hair: { style: HairId; color: string }; eyes: EyeId; brows: BrowId; mouthSet: MouthSetId;
  outfit: { style: OutfitId; primary: string; secondary: string }; accessory?: AccessoryId; prop?: PropId;
}
// character/svg.ts
export type Pose = 'idle0' | 'idle1' | 'walk0' | 'walk1' | 'walk2' | 'walk3' | 'cheer' | 'sad' | 'hurt' | 'sleep' | 'cast';
export type Facing = 'front' | 'back';                    // front=SE，back=NE；另外两个方向靠镜像
export type Expression = 'normal' | 'happy' | 'sad' | 'angry' | 'shock';
export function characterSvg(c: CharacterConfig, pose: Pose, facing: Facing): string;   // viewBox 0 0 128 160
export function portraitSvg(c: CharacterConfig, expr: Expression): string;             // 256×256 胸像，HUD 用
// character/atlas.ts
export async function buildCharacterAtlas(cs: CharacterConfig[], scale: 1 | 2): Promise<Map<string, Texture>>;
// 在 2048² 画布上排布 12 角色 × 2 朝向 × 11 姿势，用 new Texture({ source, frame }) 切出子纹理
```

- **部件库**是手写的 SVG 片段函数：约 6 种头型、12 种发型、6 种眼睛、5 组嘴型、12 套服装、10 个配件或道具。所有角色共用骨架和描边规则，所以风格天然统一；换颜色就能出新角色或 NPC。
- **12 个角色原型（致敬，不复刻）**：老农伯、清纯少女、贵妇、忍者少年、牛仔、中东富商、武士、甜美女孩、猫耳少女、公主、小胖子少爷、富家少年。NPC 有新闻主播、女巫、银行员、医生、警察。神仙分大小两个版本（财、福、土地、天使、衰、穷、恶魔、死神），四大恶人（强盗、小偷、流氓、间谍）按数据表补齐。**名字和外观是否沿用原作，见开放问题 1。**
- HUD 头像直接把 `portraitSvg` 以内联 `<img src=data:>` 渲染，任何 DPI 下都清晰。表情随事件切换：收租时 happy，破产时 sad。
- 可选的第二阶段：`scripts/bake-atlas.ts` 在构建期用 `@resvg/resvg-js`（MPL-2.0，仅开发依赖）加 `free-tex-packer-core` 输出 PNG 图集，缩短首屏生成时间。

### 6.3 卡片、道具、图标

- 卡片框由 `cardFrame.ts` 输出 88×120 的 SVG，类别色：攻击红、防御蓝、经济金、移动绿、神仙紫、地产橙。中间图标优先组合 **Microsoft Fluent Emoji（MIT，Color SVG）**，例如 🐢乌龟、💣炸弹、🚧路障、😇天使、😈恶魔、🏠房屋、💰财富、🔄转向，缺的再自绘。
- UI 通用图标用 **Kenney Game Icons / Board Game Icons（CC0）**，包括骰子、棋子、卡牌、金币、设置、音量。
- 许可：Kenney 是 CC0，无需署名；Fluent Emoji 是 MIT，需在 Credits 页保留版权声明；game-icons.net 是 CC BY 3.0，只作备选，用了必须署名。DiceBear 的 CC0 头像风格（如 Lorelei、Notionists）只适合做大厅默认头像，不适合全身 Q 版，不作为角色主方案。
- 所有素材登记到 `assets/credits.json`：

```ts
interface CreditEntry { file: string; title: string; author: string; source: string; license: 'CC0-1.0'|'MIT'|'OFL-1.1'|'CC-BY-4.0'|'CC-BY-3.0'|'Pixabay'|'Sonniss-GDC'|'Original';
  licenseUrl?: string; modified: boolean; attribution?: string }
```

`scripts/check-credits.ts` 在 CI 中检查三件事：每个素材都有登记；许可证在白名单内；CC-BY 条目自动生成到游戏内「授权与制作人员」页。

### 6.4 AI 生成素材的注意事项

- 只用于**概念草图**，成品一律由人重绘为 SVG 部件。理由：美国版权局认为纯 AI 生成内容不受版权保护，别人可以随意复用；各工具的商用条款也不一样。
- 提示词中禁止出现「大富翁、Richman、原作角色名、大宇」等字样，避免生成侵权近似物；保留生成记录。
- 中国大陆发布时，如果对外展示 AI 生成的图片或音频，需要遵守《人工智能生成合成内容标识办法》（2025-09-01 起施行）做显式或隐式标识。全部重绘就没有这个问题。

---

## 7. 音频

### 7.1 选型结论

| 方案 | 现状（2026-09 核实） | 结论 |
|---|---|---|
| howler@2.2.4 | 2023-09 后未发版，维护者公告停在 2022 | 不用（仍是 MIT 且稳定，保留为 B 计划） |
| @pixi/sound@6.0.1 | 2024-07 后未发版，peer pixi.js ^8 | 不用 |
| tone@15 | 活跃，但偏合成器，太重 | 不用 |
| **自研 AudioEngine（Web Audio）** | 浏览器 API 稳定，代码约 300 行，便于控制和测试 | **选用** |
| **zzfx@1.3.2**（MIT，2025-09） | 用参数数组程序化生成音效，几乎零体积 | 选用，负责 UI 音、脚步、金币、警笛、爆炸底层 |

```ts
// audio/AudioEngine.ts
export type Bus = 'bgm' | 'sfx' | 'voice' | 'ui';
export class AudioEngine {
  readonly ctx: AudioContext;
  unlock(): Promise<void>;                              // 在首次 pointerdown/keydown 时 resume
  setVolume(bus: Bus | 'master', v: number): void;      // 0..1，线性转 dB 曲线
  setMuted(m: boolean): void;
  load(manifest: SfxManifest): Promise<void>;           // SFX：fetch + decodeAudioData 成 AudioBuffer
  play(id: SfxId, o?: { bus?: Bus; rate?: number; volume?: number; pan?: number }): void;  // 同一 id 限并发 4 个
  playZzfx(preset: ZzfxPresetId, o?: { rate?: number }): void;   // zzfxG 生成的 buffer 会缓存
  playBgm(track: BgmId, o?: { fadeMs?: number }): void;          // <audio>+MediaElementSource 流式，交叉淡入淡出
  duck(bus: 'bgm', db: number, ms: number): () => void;          // 新闻、乐透、语音播放时压低 BGM
  babble(char: CharacterId, text: string): void;                 // 每字一个音高抖动的短音（类似动森的角色"语音"）
  suspendWhenHidden(on: boolean): void;
}
```

- **BGM 走 `<audio>` 流式**：3 分钟立体声解码成 AudioBuffer 大约要 63MB，手机扛不住。MP3 循环有编码器补白造成的缝隙，因此 manifest 里记录 `loopStart/loopEnd`，或者选用本身循环段干净的曲子。
- **格式**：BGM 用 MP3 128kbps（全平台支持），SFX 用 MP3 或 OGG（`canPlayType` 选择）。每个 SFX 不超过 50KB，懒加载。
- **iOS**：必须由用户手势解锁，大厅的「点击开始」同时承担 `AudioUnlockGate`。支持时设置 `navigator.audioSession.type = 'playback'`，避免被静音键屏蔽；这个行为在设置里可以关掉。
- **角色语音**：不使用原版配音。第一版用 `voiceBabble`：按角色的 pitch、波形、语速合成咕哝音，配合头顶气泡文字。以后如需真人配音，另行录制并登记授权。
- 音量默认值：主 80、BGM 60、音效 80、语音 70。后台标签页默认静音（可设置）。

### 7.2 音源（均可商用；优先 CC0）

| 用途 | 来源 | 许可证 | 备注 |
|---|---|---|---|
| 骰子、筹码、卡牌 | Kenney **Casino Audio**（50 个） | CC0 | 无需署名 |
| UI 点击、确认、错误 | Kenney Interface Sounds / UI Audio | CC0 | |
| 敲锤、爆炸、撞击 | Kenney Impact Sounds + ZzFX | CC0 / 自生成 | |
| 过场短乐句（升级、破产、胜利） | Kenney Music Jingles | CC0 | |
| BGM（大厅、棋盘 2–3 首、小游戏、结算） | **OpenGameArt**，用 CC0 筛选（如 "CC0 Chiptunes"、"Happy Adventure (Loop)"） | CC0 | 逐首登记 |
| 补充 BGM | incompetech（Kevin MacLeod） | CC BY 4.0 | 必须在制作人员页署名；也可付费买免署名版 |
| 补充 BGM 或 SFX | Pixabay Music/SFX | Pixabay Content License | 可商用，禁止单独再分发；部分曲目有 Content ID 声明风险，次选 |
| 补充 SFX | Freesound（仅用 CC0 筛选） | CC0 | 避开 CC BY-NC |
| 大量高质量 SFX | Sonniss #GameAudioGDC Bundle | 免版税，无需署名 | 禁止单独再分发或用于 AI 训练；网页游戏的素材文件可被直接下载，是否算单独再分发存在灰区，所以放在次选 |

FreePD 已关站，不列入。

### 7.3 事件到音效

`presentation/soundMap.ts` 定义 `Record<GameEvent['type'], SfxSpec | null>`，与 handler 一样强制穷举。决策倒计时最后 10 秒每跨过一个整秒播一次界面音 `countdown`（ZzFX 方波「嘀」，走音效总线），最后 3 秒改为高音双响 `countdownFinal`（原版单机没有决策计时，素材包里没有语义对应的音效）。

---

## 8. 适配与性能

- 断点：`≥1280` 完整桌面，`1024–1279` 右栏 260px，`<1024` 或手机横屏用紧凑右栏，竖屏换布局（5.2）。
- 规模只有 60–120 个格子、4 个玩家，对象总数约 300–600，Pixi 的负载很轻。重点控制：ground 分块缓存；marks 层设 `isRenderGroup`；粒子数上限高画质 400、中 150、低 0；角色和建筑纹理进图集以减少纹理切换。
- 画质三档：

| 档 | 设备像素比上限 | fps | 抗锯齿 | 粒子 | 阴影/光晕 |
|---|---|---|---|---|---|
| 高 | 2 | 60 | 开 | 400 | 开 |
| 中 | 1.5 | 60 | 开 | 150 | 简化 |
| 低 | 1 | 30 | 关 | 0（只保留关键闪光） | 关 |

  首次启动时测 2 秒帧时间，自动选档。
- 包体预算：首屏 JS gzip 后 ≤ 450KB（React + Pixi + 大厅）；棋盘 chunk 懒加载；每个小游戏一个 chunk；BGM 流式；字体按分片加载。
- 内存 ≤ 300MB（移动端）。退出对局时 `destroy({ children: true, texture: true })` 并清空 textureCache。
- WebGL 上下文丢失时显示「图形重建中…」，由 `textureCache.rebuildAll()` 负责恢复（程序化纹理可以随时重新生成，这是它的优势）。

---

## 9. 小游戏运行容器

原版游乐园有 3 个 15 秒小游戏，以点券为奖励。致敬版命名为：**射气球**（balloonShoot）、**福神撒宝**（fortuneCatch，接金币元宝、躲炸弹）、**企鹅挖宝**（penguinDig，先记住宝石和炸弹的位置，再操控企鹅挖）。

### 9.1 规则（shared，确定性）

```ts
// packages/shared/src/minigames/types.ts
export interface MiniGameDef<P, S, I, R extends { coupons: number }> {
  id: MiniGameId; tickRate: 30; maxTicks: number;           // 15s → 450 tick（企鹅挖宝另加 3s 预览）
  virtualSize: { w: 960; h: 540 };                           // 虚拟坐标，整数
  init(seed: number, params: P): S;                          // 必须用 shared 的种子 PRNG，禁止 Math.random
  step(s: S, input: I | null): S;                            // 纯函数，推进 1 tick
  isOver(s: S): boolean;
  result(s: S): R;
  ai(s: S, rng: Rng): I | null;                              // 托管、电脑玩家、断线兜底
}
export type InputLog<I> = Array<[tick: number, input: I]>;
export function replay<P,S,I,R extends {coupons:number}>(def: MiniGameDef<P,S,I,R>, seed: number, params: P, log: InputLog<I>): R;
```

**跨引擎确定性铁律**：sim 内只能用整数或定点数（1/256 像素）运算，禁止 `Math.sin/cos/tan/exp/log/pow/random/hypot`。三角函数从 `fixed.ts` 查表，碰撞用整数距离平方。只有这样 V8（服务器和 Chrome）、JavaScriptCore（Safari）、SpiderMonkey（Firefox）重放出的分数才会逐位一致。

各游戏的输入与状态要点：
- `balloonShoot`：I = `{ shoot: [x, y] }`，冷却 6 tick。气球有普通、稀有、金色、炸弹球（扣分）四种，按种子生成上升路径。
- `fortuneCatch`：I = `{ targetX }`，篮子以最大速度趋近目标。掉落物有金币、元宝、宝箱、炸弹，接到炸弹立即结束。
- `penguinDig`：I = `{ moveTo: [cx, cy] } | { dig: true }`，网格 6×5，先有 90 tick 的预览期，挖到炸弹立即结束。

### 9.2 客户端容器

```ts
// apps/client/src/minigames/registry.ts
export interface MiniGameClientModule<P, S, I, R extends { coupons: number }> {
  def: MiniGameDef<P, S, I, R>;
  bundle?: string;                                          // Pixi Assets bundle（多数资源程序化生成，可为空）
  createView(ctx: { renderer: Renderer; t: TFunction; audio: AudioEngine; quality: Quality }): MiniGameView<S>;
  createInput(ctx: { canvas: HTMLCanvasElement; toVirtual(p: Pt): Pt }): MiniGameInput<I>;
  Hud: ComponentType<{ state: S; remainingMs: number; mode: 'play' | 'spectate' }>;  // DOM：计时、得分
  howTo: { titleKey: string; bodyKey: string; controls: { desktop: string; touch: string } };
}
export interface MiniGameView<S> { root: Container; render(prev: S, curr: S, alpha: number): void; destroy(): void }
export interface MiniGameInput<I> { poll(tick: number): I | null; destroy(): void }
export const miniGames: Record<MiniGameId, () => Promise<MiniGameClientModule<any, any, any, any>>> = {
  balloonShoot: () => import('./balloonShoot'), fortuneCatch: () => import('./fortuneCatch'), penguinDig: () => import('./penguinDig'),
};

// minigames/host/MiniGameHost.ts
export interface MiniGameSession { sessionId: string; gameId: MiniGameId; seed: number; params: unknown; seat: SeatId; startAt: number }
export class MiniGameHost {
  play(s: MiniGameSession, signal: AbortSignal): Promise<{ log: InputLog<unknown>; localResult: unknown }>;
  spectate(s: MiniGameSession, feed: AsyncIterable<InputLog<unknown>>, signal: AbortSignal): Promise<void>;
  close(): void;
}
```

**流程**：
1. 进入：棋盘 `world.visible=false`，镜头冻结，切换到小游戏 BGM；`minigameRoot` 按虚拟 960×540 等比缩放后居中（letterbox）；DOM 显示「玩法说明」3 秒倒计时。
2. 运行：`FixedStepLoop` 以 30Hz 累加器驱动，每个 tick 执行 `input.poll(tick)` → 写入 `InputRecorder` → `def.step`；渲染时在两个 tick 之间按 alpha 插值。
3. 上报：每 200ms 发一次 `mg.input`（增量帧），服务器转发给观战者；结束时发 `mg.submit { log, resultHash }`。
4. 结算：服务器用 `replay()` 验算后，发出权威的 `miniGameResult` 事件，客户端播放点券飞入 HUD 的动画。**客户端本地算出的分数只用于即时显示，与服务器不一致时以服务器为准。**
5. 观战：收到 `miniGameStarted` 事件时，其他玩家和观战者全屏观看，也可以缩到画中画；输入缓冲 300ms 后本地跑同一个 sim 重放。
6. 断线或超时：由服务器用 `def.ai` 跑完，客户端只播放结果。

---

## 10. 状态管理、网络客户端、i18n

### 10.1 Zustand stores

```ts
interface ConnectionStore { status: 'idle'|'connecting'|'open'|'reconnecting'|'closed'; attempt: number; rttMs: number; clockOffsetMs: number; resumeToken: string | null }
interface RoomStore { room: RoomView | null; me: { connId: string; seat: SeatId | null; role: 'player'|'spectator' } }
interface GameStore {
  mapId: string | null;
  view: ClientGameState | null;       // 显示态（HUD 读这个）
  latest: ClientGameState | null;     // 最新权威快照
  version: number;
  pending: PendingDecisionView | null;// 只在动画追上之后才设置
  anim: { playing: boolean; backlogMs: number };
  log: LogLine[];                     // 最近 200 条事件文字
  autoplay: Record<SeatId, boolean>; online: Record<SeatId, boolean>;
}
interface UiStore { panel: PanelId | null; targeting: TargetingState | null; followSeat: SeatId | null; popups: PopupItem[]; toasts: Toast[] }
interface SettingsStore { volume: Record<'master'|'bgm'|'sfx'|'voice', number>; muted: boolean; speed: Speed; quality: 'auto'|'high'|'mid'|'low';
  autoFollow: boolean; colorBlind: boolean; leftHanded: boolean; lang: 'zh-CN'; name: string }   // persist
interface ChatStore { messages: ChatMsg[]; unread: number }
```

Pixi 侧用 `subscribeWithSelector` 订阅，例如 `useGameStore.subscribe(s => s.view?.players, …)` 用来更新头顶状态。React 组件一律用细粒度 selector 配合 `useShallow`。

### 10.2 Transport 与消息

```ts
export interface Transport {
  connect(): Promise<void>;
  send(m: ClientMsg): void;
  onMessage(cb: (m: ServerMsg) => void): () => void;
  onStatus(cb: (s: ConnectionStore['status']) => void): () => void;
  close(): void;
}
// 客户端依赖的消息（协议由服务器领域定稿，v:1）
type ServerMsg =
  | { t: 'welcome'; connId: string; resumeToken: string; serverTime: number }
  | { t: 'room'; room: RoomView }
  | { t: 'sync'; reason: 'start'|'join'|'reconnect'|'resync'|'load'; mapId: string; version: number; state: ClientGameState; pending: PendingDecisionView | null }
  | { t: 'events'; batch: EventBatch }
  | { t: 'presence'; seat: SeatId; online: boolean; autoplay: boolean }
  | { t: 'chat'; msg: ChatMsg } | { t: 'emote'; seat: SeatId | null; from: string; emote: EmoteId }
  | { t: 'mg.frames'; sessionId: string; frames: InputLog<unknown> }
  | { t: 'ack'; intentId: string } | { t: 'nack'; intentId: string; code: string }
  | { t: 'saves'; list: SaveMeta[] } | { t: 'pong'; clientTime: number; serverTime: number } | { t: 'error'; code: string };
type ClientMsg =
  | { t: 'hello'; name: string; resumeToken?: string; lastVersion?: number }
  | { t: 'room.create'; settings: RoomSettings } | { t: 'room.join'; code: string; as: 'player'|'spectator' }
  | { t: 'room.seat'; seat: SeatId | null; character?: CharacterId } | { t: 'room.ready'; ready: boolean }
  | { t: 'room.ai'; seat: SeatId; level: AiLevel | null } | { t: 'room.start' } | { t: 'room.fromSave'; saveId: string }
  | { t: 'intent'; intentId: string; decisionId: string | null; action: PlayerAction }
  | { t: 'autoplay'; on: boolean } | { t: 'resync'; haveVersion: number }
  | { t: 'chat'; channel: 'all'|'spectators'; text: string } | { t: 'emote'; emote: EmoteId }
  | { t: 'mg.input'; sessionId: string; frames: InputLog<unknown> } | { t: 'mg.submit'; sessionId: string; log: InputLog<unknown>; resultHash: string }
  | { t: 'save'; slot: number; name: string } | { t: 'saves.list' } | { t: 'ping'; clientTime: number };
```

- `wsTransport` 的重连退避为 0.5/1/2/4/8s，上限 10s，加 ±20% 抖动。每 5s 发一次 ping 计算 RTT 和时钟偏移（取最近 5 次 RTT 最小的样本）。`resumeToken` 存 sessionStorage（按标签页），以免多开时互相顶掉。
- intent 带 `decisionId` 防止重复或过期提交。发出后按钮进入 pending 状态，收到 nack 时 toast 提示并解锁。
- 邀请链接格式为 `https://host/r/ABC123`（观战为 `?watch=1`）。

### 10.3 i18n

- 使用 `i18next@26` + `react-i18next@17`，第一版只有 `zh-CN`，目录结构为 `zh-TW`、`en` 预留。
- 引擎和数据只给 id，文案键由 id 派生：`cards.<id>.name`、`cards.<id>.desc`、`news.<id>.headline`（插值 `{{player}}`、`{{amount}}`）、`events.<type>`。
- `format.ts` 负责金额格式（`Intl.NumberFormat('zh-CN')`，飘字超过 1 万时简写为「4.8万」）和日期格式「1998年3月12日 星期四」。
- 测试会遍历 shared 数据表中的所有 id，断言 zh-CN 键齐全，防止漏译。

---

## 11. 关键时序

**A. 掷骰 → 行走 → 岔路 → 买地**
```
Client(P1)                     Server                          Clients(P2..P4, 观战)
 点[🎲] → dice.startSpin()（乐观）
 intent{rollDice}  ───────────▶ applyAction → events[diceRolled, playerMoved(path至岔路)]
                               pending{chooseDirection, deadline=now+budget+30s}
 ◀──────────── events batch ───┴──────────────────────────────▶ 同一批
 dice 落定 → walk(path) → 批尾对账 → 弹出 ForkChooser          播放相同动画 → WaitingBanner
 点箭头 → intent{chooseDirection}
                               events[playerMoved(剩余), landed] pending{buyLand}
 走完 → BuyLandDialog → intent{buyLand:true}
                               events[landBought, cashChanged] pending{preRoll(P2)}
 插旗、飘字、HUD 现金变化                                        轮到 P2：ActionPad 可用
```

**B. 断线重连**
```
ws close → status=reconnecting → 1s 后 ReconnectOverlay
服务器：宽限期结束后将该座位置为托管，广播 presence{autoplay:true}；AI 继续代打
重连 → hello{resumeToken,lastVersion} → sync{reason:'reconnect',state,pending}
客户端：EventPlayer.reset(state,pending) → board.sync → HUD → 关闭遮罩 → toast「已恢复连接」
         若 pending 是我的 → 直接弹出对话框（剩余时间按服务器 deadline 计算）
玩家可在 ActionPad 切换「托管」开关（intent autoplay:false）
```

**C. 观战中途加入**：`room.join(as:'spectator')` → `sync{reason:'join'}` → `reset` → 之后与普通客户端一样收 events。

**D. 小游戏**：`landed(游乐园)` → pending `miniGamePick`（或随机）→ intent → events `miniGameStarted{session}` → 当事人执行 `MiniGameHost.play`，其他人 `spectate(feed)` → `mg.submit` → 服务器 replay → events `miniGameResult{coupons}` → 所有人退出容器，播放点券飞入。

---

## 12. 测试方案

### 12.1 Vitest 5（`apps/client/vitest.config.ts`，三个 project）

1. **unit（node）**：
   - `iso/projection`：往返转换、深度排序对 8 邻域（含 2x2 footprint）正确，用参数化表驱动。
   - `EventPlayer`：使用假 `AnimClock` 和 mock handler，验证串行顺序、提交时机、倍速、`skipAll` 能中止并直达快照、断档时发出 resync、backlog 自动加速或跳过、pending 必须在动画播完后才出现、后台模式只提交不播放。
   - `viewReducer` 一致性（**跨包关键测试**）：用 shared 引擎加 AI 自对弈，20 个种子 × 300 回合，每批都断言 `fold(applyEventToView, prevState, events)` 与 `batch.state` 的可见字段深度相等。它保证事件确实携带了足够的后置值。
   - `timing`：handler 实测时长 ≤ 预算（加速时钟下）。
   - 小游戏：sim 确定性（同种子、同输入得到同结果哈希），AI 能在 maxTicks 内结束，`replay(log)` 与在线逐帧推进结果一致。
   - `format`、`i18n` 键完整性，`credits.json` 校验。
2. **dom（jsdom + @testing-library/react + user-event + jest-dom）**：
   - 每个 Decision 组件：根据 options 渲染价格和候选，点击后 `submit` 的 action 正确，重复点击无效，倒计时到 0 后 UI 锁定。
   - HUD：view 变化后数字更新；GodBadge 天数；轮次高亮；托管和离线徽标。
   - InventoryPanel 置灰逻辑、StockPanel 买卖金额、LotteryDialog 机选和已占用号码、ChatPanel 限长限速、SettingsDialog 持久化（localStorage mock）。
   - Pixi 不在 jsdom 挂载：`BoardCanvas` 通过服务容器注入 `FakeRenderer`。
3. **browser（@vitest/browser-playwright，Chromium）**：
   - 真实 WebGL 下 `GameRenderer` 冒烟测试（加载地图并 sync 一个快照，无报错，对象数符合预期）。
   - 程序化生成器：建筑各等级和角色各姿势画进 Gallery 画布后 `toMatchScreenshot`（pixelmatch，允许 0.5% 差异）。
   - 在浏览器中运行小游戏 sim 重放，结果哈希与 node 下的快照一致，从而验证跨引擎确定性。CI 另外补跑 WebKit 和 Firefox 两个 project。

### 12.2 Playwright E2E（`e2e/`，@playwright/test 1.63）

- `webServer` 启动两个进程：服务器（`RICH4_TEST_MODE=1`，开放 `debug.*` intent：强制骰子、改现金、传送、设种子、决策时限 2s、小游戏输入注入）和客户端 `vite preview`。客户端 URL 参数 `?anim=instant&audio=off` 可选。
- `fixtures/room.ts`：`fourPlayers` fixture 用 `browser.newContext()` 创建 4 个互相隔离的上下文，P1 建房（seed=42），P2–P4 打开邀请链接，各自选角色并准备，P1 开始游戏。另有 `spectator` fixture。
- 测试模式下暴露 `window.__rich4 = { store, eventPlayer: { idle }, board: { tileScreenPos(id) } }`，用于等待动画空闲和断言。**点击一律走 DOM 备用按钮**，不点画布坐标。
- 用例：
  1. `lobby`：建房、加入、角色互斥、准备、开始；满员后第 5 人自动成为观战者；房主踢人。
  2. `turn-cycle`：强制骰子，完成买地、升级、付租；**断言 4 个页面的 HUD 现金、存款、点券和地块归属完全一致**（读取 `data-testid`），且等于服务器快照。
  3. `timeout-ai`：P2 不操作，2 秒后 toast「已由电脑代为决定」，游戏继续。
  4. `reconnect`：P3 在自己回合 `context.setOffline(true)`；其他人看到托管徽标；8 秒后恢复网络，P3 页面无残留对话框、数值与他人一致、托管结束。另测刷新页面后用 resumeToken 恢复座位。
  5. `chat-spectate`：聊天和表情传播到全部 5 个上下文，头顶气泡出现，观战频道隔离，观战者没有操作按钮。
  6. `minigame`：强制落在游乐园，注入脚本输入，服务器验算的点券与客户端显示一致；其他人进入观战重放。
  7. `save-load`：第 10 回合存档，全员离开，房主从存档开房，其他人重新入座；比较状态哈希一致。
  8. `solo-soak`：单机加 3 个电脑，以 instant 速度跑 100 回合，没有控制台错误和未处理的 Promise 拒绝，内存增长小于 50MB。
  9. `mobile-layout`：`devices['iPhone 15']` 竖屏和横屏各一遍，检查主要按钮可见且可点、BottomSheet 可开关、捏合缩放不触发页面缩放。
  10. `visual`：`/dev/gallery` 和固定种子棋盘的 `toHaveScreenshot`，在官方 Docker 镜像 `mcr.microsoft.com/playwright:v1.63.0-noble` 中执行，保证像素稳定。
- 性能冒烟：`?bench=1` 自动对局 60 秒，用 rAF 采样帧时间；CI 桌面环境断言 p95 < 20ms（软阈值，只告警）。

---

## 13. 对其他领域的接口要求（本设计的前提）

1. **引擎**：会改变可见状态的事件要携带后置绝对值；`PendingDecisionView.options` 要带全渲染所需的数字和合法候选，客户端不重复实现规则；`GameEvent` 必须是带 `type` 字段的可辨识联合类型。
2. **引擎/数据**：提供 `MapDef` 的网格坐标、邻接关系和矩形 footprint（3.1），以及 `validateMap()`。
3. **服务器**：批次包含 `fromVersion/toVersion/state/pending`；`deadline` 使用 `shared/presentation/timing.batchBudgetMs`；支持 `resync`；转发 `mg.input`，并用 `replay()` 验算小游戏；按观察者脱敏快照。
4. **服务器/共享**：单机离线模式（`localTransport` 在 Worker 中运行）要求把房间和回合编排核心（计时器用注入的 scheduler、AI 代决）做成不含 IO 的模块，放在 shared（如 `shared/session`）。否则单机模式只能连本地或公网服务器。
5. **shared** 需要导出客户端显示用的纯 selector：`calcToll`、`netWorth`、`streetBonus` 等。

---

## 14. 依赖与版本（2026-09-26 npm registry 实测）

运行时依赖：react / react-dom 19.3.0，pixi.js 8.21.0（2026-09-25），zustand 5.0.15（2026-08），radix-ui 1.6.7（2026-07），motion 13.4.4（2026-09），i18next 26.4.2 / react-i18next 17.0.15（2026-09），wouter 3.11.0（2026-09），clsx 2.1.1，zzfx 1.3.2（2025-09），idb-keyval 6.3.0（2026-07），qrcode 1.5.4（2025-11），@fontsource/zcool-kuaile 5.3.0，@fontsource/fredoka 5.3.0（2026-07，OFL）。

开发依赖：vite 8.3.1，@vitejs/plugin-react 6.1.1，vitest 5.0.2，@vitest/browser-playwright 5.0.2，@vitest/coverage-v8 5.0.2，@testing-library/react 16.3.3，@testing-library/user-event 14.6.7，@testing-library/jest-dom 7.0.1，jsdom 30.1.1，@playwright/test 1.63.0，fake-indexeddb 6.2.5；可选的 @resvg/resvg-js 2.6.2 和 free-tex-packer-core 0.3.9。

明确不用：@pixi/react（棋盘场景不适合）、pixi-viewport（2024-11 后未更新）、@pixi/sound（2024-07 后未更新）、howler（2023-09 后未更新）、@pixi/particle-emitter（不支持 v8）、phaser 4.2.1（理由见 1.1）。

---

## 15. 实施里程碑（前端）

- **F0 骨架（1 周）**：Vite、路由、stores、`Transport`（ws 实现 + 用于组件测试的 mock）、tokens 与基础组件、大厅和房间 UI。
- **F1 棋盘（2 周）**：投影与深度、GroundLayer 与 RoadPainter、建筑生成器、角色 rig 与图集、Camera 与手势、`/dev/gallery` 和 `/dev/map`、`BoardView.sync`。
- **F2 主循环（2 周）**：EventPlayer、viewReducer、timing、核心 handler（回合、骰子、移动、地产、金钱）、HUD、buyLand/upgrade/fork 对话框、一致性测试。
- **F3 卡片、道具、神仙、危险物、医院监狱（2 周）**：FxSystem、TargetPicker、InventoryPanel。
- **F4 经济与事件（1.5 周）**：银行、股市、乐透、新闻、命运、魔法屋、百货的面板和弹窗。
- **F5 小游戏（2 周）**：Host 加 3 个游戏，包括观战重放和确定性测试。
- **F6 社交与系统（1 周）**：聊天、表情、观战、重连遮罩、存读档、设置、完整音频。
- **F7 打磨（持续）**：移动端、画质档、视觉回归、完整 E2E 套件、Credits 页。

---

## 16. 关键文件（实现优先级）

- <repo>/apps/client/src/presentation/EventPlayer.ts
- <repo>/apps/client/src/game/board/BoardView.ts
- <repo>/apps/client/src/game/iso/projection.ts（加 depth.ts）
- <repo>/apps/client/src/game/procedural/building/generate.ts 与 character/svg.ts
- <repo>/packages/shared/src/presentation/timing.ts 与 packages/shared/src/minigames/types.ts
- <repo>/apps/client/src/ui/decisions/registry.ts
- <repo>/e2e/fixtures/room.ts

## 17. 调研来源

- PixiJS 版本与新特性：https://github.com/pixijs/pixijs/releases，https://pixijs.com/blog/june-2026，https://pixijs.com/blog/8.16.0
- @pixi/react v8（仅 React 19）：https://pixijs.com/blog/pixi-react-v8-live
- Phaser 4 发布：https://phaser.io/news/2026/05/phaser-3-vs-phaser-4，https://gamefromscratch.com/phaser-4-released/
- Howler 维护状态：https://github.com/goldfire/howler.js/discussions/1594
- pixi-viewport：https://github.com/pixijs-userland/pixi-viewport/releases；@pixi/sound：https://github.com/pixijs/sound/releases
- Pixi v8 ParticleContainer 与 cacheAsTexture：https://pixijs.com/8.x/guides/components/scene-objects/particle-container，https://pixijs.com/8.x/guides/components/scene-objects/container/cache-as-texture
- Kenney CC0：https://kenney.nl/support，https://kenney.nl/assets/casino-audio，https://kenney.nl/assets/board-game-icons
- DiceBear 各风格许可：https://www.dicebear.com/licenses/
- Fluent Emoji（MIT）：https://github.com/microsoft/fluentui-emoji
- Pixabay 许可：https://pixabay.com/service/license-summary/；incompetech：https://incompetech.com/music/royalty-free/licenses/；Sonniss GDC：https://sonniss.com/gdc-bundle-license/；OpenGameArt CC0：https://opengameart.org/content/cc0-chiptunes
- Vitest 视觉回归：https://main.vitest.dev/guide/browser/visual-regression-testing
- 原作玩法参考（小游戏、大块地建筑、特殊地点）：https://www.163.com/dy/article/HHK7NHS30546O9E5.html，https://www.163.com/dy/article/GQB1C7G70546O9E5.html，https://www.163.com/dy/article/HJ95G6PE0546O9E5.html，https://zh.wikipedia.org/zh-hans/大富翁4


## key_decisions
- PixiJS v8 以命令式写法绘制棋盘、特效和小游戏；React 19 DOM 负责全部 HUD、对话框和大厅；棋盘不用 @pixi/react — Pixi 8.21 活跃维护、可按模块裁剪、有 WebGL/WebGPU/Canvas 回退。棋盘由 async 动画队列驱动，命令式最直接。DOM 在中文排版、输入法、无障碍、i18n 和测试上占优。Phaser 4 太重，自带主循环会和 React 形成两套世界。纯 Canvas 开发成本过高。
- 区分显示态 view 与权威态 latest：每个事件 handler 播完后提交 applyEventToView，每批结束时用快照对账 — HUD 数字与动画节奏同步，避免剧透。批尾对账保证最终与服务器一致。观战、重连、后台切回可以直接 reset 到快照，不需要补播动画。
- 事件必须携带后置绝对值，pendingDecision.options 必须带全渲染所需的数据和合法候选 — 客户端不重复实现规则，viewReducer 只做字段写入。再用引擎自对弈的一致性测试兜底，防止事件与快照漂移。
- 在 shared 中放共享动画时长预算 batchBudgetMs；服务器 deadline = 当前时间 + 动画预算 + 决策时限 — 服务器不必等客户端确认动画播完，玩家也不会因动画慢而损失思考时间；客户端各自选 1x/2x/3x 倍速不影响公平性。
- handler 注册表和音效映射用 satisfies 对 GameEvent['type'] 做穷举；决策组件注册表同样穷举 DecisionKind — 引擎新增事件或决策类型时前端会编译失败，不会出现静默漏播或流程卡死；未知的决策类型用 GenericChoice 兜底。
- 镜头和补间自己写（Camera、AnimClock、tween，支持 AbortSignal），不用 pixi-viewport 或 GSAP — 需求简单，但必须支持倍速、一键跳过和测试中的假时钟。pixi-viewport 2024-11 后没有更新，GSAP 不是 OSI 开源许可。
- 美术全部程序化：角色用 SVG 纸娃娃 rig（12 个角色、NPC、神仙共用骨架和描边规则），建筑用 Pixi Graphics 等角挤出生成器按等级变高，运行时栅格化进图集 — 成本低、风格天然统一、换色就能出变体；上下文丢失后可以重新生成；不使用任何原版素材，许可清晰。
- 图标用 Kenney（CC0）加 Fluent Emoji（MIT）；音源优先 CC0（Kenney、OpenGameArt、Freesound 的 CC0 筛选）；所有素材登记 credits.json 并由 CI 校验 — 许可链可审计；CC-BY 素材自动生成署名页；避开 NC 协议和不明来源的素材。
- 自研 Web Audio 薄封装 AudioEngine：BGM 用 <audio> 加 MediaElementSource 流式播放，SFX 用 AudioBuffer，程序音效用 ZzFX；不依赖 Howler 或 @pixi/sound — Howler 自 2023-09 后停更，@pixi/sound 自 2024-07 后停更。BGM 若整段解码，一首 3 分钟立体声约 63MB，手机不可接受。自研封装可以精确控制分轨混音、压低 BGM 和 iOS 解锁。
- 小游戏规则在 shared 中写成确定性定步长 sim，只用整数或定点数，禁止 Math 超越函数；客户端只提供 View 和 Input 适配器；输入日志上传后由服务器重放验分，观战者用转发的输入帧同步重放 — 同时满足服务器权威（防刷点券）、观战直播、断线后由 AI 代玩三项需求。整数运算保证 V8、JavaScriptCore、SpiderMonkey 重放结果逐位一致。
- 所有画布内决策（选岔路、选目标格或目标玩家）都同时提供 DOM 备用控件 — 服务无障碍和手机上点不准的情况；Playwright E2E 可以稳定点击，不依赖画布坐标。
- 测试分层：Vitest 5 分为 node 单元、jsdom 组件、浏览器模式（Pixi 冒烟和 toMatchScreenshot）三个 project；Playwright 开 4 个 BrowserContext 加 1 个观战，在服务器测试模式下跑联机全流程 — 规则一致性、UI 交互、真实渲染、多人联机与断线重连分别有对应的测试层，并能在 CI 的 Docker 中稳定复现。

## dependencies
- react@19 (19.3.0) — DOM UI
- react-dom@19 (19.3.0) — DOM UI
- pixi.js@8 (8.21.0, 2026-09-25) — 等角棋盘、特效、小游戏渲染
- zustand@5 (5.0.15, 2026-08) — 客户端状态（含 persist、subscribeWithSelector）
- radix-ui@1 (1.6.7, 2026-07) — Dialog/Tabs/Slider/Tooltip/Popover 等无障碍基础组件
- motion@13 (13.4.4, 2026-09, MIT) — DOM 面板、弹窗、卡片翻转动画
- i18next@26 (26.4.2) — i18n 核心
- react-i18next@17 (17.0.15) — React i18n 绑定
- wouter@3 (3.11.0, Unlicense) — 轻量路由（/、/r/:code、/solo、/dev/*）
- clsx@2 — className 组合
- zzfx@1 (1.3.2, MIT) — 程序化复古音效（UI、脚步、金币、警笛、爆炸）
- idb-keyval@6 (6.3.0) — 单机本地存档与缓存（IndexedDB）
- qrcode@1 (1.5.4) — 邀请二维码
- @fontsource/zcool-kuaile@5 (OFL) — 标题卡通中文字体，按 unicode-range 分片
- @fontsource/fredoka@5 (OFL) — 数字与英文字体
- vite@8 (8.3.1, dev) — 构建与开发服务器
- @vitejs/plugin-react@6 (6.1.1, dev) — React 插件
- vitest@5 (5.0.2, dev) — 单元与组件测试
- @vitest/browser-playwright@5 (dev) — Vitest 浏览器模式（Pixi 冒烟、toMatchScreenshot）
- @vitest/coverage-v8@5 (dev) — 覆盖率
- @testing-library/react@16 (16.3.3, dev) — 组件测试
- @testing-library/user-event@14 (dev) — 交互模拟
- @testing-library/jest-dom@7 (dev) — DOM 断言
- jsdom@30 (dev) — 组件测试环境
- @playwright/test@1 (1.63.0, dev) — 4 个上下文的联机 E2E 与视觉回归
- fake-indexeddb@6 (dev) — 存档组件测试
- @resvg/resvg-js@2 (可选 dev, MPL-2.0) — 第二阶段构建期把 SVG 角色烘焙成 PNG
- free-tex-packer-core@0 (可选 dev, MIT) — 第二阶段构建期图集打包

## risks
- 知识产权：「大富翁」商标以及孙小美、阿土伯等角色名和形象属于大宇资讯。即使不用原版素材，照搬角色名或外观、在产品名里用「大富翁4」仍有侵权风险。建议对外发布前改用原创角色名和明显不同的造型，数据驱动的 nameKey 让改名成本很低。
- 小游戏跨引擎确定性：只要 sim 中出现 Math.sin/cos/pow/random 或依赖浮点累积，服务器（V8）重放的分数就可能与 Safari（JavaScriptCore）或 Firefox 不一致，导致误判作弊。必须强制整数或定点数加查表，并在 Chromium、WebKit、Firefox 三端跑重放一致性测试。
- 事件与快照漂移：如果引擎事件缺少后置值，或者 viewReducer 与引擎语义不一致，批尾对账会出现数字跳变。依赖引擎自对弈的一致性测试长期守护，也需要引擎团队配合事件字段设计。
- 动画时长预算偏差：handler 实际时长超过 shared 预算时，玩家的决策时间会被压缩。需要开发期测量告警，并在 CI 中测试加速时钟下的时长。
- 程序化美术质量：程序员绘制的 SVG rig 可能显得粗糙，影响「明快卡通」的观感。需要预留专门的美术打磨迭代，必要时外包部件绘制，rig 架构可以保持不变。
- 中文字体分片加载：Pixi Text 在字形分片尚未下载时会用回退字体渲染，并被缓存成纹理。必须先 document.fonts.load(font, text) 再创建文本；动态文本（玩家昵称、聊天）要额外处理。
- 音频平台差异：iOS 需要手势解锁，静音键会屏蔽 Web Audio；MP3 循环有补白缝隙；后台标签页会暂停 AudioContext。自研 AudioEngine 需要在真机矩阵上测试，Howler 2.2.4 作为 B 计划。
- WebGL 上下文丢失（移动端切后台、显存紧张）：程序化生成的 RenderTexture 会失效。必须实现 textureCache.rebuildAll 并测试恢复路径。
- 后台标签页的 rAF 节流导致动画队列停滞、积压：依赖 visibilitychange 切换到 instant 模式；部分浏览器的 bfcache 或冻结标签页还需要配合重连逻辑。
- 新大版本工具链：Vite 8（Rolldown）、Vitest 5、TypeScript 7（原生编译器）、ESLint 10 发布时间都不长，部分插件（如 typescript-eslint）可能暂未兼容。需要锁定精确版本，必要时 TypeScript 降到 6.x。
- 素材许可灰区：Pixabay 禁止单独再分发，Sonniss GDC 禁止再分发，而网页游戏的素材文件可被用户直接下载，可能被认定为再分发。因此优先 CC0，仅在必要时使用这两个来源并记录。
- AIGC 合规：如果使用 AI 生成的图片或音频直接对外发布，在中国大陆需按《人工智能生成合成内容标识办法》标识，而且 AI 输出可能不受版权保护。建议只用于概念草图。
- 等角深度排序只在「矩形 footprint、角色只走相邻路格」的前提下正确。地图数据如果出现 L 形地块或对角路格，会出现遮挡错误，需要 validateMap 强制约束。

## open_questions
- 角色名与造型：沿用原作的 12 个角色名（孙小美、阿土伯、钱夫人等）作为致敬，还是改为原创名字、只保留性格原型？这影响对外发布的法律风险。
- 首发地图具体用原版哪一张？能否拿到或手工整理出网格坐标版的格子布局（渲染需要每格的 x,y 和邻接关系）？
- 对手的卡片和道具是否公开可见（原版可用「查看」功能）？这决定服务器快照是否需要脱敏，以及 PlayerInfoPanel 显示多少信息。
- 单机对战电脑是否要求完全离线（在浏览器 Worker 中运行引擎和回合编排）？如果要，服务器领域需要把 GameSession 编排核心做成不含 IO 的 shared 模块。
- 小游戏的防作弊强度：接受「服务器重放输入日志验分」的方案吗？还是简化为信任客户端上报（实现更简单，但可以刷点券）？
- 角色语音：第一版用程序化咕哝音（babble）加气泡文字是否可以接受？将来是否计划真人配音或商用 TTS？
- 移动端优先级：是否需要完整支持手机竖屏对局，还是以横屏为主、竖屏只保证可玩？
- 动画速度是否允许房主设置上限（例如比赛模式强制 2x），还是完全由各客户端自选？
- 除 zh-CN 外，首发是否需要繁体中文（zh-TW）或英文？这会影响字体分片策略和文案工作量。
- 是否需要对局回放（利用服务器事件日志重播整局）？目前的架构可以支持，但不在首发范围内。