# 「原版皮肤」方案审查报告（只读审查）

**结论**：方案的大方向是对的。用原版世界坐标加仿射投影、不转换到现有等角网格、复用 BoardPort/StagePort 两个接缝、素材包不入库也不进镜像，这些选择都有证据支撑。但有 **10 项必须修正**：演出预算取错了口径、MVP 缺少舞台实现、访问控制的回环例外可以被绕过、CI 里原版棋盘根本跑不起来、工作量明显低估，等等。按现在的方案开工，会在集成阶段返工。

本次审查只读了代码和调研证据，没有写入任何文件。

---

## 一、必须修正

### 1. FLIC 时长适配用错了预算口径（§3.5 整张表）

**问题**：方案拿「事件总预算」（例如 GOD_ATTACHED 1500、CONFINED 1500）当 FLIC 的可用时长。但 handler 是在事件预算里同时编排镜头聚焦、弹窗和舞台调用的。真正留给舞台方法的时长，是 `apps/client/src/game/fx/timings.ts` 里的 FX_* 常数，`handlers/budget.test.ts` 也是按这些常数判定是否超预算。

**证据**
- `handlers/gods.ts:62`：`Promise.all([showPopup(..., GOD_POPUP_MS), stage.godArrive(...)])` 之后还要 `wait(100)`。
- `handlers/status.ts:23-25`：先 `focus(250)`，再 `escort`。
- `handlers/items.ts:99-118`：`focus(300/400)` 加 `explode`/`strike`，再加 `wait(400/150)`。

**按实际可用时长重算后的压缩倍数**

| 演出 | 原长 | 实际可用 | 需压缩 |
|---|---|---|---|
| 神明降临 | 1.2–3.5 s | FX_GOD_ARRIVE_MS=900 | 1.3–3.9× |
| 救护车 483 | 6.2 s | FX_ESCORT_MS=1050 | **5.9×** |
| 警车 497 | 2.49 s | 1050 | 2.4× |
| 大爆炸 486 | 2.9 s | FX_EXPLODE_MS=720 | 4× |
| 飞弹 490 | 4.1 s | FX_MISSILE_MS=1340 | 3.1× |
| 神明离身 485 | 0.9 s | FX_GOD_LEAVE_MS=620 | 1.45× |

**影响**：标准节奏下，大部分 FLIC 会被截得只剩片段，原味损失比方案描述的大得多。「原版节奏」这个用户决策的分量也因此变重。

**修正**
- `playFit` 的预算按「事件预算减去 handler 里其他 await 的时长」逐个 handler 推算。
- budget.test 增加 OrigStage 的时长常量。
- 用户决策第 5 条要按上表的真实倍数重新向用户说明。

### 2. MVP（A0–A7 + A9）不含 OrigStage，而现有 BoardStage 无法委托

**问题**：MVP 里没有舞台实现，路障、地雷、定时炸弹、路上神明、乞丐、四大恶人、关押外观都会画不出来，对局实际上没法玩。方案说「无原版对应的方法委托程序化 fx」，但 `BoardStage` 与程序化棋盘深度耦合，不能直接委托。

**证据**：`BoardStage.ts` 大量直接访问 `board.roads.*`、`board.geometry.tileCell/viewCell`、`depthOfCell`、`landmarkScreenPos`、`roads.figures`，位置在第 131、146–153、182、241、276、395、409、507、548、731、748 行。能委托的只有 `FxSystem` 这一层（它接收屏幕点）。

**修正**
- MVP 必须加入「A8-lite」：`OrigStage.syncWorld` 负责静态物件、神明、恶人和关押外观，其余 33 个方法先给固定时长的简化实现。约 +3–4 人日。
- 方案里的「委托」改为「委托给 FxSystem 原语」。

### 3. 访问控制的「回环例外」可以被绕过（§5.1 启动守卫）

**问题**：守卫规则是「HOST 为 127.0.0.1 或 ::1 时允许 `ACCESS_MODE=off`」。但给朋友开服最常见的做法，恰恰是后端监听回环地址，再由同机的 Caddy/nginx、cloudflared、frp、Tailscale Funnel 反代到公网。这时守卫放行，素材包完全公开。

**修正**
- 取消按 HOST 判定的自动例外。
- 改为显式开关：只在 `NODE_ENV!==production`、PUBLIC_URL 为 localhost、`TRUST_PROXY=0` 三者同时成立，并且设置了 `RICH4_ASSETS_ALLOW_UNGATED=1` 时才放行。
- 启动日志要高亮提示当前处于未设门禁状态。

### 4. 没有素材包时，`/pack/manifest.json` 会返回 200 的 index.html

**问题**：方案的皮肤判定表假设「没有素材包时 manifest 返回 404，于是回退程序化」，但这个 404 永远不会出现。`apps/server/src/http/static.ts:62-64` 的 notFoundHandler 对所有不以 `/api/`、`/socket.io` 开头的 GET 请求都返回 SPA 页面。Vite 开发服务器也有同样的 SPA 回退。

**修正**
- 服务器无论是否配置素材包，都注册 `/pack/*`；未启用时返回 404 JSON。
- `/pack/` 加入 SPA 回退的排除前缀。
- PackClient 把「非 JSON」或「zod 校验失败」一律当作 procedural。

### 5. 忽略规则的落地顺序反了，默认输出目录也有风险

**问题**：A2 会在仓库根目录生成 `rich4-assets/`，但 `.gitignore` 和 `.dockerignore` 的更新排在后面的 A4。现有 `.gitignore` 和 `.dockerignore` 里都没有 `rich4-assets`，而另一个工作流正在并行提交。

**修正**
- 忽略规则和 check-no-original 的路径规则移到 A0。
- `--out` 的默认值改为 `.cache/rich4-assets/`（本来就被忽略）或仓库外目录。
- extract 拒绝输出到 `apps/*/public/**`：Vite 会把 public 目录原样拷进 dist，进而进入镜像。
- 更一般地，extract 拒绝输出到任何「未被 git 忽略」的路径。

### 6. CI 实际上完全覆盖不到原版棋盘

**问题**：方案 §3.1 写「fixture 地图没有 GND，永远走程序化棋盘」，而 CI 里只有 fixture 地图。结果 `skin-original.spec.ts` 只测到 UI 和音频，OrigRenderer、OrigActor、OrigStage 在 CI 中零覆盖。

另外，现有 E2E 直接读取程序化渲染器的内部结构：
- `e2e/specs/anim-unmount.spec.ts:52`：`__rich4.renderer.board.allActors()`
- `chat-spectate.spec.ts:64`：`board.actor(1)`
- `cards.spec.ts`：统计路面物件和关押外观

**修正**
- 合成素材包必须为 fixture 地图提供合成 GND 和 skin.json。fixture 的 world 坐标是 cell×32，可以直接生成棋盘格底图，skin.json 绑定 fixture 的地图身份。
- OrigRenderer 要实现同形的测试钩子（`board.allActors/actor/roads` 计数）。

### 7. 接缝清单不完整，BoardSurface 的定义不够

方案 §3.1 只列了 5 个接缝。实际还有以下几处：

**GameScreen 直接访问渲染器内部**（`ui/screens/GameScreen.tsx:114-153`）
- 用到 `ctrl.renderer.camera.panTo/screenToWorld/onUserGesture`、`ctrl.renderer.app.screen`、`ctrl.renderer.rotation`、`ctrl.renderer.rotate(d)`、`ctrl.anchorPos`。

**旋转类型只支持 4 向**
- `Rotation` 类型是 0..3（`iso/projection.ts`），并通过 `MiniMap` 的 props 传递（`hud/MiniMap.tsx:18,42`）。
- 支持 8 视角需要放宽这个类型，或者单独设计一套。

**测试钩子**
- `dev/testHooks.ts` 的 `exposeBoard(pos, renderer: GameRenderer)` 类型绑死在 GameRenderer 上。

**镜头缩放**
- `camera/Camera.ts:28-29` 把 `MIN_ZOOM=0.4`、`MAX_ZOOM=1.8` 写成常量，而方案要求「默认 2×、范围 1–3×」。
- `BoardCanvas.tsx:22` 的 `START_ZOOM=0.85` 和开局 fitAll 俯瞰也和这个范围冲突。
- 两个渲染器里 zoom=1 的含义也不同：程序化是 128 px 一格，原版是 1 个源像素。

**BoardCanvas 的创建参数**
- `GameRenderer.create({onTap(pick{tile,lot}), onDoubleTap, onContextLost, quality, labels})` 和 `loadMap(def)`，OrigRenderer 都要同形实现。

**小游戏宿主**
- `MinigameClientModule.createView` 按模块注册，要按皮肤选择视图，必须改 `MiniGameHost` 或 registry。

**语音确定性需要的上下文**
- 方案写的 `hash32(batch.toVersion, …)`，但协议里**没有 toVersion 字段**，只有 epoch 和 seq（`shared/net/protocol.ts:59-62`）。
- `PresentationContext` 也不携带批次信息，需要扩展 EventPlayer 和 ctx。这与「presentation 不改」的说法矛盾。

**邀请授权需要改现有 UI**
- 房间页的「复制邀请链接」要改成生成 `#g=` 链接，这是现有 UI 的改动。

**修正**：BoardSurface 至少要包含 `camera` 门面（panTo、screenToWorld、setInsets、zoomTo、fitAll、onUserGesture）、`rotation: number`、`anchorPos`、`destroy`、测试钩子接口。上面各项并入 §3.1 的接缝清单，并与并行工作流约定合并窗口。

### 8. 漏了工程车载具

**问题**：引擎的 `Vehicle = 'walk' | 'moto' | 'car' | 'engineer'`（`packages/shared/src/data/tables/ids.ts:261`）。render 调研也记录了速度表第 4 项为 8，对应「履带机械臂」。方案却写「k=9–12 用途未定，本方案不使用」，这样玩家换乘工程车时没有任何原版姿态可用。

**修正**
- 把 engineer 暂定映射到 k=9–11，置信度标 `guess`，并用 `0x40b425` 角色载入器的分支核实。
- 核实前走程序化回退，但回退路径要写明。

### 9. 用 MapDef 的 `dataHash` 绑定 skin 太脆

**问题**：`meta.dataHash` 覆盖整个规范化后的 MapDef。M9「台湾图核实」还没做，另一个工作流也在改 tools/extract，map-build 的任何变动都会改变这个哈希，导致原版棋盘静默回退成程序化，看起来像「皮肤失效」。

**证据**：`rich4-data/maps/taiwan.map.json` 的 `meta.source.resourceSha256=e95239…`。这是原始地图资源的哈希，是稳定的。

**修正**
- skin 改为绑定 `source.resourceSha256`，再加一份摘要，覆盖 `tiles[].world`、`lots[].world/facing`、`companies[].world/facing`。
- 不匹配时在设置页显示具体原因。

### 10. 工作量明显低估，而且方案内部自相矛盾

| 项 | 方案 | 审查估计 | 依据 |
|---|---|---|---|
| A11 场所屏 | 10 | **16–26** | §4.3 表中有 13 行，按方案自己「每屏 1–2 天」的估算就是 13–26 天；另外每屏还要把对话框状态抽成 hook |
| A8 OrigStage | 4 | 7–8 | BoardStage 784 行、33 个方法，还要加 playFit 和逐 handler 核对预算 |
| A6 静态棋盘 | 5 | 7–8 | 包含第 7 条的 BoardSurface 抽取、Camera 参数化、8 向小地图和 GameScreen 改造 |
| A7 OrigActor | 4 | 5–6 | PlayerActor 680 行（状态、气泡、名牌、hop、settleAt、spread），再加 21 套姿态、快艇、工程车 |
| A4 访问控制 | 3.5 | 5–6 | 口令、scrypt、cookie、限流、授权、邀请表、握手守卫、CLI、Range 与预压缩，外加 M11 验证、E2E 夹具、loadtest 的适配 |
| A9 音频 | 4.5 | 7–8 | 27 个语音槽的触发推导、NPC 与新闻映射、BGM 栈、SFX 集、iOS 解锁 |
| 新增 A8-lite | — | 3–4 | 第 2 条 |

**重估结果**：总量约 **85–100 人日**（方案为 60）；MVP 约 **42–48 人日**（方案为 31.5）。

---

## 二、与调研证据不一致，或需要降级置信度

1. **LZHUF 距离解码的规格写法会误导实现**。方案 §2.3 写「先读 8 位查表，再读 6 位」，但原型的实际做法是：**窥视** 8 位，只消耗 `DLEN[b]`（3..8）位，再读 6 位（`test/lzhuf-proto.ts:198-201`）。方案声明「生产实现以此为准」，所以必须改正文字。

2. **lotHighlight #14 的帧语义冲突**。
   - `render/render-model.json` 写的是「0/1 为小地块的两种朝向，2/3 为设施大地块，4 为圆」，混色方式是「OR 混色」。
   - 方案写的是「帧 = (phase&1)，加色混合」。
   - render 调研的 unknowns 明确说颜色表 0x4861d0 与相位没有解码。
   - 这一项应标 `guess`；帧号按朝向取；混色标注为近似处理。

3. **只有目视依据的语义被当成了事实**，应在目录里标 `visual` 或 `guess`：
   - 角色姿态 k=12、16–20（render 与 sprites 两份调研都列在 unknowns 里）；
   - Data 339–354 是否就是四大恶人，以及 p=3 的用途（sprite catalog 只写了「4 名 NPC ×4，目视」）；
   - 镜头夹取范围 [220,2084]² 和 20 ms tick、40 ms 动画帧（都来自 oama 对 v3.11 的结论，v2.06 没有读过）；
   - 骰子 FLC 的 speed=14 ms 是否就是实际帧间隔（ui 调研 unknowns）。

4. **投影精度的验收指标选错了**。「查表与仿射差 4.5–6.4 px」是绝对位置误差。但地面和精灵用的是同一个仿射变换，用户看到的是「精灵锚点相对它脚下底图」的误差。在原版里，这个相对误差只来自亚格公式与四边形插值之间的取整差，约 ≤2 px。
   - §6.2 的测试应改为度量这个相对误差。
   - 风险条目「底图元素错位 2–6 px」也说重了。

5. **缺少朝向数据**：
   - `RoadObject` 没有 facing 字段（`engine/types/state.ts:278-283`）；
   - 路上神明也没有 facing；
   - PlayerView 里没有 dir，reset 或快照之后的朝向是未知的。
   - 需要为这几种情况定义确定性的默认值，例如 facing=0，或者按 id 哈希取值。

6. **`LotLook` 不带 chain/mark 字段**（`presentation/types.ts`）。连锁店 #47、涨价和查封的高亮只能在批尾的 `syncView` 里更新，批次中途不会刷新。应作为已知偏差记录下来。

7. **企鹅挖宝的 Panel#81 掩膜不能用于输入命中判定**。输入必须走 sim 的 `pickCell`，否则 golden 和服务器复验会失去意义。掩膜只能用来做诊断对拍；而且对拍不一致时，应当报告，而不是阻断。

8. **桌面右栏宽度对不上**。`hud.module.css` 里桌面右栏为 300px，1024–1279 宽时为 260px，而 Panel#0 的原生宽度是 200。桌面上只能按 1.5 或 1.3 的非整数倍缩放，像素图会不均匀。原版皮肤下应把 `--right-w` 设成 200 的整数倍，或者对侧栏改用平滑缩放。

9. **ownerMark 与主人色选项冲突**。ownerMark #13 的 12 帧是「按角色」画好的旗子。如果主人色选用座位色，描边是座位色、旗子是角色色，两者不一致。这一点应写进用户决策说明。

10. **ffmpeg 参数的小问题**：m4a 那条命令没有 `-map_metadata -1`，也没有 bitexact 相关参数。两条命令都没有写入方案声称的 `RICH4_DERIVED` 注释标记，与 §2.5 的守卫标记对不上。

---

## 三、渲染对齐可行性：可行，并且推荐

**已核实的证据**
- `projection-fit.v206.json`：8 个视角带常数项的仿射拟合，最大误差 1.81 px；视角 0 的常数项为 (−1.608, −1.117)；透视项 < 2e-5。
- `board_v0_center.png` 目视：建筑落在地块框内，路径沿路面走，公园和骰子格的圆盘都在节点上。
- 台湾 MapDef 与调研一致：
  - 节点 1 的 world 为 (1752,1871)；
  - 54 块地和 3 家企业全部带 facing；
  - `noItems` 共 17 个节点（1–4、25–29、32–34、99–103），与 boatNodes 相同；
  - `decorations` 为空，所以需要 skin.json 补上。

**为什么不能转换到我们的网格**：我们的网格是 45°、纵向压缩 0.5，只有 4 个方向。原版视角的方位角是 −22.5°+45°k、纵向压缩 0.7086，原版精灵的预渲染方位不在我们的方向集合里。所以方案「不转换」的判断是对的；方案不推荐「程序化棋盘 + 原版精灵」的混搭，这一点也同意。

**补充建议**
- 精灵的屏幕坐标取整到源像素（原版就是按整数位置画的）。整数倍缩放时，镜头平移也按源像素取整，否则最近邻采样下平移会闪烁。
- 缩放小于 1（开局俯瞰）时，底图要用 linear 加 mipmap，否则旋转后的地面会严重锯齿。
- 2304² 的底图在 4096 纹理上限以内，所以 2×2 切块只是可选项。
- 拾取高层建筑时，屏幕点反投到地面会偏到建筑后方，建议先用精灵的 alpha 做命中判定。
- 忽略 via 连接格的做法成立：原版地图数据里只有节点坐标。但快艇航段（99–103）的节点间距很大，恒定的 STEP_MS 会造成明显的变速，需要确认能否接受。

---

## 四、法律与部署

**已经处理到位的**：manifest 白名单、private 与 noindex、CORP same-origin、scrypt、授权放在 URL 片段里、派生标记加哈希禁单、镜像扫描。

**还需要补的**
1. 回环例外问题（见第一节第 3 条）。
2. **限流必须配合 `TRUST_PROXY=1`**。否则经 Caddy 进来的请求来源 IP 全都一样，「每 IP 每分钟 5 次、锁 15 分钟」就变成了全站锁死，攻击者可以用它把所有人挡在门外。建议改成退避延迟加全局软上限，不做硬锁。
3. **Vite 开发服务器可能泄露原版文件**。根目录 package.json 有 workspaces，Vite 会把仓库根当作 fs.allow 范围，`/@fs/<绝对路径>/original/Game/Data.mkf` 和 `rich4-assets/**` 都能被取到。一旦为了手机测试加 `--host`，局域网内任何人都能下载。建议在 `server.fs.deny` 里加上 `original/**`、`rich4-assets/**`、`.cache/**`、`rich4-data/**`。
4. **吊销无法清除浏览器缓存**。`max-age=31536000, immutable` 意味着吊销以后，朋友浏览器里的副本还会保留一年。建议降到 7–30 天，并在文档里写明这个限制。
5. **M11 的验证项会失效**：`curl /api/maps`、针对 compose 部署跑的 E2E、loadtest 在启用门禁后都会返回 401，需要同步修改，比如给 E2E 夹具注入口令。
6. **会话过期影响对局**：对局中途 cookie 到期时，Socket 重连会返回 ACCESS_REQUIRED，玩家被踢回门禁页。cookie 需要滑动续期。
7. **挂载目录权限**：宿主目录设为 0750 时，要确认容器内运行用户的 UID/GID 有读权限。
8. **可选的低风险模式：各自加载自己的素材**。每位朋友在浏览器里拖入自己的 Steam 版目录，由浏览器端的 TS 解码器解码并缓存到 OPFS。这样服务器完全不分发受版权保护的内容，也就不需要门禁。代价是视频（Indeo5）无法在浏览器里解码，只能省略。这个模式可以与服务器素材包共存，建议作为用户决策列出。
9. **代码来源**：audio_video 调研说明 `test/ui-lib.mjs` 是其他工作流写的。移植进生产代码前，要逐个文件确认来源、加上来源说明头，确保没有从 GPL 或无许可证项目搬运代码或数表。

---

## 五、修正后的冲击面清单（比方案 §3.1 多出的部分已标出）

| 文件 | 改动 |
|---|---|
| `ui/screens/BoardCanvas.tsx` | 方案已列 |
| `ui/screens/GameScreen.tsx` | camera、rotation、anchorPos 改走 BoardSurface（**新增**） |
| `ui/hud/MiniMap.tsx` + `game/minimap/MiniMapPainter.ts` | Rotation 类型放宽到 0..7（**新增**） |
| `game/camera/Camera.ts` | 缩放上下限参数化（**新增**） |
| `dev/testHooks.ts` | 接口化，不再绑定 GameRenderer（**新增**） |
| `presentation/EventPlayer.ts` + `types.ts` | ctx 携带 epoch、seq、事件下标（**新增**） |
| `presentation/soundMap.ts` | 方案已列 |
| `minigames/host/MiniGameHost.ts` 或 registry | 按皮肤选择视图（**新增**） |
| 房间页的邀请链接 | 生成授权链接（**新增**） |
| `server/http/static.ts` | `/pack` 排除出 SPA 回退（**新增**） |
| `server/config.ts`、`net/io.ts` | 方案已列 |
| `shared/net` | 新增 ErrorCode（方案已列） |
| `vite.config.ts` | `/pack` 代理加上 fs.deny（**新增** fs.deny 部分） |
| `.gitignore`、`.dockerignore`、`scripts/check-no-original.ts` | 必须在 A0 完成 |
| `e2e/specs/*` 用到的钩子 | 需要同形实现（**新增**） |

---

## 六、建议的里程碑调整

1. **A0** 在原有内容之外增加：忽略规则与守卫、`/pack` 默认返回 404、BoardSurface 与测试钩子的接口草案、`--out` 默认目录与禁止输出路径的规则。
2. **MVP** 调整为 A0–A7 加 A8-lite 加 A9。并把 fixture 的合成 skin 放进 A5/A6 的交付物，保证 CI 能跑到原版棋盘。
3. **A8** 先按「事件预算减去 handler 其余 await」逐个 handler 列出 FLIC 可用时长表，再实现 playFit。原版节奏这个用户决策要附上真实的压缩倍数表。
4. **A11** 按 13–15 屏重新估算，或者只挑 5 个最能体现原味的场景（银行、百货、乐透、魔法屋、拍卖），其余推到后续版本。
5. **engineer 载具、lotHighlight 帧语义、k=16–20 姿态语义**：在 A2 的目录里先标置信度，由 A6/A7 负责用 exe 核实。