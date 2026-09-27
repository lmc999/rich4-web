# 原版地图渲染模型（v2.06 为主，v3.11 对照）

## 0. 结论速览
- 地面不是一块块等角菱形图块，而是一整张 **2304×2304 的正射（俯视）底图**：72×72 块，每块 32×32，8bpp，配 RGB555 调色板。**世界坐标 (x,y) 就是底图像素坐标**。
- 原版逐格查投影表 `T[view][dy][dx]`，把每格四角映射到屏幕，再按扫描线把 32×32 图块贴成四边形。
- 投影实质上是**仿射**：旋转 θ = −22.5° + 45°·view，每格 38.95 px（1.217 px/世界单位），纵向压缩 0.7086（≈cos45°），再加取整噪声。拟合结论：
  - 带常数项的仿射拟合，全表最大误差 1.8–2.0 px，均值 0.7 px；
  - 单应（透视）拟合的透视系数 |h31|、|h32| < 2e-5；
  - 因此**不是透视投影**，oama 注释里“透视、误差 15–44 px”的说法不成立。
- 物体投影：`屏幕 = (220,260) + o(镜头) − o(物体) + T[格差]`。
  - `o` 是亚格偏移，由 2×2 int8 矩阵求出；
  - (220,260) 是棋盘区 (0,40)–(440,480) 的中心，也就是棋盘局部坐标 (220,220)。
- 深度排序：键为 int16 `((sy&0xfff)<<4)|layer`，按升序画。
- 建筑图号：`(8−(facing+view))&7`。
- 棋子图号：`((8−view+dir)&7)·(帧数/8)+动画帧`。
- 以上全部用 radare2 读 v2.06 fcn.00407ebd 等函数得出，并已用自写原型渲染核对。

## 1. 地面

### 1.1 GND 资源
位置：map.mkf 资源 `gm*2`，两版相同。MKF 头为 (5319312, 5319312, imgOff=16, imgSize=512)。

| 偏移 | 内容 |
|---|---|
| 0x00 | `'GND\0'` |
| 0x04 | u16 tilesW = 72 |
| 0x06 | u16 tilesH = 72 |
| 0x08 | u32 5184 |
| 0x0C | u32 0 |
| 0x10 | 256×u16 RGB555 调色板。MKF 头的 imgOff/imgSize 就指向这 512 字节，载入时转成显示格式；RGB565 解出来是噪点，已目视否定 |
| 0x210 | 72×72 u16 排布表 |
| 0x2A90 | 5184 块 × 1024 字节，块内行主序 |

- 排布表：Game 版 4 张图、MultiverseJourney 版 8 张图全部是恒等映射 0..5183。
- 块内行主序：行 = 世界 y，列 = 世界 x。
- 总长 16 + 512 + 10368 + 5308416 = 5319312。
- v2.06 的 GND0..3 与 v3.11 逐字节相同。

**排布表在哪里**：就在 GND 资源内部的 +0x210，不在 exe，也不在地图结构资源里。exe 只记指针：
- v2.06 载入器 fcn.0040779b：
  - 调色板 memcpy 到 0x488440；
  - `[0x488858] = GND+0x210`（排布表）；
  - `[0x488854] = GND+0x2A90`（图块）。
- v3.11：调色板在 0x48b6b4，`[0x48bacc] = +0x2A90`。

### 1.2 投影表（D2 已抽取在 tables.v206/v311.json 的 view 字段；两版数值相同）

**cellScreen**（v2.06 0x46ab9c，v3.11 0x46ccf0）
- 布局：`[view]` 步长 0xd24，`[dy+14]` 步长 0x74，`[dx+14]` 步长 4。
- 每项两个 int16，**顺序是 (sy, sx)**。
- 证据：
  - 地面循环 0x408049–0x40817c：`tileRow = camY>>5 + b0`、`tileCol = camX>>5 + b1`、表偏移 `(b0+14)*0x74 + (b1+14)*4`；
  - 四边形光栅器 0x453e01/0x453fca 用点的低 16 位做扫描行（行跨度 0x500 = 640×2 字节）；
  - 精灵 X 取 +2 那一路。

**subcell**（v2.06 0x4727bc，v3.11 0x474910）
- 每视角 4 个 int8。
- fcn.004076f5（v3.11 fcn.00407a2c）的计算：
  - `fx = x&31`，`fy = y&31`；
  - `o1 = (m0*fx>>5) + (m2*fy>>5)`，供 X；
  - `o2 = (m1*fx>>5) + (m3*fy>>5)`，供 Y；
  - 每个乘积各自做算术右移；o 与投影方向相反（为负的偏移）。

**drawOrder**（v2.06 0x4714bc，v3.11 0x473610）
- 每视角 0x260 字节，是 (b0=dy, b1=dx) 的 int8 对，以 −128 结束，各 296 项，覆盖屏幕约 ±290 px。
- 四边形互不重叠，所以它**只起可见格剔除作用**。

### 1.3 地面绘制（v2.06 fcn.00407ebd，0x407fc3–0x408181；v3.11 fcn.0040829d，0x4083cc 起）

镜头与基准点：
- `cellX = camX>>5`，`cellY = camY>>5`；
- `bx = 220 + o1(cam)`，`by = 260 + o2(cam)`。

逐格绘制：对 drawOrder 中每个 (dy, dx)——
- 格行/列超出 0..71 的直接跳过（留黑）；
- 四角：`P0 = T(dx,dy)`、`P1 = T(dx+1,dy)`、`P2 = T(dx+1,dy+1)`、`P3 = T(dx,dy+1)`，各加 (bx, by)；
- 对应纹理坐标依次为 (0,0)、(31,0)、(31,31)、(0,31)，16.16 定点，按扫描线线性插值；
- 图块 = `tiles + arrange[(cellY+dy)*72 + cellX+dx]*1024`；
- 用 `pal[0x488440]` 查色后直接写入 640×480 后台缓冲；
- 裁剪矩形全局变量为 0x483498/0x48349c/0x4834a0/0x4834a4，数据段初值 (0, 40, 440, 480)，即原版视窗 440×440。

### 1.4 八个视角
- 视角全局：v2.06 为 [0x495c5c]，v3.11 为 [0x499088]。
- v2.06 热键：[0x495c0c] 使 `view=(view−1)&7`，[0x495c0e] 使 `view=(view+1)&7`（0x40138d / 0x4013cd）。
- 载入地图时置 0（0x407a8c），存档保存 4 字节（0x402dcb / 0x403247）。
- 拟合参数见 projection-fit.v206.json。视角 0：
  - `sx = 36.01·dx + 14.86·dy − 1.6`
  - `sy = −10.53·dx + 25.52·dy − 1.1`
  - dx、dy 为格差。
- 各视角 θ（度）：

| view | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|---|
| θ | −22.4 | 22.5 | 67.6 | 112.4 | 157.5 | −157.5 | −112.4 | −67.5 |

- view+1 使画面顺时针转 45°。

## 2. 物体

### 2.1 世界点 → 屏幕
先求格差：`dx = (x>>5) − cellX`，`dy = (y>>5) − cellY`，要求 |dx|、|dy| ≤ 14（代码判 0..0x1c），否则不画。然后：
```
sx = bx + T[view][dy+14][dx+14].sx − o1(x,y)
sy = by + T[view][dy+14][dx+14].sy − o2(x,y)
```
- 同一段代码在 v2.06 0x4081f2（装饰）、0x408316（玩家）、0x408d60（住宅）、0x408f81（设施）、0x4091b3（企业）、0x4092f8（景观）重复出现。
- 镜头函数为 fcn.00407ebd(x, y)；x = −1 时沿用 [0x488038]/[0x48803c]。

### 2.2 精灵格式与贴图

**SPR**
- 头部：`'SPR\0'`、u32 n、u32 start。
- 其后 n×12 字节帧描述：u16 w、u16 h、i16 ax、i16 ay、u32 size（= w·h）。
- start 处是 512 字节 RGB555 调色板，然后逐帧存 8bpp 像素。
- MKF 头 imgOff = start、imgSize = 512。

**SMP**
- 头部结构同 SPR，但 size = w·h·2，像素是 16 位 RGB555 直接色。
- MKF 头的 imgOff/imgSize 覆盖全部像素。

**贴图规则**
- SPR 用 0x454dd0，SMP 用 0x454b21 → 0x4542b2。
- 左上角 = (sx − ax, sy − ay)。
- SPR 索引 0 透明，SMP 值 0 透明。
- 按棋盘矩形裁剪。

**主人色**
- 绘制槽 +6 字节 ≠ 0xff 时，把该 SPR 调色板第 255 项临时改成主人颜色（0x409468–0x409487）。
- 值为 0（无主）时改成 0，即黑色。
- 住宅、设施、企业都有这圈描边色。

### 2.3 图号与资源（v2.06 载入器 fcn.0040779b；v3.11 fcn.00407ad2 + 绘制器 fcn.0040829d）

**住宅**
- 地块 +0x1b 为 facing，帧 = `(8−(facing+view))&7`。
- level > 0 时：
  - 普通住宅：v2.06 为 `27 + gm*5 + (level−1)`，v3.11 为 `0x27 + gm*5 + (level−1)`；
  - 连锁店：v2.06 为 47，v3.11 为 `0x4f + gm`。
- level = 0 且有主时画角色标记：v2.06 资源 13，v3.11 资源 25；12 帧，帧号 = 角色号（player+0x0b）。
- 拾取 ID 为 2000 + i。

**设施**
- v2.06 有 21 库：48 公園；`48 + (kind−1)*5 + level`（49–53 旅館、54–58 購物中心、59–63 加油站、64–68 研究所）。
- v3.11 有 17 槽：
  - stage 0 基址 0x57，stage 1 为 `0x68 + map*17`；
  - 槽 0 公園，1–5 旅館，6–10 購物中心，11 加油站（仅 1 级），12–16 研究所。

**企业与景观**
- 企业读 +0x20，景观读 +0x1a，得到 spriteId。
- 资源号：v2.06 为 `id + 26`，v3.11 为 `id + 0x26`。
- 两版台湾 spriteId 不同：臺灣人壽 49→134，醫院 61→144，綠島 123→259；但对应的资源逐字节相同，例如 v2.06 75 = v3.11 172。
- 企业有主人色；景观为 0xff，不改色。

**地块高亮（涨价/查封）**
- 地块 +0x17 或设施 +0x1c 非 0 时，用 v2.06 资源 14（v3.11 资源 26）的 SPR 掩码：
  - 地块用帧 `(帧号&1)`，设施用帧 `(帧号&1)+2`；
  - 调 0x455293，把颜色 OR 到目标像素；
  - 颜色取自 0x4861d0 表，下标 `(state&1)*4 + 相位[0x4741a0]`。
- 这一步在排序精灵之前画。

**两版锚点差异**
- v3.11 只改动了部分精灵的锚点：台湾住宅差 (−3,−1)~(−4,−3)，公園最多 13 px。像素本身相同。

### 2.4 装饰（node +0x22）
- 地面画完后、排序之前，逐节点绘制（0x408181–0x40827f），不参与排序。
- 资源：
  - v2.06 为 map.mkf 资源 12（SMP 17 帧：PARK / NEWS / ? / 监狱 / 医院 / 3×GAME / 乐透 / 50 / 30 / 10 点 / CARD / BANK / On sale / 魔法屋 / 小币）；
  - v3.11 为资源 24（58 帧）。
- 帧 = decor − 1，锚点为图心。
- 台湾图两版的换算：`v3.11 decor = 2·v2.06 decor − 1`（普通款在奇数位）。

### 2.5 深度排序（0x4093d9：qsort(0x487438, n, 4, 0x4076c2)，比较低 16 位 int16）
- 键 = `(槽号<<16) | ((sy&0xfff)<<4) | layer`，layer 取值：

| layer | 对象 |
|---|---|
| 0 | 建筑 / 地块标记 / 地上物件 / 附身物件 |
| 8 | 非当前 NPC |
| 0xC | 非当前玩家 |
| 0xD | 当前玩家或当前 NPC |
| 0xE / 0xF | 梦游 ZZZ（Data.mkf 373，6 帧） |

- 飞行中物件的键为 0x7FF0，固定最后画。
- 定时炸弹（type 0x12）的槽另外在 (sx, sy−60) 画 "%d"。

### 2.6 棋子与物件

**玩家**（结构 0x493918，步长 0x68）
- 取库：`[0x495cd0 + p*0x34 + 快艇?4 + pose*8]`，pose 0 站、1 走、2 持骰。
- 帧号：`((8−view+dir)&7)·(帧数/8) + [0x495cbf]`。
- v2.06 资源：Data.mkf `87 + 21·角色 + k`，v3.11 为 `0x80 + 21·角色 + k`。k 的含义：

| k | 含义 |
|---|---|
| 0 / 1 / 2 | 步行站、走（72 帧 = 8×9）、持骰 |
| 3–5 | 机车 |
| 6–8 | 汽车 |
| 9–11 | 第 4 种载具（履带机械） |
| 13–15 | 快艇 |
| 16–20 | 其它状态 |

**方向编码**（fcn.00453614）
- `dir = [2,3,4,5,6,7,0,1][round(atan2(−dy,dx)/45°)&7]`。
- 即 0 南（+y）、2 东（+x）、4 北、6 西。

**NPC 4..7**（v2.06）
- Data.mkf `0x143 + 4·actor + {0 站, 1 走, 2 快艇}`。

**地上物件**（0x493ab0，步长 24，46 槽）
- 帧 = `(8−view+facing)&7`，库 = Data.mkf `0x163 + type − 1`（v3.11 为 0x18c 起）。
- 初始类型表 0x47cb5c：type 16 路障 ×10、17 地雷 ×10、18 定时炸弹 ×10。

**附身物件**
- 画在主人位置，帧 = `(dirIdx+4)&7`。
- 屏幕偏移：普通用 0x4727fd，定时炸弹用 0x47283d。例如 dirIdx 0 对应 (−10,−22) 与 (−18,−44)。

### 2.7 行走与快艇（fcn.0040bb40）
- 速度表：0x472884 = [8, 12, 16, 8]，下标为 player+0x09 & 3。
- 每格 tick 数 `N = trunc(dist/速度)`；N 为 0 时取 1。截断由 fcn.0045641c 实现（控制字 RC = 11）。
- 快艇或特殊状态固定按 `dist × 0.125`（0x4611c4 = 0.125f），即 8 px/tick。
- 每 tick：位置加 Δ/N（float 累加，截断存储），动画帧 +1，到 `走姿库帧数/8` 归零。
- 当前节点 flags bit31 置位时，换快艇姿态。台湾图共 17 个这样的节点：1–4、25–29、32–34、99–103（去澎湖、綠島的航线）。
- tick 分频表 0x46a9d0 = [6, 4, 2, 0]；每个 tick 20 ms × 分频，其中 20 ms 取自 oama 对 v3.11 的结论。

## 3. 原型与验证
- 原型：test/render-lib.ts 与 test/render-proto.ts，全部自写，包括 MKF 读取、私有压缩解压、SPR/SMP/GND 解析、node:zlib 最小 PNG 编码器。
- 另有 Python 辅助脚本：render_mkf_list / lzhuf / png / sprites / index_sheet / mapdata / fitcheck。
- 运行：`npx tsx test/render-proto.ts`；v3.11 用 `ED=v311 RICH4_SHARE=<共享盘>`。
- 产物在 .cache/assets-research/render/，目视核对结果如下。

**正射底图叠点**（taiwan_topdown_nodes_half.png）
- 103 个节点全部落在底图暗色公路条的中线上；
- 住宅点落在白虚线地块框中心，设施点落在大地块框中心；
- 21 个景观点落在对应地貌上，17 个快艇节点落在海上航线上。

**整图总览**（taiwan_view0.png 等）
- 用拟合仿射投影全部 72×72 块，并叠加全部建筑、装饰、节点。
- 视角 0 的全图 3985×2856 px，另有 1/3 缩图；视角 1、3 各出一张。
- 装饰圆盘都在路口，建筑都在地块框内。

**精确棋盘**（board_v{0,1,2,5}_{taipei,greenisland,center}[_clean].png）
- 按原版表 + 亚格公式绘制：640×480，棋盘区 (0,40)–(440,480)。
- 每张画 259–296 块地面，无空洞（地图边外留黑）。
- 节点红点压在路面中线，邻接线沿路走。
- 景观精灵（如石門水庫）正好压在地面贴图里它自己的岩石底座上。如果轴向弄反，两者会明显错位，因此这一对齐同时验证了 (sy,sx) 顺序和 dy 在外层。
- 綠島航线上两名角色以快艇姿态出现。

**两版对照**
- v3.11 同一套流程（map.mkf + 共享盘 MultiverseJourney/Data.mkf）渲染结果与 v2.06 基本一致，只有锚点差 1–4 px。
- 这说明 v3.11 的资源号映射（`0x27 + gm*5`、`0x4f + gm`、`0x57 + 槽`、`id + 0x26`、角色基址 0x80）都正确。

**方向帧**
- dircheck_view0_x3.png：8 个方向上的角色都面朝各自的移动方向。

**数值**
- 表投影与仿射模型，以每个节点为镜头、比较 ±14 格内全部点，最大差 4.5–6.4 px（按视角不同），这个数含亚格取整。
- 只看表格点，最大差 1.8–2.0 px。

## 4. PixiJS 落地建议
1. **素材预处理**（本地运行，产物不入库）：
   - 每张图的 GND 导出一张 2304×2304 PNG，或 4 张 1152²；
   - SPR/SMP 导出图集，每帧附 {w, h, ax, ay}；
   - SPR 里索引 255 的像素另导出一张白色掩码。客户端画法：底图（255 处透明）+ 掩码 × tint(主人色)，与原版改调色板等价。
2. **地面**，两种做法二选一：
   - 高保真：用 29×29 顶点的 `Mesh` 自建几何，顶点 = 表值 + (bx,by)，UV = 世界格角 ÷ 2304；跨格时换 UV，格内只平移。
   - 简化（推荐默认）：底图做成单个 Sprite，套仿射矩阵 `(a,c,b,d) = 拟合系数/32`。精灵位置用同一个仿射，内部完全对齐；与原版的偏差不超过 2 px（格点）或 6 px（含亚格）。视窗也能超过 ±14 格。
3. **精灵**：pivot = (ax, ay)，zIndex = `sy*16 + layer`。装饰放在地面上方单独一层，不排序。旋转视角时重算投影与帧号。
4. **舞台**：640×480 舞台里放 440×440 棋盘区，镜头对准棋盘局部 (220,220)。放大时用最近邻采样。

## 5. 对现有文档的纠错（未改文件，按约束只报告）
- tools/extract/src/exe/types.ts 的 ViewTables 注释，以及 docs/VERIFY.md V-E10，把 cellScreen 写成“dx 外层、(x,y)”，**两处都反了**：实际是 dy 外层、(sy,sx)。只修一处会导致棋盘沿主对角线镜像。
  - drawOrder 的字节对实际是 (dy, dx)；
  - subcell 的结果是**负的**亚格偏移，要用减法。
- r_references §3 与 oama projection.ts 称“透视、误差 15–44 px”，不成立：该表就是仿射加取整噪声。

## verified
- GND 结构：用 map.mkf 资源 0 验证。头部依次为 'GND\0'、u16 72、u16 72、u32 5184、u32 0；+0x10 是 512 字节调色板；+0x210 是 72×72 u16 排布表；+0x2A90 起 5184×1024 字节图块，总长 5319312 正好吻合。8 张图的排布表全部恒等（render-proto.report.json 中 identityArrange=true）。按 RGB555 渲出的正射图是清晰的台湾岛，按 RGB565 则是噪点（gnd0_topdown_555_half.png 对照 _565_half.png）
- 世界坐标即底图像素：taiwan_topdown_nodes_half.png 目视，103 个节点压在公路中线，50 块住宅地在白虚线框中心，4 个设施在大框中心，21 个景观在对应地貌上，17 个 bit31 节点在海上航线上
- 投影表轴向：v2.06 0x408049–0x40817c 的地面循环中，图块行 = camY>>5 + b0，表偏移 = (b0+14)*0x74 + (b1+14)*4；光栅器 0x453e01/0x453fca 用每个点的低 16 位做扫描行，行跨度 0x500。据此 T 为 [dy][dx] → (sy,sx)。渲染验证：石門水庫等景观精灵正好落在底图中它自己的岩石底座上
- 投影中心：v2.06 0x408001/0x408009 对 o1+0xdc、o2+0x104，即 (220,260)；v3.11 0x4083e1/0x4083e9 相同。裁剪矩形 0x483498..0x4834a4 的数据段初值为 (0,40,440,480)，由 fcn.00453ddc 设置
- 亚格函数 fcn.004076f5 的反汇编：fx=x&31，fy=y&31；outA=(m0*fx>>5)+(m2*fy>>5)，outB=(m1*fx>>5)+(m3*fy>>5)。绘制时 sx=[esp+0x20]+T.sx−outA(物体)，其中 [esp+0x20]=220+outA(镜头)
- 表的性质（test/render_fitcheck.py 纯 Python 最小二乘）：8 个视角的仿射+常数项拟合最大误差 1.81–2.02 px、均值约 0.7 px；单应拟合 h31、h32 < 2e-5；视角 0 的尺度 38.96 px/格，θ=−22.43°，纵向压缩 0.7087
- 表投影与仿射模型的整体差：以每个节点为镜头，对 ±14 格内所有点求最大差，视角 0..7 依次为 6.43/5.78/5.61/4.49/4.50/4.84/5.06/4.81 px（render-proto.report.json 的 tableVsAffineMaxPx）
- 私有压缩解压（自写，按 g_map §6.3）：v2.06 map.mkf 资源 12（257274 字节）、13、14、15，以及 Data.mkf 的若干资源，解压长度与 MKF 头一致，签名均为 SPR/SMP，帧 size 之和正好等于数据长度
- SPR/SMP 格式：资源 27 的头为 SPR、8 帧、start=108；帧 (35,38,18,29,1330)，1330 = 35×38；108+512+Σsize = 10823 = raw。SMP 资源 12：17 帧，size = w×h×2，imgOff=216=12+17×12
- 精灵贴图：0x454dd0 与 0x4542b2 都减去 ax/ay；SPR 索引 0 透明，SMP 值 0 透明；0x409468–0x409487 把调色板 +0x1fe（第 255 项）改成主人色，无主为 0
- v2.06 资源号来自载入器 fcn.0040779b：GND gm*2；小地图 8+gm（SMP 200×200 与 400×400）；装饰 12；角色标记 13；地块高亮 14；角色头像 15+角色；住宅 27+gm*5+k；连锁店 47；设施 48+j（j=0..20）；企业/景观 id+26。index_027_068.png 与 index_069_149.png 目视分类吻合（27–31 台湾 1–5 级住宅，48 公園，49–53 HOTEL，64–68 研究所，87 醫院，149 綠島監獄）
- v3.11 资源号来自载入器 fcn.00407ad2 与绘制器 0x40940d 起的设施分派：装饰 0x18、角色标记 0x19、高亮 0x1a、头像 0x1b+角色、住宅 0x27+gm*5+k、连锁店 0x4f+gm、设施 0x57+槽（stage1 为 0x68+map*17）、企业/景观 id+0x26、角色 0x80+21c。用这套映射渲染 v3.11 棋盘（render/v311/board_*.png），结果正确
- 两版对照：台湾地图结构资源 1 只有 67 字节不同，全部在 spriteId 与 decor 上（decor 换算为 v3.11 = 2·v2.06 − 1）；企业/景观精灵逐字节相同（75=172、87=182、149=297 等）；住宅、连锁店、公園只有帧描述里的锚点不同（台湾住宅差 −1..−4 px，公園最多 13 px）
- 帧号公式：建筑为 (8−(facing+view))&7（0x408dd1、0x408ff4、0x409255、0x40939d）；玩家为 ((8−view+dir)&7)·(帧数>>3)+动画帧（0x408433–0x40846e）；方向函数 fcn.00453614 的查表 0x47f6f4=[2,3,4,5,6,7,0,1]。dircheck_view0_x3.png 中角色都面朝各自的移动方向
- 深度排序：键为 ((sy<<4)&0xfff0)+(槽号<<16)，再 OR 上 layer（0 / 8 / 0xC / 0xD / 0xE / 0xF；飞行物件用 0x7ff0）；比较函数 0x4076c2 按低 16 位 movsx 比较；qsort 在 0x4093e7
- 行走：速度表 0x472884=[8,12,16,8]（唯一引用在 0x40bd74）；快艇或特殊状态乘 0.125（0x4611c4 = 0.125f）；取整函数 fcn.0045641c 把 RC 设为截断；动画帧每 tick +1，按走姿库帧数/8 取模（0x40c22e）；分频表 0x46a9d0=[6,4,2,0]（引用在 0x401f4b）
- 快艇段：角色载入器 0x40b5cb 检查当前节点 +0x27 & 0x80，是则加载 k=13..15。台湾图 bit31 节点共 17 个（1–4、25–29、32–34、99–103）。board_v0_greenisland.png 中两名角色以快艇姿态出现在航线上
- 原型渲染：精确棋盘每张画 259–296 块地面、若干装饰、4–40 个精灵；12 张棋盘图加 3 个视角的整图总览都经目视，建筑在地块框内、装饰在路口、节点在路中线；check:no-original 通过（962 个文件）

## unknowns
- 投影表无法用简单公式逐项重算：floor 或 round 加旋转缩放最多只命中 89/841 项。要做到像素级复现只能直接带表；仿射模型与原版有 2–6 px 偏差
- 地块高亮的颜色表 0x4861d0 与相位全局 [0x4741a0] 的具体取值、闪烁周期没有解码
- Data.mkf 中角色第 12、16–20 套姿态的含义（住院、坐牢、附身等）只凭图像推测；第 4 种载具（速度 8，履带机械臂）的正式名称未知
- 地上物件 type 1..15 分别对应哪位神明或 NPC 未逐一核对（只确认 16 路障、17 地雷、18 定时炸弹、19 ZZZ）；v2.06 中機器娃娃（actor 8，0x40b9e9 分支）的资源号未读
- 20 ms 的渲染周期取自 oama 对 v3.11 的结论，v2.06 只核对了分频表 [6,4,2,0]；镜头推移与 clamp（oama 称 [220,2084]）在 v2.06 中未读
- 手头没有原版实机截图，绝对像素位置只能靠内部一致性和双版本交叉验证，没有与截图逐像素比对
- original/MultiverseJourney/ 下只有 rich4.exe 和 map.mkf。v3.11 需要的 Data.mkf、Panel.mkf、Speaking.mkf 等只在共享盘 rich4-share/MultiverseJourney/ 中；若素材包选 v3.11，提取来源要改成 Steam 目录
- drawOrder 对 296 格的具体取舍规则（为何每个视角恰好 296 项）没有推导，只确认它是剔除表

## artifacts
- <repo>/test/render-lib.ts
- <repo>/test/render-proto.ts
- <repo>/test/render-dircheck.ts
- <repo>/test/render_mkf_list.py
- <repo>/test/render_lzhuf.py
- <repo>/test/render_png.py
- <repo>/test/render_sprites.py
- <repo>/test/render_index_sheet.py
- <repo>/test/render_mapdata.py
- <repo>/test/render_fitcheck.py
- <repo>/.cache/assets-research/render/render-model.json
- <repo>/.cache/assets-research/render/projection-fit.v206.json
- <repo>/.cache/assets-research/render/render-proto.report.json
- <repo>/.cache/assets-research/render/taiwan_view0.png
- <repo>/.cache/assets-research/render/taiwan_view0_third.png
- <repo>/.cache/assets-research/render/taiwan_view0_groundonly_third.png
- <repo>/.cache/assets-research/render/taiwan_view1_overview.png
- <repo>/.cache/assets-research/render/taiwan_view3_overview.png
- <repo>/.cache/assets-research/render/taiwan_topdown_nodes_half.png
- <repo>/.cache/assets-research/render/board_v0_center.png
- <repo>/.cache/assets-research/render/board_v0_center_clean.png
- <repo>/.cache/assets-research/render/board_v1_taipei.png
- <repo>/.cache/assets-research/render/board_v5_center_clean.png
- <repo>/.cache/assets-research/render/board_v0_greenisland.png
- <repo>/.cache/assets-research/render/dircheck_view0_x3.png
- <repo>/.cache/assets-research/render/gnd0_topdown_555_half.png
- <repo>/.cache/assets-research/render/sprites_v206/index_027_068.png
- <repo>/.cache/assets-research/render/sprites_v206/index_069_149.png
- <repo>/.cache/assets-research/render/sprites_v206/data_087_107.png
- <repo>/.cache/assets-research/render/sprites_v206/data_355_374.png
- <repo>/.cache/assets-research/render/sprites_v206/res012.png
- <repo>/.cache/assets-research/render/v311/board_v0_center_clean.png