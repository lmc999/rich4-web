# 原版 UI 素材调研（v2.06 `original/Game`，另对照共享盘 v3.11）

## 0. 结论速览
- 我自写了一个最小解码器（MKF 容器、私有 LZHUF、SPR/SMP、FLC、裸 RGB555、PNG 编码），代码在 `test/ui-lib.mjs`。用它对 Panel、Data、help、jump、map 五个 MKF **全量解码**：
  - 417 个压缩资源解压后的长度与头部 `uncompressed` 全部一致。
  - 580 个 SPR/SMP 精灵表的数据终点都恰好等于资源长度，`gsize` 也全部等于 w×h（SPR）或 w×h×2（SMP）。
  - FLC 头里的 size 字段与资源长度全部一致。
  - 共导出 324 张样张，逐张目视识别。
- UI 图像几乎都在 **Panel.mkf（113 项）** 和 **Data.mkf（561 项）**。另外：
  - 开局设置和过场在 jump.mkf。
  - 讲话头像（含表情）、缩小地图、特殊格徽章、占地标志在 map.mkf。
  - 游戏百科在 help.mkf（Big5 文本）。
  - 片头、片尾和 12 段角色结局是 `Media/*.avi`（Indeo 5）。
- **原版中文字体不是 MKF 里的位图字体。** exe 用 GDI 的 `CreateFontA` 建字体，字体名是「細明體」，字符集 CHINESEBIG5（0x88），再用 `TextOutA` 在 DirectDraw 表面上逐字输出。MKF 里只有数字、英文按钮这类**预画进图里**的字。
- 推荐走 **B+ 混合路线**：主 HUD 保留 React 布局，全面换上原版素材；银行、商店、乐透、魔法屋、拍卖、股市等场所屏用「原版 640×480 场景等比缩放 + 原坐标热区」做成模态层。MVP 约 1.5–2 周，完整约 4–6 周。

## 1. 解码规格（已实现并验证）
- **MKF 容器**
  - 文件头 u32 是索引表偏移 X，索引项数 N = (len−X)/4。
  - 这几个文件的最后一项索引都**不是**哨兵（`start[N−1] ≠ X`），所以 N 项全部是资源。
  - 每个资源有 16 字节头 `{raw, stored, imgOff, imgSize}`；`raw ≠ stored` 表示压缩。
- **LZHUF**：按 g_map.md §6.3 的伪代码自写。
  - 距离前缀用 8 位 LSB-first 查表，得到长度 L 和高位 HI。
  - 之后再读 6 位，`dist = HI<<6 | lo6`；`dist == 0xFFF` 表示结束。
  - 整个 Data.mkf 解压约 1.5 秒（node 24）。
- **SPR**
  - 头部 `'SPR\0'`、块数、start。
  - 每帧描述 12 字节 `{w,h,x,y:int16, gsize:u32}`。
  - 调色板在 start..start+512，共 256 项 RGB555。
  - 首帧像素从 start+512 开始；8bpp，索引 0 为透明。
- **SMP**：首帧从 start 开始，16bpp RGB555（`r=(c>>10)&31`），**没有 alpha**。
  - 叠加类图（气泡、消息框、GO 钮、讲话头像、太阳/月亮钮等）要把纯黑 `0x0000` 当色键，已目视验证。
  - 整屏背景不能抠黑。
- **锚点**：`x/y` 是锚点，落点 = 画点 − (x,y)。
  - 验证方法：工具列按钮按「画点 (i*40+20, 20) 减锚点」贴图，11 颗正好铺满 440 宽，见 `samples/mockup-main-*.png`。
- **FLC**
  - AF12 格式，8bpp，块类型只出现 4/15/18（COLOR_256、BYTE_RUN、PSTAMP）。
  - 色键**每个资源不同**，必须逐项建表：
    - 骰子与部分跳伞：绿 (0,255,0)
    - 角色表情动画：青 (0,135,135)
    - 救护车：(0,0,127)
    - 神明降临：(35,59,27)
    - 警车：(0,111,0)
    - 其余多为黑
- **裸 RGB555（无头）**：尺寸由调用方决定，我用行宽自相关求出。
  - 80000 B = 200×200（节日图）
  - 194776 B = 388×251（新闻/命运插图）
  - 84480 B = 165×256（卡片插画）
  - 614400 B = 640×480
- **命中掩膜**（8bpp，每像素一个区号）：
  - Panel#8：72×67，GO 钮，4 区
  - Panel#19：640×480，魔法屋，12 区 + 中心
  - Panel#22：128×192，计算器，16 键
  - Panel#81：640×480，企鹅挖宝的 64 格

## 2. UI 资源定位总表（v2.06 编号；「图n」为帧号）

### 2.1 主画面（640×480：工具列 0..440×40｜棋盘 (0,40) 440×440｜侧栏 x=440 宽 200）

| 元素 | 资源 | 尺寸/帧 | 备注 |
|---|---|---|---|
| 工具列 11 钮 | Panel#1 | 图0 底条 439×40；图1–11 常态；图12–22 悬停 | 顺序：?/设定/托管灯泡/LOAD/SAVE/大地图/放大镜/锤子/CARD/SALE?/走势；命中 x/40 |
| 个人资料栏 4 分页 | Panel#0 | 图0–3 各 200×280（資金/地產/股票/其他，含右缘竖页签：青/蓝/红/金，以及行图标）；图4 200×80；图5 无页签版 | 贴 (440,0)；数值与「物價指數 N」是 GDI 文字 |
| 头像 72×72 | Data#2 | 12 帧，每帧 72×72 | 帧号 = 角色号 |
| 右下日历/月历 | Panel#2 | 图0–3 春夏秋冬 200×200；图4–7 月历版（S M T W T F S）；图8/9 太阳、图10/11 月亮（24×23、20×20，常态/悬停） | 贴 (440,280) |
| 节日插画 | Data#4–86 | 83 张 200×200 裸图 | 台湾 4–27、中国 28–46、日本 47–67、美国 68–86 |
| 缩小地图/大地图 | map#8–11 | 每张地图 200×200 + 400×400 | 台/中/日/美 |
| 小地图旋转钮 | Data#476 图18–21 | 25×26 | 蓝左、紫右，常态+悬停 |
| GO 钮 | Panel#7 | 图0–5 72×67（GO 常态/悬停/禁止/禁止悬停/乌龟两态）；图6–11 骰子数小图 15×15 | 命中掩膜为 Panel#8 |
| 骰子 | Panel#3 SPR 18 帧（3 种尺寸 × 6 面）；Panel#4/5/6 FLC 189×285×36 帧（分别为 1/2/3 颗） | | FLC 绿色色键 |
| 遥控骰子选点 | Panel#72 | 256×55 + 6 钮 30×29 | |
| 计算器数字窗 | Panel#21 SPR 26 帧 | 128×192 本体、MAX 49×25、↵ 57×25、键帽 33×17×12、计量条 108×12、LCD 数字 9×19×10 | 命中掩膜为 Panel#22 |
| YES/NO | Data#399 3 帧 96×48（常态 / YES 亮 / NO 亮）+ Data#476 图5 消息框 195×133（锚点居中） | | |
| 讲话气泡/讲话框 | Data#476 图6 云形 210×154；图0–3 讲话框 139×116（四种尾巴方向）；图7 名牌 400×89 | | |
| 讲话头像 + 表情 | map#15–26（角色 0–11） | 图0 大头 70–85×60–76；图1–4 表情；图5 小头；图6 地图点 | 贴 (170,130)，图号 = 表情+1 |
| 金貝貝表情图 | Data#478 | 21 个 | |
| 选择玩家窗 | Data#477 | 177/257/337×97（放 2/3/4 个头像） | |
| 设施类别选择 | Data#476 图4 | 355×83 | |
| 光标与棋盘标记 | Data#0 | 43 帧：STOP、地雷、炸弹、飞弹、准星、卡片翻转 15 帧、手形、针筒、爪印、8 向选路箭头 | |
| 特殊格徽章 | map#12 | 17 帧 | 公园/NEWS/?/监狱/医院/GAME×3/乐透/30·50·10 点/CARD/BANK/On sale/魔法 |
| 占地标志 | map#13 12 帧；另有大小两套在 Panel#26 图90–115 | | 牛仔帽、油桶、手里剑、钻石、斗笠、玫瑰、剑、蝴蝶结、羽毛、红鞋、球棒、奶嘴 |

### 2.2 卡片、道具、神明
- **30 张卡片插画**：Data#530–559，165×256 裸图，**卡号 k（1–30）= 529+k**。30 张逐张与卡表顺序目视对上：均富=530 … 同盟=558、乌龟=559。
- **卡片没有小图标**：卡片欄 5×3 格（Panel#11 图0 青绿，412×180）只画卡名。另有通用卡片图标：Data#374（20×26）、Panel#73 图12/16。
- **13 种道具图标**有两套：
  - Panel#11 图2–14（约 40×34，图15/16 为禁用）；道具欄底为 Panel#11 图1（砖红）。
  - Panel#74 13 帧小图（24×20）。
- **12 神明小像**：Panel#9 图13–24。
- **神明降临 FLC**：Data#499–510（440×440）。
- **神明老虎机**：Panel#67（4 位/3 位机身 + 滚轮）。

### 2.3 场所与全屏界面

| 界面 | 资源 |
|---|---|
| 标题 | Data#1：图0 640×480；图1–6 START/LOAD/OPTION 常态/悬停；图7–8 EXIT |
| 游戏设定 | Data#3：主框 347×363、热键页 328×336、日期页 199×220、LED、箭头；图10/11 右上三钮组 |
| LOAD/SAVE | Data#479：555×451 / 555×381 + 4 张地图缩图 72×72 |
| 开局设置/选人 | jump#0–3 背景 640×480（台/中/日/美）<br>jump#4：12 头像格 440×155（6×2）、竖栏 192×461（关卡一–四、OK/EXIT、6 条下拉）、下拉列表 257×177、勾/叉/星<br>jump#5–40：12 角色 × 步行/机车/汽车侧视动画（SPR 7–21 帧） |
| 托管 AI | Panel#77：对话框 435×355、行底亮/暗 116×86、12 圆头像 70×65（图6–17） |
| 个人资产表整页 | Panel#9：3 页 640×480（总表/地产/股票清单）、EXIT 58×19、翻页箭头、蓝钮 97×40 |
| 百货公司（卡片/道具店） | Panel#10：38 帧，两页底图、货架 222×462、两位店员立绘与脸部小动作、切页三角钮 85×85、EXIT 80×40、点数底板 90×40 |
| 乐透投注 | Panel#12：底图、猫女立绘、号码选框 70×42 |
| 乐透奖池跑马灯 | Panel#14：FLC 213×68×5 |
| 乐透开奖 | Panel#15：47 帧，主持人 6 姿势、号码球 0–9、12 角色小头、爆炸框<br>Panel#16：摇球 FLC 275×270×42<br>Panel#17：开球 FLC 280×480×37 |
| 魔法屋 | Panel#18（六芒星底图、女巫、24 个选项图标、提示框 5 种）<br>Panel#19 掩膜；Panel#20 施法 FLC 640×480×25 |
| 银行 | Panel#23（柜台、百叶窗、董事长、柜员表情、借还款卡、EXIT 80×40）<br>ATM：Panel#24（320×338 + 键帽 + LCD 数字） |
| 月结颁奖 | Panel#25：83 帧，底图、MONEY 卡、名次 1–4、主持人 5 姿势、12 角色 × 3 Q 版小人 |
| 拍卖 | Panel#26：116 帧，竞价钮 PASS/+100/+500/+1000/+5000/+10000/Give up（各两态）、拍卖官、女助手、47 张建筑缩图、12 角色描边 |
| Q 版小人动画 | Panel#27–62：12 角色 × 3 段 |
| 监狱 / 医院 / 四大恶人 | Panel#63 / Panel#65 / Panel#64 |
| 新闻板 / 命运板 | Panel#66 图0（蓝 NEWS）/ 图1（紫 ?），各 440×480 |
| 新闻/命运插图 | Data#400–475，388×251 × 76<br>新闻编号 i 对应 Data#400+i（36 条逐一与新闻表目视对上：#4 外星人、#11–13 三税、#22 挤兑、#26–27 CLOSED…）<br>436–475 共 40 张为命运 |
| 轮盘 | Panel#68–71：依次为航空 / 旅馆 / 购物中心 / 保险（按图2 盘面逐格核对：#68 = 0,1,2,3,2,1；#69 = 1–4；#70 = 6,1–5；#71 = 3,5,10,15,20,30） |
| 公佈欄 | Panel#73 |
| 股市 / 持股汇总 | Panel#75（两页 640×480、详情 587×375、行业图 80×112×9）/ Panel#76（592×432） |
| 游戏百科 | help#0：400×400 窗；help#1–99 为 Big5 文本，每行 10 字、NUL 分隔 |
| Loading | Data#560 |
| 小游戏 | Panel#78 READY GO FLC；Panel#79–112 为三款小游戏素材 |
| 过场与棋盘特效 | jump#41–66：飞机、12 人自由落体/开伞 FLC<br>Data#482–529：440×440 棋盘 FLC（烟火、救护车 440×74×62、爆炸/核弹、UFO、龙卷风、警车、神明、火灾、飞机、12 人降落伞 518–529）<br>Data#375–398：12 角色 × 2 段表情 FLC |
| 胜利/结局 | Media/END01–12.AVI（640×480 Indeo5，ffmpeg 可解；END10 = 孙小美，已抽帧）；另有 Over.avi、Thanks.avi、Start.avi |

### 2.4 预画字模（MKF 里仅有的「字体」）
- Panel#13：黄色 0–9、逗号、$（16×18）
- Data#476 图8–17：绿色大数字 35×43
- Panel#21 图16–25、Panel#24 图19–28：LCD 数字
- Panel#15：号码球
- Panel#67：老虎机滚轮
- Panel#79、#112：HUD 数字与气球数字
- Panel#25 图6–9：名次 1–4

## 3. 版本差异与编号换算（逐资源 SHA1 比对共享盘 MultiverseJourney v3.11）
- **Panel**：113 项里 111 项同号同内容，只有 #26（拍卖，v3.11 为 184 帧）和 #75（股市，29 帧）不同。
- **Data**：v3.11 在 87 号处插入 41 张节日图，所以 **v2.06 从第 87 号起的编号 +41 = v3.11 编号**。oama 文档里的号码可以照此换算：
  - `0x205`=517 → 476
  - `0x207`=519 → 478
  - `0x208`=520 → 479
  - 卡片插画 571–600 → 530–559
- **Data 里内容有改动的 4 项**：
  - #1：v3.11 标题多了 NEW STAGE。
  - #476：v3.11 的框变大，消息框 249×170、气泡 271×199。
  - #479：v3.11 有 8 张地图缩图。
  - #543：v3.11 的停留卡换了图。
- **jump**：v3.11 多 4 项，是新关卡的背景。
- **help**：46 条文案不同。
- **map**：讲话头像 v2.06 = 15+角色，v3.11 = 27+角色。

## 4. 字体结论（exe 实证）
- **建字体**：`fcn.0044e200` 是 CreateFontA 的封装，有 150 个调用点。
  - 参数：`nHeight = −h`、`weight = (style&2) ? 700 : 400`、`charset = 0x88`、quality 为 DEFAULT，其余为 0。
  - 字体名指针 = VA 0x46410c，即文件偏移 **0x62d0c**，内容为 Big5 字节 `B2 D3 A9 FA C5 E9`（「細明體」）。
- **画字**：`fcn.0044e0f6` 逐字 `TextOutA`，双字节字每次输出 2 字节；竖排时每字的 y 步进 = 字高 + 额外间距。
- **样式位**：
  - bit0：先用边框色（全局 0x474108）描一圈边，再画正文。
  - bit1：粗体。
  - bit2：正文偏移 1 px，形成阴影效果。
  - bit3：另一分支，暂未解明。
- **调用分布**
  - 字高：16px×55、20px×33、12px×16、15px×13、28px×8、18px×7、24px×6、22px×3，另有 14、26、48、60、72（60/72 疑为日历大号日期）。
  - 样式：2（粗体）×64、3（粗体+描边）×63、6×11。
- **旁证**：Steam 启动器 SystemString.xml 提示「非 Unicode 程式語言必須為中文(繁體 台灣)」，说明文字依赖系统的 Big5 字体。
- **网页替代**
  1. 最接近点阵观感：**文泉驿点阵宋体**（WenQuanYi Bitmap Song，明体风格点阵，12/13/15/16 px，GPL-2.0 + 字体例外）。需要转成 TTF/WOFF2 像素轮廓，在整数倍下使用。
  2. 20px 以上用明体矢量字：思源宋体 Source Han Serif TC 或 Noto Serif TC（OFL）。
  3. Windows 用户可以先写 `local('MingLiU')` / `local('PMingLiU')`，但**不能分发**。
  4. 描边用 8 方向 1px 的 `text-shadow` 模拟 GDI 的多遍输出；粗体用 700。
  5. 融合像素（Fusion Pixel）、方舟像素都是黑体风格，不够像。

## 5. 两条 UI 路线评估

### 路线 A：原版 640×480 固定布局，等比缩放
- **做法**
  - 整个画面是一个 640×480 舞台（Canvas 或绝对定位 DOM + transform），按原坐标、锚点和命中掩膜实现。
  - 16:9 桌面上按高度缩放，1080p 下倍率 2.25；两侧空出约 480px，放聊天、观战、日志、房间码。
  - 回合倒计时叠在工具列右侧或棋盘角。
- **手机横屏的问题**（以 844×390 为例）
  - 倍率只有 0.81：40px 的工具钮只剩 32px，12px 字只剩约 10px，偏小。
  - 非整数倍的最近邻缩放会让像素粗细不均，只能改用平滑缩放。
- **素材清单**：第 2 节全部，外加每屏在 exe 里的布局坐标和热区（需要逐屏逆向，oama 文档可以当事实参考）。
- **工作量：约 8–10 周**
  - 舞台、输入与缩放：3 天
  - 主画面（工具列、四页侧栏、日历、GO、骰子、气泡、YES/NO、计算器、选人窗）：约 1.5 周
  - 约 20 个场所/全屏界面，每个 1–3 天：5–7 周
  - 联机信息放进边栏 + 手机适配：约 1 周
- **原味度最高**，但要重写现有的决策对话框体系。

### 路线 B：保留 React 布局，全面换皮
- **素材映射**

| 现有元素 | 换成的原版素材 |
|---|---|
| TopBar | 日历 Panel#2 + 节日图 Data#4–86 |
| PlayerPanel | 侧栏页 Panel#0，拆成羊皮纸底、浅蓝数值条、行图标、页签色；头像 Data#2 |
| ActionPad | 工具列图标 Panel#1（22 帧），GO 钮 Panel#7 |
| MiniMap | map#8–11 + 旋转钮 Data#476 图18–21 |
| 通用框 | 9-slice：Panel#25 图2、Panel#26 图2、Panel#23 图22、Data#476 图5/6、Panel#18 图6–10 |
| 按钮 | Panel#9 图12、Panel#23 图16–19、各屏 EXIT 钮 |
| 数额输入 | 计算器 Panel#21 |
| 确认框 | YES/NO：Data#399 |
| CardTile | 卡图 Data#530–559 |
| 道具 | Panel#11、Panel#74 |
| 神明徽章 | Panel#9 图13–24 |
| 状态 | Data#478 |
| 讲话气泡/聊天头像 | map#15–26 表情 |
| 骰子 | Panel#3–6 |
| 事件弹窗 | 新闻/命运板 Panel#66 + 插图 Data#400–475 |

- **9-slice 实测**（见 `samples/nineslice-demo.png`）
  - 带边框的框（绿边羊皮纸、蓝边框、蓝按钮）拉伸后效果良好。
  - 中间是图案的框（十字花）要用平铺，即 `border-image-repeat: round`，不能拉伸。
  - 宝石消息框顶部饰件居中，只能做 3-slice。
  - 侧栏页里的图标已经烘焙进图，必须拆层后再用。
- **工作量：MVP 1.5–2 周，完整 4–6 周**
  - 素材管线（抽取 → 带 alpha 的 PNG/WebP 图集 + 清单 + 色键表 + FLC 转精灵表/WebM）：3–4 天
  - 主题与 9-slice 组件：2–3 天
  - HUD 换皮：3–4 天
  - 约 15 个决策对话框换皮：8–12 天
  - 字体：1 天

### 推荐：B+ 混合
- 主 HUD 走 B：兼容手机横屏、聊天、观战、倒计时，现有 React 决策流程不用推倒。
- 银行、百货、乐透投注与开奖、魔法屋、拍卖、股市、公佈欄、个人资产表、月结、医院、监狱这类场所屏，用「原版 640×480 场景 letterbox 模态」：底图、立绘和按钮按原坐标摆，命中用原掩膜或矩形，数值用 React 叠字。
- 场所屏可以逐屏上线，每屏 1–2 天；没有素材包时退回现有的程序化对话框。

## 6. 素材包交付建议
- **UI 子集体积**：全部 SPR/SMP 转成 PNG（deflate 6，未优化）约 **24.4 MiB**。其中 Panel 12.1、新闻/命运 5.6、节日 2.1、jump 1.7、Data UI 1.2、卡图 1.0、map 0.6 MiB。换成 WebP 或按屏懒加载后首屏可以控制在 3 MiB 以内。
- **生成与分发**：由服务器从本地只读目录（如 rich4-data/）提供清单 `pack.json` 和图集，这些都由本地 CLI 从用户自己的 `original/Game` 生成。客户端先探测素材包是否存在，不存在就回退到程序化美术。
- **缩放**：整数倍用最近邻（`image-rendering: pixelated`）；非整数倍先按 2× 最近邻放大，再平滑缩小。可选 xBR 或 AI 超分，但要记得同步缩放锚点。
- **AVI**：用 ffmpeg 把 Indeo5 转成 WebM/MP4（已验证能解码）。

## 7. 样图位置（均在 `.cache/assets-research/ui/`，只在本机浏览，不上传）
- `sheets/`：324 张样张，命名为 `<mkf>-<资源号>.png`，每帧标了帧号；透明区用棋盘格表示。
- `index.html`：本地浏览目录，附识别说明。
- `ui-manifest.json`：64 组资源的标注，含帧尺寸与锚点。
- `catalog-*.json`：全量资源目录。
- `samples/`：
  - `mockup-main-640x480.png`（和 1280×960 版）：用原版素材拼的主画面样稿。
  - `nineslice-demo.png`：9-slice 伸缩演示。
  - 工具列条、头像条、讲话头像、YES/NO、计算器、卡图、新闻图、节日图、选人背景与部件、标题、资产表、银行、掷骰帧、命中掩膜、AVI 抽帧。

## verified
- 解码器正确性：Panel/Data/help/jump/map 五个 MKF 里 417 个压缩资源解压后的长度全部等于头部 uncompressed；580 个 SPR/SMP 精灵表的数据终点全部等于资源长度，gsize 全部等于 w*h(*2)；FLC 头 size 全部等于资源长度（统计脚本 test/ui-catalog.mjs，结果：bad=0）
- MKF 概况：Data.mkf 561 项（270 个压缩），Panel.mkf 113 项（92 个压缩），jump 67 项，help 100 项，map 150 项；这几个文件的最后一项索引都不等于 X（不是哨兵）
- 工具列 Panel#1：图0 为 439×40 底条，图1–11 常态、图12–22 悬停；按『画点 (i*40+20,20) 减锚点』拼接后 11 钮正好铺满 440 宽（samples/mockup-main-1280x960.png 目视确认）
- SMP 叠加图把纯黑 0x0000 当色键后，气泡、消息框、GO 钮、讲话头像边缘干净（mockup 第二版目视确认）；整屏底图不能抠黑
- 侧栏 Panel#0 图0–3 为 200×280 四页（青/蓝/红/金页签），头像 Data#2 为 12×72×72，日历 Panel#2 为 4 季 + 4 月历 200×200 + 太阳/月亮钮（目视）
- 卡片插画 Data#530–559（165×256 裸 RGB555，行宽自相关最优为 165）：30 张逐张与 30 卡顺序对应，例如 537 为 SALE 拍卖卡、549 为 FREE 免费卡、553 为 UP 红卡、554 为 DOWN 黑卡、559 为乌龟卡
- 新闻插图 Data#400–435（388×251，行宽自相关最优为 388、97388/388=251 整除）：36 条逐一与 r_squares_events 新闻表目视对上（#0 开释、#4 外星人、#11–13 三税、#16 豪雨、#22 挤兑 BANK、#26–27 CLOSED、#35 1up）
- 节日图 Data#4–86 为 83 张 200×200，按台/中/日/美分段（图上文字：元旦、清明节、ひなまつり、Thanksgiving Day 等）
- 讲话头像在 map#15–26：每个角色 7 帧（大头、4 个表情、小头、地图点），map#24 为孙小美（与 Data#2 图9 一致）
- 掷骰 FLC Panel#4/5/6 分别为 1/2/3 颗骰子，189×285×36 帧，绿色 (0,255,0) 色键（第 30 帧目视）
- 命中掩膜：Panel#8 为 4824=72×67（值 1–4），Panel#19 为 640×480（值 0–13），Panel#22 为 128×192（值 1–16），Panel#81 为 640×480（64 格）
- 版本比对（逐资源 SHA1）：Panel v2.06 与 v3.11 只有 #26、#75 不同；Data 从 v2.06 第 87 号起 +41 等于 v3.11 编号（471 项同内容换号），v2.06 改动项为 1/476/479/543；jump 从 5 号起 +4
- 字体：rich4.exe（v2.06）导入 GDI32 CreateFontA/TextOutA；封装函数 fcn.0044e200 传入 charset 0x88、weight 400/700、字体名 VA 0x46410c（文件偏移 0x62d0c）= Big5『細明體』(B2D3 A9FAC5E9)；150 个调用点的字高分布：16px×55、20px×33、12px×16、15px×13 等
- help.mkf #1–99 用 TextDecoder('big5') 解出正常繁体说明文（每行 10 字、NUL 分隔），说明文字全部由 GDI 渲染，MKF 里没有中文点阵字库
- Media/*.avi 为 Indeo5 (IV50) 640×480，ffmpeg 可解码；END10.AVI 第 12 秒是孙小美 3D 结局画面
- UI 子集转 PNG 体积估算：合计 24.4 MiB（test/ui-size-estimate.mjs）

## unknowns
- 破产画面没有找到专用的全屏资源：推测只用棋子破产/乞丐姿态加事件语音槽 25；Data#375–398 每个角色 2 段表情 FLC 的语义（得意/失意？）未定
- Panel#0 图4（200×80）和图5（无页签页）的具体使用场景未确认
- Data#476 图8–17 绿色大数字的用途（推测为剩余步数），以及 Panel#13 黄色数字字模的使用位置，未从 exe 核实
- 命运插图 Data#436–475 共 40 张，与 37 条命运（外加按地图换文案的 4 项）之间的精确映射未读 exe 确认
- 路线 A 需要的各屏精确坐标（侧栏数值、物价指数、日历文字、页签命中区等）本次没有逐屏逆向
- 細明體在 Win9x/GDI DEFAULT_QUALITY 下哪些字号使用内嵌点阵，需要在有该字体的 Windows 上核实；文泉驿点阵宋体对 Big5 繁体字的覆盖度需实测
- FLC 头 speed 字段（例如骰子只有 14ms）是否就是实际播放间隔，还是由游戏自己的定时器决定，未核实
- 究竟以 v2.06 还是 v3.11 的美术为准（v3.11 消息框/气泡更大，有 NEW STAGE 和 8 张地图）需要用户拍板；本次清单以 v2.06 为主
- END01–12.AVI 与角色号的对应：只核对了 END10=孙小美（角色 9），推测 ENDnn = 角色号+1

## artifacts
- <repo>/.cache/assets-research/ui/ui-manifest.json
- <repo>/.cache/assets-research/ui/index.html
- <repo>/.cache/assets-research/ui/catalog-Panel-Data-help-jump.json
- <repo>/.cache/assets-research/ui/catalog-map.json
- <repo>/.cache/assets-research/ui/catalog-Panel.json
- <repo>/.cache/assets-research/ui/sheets/ (324 张 <mkf>-<资源号>.png 样张)
- <repo>/.cache/assets-research/ui/samples/mockup-main-640x480.png
- <repo>/.cache/assets-research/ui/samples/mockup-main-1280x960.png
- <repo>/.cache/assets-research/ui/samples/nineslice-demo.png
- <repo>/.cache/assets-research/ui/samples/toolbar-strip-Panel1.png
- <repo>/.cache/assets-research/ui/samples/portraits-Data2.png
- <repo>/.cache/assets-research/ui/samples/speaker-map24.png
- <repo>/.cache/assets-research/ui/samples/sidebar-page-funds-Panel0-f0.png
- <repo>/.cache/assets-research/ui/samples/calculator-Panel21-f0.png
- <repo>/.cache/assets-research/ui/samples/yesno-Data399.png
- <repo>/.cache/assets-research/ui/samples/card-art-Data531-均貧卡.png
- <repo>/.cache/assets-research/ui/samples/news-art-Data400.png
- <repo>/.cache/assets-research/ui/samples/holiday-Data4.png
- <repo>/.cache/assets-research/ui/samples/title-Data1-f0.png
- <repo>/.cache/assets-research/ui/samples/select-bg-jump0.png
- <repo>/.cache/assets-research/ui/samples/select-ui-jump4-f1.png
- <repo>/.cache/assets-research/ui/samples/asset-sheet-Panel9-f0.png
- <repo>/.cache/assets-research/ui/samples/bank-Panel23-f0.png
- <repo>/.cache/assets-research/ui/samples/dice-roll-Panel4-f10.png
- <repo>/.cache/assets-research/ui/samples/hitmap-Panel19.png
- <repo>/.cache/assets-research/ui/samples/hitmap-Panel22.png
- <repo>/.cache/assets-research/ui/samples/hitmap-Panel81.png
- <repo>/.cache/assets-research/ui/samples/avi-END10-12s.png
- <repo>/.cache/assets-research/ui/samples/avi-Start-8s.png
- <repo>/test/ui-lib.mjs
- <repo>/test/ui-mkf-survey.mjs
- <repo>/test/ui-catalog.mjs
- <repo>/test/ui-summary.cjs
- <repo>/test/ui-dump-sheets.mjs
- <repo>/test/ui-dump-raw.mjs
- <repo>/test/ui-flc-grid.mjs
- <repo>/test/ui-montage.mjs
- <repo>/test/ui-width-probe.mjs
- <repo>/test/ui-samples.mjs
- <repo>/test/ui-version-diff.mjs
- <repo>/test/ui-manifest.mjs
- <repo>/test/ui-size-estimate.mjs