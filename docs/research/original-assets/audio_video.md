# 音频与视频调研结论（v2.06 为主，v3.11 对照）

> 以下结论全部在本机正版文件上核对过。原版文件只读取，没有修改。派生文件都写在 `.cache/assets-research/{audio,video}/`，调试脚本放在 `test/ar_*`。
> 汇总清单见 `.cache/assets-research/audio/audio-manifest.v206.json`，内容包括：音乐轨表、场景表、音效集表、FLIC↔音效配对、Effect 逐号时长、FLIC 清单、视频转换统计。

---

## 1. Speaking.mkf（语音，1374 段）

### 1.1 容器与单段格式（已验证）

**容器**
- 文件大小 56,970,696 B（0x3654DC8）。
- 首个 u32 X = 56,965,200（0x3653850），指向索引表。
- 索引表共 1374 项，没有哨兵项。
- 全部资源都未压缩（raw==stored），imgOff 和 imgSize 都是 0，可以直接切片使用。

**单段格式**
- 每段资源体（资源起点 +16 之后的 stored 字节）本身就是一个完整的 RIFF/WAVE 文件，头 16 字节为 `RIFF….WAVEfmt `。
- 1374 段的 RIFF 长度字段都满足 riffSize+8 = stored。
- 编码统一为 PCM（fmt tag=1）、单声道、8 位无符号（ffprobe 识别为 pcm_u8）。
- 采样率分两种：
  - 22050 Hz：1184 段
  - 44100 Hz：190 段
- 块顺序为 `fmt `→`data`→`LIST`，其中 377+165 段另带 `smpl`。
  - LIST/INFO 内容为 GoldWave 或 Awave 的 ISFT 签名。
  - smpl 是 Awave 生成的整段循环标记（type=255，count=0x80000000）。游戏不读取，应忽略。

**时长统计**
- 总时长 2283.9 s，约 38.1 分钟。
- 单段最短 0.137 s，最长 6.406 s，平均 1.662 s。
- WAV 合计 56,943,212 B。

### 1.2 编号结构（用 exe 台词校正了 r_minigames_chars §2.4）

在 v2.06 exe 的 DGROUP 段里，以 `#NNNN` 开头的 Big5 台词字符串共 1343 条。`NNNN` 就是资源号，不加偏移。这些字符串覆盖了 1374 个编号中的 1341 个，逐号清单见 `speaking.manifest.json`。据此得到的真实分段如下：

| 区段 | 数量 | 内容（依据台词文本） |
|---|---|---|
| 0..233 | 234 | NPC 与新闻播报：<br>• 0..10 道具店（「歡迎光臨道具店！」）<br>• 11..35 乐透，其中 20..31 为 12 个角色名<br>• 36..57 魔法屋（46..57 为「財產最多的人」等目标选择）<br>• 75..91 银行<br>• 93..122 月结「本月悲情人物／本月冠軍」，其中 97..107、110..121 为角色名<br>• 123..130 医院<br>• 132..148 拍卖，其中 136..147「恭喜XX購得此地」<br>• 149..233 新闻事件（「外星人攻打地球」「豪雨特報…」「酒醉大鬧警局坐牢%d天」等） |
| 234..425 | 192 | **12 角色 × 16 条道具使用台词**，编号 = 234 + 16×角色 + k。例如 234「衝啊！野牛號！」（約翰喬），266「沒看過忍者騎機車啊？」。金貝貝对应 410..425，内容为 `@NN` 表情图号 |
| 426..1049 | 624 | 12 × 52 条卡片台词，编号 = 426 + 52×角色 + k |
| 1050..1373 | 324 | 12 × 27 个事件槽，编号 = 1050 + 27×角色 + 槽。例如 1074「哈哈！勝利總是在正義的一方！」= 約翰喬槽 24 |

**补充**
- **44.1 kHz 的 190 段**全部属于角色 2（忍太郎）和角色 6（宮本寶藏）：
  - 忍太郎：266–281、530–581、1104–1130
  - 宮本寶藏：330–345、738–789、1212–1238
- **exe 中无台词文本的 33 个编号**：0、58–74、92、94、96、124、131、133、134、156、161–164、173、190、194。这些编号有音频，但文本可能在运行时拼接，也可能已弃用。
- **与 v3.11 的差异**：`MultiverseJourney/Speaking.mkf` 同样是 1374 段，逐段 md5 比较只有 **#361**（糖糖「害人精！！」）不同，大小 33424→16254 B。

---

## 2. Effect.mkf（音效）与音效集表

### 2.1 容器（已验证）
- 文件大小 3,897,646 B。
- 首个 u32 X = 3,897,186（0x3B7762），索引表 115 项，没有哨兵，全部未压缩。
- 99 段是 RIFF WAV，格式统一为 PCM u8、单声道、22050 Hz。
- **#64..#79 共 16 段为 0 字节空占位**。
- 非空段总时长 176.0 s，合计 3,895,342 B。逐号时长见 `effect.index.json`。
- 按命名分两组：
  - 0..63 的 INAM 为 `Z-1-xxx`，编号 = 资源号 + 1。
  - 80..114 的 INAM 为 `Z-2-xxx`，或者没有 LIST。

### 2.2 「19 张音效表」在 exe 里，不在 mkf 里
表位于 exe 的 DGROUP 段。每条记录 8 字节 `{u32 Effect资源号, u32 运行时 IDirectSoundBuffer*（文件内为0）}`，以 0xFFFFFFFF 结尾，且**不按 4 字节对齐**，扫描时步长必须为 1。音效编号与 Effect 资源号是恒等关系。v2.06 扫描结果（`sfx-tables.v206.json`）：

| v2.06 表基址 | 音效号 | 语境（依据载入点所在函数和同函数的场景曲） |
|---|---|---|
| 0x47f5fa | 0,1,2,4,3 | 全局 UI 集，启动时 push@0x401721 载入 |
| 0x47f62a | 7,9,10,32,33,34,35,36,37,38,43,44,45,46,53,47,48,49,50,54,55,56,15,62 | 棋盘主界面，载入 0x407d0f、释放 0x407e5f |
| 0x46ab7c | 5 | 开局设定（fcn.00406bb2） |
| 0x472ee7 | 11,12,13,14,16,17,18,15 | 企鵝挖寶（同函数播 MIDI13） |
| 0x472f2f | 19,20,21 | 七彩氣球（MIDI12） |
| 0x472f4f | 22,23,24,15 | 喜從天降（MIDI11） |
| 0x472f88 | 25,26 | 小游戏公共部分（fcn.00415184，推断为入场/结算） |
| 0x4733c3 | 40,41 | 股市行情（fcn.0042aafd，引用「持有股數表／股價表」） |
| 0x4733db | 61 | 上市公司分红（fcn.0042b017） |
| 0x47349f | 31 | 乐透投注 |
| 0x4734af | 57,58 | 乐透开奖 |
| 0x47361b | 39 | 魔法屋 |
| 0x47394b | 27,28,60 | 月结（fcn.00438bf2，引用「存款／利息／貸款中」） |
| 0x4739ee | 29,63 | 拍卖（引用「標價：」） |
| 0x473b60 / 0x473b70 | 51 / 52 | fcn.0043df4a / 0043e43e（「%d元」输入类界面，推断） |
| 0x46ab8c | 8 | 没有任何代码引用，是死表 |
| 0x473342 / 0x474110 | 0 | 假阳性 |

**与 rich4-spec（v3.11）对照**：16 张有效表的内容逐项一致，只是地址平移，例如 v3.11 的 0x48231a/0x48234a 对应 v2.06 的 0x47f5fa/0x47f62a。

**播放入口与调用统计**
- v2.06 的播放函数 play_sound_effect 位于 **0x4529ee**，是按字节序列定位 v3.11 的 0x4542ce 得到的。
- 共 152 处调用，其中 131 处能静态解析出编号，结果见 `sfx-callsites.v206.json`。
- 调用次数最多的编号：1（44 次，推断为通用点击/确认）、4（17 次）、0（10 次）、2（7 次）。

**未被任何表引用的编号**
- 6、8、30、42：未引用。
- 59：经 FLIC 动态播放。

### 2.3 #80..#114 是「FLIC 同步音效」
- 播放入口是 `fcn.0044fc76(flic, x, y, flags, sfxId)`：
  - sfxId≠-1 时，先 0x452a24 按需载入，再由 0x452a83 在首帧播放。
- 调用点共 55 处，逐一解出（图号是 Data.mkf 资源号，描述依据样张目视）：

| FLIC | 音效 | 说明 |
|---|---|---|
| 499..510 | 102..113 | 12 位神明降临，440×440。依次为小財神 499/102、大財神 500/103、小福神 501/104、大福神 502/105、小窮神 503/106、504/107、505/108、506/109、天使 507/110、**惡魔 508/112**、**土地公 509/111**、死神 510/113 |
| 483 | 92 | 救护车，440×74，62 帧×100 ms = 6.2 s，与音效 6.2 s 完全一致；fcn.0043d6c0 医院 |
| 497 | 94 | 警车，35 帧×71 ms ≈ 2.49 s，音效 2.467 s；fcn.0043c03f 监狱 |
| 482 | 90 | 烟火，另见节日表 |
| 514 | 100 | 破产，房屋倒塌 |
| 515 | 101 | 地图崩裂（游戏结束，推断） |
| 517 | 96 | 飞机（出国观光，推断） |
| 492 / 498 | 84 | UFO 光束 |
| 490 | 86 | 天降光束与爆炸（推断为飞弹） |
| 488 | 97 | 坦克拆屋 |
| 493 / 494 | 89 / 88 | 龙卷风 |
| 486 | 87 | 碎屑爆炸 |
| 484 | 82 | 小爆炸 |
| 511 | 85 | 小爆炸 |
| 491 | 93 | 烟雾 |
| 485 | 95 | 110×110 烟雾（推断为神明离身）；喜從天降接到炸弹也播它（fcn.00414f20 @0x415016 载入，fcn.00412b66 @0x412d2b 画在接物者 x−55、y=295） |
| 496 | 98 | 旋转的 Ticket（得点券），位置 (204,180) |
| 495 | 99 | 卡片翻出问号（得卡片），位置 (208,180) |
| 516 | 80 | — |
| 513 | 114 | 圣诞 |

- **动态 FLIC 的音效**：91、97、81、83、59。

### 2.4 其他
- `InstOK.wav` 和 `InstSel.wav` 是安装程序音效（PCM s16，22050 Hz），不属于游戏音效。
- 音量：RICH4.CFG +2 为音乐音量（0..4），+3 为音效音量（0..4）。共享盘样本为 `01 01 04 04 01 00`。

---

## 3. 音乐：Steam 版 OGG 与 MIDI/场景的映射

### 3.1 Steam 版的实现方式（已从 exe 和 DxWnd 双向证实）

**CD 音轨模拟**
- Steam 版用 DxWnd 的 VIRTUALCDAUDIO 模拟 CD 音轨，dxwnd.log 中有 `cdAudioPath=..\Media`，fakecdlabel 为 Rich4CD。
- `Media/Music/trackNN.ogg` 就是虚拟光盘的第 NN 轨，track01 为数据轨。
- `tracklen.nfo` 是虚拟 TOC，格式为 `track=N type=d|o pos=秒 len=秒`。其中 track02..09 的 len 与 OGG 实长不符（例如 track03 标 141，实长 169.18 s），**不能作为时长依据**。

**exe 中的 CD 模式判定**
- 0x452d1d 处 `open cdaudio!%s alias cdtrack wait`，随后查询轨数；有轨时 0x452d81 设置 `[0x47c594]=1`，即 CD 模式。

**棋盘背景曲（fcn.004533f0）**
- 参数 n≠0 时，选第 n-1 首（乐曲点播）。
- n=0 时，按 `(cur+1)&7` 轮播。
- MIDI 模式下用 `open sequencer!<名>`，名字表的指针位于 0x47c597。
- **CD 模式下为 `play cdtrack from %d notify`，%d = idx+2**（0x4534ef `add eax,2`）。

**场景曲（fcn.00453037）**
- 只走 MIDI：名字表 0x47c5b7 = 0x47c597+0x20，即取第 8+arg 个名字。
- 参数 bit15（0x8000）表示「不记录棋盘曲的续播点」。

**DxWnd 的 MIDI→CD 重定向**
- 游戏目录下没有 .MID 文件。DxWnd 读取 `Midi.TXT`，字符串位于 dxwnd.dll 0x1016f334。
- 读取前先执行 `mov ebx,2`（0x1008b344），每读一行 `inc ebx`（0x1008b7a4）。
- 最终把 `play mid` 改写成 `play cdaudio from %d notify`。
- 所以 **Midi.txt 第 k 行（0 起）对应 track(k+2)**，与 exe 中「CD 轨 = idx+2」一致。

**循环规则**
- 收到 MM_MCINOTIFY（0x3b9，成功）后调用 fcn.0045338b：
  - 当前是棋盘曲时，切到下一首。
  - 当前是场景曲时，执行 `play mid from 0`，原曲循环。
- 场景曲打断棋盘曲时，续播点压栈保存（0x47c5fb），离开场景后从中断处接着播。

### 3.2 轨号总表
- 音频格式：Vorbis，44.1 kHz，立体声。
- 25 轨合计 2045.9 s、115,780,258 B，平均约 453 kbps。
- 下表中「建议循环区间」是用 silencedetect（-50 dB）测得的首尾静音边界。

| 轨 | MIDI 名 | 实长 s | 用途 | 建议循环区间 s |
|---|---|---|---|---|
| 02 | RICH08 | 143.92 | 棋盘轮播 #0 | 0–141.89 |
| 03 | RICH16 | 169.18 | 棋盘 #1 | 0–166.32 |
| 04 | RICH17 | 181.95 | 棋盘 #2 | 0–179.55 |
| 05 | RICH18 | 180.09 | 棋盘 #3 | 0–178.03 |
| 06 | RICH19 | 153.44 | 棋盘 #4 | 0–153.44 |
| 07 | RICH20 | 187.15 | 棋盘 #5 | 0–184.39 |
| 08 | RICH21 | 130.26 | 棋盘 #6 | 0–128.09 |
| 09 | RICH22 | 171.78 | 棋盘 #7 | 0–169.72 |
| 10 | MIDI01 | 48.76 | 标题 | 0.48–48.02 |
| 11 | MIDI02 | 48.20 | 开局设定 | 0.25–48.20 |
| 12 | MIDI03 | 16.63 | 破产 | 0–15.44 |
| 13 | MIDI04 | 39.24 | **v2.06 和 v3.11 均无引用** | — |
| 14 | MIDI05 | 54.52 | 银行 | 0.34–52.30 |
| 15 | MIDI06 | 79.18 | 拍卖；破产分支（esi>3） | 0.50–77.29 |
| 16 | MIDI07 | 51.27 | 道具商店；乐透投注；游戏结束结算画面（0x8006，随后播 END.AVI/OVER.AVI） | 0.48–49.35 |
| 17 | MIDI08 | 66.78 | 魔法屋 | 0.35–63.61 |
| 18 | MIDI09 | 21.73 | 乐透开奖 | 0.42–21.09 |
| 19 | MIDI10 | 41.38 | 月结（存款利息/月末） | 0.27–39.75 |
| 20 | MIDI11 | 69.80 | 喜從天降 | 0–68.44 |
| 21 | MIDI12 | 45.05 | 七彩氣球 | 0.30–44.25 |
| 22 | MIDI13 | 43.37 | 企鵝挖寶 | 0.23–42.60 |
| 23 | MIDI14-1 | 40.08 | 圣诞 12/25 | 0.30–39.15 |
| 24 | MIDI14-2 | 19.88 | 农历正月初一～初三 | 0.25–19.60 |
| 25 | MIDI15 | 21.50 | 监狱 | 0.25–20.40 |
| 26 | MIDI16 | 20.71 | 医院 | 0.31–19.57 |

**场景曲的调用点（v2.06）**
- 标题：0x402a16，所在函数引用字符串 "V2.06"。
- 开局设定：0x406e52（0x8001）。
- 结算：0x40746e（0x8006）。
- 破产：0x40ca4e(2)，另有分支 0x40cc93(5)。
- 三个小游戏：0x414cc0(12)、0x414ebe(11)、0x4150de(10)。
- 商店：0x42e0ea(6)。乐透投注：0x430a24(6)。乐透开奖：0x430b89(8)。
- 魔法屋：0x432c50/0x432ed8(7)。
- 银行：0x43599e/0x435c0a(4)。
- 月结：0x438e97(9)。拍卖：0x43b437(5)。
- 监狱：0x43c0d1(15)。医院：0x43d75e(16)。
- 节日：0x450d26（music|0x8000）。
- v3.11 的 22 处调用参数相同；它多出的 0x4026fd 同样是 0 号曲。

**节日表**
- 位置 VA 0x47d6ab，每张地图 24 项 × 12 B，按 map×288 偏移。
- 记录布局：`type(0阳历/1农历/2特殊), 月, 日, x, flags(bit0=播FLIC, bit2=切音乐), u16 FLIC(Data.mkf), u16 音效, u16 音乐idx`。
- 各地图共有的条目：
  - 12/25：flags 0x0f、FLIC 513、音效 114、music 13 → 23 轨。
  - 农历 1/1：flags 0x04、music 14 → 24 轨。
  - 1/1：FLIC 482 烟火 + 音效 90。
- 台湾图另有 10/10 同样播放 FLIC 482 + 音效 90。

**轮播曲目名**：8 首轮播曲目名（攜手創奇蹟 等）与 RICH08/16..22 的对应顺序无法从文件中得出。

---

## 4. 视频

### 4.1 AVI（共享盘 Media，ffprobe 结果）

所有 AVI 的视频编码都是 **Indeo 5（IV50，yuv410p）**。

| 文件 | 分辨率 | fps | 帧数 | 时长 s | 音频 |
|---|---|---|---|---|---|
| Start.avi（片头） | 640×480 | 15 | 508 | 33.87 | IMA ADPCM 22050 立体声 |
| Flytw / Flychina / Flyjp / Flyus（各地图飞行过场） | 640×480 | 15 | 100 | 6.67 | IMA ADPCM 22050 立体声 |
| End.avi | **320×240** | 15 | 450 | 30.0 | IMA ADPCM 22050 立体声 |
| Over.avi（制作群，从光盘 `%c:\OVER.AVI` 读取） | 640×480 | 10 | 1295 | 129.5 | IMA ADPCM 22050 立体声 |
| airplane.avi | 640×480 | 9.989 | 133 | 13.31 | PCM s16 44.1k 单声道 |
| Thanks.avi | 640×480 | 9.989 | 1820 | 182.2 | PCM s16 22050 立体声 |
| END01..12.AVI | 640×480 | 10 | 328–620 | 32.8–62.0 | PCM s16 44.1k 立体声 |

**各版本的引用情况**
- v2.06 exe 只引用 START、END、OVER、FLYTW/CHINA/JP/US。
- v3.11 另外引用 `END%02d.AVI`、THANKS.AVI、AIRPLANE.AVI。
- 按目视判断，END01..12 依角色号 0..11 排列，例如 01 牛仔、02 企鹅婚礼、11 篮球。这一点是推断。

**转换验证**
- ffmpeg 8.1.1 对全部 AVI 做 `-f null` 解码，无任何错误。
- 批量转换（x264 medium CRF23 + AAC96k；VP9 CRF33 + Opus64k）：
  - 源文件合计 418.3 MB。
  - **MP4 合计 102.8 MB，WebM 合计 78.3 MB**。
  - 仅 v2.06 用到的 7 个文件转 MP4 约 23 MB。
- Start.avi 与 Start.webm 第 12 秒的并排截图目视一致。

### 4.2 MKF 内的 FLIC 动画

**格式**
- 标准 Autodesk FLC：magic 0xAF12，8bpp，带调色板。
- 块类型：4 COLOR_256、7 DELTA_FLC、15 BYTE_RUN、18 PSTAMP。
- 每段带一个 ring 帧。
- 帧间隔取头部 +16 的毫秒值。

**数量**
- Data.mkf：72 个，均为 LZHUF 压缩，imgSize=0。
- Panel.mkf：8 个。
- jump.mkf：25 个。
- help.mkf：0 个。

**主要条目**
- **Data 375..398**：12 个角色 × 2 个表情动画，64–192 px，71 ms/帧。
- **Data 482..517**：事件和神明动画，多为 440×440。
- **Data 518..529**：12 个角色的降落伞动画，440×440，42 ms/帧。
- **Panel**：
  - #4/5/6：1、2、3 颗骰子，189×285，36 帧，14 ms/帧。
  - #14：跑马灯框。
  - #16：乐透摇奖机 275×270，42 帧。
  - #17：彩带 280×480。
  - #20：魔法屋 640×480，25 帧，不透明。
  - #78：「READY」640×480，20 帧，114 ms/帧（小游戏入场）。
- **jump**：
  - #42：机舱门 220×240。
  - #43..54：12 个角色自由落体，640×480，28 ms/帧。
  - #55..66：12 个角色开伞，42 ms/帧。

**透明色键 = 调色板索引 0（已验证）**
- 抽查的 44 段中，40 段的四角像素都是索引 0，且该索引覆盖 46%–99% 的像素。该索引对应的 RGB 各不相同（黑、亮绿、暗绿、青、蓝），所以透明判定必须按索引，不能按颜色。
- 不透明的例外只有 3 段：Panel#16（摇奖机）、Panel#20（魔法屋）、jump#42（机舱门）。

**flags 参数**
- 由 fcn.0044f514 解析：
  - bit0：写入 0x4895fa。
  - bit1：可点击跳过，检查 WM_LBUTTONUP/RBUTTONUP/KEYUP。
  - bit2：含义未定。
  - bit3：清除 bit0。
  - bits16–23：非零时分配 440×440×2 的背景缓冲。
  - bit31：全屏模式。

**交付方式的体积与显存对比**（`flic-atlas/compare.json`）

| FLIC | FLC 原始 | FLC brotli | 整幅 PNG 图集（显存 RGBA） | 裁剪 PNG 图集（显存） | VP9 WebM |
|---|---|---|---|---|---|
| Data#482（66 帧 440²） | 375 KB | 114 KB | 269 KB（53 MB） | 232 KB（20 MB） | — |
| Data#499（神明） | 478 KB | 216 KB | 440 KB（18.5 MB） | 542 KB（8.7 MB） | 59 KB（带 alpha） |
| Data#513（90 帧） | 971 KB | 320 KB | 760 KB（66.5 MB） | 809 KB（61 MB） | 323 KB（带 alpha） |
| Panel#20（640×480 不透明） | 2.44 MB | 1.06 MB | 2.66 MB（29 MB） | — | 274 KB |

**推荐做法**
- 离线：把 FLC 从 MKF 解压成独立的 `.flc`，传输时用 brotli 或 gzip。
- 客户端：用约 150 行自写解码器画到单张 canvas 上，索引 0 视为透明。这种方式体积最小，帧时序和调色板与原版一致，显存只需要一幅画面。
- 也可以用 PNG 序列帧图集，但只适合小动画（骰子、表情、Ticket 等），440×440 的长动画显存占用太大。
- WebM 只适合 3 段不透明的全屏动画。VP9 的 alpha 在 Safari 上不可用，不作为透明动画的通用方案。

---

## 5. 浏览器端推荐格式与体积（1473 个文件全量实测）

**语音和音效**

| 方案 | 语音 1374 段 | 音效 99 段 | 说明 |
|---|---|---|---|
| 原始 WAV（u8） | 56.9 MB | 3.9 MB | 可以直接 decodeAudioData，但体积大 |
| **Ogg Opus 单声道 32k VBR（首选）** | **9.64 MB** | **0.76 MB** | Chrome/Firefox 支持；Safari 自 18.4 起支持 Ogg Opus/Vorbis |
| MP3 LAME V6 单声道（兼容回退） | 14.26 MB | 0.94 MB | 有编码器延迟，不适合要求精确起点的短音效 |
| AAC-LC 48k 单声道 .m4a | 15.78 MB | 1.19 MB | 通用 |

**按需加载粒度**
- NPC 与新闻（0..233）的 Opus 共 1.87 MB。
- 每个角色 95 条（16+52+27）的 Opus 为 0.33–0.78 MB，4 人一局约 3 MB。
- 建议：音效在进入对应界面时按「音效集」预载，与原版一致；语音按「系统 + 本局 4 名角色」懒加载。

**音乐**
- 选项一：原始 OGG 直接供给，约 116 MB。
- 选项二：转成 Opus 112k 立体声，约 28.6 MB（实测 track10 为 775 KB/48.8 s）。
- 选项三：AAC 128k 作回退，约 32.7 MB。
- 长的棋盘曲用 `<audio>`（可接 MediaElementSource）流式播放；场景曲用 AudioBufferSourceNode，按上表的 loopStart/loopEnd 循环。

**视频**
- 首选 MP4（H.264 + AAC，+faststart），所有浏览器都能播。
- 可选 WebM（VP9 + Opus），体积约为 MP4 的 76%。

**ffmpeg 命令**（素材只放在本地只读目录，转换产物放在 gitignore 的 `rich4-data/` 或 `.cache/`）

```sh
# 语音/音效
ffmpeg -i in.wav -ac 1 -c:a libopus -b:a 32k -vbr on -application audio out.ogg
ffmpeg -i in.wav -ac 1 -c:a libmp3lame -q:a 6 out.mp3            # 回退
ffmpeg -i in.wav -ac 1 -c:a aac -b:a 48k -movflags +faststart out.m4a
# 音乐
ffmpeg -i track02.ogg -c:a libopus -b:a 112k track02.opus.ogg
ffmpeg -i track02.ogg -c:a aac -b:a 128k track02.m4a                # 回退
# 视频（Indeo5 → H.264 / VP9）
ffmpeg -i Start.avi -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 128k Start.mp4
ffmpeg -i Start.avi -c:v libvpx-vp9 -crf 32 -b:v 0 -row-mt 1 -deadline good -cpu-used 2 -pix_fmt yuv420p -c:a libopus -b:a 96k Start.webm
ffmpeg -i End.avi -vf scale=640:480:flags=lanczos ... End.mp4       # End.avi 仅 320×240，可选放大
# FLIC → WebM（仅不透明全屏动画）：解码帧后以 rawvideo 管道输入
... | ffmpeg -f rawvideo -pix_fmt rgba -s 640x480 -framerate 14.08 -i - -c:v libvpx-vp9 -crf 30 -b:v 0 out.webm
```

WAV 资源可以直接从 MKF 切片取出，不需要任何解码，脚本见 `test/ar_export_audio.py`。

**版权说明**：以上转换只用于用户私人和朋友游玩，素材不进仓库、不进镜像。

## verified
- Speaking.mkf：索引表偏移 X=56,965,200，共 1374 项，全部未压缩，每段资源体都是完整的 RIFF WAV。格式为 PCM u8 单声道，22050 Hz 1184 段、44100 Hz 190 段。总时长 2283.9 s，最短 0.137 s，最长 6.406 s。RIFF 长度字段与资源大小全部一致（0 处不符）。依据：test/ar_wav_stats.py 的输出，speaking.index.json。
- 导出 17 段语音和 16 段音效样本，存放在 .cache/assets-research/audio/wav/，ffprobe 均识别为 pcm_u8 且 ffmpeg 解码无错误。另外全量导出 1473 段并批量转码，0 错误。
- 44.1 kHz 的编号区间为 266-281、330-345、530-581、738-789、1104-1130、1212-1238，按公式对应忍太郎（角色 2）和宫本宝藏（角色 6）。
- v2.06 exe 中有 1343 条 '#NNNN' 开头的 Big5 台词字符串，覆盖 1341/1374 个语音号；234..425 为 12 角色 × 16 条道具台词，例如 #266「沒看過忍者騎機車啊？」，#330「去吧，我的HONDA！」。结果见 speaking.manifest.json。
- v2.06 与 v3.11 的 Speaking.mkf 逐段 md5 比较，只有 #361 不同，大小 33424→16254 B。
- Effect.mkf：115 项，99 段为 WAV（u8 单声道 22050 Hz，合计 176.0 s），#64..#79 为 16 段 0 字节空占位。
- 音效集表在 exe 的 DGROUP 段，以 1 字节步长扫描，v2.06 有 16 张表被 push 引用，内容与 rich4-spec v3.11 的表逐项相同。0x46ab8c {8} 没有任何代码引用。play_sound_effect 在 v2.06 位于 0x4529ee（按 v3.11 0x4542ce 的字节序列定位），共 152 处调用。
- FLIC 播放函数 fcn.0044fc76 的 55 处调用逐一解出了（Data.mkf 图号，音效号）配对。时长互相吻合：救护车 483 为 62 帧×100 ms = 6.2 s，音效 92 为 6.200 s；警车 497 为 35×71 ms，音效 94 为 2.467 s。
- 音乐：exe 的 0x4534ef 处 `add eax,2` 后执行 'play cdtrack from %d notify'，即棋盘曲 CD 轨号 = idx+2。场景曲函数 0x453037 只走 sequencer，名字表位于 0x47c5b7。DxWnd 在 0x1008b344 执行 `mov ebx,2`，然后 fopen('Midi.TXT')，每读一行 inc ebx（0x1008b7a4），并把 'play mid' 改写为 'play cdaudio from %d notify'。由此得出 Midi.txt 第 k 行对应 track k+2。
- 25 条 OGG 的 ffprobe 实测：均为 Vorbis 44.1 kHz 立体声，合计 2045.9 s、115,780,258 B。实长与 tracklen.nfo 不符，例如 track03 实长 169.18 s，nfo 标 141。
- 场景参数：v2.06 的 21 处调用与 v3.11 的 22 处调用参数集合相同。按同函数引用的字符串核对了语境：'V2.06' 为标题；'%s向銀行貸款' 为银行；'存款：/利息：' 为月结；'標價：' 为拍卖；'保釋%s' 为监狱；'得點券%d點' 为企鹅挖宝。
- 节日表 VA 0x47d6ab 的 4 张图已全部解析：12/25 为 FLIC 513、音效 114、music 13；农历 1/1–1/3 为 music 14；1/1 为 FLIC 482、音效 90。
- AVI：ffprobe 显示全部为 Indeo5（IV50）。ffmpeg 8.1.1 对 7 个代表文件做 -f null 解码，无错误。21 个 AVI 全部转码：MP4 合计 102.8 MB，WebM 合计 78.3 MB（源文件 418.3 MB）。Start.avi 与 WebM 第 12 秒并排截图目视一致，图为 video/Start_12s_avi_vs_webm.png。
- FLIC 扫描结果：Data.mkf 72 个、Panel.mkf 8 个、jump.mkf 25 个，全部为 0xAF12 的 8bpp FLC。已出样张并目视识别内容：12 神明、救护车、警车、烟火、骰子 1/2/3、READY、12 角色降落伞等。
- 透明色键为调色板索引 0：抽查的 44 段中，40 段的四角像素都是索引 0，占比 46–99%；只有 Panel#16、Panel#20、jump#42 为不透明。
- 体积对比实测：Data#482 的 FLC 经 brotli 为 114 KB，整幅 PNG 图集需 53 MB 显存；Panel#20 的 FLC 经 brotli 为 1.06 MB，VP9 WebM 为 274 KB。
- 音频转码体积实测：语音 WAV 56.9 MB，Opus 32k 为 9.64 MB，MP3 V6 为 14.26 MB，AAC 48k 为 15.78 MB；音效分别为 3.9 / 0.76 / 0.94 / 1.19 MB。

## unknowns
- 8 首棋盘曲（RICH08、RICH16..22，对应 track02..09）与曲名（攜手創奇蹟 等）的对应顺序无法从文件中得出，需要实际试听比对。
- MIDI04（track13，39.2 s）在 v2.06 和 v3.11 中都没有静态引用，用途不明，也可能是弃用曲。
- 神明 FLIC 504/505/506 分别是大窮神、小衰神、大衰神中的哪一个，目前只凭目视，属推断，需要对照 r_deities 的神明编号表确认。另有几段 FLIC 的语境也属推断：515（地图崩裂→游戏结束）、517（飞机→出国观光）、490（飞弹）、516。
- 动态播放的音效号 91、97、81、83、59 所对应的 FLIC 在运行时才确定，具体动画未逐一追踪。音效 6、8、30、42 没有引用，可能是死资源。
- 0..63 号 UI 和棋盘音效的具体动作语义（例如 1 号是点击还是确认，7/9/10 是脚步、机车还是汽车）没有逐个调用点人工确认，需要试听或逐函数阅读 151 处调用点。
- Speaking 中 33 个编号在 exe 里找不到 '#NNNN' 台词文本：0、58–74、92、94、96、124、131、133、134、156、161–164、173、190、194。用途待查，文本可能在运行时拼接。
- fcn.0044f514 的 flags 中，bit2 和 bits8–15 的含义未确定；bits16–23 疑为背景保存相关参数。
- DxWnd 的虚拟 CD 在执行 'play cdaudio from N'（不带 to）时，是只播这一轨还是一直播到盘尾，没有实测。网页版可以按 MIDI 模式的语义实现：棋盘曲 (idx+1)&7 轮播，场景曲单曲循环。
- END01..12 与角色号的对应（END%02d = 角色 + 1）只凭画面判断，属推断；另外 END07 采样帧只显示制作名单，没能确认对应角色。
- 本次的 test/ar_flic_*.mjs 依赖其他工作流在 test/ui-lib.mjs 中写的 LZHUF 和 FLC 解码器，那个文件如果改动，这些脚本可能需要同步调整。
- Safari 从 18.4 起支持 Ogg Opus/Vorbis，这一点来自网络检索（WebKit 发布说明与相关报道），没有在真机上验证。更旧的 Safari 需要回退到 MP3 或 AAC。

## artifacts
- <repo>/.cache/assets-research/audio/audio-manifest.v206.json
- <repo>/.cache/assets-research/audio/speaking.manifest.json
- <repo>/.cache/assets-research/audio/speaking.index.json
- <repo>/.cache/assets-research/audio/effect.index.json
- <repo>/.cache/assets-research/audio/sfx-tables.v206.json
- <repo>/.cache/assets-research/audio/sfx-callsites.v206.json
- <repo>/.cache/assets-research/audio/flic.index.json
- <repo>/.cache/assets-research/audio/flic-data-482-529.png
- <repo>/.cache/assets-research/audio/flic-data-375-398.png
- <repo>/.cache/assets-research/audio/flic-data-misc.png
- <repo>/.cache/assets-research/audio/flic-data-495-496.png
- <repo>/.cache/assets-research/audio/flic-panel.png
- <repo>/.cache/assets-research/audio/flic-jump.png
- <repo>/.cache/assets-research/audio/flic-atlas/compare.json
- <repo>/.cache/assets-research/audio/flic-atlas/Data483_trim.png
- <repo>/.cache/assets-research/audio/flic-atlas/Data499_trim.png
- <repo>/.cache/assets-research/audio/flic-atlas/Panel20.webm
- <repo>/.cache/assets-research/audio/flic-atlas/Data499_alpha.webm
- <repo>/.cache/assets-research/audio/flic-atlas/Data513_alpha.webm
- <repo>/.cache/assets-research/audio/flic-atlas/jump55_alpha.webm
- <repo>/.cache/assets-research/audio/wav/
- <repo>/.cache/assets-research/audio/all/opus/
- <repo>/.cache/assets-research/audio/music/track10.opus.ogg
- <repo>/.cache/assets-research/audio/music/track10.m4a
- <repo>/.cache/assets-research/video/Start.mp4
- <repo>/.cache/assets-research/video/Start.webm
- <repo>/.cache/assets-research/video/END01.mp4
- <repo>/.cache/assets-research/video/Start_12s_avi_vs_webm.png
- <repo>/.cache/assets-research/video/END01_20s.png
- <repo>/.cache/assets-research/video/avi-contact.png
- <repo>/.cache/assets-research/video/all/video-convert.json
- <repo>/test/ar_mkf_survey.py
- <repo>/test/ar_wav_stats.py
- <repo>/test/ar_wav_chunks.py
- <repo>/test/ar_export_audio.py
- <repo>/test/ar_audio_convert.py
- <repo>/test/ar_sfx_tables.py
- <repo>/test/ar_voice_text.py
- <repo>/test/ar_flic_survey.mjs
- <repo>/test/ar_flic_sheet.mjs
- <repo>/test/ar_flic_key.mjs
- <repo>/test/ar_flic_formats.mjs
- <repo>/test/ar_flic_webm.mjs
- <repo>/test/ar_video_convert.py
- <repo>/test/ar_build_manifest.py