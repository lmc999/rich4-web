# 大富翁4 Web 复刻：三个原版小游戏与电脑 AI 设计

> **实施记录**：小游戏 sim 与原版 AI 的实际做法见 architecture §18.1（OriginalAiPolicy）、§18.4（三个小游戏），以那里为准。

> 规则基准：原版程序的实际行为。逆向资料几乎都基于 **v3.11 合版 exe**，文中的 VA 都指 v3.11。v2.06 与之是否一致，统一放到第 11 节「需要从用户正版文件核实的项」。
> 自研实现。GPL 仓库（oama1111/rich4-remake-public、mytbk/rich4）**只作事实来源**，代码一行不抄。每个常量用 `@source v311:0xVA` 标注出处。

---

## 0. 结论速览

| 主题 | 结论 |
|---|---|
| 逻辑 tick 频率 | **60Hz 和 30Hz 都不采用**。每个游戏直接用原版定时器周期作为逻辑 tick：企鹅 100ms、气球 100ms、喜从天降 50ms。客户端按显示器刷新率插值渲染。理由见 2.2 |
| 坐标系 | 统一用原版 640×480 整数舞台坐标（不用 960×540）。命中框、速度、跑道都是原版像素值 |
| 确定性 | 只用整数运算。三个游戏都**不需要三角函数**。随机数用 sim 自带的 Watcom LCG（15 位输出，与原版 `rand()%N` 分布一致），种子由服务器派发 |
| 输入 | `[tick, code, a, b?]` 三种：PickCell（企鹅）、Click（气球）、CursorX（喜从天降）。输入在第 tick 步推进**之前**生效 |
| 结算 | 分数 1:1 折成点券。点券原版是 uint16 会回绕，这里改为饱和到 65535（有意偏差）。电脑、托管、動畫過程关闭、玩家主动「跳过」，一律走原版的不玩分支：`50 + rand%20`，再掷一次 `rand&1` 选台词，共消耗 2 次 |
| 防作弊 | 沿用 design_net §6.3 的做法：服务器下发种子，客户端回传输入日志，服务器重放计分。在此基础上**加实时输入流**，同时用于观战直播和中途断线结算 |
| 电脑 AI | 按原版还原「个性闸门 + 固定阈值」这套 AI。`AiPolicy.decide(view, decision, ctx)` 是纯同步函数，只读公平视图。AI 的随机数按 `(aiSeed, 座位, decisionId或回合)` 派生，不碰引擎 RNG |
| 难度 | 原版没有难度选项。房间里给每个电脑座位提供「性格预设」：按角色（原版，默认）/ 乖宝宝 / 普通人 / 大老奸，UI 上可标作 简单/普通/困难。只覆盖 personality 这一个特质，不改任何阈值 |
| 托管 | 与电脑共用同一个 AiPolicy。托管真人座位时读该座位的 aiTraits，默认值来自角色表，可以在「託管AI」对话框里修改（原版的个性、使用卡片、使用道具、现金↔存款比例、股票↔资金比例），修改以系统 action 写进 state 并随存档保存 |

---

## 1. 资料基线与证据等级

- **A 级**：两份独立的指令级读法一致。例如喜从天降的炸弹概率：mytbk 的 asm 在 `0x41378d` 处是 `call 0x4123ba; test eax,eax; jne 跳过`，而 `0x4123ba` 返回 `rand()%10<7`，所以起预警的概率是 **30%**。remake 的差距审计（gaps/05 #35）得出同样结论。rich4-spec small-games.md 写的 70% 漏看了调用方的 `jne`。
- **B 级**：只有单一来源（rich4-spec 或 remake 注释），但给出了 VA。
- **C 级**：推断，或只是社区说法。
- 已知误读，本文按订正后的结论采用：
  - rich4-spec 把 `who_plays==1` 解读为「电脑」。实际 1 = 真人（LTCTM 存档修改器和指令流向都支持这一点），只有真人会亲自玩小游戏。
  - 企鹅件数模板 `{3,12,3,9,1}` 对应类型 1..5，类型 1 是炸弹，共 3 个。满分 **188**，不是 rich4-spec 算的 363。
  - 气球有 8 条跑道（x=40..600）。

---

## 2. 小游戏通用框架

### 2.1 触发与结算（与引擎的交互）

```
落点 kind ∈ {6 企鹅, 7 气球, 8 喜从天降}（只在停留时触发，路过不算）：
  if 玩家梦游中 (+0x37 闸门 @source v311:0x419873)      → 整格事件不执行
  elif room.minigameMode == 'skip'（= 原版 RICH4.CFG「動畫過程」关闭 @source v311:0x41561a） → resolveSkip()
  else → 建 PendingDecision{kind:'MINIGAME', options:{minigameId, allowDecline}}
         state.secret.minigame[decisionId] = { seed: rng.nextU32() }    // 种子只存在 secret 里
MINIGAME 允许的 intent：
  minigameDecline                              // 真人点「跳过」、电脑/托管、未开局就超时 → resolveSkip()
  MINIGAME_RESULT{score, sessionId, logHash}   // 只能由服务器构造（MinigameReferee 重放后提交）
resolveSkip():      @source v311:0x415457..0x4154bb
  score = 50 + rng.rand15() % 20               // 第 1 次消耗
  slot  = rng.rand15() & 1                     // 第 2 次消耗：角色台词槽 0 或 1（「得点券」>100 / 51–100 两档）
  coupons = min(65535, coupons + score)        // 原版是 add word 回绕，这里有意改为饱和
  events: MINIGAME_ENDED{seat, minigameId, mode:'skipped', score, couponsAfter, speech:{slot}}
resolveResult(score):
  coupons = min(65535, coupons + clamp(score, 0, spec.scoreSanityMax))
  events: MINIGAME_ENDED{seat, minigameId, mode:'played', score, couponsAfter}
```

- 引擎不区分座位由电脑还是真人控制，统一建 MINIGAME 决策，由 AiDriver 代电脑或托管座位回答 `minigameDecline`。这与原版一致：`who_plays≠1` 时直接走不玩分支。
- `allowDecline`（房间设置，默认开）：真人可以在倒计时阶段点「跳过，直接领 50–69 点券」。这相当于把原版「動畫過程」这个全局开关细化到每个玩家，得到的结果与原版可达的结果相同。

### 2.2 tick 频率裁决

**结论：逻辑 tick 等于原版定时器周期（企鹅 100ms / 气球 100ms / 喜从天降 50ms）。渲染用 rAF 在两个 tick 之间插值。**

不用 60Hz 或 30Hz 的理由：

1. 原版常量都是「每个定时器周期多少像素」的整数：气球上升 15/18/24，财神 ±12，接物者 10，落速 24/18/15/12。换算到 60Hz 就得写成 2.5px/帧这类定点小数，取整误差会移动命中和出屏的时刻，偏离原版。
2. 随机数的消费点与原版一一对应。气球是每个 tick 每个空槽掷一次 `rand()%1000`，改变 tick 频率等于改变每秒的期望生成数，概率表就得重新推导。
3. 输入在两个 tick 之间到达时，原版本来就是作用在上一个 tick 的状态上（WM_LBUTTONDOWN 发生在 WM_TIMER 之间）。把输入量化到 tick 不会丢掉原版能表达的任何信息。
4. 服务器重放步数少（最多 420 步），输入日志也短。
5. **插值误差由「最近 tick 归属」兜底**（见 7.2）。渲染位置是 `lerp(prev, curr, α)`。如果点击发生在 α<0.5，就把这次输入记到 t−1，并在本地回滚一步重算。这样画面与逻辑的偏差不超过 0.5×速度：最快的气球在 ×2 状态下是 48px/tick，偏差 ≤ 24px，小于命中框最小半高 26px。于是点在「看到的气球中心」一定能打中。

需要对齐的旧设计：design_net 的 `MinigameTicket.tickHz: 60` 改为 `tickMs: 50|100` 加 `introTicks` 和 `maxTicks`；design_client 的 `tickRate: 30` 和 `virtualSize 960×540` 作废。

### 2.3 确定性铁律（lint 强制执行）

- sim 目录禁止使用 `Math.random`、`Date`、`performance`、`Math.sin/cos/tan/pow/exp/log/hypot/round`，也禁止浮点字面量参与状态计算。只允许整数、`Math.imul`、`>>`、`|0`、`Math.trunc`（仅用于小整数相除），以及 `Int16Array`/`Int32Array`/`Uint8Array`。
- 整数除法统一用 `idiv(a,b) = Math.trunc(a/b)`，并规定 `|a| < 2^26`，保证与 C 语言截断除法结果相同。
- RNG（每个 sim 各自持有，状态是 uint32）：
  ```ts
  // @source game-loop.md PRNG（Watcom rand @v311:0x456f2d）
  export function rand15(s: { rng: number }): number {
    s.rng = (Math.imul(s.rng, 0x41c64e6d) + 0x3039) >>> 0;
    return (s.rng >>> 16) & 0x7fff;
  }
  export const randMod = (s, n) => rand15(s) % n;                 // 与原版 idiv 在非负数上一致
  export const randScale = (s, n) => (rand15(s) * n) >> 15;       // 企鹅埋宝 rand()*ebp>>15
  ```
- `hash(s)`：对所有 typed array 和标量字段做 FNV-1a 32 位哈希，用于 golden 测试、三端一致性测试，以及提交时附带的 finalHash（只核对并记日志）。
- `fx` 数组：每次 step 开头清空，只放表现用的提示（音效、粒子），不参与状态计算。

### 2.4 类型定义（`packages/shared/src/minigames/types.ts`）

```ts
export type MinigameId = 'penguin' | 'balloon' | 'xicong';     // 三端统一（旧名 fortune/balloonShoot/penguinDig 作废）
export const enum InputCode { PickCell = 1, Click = 2, CursorX = 3 }
/** tick = 在第 tick 次 step 之前生效；a/b 为 640×480 舞台整数坐标或格号 */
export type InputEvent = readonly [tick: number, code: InputCode, a: number, b?: number];

export interface MinigameSpec {
  id: MinigameId;
  tickMs: 50 | 100;
  introTicks: number;           // 入场（原版 intro 计数）
  playTicks: number;            // 游玩计时
  maxTicks: number;             // 硬上限（含 intro 与收场），重放和超时判定用
  stage: { w: 640; h: 480 };
  acceptedCodes: readonly InputCode[];
  maxInputsPerTick: number;
  maxInputsPerSecond: number;
  scoreSanityMax: number;       // 只防 bug；真实上限由规则决定
  rollbackAttribution: boolean; // 是否启用「最近 tick 归属」（只有气球开）
}
export interface SimBase {
  tick: number;                 // 已完成的 step 数
  phase: 'intro' | 'play' | 'ending' | 'over';
  rng: number;                  // uint32
  fx: SimFx[];
}
export type SimFx =
  | { t: 'dig'; cell: number } | { t: 'arrive'; cell: number } | { t: 'reveal'; cell: number; item: number }
  | { t: 'bomb' } | { t: 'timeup' }
  | { t: 'spawn'; slot: number } | { t: 'pop'; slot: number; kind: number; scoreAfter: number } | { t: 'miss' }
  | { t: 'effect'; effect: 0 | 1 | 2 | 3 | 4 | 5 }
  | { t: 'drop'; slot: number; item: number } | { t: 'warn'; x: number } | { t: 'bombDrop'; slot: number }
  | { t: 'catch'; item: number } | { t: 'boom' };

export interface MinigameParams { ruleset: 'exe311' }   // 预留 'exe206'（若核实后有差异）
export interface MinigameSim<S extends SimBase> {
  spec: MinigameSpec;
  init(seed: number, p: MinigameParams): S;
  /** 原地推进一步；inputs 必须全部满足 e[0] === s.tick，并按到达顺序排列 */
  step(s: S, inputs: readonly InputEvent[]): void;
  isOver(s: S): boolean;        // 分数已最终确定（结算姿势和大号分数属于表现层，不在 sim 内）
  score(s: S): number;
  clone(s: S): S;
  hash(s: S): number;
  validateInput(e: InputEvent): boolean;   // code 在 acceptedCodes 中、坐标或格号在范围内、都是整数
  accepting(s: S): boolean;                // 客户端据此丢弃无效点击，缩小日志
}
export interface MinigameBot<S extends SimBase> {  // AI 代玩：测试、演示、可选玩法，不用于原版结算
  create(seed: number): unknown;                   // bot 自己的记忆和随机数
  act(mem: unknown, s: Readonly<S>): InputEvent[]; // 只能读玩家屏幕上看得到的信息
}
```

### 2.5 重放与日志校验（`replay.ts` / `validate.ts`）

```ts
export function replay<S extends SimBase>(sim: MinigameSim<S>, seed: number, p: MinigameParams,
  log: readonly InputEvent[]): { score: number; endTick: number; hash: number } {
  const s = sim.init(seed, p); let i = 0;
  while (!sim.isOver(s) && s.tick < sim.spec.maxTicks) {
    const j0 = i; while (i < log.length && log[i][0] === s.tick) i++;
    sim.step(s, log.slice(j0, i));
  }
  return { score: clamp(sim.score(s), 0, sim.spec.scoreSanityMax), endTick: s.tick, hash: sim.hash(s) };
}
export function validateLog(spec: MinigameSpec, log: readonly InputEvent[]): ValidationError | null {
  // 长度 ≤ 2000；tick 为整数、单调不减、< maxTicks；validateInput 全部通过；
  // 同一 tick 的条数 ≤ maxInputsPerTick；任意 1000/tickMs 个 tick 的窗口内条数 ≤ maxInputsPerSecond
}
```

### 2.6 目录

```
packages/shared/src/minigames/
  index.ts            MINIGAMES: Record<MinigameId, MinigameSim<any>>、BOTS、SPEC
  types.ts  rng.ts  replay.ts  validate.ts  hash.ts
  penguin/  constants.ts  geometry.ts（格心、菱形拾取）  sim.ts  bot.ts  sim.test.ts
  balloon/  constants.ts  sim.ts  bot.ts  sim.test.ts
  xicong/   constants.ts  sim.ts  bot.ts  sim.test.ts
  __golden__/{penguin,balloon,xicong}.json    // {seed, log, score, endTick, hash}[]
  verify/exeFacts.ts   // 与用户 exe 提取出的 JSON 对照（见 §11）；缺文件时测试 skip
```

---

## 3. 企鹅挖宝（kind 6，`penguin`）

### 3.1 原版规则还原

| 项 | 值 | 出处 |
|---|---|---|
| 定时器 | 100ms。intro 10 tick（1s），游玩 150 tick（15s） | v311:0x4148b9 / 0x4148ab / 0x4148b1（A） |
| 棋盘 | 9×9 索引，格号 = 行×9+列。有效格 64 个，冰屋格 40 无效。有效掩码按行：r0 列 3–6，r1 列 1–7，r2 列 1–8，r3 全部，r4 除列 4 外全部，r5 全部，r6 列 0–7，r7 列 1–7，r8 列 2–5 | 格表 v311:0x474d7c（81×8 字节，word[0]==0 表示无效）（B，需核实） |
| 格心（舞台坐标） | `x = 48(r+c) − 64`，`y = 24(r−c) + 225`。菱形半宽 48、半高 24 | 同上。冰屋画在 (320,225) |
| 起点 | 第 6 行第 2 列（格 56） | v311:0x4148a2（B） |
| 埋藏 | 5 轮，件数 [3,12,3,9,1]，对应类型 1..5。每次取 `pick = rand()*free>>15`（free 从 64 起每埋一件减 1），在「有效且为空」的格子里按索引序取第 pick 个 | v311:0x411fc8 / 0x412014（A） |
| 类型与分值 | 1 = 炸弹（0 分，挖到立即结束）；2 = 5 分 ×12；3 = 12 分 ×3；4 = 8 分 ×9；5 = 20 分 ×1。满分 188 | v311:0x413d6a..0x413da6（A） |
| 名称 | 推断：5 分金币、8 分蓝宝石、12 分红宝石、20 分钻石 | C（需看截图核实） |
| 操作 | 只用左键。点目标格后企鹅逐格走过去，每格 4 tick；到达后自动挖 4 tick，然后揭晓。经过的格子不挖。以下情况点击无效：走路中、挖掘中、intro 期间、点当前所在格、点无效格 | 0x414abe 闸门（A） |
| 路径 | 16.16 定点直线：主轴每格 ±1，副轴每格加 `(d副<<16)/|d主|`。下一格无效时停掉该轴 | v311:0x41211c / 0x412287 / 0x4123aa（B，取整方式需核实） |
| 记忆阶段 | intro 期间所有埋藏格都画土堆，**看不出种类**；进入游玩后土堆消失 | D-MINI-9（B）。玩家回忆的「几秒、能看到种类」与此不符 |
| 结束 | 时间到，或挖到炸弹（分数保留） | 0x41298e→0x4129ab→0x412b95（A） |
| 表现 | 分数 <40 低姿势，>55 高姿势，40–55 中姿势；之后大号分数 2 秒，点一下可提前关 | 0x4149c8 / 0x4149e8（A） |

### 3.2 State

```ts
interface PenguinState extends SimBase {
  introLeft: number; timeLeft: number;
  board: Uint8Array;      // 81：0 空，1..5 类型；挖开后清 0
  dug: Uint8Array;        // 81
  moundShown: Uint8Array; // 81：只供 intro 渲染（= 开局 board != 0）
  counts: Int32Array;     // [0..5]
  cell: number;           // 当前所在格
  walk: null | { target: number; majorIsCol: boolean; maj: number; minFx: number; sMaj: -1|0|1;
                 stepMin: number; left: number; next: number; sub: number };
  digLeft: number;        // 0..4
  dir: number;            // 0..7，表现用
  endReason: 'none' | 'time' | 'bomb';
}
```

### 3.3 step 伪代码

```
init(seed): rng=seed; board 按 3.1 埋藏; cell=56; phase='intro'; introLeft=10; timeLeft=150; moundShown=board!=0

step(s, inputs):
  s.fx = []
  for e of inputs: if e[1]==PickCell: onPick(s, e[2])
  switch s.phase:
    'intro': if --s.introLeft == 0: s.phase='play'
    'play':
      s.timeLeft--
      if s.timeLeft <= 0: s.phase='over'; s.endReason='time'; fx timeup
      elif s.digLeft > 0: if --s.digLeft == 0: reveal(s, s.cell)
      elif s.walk: if ++s.walk.sub == 4: advance(s)
  s.tick++

onPick(s, c): if s.phase!='play' || s.walk || s.digLeft>0 || c==s.cell || !VALID[c] → return
             startWalk(s, c)        // 若第一步就无路可走，则原地挖（digLeft=4）
startWalk: dc=tc−fc, dr=tr−fr；|dc|≥|dr| 时主轴=列、n=|dc|、stepMin=idiv(dr<<16,|dc|)，否则主轴=行；
           minFx = 起点副轴<<16；next = nextCell(w)
nextCell(w):                                  // 取整方式标 VERIFY：round = (fx + 0x8000) >> 16
  nm=w.maj+w.sMaj; nf=w.minFx+w.stepMin; c1=cellAt(nm, round(nf))
  if VALID[c1]: commit(nm,nf) return c1
  c2=cellAt(nm, round(w.minFx)); if w.stepMin!=0 && VALID[c2]: w.stepMin=0; commit(nm,w.minFx) return c2     // 副轴停
  c3=cellAt(w.maj, round(nf));   if round(nf)!=round(w.minFx) && VALID[c3]: w.sMaj=0; commit(w.maj,nf) return c3 // 主轴停
  return -1
advance(s): s.cell=s.walk.next; s.walk.left--; s.walk.sub=0
  if s.cell==s.walk.target || s.walk.left==0: s.walk=null; s.digLeft=4; fx arrive,dig
  else { n=nextCell(s.walk); if n<0 { s.walk=null; s.digLeft=4 } else s.walk.next=n }
reveal(s,c): k=s.board[c]; s.board[c]=0; s.dug[c]=1
  if k==1: s.phase='over'; s.endReason='bomb'; fx bomb
  elif k>=2: s.counts[k]++; fx reveal
score = 5*c[2] + 12*c[3] + 8*c[4] + 20*c[5]
isOver = phase=='over'
```

- spec：`{tickMs:100, introTicks:10, playTicks:150, maxTicks:170, acceptedCodes:[PickCell], maxInputsPerTick:2, maxInputsPerSecond:10, scoreSanityMax:188, rollbackAttribution:false}`。
- 客户端拾取（`geometry.ts`）：对每个有效格判断 `|dx|*24 + |dy|*48 ≤ 48*24`（菱形），命中的格号作为 `a`。原版用逐像素命中表 Panel#81，边缘最多差一两个像素。这里的美术是自制的，采用几何菱形，属于有意偏差。

### 3.4 bot（AI 代玩，只读公平信息）

记忆里只有 intro 期间看到的土堆格。每当 `accepting`，就选一个「未挖的土堆格」，取路径步数最少者，平手取格号小的；土堆挖完后，改选最近的未挖有效格。bot 的反应延迟为 `2 + rng%3` tick。

---

## 4. 七彩气球（kind 7，`balloon`）

### 4.1 原版规则还原

| 项 | 值 | 出处 |
|---|---|---|
| 定时器 | 100ms。intro 5 tick，游玩 150 tick | v311:0x414c1d / 0x414f6b（A） |
| 槽 / 跑道 | 16 个槽；8 条跑道 x = 40 + 80k（k = 0..7）；从 y = 420 升起 | 0x413027 / 0x41305e / 0x41309b（A） |
| 生成 | 游玩中每 tick、每个空槽：`r = rand%1000`。r<20 → 类型 r>>2（数字 1–5）；r<28 → ((27−r)>>1)+5（数字 6–9）；r<30 → 特殊表[rand%10]；其余不生成。然后只在「没有气球 y>300」的跑道中取 `rand%可用数` | 0x4131a5 / 0x413001 / 0x413083（A） |
| 特殊表 | `09 09 0a 0a 0a 0a 0a 0b 0b 0b`：×2 占 20%，÷2 占 50%，? 占 30% | v311:0x475039（A） |
| 速度（px/tick） | `[15,15,15,15,18,18,18,24,24,24,24,18]`，按类型 0..11 取 | v311:0x475004（A，共 12 字节） |
| 命中框 | 类型 <6：±22×±30；类型 ≥6：±18×±26（含端点） | 0x414f26（B） |
| 出屏 | `y + off ≤ 0` 时移除。off：大球 111，小球 90，爆开图 82（精灵高度减锚点 y） | Panel#91 精灵尺寸（B，提取脚本输出数值） |
| 计分 | 数字气球：`score += k+1`，**只有这一支**在 ≥1000 时夹到 999。×2：`score*=2`，不夹。÷2：`score>>=1`。?：先清掉冻结和变速，再按 `rand%6` 取效果：0 剩余时间=1；1 冻结 20 tick；2 速度×2；3 速度÷2；4 分数清零；5 分数×2 | 0x414ed6..0x414ef3、0x414ba4 跳表（A） |
| 一次点击 | 遍历 16 个槽，**所有**命中的气球都爆，并按槽序依次计分。点空只放音效 | 0x414dec..0x414f2b（B） |
| 爆开 | 命中后爆开图停留 3 tick，再清空槽位 | 0x4130b6..0x4130d2（A） |
| 收场 | 时间到后不再生成新气球，屏上剩下的仍然能打；等全部出屏或被打掉才结算。大号分数显示 2 秒，不可跳过 | 0x413a32（A） |

### 4.2 State 与 step

```ts
interface BalloonState extends SimBase {
  introLeft: number; timeLeft: number; freeze: number; speedMode: -1 | 0 | 1; score: number;
  x: Int16Array; y: Int16Array; kind: Int8Array; pop: Int8Array;   // 16 槽；x==0 表示空槽
}
```

```
step(s, inputs):
  s.fx=[]
  for e of inputs: if e[1]==Click && (s.phase=='play'||s.phase=='ending'): click(s, e[2], e[3])
  if s.phase=='intro': if --s.introLeft==0 s.phase='play'; s.tick++; return
  if s.phase=='over': s.tick++; return
  if s.freeze>0 s.freeze--
  if s.timeLeft>0 s.timeLeft--
  spawning = s.phase=='play' && s.timeLeft>0
  active=false
  for i in 0..15:
    if x[i]==0:
      if !spawning continue
      r=rand15%1000
      k = r<20 ? r>>2 : r<28 ? ((27−r)>>1)+5 : r<30 ? SPECIAL[rand15%10] : −1
      if k<0 continue
      lanes = LANES.filter(l => !∃j: x[j]==l && y[j]>300)
      if lanes.length==0 continue          // VERIFY：无可用跑道时是否仍掷选道的那次 rand
      x[i]=lanes[rand15%lanes.length]; y[i]=420; kind[i]=k; pop[i]=0; fx spawn; active=true; continue
    if pop[i]>0: if --pop[i]==0 x[i]=0 else active=true; continue
    if s.freeze==0: v=SPEED[kind[i]]; y[i] −= (s.speedMode==−1 ? v*2 : s.speedMode==1 ? v>>1 : v)
    if y[i] + OFF[kind[i]<6?'tall':'short'] <= 0: x[i]=0; continue
    active=true
  if s.phase=='play' && s.timeLeft==0: s.phase='ending'
  if s.phase=='ending' && !active: s.phase='over'
  s.tick++

click(s,px,py): for i in 0..15:
  if x[i]==0 || pop[i]>0 continue
  if !hit(i,px,py) { fx miss; continue }
  k=kind[i]
  if k==9  s.score = sat32(s.score*2)
  elif k==10 s.score >>= 1
  elif k==11 { s.freeze=0; s.speedMode=0; e=rand15%6; fx effect(e)
               e==0: s.timeLeft=1 | e==1: s.freeze=20 | e==2: s.speedMode=−1 | e==3: s.speedMode=1 | e==4: s.score=0 | e==5: s.score=sat32(s.score*2) }
  else { s.score += k+1; if s.score>=1000 s.score=999 }   // 原版的「999 bug」：数字气球命中时，≥1000 一律夹回 999
  pop[i]=3; fx pop
score = s.score; isOver = phase=='over'
```

- spec：`{tickMs:100, introTicks:5, playTicks:150, maxTicks:300, acceptedCodes:[Click], maxInputsPerTick:4, maxInputsPerSecond:20, scoreSanityMax:65535, rollbackAttribution:true}`。
- bot：延迟 2 tick 看画面。候选气球的价值：数字气球 = k+1；×2 在 score≥30 时视为 score；÷2 视为 −score/2；? 在 score≥50 时视为负值、否则为 3。挑价值最大的点它的中心，每秒最多 5 次。

---

## 5. 喜从天降（kind 8，`xicong`）

### 5.1 原版规则还原

| 项 | 值 | 出处 |
|---|---|---|
| 定时器 | 50ms。intro 10 tick，游玩 360 tick（18 秒）。HUD 显示 tick/2 | 0x41500f / 0x4151c1 / 0x4141a0（A） |
| 财神 | y = 126，x 在 [110, 530] 内，每 tick ±12。状态机：0 向右走，2 右端转身（5 帧），3 左端转身（5 帧），4 向左走；1 不可达。初始 state 3、frame 4、x 110 | 跳表 0x413234、0x4138ba..0x413a22（A/B） |
| 撒宝 | 行走状态每段 5 帧，frame == spawnFrame 时在当前 x 撒一件，然后 frame++、x±12。走完 5 帧那一拍：向右时若 x>320 掷 `rand%4`，结果为 0 或 x==530 就转身；否则 `spawnFrame = rand%5`，x±12，frame 清零（向左对称，条件为 x<320 或 x==110） | 0x413886..0x413a22（B，按 remake 订正） |
| 宝物 | `rand%20`：<9 类型 3（金币 1 分，45%）；<15 类型 2（元宝 3 分，30%）；<18 类型 1（钱袋 5 分，15%）；其余类型 0（宝箱 10 分，10%）。rand 在找空槽**之前**就掷。最多 16 件 | 0x4123d7..0x412463（A） |
| 下落 | 起点 y = 100，初速 −16。y<130 时每 tick 速度 +2（上限 16）；y≥130 后按表 `[24,18,15,12,15]`（类型 0..4，4 是炸弹）匀速下落；y>380 算漏接 | v311:0x475010、0x4134b3（A） |
| 横向摆动 | 判定点 `px = x + trunc(frame*(y−130)/250)`，frame 取值 0..7 循环 | 0x4132bc（B） |
| 接物者 | y = 380。鼠标 x 与自身 x 相差 >8 才动，每 tick 10px。时间到后不再跟随鼠标 | 0x413606..0x413688（A） |
| 接住判定 | 使用当前帧贴图的矩形。默认 66×72、锚点 (33,71)，即 `x−33 < px < x+33` 且 `309 < y < 381`。**remake 读出「只有移动中（dir≠0）才判定接住」** | 0x413743（B，**需核实**） |
| 炸弹 | 预警未激活时，若（state<2 且 x>320）或（state>3 且 x<320），先掷 `r=rand%10`；**r≥7（30%）** 且处于游玩中，才掷 `rand%140` 并起预警。落点：财神在右半边 → 160+r，否则 360+r。预警共 12 帧，第 8 帧且未被炸时投下炸弹 | mytbk asm 0x41375b..0x4137e8（A） |
| 结束 | 接到炸弹，或时间到，都进入 ending：财神停止，屏上掉落物落完后结算。被炸时不播结算姿势 | 0x41342e / 0x413849（A） |
| 结算姿势 | <40、40–49、50–59、≥60 各一种（表现层） | 0x4150fe..0x41512c（A） |

### 5.2 State 与 step

```ts
interface XicongState extends SimBase {
  introLeft: number; timeLeft: number;
  godX: number; godState: 0|2|3|4; godFrame: number; godSpawnFrame: number;
  cursorX: number; catcherX: number; catcherDir: 0|1|2; catcherFrame: number;
  warn: number; warnX: number; bombs: number; hitBomb: boolean;
  ix: Int16Array; iy: Int16Array; ikind: Int8Array; iframe: Int8Array; ivy: Int8Array; // 16 槽
  counts: Int32Array;   // [0..3]
}
```

```
step(s, inputs):
  s.fx=[]
  for e of inputs: if e[1]==CursorX: s.cursorX = clamp(e[2], 0, 639)
  if s.phase=='intro': if --s.introLeft==0 s.phase='play'; s.tick++; return
  if s.phase=='over': s.tick++; return
  if s.phase=='play': if --s.timeLeft==0: s.phase='ending'; fx timeup
  if s.phase=='play': moveCatcher(s)
  active=false
  for i in 0..15: if ix[i]==0 continue
    iframe[i]=(iframe[i]+1)&7
    if iy[i]<130: ivy[i]=min(ivy[i]+2,16); iy[i]+=ivy[i] else iy[i]+=FALL[ikind[i]]
    px = ix[i] + idiv(iframe[i]*max(0,iy[i]−130), 250)
    caught = (!CATCH_REQUIRES_MOVING || s.catcherDir!=0) && px > s.catcherX−33 && px < s.catcherX+33 && iy[i] > 309 && iy[i] < 381
    if caught: if ikind[i]==4 { s.hitBomb=true; s.phase='ending'; s.warn=−1; fx boom } else { s.counts[ikind[i]]++; fx catch }
               ix[i]=0; continue
    if iy[i]>380: if ikind[i]==4 s.bombs−−; ix[i]=0; continue
    active=true
  warnStep(s)
  if s.phase=='play' godWalk(s) else { s.godState=2; s.godFrame=2 }
  if s.phase=='ending' && !active: s.phase='over'
  s.tick++
moveCatcher(s): dx=s.catcherX−s.cursorX
  if |dx|<=8 s.catcherDir=0 else { s.catcherDir = dx>0?1:2; s.catcherX += dx>0?−10:10; s.catcherFrame=(s.catcherFrame+1)%10 }
warnStep(s):
  if s.warn>=0: s.warn++; if s.warn==8 && !s.hitBomb spawn(s,s.warnX,true); if s.warn>=12 s.warn=−1; return
  if !((s.godState<2 && s.godX>320) || (s.godState>3 && s.godX<320)) return
  if rand15%10 < 7 return                    // 70% 不起预警（先掷 rand，再判断阶段，与 asm 顺序一致）
  if s.phase!='play' return
  r=rand15%140; s.warn=0; s.warnX = s.godX>320 ? 160+r : 360+r; fx warn
spawn(s,x,bomb): k = bomb ? 4 : (r=rand15%20, r<9?3 : r<15?2 : r<18?1 : 0); if bomb s.bombs++
  slot = 第一个空槽; 没有则 return; 写入 x, y=100, vy=−16, frame=0; fx drop / bombDrop
godWalk(s): 按 5.1 的状态机实现（state 2/3 各走满 5 帧后切到 4/0，frame 清零）
score = 10*c0 + 5*c1 + 3*c2 + c3; isOver = phase=='over'
```

- `CATCH_REQUIRES_MOVING` 默认 `true`（按 remake 的读法），并标 VERIFY。核实结论为「静止也能接」时改成 false，同时刷新 golden。
- 世界更新的顺序（接物者 → 掉落物 → 预警 → 财神）标 VERIFY（v311:0x413248）。
- spec：`{tickMs:50, introTicks:10, playTicks:360, maxTicks:420, acceptedCodes:[CursorX], maxInputsPerTick:1, maxInputsPerSecond:20, scoreSanityMax:999, rollbackAttribution:false}`。
- bot：在非炸弹掉落物中，挑 `价值 / 预计到达 tick` 最大、并且赶得上（|Δx|/10 ≤ 到达 tick）的那件，把光标对准它的预测 px。若某颗炸弹 8 tick 内会落在接物者 ±40px 以内，就先向远离的方向躲。

---

## 6. 服务端裁判与观战直播（对齐 design_net §6.3）

### 6.1 票据与消息（修改 `shared/net/protocol.ts`）

```ts
export interface MinigameTicket {
  sessionId: string; minigameId: MinigameId; seed: number; params: MinigameParams;
  tickMs: 50 | 100; introTicks: number; maxTicks: number;
  startsAt: number;            // = now + animMs + 3000（3 秒倒计时，期间显示操作说明和「跳过」按钮）
  deadlineAt: number;          // = startsAt + maxTicks*tickMs + 5000
  role: 'player' | 'spectator';
}
// C2S
'game:minigameInput':  (p: { sessionId: string; seq: number; events: InputEvent[] }, ack) => void;  // 每 200ms 或攒满 8 条发一次；seq 0 可以不带事件，表示「已开局」
'game:minigameSubmit': (p: { sessionId: string; inputs: InputEvent[]; claimedScore: number; finalHash: number; clientElapsedMs: number }, ack: Ack<{score:number}>) => void;
// S2C
'game:minigameFrames': (p: { sessionId: string; seq: number; events: InputEvent[] }) => void;       // 转发给观战者和其他玩家
```

- 引擎事件 `MINIGAME_STARTED{seat, minigameId, sessionId, spectate?: Omit<MinigameTicket,'role'> & {role:'spectator'}}`。房间设置 `minigameSpectate` 为 `'live'`（默认）时，才把种子公开给观察者，见风险条目。
- 限流：`game:minigameInput` 每秒 10 次；`game:minigameSubmit` 每 2 秒 1 次（不变）。

### 6.2 MinigameReferee 流程

```
open(decision):  session{log:[], lastTick:−1, started:false}；给玩家发 ticket(role:'player')；给观察者发 MINIGAME_STARTED
onInput(p):      seq 必须连续；每条事件 validateInput 通过、tick ≥ lastTick、tick < maxTicks；
                 且 tick ≤ floor((now − startsAt)/tickMs) + 20（不允许来自「未来」，容差 1–2 秒）；
                 条数和密度符合 spec → 追加到 log，started=true，转发 game:minigameFrames
onSubmit(p):     p.inputs 必须以 session.log 为前缀，否则拒绝并改用 session.log；validateLog；
                 时序：now − startsAt ≥ endTick*tickMs*0.85 − 500
                 result = replay(sim, seed, params, log) → runner.submit(system, MINIGAME_RESULT{score:result.score, logHash})
                 claimedScore 或 finalHash 与服务器不一致时只记日志和计数，一律以服务器重放为准
onDeadline():    started ? 用 session.log 重放到结束，按 MINIGAME_RESULT 结算（中途掉线：已发出的输入算数，之后视为不操作）
                            : 按 minigameDecline 结算（从未开局 → 走不玩分支）
玩家点「跳过」：   只有 started==false 时允许，按 minigameDecline 处理
```

- design_net 的 `CHOOSE_PATH` 超时条目删除（用户决策 3：岔路始终随机）。`MINIGAME` 的超时改为 `maxTicks*tickMs/1000 + 3 + 5` 秒。

---

## 7. 前端交互（对齐 design_client §9）

### 7.1 容器

- `apps/client/src/minigames/host/MiniGameHost.ts`：负责倒计时、驱动 FixedStepLoop（按 spec.tickMs）、InputRecorder、结算表现，以及观战模式。
- 舞台是 640×480 等比 letterbox，棋盘层隐藏，切换到小游戏 BGM（我们自己的曲目，对应原版的 MIDI13/12/11）。
- tick 对齐：`targetTick = floor((serverNow − startsAt)/tickMs)`。每帧最多补 10 个 tick。页面在后台时不产生输入，回到前台后追到当前 tick。
- 渲染：`view.render(prev, curr, α)`。气球、财神、掉落物按 α 插值；企鹅每格内的 4 个子帧也插值。
- 表现：结算姿势按分档播放；大号分数显示 2 秒，只有企鹅可以点击跳过；点券飞进 HUD 的动画在收到服务器的 MINIGAME_ENDED 后播放。本地算出的分数只用于即时显示。

### 7.2 输入

| 游戏 | 桌面 | 触屏（横屏） | 记录规则 |
|---|---|---|---|
| 企鹅 | 左键点格。光标换成蓝色椭圆靶圈 | 点击 | 先用菱形拾取得到格号 → 当 `accepting` 时记 `[t, PickCell, cell]`。方向键加回车可以移动高亮格后确认（无障碍） |
| 气球 | 左键射击，准星光标三帧轮播 | 点击，多指时每指算一次 | `[t', Click, x, y]`，坐标取整到舞台坐标。**最近 tick 归属**：α<0.5 时 t'=t−1，客户端从 prev 快照重算一步（fx 只补发新增的那部分）；t' 不能小于上一条的 tick |
| 喜从天降 | 鼠标横向位置，游玩时隐藏光标 | 手指横向拖动，按绝对 x 映射 | 每个 tick 最多记一条 `[t, CursorX, x]`，只在 x 变化时记。←/→ 键以每 tick 20px 移动一个虚拟光标（无障碍） |

- 手机横屏：640×480 等比缩放到 390 高时，缩放系数约 0.81。企鹅格子约 78×39 CSS px，气球命中框约 36×49，都可以点。竖屏只提示旋转（全局约定）。

### 7.3 观战

所有非当事人都用 `MiniGameHost.spectate(ticket, frames)`：本地用同一个 sim 重放收到的输入帧，保持 400ms 抖动缓冲。超过 2 秒没有新帧就定格，显示「等待 X…」。收到 MINIGAME_ENDED 时快进到终局，与权威分数对齐。`minigameSpectate` 为 `'replay'` 时，结算后才下发 `seed + log`，播放 2 倍速回顾。

### 7.4 与 design_client / design_net 需要统一的地方

1. `MiniGameId` 统一为 `'penguin'|'balloon'|'xicong'`，不再用 `balloonShoot/fortuneCatch/penguinDig/fortune`。
2. 作废 `tickRate:30`、`virtualSize 960×540`、气球的「炸弹球 / 冷却 6 tick」、企鹅的「6×5 网格 / 90 tick 预览 / dig 输入」、「3 个 15 秒小游戏」的说法（喜从天降是 18 秒）。
3. 删除 `miniGamePick` 决策（游戏种类由格子决定），删除 `chooseDirection` 决策（岔路始终随机）。
4. design_client 写的「断线由服务器用 def.ai 跑完」改为：已开局的按已收到的输入结算，未开局的走不玩分支。`def.ai` 更名为 `MinigameBot`，只用于测试、演示，以及可选的「电脑亲自玩」房间玩法（非原版，默认关）。
5. 统一用 `game:minigameInput`/`game:minigameFrames`（替代 `mg.input`/`mg.frames`）加 `game:minigameSubmit`。
6. `EVENT_BUDGET`：MINIGAME_STARTED 1500ms；MINIGAME_ENDED played 为「姿势时长 + 2000」；skipped 为 1000（台词阻塞 1 秒）。

---

## 8. 电脑 AI：原版行为还原

### 8.1 每回合结构（原版相位 2/5 的 `0x418dc6`）

```
掷骰前（PRE_ROLL），依次：
  ① 买股票：rand%3 必须为 0 才继续（每个电脑回合必掷）      @0x42bf14
  ② 卖股票：没有还款压力时 rand%3 必须为 0                   @0x42c802
  ③ 公布栏：rand%15 为 0 才挂牌 → rand%3 为 0 才重新定价 → rand%4 为 0 才买   @0x42886e/0x428a37/0x428ae8
  ④ 硬币 rand&1：奇数只考虑用卡，偶数只考虑用道具（二者互斥，每回合最多用 1 件）   @0x418e18（A）
  ⑤ 骰子颗数策略                                              @0x4221c0
  ⑥ 掷骰
```

采用硬币互斥的解读，理由是有指令级证据（A 级），critique 列出的冲突据此裁决。r_cards 写的「每回合 1 卡 + 1 道具」不采用。

### 8.2 通用机制

- **个性闸门**（`0x41e69e` 用于卡片，`0x420e9a` 用于道具，A 级）：`d = f7 − personality`。d≥2 从不做；d==1 时 `rng%3==0` 才做；d≤0 照做。个性 0 = 乖宝宝，1 = 普通人，2 = 大老奸。
- **候选环**：手牌 N>8 张时，从 `rng%N` 起环形取 8 张，否则从 0 开始取；道具种类 >4 时，从 `rng%count` 起环形取 4 种，**时光机不计入**。对候选依次「过闸门 → 问判定函数」，第一个愿意出的就执行。
- **视野**：以自己脚下为中心、440×440 的屏幕方窗，判定条件是 `−220 ≤ 投影偏移 < 220`。投影使用规范视角 0（原版随当时的视角档位变化；联机时各客户端视角不同，因此固定为 0，属有意偏差）。候选按投影后的屏幕行序排列（先 y 后 x，同位置按 id）。地块和设施用各自记录里的锚点 x/y，人和物件用所在节点坐标。
- **最恨的人** `mostHated(me)`（`0x40d2d3`，A 级）：遍历其他在场玩家，只有严格大于当前最大值才替换（first-wins）。全部为 0 时返回 −1。
- **worthTaking(enemy, e)**（`0x41e8e6`，A 级）：enemy==−1 → false。地块：有主、不是我的、有房子，并且（同街有我的地，或者地主正是 enemy 且等级≥2）。设施：有主、不是我的、等级>0。
- **同街** = 同名地块。
- **lookahead(n) / lookbehind(n)**（`0x40b221`/`0x40b343`）：沿邻接表前进，不回头；岔路用 AI 自己的 rng 挑一条，并记下「遇到过岔路」；无路可走时原路返回；最多 8 格。
- AI 的所有随机数都来自 `ctx`，与引擎 RNG 无关。原版这些 `rand()` 走全局序列，这里只保留分布，不保留序列。

### 8.3 角色特质表（`shared/ai/traits.ts`，@source 角色表 v311:0x47e80c，需核实）

| id | 角色 | 个性 | 借贷% | 现金% | 炒股% |
|---|---|---|---|---|---|
| 0 | 约翰乔 | 2 | 60 | 50 | 30 |
| 1 | 沙隆巴斯 | 1 | 100 | 40 | 45 |
| 2 | 忍太郎 | 2 | 0 | 70 | 0 |
| 3 | 钱夫人 | 2 | 100 | 60 | 30 |
| 4 | 阿土伯 | 1 | 50 | 40 | 25 |
| 5 | 莎拉公主 | 1 | 75 | 70 | 30 |
| 6 | 宫本宝藏 | 1 | 100 | 50 | 20 |
| 7 | 糖糖 | 0 | 0 | 40 | 35 |
| 8 | 乌咪 | 0 | 0 | 60 | 20 |
| 9 | 孙小美 | 0 | 50 | 50 | 0 |
| 10 | 小丹尼 | 1 | 30 | 55 | 15 |
| 11 | 金贝贝 | 2 | 80 | 80 | 0 |

12 个角色的能力位 f22 都是 3（会用卡、会用道具）。卡片和道具的 f7 以及价格，直接引用 `shared/data/cards.ts` 和 `tools.ts`，与 r_references §2.1 的表一致。

---

## 9. AI 接口与实现

### 9.1 类型（`packages/shared/src/ai/types.ts`）

```ts
export type Personality = 0 | 1 | 2;
export interface AiTraits {           // 对应原版玩家结构 +0x16..+0x1a
  personality: Personality; useCards: boolean; useTools: boolean;
  loanRatio: number; cashRatio: number; stockRatio: number;   // 0..100
}
export type AiPreset = 'character' | 'gentle' | 'normal' | 'cunning';
export interface SeatAiConfig { preset: AiPreset; overrides?: Partial<AiTraits> }
export interface TrusteeSettings { personality: Personality; useCards: boolean; useTools: boolean;
  cashRatio: number; stockRatio: number }                      // 原版「託管AI」对话框字段；比例步长 10
export interface AiRng { next15(): number; mod(n: number): number; bit(): 0 | 1; scale(n: number): number }
export interface AiContext {
  seat: SeatIndex; traits: AiTraits;
  rng: AiRng;                              // 按 (aiSeed, seat, decisionId) 派生
  turnRng(salt: AiSalt): AiRng;            // 按 (aiSeed, seat, turnIndex, salt) 派生；同一回合内多次调用结果稳定
  data: StaticGameData;                    // 地图、卡片、道具、角色、股票表
  handVisibility: 'public' | 'private';
}
export interface AiPolicy {
  readonly id: 'original-v1';
  decide(view: GameView, decision: DecisionForYou, ctx: AiContext): PlayerIntent;   // 纯同步，目标 <5ms
}
export function resolveTraits(characterId: CharacterId, cfg?: SeatAiConfig): AiTraits;
// preset：character → 角色表；gentle/normal/cunning 只覆盖 personality 为 0/1/2；overrides 最后覆盖
export function createAiRng(aiSeed: number, ...keys: number[]): AiRng;
// Watcom LCG，种子 = mix32(aiSeed, keys..)；字符串 key 先做 fnv1a32
```

### 9.2 AiView（`ai/view.ts`，只读封装公平视图）

```ts
export class AiView {
  constructor(v: GameView, seat: SeatIndex, data: StaticGameData);
  me; players; pi; initialFund; date; dayOfMonth; marketOpenToday; totalMonths;
  rivals(): SeatIndex[];  mostHated(): SeatIndex | -1;
  inView(p: {x:number;y:number}): boolean;
  visibleEntities(): VisibleEntity[]; visibleRivals(): SeatIndex[]; visibleObjects(); visibleEmptyNodes();
  street(landId): LandId[];  streetLevelSum(owner, street): number;  streetToll(owner, street): number;  // 含 PI
  lookahead(n, rng): { nodes: NodeId[]; forked: boolean };  lookbehind(n, rng);
  holdingsValue(seat): number; netWorth(seat): number; daysUntil(date): number;
  handOf(seat): CardId[] | { count: number };   // 私密模式下只返回张数
}
```

### 9.3 策略分派（`ai/policy.ts`）

```ts
const HANDLERS = {
  PRE_ROLL: preRoll, BUY_LAND: buyLand, UPGRADE_LAND: yes, BUY_FACILITY: buyLand, BUILD_FACILITY_TYPE: facilityType,
  UPGRADE_FACILITY: yes, RESEARCH_PICK: researchPick, BANK_ATM: atm, BANK_COUNTER: bankCounter, LOAN_REMINDER: ack,
  SHOP: shop, LOTTERY: lottery, MAGIC_HOUSE_EFFECT: magicEffect, BAIL: bail, MINIGAME: () => ({ type: 'minigameDecline' }),
  AUCTION_BID: auctionBid, FREE_CARD_PROMPT: freeCard, SCAPEGOAT_PROMPT: scapegoat, HAND_FULL_DISCARD: discardCheapest,
  BIRTHDAY_PICK: birthdayPick, STEAL_PICK: stealPick, SHARE_SUBSCRIBE: subscribe, CONSTRUCTION_TARGET: constructionTarget,
  SLOT_STOP: stopNow, INFO_ACK: ack, DEATH_TARGET: never, /* … */
} satisfies { [K in DecisionKind]: AiHandler<K> };   // 引擎新增 DecisionKind 时这里编译失败；暂无规则的先指向 useDefault
export const OriginalAiPolicy: AiPolicy = {
  id: 'original-v1',
  decide(view, d, ctx) {
    const v = new AiView(view, ctx.seat, ctx.data);
    const intent = HANDLERS[d.kind](v, d as any, ctx);
    return isLegal(intent, d) ? intent : d.defaultIntent;   // 先用 options 校验（合法目标、价格、上限），防止活锁
  },
};
```

DecisionKind 的名称以引擎领域为准，本表给出建议名；AI 内部通过 `toIntent()` 适配器转成引擎的 intent 名。

### 9.4 PRE_ROLL 伪代码

```
STEPS = [stockBuy, stockSell, boardList, boardBuy, cardOrTool, roll]
preRoll(v, d, ctx):
  log = d.options.turnLog                       // 引擎提供：本座位本回合已做的自由操作，按顺序排列
  cur = log.length ? stepIndexOf(last(log)) + (canRepeat(last(log)) ? 0 : 1) : 0   // 只有 stockSell 在有还款压力时可以重复
  for i in cur..4:
     intent = STEPS[i](v, d, ctx)               // 本步内的随机数一律用 ctx.turnRng('<步骤名>')，重复调用结果稳定
     if intent return intent
  return { type:'roll', dice: dicePolicy(v, ctx) }

stockBuy:   @0x42bf03..0x42c72d
  if turnRng('buyGate').mod(3)!=0 || traits.stockRatio==0 || !marketOpen || (loanDue && daysUntil(loanDue)<15) → null
  budget = min(存款, trunc((持仓市值+现金+存款)*stockRatio/100) − 持仓市值)；≤0 → null
  按 12 支股票的 score 降序排列（同分按下标；原版 qsort 不稳定，这里的有意偏差：取稳定排序）
  for (rank i, s)：score==0 跳过；turnRng('rank').mod(24) <= 12−i → 选中
  shares = min(trunc(budget/price), 当日可成交量)；0 → null
  score(s)（全部基于公开数据；常量 @0x46419c..）：
    停牌 / 涨停 / 当日可成交量为 0 → 0
    无企业：存款 ≤ 30000·PI → 0；avg6、avg24 为最近 6/24 个非 0 收盘价的均值
      现价 < 参考价×2.5 且 波动>2.0 且 avg6>avg24 → +2；现价 < 参考价×0.6 且 avg6>avg24 → +4；avg6 < avg24×0.5 → +2
    有企业：存款 ≤ 20000·PI → 0；S = 月均盈余；A = 资产额/10000
      0<S<5000PI → +1；5000PI≤S<10000PI → +2；S≥10000PI → +3
      累计盈余>0 且 我持股<5000 且 现价≤A×1.2 → +1，另外若董事长是别人：流通+我持股+企业剩余 > 董事长持股 → +1；我持股+可成交 > 董事长持股 → +2
      现价 < A×0.85 → +3；现价 < A×0.7 → +5
stockSell:  @0x42c79f..0x42d0ee
  pressure = daysUntil(loanDue) ≤ 6 && 现金+存款 < 贷款
  if !pressure && turnRng('sellGate').mod(3)!=0 → null；休市 → null
  对每支持仓（>0、未停牌、未跌停）打卖出分（有企业 / 无企业两张表，见 remake 已解的 VA 列表；有压力时 ×2 或 +1），取最高分且 >0 的一支，全部卖出
  有压力时重复，直到 现金+存款 ≥ 1.1×贷款 或 没有可卖的
boardList:  if turnRng('board').mod(15)!=0 → null。手牌 >12 时，从「成对的卡」表（k 张同名卡进表 k·(k−1) 次）随机挑一张挂牌，价格 = 卡价×100×PI；
            否则从 数量≥3 或（数量>0 且 f7−个性==2）的道具里随机挑一个挂牌，价格 = 道具价×100×PI。公布栏满了先撤第 0 格。
            （「1/3 重新定价」的规则未解，v1 不做 → open question）
boardBuy:   if turnRng('boardBuy').mod(4)!=0 → null。遍历其他人的挂牌：股票挂牌 round(标价/股数) < 现价 → 买；
            地产挂牌 3×估值 > 标价 且 现金 > 2×标价 → 买。每回合最多成交 1 件。
cardOrTool: coin = turnRng('coin').bit()
  if coin==1: if !traits.useCards → null；按候选环（最多 8 张）逐张：AI_NEVER_PLAYS 跳过；gate(f7, rng) 过了再调 CARD_AI[c](v,ctx)，得到合法选择就返回 useCard
  else:       if !traits.useTools → null；按候选环（最多 4 种，不含时光机）逐个：gate 过了再调 TOOL_AI[t](v,ctx)
dicePolicy: @0x4221c0（A/B）
  步行或受阻 → 当前骰子数；汽车默认 3，机车默认 2
  身背定时炸弹：引信 <15 → 1，否则保持默认
  否则 lookahead(5)：safe = 无主或我的地产/设施格数，hostile = 别人的格数
    safe==0 && hostile>2 → 汽车 2+rng.bit()，机车 2；safe≥2 && hostile≤1 → 1
```

### 9.5 30 张卡的 AI 判据（`ai/cards.ts`，入口为跳表 v311:0x475328）

| # | 卡 | f7 | AI 使用条件 → 目标 |
|---|---|---|---|
| 1 | 均富 | 2 | 在场平均现金 > 我的现金×10，且我的现金 < 3000·PI → 用 |
| 2 | 均贫 | 2 | 最恨的人在视野内，现金 > 30000·PI 且 > 我的 2 倍 → 他；否则视野内对手中现金 > 50000·PI 且 > 我的 3 倍的，取**下标最大**者 |
| 3 | 购地 | 1 | 脚下 worthTaking(hated)，且 (地价+房价×级)×PI < 现金 |
| 4 | 换地 | 0 | 脚下是我的、≤1 级、同街没有我的其他地 → 与视野内第一块「不同街、地价更高、等级更高、worthTaking」的地互换（设施同理） |
| 5/6 | 换屋 / 转向 | 0 | 从不使用 |
| 7 | 改建 | 0 | 脚下是我的连锁店，且同街另有我的地 → 改回住宅；脚下是我的 1 级住宅：乖宝宝直接改成连锁店，其他个性要求同街其余地块都是对手的才改。脚下是我的 1 级公园 → 改成 rng%4+1；脚下是对手的非公园设施、≥3 级（若是最恨的人则 ≥2 级）→ 改成公园 |
| 8 | 拍卖 | 1 | 脚下是对手 ≥3 级的地，或最恨的人 ≥2 级的地 |
| 9 | 天使 | 0 | 视野内我有 ≥3 块未满级住宅的街，用 rng 随机挑一条，目标是该街第一块 |
| 10 | 恶魔 | 2 | 按视野内各街统计：有最恨的人时，他在该街 ≥2 间、等级和 ≥7，且我的等级和 ≤1；没有时，我在该街为 0，对手合计 ≥3 间、等级和 ≥9 |
| 11 | 怪兽 | 2 | 有最恨的人：先看他的设施，再看他的地，取最高级（同级取更贵）且 ≥3；没有：看全体对手，设施优先，地要 ≥4 级 |
| 12 | 拆除 | 1 | 先按怪兽的判据找；找不到再按屏幕行序扫，第一个命中即用：对手的连锁店且他连锁店 ≥4 间（乖宝宝不做）/ 我有座驾时对手的加油站 / 对手地上的路障 / 我地上的地雷 |
| 13 | 抢夺 | 2 | 最恨的人手里 f7≥1 的最贵一张；否则所有对手手里 f7==2 的最贵一张。私密模式见 9.9 |
| 14 | 停留 | 0 | 对自己：不在龟行中；脚下是我的未满级住宅，房价×PI<现金，现金+存款>10000，财运≥0，且（同街另有我的地或 ≥2 级）；设施同理（非公园、非加油站，现金>10000）。对别人：视野内对手站在我 ≥2 级的非公园设施上，或站在我当董事长的企业上，按下标取第一个 |
| 15 | 冬眠 | 2 | rng%4==0 |
| 16/17 | 梦游 / 陷害 | 1/2 | 视野内对手中未冬眠、且手里没有复仇卡（可见时才判断）的：最恨的人优先，否则 rng 随机选一个 |
| 18–21 | 复仇 / 嫁祸 / 免费 / 免罪 | – | 被动卡，不主动出，见 9.7 的 prompt |
| 22 | 送神符 | 0 | 身上附着坏神（小/大穷神、小/大衰神、恶魔、死神），或身背定时炸弹 |
| 23 | 请神符 | 0 | 身上没有小/大财神、小/大福神、土地公，且视野内离我最近、无人附身的神明正是这 5 位之一 |
| 24 | 红卡 | 0 | 开市日：我持仓市值最大、未停牌、未涨停的一支 |
| 25 | 黑卡 | 1 | 开市日：最恨的人持仓市值最大的一支（未停牌、我没持有、未跌停）优先；否则取拥有企业最多的对手的持仓中市值最大、且有企业的一支 |
| 26 | 查税 | 1 | 最恨的人现金 > 30000·PI → 他；否则视野内对手中现金 > 50000·PI 的，取**下标最大**者 |
| 27 | 涨价 | 0 | 逐街检查：最恨的人不在该街、我的等级和 ≥7、对手等级和 ≤3、我占间数比例 ≥0.66（整数写法：`100×我的 ≥ 66×总数`）；地块都不符合时，取我第一栋 ≥3 级的非公园、非研究所设施（原版的 esi 残值怪癖记为有意简化） |
| 28 | 查封 | 1 | 前方 6 格内，某街我没有地、对手等级和 ≥7 → 封那一块；或最恨的人 ≥3 级的非公园设施 |
| 29 | 同盟 | 0 | 视野内对手中不是最恨的人、也没和我结盟的，取地产最多者 |
| 30 | 乌龟 | 0 | 对自己：前方 3 格没有岔路，且都是可买或可加盖的格；累计价格×1.5 < 现金、可用格 ≥2、现金+存款 >10000、财运 ≥0；途中遇到对手收费高（同街过路费 >1000·PI）的格就放弃。对别人：视野内某个对手前方 3 格没有岔路、都有主、没有一格是他自己的，且我在这些格上累计可收过路费 ≥10000·PI、至少 2 格 |

### 9.6 13 种道具的 AI 判据（`ai/tools.ts`，入口为跳表 v311:0x4753a0）

| # | 道具 | f7 | 判据 |
|---|---|---|---|
| 1 | 机器娃娃 | 0 | 前瞻 4 格没有岔路；路径上有坏神或恶犬 → 用；有地雷落在我的地上 → 用；有路障落在别人的地上且该地主同街过路费 >3000·PI → 用（别人的设施一律视为该条件成立） |
| 2 | 路障 | 1 | 阶段一：前瞻 4 格没有岔路，第一个空格满足以下任一条件就放：a) 无主住宅地，我在同街 ≥2 块或该地等级≠0，且现金+存款>10000、财运≥0、不在龟行、地价×PI<现金；b) 无主设施，钱的条件同上；c) 百货公司格且点券>200。阶段二：后瞻 6 格与视野的交集里，我的住宅中同街过路费 >6000·PI、过路费最高的那一格 |
| 3 | 地雷 | 1 | 后瞻 6 格与视野的交集：监狱格有人或医院格有人 → 立即选它；否则候选 = 对手的地块/设施格，取 rng%n |
| 4 | 定时炸弹 | 1 | 同地雷，但任何空格都可以作为候选 |
| 5 | 机车 | 0 | 步行中且 rng%4==0 |
| 6 | 汽车 | 0 | 交通工具 < 汽车且 rng%4==0 |
| 7 | 飞弹 | 2 | 目标 = 最恨的人，没有则随机一个在场对手，且必须在视野内；以目标为中心 100px 的爆风内若有我或我的地产 → 放弃 |
| 8 | 遥控骰子 | 0 | 以下情况不用：身附衰神/死神、龟行中、现金+存款<10000、财运<0。前瞻 6 格要求没有岔路；逐格跳过有恶人或坏物件的格。无主住宅（同街我有 ≥2 块，且 2×现金 > 5×地价）→ 立即定这个步数；无主设施（2×现金 > 5×地价）→ 立即定；我的未满级住宅或非公园/加油站设施满足 2×现金 > 5×房价 → 先记下，最后取等级最高的那条 |
| 9 | 机器工人 | 1 | 视野内我的可升级地产中，当前租金最高的一块（平手取屏幕行序靠前者）。**只对自己的地产用** |
| 10 | 时光机 | 2 | 从不使用（被跳过，且不计入候选） |
| 11 | 传送机 | 1 | 视野内无主、≥3 级、房价×PI<现金的地产，取等级最高的一块；还要求现金+存款>10000、财运≥0 → 把自己传送过去 |
| 12 | 工程车 | 2 | 当前还没开工程车，且 rng%15 ≤ 个性 |
| 13 | 核子飞弹 | 2 | 随机挑有主地产作为候选，最多 10 次，找一个「我不在以它为中心的那一屏里」的 → 发射（`0x421e62`，B 级；阈值细节需核实） |

### 9.7 非 PRE_ROLL 决策的规则总表

| DecisionKind（建议名） | AI 规则 | 出处 |
|---|---|---|
| BUY_LAND / BUY_FACILITY | 买，当且仅当 `现金+存款−价格 > min(trunc(开局资金×0.05), 7000) × PI`（引擎另外要求价格≤现金）。**不看仇恨，不看同街** | 0x41d7d4（A） |
| UPGRADE_LAND / UPGRADE_FACILITY | 引擎判定能盖（钱够、未满级）就盖，不留保留额 | 0x419911（A） |
| BUILD_FACILITY_TYPE（首建、天使卡或神明代盖） | `rng%4+1`，即旅馆/购物中心/加油站/研究所之一，**永远不盖公园**；首建付不起时放弃 | 0x41a23e（A） |
| RESEARCH_PICK | 当前可选的最高等级项目 | 0x44101d（A） |
| BANK_ATM（路过银行） | 按比例重新分配现金：`t = cashRatio/100`；当月 1–7 日 ×1.5，26 日及以后 ×0.5；t≥1 取 0.9，t≤0 取 0.1。若 `|现金/(现金+存款) − t| ≥ 0.25` 或现金==0，就把现金调成 `trunc(总额×t)`（单精度语义用 `Math.fround` 复现） | 0x437acd..0x437bca（A） |
| BANK_COUNTER（停在银行，ATM 之后） | 被拒绝往来 → 不办。先判断还款：`2×贷款 < 存款`，或（距到期 ≤6 天且现金+存款 ≥ 1.1×贷款）→ 全额还清。否则当 贷款==0 且 loanRatio>0 且未冻结放款，并且（`rng%10==0` 或 现金+存款 < 30000）→ 借 `min(trunc(身家×loanRatio/100), 额度)`。**AI 不使用特別融資**（未解） | 0x436668/0x436893/0x4368bb（A/B） |
| SHOP（百货公司；电脑座位看到的是整副牌堆，不抽货架） | S1：逐槽卖掉 f7−个性==2 的卡。S2：f7−个性==2 的道具整种卖光。S3：点券<100 时卖掉最便宜的一张卡，每种道具多于 1 件的卖到剩 1 件，并卖掉与当前座驾同类的车。点券为 0 → 离店。C：卡预算 = 点券>>1，牌堆中价格 ≤ 预算且 f7−个性≠2 的卡按价格降序逐张买，满 15 张停。V：道具预算 = 点券 − (点券>>1)；机车：当前不是机车、手里没有机车、80 < 预算、库存有 → 买；汽车同理，门槛 150。T：按顺序处理 [遥控骰子, 路障, 飞弹, 机器娃娃, 定时炸弹, 地雷]，满足「持有<9、f7−个性≠2、价格≤预算、库存>0」各买一件 | 0x42ed8d..0x42f307（A/B） |
| LOTTERY | 现金 > 1000 → 买，号码 = 未售号码[rng%n] | 0x43169e（A） |
| MAGIC_HOUSE_EFFECT | 受影响名单里有我 → 效果 6（得一张卡）；否则 `r=rng%11`，r==6 时改为 7（向后转）。第一个转盘（选哪一类人）由引擎用 RNG 转出 | 0x43381b（B） |
| BAIL（停在监狱或医院） | 先 `rng.bit()==0` → 不理会。按个性决定候选：0 只保释玩家；1 保释玩家，另外 `rng%3==0` 时把恶人也加入候选；2 只放恶人。目标 = 候选[rng%n]。费用门槛：保释玩家要求点券 >30；放恶人要求点券 ≥700（实际收 300） | 0x43d3d8 / 0x43ea9a（A） |
| MINIGAME | `minigameDecline`，结算走不玩分支 | 0x41560d（A） |
| AUCTION_BID | 第一次看到这场拍卖时，用 `turnRng('auction:'+id)` 算出心理价位并保持不变：`factor = r/32767×0.3+0.5`；`scarcity = 6 − 4×无主比例`；`v1 = ((级>>1)+1+我同街块数) × 起拍价 × PI × scarcity × factor`（PI 乘了两次，原版如此）；`v2 = 地价×PI×(3+r'/65536)`；`L = min(v1, v2, 现金)`。出价：现金 < 现价 → 放弃；否则从 10000/5000/1000/500/100 中取最大的一档，要求现价+档 ≤ L；一档都不行 → PASS。只剩一个可出价座位时压成最小档（+100） | 0x439f0d / 0x43b124 / 0x43b183（B） |
| FREE_CARD_PROMPT | 用，当 金额 > 现金，或 金额 > (rng%3000+3000)·PI | 卡片规则（B） |
| SCAPEGOAT_PROMPT | 过路费或罚款：金额 > (rng%4000+4000)·PI 才用；查税：现金 ≥20000·PI 才用；陷害或梦游：一律用。目标 = 候选中最恨的人，否则 rng 随机 | 卡片规则（B） |
| HAND_FULL_DISCARD | 丢价格最低的一张，同价取靠前的槽 | 0x44128f（A） |
| BIRTHDAY_PICK（命运「生日」） | 从每个对手手里随机拿一张 | squares_events（B） |
| STEAL_PICK（抢夺卡第二步） | 与第 13 号卡的判据相同；对方没有符合条件的卡时拿他最贵的卡，没有卡就拿最贵的道具 | 0x41f901（B） |
| SHARE_SUBSCRIBE（踩到上市企业现场认购） | `n = min(options.max, trunc((现金 − trunc(开局资金×0.3)×PI) / 单价))`；n≤0 → 不买 | 0x41d267 / 0x41d839（B） |
| CONSTRUCTION_TARGET（建设公司） | 在自己的住宅里挑当前等级租金最高的一块；没有住宅则挑地价最高的设施；都没有 → 放弃 | 0x40b455（B） |
| SLOT_STOP / 旅馆转盘等 | 立即停；结果由引擎 RNG 决定 | – |
| INFO_ACK / LOAN_REMINDER | 确认 | – |
| DEATH_TARGET（投降召唤死神） | AI 永不投降 | – |
| 其他 / 未来新增 | 使用 `decision.defaultIntent` | – |

### 9.8 难度（性格预设）与托管

- 房间设置里的电脑座位：`room:setSeatAi(p:{seat, ai: SeatAiConfig|null})`，取代原来的 `{difficulty}`。UI 下拉选项为「按角色（原版）/ 乖宝宝·简单 / 普通人·普通 / 大老奸·困难」，另有「高级」折叠面板，可以调五个特质。
  - 实际强弱主要来自两点：个性闸门决定出不出害人的卡，个性也决定保释风格。借贷和现金比例影响的是节奏，不直接等于强弱。所以预设**只覆盖 personality**，保持「原版 AI + 性格替换」，不引入非原版的智能。
  - 后续如需更强的「专家」AI，另实现一个 `AiPolicy`，例如 `plus-v1`，房间里单独选择，与原版 AI 并存。
- 托管：`game:autopilot {on, settings?: TrusteeSettings}`。服务器校验取值范围（比例为 0..100 且是 10 的倍数）后，提交系统 action `SET_AI_TRAITS{seat, traits}`，写入 `state.players[seat].aiTraits` 并随存档保存，对应原版把设置拷进玩家结构 +0x15..+0x1a 的做法。借贷比例不在原版托管对话框里，沿用角色默认值。
- 断线托管、AFK 托管、手动托管、超时代决都读 `aiTraits`，与原版托管一致。房间可选 `aiTimeoutPolicy: 'ai'（默认）| 'conservative'`。选 conservative 时，单次超时（非托管状态）使用 `defaultIntent`（不买、不用卡、直接掷骰），避免电脑替真人按角色比例大额借贷。
- 开局资金分配：`controller==='ai'` 的座位现金 = 总资金 × cashRatio / 100，其余进存款；真人对半分（由引擎领域实现）。

### 9.9 公平视图约束

- AI 只接收 `projectState(state, {kind:'seat', seat})` 和本座位的 `DecisionForYou`。**AiPolicy 不引用 GameState 类型，也不能访问 secret**：lint 规则禁止 import `engine/state`，测试中用 Proxy 拦截对 `secret` 的访问。
- 私密手牌模式（`handVisibility==='private'`）下的降级：
  - 抢夺卡（13）只要求最恨的人手牌 >0（否则选手牌最多的对手），具体拿哪张在 STEAL_PICK 时根据 options 里对方的手牌决定。
  - 梦游和陷害（16/17）忽略「对方持有复仇卡」这个条件。
  - 黑卡、红卡只用公开的持股信息，不受影响。
- AI 的随机种子 `aiSeed` 存在 `state.secret`，只由 AiDriver 读取，用来构造 `ctx`，policy 本身看不到。

### 9.10 AiDriver 对接（与 design_net §7 对齐的增量）

```ts
const view = projectState(st, { kind: 'seat', seat }, visOpts);
const ctx = makeAiContext({ aiSeed: st.secret.aiSeed, seat, decisionId: d.id, turnIndex: view.clock.turnNo,
  traits: st.players[seat].aiTraits, data, handVisibility: visOpts.handVisibility });
let intent: PlayerIntent;
try { intent = policy.decide(view, d, ctx); } catch (e) { log.warn(e); intent = d.defaultIntent; }
if (!PlayerIntentSchema.safeParse(intent).success || !allowedIntents(d.kind).includes(intent.type)) intent = d.defaultIntent;
runner.submit({ kind: 'ai', seat, by }, d.id, intent);   // 抛 EngineRuleError 时退回 defaultIntent，并计入 ai_rejects 指标
```

- design_net 原来的 `AiContext{difficulty, rng, characterId}` 改为 9.1 的定义。
- 「AI 独立 Prng，种子为房间 seed 加座位」改为「按 decisionId 或 turnIndex 派生」：不需要持久化 AI 的 RNG 状态，重启以后结果也能复现。

---

## 10. 测试方案

### 10.1 小游戏（vitest，放在 `packages/shared` 下）

1. **规则单测**：
   - 企鹅：埋藏件数恰好 3/12/3/9/1，落在 28 个不同的有效格上，不落在冰屋 40；走路或挖掘中点击无效；挖到炸弹立即 over；全部挖完得 188；路径 golden（10 组起点 × 终点）。
   - 气球：8 条跑道；在 1e5 次单槽掷骰上检验分布（数字 1–5 各 0.4%，6–9 各 0.2%，特殊 20/50/30）；y>300 时占用跑道；夹 999 只发生在加数字那一支；×2 可以超过 1000；÷2 向下取整；? 的 6 种效果；爆开图停 3 tick；ending 阶段仍然可以打。
   - 喜从天降：财神只在 110–530 之间活动，转折点落在 170/242/…/530；宝物类型分布；炸弹起预警频率是 30%；摆动公式；被炸后进入 ending；计分。
2. **golden**：每个游戏 10 组 `{seed, log}`，记录 `{score, endTick, hash}` 的快照。
3. **三端一致性**：用 `@vitest/browser-playwright` 在 Chromium、WebKit、Firefox 上跑同一批 golden，结果必须与 node 完全一致。
4. **fast-check 模糊测试**：随机生成合法日志，replay 不抛异常，分数落在 `[0, scoreSanityMax]`，`endTick ≤ maxTicks`；随机生成非法日志（乱序、越界、超密度），`validateLog` 必须拒绝。
5. **bot**：1000 个种子全部能在 maxTicks 内结束。平均分作为回归基线，不设硬阈值，偏离基线 ±30% 时告警。
6. **与 exe 核对**：`verify/exeFacts.test.ts` 读取提取出的 `exe-v311.json`/`exe-v206.json`，逐项对比 constants；文件不存在时 skip。

### 10.2 服务端（design_net unit/MinigameReferee 的补充）

伪造分数时以重放结果为准；实时流的前缀不一致时改用流里的日志；「未来」的 tick 被拒；中途断线用已收到的日志结算；从未开局到期走 decline；`startsAt` 之前提交 decline 允许，开局之后不允许；观战者收到的帧与玩家发出的一致。

### 10.3 AI

1. **规则单测**（使用固定 fixture 的 GameView）：
   - 买地保留额：PI 为 1 或 3，开局资金取 30 万或 1 万，覆盖边界相等的情况。
   - 个性闸门：统计检验 1/3 的概率。
   - 骰子策略：引信 14/15/21；前瞻 safe 与 hostile 的四种组合。
   - 银行：cashRatio×1.5/0.5，0.25 的带宽，贷款闸门，还款条件。
   - 商店：点券 460 买不到汽车、461 可以买。
   - 保释的三种风格；魔法屋；乐透；拍卖心理价位；30 张卡和 13 种道具各至少一正一反两个 fixture。
2. **合法性模糊测试（fast-check）**：用随机策略把对局推进 0–3000 步，得到随机状态，在每个待决策上调用 OriginalAiPolicy。断言：intent 能通过 `PlayerIntentSchema` 和 `allowedIntents`；`engine.applyAction` 不抛 `EngineRuleError`（要求 100%，出现一次就修）；单次 decide 耗时 p99 < 5ms；在 view 上访问 `secret` 时 Proxy 抛错。
3. **自对弈**（`packages/shared/src/ai/testing/selfplay.ts`，纯函数驱动，不依赖服务器）：
   ```ts
   runSelfPlay({ seed, map: 'taiwan', settings, seats: 4 AI（随机角色和预设）, maxActions: 400_000 })
     → { result, days, actions, finalHash, journalHash, rejects, fallbacks }
   ```
   - PR CI 跑 20 局。每晚跑 1000 局（`apps/server/scripts/simulate.ts`，用 worker_threads 8 并发，估计 5 分钟以内）。
   - 设置组合：游戏时间 1 年或 2 年（必须全部结束）；胜利条件 10 倍；另有一组「无限」对局，封顶 20 年，只统计结束率，低于 95% 时告警。
   - 断言：不抛异常；每局都有结果；**活性**（同一个 decisionId 不会被连续提交两次，连续 50 步状态哈希不变视为卡死）；`rejects == 0`；**确定性**（同一种子跑两遍，`finalHash` 和 `journalHash` 相同）；每步检查引擎不变量（由引擎领域提供）。
   - 统计快照：各性格胜率、平均破产天数、平均用卡数，作为回归基线（±20% 告警）。
4. **golden 行为回归**：固定 20 个种子的 action 日志作为快照。AI 行为有意变更时用 `--update` 刷新，并在 PR 里说明。

---

## 11. 需要从用户正版文件核实的项

准备：用户把 v2.06 和 v3.11 的 `rich4.exe`、`Panel.mkf` 拷到 gitignore 的 `.original/{v206,v311}/`。

- 数据表：用提取脚本 `tools/extract/exeFacts.py`（python3.14，只用 struct：解析 PE 节表，把 VA 换算成文件偏移）逐项读出，**只输出数值 JSON**。
- 代码分支：用 `r2 -q -c 'pd N @ VA' rich4.exe` 人工确认。
- v2.06 的地址不同：先用 v3.11 表的字节序列做 `/x` 搜索定位（数据表的字节序列通常不变），再核对值是否一致；代码分支用附近的立即数签名（例如 `c7 05 ?? ?? ?? ?? 96 00 00 00`）定位。

| # | 项 | v3.11 位置 | 期望 / 当前采用 | 核实方式 |
|---|---|---|---|---|
| M1 | 真人（who_plays==1）才进小游戏，其余走不玩分支 | 0x41560d / 0x415614 | 1 = 真人 | `pd 8 @ 0x415606` |
| M2 | 不玩分支 `50+rand%20` 以及第二次 `rand&1` | 0x415457..0x4154bb | 如上 | `pd 30 @ 0x415457` |
| M3 | 企鹅件数模板 | 0x411fc8 | 3,12,3,9,1（dword） | `pxw 20 @ 0x411fc8`；v2.06 搜 `/x 030000000c000000030000000900000001000000` |
| M4 | 企鹅格表（有效掩码与格心） | 0x474d7c，81×8 字节 | 3.1 的公式和掩码 | 脚本导出后与公式逐格对比 |
| M5 | 企鹅起点 (2,6)；intro 10 / 游玩 150 / 100ms | 0x4148a2 / 0x4148ab / 0x4148b1 / 0x4148d9 | 如上 | `pd 20 @ 0x4148a0` |
| M6 | 企鹅 DDA 的取整方式和轴停规则 | 0x41211c / 0x412287 / 0x4123aa | round = (fx+0x8000)>>16 | `pdf @ 0x41211c`、`pdf @ 0x412287` |
| M7 | 企鹅揭晓动画期间点击是否被吞；炸弹动画长度 | 0x414abe / 0x412b90 | 不吞（按 remake 读法） | `pd 20 @ 0x414aa9` |
| M8 | 气球速度表 | 0x475004，12 字节 | 0f 0f 0f 0f 12 12 12 18 18 18 18 12 | `px 12 @ 0x475004` |
| M9 | 气球特殊表 | 0x475039，10 字节 | 09 09 0a 0a 0a 0a 0a 0b 0b 0b | `px 10 @ 0x475039` |
| M10 | 气球逐槽生成；无可用跑道时是否仍掷 rand | 0x412f6f..0x413230 | 逐槽；不掷 | `pd 120 @ 0x412fd0` |
| M11 | 气球命中框；一次点击打爆多个；遍历顺序 | 0x414dec..0x414f2b | ±22×30 / ±18×26；全部命中；按槽升序 | `pd 80 @ 0x414dd2` |
| M12 | 999 夹子只在加数字那一支 | 0x414ed6..0x414ef3 | 是 | `pd 16 @ 0x414ec0` |
| M13 | 气球精灵高度和锚点（出屏判据） | Panel.mkf #91 头部 | 141/30、116/26、122/40 | 提取脚本只读 SPR 头的宽、高、x、y，不读像素 |
| M14 | 喜从天降落速表 | 0x475010，5 字节 | 18 12 0f 0c 0f | `px 5 @ 0x475010` |
| M15 | 炸弹预警概率 30% | 0x41378d..0x413794 | `test eax,eax; jne 跳过` | `pd 6 @ 0x41378d`（A 级，复核即可） |
| M16 | **静止时能否接住**；接物矩形来源 | 0x413743 附近 | 暂按「只有移动中能接」 | `pd 60 @ 0x413700` |
| M17 | 世界更新的顺序（接物者 / 掉落物 / 预警 / 财神） | 0x413248 | 如 5.2 所写 | `pdf @ 0x413248` |
| M18 | 财神状态机和两个转折点 | 0x413234 表、0x413886..0x413a22 | 如 5.1 所写 | `pxw 20 @ 0x413234` 再 `pd` |
| M19 | 宝物种类对应的名称和图标 | Panel #0x50、#0x5f..0x63 | 推断的名称 | 用户在原版里截图对照即可，不提取任何图像 |
| M20 | v2.06 与 v3.11 小游戏逻辑是否相同 | v2.06 exe | 未知 | 按 M3、M8、M9、M14 的字节序列在 v2.06 中搜索，并对比计时立即数 |
| M21 | 「動畫過程」配置闸门和梦游闸门 | 0x41561a / 0x497159、0x419873 | 如 2.1 所写 | `pd 8 @ 0x41561a` |
| A1 | 角色 AI 特质（个性、借贷、现金、炒股、能力位） | 角色表 0x47e80c | 8.3 的表 | 导出后与表逐项对比 |
| A2 | 卡片和道具的 f7、价格、权重 | 0x47fdea+i×8、0x47fee0 | r_references §2.1 的表 | 导出后对比；v2.06 用前 8 条记录的字节模式定位 |
| A3 | 个性闸门、用卡道具硬币、候选 8/4、跳过时光机 | 0x41e69e / 0x418e18 / 0x441d45 / 0x447fda | 如 8.1、8.2 所写 | `pd` |
| A4 | 买地保留额 0.05 与 7000 | 0x41d7d4、0x463cc8 | 如 9.7 所写 | `pd 30 @ 0x41d7d4`；`px 8 @ 0x463cc8` |
| A5 | 骰子策略 | 0x4221c0 | 如 9.4 所写 | `pdf @ 0x4221c0` |
| A6 | 银行 AI：贷款是赋值还是累加（是否要求贷款==0）、30000 是否乘 PI、还款条件 | 0x436668 / 0x436893..0x436906 | 要求贷款==0；不乘 PI | `pd 60 @ 0x436880` |
| A7 | 现金重分配常量 | 0x464c08..0x464c28 | 100、1.5、0.5、±0.25 | `px 40 @ 0x464c08` |
| A8 | 股票买卖打分常量 | 0x46419c..0x4641f8 | remake 已解 | `px 96 @ 0x46419c` |
| A9 | 商店 AI 与道具购买顺序表 | 0x42ed8d.. 与 0x4755f0 | `07 01 06 00 03 02` | `px 6 @ 0x4755f0` |
| A10 | 保释、魔法屋、乐透、拍卖、公布栏的 AI 分支 | 0x43d3d8 / 0x43381b / 0x43169e / 0x439f0d / 0x42886e | 如 9.7 所写 | `pd` |
| A11 | 视野投影表（规范视角 0） | 0x46ccf0 表、0x474910 矩阵 | 未取 | 导出为 JSON，供 `shared/geom/viewWindow.ts` 使用 |
| A12 | 特別融資 AI、公布栏重新定价规则 | 0x436b0a、0x428a37 以后 | 未解，v1 不实现 | `pdf` |
| A13 | 核子飞弹 AI 阈值（疑似读到栈上残留值） | 0x421e62..0x4221bf | B 级 | `pdf`，必要时做差分对比 |

---

## 12. 实施顺序

1. **MG1**：shared 下的三个 sim、replay、validate、golden、bot，以及三端一致性测试。
2. **AI1**：types、traits、rng、AiView（视野先用节点坐标近似，A11 核实后替换成原版投影）、policy 分派（先全部返回 defaultIntent）、selfplay 骨架，并接上 stubEngine 验证活性。
3. **AI2**：落点和经济类决策（买地、盖房、设施、银行、ATM、商店、乐透、保释、魔法屋、被动卡、手牌满、认购、建设、研究、小游戏）。
4. **MG2**：引擎的 MINIGAME 决策和 skip 结算；服务器的 Referee、实时流、断线结算。
5. **AI3**：PRE_ROLL 的硬币、30 张卡、13 种道具、骰子策略。
6. **MG3**：客户端 Host、三个游戏的 View 和 Input、观战、移动端适配。
7. **AI4**：股票买卖、公布栏、拍卖；房间预设和托管对话框；夜间 1000 局自对弈。
8. **V**：跑 §11 的提取和对照，把结论回写到 constants 和 golden。

---

## 13. 关键文件

- <repo>/packages/shared/src/minigames/types.ts
- <repo>/packages/shared/src/minigames/{penguin,balloon,xicong}/sim.ts
- <repo>/packages/shared/src/minigames/replay.ts（附 validate.ts）
- <repo>/packages/shared/src/ai/policy.ts（附 types.ts、traits.ts、view.ts、cards.ts、tools.ts、decisions/*）
- <repo>/packages/shared/src/ai/testing/selfplay.ts
- <repo>/apps/server/src/game/MinigameReferee.ts 与 AiDriver.ts
- <repo>/apps/client/src/minigames/host/MiniGameHost.ts
- <repo>/tools/extract/exeFacts.py


## key_decisions
- 小游戏的逻辑 tick 直接取原版定时器周期：企鹅和气球 100ms，喜从天降 50ms。不采用 60Hz，也不采用 30Hz；渲染按显示器刷新率插值 — 原版常量都是「每个定时器周期多少像素」的整数，随机数又是每 tick 每槽掷一次。按原周期运行，数值和概率分布都能逐位还原，不用引入定点小数改写，重放步数也最少（不超过 420 步）
- 气球的点击按「最近 tick」归属：插值系数 α<0.5 时记到 t−1，客户端本地回滚一步重算 — 插值渲染会让画面落后于逻辑位置。最快的气球（×2 状态下 48px/tick）会让偏差超过命中框。按最近 tick 归属后，偏差不超过 24px，小于最小半高 26px，点在看到的气球中心必定命中，确定性也不受影响
- 小游戏统一使用原版 640×480 整数舞台坐标，并采用原版的命中框、速度、跑道等像素常量 — 命中判定和出屏判定直接依赖像素值。改用 960×540 就要全部换算，会带来取整偏差
- sim 内部使用 Watcom LCG（15 位输出）作为自己的随机数，种子由服务器从 secret.rng 派生 — 这样 rand()%N 的分布与原版完全一致（例如 %1000、%20 在 32768 上的微小偏差也一样），而且只用 Math.imul，在 V8、JavaScriptCore、SpiderMonkey 三个引擎上结果逐位相同
- 电脑、托管、動畫過程关闭、玩家主动跳过，都走原版的不玩分支：50+rand%20，再加一次 rand&1 选台词，共 2 次随机数消耗 — 这是原版对电脑和托管玩家的实际行为（A 级证据）。让真人也能主动跳过，只是把原版的全局开关细化到个人，结果与原版可达的结果相同
- 已开局后掉线或超时的小游戏，用已经实时上传的输入日志重放到结束来结算；从未开局的，走不玩分支 — 防止玩家「玩坏了就断线」换取 50–69 点券；实时输入流本来就要做，用于观战直播
- 点券饱和到 65535，不照原版 uint16 回绕 — 回绕属于原版溢出 bug，在联机环境里会造成明显的不公平。这是有意偏差，已登记
- 电脑每回合按硬币 rand&1 在「用卡」和「用道具」之间二选一，二者互斥 — 0x418e18 有指令级证据，据此裁决 critique 中「每回合 1 卡 + 1 道具」的冲突
- AiPolicy 是纯同步函数，只读取投影后的公平视图和本座位的 DecisionForYou；AI 的随机数按 (aiSeed, 座位, decisionId 或 turnIndex+salt) 派生 — 不接触 secret，保证公平。随机数是派生出来的，不需要持久化 AI 的 RNG 状态，重启后能复现，同一回合里多次决策的结果也稳定
- PRE_ROLL 按原版顺序推进：买股、卖股、公布栏挂牌、公布栏购买、卡或道具、掷骰。当前进行到哪一步由引擎提供的 turnLog 推算 — 策略本身不需要保存内部状态，也避免已经跳过的步骤因为状态变化被重新触发，偏离原版顺序
- 引擎为电脑和真人统一创建决策，AI 的随机选择（例如设施类型 rng%4+1、乐透号码）都在 AI 侧完成 — 引擎不需要区分控制者，只有开局资金分配和商店货架两处例外。托管、超时代决、纯电脑三种情况走同一条路径
- 难度只做性格预设：按角色（原版）/ 乖宝宝 / 普通人 / 大老奸，只覆盖 personality，不改任何阈值 — 原版没有难度选项，强弱差异来自个性闸门和保释风格。保持原版 AI，将来如果要做专家 AI，就另写一个 AiPolicy 并存
- 托管设置沿用原版「託管AI」对话框的字段（个性、使用卡片、使用道具、现金↔存款比例、股票↔资金比例），通过系统 action SET_AI_TRAITS 写入 state — 与原版把设置拷进玩家结构的做法一致，存档和重放都能保留
- AI 的视野固定使用规范视角 0 的原版投影方窗（±220 像素） — 联机时每个客户端的视角不同，而原版 AI 的候选顺序依赖视角。固定为视角 0 才能保证确定性

## contracts
- 引擎：落在 kind 6/7/8 格上时，除非处于梦游闸门或房间设置 minigameMode='skip'，否则创建 MINIGAME 决策，种子只存放在 state.secret.minigame[decisionId]
- 引擎：MINIGAME 决策允许客户端或 AI 提交 minigameDecline；MINIGAME_RESULT{score,sessionId,logHash} 只能由服务器提交
- 引擎：不玩分支结算恰好消耗 2 次 rand15：score=50+r%20，台词槽=r&1；点券饱和在 65535
- 引擎：MINIGAME_ENDED 事件携带 mode、score、couponsAfter 这些后置绝对值；MINIGAME_STARTED 在 minigameSpectate='live' 时携带观战票据
- shared：MinigameId 统一为 'penguin'|'balloon'|'xicong'，服务端、客户端、引擎三处共用 packages/shared/src/minigames 里的同一个 sim
- 网络：MinigameTicket 用 tickMs(50|100)、introTicks、maxTicks、deadlineAt 取代 tickHz:60
- 网络：新增 C2S game:minigameInput{sessionId,seq,events} 和 S2C game:minigameFrames；最终提交的日志必须以已上传的流为前缀
- 服务端：MinigameReferee 用 spec.tickMs、maxInputsPerSecond 做校验，一律以服务器重放结果为准；已开局的会话在超时时用已上传的日志结算，未开局的按 decline 结算
- 客户端：小游戏舞台为 640×480 整数坐标，按 spec.tickMs 固定步长驱动；气球启用最近 tick 归属
- 客户端：删除 miniGamePick 和 chooseDirection 两类决策对话框
- 引擎：PRE_ROLL.options 提供 turnLog，即本座位本回合已做的自由操作（stockBuy/stockSell/boardList/boardBuy/card/tool），按发生顺序排列
- 引擎：ROLL intent 带 dice 参数，由引擎校验不超过当前交通工具允许的骰子数
- 视图：GameView 暴露 AI 所需的公开数据，包括敌意矩阵、144 日收盘价、企业财务、玩家财运和福运、身背炸弹的引信、各阻碍计数、上一格节点、实体锚点坐标、全局道具库存、牌堆剩余张数（不含顺序）
- 引擎：players[i].controller 取值 'human'|'ai'，players[i].aiTraits 持久化在 state 中，由服务器产生的系统 action SET_AI_TRAITS 修改
- 引擎：createGame 时生成 state.secret.aiSeed（uint32），只允许 AiDriver 读取
- 引擎：controller='ai' 座位的 SHOP 决策暴露整副牌堆的剩余张数，真人座位暴露货架
- shared：inViewWindow(center, point) 使用规范视角 0 的 ±220 像素半开区间，AI 判断视野和卡片道具判断目标合法性都用这一个函数
- AI：AiPolicy.decide 是纯同步函数，返回的 intent 必须能通过 PlayerIntentSchema 和 allowedIntents(kind)，并且用 options 预先校验过合法性
- 服务端：AiDriver 用 state 中的 aiTraits 和派生出的随机数构造 AiContext；decide 抛异常或 intent 非法时退回 defaultIntent，并统计 ai_rejects 指标
- 网络：room:setSeatAi 的参数改为 SeatAiConfig{preset,overrides?}；game:autopilot 增加可选的 TrusteeSettings
- 计时：MINIGAME 决策的截止时间 = startsAt + maxTicks×tickMs + 5000 毫秒；design_net 的 CHOOSE_PATH 超时条目删除

## risks
- 多处小游戏细节只有单一来源的反汇编读法（企鹅 DDA 的取整方式、喜从天降静止时能否接住、世界更新顺序、气球无可用跑道时是否消耗随机数），核实前的实现可能偏离原版。缓解：在常量中标注 VERIFY，用 §11 的脚本加 r2 核对，并在 golden 中固定当前选择
- 所有数值都来自 v3.11 合版；原版 v2.06 的小游戏和 AI 参数是否相同还没有证据。缓解：用 M20、A2 的字节签名搜索做对比，必要时启用 params.ruleset='exe206'
- 观战直播会把种子下发给观察者，懂技术的围观者可以从种子解出企鹅的埋藏布局，再场外告诉玩家。当事玩家本人本来就拿得到种子。奖励只是点券，影响有限；比赛房间可以把 minigameSpectate 设为 replay。后续可选的加固方案：企鹅改由服务器揭晓
- 懂技术的玩家可以在本地拿种子预演，算出最优点击再按真实节奏提交（相当于自瞄），服务器重放无法分辨。输入频率上限和不允许来自未来的 tick 只能限制，不能杜绝
- AI 的规则量很大（30 张卡、13 种道具、股票打分、商店、拍卖），而且依赖 GameView 暴露大量公开字段。视图契约遗漏字段会导致 AI 规则退化。缓解：用 AiView 适配层集中访问，并用 fixture 单测覆盖每一张卡和每一种道具
- AI 只要提交一次被引擎拒绝的 intent，就可能卡死（活锁）。缓解：提交前用 options 校验、非法时退回 defaultIntent、模糊测试要求 100% 合法、自对弈中加入活性检测
- 原版 AI 的随机数走全局序列，这里改为 AI 自己派生，只能还原分布，无法与原版逐位对拍；原版 qsort 不稳定，这里取稳定排序，也是有意偏差
- 事实数据引用自 GPL 仓库的反汇编注释。实现时必须以本文件的规格和 VA 为依据独立编写，不能复制 remake 的代码，以免 GPL 传染
- 超时代决沿用托管 AI 时，电脑可能替真人按角色的借贷比例大额借款或使用卡片，与玩家预期不符。缓解：提供房间选项 aiTimeoutPolicy='conservative'

## open_questions
- 喜从天降：接物者静止时能否接住（remake 读法是只有移动中能接）？需要按 M16 在 v3.11 的 0x413743 附近核实，同时在 v2.06 上复核
- 企鹅挖宝：揭晓动画期间点击是否会被吞掉？DDA 的取整和轴停规则是否与 3.3 一致？（M6、M7）
- v2.06 原版与 v3.11 合版的小游戏参数（计时、概率、分值）以及 AI 表是否完全一致？
- 两个小游戏的宝物名称和图标对应关系：钻石、红宝石、蓝宝石、金币；宝箱、钱袋、元宝、金币。需要用户用原版截图确认
- 是否允许真人在小游戏倒计时阶段主动「跳过」领 50–69 点券？原版只有全局的「動畫過程」开关。本设计默认允许，可以在房间设置里关闭
- 观战默认实时直播并公开种子，还是默认结算后回放？本设计默认 live
- 私密手牌模式下，AI 的抢夺卡和梦游/陷害卡判据要降级（看不到对方手牌），是否可以接受？
- 原版电脑是否会使用特別融資（0x436b0a）？公布栏「1/3 重新定价」的具体规则是什么？这两项 v1 都不实现
- 房间的电脑性格预设在 UI 上用「简单/普通/困难」还是直接写性格名？是否需要开放五个特质的高级自定义？
- 单次决策超时的代决，默认用托管 AI（原版风格，可能替玩家借款或用卡），还是默认保守的 defaultIntent？
- 是否要做非原版的「电脑亲自玩小游戏」房间选项（用 bot 实时演示给观众看）？本设计默认关闭，留到 v2