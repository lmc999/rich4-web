# MKF 容器总览与 LZHUF 解压：调研结论与实现规格

## 0. 结论

- **容器格式**：9 个 MKF 文件全部按同一套规则解析成功，共 2782 个资源。
  - 没有任何文件带哨兵项。每个资源都首尾相接，间隙恒为 0。
  - 等式 `文件大小 = 4 + Σ(16 + stored) + 4×count` 在所有文件上成立。
- **压缩资源**：共 440 个。
  - v2.06 有 417 个：Data 270、Panel 92、jump 36、map 19。
  - v3.11 map.mkf 有 23 个。
  - Speaking、Effect、help、MapDat 里没有压缩资源。
- **解压实现**：自写的 `test/lzhuf-proto.ts` 把全部 440 个资源解压成功，每个都通过以下检查：
  - 输出长度等于 uncompressed；
  - 输出满之后的下一个符号正好是结束标记（dist=0xFFF）；
  - 按结束标记算出的字节数 `ceil(bits/8)` 与 stored 逐个相等；
  - 最后一次回溯没有越界（overrun=0）。
- **与原版代码逐字节比对**：用 radare2 ESIL 仿真 v2.06 exe 自带的解压函数（VA 0x4536a0），抽了 6 个资源，结果全部与自写实现逐字节一致。其中 2 个资源会触发频率减半（rescale）。
- **imgOff/imgSize 的含义**：解压后要转像素格式的那段 RGB555 字（16 位）。
  - 原版把原生 RGB555 转成显示模式对应的格式（565 / BGR565 / 444）。
  - 浏览器端**不必做这一步**，直接把 RGB555 展开成 RGBA 即可。
  - SPR 和 GND 的这一段只覆盖 512 字节的调色板；SMP 和 RAW16 则覆盖全部像素。

## 1. 容器格式（已在全部 9 个文件上验证）

```
X = u32le@0                    # 索引表偏移
N = (fileLen - X)/4            # 索引项数（9 个文件均无哨兵，即 N == 资源数）
start[i] = u32le@(X+4i)        # 资源 i 的 16 字节头的绝对偏移；start[0]==4，严格递增
hdr@start[i] = {uncompressed u32, stored u32, imgOff u32, imgSize u32}
body = file[start[i]+16 : start[i]+16+stored]   # 恰好结束于 start[i+1]（末项结束于 X）
compressed ⇔ stored != uncompressed             # 所有压缩项 stored < uncompressed
```

- 空资源：Effect.mkf 的 #64–#79（16 个）只有头，头四个字段全为 0。
- 与仓库代码的关系：`tools/extract/src/mkf/container.ts` 的不变量检查在 9 个文件上全部成立。需要补的有三点：
  - 压缩资源要先解压，再按魔数分类；
  - 类型要增加 FLIC、WAVE、RAW16、TEXT、EMPTY；
  - `read()` 要接上解压器。

## 2. 各文件统计

完整清单见 `.cache/assets-research/mkf-index/<edition>-<file>.json`。每项含 i、offset、uncompressed、stored、imgOff、imgSize、compressed、ratio、gap、kind、head16、payloadSha1、detail，以及 lzhuf 统计。

| 文件 | 大小(B) | X | 资源数 | 压缩数 | Σstored / Σraw | 类型分布 |
|---|---|---|---|---|---|---|
| Game/Data.mkf | 53,296,712 | 53,294,468 | 561 | 270 | 53,285,488 / 76,721,183 | SPR 290、RAW16 190、FLIC 72、SMP 9 |
| Game/Panel.mkf | 25,351,066 | 25,350,614 | 113 | 92 | 25,348,802 / 39,209,885 | SPR 66、SMP 34、FLIC 8、DATA 4、RAW16 1 |
| Game/Speaking.mkf | 56,970,696 | 56,965,200 | 1374 | 0 | 56,943,212 | WAVE 1374 |
| Game/Effect.mkf | 3,897,646 | 3,897,186 | 115 | 0 | 3,895,342 | WAVE 99、EMPTY 16 |
| Game/jump.mkf | 26,091,102 | 26,090,834 | 67 | 36 | 26,089,758 / 31,142,337 | SPR 36、FLIC 25、RAW16 4、SMP 2 |
| Game/help.mkf | 363,252 | 362,852 | 100 | 0 | 361,248 | SMP 1、TEXT(Big5) 99 |
| Game/map.mkf | 40,312,048 | 40,311,448 | 150 | 19 | 40,309,044 / 41,847,295 | SPR 125、SMP 17、GND 4、DATA 4 |
| Game/MapDat.MKF | 36,560 | 36,544 | 4 | 0 | 36,476 | DATA 4 |
| MultiverseJourney/map.mkf (v3.11) | 76,639,739 | 76,638,547 | 298 | 23 | 76,633,775 / 80,635,538 | SPR 261、SMP 21、GND 8、DATA 8 |

### 编号区段

“C”表示压缩；完整区段见 `_ranges.json`。

**Data.mkf**
- #0 SMP C（43 帧）；#1 SMP；#2 SMP C；#3 SMP
- #4–86 RAW16 C，每项 80000 B，是 200×200 的节日 / 日历图（例：#4 为“元旦”）
- #87–374 SPR，8 位精灵
- #375–398 FLIC C，约 64–192 px 的小动画（例：#375 为 100×100、11 帧的牛仔角色）
- #399 SMP C
- #400–475 RAW16 C，每项 194776 B，是 388×251 的事件 / 新闻插画
- #476–479 SMP C
- #480–481 SPR C
- #482–529 FLIC C，其中 44 个为 440×440（例：#519 为跳伞动画）
- #530–559 RAW16 C，每项 84480 B，是 165×256 的卡片图，共 30 张，与 30 张卡对应
- #560 RAW16，640×480

**Panel.mkf**
- #0–2 SMP C（#0 为玩家信息侧栏 200×280×6）
- #3 SPR；#4–6 FLIC（189×285）；#7 SMP；#8 DATA(4824 B)
- #9–12 SMP（640×480 界面）；#13 SMP C；#14 FLIC C；#15 SMP C
- #16 FLIC；#17 FLIC C；#18 SMP
- #19 DATA：640×480 的 u8 区域编号图，值 0..13，呈六芒星形
- #20 FLIC C，640×480、25 帧
- #21 SPR；#22 DATA(24576 B)；#23–25 SMP
- #26 SMP C：拍卖场景，116 帧
- #27–62 SPR C；#63–74 SMP C；#75–77 SMP
- #78 FLIC C：小游戏共用的入场动画，640×480
- #79–80 SMP C；#81 DATA C（640×480 u8）；#82–90 SPR C；#91 SMP C
- #92 RAW16 C：640×480 的“南天门”背景
- #93–111 SPR C；#112 SMP C

**jump.mkf**
- #0–3 RAW16：640×480 背景
- #4 SMP；#5–40 SPR C（角色动作帧，例：#5 为 128×143×20）
- #41 SMP；#42–66 FLIC（640×480，另有 1 个 220×240）

**help.mkf**
- #0 SMP：12 帧，首帧 400×400
- #1–99：Big5 帮助文本

**Game/map.mkf**
- #0/2/4/6 GND，对应 4 张地图的地面纹理
- #1/3/5/7 地图结构数据（#1 长 7956 B）
- #8–12 SMP C（#8–11 为 200×200 地图缩略图）
- #13–14 SPR C；#15–26 SMP C；#27–149 SPR

**v3.11 map.mkf**
- #0..15 为 8 张图的 GND / 结构数据交替排列
- #16–24 SMP C；#25–26 SPR C；#27–38 SMP C；#39–297 SPR
- 与 v2.06 的对应关系：前 4 个 GND 的 sha1 相同；v2.06 #8–11 等于 v3.11 #16–19；v2.06 #13–26 等于 v3.11 #25–38。两边的压缩数据字节也完全相同。
- 这一偏移说明缩略图起点在 v2.06 是 8、在 v3.11 是 16。g_map.md 写的“16+id”只适用于 v3.11。

**MapDat.MKF 与 map.mkf 的对照**
- MapDat #0 等于 map.mkf #1，MapDat #3 等于 map.mkf #7。
- MapDat #1、#2 与 map.mkf #3、#5 **不同**（sha1 前缀 6e07.. ≠ cc80..，83db.. ≠ 0eeb..）。
- 这一点需要地图方向的研究者注意。

### 压缩资源的分布与压缩率

| 文件 | 数量 | stored / raw | 按类型 |
|---|---|---|---|
| Data | 270 | 0.440 | RAW16 189（0.367）、FLIC 72（0.559）、SMP 7（0.352）、SPR 2（0.497） |
| Panel | 92 | 0.368 | SPR 64（0.429）、SMP 22（0.300）、FLIC 4（0.635）、DATA 1（0.030）、RAW16 1（0.289） |
| jump | 36 | 0.367 | 全部为 SPR（#5–40） |
| map v2.06 | 19 | 0.286 | 编号 #8–26：SMP 17、SPR 2 |
| map v3.11 | 23 | 0.273 | 编号 #16–38：SMP 21、SPR 2 |

- 合计：440 个资源，stored 31,517,638 B，解压后 79,407,009 B。
- 解码过程中共出现 14,760,934 个字面量、8,245,848 次回溯、902 次频率减半。
- 两个版本中，**地图结构数据、GND、WAVE、TEXT 全部未压缩**。

## 3. LZHUF 解压规格

实现文件是 `test/lzhuf-proto.ts`，自写，没有拷贝任何 GPL 或无许可证的代码与表。

### 3.1 表按规则生成，并与自有 exe 逐字节核对

- 距离前缀表 DHI、DLEN 各 256 字节，按 g_map.md §6.3 的规则生成。
- 初始树按以下内存布局排列，共 4492 字节：`freq[642] | son[641] | prnt[641] | prnt_leaf[322]`，值以“索引×2”存储。
- 用 `test/lzhuf-tables-verify.ts` 在 exe 中搜索，三张表**都只命中一处**：

| 版本 | DHI | DLEN | 初始树 |
|---|---|---|---|
| v2.06 | VA 0x480710（文件 0x7f310） | VA 0x480810 | VA 0x480910 |
| v3.11 | VA 0x483430 | VA 0x483530 | VA 0x483630 |

### 3.2 原版代码位置（v2.06）

- **读资源**：0x44ec68。流程如下：
  1. `SetFilePointer(index[i])` 后读 16 字节头；
  2. 调用方没给缓冲区时 `malloc(uncompressed)`；
  3. stored==uncompressed 时直接读；否则把 stored 字节读进临时缓冲，调用 `0x4536a0(dst, src)`；
  4. imgSize≠0 时调用 `0x450028(buf+imgOff, imgSize)`；
  5. 缓冲区以 "SPR" 或 "SMP" 开头时，调用 `0x44e890` 把 gsize 链改写成指针。
- **解压主函数**：0x4536a0。
  - 只有 `(dst, src)` 两个参数，**没有长度参数，完全靠 dist==0xFFF 的结束标记停止**。
  - 字面量路径不检查边界，回溯用 `rep movsb`。
- **子函数**：
  - 0x45381b：解一个符号，用 `bt [esi], ecx` 逐位读取；
  - 0x453769：若 freq[640]==0x8000 则先减半，再更新树；
  - 0x45377b：更新树，用 `repe scasw` 找交换位置；
  - 0x45372c：频率减半。
- **工作表**：freq 在 0x481a9c，son 在 0x481fa0，prnt 在 0x4824a2，prnt_leaf 在 0x4829a4。
- **v3.11 的对应函数**：在 VA 0x455040。431 字节的函数体与 v2.06 相比只有 52 个字节不同，而且全部是表和工作区的绝对地址，算法完全相同。

### 3.3 算法

```
NCHAR=321, T=641, ROOT=640；freq/son/prnt 初值见 §3.1
bit(p) = (src[p>>3] >> (p&7)) & 1              # LSB-first
decode_symbol: c=son[ROOT]; while c<T: c=son[c+bit(pos++)]; s=c-T
               if freq[ROOT]==0x8000: rescale();  bump(s)
bump(s): e=prnt[T+s]; loop { a=++freq[e];
          if a<=freq[e+1] { e=prnt[e]; if e==0 return; continue }
          l=e+1; while freq[l]==a-1: l++; l--;
          freq[e]=freq[l]; freq[l]=a; i=son[e]; j=son[l];
          prnt[j]=e; if j<T: prnt[j+1]=e;
          prnt[i]=l; if i<T: prnt[i+1]=l;
          son[e]=j; son[l]=i; e=prnt[l]; if e==0 return }
rescale(): for s in 0..320: if freq[prnt[T+s]]&1: bump(s)
           for k in 0..640: freq[k]>>=1
main: while out<size:
        s=decode_symbol(); if s<256 { out+=s; continue }
        b=8 位@pos; L=DLEN[b]; hi=DHI[b]; lo6=6 位@(pos+L); pos+=L+6
        dist=(hi<<6)|lo6; if dist==0xFFF: break      # 结束标记
        n=s-253 (3..67); p=out_len-1-dist; 逐字节复制 n 次（允许源与目标重叠）
```

### 3.4 实现建议

- 按 uncompressed 分配输出，写满后停止。
- 严格模式下再解一个符号，确认它是结束标记，并确认 `ceil(bits/8)==stored`。本批数据 440/440 全部满足，可以把这一条当作损坏检测。
- 以下情况都报错：结束标记提前出现、回溯越界、读取越过源数据末尾。
- 性能：Node 24 在 1.6 秒内完成全部 9 个文件的解析、解压和 sha1，约 50 MB/s 以上。可以在服务端启动时做一次解包并缓存。

## 4. imgOff/imgSize 的含义与像素格式

### 4.1 原版的转换函数

v2.06 的 0x450028 签名为 `(ptr, nbytes)`，根据全局变量 `[0x4741a0]` 的像素格式处理：
- 0：原生 RGB555，不做转换；
- 1：转 RGB565，公式为 `(v & 0x1F) | ((v<<1) & 0xFFC0)`；
- 2：转 BGR565；
- 3：转 RGB444。

处理顺序是先每次两个像素（按 dword），剩一个再单独处理一个 word。

由此可知**存储格式是 X1R5G5B5**：
- 在所有 imgSize>0 的区域中，bit15 置位的 u16 数量为 **0**。
- 这些区域共约 3,580 万个字，其中来自压缩资源的约 2,440 万个。
- 如果解压有误，随机数据的 bit15 约有 50% 会置位，所以这同时也是对解压结果的检验。

浏览器端的换算：`r=(v>>10)&31, g=(v>>5)&31, b=v&31`，每个 5 位分量按 `x<<3 | x>>2` 扩展到 8 位。

### 4.2 各类资源的取值（全量校验结果在 `_validate.json`，bad 列表均为空）

| 类型 | imgOff | imgSize | 这段内容是什么 |
|---|---|---|---|
| SPR | start_offset（=12+12n） | 512 | 256 色 RGB555 调色板；像素是 8 位索引 |
| GND | 16 | 512 | 调色板 |
| SMP | start_offset | raw−start | 全部 16 位像素 |
| RAW16 | 4 | raw−4 | 16 位像素；原版前 2 个像素不做转换，属于怪癖，可忽略 |
| FLIC / WAVE / TEXT / DATA / EMPTY | 0 | 0 | 不需要转换 |

## 5. 各类资源的解析入口建议

**SPR**
- 头部依次为：`"SPR\0"`、u32 n、u32 start（=12+12n）。
- 块表每项 12 字节：`{i16 w, i16 h, i16 x, i16 y, u32 gsize}`，其中 gsize=w·h。在 12,838 个块上全部成立。
- 调色板位于 start，共 512 字节；首帧像素从 start+512 开始，之后各帧依次累加 gsize。
- 像素是 8 位索引，**没有 RLE**。
- 索引 0 表示透明：四角像素中 42,786 个是索引 0，palette[0] 在 462 个 SPR 里都是 0x0000。
- (x, y) 是锚点：角色图多为 x≈w/2、y≈h（脚底）；y 可能为负。
- 建议输出成 RGBA 图集，并附一份帧 JSON，记录 w、h、ax、ay。

**SMP**
- 头部与 SPR 相同，但 gsize=2·w·h（在 1,209 个块上全部成立）。
- 像素是 16 位 RGB555，从 start 开始，没有调色板。
- 透明色推测是 0x0000：四角像素中 2,964 个为 0。整屏背景类资源不透明，需要按用途区分。

**GND**
- 布局依次为：`"GND\0"`、u16 w=72、u16 h=72、u32 n=5184、u32 0；调色板位于 16（512 字节）；u16[n] 索引表位于 528；之后从 528+2n 开始是 n 个 32×32 的 8 位图块。
- 12 个 GND 的索引表都是恒等映射。
- 大小公式为 `raw = 16+512+2n+1024n = 5,319,312`。
- 图块按行优先拼接，得到一张完整的 2304×2304 俯视地面纹理，已用 1/4 缩略图目视确认。透视投影在渲染时再做，见 r_references §3。

**RAW16**
- 没有头部。尺寸只能靠字节数判断：
  - 80000 → 200×200
  - 194776 → 388×251
  - 84480 → 165×256
  - 614400 → 640×480
- 这些尺寸是用行自相关找到最小误差、再目视样图确认的。exe 中硬编码尺寸的位置尚未找到。

**FLIC**
- 标准 Autodesk FLC：魔数 0xAF12，8 位色，头部 128 字节，第一帧的偏移在头部 +80（oframe1），帧间隔在 +16（毫秒，样本为 71 ms）。
- 帧块类型为 0xF1FA，子块类型：4（COLOR_256）、15（BRUN）、7（DELTA_FLC）、16（COPY）、18（PSTAMP）。帧块数 = frames+1（末帧是循环帧）。
- 105 个 FLIC 的帧链都恰好走到文件尾。
- Panel #20 的末帧中，COPY 子块的 size 字段写成 307204（本应为 307206）。解码时应按帧块大小前进，COPY 数据按 W×H 读取。
- 用 ffmpeg 可以直接解码导出的 payload，但它会跳过这个 COPY 块。

**WAVE**
- 标准 RIFF PCM，8 位单声道：
  - 22050 Hz：Speaking 1184 个 + Effect 99 个；
  - 44100 Hz：Speaking 190 个。
- 总时长：Speaking 约 2284 秒，Effect 约 176 秒。浏览器可以直接播放。

**TEXT**
- help.mkf #1–99，用 `TextDecoder('big5')` 解码。

**DATA**
- 地图结构数据：见 g_map.md。
- Panel #8：4824 B，取值 1..4。
- Panel #19 和 #81：640×480 的 u8 区域掩码，#19 有 13 个区域。
- Panel #22：24576 B。

**建议的流水线**

1. 服务端读取只读目录下的原版文件，按本规格解压。
2. 转换成 PNG 图集、WAV/OGG 和 JSON 清单，写入派生缓存目录，不入库。
3. 通过静态路由提供给客户端。
4. 客户端先探测清单；拿不到时回退到现有的程序化美术。


## verified
- 容器：9 个 MKF 共 2782 个资源。每个文件的 X、N、资源头都已解析；全部没有哨兵，所有 gap=0，所有资源满足 imgOff+imgSize≤uncompressed，所有压缩项满足 stored<uncompressed，违例数为 0。数字见 .cache/assets-research/mkf-index/_summary.json 与各文件 JSON。
- 按规则生成的 DHI、DLEN（各 256 B）和初始树（4492 B）在用户自有 exe 中各只命中一处：v2.06 在 VA 0x480710/0x480810/0x480910（文件偏移 0x7f310/0x7f410/0x7f510），v3.11 在 VA 0x483430/0x483530/0x483630（test/lzhuf-tables-verify.ts）。
- 440 个压缩资源（v2.06 417 个 + v3.11 23 个）全部通过：输出长度等于 uncompressed；输出满后的下一个符号是 dist==0xFFF 的结束标记；ceil(含结束标记的总比特数/8) 与 stored 逐个相等；overrun=0。频率减半路径被触发 902 次（单个资源最多 86 次）。
- 用 radare2 ESIL 仿真 v2.06 rich4.exe 的原版解压函数 0x4536a0（针对 ESIL 的 bt 与 repe scasw 两处语义错误，在 io.cache 中打了等价补丁）。Panel#13（5298 B）、map#14（39601 B）、Panel#90（2226 B）、Panel#72（38696 B）、Data#481（82412 B，减半 1 次）、Data#468（194776 B，减半 3 次）共 6 个资源的输出与自写实现逐字节一致，且原版函数在输出末尾之后没有多写任何字节（结果见 .cache/assets-research/emu/results.txt）。
- v2.06 解压函数（0x4536a0，431 B）与 v3.11 的对应函数（0x455040）逐字节比较，只有 52 字节不同，全部是表和工作区的绝对地址，算法完全相同。
- v2.06 读资源函数 0x44ec68 的反汇编确认了处理顺序：先读 16 字节头；stored==uncompressed 时直接读，否则调用 0x4536a0(dst,src)，只有两个参数；imgSize≠0 时调用 0x450028(buf+imgOff, imgSize)，按全局变量 [0x4741a0] 选择 RGB555→565/BGR565/444 的转换；缓冲区以 SPR 或 SMP 开头时调用 0x44e890 做块指针修正。
- 所有 imgSize>0 区域内的 u16 字，bit15 置位数都为 0。其中 Data 有 1398 万个字、Panel 1547 万个、map v2.06 108 万个、v3.11 279 万个；仅压缩资源部分就有约 2440 万个字。存储格式为 RGB555，这也说明解压结果正确。
- 类型规则全量成立（_validate.json 中 bad 列表为空）：SPR 的 gsize=w·h（Data 8591 块、Panel 696、jump 461、map 1001、v3.11 2089）；SMP 的 gsize=2wh；SPR 与 SMP 都满足 start=12+12n、imgOff=start；SPR 的 imgSize=512；GND 满足 imgOff=16、imgSize=512、raw=16+512+2n+1024n，且 12 个 GND 的 u16 索引表全是恒等映射；RAW16 的 imgOff=4、imgOff+imgSize=raw。
- FLIC 共 105 个（Data 72、Panel 8、jump 25），全部是 0xAF12 8 位 FLC。头部 size 字段等于 payload 长度，帧链恰好走到文件尾，帧块数 = frames+1。唯一的异常是 Panel#20 末帧 COPY 子块的 size 字段为 307204（应为 307206）。ffprobe/ffmpeg 能直接解码导出的 payload。
- WAVE 共 1473 个：Speaking 1374 个，其中 1184 个为 22050 Hz、190 个为 44100 Hz，8 位单声道 PCM；Effect 99 个，全部为 22050 Hz。Effect #64–79 是 16 个空资源。help.mkf #1–99 能用 Big5 严格解码。
- 目视检查的样图（全部由压缩资源解码得到，均正确）：jump05_SPR_C（牛仔 20 帧）、data004 RAW16 200×200（元旦）、data400 388×251（事件插画）、data530 165×256（卡片图）、panel092 640×480（南天门）、panel026_SMP_C（拍卖场景 116 帧）、map08_SMP_C（台湾图缩略图）、data375 与 data519 的 FLIC 帧序列。另外 GND 按行优先拼接后是完整的台湾图地面纹理（map000_GND_rowmajor_quarter.png）。
- 跨版本比对：v2.06 map.mkf 的 150 项中有 112 项在 v3.11 能找到 payload 相同的资源。v2.06#8–11 对应 v3.11#16–19，v2.06#13–26 对应 v3.11#25–38，两边都是压缩存储且压缩字节相同。9 个文件中没有“一处压缩、另一处未压缩但内容相同”的资源对（137 组重复 payload 里混合组为 0），因此无法用 v3.11 的未压缩资源做独立比对，改用原版代码仿真代替。
- MapDat.MKF #0 与 map.mkf #1 相同，#3 与 #7 相同；但 MapDat #1、#2 与 map.mkf #3、#5 的 sha1 不同。

## unknowns
- RAW16 各尺寸（200×200、388×251、165×256、640×480）是由字节数、行自相关和目视推断的；exe 中硬编码这些尺寸的位置尚未找到。imgOff=4 的由来也未确认（推测是打包工具的习惯，原版因此前 2 个像素不做格式转换）。
- SMP 的透明色是否统一为 0x0000：四角统计支持这一点，但原版的 blit 函数与透明判断尚未反汇编确认；也不清楚是否有 SMP 需要按用途当作不透明图处理。
- SPR 的 (x, y) 锚点在原版绘制时的具体减法方向，需要在渲染研究中用 exe 的 blit 代码或实机截图核对。
- Panel DATA 资源的语义：#8（4824 B，值 1..4）、#19/#81（640×480 区域编号掩码，推测是某个选择盘的点击判定区域）、#22（24576 B）。
- MapDat.MKF #1、#2 与 map.mkf #3、#5 的差异具体在哪些字段、原版实际加载哪一份，需要地图方向的研究者跟进。
- 只用 ESIL 仿真抽查了 6 个资源；其余 434 个压缩资源依靠结束标记与字节数的精确对齐、RGB555 的 bit15 检验和结构自洽性间接验证，没有逐个仿真（全量仿真约需数小时）。
- Data、Panel、jump 等文件里各资源编号与具体游戏用途（哪个角色、哪个界面）的完整对应关系，不在本主题范围内，需要结合 exe 引用和其他主题的研究。

## artifacts
- <repo>/test/lzhuf-proto.ts
- <repo>/test/lzhuf-tables-verify.ts
- <repo>/test/lzhuf-emu-verify.sh
- <repo>/test/mkf-lib.ts
- <repo>/test/mkf-survey.ts
- <repo>/test/mkf-survey-check.ts
- <repo>/test/mkf-validate.ts
- <repo>/test/mkf-ranges.ts
- <repo>/test/mkf-render-samples.ts
- <repo>/test/mkf-content-probe.ts
- <repo>/test/mkf-dump-stored.ts
- <repo>/.cache/assets-research/mkf-index/v206-Data.mkf.json
- <repo>/.cache/assets-research/mkf-index/v206-Panel.mkf.json
- <repo>/.cache/assets-research/mkf-index/v206-Speaking.mkf.json
- <repo>/.cache/assets-research/mkf-index/v206-Effect.mkf.json
- <repo>/.cache/assets-research/mkf-index/v206-jump.mkf.json
- <repo>/.cache/assets-research/mkf-index/v206-help.mkf.json
- <repo>/.cache/assets-research/mkf-index/v206-map.mkf.json
- <repo>/.cache/assets-research/mkf-index/v206-MapDat.MKF.json
- <repo>/.cache/assets-research/mkf-index/v311-map.mkf.json
- <repo>/.cache/assets-research/mkf-index/_summary.json
- <repo>/.cache/assets-research/mkf-index/_validate.json
- <repo>/.cache/assets-research/mkf-index/_ranges.json
- <repo>/.cache/assets-research/emu/results.txt
- <repo>/.cache/assets-research/samples/stats.json
- <repo>/.cache/assets-research/samples/jump05_SPR_C.png
- <repo>/.cache/assets-research/samples/jump40_SPR_C.png
- <repo>/.cache/assets-research/samples/data000_SMP_C.png
- <repo>/.cache/assets-research/samples/data001_SMP.png
- <repo>/.cache/assets-research/samples/data004_RAW16_C_200x200.png
- <repo>/.cache/assets-research/samples/data050_RAW16_C_200x200.png
- <repo>/.cache/assets-research/samples/data088_SPR.png
- <repo>/.cache/assets-research/samples/data375_FLIC_C.png
- <repo>/.cache/assets-research/samples/data400_RAW16_C_388x251.png
- <repo>/.cache/assets-research/samples/data450_RAW16_C_388x251.png
- <repo>/.cache/assets-research/samples/data480_SPR_C.png
- <repo>/.cache/assets-research/samples/data482_FLIC_C.png
- <repo>/.cache/assets-research/samples/data519_FLIC_C.png
- <repo>/.cache/assets-research/samples/data530_RAW16_C_165x256.png
- <repo>/.cache/assets-research/samples/data560_RAW16_640x480.png
- <repo>/.cache/assets-research/samples/panel000_SMP_C.png
- <repo>/.cache/assets-research/samples/panel001_SMP_C.png
- <repo>/.cache/assets-research/samples/panel019_DATA_640x480_u8.png
- <repo>/.cache/assets-research/samples/panel026_SMP_C.png
- <repo>/.cache/assets-research/samples/panel030_SPR_C.png
- <repo>/.cache/assets-research/samples/panel078_FLIC_C.png
- <repo>/.cache/assets-research/samples/panel092_RAW16_C_640x480.png
- <repo>/.cache/assets-research/samples/jump000_RAW16_640x480.png
- <repo>/.cache/assets-research/samples/jump003_RAW16_640x480.png
- <repo>/.cache/assets-research/samples/jump043_FLIC.png
- <repo>/.cache/assets-research/samples/help000_SMP.png
- <repo>/.cache/assets-research/samples/map08_SMP_C.png
- <repo>/.cache/assets-research/samples/map12_SMP_C.png
- <repo>/.cache/assets-research/samples/map13_SPR_C.png
- <repo>/.cache/assets-research/samples/map15_SMP_C.png
- <repo>/.cache/assets-research/samples/map100_SPR.png
- <repo>/.cache/assets-research/samples/map000_GND_tiles0-63.png
- <repo>/.cache/assets-research/samples/map000_GND_rowmajor_quarter.png