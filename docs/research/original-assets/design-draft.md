# 「原版皮肤」总体方案：私用素材包 + 程序化回退

> 适用于 `<repo>`。本文只是方案，没有改动 apps/、packages/、tools/、docs/ 下的任何文件，也没有提交。
> 依据：五路调研（containers、sprites、render、audio_video、ui），加上对现有代码的阅读：`docs/architecture.md` §0/§2/§9/§10/§16–§20、`docs/design/client.md` §3–§5/§7、`apps/client/src/game/**`、`presentation/**`、`apps/server/src/{config.ts,http/static.ts}`、`scripts/check-no-original.ts`、`.dockerignore`。

---

## 0. 背景与结论

### 0.1 现在的美术是怎么来的

按 architecture §0 决策 5（「美术自制，程序化 SVG/Pixi 绘制」），画面里没有任何外部图片。

**角色、神明、恶人**
- 由 SVG 纸娃娃 rig 在浏览器里合成，生成 128×160 的 SVG。相关文件：`game/procedural/character/{rig,svg,parts/*}.ts`、`game/actors/figures.ts`。
- `atlas.ts` 把它们栅格化成图集：每个角色 11 个姿势 × 正面、背面 2 个朝向。左右两个方向靠 `scale.x=-1` 镜像得到，所以一共只有 4 个方向。

**建筑**
- `procedural/building/generate.ts` 用 Pixi Graphics 画等角挤出盒：顶面、左面、右面亮度分别为 100%、85%、70%，加 2px 描边。
- 楼层、屋顶、招牌随等级增加，结果由 `textureCache.ts` 缓存。

**地面与道路**
- `board/GroundLayer.ts` 和 `RoadPainter.ts` 画 2:1 菱形格，道路有 16 种拼接方式。
- 投影在 `iso/projection.ts`（TILE 128×64），只支持 4 个 90° 旋转。

**特效与字体**
- 特效在 `fx/*`：粒子、光柱、爆炸都是程序化绘制。
- 字体用站酷快乐体和 Fredoka（都是 OFL 许可）。

**音频**
- 尚未接入。`presentation/soundMap.ts` 只有骨架，AudioEngine 属于 M10。

### 0.2 调研结论（全部在用户正版文件上验证过）

**容器与压缩**
- 9 个 MKF 共 2782 个资源，都按同一套规则解析。压缩资源 440 个：v2.06 有 417 个，分别是 Data 270、Panel 92、jump 36、map 19；v3.11 map.mkf 有 23 个。
- 自写的 LZHUF 解压全部 440 个都通过严格检查：输出长度等于 uncompressed，写满后下一个符号正好是 dist==0xFFF 结束标记，`ceil(bits/8)==stored`，没有越界。
- 用 radare2 ESIL 仿真原版解压函数（v2.06 VA 0x4536a0），抽 6 个资源与自写实现逐字节比对，结果一致。证据：`<repo>/.cache/assets-research/emu/results.txt`。

**像素格式与透明**
- 像素格式是 RGB555：所有需要格式转换的区间约有 3290 万个 16 位字，bit15 置位数为 0。
- 透明规则：
  - SPR：按索引 0 判透明（exe 的 blit 在 fcn.00454C9E 处 `je skip`）。
  - SMP：0x0000 为透明（fcn.004542B2）。
  - FLIC：索引 0 为透明（fcn.0044F361）。例外是 Panel#16、Panel#20、jump#42 三段，它们不透明。
- 锚点：落点 = 画点 − (x, y)（fcn.00455293）。

**地面与投影**
- 地面 GND 是一张 2304×2304 的正射底图，由 72×72 块、每块 32×32 组成。世界坐标就是这张底图的像素坐标。
- exe 里的投影表本质上是仿射变换：θ = −22.5° + 45°·view，每格 38.95 px，纵向压缩 0.7086。
  - 带常数项的仿射拟合，最大误差 1.81–2.02 px；
  - 透视项 |h31|、|h32| < 2e-5，所以不是透视投影。
- 证据：`<repo>/.cache/assets-research/render/projection-fit.v206.json`。
- 原型渲染：12 张 640×480 棋盘、3 个视角的全图总览，另有 1 张 8 方向朝向核对图，都已目视核对：建筑在地块框内，节点在路中线上。文件在 `.../render/board_v{0,1,2,5}_*.png`、`taiwan_view0_third.png`、`dircheck_view0_x3.png`。

**图像资源目录**
- 已导出 1358 张 PNG 和 40 张联系表，以及 324 张 UI 样张（在 `.../samples/`、`.../ui/sheets/`）。
- 已定位的资源编号：12 角色 × 21 套姿态 × 8 方向、4 图 × 5 级 × 8 方向建筑、15 种神明与路面物件、全部 UI 面板、30 张卡、76 张新闻/命运插图、83 张节日图。

**音频与视频**
- 语音 1374 段、音效 99 段，都是 8 位 PCM WAV，全部导出转码，0 错误。
- 音乐：Steam 版把 MIDI 换成了 25 轨 OGG。棋盘曲 CD 轨号 = idx + 2，场景曲 CD 轨号 = arg + 10，已由 exe 与 DxWnd 两边互相证实。
- AVI 是 Indeo5 编码，ffmpeg 能解码，21 个文件全部转码成功。

**字体**
- 原版中文不是 MKF 里的位图字，而是 GDI 的 `CreateFontA("細明體", CHINESEBIG5)` 画出来的（fcn.0044e200，共 150 个调用点）。MKF 里只有预先画进图里的数字和英文。

### 0.3 推荐方案（一句话版）

1. 素材由本地命令 `npm run extract -- assets` 离线派生到 `rich4-assets/`，内容包括 PNG 图集、JSON、FLC、Opus/AAC 音频和可选的 MP4，外加带 sha256 的 manifest。
2. 服务器只从只读目录，按 manifest 白名单，经 `/pack/*` 提供文件。启用素材包时，整个站点必须有访问口令（或邀请授权）才能用。
3. 前端新增「原版皮肤」渲染器，直接用原版世界坐标、仿射投影和 8 个视角。**不转换到我们现有的 2:1 等角网格。**
4. 渲染器实现现有的 `BoardPort` 和 `StagePort` 两个端口，所以 presentation/handlers、引擎、协议都不用改。
5. UI 走 B+ 混合路线：主 HUD 保留 React 布局，全面换上原版素材；银行、商店、乐透等场所屏做成「640×480 原版场景」模态层。
6. 音频全部用原版素材：BGM 按场景切换，语音用 27 个事件槽加卡片/道具台词，音效按原版音效集预载。
7. 没有素材包、地图不匹配、或访问被拒时，一律回退到现有的程序化美术。

---

## 1. 边界与原则

1. **需要改动的原决策**（建议在 architecture 增加 §21 记录）：
   - 决策 4「只输出 JSON，不含任何图片或音频」改为：地图数据包照旧；**另加一个私用素材包 rich4-assets/**，由本地派生，不入库、不进镜像、不公开。
   - 决策 5「美术自制」改为：**双皮肤**。原版皮肤只在有素材包时启用；程序化美术继续作为回退，也是 CI 的基线。
2. **三道隔离线**：
   - 仓库：`.gitignore` 加 `rich4-assets/`，check-no-original 同步扩展。
   - 镜像：`.dockerignore` 加 `rich4-assets` 和 `**/*.flc`，镜像扫描同步扩展。
   - 公网：访问控制，素材响应一律 `private`，并设 noindex。
3. **代码许可**：
   - 生产代码只从我们自己在 `test/` 下写的原型移植：`lzhuf-proto.ts`、`sprite-proto.ts`、`render-lib.ts`、`ui-lib.mjs`、`ar_*.py`。
   - mytbk、oama、nurockplayer 这几个参考项目只能读思路，**不能复制代码或表**。
   - LZHUF 的 DHI/DLEN 与初始树按规则生成，再与用户自己的 exe 核对。已核对：三张表在 v2.06 exe 中各只命中一处，位于 VA 0x480710/0x480810/0x480910。
4. **不改引擎与协议**：
   - 引擎只用 TileId 和 `World` 坐标，MapDef 的 `tiles[].world`、`lots[].world`、`companies[].world` 就是原版世界坐标（例如台湾节点 1 是 (1752,1871)）。
   - `LandmarkDef` 没有 world 字段，缺的景观坐标和精灵号由素材包里的 `skin.json` 补上。
5. **并行开发约束**：另一个工作流正在改 apps/、packages/、tools/、docs/。本方案尽量放进新目录，与现有代码的接缝只有第 3.1 和第 5 节列出的少数几个点。

---

## 2. 素材管线：`npm run extract -- assets`

### 2.1 命令

```
rich4-extract assets build  [--src original/] [--out rich4-assets/] [--edition v206]
                            [--only board,ui,fx,minigame,audio,music,video] [--media <Steam Media 目录>]
                            [--audio opus,m4a] [--video] [--jobs 4] [--allow-unknown]
rich4-extract assets verify [--out rich4-assets/] [--full]     # 逐文件复算 sha256，并与 manifest 比对
rich4-extract assets ls     [--group board.common] [--json]    # 列出目录项及其解析结果
rich4-extract assets preview [--out .cache/assets-preview/]    # 本机浏览用的联系表和 index.html（不进素材包）
rich4-extract mkf ls --file <mkf>                              # 扩展现有命令：显示 kind 与压缩统计
```

**退出码**沿用现有约定：0 成功；1 结构或校验失败；2 缺少输入（例如没有 ffmpeg 却指定了 `--only audio`）；3 指纹未知。

**前置检查**
- 先跑 fingerprint，确认 Game/*.mkf、rich4.exe 在 known-files 中登记过。
- 解码器与 PNG 编码器只用 `node:zlib`，不装任何 npm 包。
- 音视频转码调用本机 ffmpeg，并把版本号写进 manifest。

### 2.2 模块结构（新增为主）

```
tools/extract/src/
  mkf/lzhuf.ts          # 严格解压：写满后校验结束标记、ceil(bits/8)==stored、回溯越界、源数据越界
  mkf/container.ts      # 扩展：read(i) 自动解压；kind 增加 SPR/SMP/GND/FLIC/WAVE/RAW16/TEXT/DATA/EMPTY
  gfx/rgb555.ts         # 5 位→8 位：x<<3 | x>>2
  gfx/{spr,smp,gnd,raw16,flc,wave}.ts   # 解析与自洽校验（start==12+12n、Σgsize 闭合、gsize==w·h(·2)）
  gfx/png.ts            # 最小 PNG 编码器：RGBA、索引色（PLTE+tRNS）、8 位灰度；固定 filter 与 zlib 级别；写入 tEXt 标记
  gfx/pack.ts           # 确定性 MaxRects 装箱（输入先排序；页面不超过 2048²；帧间留 1px 间隔）
  assets/catalog.v206.ts  # 资源目录：逻辑键 → (mkf, 编号, kind, 帧语义, 透明规则, 分组, 证据)，见 2.4
  assets/skin.ts        # 地图皮肤：raw 地图（decor/spriteRes/facing/景观坐标）+ exe 投影表 + 仿射拟合
  assets/audio.ts       # WAV 切片 → ffmpeg；音乐按循环区间裁剪；voice-map / sfx-sets / music-map
  assets/video.ts       # 可选：AVI → MP4
  assets/manifest.ts    # 规范化 JSON、带哈希的文件名、sha256、分组
  commands/assets.ts
packages/shared/src/assets/pack.ts   # 素材包契约（类型 + zod），client、server、extract 共用；只依赖 util
```

**分层规则**（architecture §3 需要补一行）：`shared/assets` 只能依赖 `shared/util`；`tools/extract`、`apps/client`、`apps/server` 都可以依赖它。

### 2.3 解码规格摘要（生产实现以此为准）

**MKF 容器**

| 项 | 规格 |
|---|---|
| 索引表 | `X = u32@0`；`N = (len−X)/4`，没有哨兵项 |
| 资源位置 | `start[i] = u32@(X+4i)` |
| 资源头 | `{uncompressed, stored, imgOff, imgSize}`，共 16 字节 |
| 数据体 | 紧跟资源头，长度为 stored，首尾相接，间隙恒为 0 |
| 是否压缩 | `stored != uncompressed` 即为压缩 |
| 像素区间 | imgOff/imgSize 表示「需要做 16 位像素格式转换的区间」。浏览器端不做这一步，直接当 RGB555 用 |

**LZHUF**
- 常量：NCHAR=321，T=641，ROOT=640，比特序 LSB-first。
- 符号：小于 256 是字面字节；否则是匹配，长度 = s − 253，范围 3..67。
- 距离：先读 8 位查 DLEN、DHI 两张表，再读 6 位；`dist = HI<<6 | lo6`。`dist==0xFFF` 表示结束。
- 频率达到 `freq[ROOT]==0x8000` 时重建：先 bump 所有频率为奇数的叶子，再整体右移一位。
- 性能参考：Node 24 上 9 个文件全量解析加解压约 1.6 s。

**各类资源布局**

| 类型 | 布局 | 透明规则 |
|---|---|---|
| SPR | `'SPR\0'`、n、start=12+12n；帧描述 `{i16 w,h,x,y; u32 gsize=w·h}`；start 处 512 字节调色板；像素从 start+512 开始，每像素 8 位，**没有 RLE** | 索引 0 |
| SMP | 同 SPR，但 gsize=2wh，像素是 16 位 RGB555，没有调色板 | 0x0000；整屏背景由目录标记为 opaque，先铺黑底 |
| GND | +0x04 cols=72，+0x06 rows=72，+0x08 5184；+0x10 调色板；+0x210 排布表（全部恒等）；+0x2A90 起 5184×1024 字节图块，行主序；总长 5,319,312 | 不透明 |
| RAW16 | 没有头，尺寸由字节数决定：80000→200×200、194776→388×251、84480→165×256、614400→640×480 | 全部不透明（含卡片插画：exe 0x440c95 不透明拷贝；⚠ 旧稿「卡片四角的 0 值视为透明」作废，见 ui.md §2.2） |
| FLIC | 标准 FLC：magic 0xAF12，8bpp；子块 4/7/15/16/18 与 0xF100 前缀块；帧块数 = frames+1 | 索引 0（3 段例外）|
| WAVE | 完整的 RIFF 文件，u8 单声道 22050 Hz 或 44100 Hz | — |
| TEXT | help #1–99，Big5 编码 | — |
| DATA | Panel #8/#19/#22/#81 是 u8 区域图（每像素一个区号） | — |

**FLIC 的一处怪癖**：Panel#20 末帧的 COPY 子块把 size 写成了 307204。解码时要按帧块大小前进，COPY 数据按 W×H 读取。

**SPR 调色板第 255 项**：只在 map.mkf 的建筑类 SPR 里表示「主人色描边」，需要单独输出一张掩膜（见 2.5）。其他文件里的第 255 项是普通颜色，例如 Panel#31 的白色高光，**不能一律替换**。

### 2.4 资源目录 catalog.v206.ts（v2.06 编号；v3.11 的偏移另表处理）

目录的每一项都带有 `confidence: 'exe' | 'visual' | 'guess'` 和证据字段 `src`（VA 或样图）。置信度为 `guess` 的项在前端默认回退到程序化美术。

**棋盘（map.mkf；n = 本档地图数 = 4；台湾 gm = 0）**

| 逻辑键 | 资源 | 说明 |
|---|---|---|
| ground.gm | #2gm（GND） | 2304² 底图 |
| minimap.gm | #8+gm（SMP 2 帧：200²、400²） | v3.11 为 #16+gm |
| decor | #12（SMP 17 帧） | 帧 = decor−1，锚点在图心，**不参与排序** |
| ownerMark | #13（SPR 12 帧） | 空地已有主时显示；帧 = 角色号 |
| lotHighlight | #14（SPR 5 帧） | 地块用帧 (phase&1)，设施用 (phase&1)+2；加色混合 |
| speaker.c | #15+c（7 帧） | 大头像、4 个表情、小头像、地图点 |
| house.gm.L | #27+5gm+(L−1) | 8 帧，帧 = `(8−(facing+view))&7`；有主人色掩膜 |
| chainStore | #47 | 连锁店 |
| facility | #48 公园；#48+(kind−1)·5+L | 旅馆 49–53、购物中心 54–58、加油站 59–63、研究所 64–68 |
| company / scenery | spriteId+26 | 已核对：医院 61→87、绿岛 123→149、台湾人寿 49→75 |

**棋子与物件（Data.mkf）**

| 逻辑键 | 资源 | 说明 |
|---|---|---|
| char.c.k | #87+21c+k | k：0 站、1 走（72 帧 = 8 方向 × 9）、2 持骰；3–5 机车；6–8 汽车；13–15 快艇；16–17 梦游；18 乞丐；19 住院；20 坐牢。**9–12 的用途未定，本方案不使用** |
| npc.a.p | #323+4a+p | a = 4..7，即 Data 339–354；p = 0 站、1 走、2 快艇 |
| roadObj.t | #354+t | t = 1..15 为神明与恶犬、礼物、宝箱、土地公等；16 路障 #370、17 地雷 #371、18 定时炸弹 #372、19 ZZZ #373；帧 = `(8−view+facing)&7` |
| doll | #480、#481 | 机器娃娃 / 工人，8 方向 |
| cursor | #0（SMP 43 帧） | STOP、准星、8 方向选路箭头、手形光标等 |
| portrait72 | #2 | 12 帧 72×72 |
| card.k | #529+k | k = 1..30；165×256 不透明整图（exe 0x440bea / 0x440c95） |
| news.i / fate | news.i = #400+i（36 张）；fate = #436–475（40 张） | 命运插图与 37 条命运的对应关系待定（`guess`） |
| holiday | #4–86 | 台湾 4–27、中国 28–46、日本 47–67、美国 68–86 |
| emoteFlic.c | #375–398 | 每个角色 2 段 |
| boardFlic | #482–529 | 见 3.7 |

**UI（Panel.mkf / Data.mkf / jump.mkf / help.mkf）**：采用 ui 调研 §2 的整张表，例如：
- 工具列 Panel#1（22 帧）、侧栏 Panel#0、日历 Panel#2、GO 钮 Panel#7；
- 骰子 Panel#3–6、计算器 Panel#21；
- 银行 Panel#23/24、百货 Panel#10、乐透 Panel#12/14–17、魔法屋 Panel#18–20；
- 拍卖 Panel#26、股市 Panel#75/76、资产表 Panel#9、月结 Panel#25；
- 监狱、恶人、医院 Panel#63–65；新闻板和命运板 Panel#66；老虎机 Panel#67；轮盘 Panel#68–71；公佈欄 Panel#73；
- 小游戏 Panel#78–112；
- 标题 Data#1、YES/NO Data#399、共享 UI 图集 Data#476、选人窗 Data#477、金貝貝表情 Data#478、存读档 Data#479、Loading Data#560；
- 开局设置 jump#0–4、侧视走动 jump#5+3c+v（v：0 步行、1 机车、2 汽车）、跳伞 jump#41–66。

**命中掩膜**：Panel#8（72×67，4 区）、#19（640×480，魔法屋 13 区）、#22（128×192，16 键）、#81（640×480，企鹅挖宝 64 格）。

**几处调研分歧的裁决**

| 分歧 | 采用 | 理由 |
|---|---|---|
| 快艇是 k=9–11 还是 13–15 | 13–15 | 有 exe 证据：0x40b5cb 检查节点 +0x27 & 0x80 |
| 道具台词在哪个区段 | 234+16c+k（道具）；426+52c+k 为卡片 | exe 中有 1343 条 `#NNNN` 台词文本；r_minigames_chars §2.4 的说法作废 |
| FLIC 色键 | 按「索引 0」判定 | ui 调研说「每个资源不同」，指的是各资源索引 0 的 RGB 颜色不同，两者不矛盾 |

### 2.5 输出：rich4-assets/ 目录与契约

```
rich4-assets/
├─ manifest.json                                 # schema 'rich4.assets/1'（不带哈希；no-cache）
├─ maps/taiwan.skin.<h8>.json                    # schema 'rich4.mapskin/1'
├─ ground/taiwan/{0_0,1_0,0_1,1_1}.<h8>.png      # 2304² 切成 2×2 张 1152²，索引色 PNG，每块多带 1px 重叠
├─ sprites/<mkf>/<res>.<h8>.png + <res>.<h8>.json   # 每个 SPR/SMP 资源一页（或多页）图集
├─ sprites/map/<res>.mask.<h8>.png               # 建筑类 SPR：索引 255 → 白色掩膜；底图里这些像素设为透明
├─ images/<mkf>/<res>.<h8>.png                   # RAW16 整图
├─ flic/<mkf>/<res>.<h8>.flc (+ .flc.br / .flc.gz)   # 解压后的 FLC 原样保存，另附预压缩版本
├─ masks/panel/<res>.<h8>.png                    # u8 区域图 → 8 位灰度 PNG（值即区号）
├─ audio/voice/<nnnn>.<h8>.{opus,m4a}  audio/sfx/<nnn>.<h8>.{opus,m4a}  audio/music/track<nn>.<h8>.{opus,m4a}
├─ video/<name>.<h8>.mp4                          # 可选
└─ data/{voice-map,sfx-sets,flic-map,music-map}.<h8>.json
```

**manifest 契约**（`packages/shared/src/assets/pack.ts`）

```ts
export interface PackManifestV1 {
  schema: 'rich4.assets/1'; packId: string /* 规范化 files 表的 sha256 前 16 位 */;
  generator: string /* rich4-extract/assets@1 */; edition: 'v206' | 'v311'; license: 'private-personal-use';
  source: { files: Record<string, { sha256: string; bytes: number }>; exeSha256: string };
  tools: { ffmpeg: string | null };
  features: { board: boolean; ui: boolean; fx: boolean; minigames: boolean; audio: boolean; voice: boolean; video: boolean };
  groups: Record<string, { keys: string[]; bytes: number }>;  // 懒加载单元：board.common / map.taiwan / char.<c> / ui.hud / venue.bank / mg.penguin / fx.board …
  files: Record<string /* 逻辑键 */, { path: string; sha256: string; bytes: number; type: string; enc?: ('br'|'gzip')[] }>;
  maps: Record<string /* mapId */, { globalMapId: number; mapDataHash: string; skin: string }>;
}
```

**图集 JSON**
- 用 Pixi Spritesheet（TexturePacker hash）格式，`Assets.load` 可以直接吃。
- `frames[name].anchor = {x: ax/w, y: ay/h}`，允许为负值或超出 [0,1]。
- 额外的 `meta.r4` 字段写：`{res:'Data#88', kind, frames, dirs: 8, framesPerDir, anchorsPx:[…], ownerMask}`。

**skin.json 内容**
- `mapDataHash`：与 MapDef.meta.dataHash 不一致时，前端回退到程序化美术。
- `ground` 分块信息。
- 每个视角的仿射矩阵：8 组 `{a,b,c,d,tx,ty}`，按世界像素计，由 cellScreen 表最小二乘拟合得到。
- 可选的精确表：cellScreen 为 8×29×29×(sy,sx)，subcell 为 8×4 个 int8，drawOrder 以 −128 结尾。
- 投影中心 (220,260)，镜头夹取范围 [220,2084]²。
- 每个节点的 `decor`；景观 21 个，各含 `{world, spriteRes, facing}`；每个企业的 `spriteRes`。
- `boatNodes`：flags bit31，台湾图 17 个（1–4、25–29、32–34、99–103）。
- 资源号解析结果（住宅、连锁店、设施、装饰、ownerMark、高亮）。

**派生标记（供守卫识别）**
- 每张 PNG 写入 tEXt `rich4:derived=private`。
- Opus 和 m4a 写入注释 `RICH4_DERIVED=1`。
- MP4 写入 `comment=rich4-derived`。
- 这些值都是常量，不影响确定性。

### 2.6 音视频转码

**语音与音效**（Speaking.mkf 1374 段、Effect.mkf 99 段；#64–79 为空）
- MKF 里的资源体直接就是 WAV，切片后交给 ffmpeg：
  ```
  ffmpeg -i in.wav -ac 1 -c:a libopus -b:a 32k -vbr on -application audio -fflags +bitexact -map_metadata -1 out.opus
  ffmpeg -i in.wav -ac 1 -c:a aac -b:a 48k -movflags +faststart out.m4a      # 旧版 iOS 回退
  ```
- 实测体积：语音 9.64 MB（Opus）/ 15.78 MB（AAC），音效 0.76 MB / 1.19 MB。

**音乐**（`original/Media/Music/track02..26.ogg`，Vorbis 44.1 kHz 立体声，合计 115.8 MB / 2045.9 s）
- 按 silencedetect 测得的循环区间裁掉首尾静音，例如 track10 取 0.48–48.02 s，这样浏览器原生 `loop` 基本无缝。
- 输出 Opus 112k 约 28.6 MB，另出 AAC 128k 回退约 32.7 MB。
- **tracklen.nfo 里的时长不可信**，例如 track03 标 141 s，实测 169.18 s。

**视频**（可选）
- AVI 在 Steam 的 Media 目录，本机只在共享盘里有。
- 转码命令：`-c:v libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 128k`。
- v2.06 用到 7 个文件（START、END、OVER、FLYTW、FLYCHINA、FLYJP、FLYUS），合计约 23 MB。

**自动生成的映射表**
- `voice-map.json`：从 exe 的 `#NNNN` Big5 台词（1343 条，覆盖 1341 个编号）与 D2 已抽出的新闻、命运、魔法屋文本做文字匹配，得到 NPC 与新闻播报的对应。不一致处用 overrides 修正。
- `sfx-sets.json`：exe 里 16 张有效音效集表，扫描步长为 1 字节。
- `flic-map.json`：55 处 FLIC 调用点解出的（图号 → 音效号）配对。
- `music-map.json`：棋盘曲 idx → track idx+2；场景 arg → track arg+10。

### 2.7 确定性与校验

**图像与 JSON：字节级确定**
- 输入排序；PNG 使用固定 filter、zlib level 9、不写时间戳；JSON 规范化。
- 文件名含内容哈希前 8 位。
- 连续两次 build，`manifest.json` 的 sha256 应该相同。

**音视频：参数级确定**
- 同一个 ffmpeg 版本加 `-fflags +bitexact`，应得到相同字节。
- 不同 ffmpeg 版本之间只比较时长（±25 ms）、采样率、声道数。manifest 记录 ffmpeg 版本。

**`assets verify`**
- 逐文件复算 sha256。
- 检查目录覆盖率：每个目录项都解析成功，帧数符合预期，例如 char.c.1 必须是 72 帧、house 必须是 8 帧。
- 列出没有被目录收录的资源，这份清单用于后续补齐。

**源文件校验**：manifest 记录 Game/*.mkf 与 exe 的 sha256。服务器启动时只校验 manifest 结构；`RICH4_ASSETS_VERIFY=full` 时逐文件校验。

### 2.8 体积估算

- 磁盘总量约 150–200 MB，其中音频两种格式约 90 MB，视频可选约 23 MB。
- 单局首次下载约 10–15 MB：地图 + 4 名角色的常用姿态库 + HUD + 音效，BGM 为流式播放。
- 其余资源懒加载，并由浏览器缓存（immutable）。
- 显存：地面约 21 MB；每个角色全部姿态约 8 MB，按姿态库懒加载后常驻 2–3 MB。

---

## 3. 前端

### 3.1 素材包加载与回退（新目录 `apps/client/src/skin/`）

**文件**
- `pack/PackClient.ts`：`GET /pack/manifest.json`，zod 校验，按逻辑键解析 URL，按组调用 `Assets.addBundle` 懒加载，提供 `canPlayType` 选格式（opus 优先，否则 m4a）。
- `skinStore.ts`：由设置、素材包状态、地图可用性三者算出最终皮肤。
- `flic/FlcDecoder.ts`（约 200 行）：输出索引缓冲与调色板，再转成 RGBA；除 3 段不透明的外，索引 0 → alpha 0。
- `flic/FlicPlayer.ts`：驱动 AnimClock，并提供 `playFit(budgetMs)`（见 3.7）。Pixi 侧复用一张纹理，每帧 `source.update()`；DOM 侧画到 `<canvas>`。

**皮肤判定顺序**

| 条件 | 结果 |
|---|---|
| 设置为「程序化」 | procedural |
| manifest 返回 404 | procedural（本站没有素材包） |
| manifest 返回 401 | 显示访问门禁页（见 5.3） |
| 素材包正常，但 `maps[mapId]` 缺失或 `mapDataHash` 不一致 | 棋盘用 procedural，UI 与音频仍用原版 |
| 其他情况 | original |

- 两套 fixture 地图没有 GND，所以永远走程序化棋盘。

**设置项**（`settingsStore`）
- `skin: auto|original|procedural`
- `audioSource: auto|original|synth`
- `voice: on|off`
- `pixel: nearest|smooth`

**接缝**（对现有代码的少量改动）
1. `ui/screens/BoardCanvas.tsx`：按皮肤选择 `GameRenderer + BoardController`，或者 `OrigRenderer + OrigBoardController`。为此从 BoardController 提取一个 `BoardSurface` 接口：`BoardPort & {stage, highlight, follow, refollow, say, tileCanvasPos, clearFx, followed, rotate}`。
2. `settingsStore` 增加上面的字段。
3. `GameScreen` 安装 AudioEngine。
4. `vite.config.ts` 的 proxy 增加 `/pack`。
5. `hud/MiniMap.tsx` 按皮肤切换画法。

### 3.2 渲染方式：用原版世界坐标加仿射投影，不转换到我们的等角网格

**推荐：原版世界坐标 + 每视角一个仿射矩阵，支持 8 个视角**

- **地面**：GND 的 4 块纹理放在同一个容器里，容器变换为 `Matrix(a,b,c,d,tx,ty)`。
  - 视角 0 的参数为 a=36.012/32、c=14.864/32、b=−10.527/32、d=25.524/32，其余视角见 projection-fit。
  - 整个地面只需 4 个 draw call。
- **精灵**：屏幕位置 = M(view)·world，pivot = 锚点 (ax, ay)。
- **误差**：与原版逐格查表加亚格偏移的结果相比，只看格点时最大 1.8–2.0 px，含亚格取整时 4.5–6.4 px。
- **精确模式**（可选画质项，放在 A6 之后）：按原版 cellScreen 表建一张 29×29 顶点的 Mesh，UV = 世界格角 ÷ 2304，物体按 `(220,260) + o(镜头) − o(物体) + T[格差]` 摆放，做到像素级一致。

**为什么不转换到现有的 2:1 等角网格**
1. GND 是一张正射底图，道路、白虚线地块框、景观底座都已经画在图里。
2. 建筑、角色、神明都是按原版投影（θ = ±22.5° + 45°k、纵向压缩 0.7086）预渲染的 8 向图。
3. 我们的网格是 45°、压缩 0.5，格距按 T=48 拟合，而且只能 4 个方向旋转。换过去以后，精灵和底图里画好的地块框、路口圆盘必然错位，8 个视角也只能用上 4 个。
4. 原型已经证明原版坐标可行：`board_v*_*.png` 中的石门水库精灵正好压在底图里它自己的岩石底座上，103 个节点都落在路中线上。

**引擎侧不用改**：路径仍是 TileId 序列，行走在节点 world 坐标之间直线插值。原版就是走直线段，所以**原版皮肤忽略 MapDef 里的 via 连接格**。

### 3.3 OrigRenderer 结构（新目录 `apps/client/src/game/orig/`）

| 文件 | 职责 |
|---|---|
| `OrigProjection.ts` | view 取 0..7；`worldToScreen`、`screenToWorld`（仿射求逆）；精确表模式；`rotate(±1)` 每次 45° |
| `OrigRenderer.ts` | 复用 `layers.ts`、`Camera`、`gestures`、`AnimClock`；背景色黑；纹理采样用 nearest（在 `pixel=smooth` 且缩放不是整数倍时改用 linear 加 mipmap） |
| `OrigBoardView.ts` | 地面、装饰层（不排序）、住宅、设施、连锁店、企业、景观、ownerMark、lotHighlight |
| `OrigActor.ts` | 21 套姿态库、8 方向、动画帧、快艇、状态、名牌与气泡（复用 `PlayerActor` 的气泡与名牌逻辑） |
| `OrigStage.ts` | 实现 StagePort：路面物件、神明、恶人、娃娃、FLIC 特效；无原版对应的方法委托给现有程序化 fx |
| `OrigBoardController.ts` | 实现 BoardPort 与 BoardSurface |
| `depth.ts` / `picking.ts` / `markers.ts` | 深度排序、拾取、目标与路径高亮 |

**建筑与主人色**
- 帧号 = `(8−(facing+view))&7`，facing 取 MapDef 的 `LotBase.facing`（原版地块 +0x1b）。
- 主人色描边 = 掩膜精灵乘以 tint(主人色)，效果等同于原版 0x409468 处临时改写 palette[255]。无主时画黑色。
- 等级 0 且有主时画 ownerMark 帧 = 角色号。
- 涨价或查封时用 #14 做加色闪烁。

**棋子**
- 帧号 = `((8−view+dir)&7)·(帧数/8) + anim`。
- dir 的求法：`dir = [2,3,4,5,6,7,0,1][round(atan2(−dy,dx)/45°)&7]`（fcn.00453614）。
- 动画帧每 40 ms（按 AnimClock 计）加 1，对应原版分频 2 档。
- 每一步仍用 `STEP_MS = 180`，保持与 shared/pacing 一致。
- 当前节点或下一节点在 boatNodes 里时，改用 k=13–15 快艇姿态库。
- 载具：walk/moto/car 分别对应 k=0/3/6 起；梦游 16–17、乞丐 18、住院 19、坐牢 20。
- 同格多人时按座位错开，沿用 `SEAT_OFFSETS`。
- 头顶气泡用 Data#476 的讲话框，配 map#15+c 头像。

**深度排序**：沿用原版规则。
- `zIndex = sy·16 + layer`，sy 是锚点在世界容器里的屏幕 y。
- layer：建筑、物件、附身物为 0；非当前 NPC 为 8；非当前玩家为 0xC；当前玩家为 0xD；ZZZ 为 0xE/0xF；飞行物固定最后画（原版键 0x7FF0）。
- 装饰圆盘在排序层之下单独一层，与原版一致。
- 旋转或每帧移动后重算 zIndex。

**镜头与旋转**
- `Camera.setBounds` 用地图四角投影后的包围盒；镜头中心夹在世界 [220,2084]²。
- 默认缩放：桌面 2×（1 个源像素 = 2 个 CSS 像素）；范围 1–3×。
- 旋转：热键 `<` `>`、小地图的蓝色/紫色旋转钮（Data#476 图18–21）、现有旋转按钮，都按 ±45° 走。
- 旋转时镜头保持对准同一个世界点，建筑与棋子重选帧，可选 150 ms 交叉淡化。
- 初始视角为 0，与原版载入地图时一致（0x407a8c）。

**拾取与高亮**
- 屏幕坐标经仿射求逆得到世界坐标：24 世界像素内最近的节点算命中；地块取 32 px 内最近的 lot.world。
- 候选格用投影后的椭圆，或 Data#0 的准星、8 向箭头帧；路径预览用半透明脚印。

**小地图**：用 map#8+gm 的 200×200 俯视图；玩家点坐标 = world·200/2304；视口画成旋转后的四边形。

### 3.4 路面物件、神明、恶人

| 端口方法 | 原版素材 |
|---|---|
| dropObject / removeObject | 路障 #370、地雷 #371、定时炸弹 #372，帧按 facing 与 view 计算；移除时播烟雾 FLIC 491 |
| 路上神明 | #355–369（t=1..15），8 帧 |
| 附身神明 | 画在主人位置，帧 = `(dirIdx+4)&7`，偏移按 0x4727fd 的表（例如 dirIdx 0 为 (−10,−22)） |
| bombAttach / bombPass | #372，偏移按 0x47283d 的表（例如 (−18,−44)）；引信数字用 Panel#13 黄色字模，或沿用现有 BitmapText |
| dollWalk | Data#480/481 |
| walkVillain | Data 339–354 |
| beggarMove | 角色 k=18 |
| 梦游 ZZZ | #373（6 帧） |

### 3.5 FLIC 特效映射与时长适配

**问题**：原版 FLIC 的时长（数据取自 `.cache/assets-research/audio/flic.index.json`）常常超过我们的事件预算（`shared/view/pacing.ts`）。

| 事件 / 端口 | FLIC（音效） | 原长 | 预算 | 标准节奏下的处理 |
|---|---|---|---|---|
| godArrive（GOD_ATTACHED） | 499–510（102–113） | 12–35 帧 × 71–128 ms，1.2–3.5 s | 1500 | 最多加速 2×，仍超出就截尾 |
| escort 医院（CONFINED） | 483 救护车 440×74（92） | 62×100 ms = 6.2 s | 1500 | 目录里 trim 出进场到停车的一段，音效淡出 |
| escort 监狱 | 497 警车（94） | 2.5 s | 1500 | 加速 1.65× |
| explode 小 / 大 | 484（82）/ 486（87） | 0.9 / 2.9 s | BOMB_EXPLODED 2000 | 大爆炸加速 1.45× |
| strike 飞弹 | 490（86） | 4.1 s | STRIKE 2400 | 加速 1.7× |
| strike 核弹 | 487 或 489（待认） | 2.2 / 3.0 s | 2400 | 未确认前走程序化 |
| godLeave | 485 烟雾（95） | 0.9 s | GOD_LEFT 900 | 原速 |
| 得卡 / 得点券 | 495（99）/ 496（98） | 1.0 s | CARD_GAINED / POINTS_GAINED 700 | 1.4× |
| 破产 | 514（100） | 0.7 s | BANKRUPT 2500 | 原速 |
| 节日：元旦、国庆 / 圣诞 | 482（90）/ 513（114） | 2.8 / 7.65 s | HOLIDAY 2000 | 482 加速 1.4×；513 截尾 |
| 开局跳伞（PARACHUTE） | 518–529 棋盘伞（按角色） | 1.3–1.7 s | 1500 | 原速；全屏的 jump#41–66 只在 A13 可选播放，不占预算 |
| 骰子（DICE_ROLLED） | Panel#4/5/6（1/2/3 颗） | 36 帧；头部 14 ms 被 exe 覆盖为 [50,30,20] ms/帧（按游戏速度），默认 1.08 s | original 2400 / compact 1480（含持骰动作与落定停留，见 shared/view/pacing 的 DICE_TIMING） | 只播一遍，第 30 帧与播完各放 Effect#10；之后定格为 Panel#3 的点数 |
| 乐透开奖（LOTTERY_DRAW） | Panel#16/17 | 3.0 / 2.6 s | 4200 | 原速 |
| 魔法屋施法（MAGIC_CAST） | Panel#20（不透明，640×480） | 1.8 s | 2000 | 原速，放在场所屏里 |
| cheer / sad 姿态 | 375–398，每个角色 2 段 | 0.4–2.3 s | — | 在角色旁循环 |
| 光柱、光束、时光倒流、传送 | 没有原版对应 | — | — | 沿用程序化 fx |

**`playFit` 的规则**
- 原长不超过预算：原速播放。
- 否则加速，速度上限 2×；仍超出时按目录里的 trim 截取，最后仍超出就均匀跳帧。
- 音效与首帧同步（原版在首帧由 0x452a83 播放）。
- signal 中止时直接落到终态。

**摆放方式**
- 440×440 的 FLIC 在原版里贴在棋盘视窗 (0,40) 处，镜头已经对准目标。我们的 handlers 本来就先 `focus()`，所以把 FLIC 当作屏幕层叠加：中心对准锚点投影位置，按镜头缩放倍率放大。

**可选：原版节奏**
- 房间设置 `pacing: 'standard'|'classic'`，classic 时用一张加长的预算表，服务器截止时间随之延长。
- 需要改 shared/view/pacing 和服务器（很小），列为用户决策。

### 3.6 小游戏三个场景

- 三个 sim 本来就用原版 640×480 坐标：财神 y=126、x 在 110..530，企鹅菱形格半宽 48、半高 24。原版素材可以按原坐标直接摆放，**sim 和 golden 完全不动**。
- 做法：为每个游戏新增一个实现 `MinigameView` 接口的 `origView.ts`，由宿主按皮肤选择。

| 游戏 | 素材 |
|---|---|
| 共用 | 入场 Panel#78「READY GO」FLC，640×480，20 帧 × 114 ms |
| 企鹅挖宝 | Panel#80–90；命中掩膜 Panel#81；BGM track22；音效集 {11,12,13,14,16,17,18,15} |
| 七彩气球 | Panel#91；BGM track21；音效集 {19,20,21} |
| 喜从天降 | 背景 Panel#92（RAW16 640×480）、93–111；被炸爆炸借用 Data#485（fcn.00414f20 @0x415016 载入、fcn.00412b66 @0x412d2b 播放）；BGM track20；音效集 {22,23,24,15} |
| 结算 | PLAY AGAIN 与数字 Panel#112；Q 版小人 Panel#27–62；共用音效 {25,26} |

- 手机横屏：4:3 舞台按 390 高缩放，也就是 520×390，与现有宿主一致。
- 顺带解决：V-R18（宝物图标与名称对照）可以直接从原版图认出。

### 3.7 音频（`apps/client/src/audio/`，同时完成 M10 的 AudioEngine）

**AudioEngine**：按 client.md §7.1 自研。
- 四条总线 bgm / sfx / voice / ui，iOS 由手势解锁。
- BGM 用 `<audio>` + MediaElementSource 流式播放；SFX 和语音用 AudioBuffer，按组预载。
- 播放语音时 BGM 压低 6 dB。

**BGM 调度（与原版一致）**
- 棋盘曲轮播 track02..09，`idx = (cur+1)&7`，一曲放完接下一首，不循环。
- 场景曲用 `<audio loop>`，文件已预先裁掉首尾静音。
- 进入场景时把棋盘曲当前位置压栈，离开后从断点续播（对应原版 0x47c5fb）。
- 场景与音轨：

| 场景 | 音轨 | 场景 | 音轨 |
|---|---|---|---|
| 标题 | 10 | 开局设置 | 11 |
| 破产 | 12 | 银行 | 14 |
| 拍卖（含破产分支） | 15 | 商店、乐透投注、结算 | 16 |
| 魔法屋 | 17 | 乐透开奖 | 18 |
| 月结 | 19 | 喜从天降 / 七彩气球 / 企鹅挖宝 | 20 / 21 / 22 |
| 圣诞 | 23 | 农历新年 | 24 |
| 监狱 | 25 | 医院 | 26 |

- track13 没有任何引用，不使用。

**SFX**
- 按场景预载音效集：
  - 全局 UI {0,1,2,4,3}；
  - 棋盘 {7,9,10,32–38,43–50,53–56,15,62}；
  - 开局设置 {5}、股市 {40,41}、分红 {61}、投注 {31}、开奖 {57,58}；
  - 魔法屋 {39}、月结 {27,28,60}、拍卖 {29,63}、数字输入 {51}/{52}。
- FLIC 同步音效 80–114 见 3.5。
- `soundMap.ts` 从「SfxId 名称」改为「原版音效号，或 ZzFX 回退预设」，并继续对 GameEventType 穷举。
- 0–63 号里每个音效的具体语义，要在 A3/A9 结合 131 处已解析的调用点上下文（`sfx-callsites.v206.json`）和试听页来标注。

**语音**

| 类别 | 编号规则 / 区段 |
|---|---|
| 事件槽 | 1050+27c+slot |
| 道具台词 | 234+16c+k |
| 卡片台词 | 426+52c+k |
| NPC | 商店 0–10、乐透 11–35、魔法屋 36–57、银行 75–91、月结 93–122、医院 123–130、拍卖 132–148 |
| 新闻播报 | 149–233，按 voice-map 对应 |

事件槽的触发（门槛与概率按 r_minigames_chars §2.4）：

| 情境 | 槽 |
|---|---|
| 开局 | 26 |
| 得点券：>100 / 51–100 / 1–50 | 0 / 1 / 2 |
| 进账：≥9000×PI / 5000–9000 / 2000–5000 | 6 / 7 / 8 |
| 小额支出 | 3–5 |
| 付钱（分档同进账） | 9–11 |
| 罚款、医药费 | 12–14 |
| 盖到 5 级 | 15 |
| 买地后同街独占 ≥3 块 | 16 |
| 在独占街区加盖（1/3 概率） | 17 |
| 被最敌对的玩家拿走 ≥5000×PI（1/2 概率） | 18 |
| 坐牢 / 住院 / 梦游 | 19 / 20 / 21 |
| 坏神附身 / 坏神离身 | 22 / 23 |
| 胜利 / 破产 | 24 / 25 |

- 需要随机的场合（1/3、1/2、二选一）用 `hash32(batch.toVersion, 事件下标, seat)` 取值，保证所有客户端和观战者听到同一句。
- 语音不阻塞演出：新语音打断同一角色的旧语音。
- 讲话气泡配表情头像（map#15+c 图1–4）显示 1–1.5 秒。
- 44.1 kHz 的 190 段（忍太郎、宫本宝藏）不用特殊处理。
- 没有素材包时：音效回退到 ZzFX 最小集，语音静默（voiceBabble 不再作为优先项）。

---

## 4. UI 路线

### 4.1 三条路线对比

| 维度 | A：原版 640×480 固定布局 | B：保留 React 布局，全面换皮 | **B+：混合（推荐）** |
|---|---|---|---|
| 原味 | 最高 | 中 | 主界面中高，场所屏高 |
| 聊天、观战、倒计时、托管 | 只能挤到 4:3 舞台两侧 | 天然兼容 | 天然兼容 |
| 手机横屏 844×390 | 缩放 0.81，40px 钮变 32px，12px 字变约 10px | 好 | 主界面好；场所屏 0.81 倍，交互控件用 React 放大到 ≥44px |
| 改造面 | 重写整个决策对话框体系 | 只换样式 | 换样式 + 约 11 个场所屏逐屏上线 |
| 工作量 | 8–10 周 | MVP 1.5–2 周，完整 4–6 周 | 约 3–4 周（A10 + A11） |

**推荐 B+ 的理由**
- 现有决策流程、倒计时、观战、托管、断线等联机能力都在 React 里，而且已有 E2E 覆盖。B+ 不动这些逻辑，只换视觉。
- 场所屏是原版「味道」最浓的地方，用原版 640×480 场景来做收益最大。
- A 可以作为后续可选的「桌面经典布局」模式（A15），不做默认。

### 4.2 主 HUD 换皮对照（B）

| 现有组件 | 原版素材 |
|---|---|
| TopBar | 日历 Panel#2（四季风景、月历、太阳/月亮钮）；节日当天换成 Data#4–86 节日图 |
| PlayerPanel | 侧栏 Panel#0 图0–3（資金/地產/股票/其他四页，青/蓝/红/金页签）；头像 Data#2（72×72）。数值仍用 DOM 文字 |
| ActionPad | 工具列图标 Panel#1（常态 1–11、悬停 12–22）；GO 钮 Panel#7（含禁用和乌龟态；命中掩膜 Panel#8） |
| DiceOverlay | 滚骰用 Panel#4/5/6 FLIC，定格用 Panel#3 |
| 数额输入 | 计算器 Panel#21（命中掩膜 Panel#22） |
| 确认框 | YES/NO：Data#399 + 消息框 Data#476 图5 |
| CardTile | 卡图 Data#530–559；卡片欄 Panel#11 图0；道具 Panel#11 图2–14、Panel#74 |
| GodBadge | 神明小像 Panel#9 图13–24 |
| 讲话 / 聊天头像 | map#15–26 表情；emote 可映射到金貝貝表情 Data#478 |
| 新闻 / 命运弹窗 | 新闻板、命运板 Panel#66 + 插图 Data#400–475 |
| 通用框与按钮 | 9-slice：Panel#25 图2、Panel#26 图2、Panel#23 图22、Data#476 图5/6 |

**9-slice 的限制**（ui 调研已实测）：
- 中间是十字花图案的框必须用 `border-image-repeat: round`，不能拉伸；
- 宝石消息框顶部饰件居中，只能做 3-slice；
- 侧栏页里的行图标已经烘焙进图，要先拆层再用。

**实现方式**
- 根元素加 `data-skin="original"`；`ui/theme/skins/original.css` 用 CSS 变量注入 `url()`，地址在运行时由 manifest 解析。
- 组件（Panel、Button、Modal、CardTile、Avatar、Money）增加皮肤变体，不改结构。
- 选人页：头像 Data#2，预览动画用 jump#5+3c+v 的侧视走动。

### 4.3 场所屏（B+ 模态，新目录 `ui/venues/`）

**`Stage4x3` 组件**
- 640×480 逻辑坐标，按容器 letterbox 等比缩放，整数倍时用 pixelated。
- 每层（底图、立绘、按钮帧）按原坐标、原锚点绝对定位。
- 热区有两种：矩形，以及掩膜（8 位灰度 PNG 经 canvas `getImageData` 查区号）。
- 数值、名称用 React 文字叠加。

**逐屏上线**：每个场景复用对应对话框的状态与 submit 逻辑（抽成 hook），只换表现层；没有素材包时回退到原对话框。

| 场景 | 资源 |
|---|---|
| 银行 | Panel#23；ATM Panel#24 |
| 百货 | Panel#10 |
| 乐透投注 | Panel#12，跑马灯 Panel#14 |
| 乐透开奖 | Panel#15/16/17 |
| 魔法屋 | Panel#18/19/20 |
| 拍卖 | Panel#26 |
| 股市 | Panel#75/76 |
| 公佈欄 | Panel#73 |
| 资产表 | Panel#9 |
| 月结 | Panel#25 |
| 监狱 / 恶人 / 医院 | Panel#63 / #64 / #65 |
| 神明老虎机 | Panel#67 |
| 轮盘 | Panel#68–71（航空 / 旅馆 / 购物中心 / 保险，按盘面核对） |

**各屏坐标来源**：从 exe 各界面函数的常量（oama 文档可以当事实参考），并对照 ui 调研的样稿 `mockup-main-640x480.png`。每屏估 1–2 天。

### 4.4 联机信息怎么兼顾

- **聊天、观战栏、断线遮罩、托管徽标**：保留 React 组件，换上原版框。
  - 托管入口用工具列的「托管灯泡」钮，设置界面用 Panel#77 的托管 AI 对话框（12 个圆头像）。
- **倒计时**：DecisionFrame 的圆环照旧；在场所屏里叠在 4:3 舞台右上角，最后 5 秒变红并滴答。
- **其他玩家与观战者**：看到的是 WaitingBanner（例如「钱夫人 正在银行…」），附场所缩略图。场所屏只对决策者本人弹出，与原版单人交互一致。
- **头顶气泡**：沿用 §20.4 的接通方式，外观换成 Data#476 讲话框。

### 4.5 手机横屏

- 844×390 下右栏 200px，正好等于侧栏 Panel#0 的原生宽度，可以 1:1 显示。
- 工具列按钮原生 40×40，四周加 2px 热区补到 44px。
- 场所屏按 520×390 显示；滑条、步进器等关键控件用 React 放大到 ≥44px，叠在原版底图上。
- 竖屏仍然只提示旋转（沿用既定决策）。

### 4.6 字体

- 原版用系统的「細明體」，**不能分发**。
- 推荐字体栈：`local('MingLiU')` / `local('PMingLiU')` → Noto Serif TC 或思源宋体 TC（OFL，按字形分片加载）。
- 描边用 8 方向 1px 的 `text-shadow` 模拟原版 bit0 描边样式；粗体用 700。
- 最像原版点阵观感的是文泉驿点阵宋体，但它是 GPL + 字体例外，列为用户决策。
- 原版图片里有繁体字，界面文字仍是简体 zh-CN。是否整体切到繁体，也列为用户决策。

---

## 5. 服务器：提供与访问控制

### 5.1 配置（`apps/server/src/config.ts` 增加）

```
RICH4_ASSETS_DIR=/assets-rich4     # 只读；目录里有合法的 manifest.json 才启用
RICH4_ASSETS_VERIFY=quick|full     # quick 只校验结构与文件存在；full 在启动时逐文件复算 sha256
ACCESS_MODE=off|passcode|invite    # 启用素材包且非回环监听时，off 被拒绝（ConfigError）
ACCESS_PASSCODE_HASH=scrypt$N$r$p$salt$hash   # 由 npm run access -- hash 生成，不存明文
ACCESS_SECRET=<≥32 字节>           # cookie 签名；更换即让全部会话失效
ACCESS_TTL_DAYS=30  ACCESS_GRANTS=1  # 允许已通过门禁的玩家为房间邀请生成临时授权
```

**启动守卫**：`RICH4_ASSETS_DIR` 已启用、`ACCESS_MODE=off`，并且 HOST 不是 127.0.0.1 或 ::1 时，抛出 ConfigError：「启用原版素材时必须设置访问口令或邀请制」。

### 5.2 `/pack/*` 路由（新文件 `http/pack.ts`、`assets/PackRegistry.ts`）

- **路由前缀用 `/pack/`，不用 `/assets/`。** 原因：Vite 构建产物本身就在 `/assets/*`，而且 `http/static.ts` 已经对 `/assets/` 设置了 `public, immutable` 缓存，两者会冲突。
- **白名单**：只提供 manifest 里列出的路径，其他请求一律 404，从根上杜绝目录穿越和泄露杂散文件。
- **响应头**

| 对象 | 头 |
|---|---|
| 带哈希的文件 | `Cache-Control: private, max-age=31536000, immutable` |
| manifest | `private, no-cache`，ETag = packId |
| 全部 | `X-Content-Type-Options: nosniff`、`Cross-Origin-Resource-Policy: same-origin`、`X-Robots-Tag: noindex, nofollow, noarchive` |

- 音频、视频支持 Range（206）。
- `.flc` 与 `.json` 在 Accept-Encoding 允许时返回预压缩的 br/gzip，并带 `Vary: Accept-Encoding`。
- 服务器**不做任何解码**，也不需要 ffmpeg。

### 5.3 访问控制

**门禁范围**
- 当 `ACCESS_MODE != off` 时，`/pack/*`、`/api/*`（`/api/access*` 除外）、Socket.IO 握手都要求带访问 cookie。
- `/healthz`、`/readyz` 和 SPA 外壳页保持公开。外壳页只含我们自己的代码，用来显示门禁界面。
- `robots.txt` 返回 `Disallow: /`。

**口令模式（推荐）**
- `POST /api/access {passcode}`：服务器用 scrypt 常数时间比对，通过后写 cookie。
- cookie：`r4_access=v1.<exp>.<epoch>.<kind>.<HMAC>`，属性 HttpOnly、Secure（PUBLIC_URL 为 https 时）、SameSite=Lax、Path=/。
- 防暴力：每个 IP 每分钟 5 次，超出锁 15 分钟，并记录日志；口令本身永不写日志。

**房间邀请授权**（`ACCESS_GRANTS=1`）
1. 已通过门禁的玩家点「复制邀请链接」，客户端调用 `POST /api/access/grant {room}`。
2. 服务器生成 24 小时有效、最多用 8 次的授权，放在链接的 URL 片段里：`/r/ABCD#g=<token>`。片段不会发给服务器，也不会进 Referer 和访问日志。
3. 受邀者的门禁页读出片段，调用 `POST /api/access/redeem` 换取 cookie。
4. 效果：朋友不需要知道口令也能进来，而且授权会自动过期。

**邀请模式**
- 管理员用 `ADMIN_TOKEN` 或 `npm run access -- invite --uses 5 --days 7` 生成邀请码，存在 DATA_DIR 的 sqlite 表 `access_invites` 里，可以撤销。
- 在 `access_meta` 里 epoch + 1 就能让全部 cookie 失效。

**前端**
- 收到 401 且错误码为 `ACCESS_REQUIRED` 时（shared/net 需要新增这个 ErrorCode），显示 `AccessGate` 页。
- Socket.IO 握手在 `io.use` 中间件里校验 `handshake.headers.cookie`，失败时返回 `ACCESS_REQUIRED`。

**零代码备选**：Caddy `basic_auth` 包住整站。缺点是手机上体验差，而且不支持房间授权，只作为临时方案。

### 5.4 Docker 与部署

- compose 的 `app` 服务增加挂载 `../rich4-assets:/assets-rich4:ro`（可选，目录不存在时注释掉），环境变量 `RICH4_ASSETS_DIR=/assets-rich4`、`ACCESS_MODE=passcode`。
- 镜像里**绝不 COPY** 素材包。`.dockerignore` 增加 `rich4-assets`、`**/*.flc`。
- Caddy 不缓存 `/pack/*`，只做透明反代。
- 发布流程写进 `docs/deploy.md`：
  1. 在本机执行 `npm run extract -- assets build && npm run extract -- assets verify`；
  2. `rsync -a rich4-assets/ server:/srv/rich4/rich4-assets/`，目录权限 0750，属主为运行用户；
  3. 设置 `ACCESS_PASSCODE_HASH` 与 `ACCESS_SECRET`。

### 5.5 守卫扩展

**`scripts/check-no-original.ts`**

路径规则：
- `rich4-assets/` 下的任何文件；
- `*.flc`、`*.fli`。

内容规则：
- PNG 带 tEXt `rich4:derived`；
- Ogg 或 m4a 带 `RICH4_DERIVED`，MP4 带 `rich4-derived`；
- JSON 的 schema 为 `rich4.assets/1` 或 `rich4.mapskin/1`；
- 文件以魔数 `SPR\0`、`SMP\0`、`GND\0` 开头；
- FLC 判定：u16@4 == 0xAF12 且 depth == 8；
- RIFF WAVE 的 ISFT 为 GoldWave 或 Awave 时，只告警。

哈希禁单：本机存在 `rich4-assets/manifest.json` 时，把其中所有 sha256 并入 `bannedHashes`。这样即使文件改名后被拷进仓库，也能拦下。

**镜像扫描**（M11 验证项扩展）

```
find / -xdev \( -iname "*.mkf" -o -iname "rich4.exe" -o -name "taiwan.map.json" -o -path "*rich4-assets*" -o -iname "*.flc" \) | wc -l
```
- 结果应为 0。
- 另外对镜像里的 png/ogg/m4a/mp4 执行 `grep -rl 'rich4:derived\|RICH4_DERIVED\|rich4-derived'`，结果也应为 0。

**`check:bundle`**：`apps/client/dist` 里不得出现上述标记，首屏 JS gzip 后仍不超过 450 KB（素材包不经过打包器）。

---

## 6. 测试策略

### 6.1 CI（没有原版文件）

**合成素材包**：新增 `scripts/gen-fake-pack.ts`，复用 extract 的 PNG 编码器、装箱器和 manifest 写入器。
- 生成结构完全合法的假素材包：彩色块加帧号的精灵、静音音频、手工构造的小 FLC、合成的 skin.json。
- 客户端 browser 测试和 E2E 都能用它在 CI 里走一遍原版皮肤的代码路径，同时也端到端测试了写入端。

**extract 单测**
- LZHUF：用测试专用的自写编码器生成比特流做往返测试；另测提前结束、回溯越界、截断三种错误。
- SPR、SMP、GND、RAW16、FLC、WAVE 解析器：用合成文件测试。
- PNG：解码回去与原数据相等，且两次编码字节一致。
- 装箱器：property 测试（不重叠、不越界、结果确定）。

**client-unit**
- OrigProjection：用合成表测试仿射与求逆，以及 (sy,sx) 顺序、dy 在外层。
- 帧号公式：8 方向 × 8 视角的 64 种组合；建筑帧号公式。
- 深度键：`sy·16 + layer` 的排序。
- 皮肤判定矩阵：404、401、地图不匹配、正常四种情况。
- 语音与音效映射：用 `satisfies Record<GameEventType, …>` 检查穷举；确定性抽取（同一事件在不同客户端选到同一句）。
- FlcDecoder：合成的 BRUN、DELTA_FLC、COPY、COLOR_256 数据，结果逐像素相等。

**client-browser**（合成素材包）
- OrigRenderer 冒烟测试。
- `WEBGL_lose_context` 之后纹理能恢复。
- FLIC 播放不超预算。
- 用 realEngine 自对弈抽出的 1300 余个事件样本，跑一遍 OrigStage 的 handlers：不抛错，时长不超过 EVENT_BUDGET_MS。

**server**
- cookie 签名、过期、epoch 失效；scrypt；限流。
- `/pack` 白名单、目录穿越、Range、响应头。
- Socket.IO 拒绝、config 启动守卫、邀请授权的次数与过期。

**E2E**
- `access.spec.ts`：未授权 → 门禁 → 口令 → 进房。
- `skin-fallback.spec.ts`：没有素材包时不请求任何 `/pack/*` 以外的资源，画面与现有基线一致。
- `skin-original.spec.ts`：用合成素材包跑一整局 turn-cycle，4 个页面的 HUD 一致。

### 6.2 本机（有原版文件；产物放在 .cache，截图基线不入库）

**`*.local.test.ts`**
- 440/440 严格解压，bit15 统计为 0。
- kind 计数：Data 为 SPR 290 / RAW16 190 / FLIC 72 / SMP 9，与调研一致。
- 目录覆盖率 100%，帧数符合预期。
- 台湾 skin.json：103 个节点、21 个景观、17 个快艇节点。

**投影精度**
- 以每个节点为镜头，比较 ±14 格内的点：仿射结果与原版「查表 + 亚格」结果的最大差不超过 6.5 px（调研实测为 4.49–6.43 px）。
- 只比较格点时不超过 2.1 px。

**视觉**
- OrigRenderer 在视角 0/1/2/5、以台北、绿岛、中心为镜头时截图，与原型渲染 `board_v*_clean.png` 做对齐后比较差异。
- 基线存放在 `.cache/visual-orig/`，**不能入库**。

**小游戏掩膜对拍**：企鹅掩膜 Panel#81 的区号，与 sim 的 `pickCell` 在 640×480 的每个像素上逐点比较，必须一致。

**角色顺序核对**：Data#2 头像顺序与 D2 抽出的角色表名称、shared 的 `CHARACTER_KEYS` 对照。

**手工清单**
- 8 个视角各看一遍；快艇航线（台湾节点 25–29、99–103）上的姿态切换。
- 各神明降临 FLIC 与音效同步；场所屏逐屏检查；BGM 切场与续播。
- iOS Safari 与 Android Chrome 横屏各打一整局。

---

## 7. 里程碑（A0–A15）

估算单位为单人全职人日。关键路径是 A1 → A2 → A6 → A7；A3/A9、A4、A10/A11、A12 可以并行。

| ID | 内容 | 交付物 | 验证 | 人日 |
|---|---|---|---|---|
| A0 | 契约与决策记录 | `shared/src/assets/pack.ts`（类型、zod、ErrorCode `ACCESS_REQUIRED`）；architecture §21 草案（修订决策 4/5）；依赖规则补行 | typecheck；check:deps | 0.5 |
| A1 | 解码核心 | `mkf/lzhuf.ts`、container 扩展、`gfx/*`（rgb555、spr、smp、gnd、raw16、flc、wave、png、pack） | 合成单测全绿；本机 440/440 严格解压，kind 计数与调研一致；抽检 6 个资源的输出 sha1 与 `emu/results.txt` 一致 | 3 |
| A2 | 资源目录与图像素材包 | `catalog.v206.ts`、`assets/skin.ts`、`manifest.ts`；`extract assets build/verify/ls/preview` | 连续两次 build 的 manifest sha256 相同；verify 0 处不符；覆盖率报告 100%，未收录清单已输出；preview 联系表目视与调研样图一致（抽 20 项，比较 RGBA 哈希）；check:no-original 能拦下植入的派生 PNG | 5 |
| A3 | 音视频转码与映射表 | `assets/{audio,video}.ts`；voice-map、sfx-sets、flic-map、music-map；本机试听页 | 语音 1374、音效 99、音乐 25 个；时长误差 ±25 ms；同版本 ffmpeg 输出字节相同；新闻台词自动匹配 ≥90%，其余进 overrides | 3 |
| A4 | 服务端提供与访问控制 | `config.ts` 字段；`assets/PackRegistry.ts`、`http/pack.ts`、`http/access.ts`、`net` 握手守卫；`scripts/access.ts`；`.gitignore`、`.dockerignore`、check-no-original 扩展；compose 挂载示例 | server 单测与集成测试（见 6.1）；`access.spec.ts`；本机 curl：无 cookie 返回 401、有 cookie 返回 200 与正确头、Range 返回 206 | 3.5 |
| A5 | 前端素材包加载、回退与 FLC 播放器 | `skin/{pack,flic}/**`、skinStore、设置页选项、BoardSurface 接缝、vite `/pack` 代理 | 回退矩阵单测；FlcDecoder 合成用例逐像素一致；本机 105 段 FLC 帧数等于头部 frames，除 Panel#20 末帧外与 ffmpeg 解码逐帧一致 | 3 |
| A6 | 原版棋盘（静态） | `game/orig/{OrigProjection,OrigRenderer,OrigBoardView,depth,picking,markers}.ts`；8 视角旋转；原版小地图 | 投影精度（见 6.2）；截图对比；帧号与深度单测；桌面 60 fps，地面 4 个 draw call | 5 |
| A7 | 原版角色与行走 | `OrigActor.ts`（21 套姿态库、8 方向、快艇、状态、气泡）；PARACHUTE 用 518–529 | 64 种方向组合单测；本机 turn-cycle 4 人对局；`?bench=1` 帧时间 p95 < 20 ms；角色顺序核对 | 4 |
| A8 | 原版舞台与 FLIC 特效 | `OrigStage.ts`（完整实现 StagePort，无原版对应的委托程序化）；`playFit`；`/dev/fx?skin=original` 画廊 | browser 测试跑 realEngine 事件样本，无错且不超预算；每个 StagePort 方法都有原版实现或显式回退（测试断言）；本机逐项目视 | 4 |
| A9 | 音频引擎与原版音频 | `audio/{AudioEngine,bgm,sfx,voice}.ts`；soundMap 改为原版音效号；ZzFX 回退 | 穷举与确定性单测；假 AudioContext 下测调度、压低、续播栈；E2E 断言 `__rich4.audio.log`（开局依次播 1050+27c+26，进银行切 track14，离开后续播误差 ≤0.5 s）；iOS 与 Android 手测 | 4.5 |
| A10 | 主 HUD 换皮（B） | `ui/theme/skins/original.css`、各组件的皮肤变体、DiceOverlay 改 FLIC、计算器、卡片与道具、新闻和命运弹窗、字体、选人页 | dom 测试（`data-skin` 切换）；CI 程序化视觉基线不变；mobile-layout E2E（合成素材包，触控目标 ≥44px）；本机截图 | 6 |
| A11 | 场所屏（B+） | `ui/venues/{Stage4x3,Hotspots}` + 11 个场景 | 每个场景用 realEngine 选项跑 dom 测试（合成素材包）；掩膜热区单测；本机 bank-stock E2E；观战者 WaitingBanner 检查 | 10 |
| A12 | 小游戏原版皮肤 | 三个 `origView.ts`、入场 FLC、BGM 与音效集 | `test:browser -- -t crossEngine` 的 golden 不变；minigame E2E（合成素材包）；企鹅掩膜逐像素对拍；桌面与 844×390 手测 | 4 |
| A13 | 片头、过场与视频（可选） | Start、End、Over、Fly* 的 MP4 播放器（可跳过）；开局全屏跳伞 jump#41–66；标题 Data#1；Loading Data#560 | 跳过行为测试；不影响服务器计时（只在客户端，不占事件预算）；手测 | 2 |
| A14 | 收尾 | WebGL 上下文恢复、显存预算与卸载、check:bundle、镜像扫描、`docs/deploy.md`、§21 定稿、VERIFY 与 DEVIATIONS 更新 | `npm run check` 全绿；镜像扫描为 0；E2E 全绿；24 小时运行 | 2.5 |
| A15 | 桌面经典 640×480 主画面（可选，路线 A） | `ui/classic/`：工具列 + 440×440 视窗 + 侧栏；聊天和观战放在两侧 | 手测，E2E 冒烟 | 8–10 |

**合计**
- A0–A14 约 60 人日。
- **MVP**（原版棋盘、角色、音频、访问控制；UI 暂用现有外观）为 A0–A7 加 A9，约 31.5 人日。
- 按 3 条轨道并行（管线与服务器 / 棋盘 / UI 与音频），日历时间约 4–5 周。

### 7.1 与现有里程碑的关系

| 里程碑 | 状态 | 被替代的部分 | 保留或调整的部分 |
|---|---|---|---|
| M6 对抗系统 | 已完成 | 无（handlers 与规则不动） | 程序化 fx 作为回退；A8 通过 StagePort 加一套原版实现；CardTile 与道具图标在 A10 换皮 |
| M7 事件与收尾 | 进行中（引擎的恶人、拍卖等尚有占位） | 无 | A11 的魔法屋、拍卖、公佈欄、新闻和命运场景，等 M7 对话框稳定后包一层；原版插图可以帮助核对新闻与命运文案 |
| M8 小游戏 | 已完成 | 无 | sim、裁判、宿主不动；A12 只加视图实现；V-R18 可以由原版图直接解决 |
| M9 台湾图核实 | 待做 | — | A6 的原版底图天然可作对照：节点、地块框、景观位置一眼可见，建议 M9 放在 A6 之后 |
| M10 体验打磨 | 待做 | 「程序化美术迭代」冻结，只修 bug；CC0 BGM 和 SFX 选曲、voiceBabble 取消，只保留 ZzFX 回退 | AudioEngine 由 A9 完成；横屏细节、画质三档、上下文恢复、性能、完整 E2E、Credits 保留；视觉回归拆成 CI 程序化基线加本机原版基线 |
| M11 部署 | 待做 | — | 增加素材包只读挂载、访问控制、镜像扫描扩展、deploy.md 素材包发布流程 |
| D1/D2 提取 | 已完成 | — | A1–A3 扩展同一个 CLI；复用 tables.v206.json 的 view 表和 raw 地图字段（decor、spriteRes、facing、景观 x/y） |

---

## 8. 需要修正的现有文档与注释（只报告，没有改）

1. `tools/extract/src/exe/types.ts` 的 ViewTables 注释和 `docs/VERIFY.md` V-E10 把 cellScreen 写成「dx 外层、(x,y)」，**两处都反了**：实际是 dy 外层、(sy,sx)。drawOrder 的字节对是 (dy,dx)，subcell 算出的是负的偏移，要做减法。只修一处，棋盘会沿主对角线镜像。
2. `docs/research/r_references.md` §3 和 oama 注释里说投影是「透视，误差 15–44 px」，不成立。它就是仿射加取整噪声。
3. `docs/research/r_minigames_chars.md` §2.4 把 426–1049 说成「卡片和道具」。按 exe 台词文本，道具是 234+16c+k，426+52c+k 只是卡片。
4. `docs/research/g_map.md` 里的「缩略图 16+id」只适用于 v3.11；v2.06 是 8+id。MapDat.MKF #1、#2 与 map.mkf #3、#5 内容不同（台湾图不受影响）。
5. `docs/architecture.md` §0 决策 4、5，以及 `docs/design/client.md` §3.2（原版皮肤的投影）、§6、§7.2（素材来源）需要按本方案修订。§9.2 的环境变量和 §9.3 的 compose 也要同步。

---

## 9. 本方案引用的证据文件（本机，均在 gitignore 目录或 test/ 下）

- 容器与解压：`<repo>/.cache/assets-research/mkf-index/{_summary,_validate,_ranges}.json`、`.../emu/results.txt`、`<repo>/test/lzhuf-proto.ts`
- 精灵目录：`.../sprite/catalog-v206.json`、`.../samples/contact/*.png`（例如 `chars-c0-walk-8dir.png`、`buildings-4maps-5lv-8dir.png`、`gods-objects-355-372.png`）
- 渲染：`.../render/{projection-fit.v206.json,render-model.json,render-proto.report.json,board_v0_center.png,taiwan_view0_third.png,dircheck_view0_x3.png}`、`<repo>/test/render-proto.ts`
- 音视频：`.../audio/{audio-manifest.v206.json,speaking.manifest.json,sfx-tables.v206.json,sfx-callsites.v206.json,flic.index.json}`、`.../video/all/video-convert.json`
- UI：`.../ui/{ui-manifest.json,samples/mockup-main-640x480.png,samples/nineslice-demo.png}`


## user_decisions_needed
- 素材基准版本：v2.06（推荐。original/Game 里文件齐全，本方案的编号都按它）还是 v3.11（需要把 Steam 的 MultiverseJourney 目录下 Data、Panel、Speaking 等只读拷贝过来；它的消息框更大、有 NEW STAGE，但 Data 从 87 号起整体偏移 +41，而且引擎目前只支持台湾图）。
- UI 路线：B+ 混合（推荐。主 HUD 保留 React 布局换原版素材，银行、商店、乐透等场所屏做成 640×480 原版模态场景），还是 A 原版 640×480 固定布局，或 B 纯换皮。另外，是否追加可选的「桌面经典主画面」模式（A15，约 8–10 人日）。
- 访问控制形式：共享口令，加上已登录玩家可生成 24 小时房间邀请授权（推荐）；或管理员发放的邀请码制；或临时用 Caddy basic_auth。门禁范围是否按推荐覆盖整站（/pack、/api、Socket.IO 都要求授权，只有外壳页公开），还是只保护 /pack。
- 启用素材包但没有配置访问控制、且服务监听在非回环地址时，服务器是否直接拒绝启动（推荐：拒绝，只允许本机回环例外）。
- 演出节奏：默认按现有事件预算，把原版 FLIC 加速或截取以适配（推荐，例如救护车原长 6.2 s，要压进 CONFINED 的 1.5 s）；还是另加一个房间选项「原版节奏」，加长预算，服务器决策截止时间也随之变长（需要小幅改 shared/view/pacing 和服务器）。
- 原版角色语音是否默认开启（推荐默认开启，音量单独调节）；卡片和道具使用台词、NPC 与新闻播报是否也播放。
- 视频：是否提取片头、片尾、飞机过场的 AVI（需要把 Steam 的 Media/*.avi 只读拷贝到 original/Media/；v3.11 的 END01–12 结局动画需要 v3.11 文件）；开局是否默认播放片头（推荐：可跳过，默认只在第一次播放）。
- 音频格式：Opus 为主、AAC 回退（推荐，兼顾 18.4 以前的 iOS Safari），还是只用 Opus；音乐重新编码为约 29 MB（推荐），还是直接提供原始 OGG（约 116 MB）。
- 字体：本机細明體 local() 加思源宋体或 Noto Serif TC（OFL）回退（推荐）；还是用观感最像点阵的文泉驿点阵宋体（GPL 加字体例外，与「不复用 GPL」的原则有张力）。原版皮肤下界面文字是否改成繁体（原版图片里都是繁体字）。
- 像素缩放：默认整数倍最近邻、非整数倍平滑（推荐）；是否另外提供 xBR 或 AI 超分（不推荐放进 MVP）。
- 是否冻结 M10 的程序化美术迭代，只做回退维护和 CI 基线（推荐冻结），同时取消 CC0 BGM 选曲和 voiceBabble 咕哝音。
- 原版皮肤下地产的主人色：用座位色，与 HUD 和色弱标记保持一致（推荐）；还是用原版角色色。
- fixture 地图或其他没有原版底图的地图：保持全程序化（推荐）；还是程序化棋盘搭配原版角色精灵（投影不同，观感会不协调）。
- 是否做「像素级精确投影」模式（按原版 cellScreen 表建 29×29 网格贴图，与原版逐像素一致），还是只用仿射近似（推荐默认。与原版查表结果差 2–6 px，肉眼难以分辨）。

## risks
- 版权与分发：即使仅供私人和朋友使用，把原版素材派生后放在联网服务器上仍有法律灰区。一旦访问口令外泄、邀请授权被转发，或者 Caddy、CDN 误缓存，素材就会暴露到公网。缓解措施：整站门禁；响应一律 private、noindex、CORP same-origin；授权 24 小时过期、有次数上限；通过 epoch 一键吊销；镜像和仓库双重守卫；manifest 标注 license=private-personal-use。
- 资源语义还有缺口，可能用错素材。缺口包括：Data 482–498、511–529 部分 FLIC（核弹是 487 还是 489、516 等）；角色姿态 k=9–12；神明 FLIC 504–506 分别对应哪位；命运插图 436–475 与 37 条命运的映射；Effect 0–63 各号的具体动作；Speaking 中 33 个找不到台词文本的编号。缓解措施：目录逐项标注置信度（exe/visual/guess），guess 项默认走程序化；靠试听页和调用点上下文逐步补齐。
- 仿射投影与原版逐格查表之间有 2–6 px 偏差，精灵和底图中画好的元素（路口圆盘、地块框）可能出现轻微错位，缩放到 3 倍时更明显。缓解措施：本机做投影精度测试和截图对比；必要时实现精确表模式。
- 原版 FLIC 大多比现有事件预算长（神明降临 1.2–3.5 s，预算 1.5 s；救护车 6.2 s，预算 1.5 s；圣诞 7.65 s，预算 2 s）。加速或截取会损失原味；如果改用原版节奏，每局会明显变慢，而且要改 shared 的 pacing 和服务器超时。
- 移动端性能与流量：地面约 21 MB 显存；每个角色全部姿态约 8 MB；440×440 FLIC 逐帧解码并上传纹理；首局下载 10–15 MB。缓解措施：按姿态库和场景懒加载，离开对局时卸载，FLIC 只保留一张画布纹理，画质档低时降低 FLIC 帧率。
- iOS 与 Safari 音频：Ogg Opus 从 Safari 18.4 起才支持（这一点来自网络检索，尚未在真机验证），旧设备要依赖 AAC 回退；自动播放需要手势解锁；静音键行为；`<audio loop>` 在循环点可能有微小缝隙。
- 测试盲区：原版皮肤的截图基线含有原版素材，不能入库，CI 只能用合成素材包覆盖代码路径。视觉回归只能在本机做，容易被忽视。
- 确定性：ffmpeg 升级后音视频输出字节会变，manifest 哈希随之变化，导致浏览器缓存失效。图像和 JSON 由自写编码器保证字节确定；音视频只做参数级校验。
- 编号版本陷阱：公开项目和文档里的资源号多数是 v3.11 的（Data 从 87 号起 +41，小地图 16+id，讲话头像 27+c），直接照抄到 v2.06 会整体错位。另外，现有 ViewTables 注释和 VERIFY V-E10 把投影表轴序写反了，按那个写法实现，棋盘会沿对角线镜像。
- 并行开发冲突：另一个工作流正在修改 apps/、packages/、tools/、docs/。本方案虽然尽量放进新目录，但接缝处（BoardCanvas、settingsStore、GameScreen、config.ts、io.ts、check-no-original、soundMap、vite 代理）仍可能与之冲突，需要在集成时统一合并。
- 场所屏逆向的工作量不确定：各屏的热区和文字坐标要从 exe 常量或样稿逐屏核对，11 个场景按每屏 1–2 天估算，可能超出。
- 繁简混排：原版图片里有繁体字（如资金、地产页签、按钮文字），界面文字是简体，观感不统一。改成繁体又要增加 zh-TW 语言包的维护成本。
- 素材包与地图数据绑定：台湾 MapDef 重新构建后 dataHash 会变，skin.json 必须同步重建，否则前端会整体回退到程序化棋盘，看起来像是「皮肤失效」。
- 代码许可：本地同时存在 GPL 或无许可证的参考项目，生产代码必须只从我们自己在 test/ 下的原型移植。需要代码审查确认没有复制外部代码或数表（LZHUF 表按规则生成，并已与用户自有 exe 核对）。