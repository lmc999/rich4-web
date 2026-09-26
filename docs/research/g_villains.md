# 大富翁4：四大恶人、乞丐与事件被动卡（实现规格）

> **版本口径**：除非标明「说明书」或「社区」，下面所有公式都来自 **v3.11《超时空之旅》rich4.exe** 的两套独立逆向：mytbk/rich4 的汇编（我逐段读过），以及 oama1111/rich4-spec 与 rich4-remake-public（两个仓库算同一来源）。mytbk 读的是 v3.11，SHA256 5a90aee2…；oama 标注的也是 v3.11。**1998 年初版是否完全相同没有证实。**`PI` = 物价指数（`0x4990e8`）。

## 0. 数据模型
- actor 编号：0..3 是玩家；**4 小偷、5 強盜、6 流氓、7 間諜**。名字表 `0x47ed5a[4..7]` 的 Big5 字串已解码核对。8 是机器娃娃，不算恶人。
- 每个恶人一条 16 字节记录，位置 `0x498e28+(actor-4)*16`：
  - `+0/+2`：x/y；`+4`：所在节点；`+6`：来路节点。
  - `+8`：**owner**，即雇主，也就是保释人。
  - `+10`：**state**。0 = 在棋盘上，1 = 监狱，2 = 医院。
  - `+11`：**home**。低 7 位：1 = 从监狱放出，2 = 从医院放出；bit7 = 已经离开过门口。
  - `+12` 冬眠，`+13` 梦游，`+14` 停留，`+15` 乌龟：都是计时器。
- **开局**：模板 `0x47ecec`，外加 `in_prison[4]`、`[5]` 和 `in_hospital[6]`、`[7]` 都置 1。所以**小偷、強盜在监狱，流氓、間諜在医院**，都没有雇主。
- **恶人没有刑期天数**。被关进去以后会一直关着，直到有人保释。「狱中囚犯无罪开释」这类新闻只作用于玩家 0..3。

## 1. 保释（雇用）
- **触发**：玩家**停在**监狱格（specialKind 4）或医院格（5）上，而且那边至少关着一人。只是路过不算。
- **价格表** `{30,30,30,30,300,300,300,300}`（监狱 `0x475c44`、医院 `0x475ca4` 两张表同值）：保释恶人 **300 点券**，保释玩家 30 点券，**不扣现金**。点券是 16 位字段。
- **人类玩家**：从 4×2 的囚犯格子里选一个。点券 ≥ 价格才能选，不够就提示「抱歉！你的點數不足！」；够了再弹是/否确认。
- **电脑玩家**，按顺序：
  1. 先掷 `rand()&1`，结果为 0 就什么都不做。
  2. 按电脑个性（`player+0x17`）决定候选名单：
     - 0（乖宝宝）：只考虑玩家；
     - 1（普通人）：先列玩家，再以 `rand()%3==0` 的概率追加恶人；
     - 2（大老奸）：只考虑恶人；
     - 其他值：不动作。
  3. 用 `rand()%候选数` 挑一个。
  4. 挑中玩家时要求点券 **> 30**；挑中恶人时要求点券 **≥ 700**（`0x2bc`）。实际只扣 300。
  5. 显示「保釋%s」。
- **放人**（`0x43d7bf` / `0x43ee6e`）：
  - `owner = 当前玩家`，`state = 0`，`node = 关押格`，`lastNode = 0`。
  - 关押格是地图上 type 为 `0x1f42`（监狱）或 `0x1f41`（医院）的节点，**不是**保释格。
  - `home = 1`（监狱）或 `2`（医院）；如果关押格本身的 specialKind 也是 4/5，就同时置 bit7。
- **行动时机**：放出来的**同一轮**、所有玩家行动完之后，就轮到恶人段行动。

## 2. 回合与移动
```
轮次：玩家 0..N-1 → 恶人 4,5,6,7（state≠0 的跳过）→ 日期+1 → 玩家 0 …
恶人回合开始的 tick（0x41c84f 的 actor≥4 支）：
  先把带 bit7 的计时器清 0；再把非 0 的计时器 -1，减到 0 就写成 0x80（本回合仍算生效）
if 冬眠(+12)≠0 或 停留(+14)≠0：本回合不动
steps = 乌龟(+15)≠0 ? 1 : rand()%9 + 2          // 2..10 步，不掷骰子、不走骰子动画
每一步：候选 = 相邻节点 − 来路 − 封路方向；候选为空就原路返回，否则 rand()%候选数
每落一格调用 onNpcStep(cell, stopped)；stopped = 这是最后一步，或被路障拦下
恶人不进入格子事件分派（0x40c912(1) 对 actor≥4 返回 0）：
  ⇒ 不缴过路费，不触发新闻/命运/银行/商店/公园等
```
卡片对恶人的效果：
- 停留卡：`+14 = 1`，恶人跳过 1 个回合。
- 乌龟卡：`+15 = 3`，恶人连续 3 回合每回合只走 1 步。
- 冬眠卡：施卡时盘上**所有**恶人（包括施卡人自己雇的）`+12 = 5`、`+13 = 0`，5 个回合不动也不行动。
- 梦游卡：没在冬眠的恶人才会被写 `+13 = 5`。这 5 回合照常走 2..10 步，但**所有偷、抢、勒索、捡物都跳过**，只保留下面的「回老家」检查。

## 3. 每一步的结算 onNpcStep（按原版顺序）
```
① 格上的物件（按物件类型分派；恶人跳过银行 ATM、乞丐、定时炸弹倒数）
   神明(1..10,12)：恶人无效
   恶犬(11)：只在 stopped 时生效 → 狗被移除，恶人住院（state=2），本趟结束（小偷也会被咬）
   礼物(13)：只有小偷且没在梦游 → 移除礼物，雇主按商店库存随机得一件道具；每一步都拿
   宝箱(14)：只有小偷且没在梦游 → 移除宝箱，雇主点券 +500；每一步都拿
   路障(16)：小偷 → 拆掉，从库存给雇主道具 2
             5/6/7 → 路障回库存，并**当场停下**（算 stopped，继续做 ②③）
   地雷(17)：小偷 → 拆掉，给雇主道具 3
             5/6/7 → **只在 stopped 时**爆炸：地雷回库存，恶人住院（state=2）
   定时炸弹(18)：小偷 → 拆掉，给雇主道具 4；5/6/7 → 无事
② if state≠0 或 梦游≠0：跳到 ③
   actor 4/5（**每一步**都做，路过也算）：
     v = 本格玩家位图 & ~(1<<owner) 里下标最小的那一个；如果 v 已出局（who_plays==0）就作罢
     小偷：amt = floor(v.点券/2)（16 位）；amt>0 时 v.点券 -= amt、雇主.点券 += amt
           提示「偷取%s\n\n%d點點券！」
     強盜：从 v 手牌里 rand() 抽一张（只抽卡片，不抽道具）→ 给雇主
           提示「奪取%s%s！」
   actor 5 且本格 specialKind==14（银行，路过也算）：
     对每个 who_plays≠0 且不是雇主的玩家 i：
       amt = trunc(i.存款 × 0.2)；pay_money(i, 雇主, amt, 5)   // 先扣存款再扣现金，入雇主现金
     提示「強盜搶奪銀行\n\n得款%d元\n\n給%s！」
   actor 6/7：**只在 stopped 时**，按格子类型：
     住宅地（2000<type<4000）：必须有地主，且地主≠雇主
       流氓：fee = Σ(与本格同地主、且同名（同一路段）的所有地块的地价 +0x1c) × PI   // 不含房屋等级
             提示「勒索%s\n\n%d元保護費！」
       間諜：fee = 本地块 +0x2c（最近一次实收的过路费；每次收租被覆盖，间谍取走后不清零）
             提示「取走過路費\n\n%d元！」
       pay_money(地主, 雇主, fee, 0)        // 地主先扣现金再扣存款，可能破产；钱进雇主**存款**
     设施/商业用地（4000<type<6000）：必须有地主，且地主≠雇主
       流氓：fee = 设施 +0x22（地价部分）× PI，不按路段累加
       間諜：fee = 设施 +0x30（最近一次过路费）
     上市企业（6000<type<8000）：必须有董事长，且董事长≠雇主；只有間諜生效
       amt = 企业 +0x28（本月盈余，也就是待发的红利；有符号）
       pay_money(企业, 雇主, amt, 0)   // 从企业账户扣：+0x28 归 0，+0x2c 同减
       amt 为负时，雇主存款反而减少
③ 回老家检查（每一步都查，梦游时也查）：
   if (home&0x7f)==1 且本格 specialKind==4，或 (home&0x7f)==2 且本格 specialKind==5：
     if home 的 bit7 已置：送回关押（state=1/2，清掉 +11..+15），本趟立即结束
     else：只把 bit7 置上（第一次踩到只做标记）
```
共同规则：
- 恶人**从不作用于雇主**，受害者里也不包括已出局的玩家。
- 同一格有多名受害者时，只作用于下标最小的那一个。
- 受害者只算**恶人自己走进的格子**上的人。起步那一格不结算；被关押、住店或消失的人，节点占位已清除，所以不会被偷。

## 4. 雇用关系的结束
- 雇主破产（`0x40cd87`）时，他雇的恶人会被强制送回：小偷/強盜回监狱，流氓/間諜回医院。
- 「回老家」按 `home` 字段判断，而 `home` 取决于**最近一次从哪里被放出来**，不是固定的。例如強盜被地雷炸进医院、再从医院保出来，之后他回的是医院。
- 其他会把恶人关起来的途径：
  - **陷害卡**：可以直接选恶人为目标，关进监狱。恶人不查免罪/嫁祸/复仇卡，也不计敌意。
  - **地雷**：只影响 5/6/7，停在地雷格上才炸，送进医院。
  - **恶犬**：4/5/6/7 都会被咬，停在恶犬格上才生效，送进医院。
  - **飞弹、核子飞弹、新闻「外星人攻打地球」**：伤害范围函数 `0x40ac7b` 会把范围内的恶人送进医院。
- 恶人一旦被关，就要有人再花 300 点券保释，保释人成为新雇主。**雇用没有时间上限。**
- 机器娃娃只清除路上的物件，对恶人没有任何作用。

## 5. 乞丐（出局玩家留在地图上的棋子）
- 玩家破产后 `who_plays = 0`，但棋子仍留在原格，就成了乞丐。回合循环会跳过他。
- **触发**：只对玩家生效，恶人不理会乞丐。玩家**停在**某格（路过不算），且该格除自己外下标最小的那个玩家已出局。
- 效果：
  1. 提示「施捨給乞丐%d元」，金额 = **1000 × PI**。
  2. 执行 `pay_money(我, -1, 金额, 0)`：先扣现金再扣存款，付不起就破产。收款方 -1 表示**进入乐透累积奖金池 `0x499080`**，不是给乞丐。
  3. 乞丐换位置（`0x40cc56`）：从所有「可走、没有人和物件、没有禁放标志」的节点里随机抽一个。要求与原位置 |dx| ≥ 300 或 |dy| ≥ 300，不满足就重抽。候选数为 0 时原版会除零崩溃。
- 结算顺序：停下时先处理乞丐，再处理物件，最后才是格子事件（过路费等）。

## 6. 事件中会检查的被动卡
**`0x441210(p)` 的逻辑**：
1. p 持有免罪卡（21）→ 用掉，显示「免罪卡生效！」，事件取消（返回 -1）。
2. 否则 p 持有嫁祸卡（19）→ 选一个新目标：
   - 人类：从其他在场玩家里选；只有一个候选时是/否确认；可以拒绝。
   - 电脑：选敌意最高的人；没有就随机挑一个在场玩家。
   - 选中则卡片消耗。
3. 返回最终目标。改嫁后的新目标**不会再被检查**。

**`0x441210` 的调用点共 7 处**（mytbk 汇编）。remake 和 spec 的 cards.md 说 5 处，漏了魔法屋的 2 处：

| 来源 | 事件 | 结算顺序 |
|---|---|---|
| 命运[6]/[7] | 强迫出国观光 / 被外星人绑架 3 天 | 神明气运判定 → 免罪 → 嫁祸 → 消失 3 天 |
| 命运[12]/[13]；[15]/[16] 无车时转入[12] | 掉进水沟就医 / 骑机车摔伤 3 天 | 气运判定 → 免罪 → 嫁祸 → 废座驾 → 住院 |
| 命运[33]～[36] | 坐牢 3/5/7/9 天（酒醉闹警局、防碍风化、走私毒品等） | 气运判定 → 免罪 → 嫁祸 → 坐牢 |
| 魔法屋[2] | 立刻坐牢三天 | 对每个目标：敌意 +90×PI → 免罪 → 嫁祸 → 坐牢 3 天 |
| 魔法屋[10] | 住院检查三天 | 同上 → 住院 3 天 |
| 新闻[29] | 违法超贷，经营者坐牢 5 天 | 随机抽一家有主企业 → 董事长走免罪 → 嫁祸 → 坐牢 5 天（没有气运判定） |

**命运事件的气运判定** `0x44b896(1,1)` 在查卡之前，看玩家的倒霉值 `+0x48`：
- 返回 1：「逃过此劫」，事件取消，**不消耗卡**；
- 返回 2：天数加倍；
- 返回 0：照常执行。

**免费卡（20）只在以下 4 处检查**，任何命运、新闻、魔法屋的罚款，以及恶人的勒索、偷租，都**不能**用免费卡或嫁祸卡抵挡：
- 住宅过路费；
- 设施过路费；
- 企业消费；
- 查税卡。

条件是：金额 ≥ 2000×PI，或金额 > 现金+存款 → 先问免费卡，再问嫁祸卡。

**复仇卡（18）只在梦游卡、陷害卡的「最终目标 == 原目标」分支检查**，事件里不查。梦游卡和陷害卡对玩家的查询顺序是：免罪 → 嫁祸 →（目标没被改嫁时）复仇。

## 7. 说明书 / 社区与 v3.11 代码的冲突（并列记录，实现以 exe 为准）
1. **強盗能抢什么**：说明书写「一张卡片或道具」；v3.11 只调用抽牌函数 `0x441e77`，只抽卡片。
2. **強盗抢银行的比例**：社区（维基、萌娘、巴哈）说 50%；exe 常量 `0x463b60` 是 0.2（`0x3FC999999999999A`）。
3. **流氓的钱给谁**：社区摘要说「不会给保释人」；巴哈说「给你」。exe 是 `pay_money(地主, 雇主, …, 0)`，**钱进雇主的存款**。推测社区误传是因为存款入账不如现金显眼（这是推断）。
4. **remake 的注释自相矛盾**：npc-actions.ts 文件头说「強盜/流氓/間諜都会夺卡」；汇编的分派 `cmp ebp,4 / je; cmp ebp,5 / jne 0x41c447` 表明**只有強盜**会夺卡。remake 后来改写的 npc-walk.ts 也已经这样实现。
5. **流氓是否收商业用地**：163 文章说流氓「两格的地不包括」；exe 对设施（商业用地）照样按 `+0x22 × PI` 收保护费。


## entries
- **四大恶人身份、编号与开局位置** [身份与初始] (high) actor 4 = 小偷、5 = 強盜、6 = 流氓、7 = 間諜。开局时小偷、強盜在监狱（state=1），流氓、間諜在医院（state=2），都没有雇主。行为对应：小偷偷点券并拾取、拆除路上物件；強盜抢卡、抢银行；流氓按地价收保护费；間諜取走过路费和企业盈余。 | 数值: 名字表 0x47ed5a[4..7] = Big5「小偷/強盜/流氓/間諜」；模板 0x47ecec 的 state 字节依次为 1,1,2,2（第 5 条 = 3 是机器娃娃）；new_game 把 in_prison[4]、[5] 和 in_hospital[6]、[7] 置 1 | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4.asm, https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_new_game.asm, https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/places.md
- **恶人记录与状态机** [数据模型] (high) 每个恶人一条 16 字节记录，字段：owner（雇主）、state（0 在盘 / 1 监狱 / 2 医院）、home（低 7 位 = 出身 1/2，bit7 = 已离开过门口）、冬眠/梦游/停留/乌龟四个计时器。恶人没有刑期天数：关押后一直关着，直到被保释；关押时不理赔、不播报。 | 数值: 记录地址 0x498e28+(actor-4)*16：+8 owner，+10 state，+11 home，+12 冬眠，+13 梦游，+14 停留，+15 乌龟 | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_prison_utils.asm, https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_player_info.h, https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/places.md
- **保释（雇用）：人类玩家** [雇用] (high) 玩家停在监狱格或医院格上，且那边关着人时，弹出保释界面。保释恶人花 300 点券、保释玩家花 30 点券，不扣现金。点券不足时提示「點數不足」；够了再弹是/否确认。被保释的恶人立即放到关押格（type 为 0x1f42/0x1f41 的节点），owner 设为保释人。只是路过不会触发。 | 数值: 价格表 {30,30,30,30,300,300,300,300}（0x475c44 / 0x475ca4）；判定为点券 ≥ 价格；点券是 16 位字段 | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_ui_prison.asm, https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_ui_hospital.asm, https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/places.md
- **电脑雇用恶人的条件** [雇用/AI] (high) 电脑停在监狱或医院格时：先 rand()&1，为 0 就不做。再按个性 player+0x17 决定候选：0 只考虑玩家；1 先列玩家，再以 rand()%3==0 的概率追加恶人；2 只考虑恶人。然后 rand()%候选数挑一人。挑中恶人时要求点券 ≥ 700，但实际只扣 300；挑中玩家时要求点券 > 30。每次停留最多保释一人。 | 数值: 阈值 0x2bc = 700（无符号比较 jb）；随机数消耗顺序：rand&1 → （个性 1 时）rand%3 → rand%n | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_ui_prison.asm, https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_ui_hospital.asm, https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/places.md
- **行动时机与回合顺序** [移动] (high) 回合顺序为：玩家 0..N-1 → 恶人 4、5、6、7（state≠0 的跳过）→ 回到玩家 0，同时日期 +1。所以恶人被保释后，就在同一轮所有玩家行动完之后行动，每轮（每天）行动一次。恶人回合开始时先 tick 自己的四个计时器。 | 数值: 0x418ebd：cur==num_players 时 cur=4；cur==8 时 cur=0 并推进日期；恶人 state≠0 时跳过 | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4.asm, https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/game-loop.md
- **恶人步数与岔路** [移动] (high) 恶人不掷骰子，步数 = rand()%9+2（2..10 步）。停留计时器≠0 时不动；乌龟计时器≠0 时只走 1 步；冬眠计时器≠0 时整个回合不行动。每一步从相邻节点里去掉来路和封路方向，再随机选一个；无路可走时原路返回。恶人不触发格子事件，不缴过路费，也不会进入新闻、命运、商店、银行等界面。 | 数值: 0x40de50：rand()%9+2；0x40de1a 停留 → 0 步；0x40de34 乌龟 → 1 步；0x40c912(1) 对 actor≥4 返回 0，因此不调用 land_on_node | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_player_utils.asm, https://github.com/mytbk/rich4/blob/HEAD/asm/rich4.asm, https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/special-actors.ts
- **小偷：偷点券** [行为] (high) 小偷每走进一格（路过或停下都算）：取本格玩家中排除雇主后下标最小的那一个；如果他已出局就作罢。否则偷走他一半点券（向下取整），全部加给雇主。数额为 0 时什么都不发生。 | 数值: amt = points>>1（16 位）；提示「偷取%s\n\n%d點點券！」，显示 1000ms | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_player_core_actions.asm, https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/npc-actions.ts, https://forum.gamer.com.tw/G2.php?bsn=972&sn=14583
- **小偷：拾取与拆除路上物件** [行为] (high) 小偷每一步都会处理路上的物件（梦游中不处理）：礼物 → 雇主按商店库存随机得一件道具；宝箱 → 雇主点券 +500；路障、地雷、定时炸弹 → 先回商店库存，再从库存各发一件道具 2、3、4 给雇主（库存为 0 或雇主道具栏满时不发）。小偷不会被路障拦下，也不会被地雷炸伤。 | 数值: 提示「小偷偷得%s\n\n給%s！」；宝箱 +500 点券；物件类型 13/14/16/17/18 | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_player_core_actions.asm, https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/tools.md, https://forum.gamer.com.tw/G2.php?bsn=972&sn=14583
- **強盜：夺卡** [行为] (high) 強盜每走进一格（路过或停下都算），对本格中不是雇主、下标最小、仍在场的玩家，从他手牌里随机抽一张卡片交给雇主。只抽卡片，不抽道具；受害者没有卡就什么都不发生。流氓和間諜不会夺卡。 | 数值: 0x441e77：rand()%手牌数；提示「奪取%s%s！」，显示 1000ms | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_player_core_actions.asm, https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_card_utils_2.asm, https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/npc-walk.ts
- **強盜：抢银行** [行为] (high) 強盜只要走进银行格（specialKind 14，路过也算）就抢：对每个在场、不是雇主的玩家，按其存款的 20% 向零截断，先扣存款、不够再扣现金，进入雇主现金。抢完无论金额多少都显示合计。 | 数值: 比例 = 0.2（常量 0x463b60 = 0x3FC999999999999A）；pay_money flags=5；提示「強盜搶奪銀行\n\n得款%d元\n\n給%s！」，显示 2000ms | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_player_core_actions.asm, https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/npc-actions.ts
- **流氓：保护费** [行为] (high) 流氓只在停下的那一格生效。住宅地：地主存在且不是雇主时，保护费 = 该地主名下所有与本格同名（同一路段）地块的地价 +0x1c 之和 × PI，不含房屋等级。设施/商业用地：保护费 = 该设施的地价 +0x22 × PI，不按路段累加。上市企业：流氓不收。钱由地主支付（先扣现金再扣存款，可能破产），进入雇主存款。 | 数值: 住宅：fee = Σ(同主、同名地块 word+0x1c) × PI；设施：word+0x22 × PI；pay_money(地主, 雇主, fee, 0)；提示「勒索%s\n\n%d元保護費！」，显示 1500ms | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_player_core_actions.asm, https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/npc-actions.ts, https://www.163.com/dy/article/GB18SNVQ0546O9E5.html
- **間諜：取走过路费** [行为] (high) 間諜只在停下的那一格生效，地主存在且不是雇主时才动手。住宅地取 +0x2c，设施取 +0x30，都是该地块最近一次实收的过路费：每次收租时被覆盖，不累加。值为 0 时什么都不做。钱由地主支付给雇主（进雇主存款）。取走后该字段不清零。 | 数值: 收租处 0x41a00b 执行 mov [land+0x2c], 过路费，设施为 [+0x30]；pay_money(地主, 雇主, 值, 0)；提示「取走過路費\n\n%d元！」 | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_player_core_actions.asm, https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/state/types.ts, https://www.163.com/dy/article/GB18SNVQ0546O9E5.html
- **間諜：取走企业盈余（红利）** [行为] (high) 間諜停在上市企业格上，且企业有董事长、董事长不是雇主时生效：取走企业的本月盈余 +0x28，也就是每月 15 号要发的红利池。钱直接从企业账户扣（+0x28 归 0，+0x2c 同减），进入雇主存款。盈余为负时，雇主存款反而减少。 | 数值: pay_money(100+企业号, 雇主, +0x28, 0)；提示「取走盈餘\n\n%d元！」 | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_player_core_actions.asm, https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/stocks.md, https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/npc-walk.ts
- **通用规则：雇主豁免与受害者选择** [行为] (high) 恶人永远不作用于雇主：偷、抢的受害者位图先去掉雇主；抢银行跳过雇主；地主或董事长是雇主时不收钱。受害者只算恶人走进的那一格上的玩家，只取下标最小的一个；如果这个人已出局，就不再往下找。 | 数值: victim = ctz(occupancy & ~(1<<owner)) | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_player_core_actions.asm, https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/npc-actions.ts
- **回关押（雇用结束）** [结束] (high) 恶人每一步（梦游时也算）都检查：home 低 7 位为 1 且本格是监狱格，或低 7 位为 2 且本格是医院格时——home 的 bit7 已置就被送回关押，本趟立即停止；bit7 未置就只把 bit7 置上。所以通常是第二次踩到同类格时回去，社区描述为「绕一圈回去」。雇用没有时间上限。被关押后必须有人再花 300 点券保释，保释人成为新雇主。 | 数值: 0x41c7a6～0x41c844；回关押时调用 send_to_prison 或 send_to_hospital(actor, 0) | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_player_core_actions.asm, https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_prison_utils.asm, https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_hospital_utils.asm
- **雇主破产时恶人回收** [结束] (high) 玩家破产清算时，他雇用且在棋盘上的恶人被强制送回：小偷、強盜回监狱，流氓、間諜回医院。 | 数值: 0x40ce86～0x40cefd | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_player_bankrupt.asm, https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/places.md
- **陷害卡、梦游卡对恶人** [外部效果] (high) 陷害卡可以选恶人为目标：直接关进监狱（state=1），不查免罪、嫁祸、复仇卡，也不计敌意。梦游卡对恶人：没在冬眠时写入梦游 5，这 5 回合照常移动，但偷、抢、勒索、捡物全部停止，只保留回老家检查。 | 数值: 陷害卡：target≥4 时跳到 0x44467a，执行 add_prison(npc, 5)，NPC 支忽略天数；梦游卡：+13 = 5 | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_card_xianhaika.asm, https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_card_mengyouka.asm, https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/places.md
- **冬眠卡、停留卡、乌龟卡对恶人** [外部效果] (high) 冬眠卡：盘上所有恶人（包括施卡者自己雇的）写入冬眠 5、梦游清 0，5 个回合不动也不行动。停留卡：写入停留 1，恶人跳过 1 个回合。乌龟卡：写入乌龟 3，恶人 3 个回合每回合只走 1 步。计时器在恶人自己的回合开始时递减，减到 0 时写 0x80，下个回合才清零。 | 数值: 冬眠 +12 = 5；停留 +14 = 1；乌龟 +15 = 3 | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_card_dongmianka.asm, https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_card_tingliuka.asm, https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_card_wuguika.asm
- **地雷、路障、定时炸弹、恶犬对恶人** [外部效果] (high) 地雷：強盜、流氓、間諜停在地雷格上时爆炸（路过不炸），地雷回库存，恶人进医院；小偷则把地雷拆走交给雇主。路障：強盜、流氓、間諜路过也会被拦下，路障回库存，这一格按停下处理（流氓、間諜会在此勒索或取费）；小偷拆走交给雇主。定时炸弹：只有小偷会拆，其他恶人无事。恶犬：四个恶人停在恶犬格上都会被咬进医院，狗被移除。 | 数值: 地雷分支 0x41be5f；路障分支 0x41bceb；恶犬分支 0x41b837；恶犬 = 物件类型 11 | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_player_core_actions.asm, https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/tools.md, https://www.163.com/dy/article/GB18SNVQ0546O9E5.html
- **飞弹、核子飞弹、外星人新闻、机器娃娃对恶人** [外部效果] (medium) 伤害范围函数 0x40ac7b（飞弹、核子飞弹、新闻「外星人攻打地球」都会调用）把范围内的恶人送进医院（NPC 支，没有天数）。机器娃娃只清除路上的物件，对恶人没有任何效果。 | 数值: 飞弹调用 fcn(0x64, 0x26, 0, cur)；核子飞弹调用 fcn(-1, 0x26, 1, cur)；外星人新闻调用 fcn(0x64, 0x26, 1, -1) | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4.asm, https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_tool_feidan.asm, https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_news.asm
- **乞丐：施舍规则** [乞丐] (high) 玩家破产后棋子留在原格，成为乞丐。其他玩家停在同一格时（路过不算；只看除自己外下标最小的占位者，他必须已出局），要付 1000×PI。钱先扣现金再扣存款，付不起就破产；这笔钱进入乐透累积奖金池，不给乞丐。恶人不和乞丐互动。结算顺序在物件和格子事件之前。 | 数值: 金额 = 1000×PI；pay_money(我, -1, 金额, 0)；收款方 -1 表示奖金池 0x499080；提示「施捨給乞丐%d元」，显示 1500ms | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_player_core_actions.asm, https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/places.md, https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/beggar.ts
- **乞丐：换位置** [乞丐] (high) 施舍完成后，乞丐立即移到一个随机节点。候选节点要求：可走、没有玩家、恶人或物件占位、没有禁放标志；并且与原位置 |dx| ≥ 300 或 |dy| ≥ 300，不满足就重抽。朝向设为从第一个相邻节点走来。没有候选时原版会除零崩溃。 | 数值: 0x40cc56 调用 0x40aa6c；候选条件 (flags & 0x80ffff00)==0 且 adj≠0；距离阈值 300 | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_node_utils.asm, https://github.com/mytbk/rich4/blob/HEAD/asm/rich4.asm, https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/places.md
- **事件被动卡：免罪卡→嫁祸卡（0x441210）调用点** [被动卡] (high) 通用检查函数：目标持有免罪卡时用掉，事件取消；否则持有嫁祸卡时改指一名在场玩家（人类可以拒绝），卡片消耗；改嫁后的新目标不再检查。共 7 个调用点：命运[6] 出国观光、命运[7] 外星人绑架（各消失 3 天）；命运[12] 就医（[13] 以及 [15]、[16] 无车时都转入它）；命运[33] 坐牢（[34]～[36] 复用，天数 3/5/7/9）；魔法屋[2] 坐牢三天、魔法屋[10] 住院三天；新闻[29] 违法超贷，董事长坐牢 5 天。remake 说有 5 个调用点，漏了魔法屋的 2 个。 | 数值: 免罪卡 id 21（0x15），嫁祸卡 id 19（0x13），复仇卡 id 18，免费卡 id 20 | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_fortune.asm, https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_magic_house.asm, https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_news.asm
- **事件中被动卡的结算顺序** [被动卡] (high) 命运类倒霉事件：先做神明气运判定（倒霉值 +0x48；返回 1 表示逃过此劫、不消耗卡；返回 2 表示天数加倍）→ 免罪卡 → 嫁祸卡 → 对最终目标执行（就医事件先废座驾再住院）。魔法屋：先敌意 +90×PI（即使后面被免罪卡挡下，敌意也照加）→ 免罪卡 → 嫁祸卡 → 关 3 天。新闻[29]：没有气运判定，直接免罪 → 嫁祸 → 坐牢 5 天。事件中不查复仇卡。 | 数值: 气运阈值：x > 100 → 1；50 < x ≤ 100 → rand()&1；x < 0 → 2；魔法屋敌意 = 90×PI | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_fortune.asm, https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_magic_house.asm, https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/fortune.md
- **免费卡的检查范围** [被动卡] (high) 免费卡只在 4 处检查：住宅过路费、设施过路费、企业消费、查税卡。条件是金额 ≥ 2000×PI，或金额 > 现金+存款。检查顺序为先问免费卡（是/否），再问嫁祸卡（改由他人支付）。命运、新闻、魔法屋的罚款，以及恶人的勒索、偷租，都不检查免费卡或嫁祸卡。说明书写的「租金或罚金、税超过两千元」只部分符合。 | 数值: 阈值 2000×PI；has_card 共 18 个调用点，全部已列举 | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_player_core_actions.asm, https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_card_chashuika.asm, https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/cards.md
- **梦游卡、陷害卡对玩家的防御顺序（复仇卡）** [被动卡] (high) 对玩家的检查顺序：免罪卡（抵消）→ 嫁祸卡（改指）→ 若最终目标仍是原目标且原目标持有复仇卡，则原目标照样中招，施卡者也被加罚（陷害卡：坐牢 5 天；梦游卡：梦游 5 天）。陷害卡打到自己时关 4 天，打到别人时关 5 天。目标是恶人时跳过整条检查。 | 数值: 陷害：自己 4 天 / 他人 5 天；复仇反弹固定 5 天 | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_card_xianhaika.asm, https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_card_mengyouka.asm, https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/cards.md
- **冲突：強盜抢银行比例与抢夺内容** [冲突] (medium) 说明书写強盜抢「一张卡片或道具」；v3.11 只抽卡片。社区（维基、萌娘、巴哈）说抢存款的 50%；v3.11 常量是 0.2。实现以 v3.11 为准，同时在 UI 或设置里记录这一差异。 | 数值: 0.2 与 0.5 | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_player_core_actions.asm, https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/npc-actions.ts, https://forum.gamer.com.tw/G2.php?bsn=972&sn=14583
- **冲突：流氓保护费归属** [冲突] (medium) 社区摘要说流氓收的钱「不会给保释人」；巴哈说「给你」；v3.11 代码是 pay_money(地主, 雇主, fee, 0)，钱进雇主的存款。推测误传源于存款入账不显眼（这是推断，未验证）。 | 数值: flags=0，即收款方入存款 | src: https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_player_core_actions.asm, https://forum.gamer.com.tw/G2.php?bsn=972&sn=14583, https://www.163.com/dy/article/GB18SNVQ0546O9E5.html

## open_questions
- 1998 年初版（非 v3.11 超时空之旅）的恶人规则是否与 v3.11 相同？说明书写強盜抢「卡片或道具」，社区说抢存款 50%，v3.11 是只抢卡片、比例 0.2。需要初版 exe 或初版实况录像核对。
- 各地图关押格（type 为 0x1f42/0x1f41 的节点）的 flags 低字节是否恰好是 4/5？这决定恶人出狱时是否直接带上「已离开」标志，也就是第一次还是第二次踩到监狱或医院格就回去。需要逐图解析 map.mkf 来验证。
- 人类玩家停在监狱或医院格时，一次能否连续保释多名？代码显示 AI 只保一名；人类界面循环是否在成功一次后就关闭，没有逐条核对。
- 163 文章称流氓「两格的地不包括」，但 v3.11 对设施（商业用地）按 +0x22×PI 收保护费。两者不一致的原因（版本差异，还是设施 +0x22 在某些地图为 0）未查明。
- 人类选目标的掩码（陷害卡用 0x0e0c0710 等）是否覆盖全部 4 个恶人？AI 是否会主动对恶人使用陷害卡、停留卡、乌龟卡、梦游卡？没有逐条核对。
- 核子飞弹调用伤害范围函数时第一个参数是 -1，其范围语义（全图，还是某个固定半径）没有展开；外星人新闻的 0x64 是否表示像素半径，也未确认。
- 玩家走到恶人所在格时是否有任何效果？代码中没有找到相关处理，目前属于推断，需要实况验证。
- 同一格有多名受害者时只作用于下标最小的那一个——这是代码结论，社区未见相关描述，需要录像验证。
- 雇主收到卡片时如果已满 15 张，是否先弃掉最便宜的一张？道具栏满 9 个时是否不发？这两点只见于 remake 的注释，未在 mytbk 中逐条核对。

## sources
- https://archive.org/download/Richman-4-Manual/%E5%A4%A7%E5%AF%8C%E7%BF%814%E8%AA%AA%E6%98%8E%E6%9B%B8_djvu.txt
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_player_core_actions.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_player_utils.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_prison_utils.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_hospital_utils.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_ui_prison.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_ui_hospital.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_new_game.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_node_utils.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_player_bankrupt.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_load_map.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_card_xianhaika.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_card_mengyouka.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_card_dongmianka.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_card_tingliuka.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_card_wuguika.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_card_passive.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_card_utils_2.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_card_chashuika.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_card_table.c
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_fortune.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_magic_house.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_news.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_tool_feidan.asm
- https://github.com/mytbk/rich4/blob/HEAD/asm/rich4_player_info.h
- https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/places.md
- https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/tools.md
- https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/game-loop.md
- https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/cards.md
- https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/fortune.md
- https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/magic-house.md
- https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/news.md
- https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/stocks.md
- https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/ai.md
- https://github.com/oama1111/rich4-spec/blob/HEAD/docs/systems/land-rent.md
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/npc-actions.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/npc-walk.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/special-actors.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/rules/beggar.ts
- https://github.com/oama1111/rich4-remake-public/blob/HEAD/packages/core/src/state/types.ts
- https://forum.gamer.com.tw/G2.php?bsn=972&sn=14583
- https://www.163.com/dy/article/GB18SNVQ0546O9E5.html
- https://zh.wikipedia.org/zh-hans/%E5%A4%A7%E5%AF%8C%E7%BF%814