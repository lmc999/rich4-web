# 原版皮肤（Original Skin）设计定稿

> 定稿日期 2026-09-27。本文是「原版皮肤」工作的**上位裁决**，与 `docs/research/original-assets/design-draft.md`（设计草案）冲突时以本文为准。
> 依据：`docs/research/original-assets/{containers,sprites,render,audio_video,ui}.md`（五路调研，全部在用户正版文件上验证）、`design-draft.md`（设计草案）、`critique.md`（审查，10 条必须修正已全部采纳，见 §3）。
> 本皮肤仅供用户与朋友**私人游玩**：素材由用户自己的 Steam 正版派生，不入库、不进镜像、不对公网公开。

---

## 1. 用户决策（不可推翻）

| # | 决策 | 内容 |
|---|---|---|
| U1 | 美术来源 | 从用户 Steam 正版（`original/`）派生原版素材包；程序化美术冻结为**回退**（无素材包、地图不匹配、访问被拒时使用），也是 CI 基线 |
| U2 | **UI 路线 A：原版 640×480 固定布局** | 整个对局画面按原版主画面还原：左上工具列 440×40（11 钮）+ 左侧棋盘视窗 440×440 + 右侧个人资料栏 200 宽 + 右下日历/月历 200×200，等比缩放。所有决策、场所、弹窗都做成原版场景。联机信息（聊天、观战、倒计时、托管、事件日志、房间信息）放在 4:3 舞台两侧的侧栏，窄屏时收成抽屉 |
| U3 | 演出节奏 | 房间选项 `pacing: 'original' \| 'compact'`，**默认 original**：完整播放原版 FLIC 与动画；服务器截止时间按所选节奏的动画预算扣除。compact 按现有预算压缩或截取 |
| U4 | 访问控制 | **共享口令 + 房间邀请链接授权**（24 小时、限次、放在 URL 片段）。启用素材包但未设门禁时服务器拒绝启动（见 §3 修正 3） |
| U5 | 文字 | 原版皮肤下界面、日志、弹窗文字一律**繁体（zh-TW）**；程序化皮肤保持简体（zh-CN） |
| U6 | 顺序 | 先完成原版皮肤；游戏正式可玩后再考虑 AI 生图替换（皮肤包格式需支持按类别替换） |

**默认项（按推荐执行，用户未反对）**：素材基准 v2.06（`original/Game`）；角色语音默认开启（含卡片/道具台词、新闻播报），音量独立调节；片头动画首次进入播放、可跳过（需把 Steam `Media/*.avi` 只读拷到 `original/Media/`）；音频 Opus 为主、AAC 回退，音乐重编码；字体 `local('MingLiU')`/`local('PMingLiU')` → Noto Serif TC（OFL，按字形分片）；像素缩放整数倍最近邻、非整数倍平滑；**原版皮肤下地产主人色用原版角色代表色**（与 ownerMark #13 按角色画好的旗子一致；HUD 以外的座位色标记保留用于色弱辅助）；fixture 地图保持程序化（CI 另用合成素材包覆盖原版渲染路径，见 §3 修正 6）；投影用仿射近似（不做逐像素查表模式）；M10 的程序化美术迭代、CC0 选曲、voiceBabble 取消。

---

## 2. 总体架构

```
original/（用户正版，只读） ──npm run extract -- assets build──►  rich4-assets/（gitignore、dockerignore；默认输出目录必须已被忽略）
   │  自写：LZHUF 严格解压、SPR/SMP/GND/RAW16/FLC/WAVE 解码、PNG 编码、MaxRects 装箱、ffmpeg 转码
   ▼
rich4-assets/manifest.json（schema rich4.assets/1，packId，license=private-personal-use，分组懒加载）
   ├ maps/taiwan.skin.<h8>.json（绑定 MapDef.meta.source.resourceSha256 + 几何摘要）
   ├ ground/ sprites/ images/ flic/ masks/ audio/{voice,sfx,music}/ video/ data/{voice-map,sfx-sets,flic-map,music-map}
server：RICH4_ASSETS_DIR（只读）→ /pack/*（manifest 白名单、private、noindex、Range、预压缩）＋ 访问门禁（口令/授权 cookie）
client：skin/（PackClient、FLC 播放器、皮肤选择与回退）
        game/orig/（OrigRenderer：原版世界坐标 + 仿射投影 + 8 视角；OrigActor；OrigStage）
        ui/classic/（640×480 舞台、工具列、资料栏、日历、原版对话框与场所屏、两侧联机侧栏）
        audio/（AudioEngine：BGM 场景切换、语音事件槽、音效集）
        i18n zh-TW（由 zh-CN 经 opencc-js s2t 生成 + 人工覆盖表）
```

**不改的部分**：引擎、协议、GameRunner、presentation/handlers 的规则与事件语义。渲染器通过 `BoardSurface` / `BoardPort` / `StagePort` 接缝替换；UI 通过「决策组件的状态与提交逻辑抽成 hook，原版场景只换表现层」复用。

---

## 3. 审查修正（全部采纳，实施以此为准）

1. **FLIC 时长口径**：playFit 的可用时长 = 事件预算 − handler 内其他 await（focus、popup、wait），逐 handler 推算；`budget.test` 纳入 OrigStage 常量。original 节奏下事件预算改为按原版 FLIC 实际时长生成（`shared/view/pacing.ts` 引入 pacing profile），服务器 Deadlines 按房间 profile 计算 animMs。
2. **MVP 必须含 OrigStage-lite**：`OrigStage.syncWorld` 负责静态物件、路上神明、恶人、关押外观；其余方法先给固定时长简化实现，可委托 **FxSystem 原语**（不是委托 BoardStage）。
3. **门禁无“回环例外”**：只有 `NODE_ENV!==production` 且 PUBLIC_URL 为 localhost 且 `TRUST_PROXY=0` 且显式 `RICH4_ASSETS_ALLOW_UNGATED=1` 时才允许无门禁，启动日志高亮警告。限流需配合 `TRUST_PROXY`，采用退避延迟 + 全局软上限，不做硬锁；cookie 滑动续期；素材缓存 `private, max-age` 7–30 天（不用 1 年 immutable，便于吊销）。
4. **`/pack/*` 永远注册**：未启用素材包时返回 404 JSON，并从 SPA 回退中排除 `/pack/`；PackClient 把非 JSON 或 zod 校验失败一律视为无素材包。
5. **忽略规则先行**：A0 先把 `rich4-assets/`、`*.flc`、`*.fli` 加入 `.gitignore`、`.dockerignore` 与 check-no-original；extract 拒绝输出到任何**未被 git 忽略**的路径和 `apps/*/public/**`；Vite `server.fs.deny` 加 `original/**`、`rich4-assets/**`、`.cache/**`、`rich4-data/**`。
6. **CI 覆盖原版渲染路径**：合成素材包为 fixture 地图生成合成 GND（棋盘格底图）与 skin.json；OrigRenderer 实现与程序化渲染器同形的测试钩子（`board.allActors/actor/roads` 计数等），现有 E2E 在两种皮肤下都能跑。
7. **完整接缝清单**：BoardSurface 至少含 camera 门面（panTo、screenToWorld、setInsets、zoomTo、fitAll、onUserGesture）、`rotation: number`（0..7）、anchorPos、destroy、测试钩子；另需改 GameScreen、MiniMap（Rotation 放宽到 0..7）、Camera（缩放上下限参数化）、testHooks（接口化）、EventPlayer/ctx（携带 epoch、seq、事件下标，供语音确定性选择）、MiniGameHost（按皮肤选视图）、房间页邀请链接（生成授权链接）、server static.ts、vite.config.ts。
8. **工程车载具**：暂定角色姿态 k=9–11，置信度 guess，用 exe 0x40b425 角色载入器核实；核实前走程序化回退。
9. **skin 绑定**：绑定 `MapDef.meta.source.resourceSha256` + 覆盖 `tiles[].world`、`lots[].world/facing`、`companies[].world/facing` 的几何摘要；不匹配时在设置页显示原因。
10. **工作量重估**：路线 A 下总量约 **100–120 人日**（单人全职），按轨道并行推进。

**其他采纳的修正**（审查第二节）：LZHUF 距离解码是「窥视 8 位、只消耗 DLEN[b] 位、再读 6 位」；lotHighlight #14 帧语义标 guess；只有目视依据的语义（姿态 k=12、16–20，Data 339–354 恶人，镜头夹取与 tick 时长，骰子 FLC 帧间隔）标 visual/guess；投影精度验收改为度量「精灵锚点相对底图」的相对误差（≤2 px）；RoadObject/路上神明/快照后朝向缺失时定义确定性默认（facing=0 或按 id 哈希）；企鹅挖宝输入命中一律走 sim 的 pickCell（Panel#81 掩膜只做诊断）；原版皮肤下侧栏按 200 的整数倍缩放或平滑缩放；ffmpeg 参数加 `-map_metadata -1`、bitexact 与 `RICH4_DERIVED` 标记；移植进生产代码的 test/ 原型逐文件确认来源（只移植我们自己写的原型，不搬运 GPL 或无许可证代码与数表）。

---

## 4. 路线 A：原版 640×480 布局

### 4.1 舞台与侧栏
- `ui/classic/ClassicStage`：640×480 逻辑坐标；`scale = min(W/640, H/480)`，整数倍时 `image-rendering: pixelated`，否则平滑；letterbox 居中。
- 原版区域（坐标以 ui 调研为准）：工具列 (0,0) 440×40；棋盘视窗 (0,40) 440×440，内嵌 OrigRenderer；个人资料栏 (440,0) 200×280（Panel#0 四页：資金/地產/股票/其他，头像 Data#2 72×72，代表色条，物价指数行）；日历/月历/缩小地图 (440,280) 200×200（Panel#2，节日当天换 Data#4–86）。
- **联机侧栏**（舞台两侧剩余宽度）：左栏 房间信息、座位与在线/托管状态、观战者、倒计时；右栏 聊天、表情、事件日志。16:9 桌面约各 240 px；手机横屏 844×390（舞台 520×390）两侧各约 162 px，或收成抽屉按钮。
- 棋盘视窗内可缩放拖拽（默认原版 1:1 源像素，缩放范围参数化），8 视角旋转沿用原版热键 `<` `>` 与小地图旋转钮。

### 4.2 原版场景与对话框（替代现有 React 对话框的表现层）
- 通用：YES/NO（Data#399 + 消息框 Data#476）、计算器数字输入（Panel#21，命中掩膜 Panel#22）、讲话框与头像表情（map#15–26）、卡片欄（Panel#11）、神明老虎机（Panel#67）、轮盘（Panel#68–71：旅馆/购物中心/保险/航空）、新闻板与命运板（Panel#66 + 插图 Data#400–475）、月结颁奖（Panel#25）、资产表（Panel#9）。
- 场所屏：银行与 ATM（Panel#23/24）、百货（Panel#10）、乐透投注与开奖（Panel#12/14–17）、魔法屋（Panel#18–20，区域掩膜 Panel#19）、拍卖（Panel#26）、股市（Panel#75/76）、公佈欄（Panel#73）、监狱/恶人/医院（Panel#63–65）、托管 AI（Panel#77）。
- 目标选择：在棋盘视窗内用原版光标（Data#0 箭头、手形、准星）点选，同时保留可访问的 DOM 候选列表（隐藏在侧栏，E2E 使用）。
- 实现方式：每个决策组件的状态与 submit 抽成 hook（`useXxxDecision`），程序化皮肤与原版皮肤各自一套表现层；倒计时圆环叠在场景右上角。
- 没有原版对应物的联机界面（大厅、建房、房间座位、存读档、口令门禁、邀请）用原版素材风格（消息框、按钮、头像）搭建。

### 4.3 标题与开局
- 标题 Data#1、选人窗 Data#477（12 头像 2×6）、开局设置 jump#0–4（背景风景 + 选中角色侧视走动 jump#5+3c+v）、Loading Data#560、开局跳伞 jump#41–66 / Data#518–529、片头 AVI（可跳过）。

---

## 5. 里程碑（原版皮肤 A0–A14）

| ID | 内容 | 验证要点 |
|---|---|---|
| A0 | 契约与安全先行：`shared/src/assets/pack.ts`（manifest 类型与 zod、ErrorCode `ACCESS_REQUIRED`）；`.gitignore`/`.dockerignore`/check-no-original 扩展；vite fs.deny；architecture §21 草案 | typecheck、check:deps、守卫能拦下植入的派生 PNG/FLC/manifest |
| A1 | 解码核心 `tools/extract/src/{mkf/lzhuf,gfx/*}` | 合成单测；本机 440/440 严格解压；抽检输出 sha1 与 `.cache/assets-research/emu/results.txt` 一致 |
| A2 | 资源目录 catalog.v206 + 图像素材包 + skin.json + `assets build/verify/ls/preview` | 两次 build manifest 相同；verify 0 不符；覆盖率报告；preview 抽检 |
| A3 | 音视频转码与映射表（voice/sfx/music/flic map；AVI → MP4） | 语音 1374、音效 99、音乐 25；时长误差 ±25ms |
| A4 | 服务器 `/pack/*`、访问门禁（口令、授权链接、cookie 续期、限流）、握手守卫、compose 挂载 | 单测与集成测试；无 cookie 401、有 cookie 200、Range 206；E2E 夹具注入口令 |
| A5 | 前端 PackClient、回退矩阵、FLC 播放器、zh-TW 语言包管线、合成素材包（CI） | 回退单测；FLC 合成用例逐像素；zh-TW 键齐全 |
| A6 | OrigRenderer 静态棋盘（8 视角、原版小地图、BoardSurface 抽象） | 相对误差 ≤2px；截图对比；测试钩子同形；60fps |
| A7 | OrigActor（21 套姿态、8 方向、快艇、工程车、状态、气泡、跳伞） | 方向组合单测；本机 4 人对局 |
| A8 | OrigStage 全量 + pacing profile（original/compact）+ 服务器按 profile 计时 | realEngine 事件样本无错不超预算；两种节奏下 E2E 通过 |
| A9 | AudioEngine + 原版 BGM/语音/音效 | 调度与确定性单测；E2E 断言音频日志；iOS/Android 手测 |
| A10 | 路线 A 外壳：ClassicStage、工具列、资料栏四页、日历/缩小地图、GO 钮与骰子 FLC、联机侧栏、手机横屏 | dom 测试；mobile-layout E2E（合成包） |
| A11 | 原版通用对话框与弹窗（YES/NO、计算器、卡片欄与目标选择、被动卡、弃牌、新闻命运板、老虎机、轮盘、月结、资产表、终局） | 每种决策在两种皮肤下 dom 测试；E2E cards/turn-cycle 在原版皮肤下通过 |
| A12 | 场所屏（银行/ATM、百货、乐透、魔法屋、拍卖、股市、公佈欄、监狱医院恶人、托管 AI、研究所/设施） | 每屏 realEngine dom 测试；bank-stock E2E（原版皮肤） |
| A13 | 小游戏原版视图（企鹅、气球、喜从天降 + 入场 FLC + BGM/音效） | golden 不变；minigame E2E |
| A14 | 标题/选人/开局设置/Loading/片头、收尾（上下文恢复、显存预算、镜像扫描、deploy.md、DEVIATIONS/VERIFY） | npm run check 全绿；E2E 全绿；镜像扫描 0 |

**与原里程碑的关系**：M9（台湾图核实）放在 A6 之后（原版底图天然可作对照）；M10 改为「原版皮肤收尾 + 通用打磨」（程序化美术冻结）；M11 增加素材包挂载与门禁。
