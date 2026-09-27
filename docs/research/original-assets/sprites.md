# 原版图像资源解码规格（v2.06 Steam 实测，自写实现 test/sprite-proto.ts）

> 这一部分回答用户“现在的美术是怎么来的”背后的问题：我们能否改用原版素材。结论是可以，且格式已完全解通：现在的美术全部由程序生成；原版素材可以从用户自己的 Steam 正版 MKF 包里无损解出，**格式已全部解明**，下文各条都有字节级或反汇编证据。素材只在本地派生，不入库。

## 0. 总量（Game 目录，另含 MJ/map.mkf）
| 档案 | 资源数 | LZ 压缩 | SPR | SMP | GND | FLIC | 无头/其他 | 精灵帧数 |
|---|---|---|---|---|---|---|---|---|
| Data.mkf | 561 | 270 | 290 | 9 | – | 72 | 190（RAW555） | 8735 |
| Panel.mkf | 113 | 92 | 66 | 34 | – | 8 | 5（RAW555 1 个、u8 区域图 4 个） | 1451 |
| jump.mkf | 67 | 36 | 36 | 2 | – | 25 | 4（RAW555 640x480） | 492 |
| map.mkf | 150 | 19 | 125 | 17 | 4 | – | 4（地图结构） | 1110 |
| help.mkf | 100 | 0 | – | 1 | – | – | 99（Big5 文本） | 12 |
| Effect.mkf | 115 | 0 | – | – | – | – | 99 RIFF + 16 个空项 | – |
| MJ/map.mkf | 298 | 23 | 261 | 21 | 8 | – | 8 | 2247 |

Game 目录 417 个压缩资源，与 nuro 文档记载的 Game 417 一致。survey 对全部 SPR/SMP 做了三项自洽检查，**0 项违例**：
- start == 12+12n；
- Σgsize 恰好闭合到资源末尾；
- 每帧 gsize == w*h 或 w*h*2。

## 1. MKF 容器与 read_mkf（exe 证据）
- 文件头：u32 为索引表偏移 X。索引表占 X..EOF，每项是 u32 绝对起点，共 (len−X)/4 项，全部是真实资源，本版本**没有哨兵项**。
- 每个资源先有 16 字节头 {rawSize, storedSize, imgOff, imgSize}，后接 storedSize 字节数据。
- read_mkf 位于 v2.06 VA **0x44EC68**，有 196 处调用，流程如下：
  - SetFilePointer 定位后读 16 字节头；
  - stored≠raw 时，把数据读进临时缓冲，调用 **fcn.004536A0**（私有解压）；
  - 若 imgSize≠0，调用 **fcn.00450028(buf+imgOff, imgSize)**，原地做像素格式转换。
- **imgOff/imgSize 的含义是“需要做 16 位像素格式转换的区间”**。按资源类型实测全部符合下表（survey 中 imgRule 全为 true）：

| 类型 | imgOff | imgSize |
|---|---|---|
| SPR | start_offset | 512（只转调色板） |
| SMP | start_offset | raw − start（整段像素） |
| GND | 16 | 512（调色板） |
| RAW555 | **4** | raw − 4 |
| FLIC、地图结构、区域图、文本 | 0 | 0 |

- RAW555 的 imgOff=4 是打包工具的怪癖：前 2 个像素不做转换。像素本身从偏移 0 开始，行宽自相关检验证明了这一点。

## 2. 私有压缩 LZHUF（按 g_map.md §6.3 伪代码自写）
- 算法：LZHUF 类自适应哈夫曼。
  - 树参数：N_CHAR=321，T=641，R=640，比特序 LSB-first。
  - 频率达到 freq[R]==0x8000 时重建：先 bump 所有奇数频率的叶子，再整体右移一位。
- 符号含义：
  - 符号 < 256 是字面字节；
  - 符号 ≥ 256 是匹配，长度 = 符号 − 253（3..67）。
- 距离编码：
  - 先窥视 8 位得到 LEN/HI 表项，再读 6 位作为 lo6；
  - dist = HI<<6 | lo6，p = out − 1 − dist，允许源与目标重叠；
  - dist == 0xFFF 为结束标记。
- **逐位验证**：test/sprite-lzcheck.ts 解压全部 **440** 个压缩资源（Game 417 + MJ 23），结果如下：
  - 输出长度全部等于 rawSize；
  - 输出写满后再解一个符号，440/440 都是 **dist==0xFFF 结束标记**；
  - 结束标记之后剩余未用字节 **全部为 0**，比特流恰好用尽。
- 性能：Data.mkf 全档解压约 1 s。

## 3. 像素格式：RGB555（0RRRRRGGGGGBBBBB，小端 u16）
- **统计证据**：
  - 16 位像素字共 32,908,232 个（Data 13.9M、Panel 15.5M、jump 2.3M、map 1.05M、help 0.17M），bit15 置位数为 **0**；
  - 调色板项共 133,376 个，bit15 置位数同样为 **0**。
  - 若是 RGB565，红色高位会大量置位。结果见 .cache/assets-research/sprite/bit15-stats.json。
- **exe 证据**：fcn.0044FF84 通过 DirectDraw 的 GetPixelFormat（vtbl+0x54）比对 RGB 掩码，把结果写入全局 [0x4741A0]：

| 取值 | 掩码 | 含义 |
|---|---|---|
| 0 | 0x7C00 / 0x3E0 | 原生 555，不做转换 |
| 1 | 0xF800 / 0x7E0 | RGB565 |
| 2 | 0x1F / 0x7E0 | BGR565 |
| 3 | 0xF00 / 0xF0 | RGB444 |

- 转换函数 fcn.00450028 每次处理一对像素（u32），奇数像素单独补一次。各模式的换算：
  - 模式 1：`(c&0x1F)|((c<<1)&0xFFC0)`，绿色最低位补 0，这就是 r_references 所说的“取整”；
  - 模式 2：`(c&0x7C00)>>10 | (c&0x3E0)<<1 | (c&0x1F)<<11`；
  - 模式 3：`(c&0x7800)>>3 | (c&0x3C0)>>2 | (c&0x1E)>>1`。
- 由此确定**文件内储存格式就是 555**。浏览器端换算为 `R8=(r<<3)|(r>>2)`，G、B 同理，用高位复制补低位。

## 4. SPR（8 位调色板精灵）
- 头部 12 字节：签名 'SPR\0'、u32 帧数 n、u32 start（恒等于 12+12n）。
- 帧表从偏移 12 起，每帧 12 字节：`int16 w, int16 h, int16 x, int16 y, u32 gsize`，其中 gsize == w*h。
- start 处是调色板：256 项 u16 RGB555，共 512 字节。
- 像素从 start+512 开始，各帧按 gsize 依次首尾相接，每像素 1 字节索引，**无 RLE**。
- **透明规则是按索引 0 判定，与 palette[0] 的颜色无关**：
  - exe 有两个 blit：fcn.00454B72 为不透明版（`lodsb; mov ax,[edx+eax*2]; stosw`）；fcn.00454C9E 为色键版（`lodsb; and eax,0xFF; je skip`）。
  - 数据反证：jump #24/#25 的 palette[0]=0x7C00（纯红），背景像素全是索引 0；同时另有索引映射为 0x0000 黑色，用于 1754/1606 个描边像素。若按颜色判定透明，这些图会出现红底且描边消失。
- **锚点**：x/y 是热点坐标，实际落点 = 画点 − (x, y)。exe 中 fcn.00455293 先 `sub [arg_10h], word [esi+4]`，再 `sub [arg_14h], word [esi+6]`。
  - 棋子与建筑的锚点在底边中心，例如 58x64 的图为 (29,63)；
  - 部分 UI 帧带负锚点或相对偏移，例如 Panel #3 骰子为 (84,−98)。
- **调色板 #255 = 地块归属色描边占位**：只出现在 map.mkf 建筑类 SPR（27..46 以及企业/景观）。占位色因资源而异，有 0x7FFF、0x7C1F、0x03FF、0x7C00、0x7FE0 等。目视验证见 idx255-highlight.png：品红标出的正是建筑外圈。其他档案里 #255 只是普通颜色，例如 Panel #31 的白色高光，**不能一律替换**。
- 占比：Data 的 SPR 像素中索引 0 约占 40.9%。

## 5. SMP（16 位直接色精灵）
- 头部与帧表同 SPR，签名为 'SMP\0'，**没有调色板**。
- 像素从 start 开始，每像素 u16 RGB555，gsize == w*h*2，**无 RLE**。
- 透明值是 0x0000：exe 中 fcn.004542B2 为 `lodsw; or ax,ax; je skip; mov [edi],ax`。另有不透明 blit，是否用色键由调用点决定。
- 全屏 640x480 背景里也有 0 值，例如 Panel #9 帧 0 有 7512 个、#75 帧 0 有 20386 个（股市网格线）、#63 帧 0 有 131453 个（监狱窗洞）。**建议**：解码时 0 → alpha 0；全屏背景统一先铺黑底再合成，这与原版两种 blit 的结果都一致。

## 6. GND（地面，map.mkf 偶数号资源 2i）
- 布局：

| 偏移 | 内容 |
|---|---|
| 0x00 | 'GND\0' |
| 0x04 | u16 cols=72 |
| 0x06 | u16 rows=72 |
| 0x08 | u16 5184（块数） |
| 0x0A..0x0F | 0 |
| 0x10 | 调色板 512 字节（RGB555） |
| 0x210 | 排布表：5184 项 u16（0x2880 字节） |
| **0x2A90** | 图块像素：5184 块 × 1024 字节（32x32，8bpp） |

- 尺寸校验：0x2A90 + 5184×1024 = 5,319,312，与 rawSize **恰好相等**，没有尾部数据。
- 排布表：4 张 v2.06 地图、8 张 MJ 地图全部是**恒等排列**（layout[i]==i，layoutMax=5183）。块 i 位于 (i%72, i/72)，行主序拼成 **2304×2304** 的平面俯视图。
- 行主序的证据是接缝比（块边界差 ÷ 块内差）：

| 资源 | 行主序 | 列主序对照 |
|---|---|---|
| #0 | 1.004 | 2.030 |
| #2 | 0.991 | 2.039 |
| #4 | 1.000 | 1.989 |
| #6 | 1.001 | 2.372 |

- 目视结果：台湾、中国、日本、美国四张完整地图，含道路和虚线地块框。
- 重复块数：#0 有 177，#2 有 984，#4 有 2，#6 有 0。仅作参考，不影响解码。
- GND 没有透明。屏幕上的透视投影（8 视角）属于渲染专题，不在本题范围。

## 7. 无头 RGB555 整图（尺寸由调用方决定）
| 资源 | 尺寸 | 内容 |
|---|---|---|
| Data 4..86（83 张） | 200×200 | 日历节日插画（台/中/日/美） |
| Data 400..475（76 张） | **388×251** | 新闻/命运事件插画 |
| Data 530..559（30 张） | **165×256** | 30 张卡片插画 |
| Data 560 | 640×480 | Loading 画面 |
| Panel 92 | 640×480 | 財神接金幣背景 |
| jump 0..3 | 640×480 | 开局设定背景 |

- 这些尺寸均由行宽自相关确定：388/165/200/640 处差值最小。卡片的角落为 0 值，可按 0 = 透明处理。

## 8. FLIC（105 段，全部为标准 Autodesk **8 位 FLC**）
- 128 字节文件头：magic 0xAF12，depth=8，+6 为帧数，+8/+0xA 为宽高，+0x10 为 speed（毫秒）。
- 块类型：0xF100 前缀块（跳过）、0xF1FA 帧块。
- 子块类型与计数（全部 105 段合计）：

| 子块 | 名称 | 出现次数 |
|---|---|---|
| 4 | COLOR_256，8 位 RGB | 119 |
| 7 | DELTA_FLC | 3048 |
| 15 | BYTE_RUN | 105 |
| 16 | FLI_COPY | 1 |
| 18 | PSTAMP | 105 |

- exe 中的播放器 fcn.0044F72B 分派 4/7/12/15/16 五种子块。调色板块由 fcn.0044ED7C 调用 fcn.0045386D，按 [0x4741A0] 的显示模式换算成 16 位查找表 [0x4893A8]。
- **索引 0 = 透明**（已在 exe 中确认）：BYTE_RUN 处理函数 fcn.0044F361 遇到 `test dl,dl; je → mov dx,[edi]`，也就是索引 0 时取底图像素。
- 数据侧印证：105 段中 94 段首帧的主色就是索引 0（青、黑、绿、深绿等），解码后边缘干净。
- 已识别的 FLIC：
  - Data 499..510：12 位神明降临，440×440；
  - Data 375..398：12 名角色各 2 段小动画；
  - Panel 4/5/6：骰子滚动，189×285，36 帧，speed=14；
  - Panel 16：摇奖球；Panel 20：魔法屋；
  - jump 42：机舱门；jump 43..66：跳伞，640×480。

## 9. 其他非图像数据
- Panel 的 u8 区域图（每像素一个区域号），伪彩色图为 panel-hitmaps.png：

| 资源 | 尺寸 | 用途 |
|---|---|---|
| #19 | 640×480 | 魔法屋六芒星，13 个区 |
| #81 | 640×480 | 企鹅挖宝冰格菱形网格 |
| #22 | 128×192 | 计算器按键 |
| #8 | 72×67 | GO 按钮，4 个区；行宽相关性 0.95 |

- help.mkf 除 #0 外都是 Big5 文本，NUL 分行，每行 10 字。

## 10. v2.06 资源目录（详见 .cache/assets-research/sprite/catalog-v206.json）
- **角色棋子**：Data **87 + 21·c + k**，c 为角色号 0..11。

| k | 姿态 |
|---|---|
| 0 / 1 / 2 | 步行：站 / 走 / 持骰 |
| 3..5 | 机车 |
| 6..8 | 汽车 |
| 9..11 | 船 |
| 16..17 | 梦游 |
| 18 | 乞丐 |
| 19 | 住院 |
| 20 | 坐牢 |

  - 图号 = 屏幕朝向 ×（图数/8）+ 帧号，走路为 9 帧 × 8 个朝向。
  - v3.11 的起点是 128，差 41 张（多出 41 张日历插画）。
- **神明/物件**（每资源 8 帧为 8 个朝向，与神明 FLIC 一一对应）：Data **354 + t**，t 取 1..15：

| t | 物件 | t | 物件 | t | 物件 |
|---|---|---|---|---|---|
| 1 | 小財神 | 6 | 大窮神 | 11 | 惡犬 |
| 2 | 大財神 | 7 | 小衰神 | 12 | 土地公 |
| 3 | 小福神 | 8 | 大衰神 | 13 | 禮物 |
| 4 | 大福神 | 9 | 天使 | 14 | 寶箱 |
| 5 | 小窮神 | 10 | 惡魔 | 15 | 死神 |

- **棋盘上的道具物件**：Data 370 路障、371 地雷、372 定时炸弹。
- **骰子**：Panel 3 为点数定格图（3 颗 × 6 面）；Panel 4/5/6 为滚骰 FLIC；Panel 72 为选骰盘。
- **道具图标**：Panel 11 图 2..14（13 种），Panel 74 为 13 个小图标。卡片插画在 Data 530..559。
- **UI**：

| 资源 | 内容 |
|---|---|
| Panel 0 | 侧栏 |
| Panel 1 | 工具列：底条 + 11 个常态 + 11 个悬停 |
| Panel 7 | GO 按钮 |
| Panel 9 | 資產表 |
| Panel 10 | 商店 |
| Panel 11 | 道具栏 |
| Panel 77 | 託管 AI |
| Data 1 | 标题 |
| Data 2 | 72×72 头像 |
| Data 3 | 设定对话框 |
| Data 399 | YES/NO |

- **map.mkf 通用公式**（n = 本档地图数，v2.06 为 4，v3.11 为 8）：

| 资源号 | 内容 |
|---|---|
| 2i | GND |
| 2i+1 | 地图结构 |
| 2n+i | 小地图（200²/400² 两帧） |
| 3n | 装饰（v2.06 17 张，v3.11 58 张；图号 = decor−1） |
| 3n+1 | 空地归属标志（SPR 12 张） |
| 3n+2 | 地块高亮（SPR 5 张） |
| 3n+3..3n+14 | 12 角色头像 × 7 表情 |
| 3n+15 + 5·map + (level−1) | 住宅建筑 |
| spriteRes + 3n + 14 | 企业 / 景观 |

  - 景观公式已用 v2.06 结构数据交叉核对：醫院 61→87、綠島 123→149、陽明山 107→133、臺灣人壽 49→75、大宇百貨 54→80，目视全部吻合。
- **jump.mkf 侧视走动**：5 + 3c + v，v 为 0 步行、1 机车、2 汽车。
- **注意**：v2.06 与 v3.11 在 Data/jump/map 上的编号有系统偏移，公开项目的资源号多为 v3.11，不能直接套用。

## 11. 网页实现建议
- **流水线**：服务器从本地只读目录提供原始 .mkf，或离线派生 PNG 图集，派生物放 gitignore 目录。解码器按上述规格实现；全部逻辑只依赖 Uint8Array，浏览器可以直接运行。
- **色彩**：RGB555 → RGB888 用高位复制。**透明**：SPR 按索引 0，SMP/RAW 按值 0x0000，FLIC 按索引 0。
- **锚点**：保留每帧 (x, y)，绘制时减去。
- **建筑归属色**：解码时把索引 255 单独输出为掩膜，或在运行时换色。
- **FLIC**：离线展开为帧图集（440² 大小的要注意显存），或转成视频；帧间隔取头部 speed。


## verified
- MKF 容器：7 个档案全部可解析，索引无哨兵；Game 目录压缩资源 417 个（Data 270 / Panel 92 / jump 36 / map 19），与 nuro 文档的 Game 417 一致；MJ/map.mkf 另有 23 个压缩资源
- LZHUF 自写解压逐位正确：440/440 个压缩资源输出长度都等于 rawSize；写满后再解一个符号，440 次全是 dist==0xFFF 结束标记；结束标记之后未用字节全部为 0（test/sprite-lzcheck.ts）
- SPR/SMP 结构：survey 对 290+34+36+125+… 个精灵资源检查 start==12+12n、Σgsize 闭合、gsize==w*h(*2)、imgOff/imgSize 规则，全部 0 违例（.cache/assets-research/sprite/survey-*.json）
- 储存格式是 RGB555：32,908,232 个 16 位像素字、133,376 个调色板项的 bit15 置位数都为 0（bit15-stats.json）；exe fcn.0044FF84 按 DirectDraw 掩码 0x7C00/0x3E0 → 模式 0 不转换，fcn.00450028 在 read_mkf（VA 0x44EC68）内按 imgOff/imgSize 原地转为 565/BGR565/444
- SPR 透明按索引 0：exe 中 fcn.00454C9E 为 `lodsb; and eax,0xFF; je skip`，fcn.00454B72 为不透明版；jump #24/#25 的 palette[0]=0x7C00，另有黑色描边索引，只有按索引判定才能正确显示
- SMP 透明值为 0x0000：exe fcn.004542B2 `lodsw; or ax,ax; je skip`；Panel #63 监狱窗洞（131,453 个 0 像素）在导出图里是透明孔
- 锚点语义：exe fcn.00455293 落点 = 画点 − (word[esi+4], word[esi+6])；棋子锚点在底边中心
- GND：头 72/72/5184，调色板 0x10，排布表 0x210，像素起点 0x2A90，5184×1024 字节恰好到文件尾；排布表为恒等排列；接缝比行主序 1.004/0.991/1.000/1.001，列主序 2.03/2.04/1.99/2.37；目视四张地图完整（gnd-4maps.png、map/0_0_crop1280x64.png）
- FLIC：105 段都是 8 位 FLC，子块 4/7/15/16/18 与前缀块 0xF100；exe 播放器 fcn.0044F72B 分派 4/7/12/15/16；BYTE_RUN 处理函数 fcn.0044F361 遇索引 0 取底图像素（透明）；解码结果目视正确（dice.png、god-films-499-510.png）
- 无头 RGB555 尺寸由行宽自相关确定：Data 400..475 为 388×251，Data 530..559 为 165×256（30 张卡片），Data 4..86 为 200×200，640×480 共 6 张；目视正确
- palette #255 为建筑归属色描边：品红高亮图显示 map #27/#40 的外圈全是索引 255（156/183 px），角色类资源基本不用索引 255（idx255-highlight.png）
- map.mkf 景观/企业图号公式 spriteRes+3n+14（v2.06 n=4 → +26）：醫院 61→#87、綠島 123→#149、陽明山 107→#133、臺灣人壽 49→#75、大宇百貨 54→#80，目视吻合
- 目视确认的类别：12 角色 × 21 姿态（chars-12-poses21.png）、行走 8 向 × 9 帧（chars-c0-walk-8dir.png）、4 图 × 5 级 × 8 向建筑（buildings-4maps-5lv-8dir.png）、15 种神明/物件 × 8 向（gods-objects-355-372.png）、骰子、UI 面板、卡片、道具图标、新闻插画、节日插画、开局场景与跳伞；颜色自然，透明边缘干净
- 共导出 1,358 张 PNG（Data 805 / Panel 120 / jump 46 / map 387，按 <res>_<frame>.png 命名，另含少量派生文件）和 40 张联系表

## unknowns
- Data 482..498、511..529 这批 FLIC（建屋、救护车 440×74、警察、爆炸等）只识别出 499..510 为神明降临，其余逐段语义还没对照 exe 调用点
- 角色 21 个姿态资源中 k=12..15（工程车/飞行器之类）的确切用途未从 exe 核实；v3.11 公开文档说 3t 为交通方式分组，本调研只做了目视
- SMP/SPR 在各调用点用的是色键 blit 还是不透明 blit 没有逐一列举；建议统一输出 alpha，全屏背景先铺黑底
- FLIC 的 DELTA_FLC 处理函数（fcn.0044EEEE）没有反汇编，未确认其对索引 0 的处理；BYTE_RUN 已确认索引 0 为透明
- 原版把 FLIC 的 8 位 RGB 调色板经 fcn.0045386D 量化到 16 位；我们直接用 8 位色，与原版存在不超过 3 位的量化差
- RAW555 的 imgOff=4 让前 2 个像素不做格式转换，属打包怪癖；只影响非 555 显示模式，可以忽略
- original/MultiverseJourney 只有 rich4.exe 与 map.mkf，没有 v3.11 的 Data/Panel/jump；v3.11 编号偏移（如角色 +41）引自公开文档，未用实际文件验证
- Panel #8（72×67，值 1..4）是 GO 按钮区域图，但 4 个区域各自的含义未核实
- GND 的透视投影与 8 视角渲染属于另一专题，本调研只解到平面 2304×2304 底图
- 另有并行工作流在 .cache/assets-research/samples/ 根目录写入平铺文件（如 data000_SMP_C.png），不是本脚本产出；Data 530..559 在那里被猜成 165x256，与本结论一致

## artifacts
- <repo>/test/sprite-proto.ts
- <repo>/test/sprite-stats.ts
- <repo>/test/sprite-lzcheck.ts
- <repo>/test/sprite-hitmap.ts
- <repo>/.cache/assets-research/sprite/catalog-v206.json
- <repo>/.cache/assets-research/sprite/survey-summary.json
- <repo>/.cache/assets-research/sprite/survey-Data.mkf.json
- <repo>/.cache/assets-research/sprite/survey-Panel.mkf.json
- <repo>/.cache/assets-research/sprite/survey-jump.mkf.json
- <repo>/.cache/assets-research/sprite/survey-map.mkf.json
- <repo>/.cache/assets-research/sprite/survey-MJ-map.mkf.json
- <repo>/.cache/assets-research/sprite/survey-help.mkf.json
- <repo>/.cache/assets-research/sprite/survey-Effect.mkf.json
- <repo>/.cache/assets-research/sprite/bit15-stats.json
- <repo>/.cache/assets-research/sprite/key-stats.json
- <repo>/.cache/assets-research/sprite/samples-log.json
- <repo>/.cache/assets-research/samples/Data/
- <repo>/.cache/assets-research/samples/Panel/
- <repo>/.cache/assets-research/samples/jump/
- <repo>/.cache/assets-research/samples/map/
- <repo>/.cache/assets-research/samples/contact/chars-12-poses21.png
- <repo>/.cache/assets-research/samples/contact/chars-12-walk.png
- <repo>/.cache/assets-research/samples/contact/chars-c0-walk-8dir.png
- <repo>/.cache/assets-research/samples/contact/buildings-4maps-5lv-8dir.png
- <repo>/.cache/assets-research/samples/contact/map-landmarks-47-149.png
- <repo>/.cache/assets-research/samples/contact/gnd-4maps.png
- <repo>/.cache/assets-research/samples/contact/gnd0-tiles.png
- <repo>/.cache/assets-research/samples/contact/gods-objects-355-372.png
- <repo>/.cache/assets-research/samples/contact/god-films-499-510.png
- <repo>/.cache/assets-research/samples/contact/npc-339-354.png
- <repo>/.cache/assets-research/samples/contact/dice.png
- <repo>/.cache/assets-research/samples/contact/ui-panels.png
- <repo>/.cache/assets-research/samples/contact/portraits-map15-26.png
- <repo>/.cache/assets-research/samples/contact/cards-530-559.png
- <repo>/.cache/assets-research/samples/contact/items-icons.png
- <repo>/.cache/assets-research/samples/contact/news-400-475.png
- <repo>/.cache/assets-research/samples/contact/jump.png
- <repo>/.cache/assets-research/samples/contact/idx255-highlight.png
- <repo>/.cache/assets-research/samples/contact/panel-hitmaps.png
- <repo>/.cache/assets-research/samples/contact/overview-Panel-0-112.png
- <repo>/.cache/assets-research/samples/contact/overview-map-0-149.png
- <repo>/.cache/assets-research/samples/contact/overview-jump-0-66.png
- <repo>/.cache/assets-research/samples/contact/overview-Data-339-374.png
- <repo>/.cache/assets-research/samples/contact/overview-Data-375-398.png
- <repo>/.cache/assets-research/samples/contact/overview-Data-399-481.png
- <repo>/.cache/assets-research/samples/contact/overview-Data-4-86.png
- <repo>/.cache/assets-research/samples/contact/overview-Data-530-559.png
- <repo>/.cache/assets-research/samples/contact/overview-Data-0-3.png