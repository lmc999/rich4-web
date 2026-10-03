# rich4 · 大富翁4 网页联机复刻

在浏览器里还原《大富翁4》（大宇资讯，1998）的 4 人联机对局：服务器权威的确定性规则引擎，规则以原版程序的实际行为为准；支持断线重连与电脑托管、存档读档、聊天与观战。电脑优先，手机横屏可玩。

**试玩地址：<https://rich4.on99.party>**

1. **获取口令**：先加入 Telegram 群 [@gameaccelerate](https://t.me/gameaccelerate)，然后私聊 [@richman4_bot](https://t.me/richman4_bot) 发送 `/code`，即可拿到 24 小时有效的口令（同一口令最多在 3 台设备登录）。
2. **进入游戏**：打开试玩地址，在门禁页输入口令（繁体界面里叫「通關密語」）。用电脑浏览器或手机横屏都可以，不用安装任何东西。
3. **邀请朋友**：拿到口令的人建好房间后，可以邀请最多 3 位朋友，朋友凭邀请链接直接进入对局，不需要口令。每个链接限一人使用、30 分钟内有效，受邀者只能进入邀请他的那个房间。

## 功能

- **四张原版地图**：台湾、大陆、日本、美国。地图数据由构建期脚本从**自己的正版文件**中提取。
- **对局**：1–4 名真人联机，空位由电脑补上；也可以单机或人机对战，支持观战、聊天与表情。
- **规则**：按原版程序行为还原（以 v2.06 为准，电脑 AI 以 v3.11 为基线），包括卡片、道具、神明、新闻与命运、魔法屋、股市、银行、拍卖、时光机等；与说明书写法冲突的几项做成房间可选的「说明书」预设。
- **三个小游戏**：企鹅挖宝、七彩气球、喜从天降。服务器下发种子，回放玩家的输入来计分，可以防作弊。
- **两套画面**：
  - **原版皮肤**：原版 640×480 布局与演出，素材从正版文件提取，只在开启访问门禁时提供。
  - **程序化皮肤**：自绘美术，没有素材包时自动使用。
- **联机体验**：
  - 断线后（默认 15 秒）由电脑托管，重新打开网页即可接回；决策有倒计时，只有一名真人时不计时；房间可选「原版 / 紧凑」两种演出节奏。
  - 两名以上真人时，别人看不到你的手牌和道具。
- **访问门禁**：共享口令、限时邀请码（到期或停用即失效）、单次房间邀请链接（受邀者只能进那个房间）。
- **部署**：Docker 镜像 + Caddy 自动 HTTPS，可以另经 Cloudflare Tunnel 再接一个域名。

有意与原版不同的地方见 [docs/DEVIATIONS.md](docs/DEVIATIONS.md)，待核实项见 [docs/VERIFY.md](docs/VERIFY.md)，后续计划（例如资料片「超时空之旅」的地图）见 [docs/TODO.md](docs/TODO.md)。

## 怎么开一局联机

1. 打开试玩地址，输入口令。进入后会先播片头，点一下可以跳过。
2. 在标题画面选「开始游戏」进入开局设置：
   - **关卡**：选地图。
   - **对局设置**：总资金、游戏时间、胜利条件等。
   - **联机设置**：电脑人数、决策计时、演出节奏、是否允许观战。

   设好后点「确定」创建房间。
3. 在选人画面点「邀请朋友」，复制链接发给朋友。每复制一次就是一条新链接，邀请几个人就复制几次；一局最多 4 人，所以最多邀请 3 位朋友。已经有口令的朋友，也可以在标题画面选「加入房间」，输入房间号。
4. 每人选好角色、点「准备」，房主点「开始游戏」。

想自己练手，在标题画面选「单机对战」即可。

## 目录结构

```
rich4/
├─ packages/shared/     @rich4/shared：纯 TS、零 IO、确定性（util、geom、data、engine、view、net、minigames、ai、save）
├─ apps/server/         @rich4/server：Fastify 5 + Socket.IO 4.8，房间、编排、访问门禁、持久化（node:sqlite）
├─ apps/client/         @rich4/client：Vite + React 19 + Pixi v8，原版皮肤与程序化皮肤
├─ tools/extract/       @rich4/extract：构建期原版数据与素材提取（private，任何 app 都不得依赖）
├─ scripts/             dev.mjs、fixture 生成、仓库守卫（check-determinism / check-no-original / check-deps / check:zh-tw）
├─ e2e/                 Playwright 端到端测试（默认配置与原版皮肤配置）
├─ deploy/              Dockerfile、compose、Caddyfile、隧道叠加文件、镜像泄漏扫描
├─ docs/                架构、领域设计、部署、规则调研、偏差与核实清单
├─ test/                临时调试脚本（见 test/README.md）
├─ original/            【gitignore】自己的正版文件，只读
├─ .cache/              【gitignore】提取中间产物
├─ rich4-data/          【gitignore】地图数据包（manifest.json、maps/*.map.json）
└─ rich4-assets/        【gitignore】原版皮肤素材包
```

分层依赖规则见 [docs/architecture.md §3](docs/architecture.md)，由 `npm run check:deps` 强制执行。

## 本机开发

需要 Node.js ≥ 24.9（`.nvmrc` 为 24，建议 24.21 LTS 或更高，`node:sqlite` 不再输出实验性警告）。

```bash
npm install        # 安装全部 workspace 依赖
npm run dev        # 并行启动服务端 :3000 与前端 :5173（输出带 [server]/[client] 前缀，Ctrl+C 一并结束）
npm test           # vitest：shared、server、server-real、client-unit、client-dom、extract、scripts；本机有 Playwright Chromium 时另加 client-browser
npm run check      # typecheck + lint + test + 各项守卫，提交前请跑一遍
```

没有原版文件也能完整开发：引擎、服务器、前端与 E2E 都可以使用 `packages/shared/src/data/maps/fixtures/` 下的手绘测试地图，原版皮肤的渲染路径另有合成素材包覆盖。

| 命令 | 作用 |
|---|---|
| `npm run dev:server` / `npm run dev:client` | 单独启动一端 |
| `npm run typecheck` | 各 workspace 执行 `tsc --noEmit`（`scripts/` 另用 `npx tsc -p scripts/tsconfig.json`） |
| `npm run lint` / `npm run format` | Biome 检查 / 格式化 |
| `npm run test:e2e` | Playwright 端到端测试（原版皮肤配置：`npx playwright test -c e2e/playwright.original.config.ts`） |
| `npm run fixtures` | 重新生成 fixture 地图 JSON（应与入库版本字节一致） |
| `npm run sim` | 电脑自对弈模拟（例如 `npm run sim -- --engine-only --map taiwan --data-dir rich4-data --games 500 --policy original`） |
| `npm run check:determinism` | 扫描 shared 的 util/geom/data/engine/minigames/ai，禁止 `Math.random`、`Date`、`performance`、`Intl`、超越函数、`Math.round`、`for…in` 等 |
| `npm run check:no-original` | 检查 git 将要纳入版本控制的文件，禁止原版文件（.mkf、RICH4.EXE、SAVE*.DAT、*.avi、*.mid 等）与派生数据入库 |
| `npm run check:deps` | 按分层表检查 import，禁止 apps/packages 依赖 `@rich4/extract` |

## 原版数据与素材提取

地图数据和原版皮肤素材**只在你本机**从你拥有的正版文件中提取，产物永不入库，原版文件也永不上传。

1. **拷贝正版文件**（只读）到 `original/`，保留 Steam 安装目录的相对路径。在 Steam 库中右键游戏，选「管理 → 浏览本地文件」即可找到根目录。
   ```
   original/
   ├─ Game/                       # 整个目录：rich4.exe、map.mkf、MapDat.MKF，以及原版皮肤要用的 Panel、Speaking、Effect、Data、jump、help 等 .mkf
   ├─ MultiverseJourney/rich4.exe  MultiverseJourney/map.mkf
   └─ Media/*.avi                 # 可选：片头与开局飞行动画
   ```
   不要拷 `SAVE*.DAT` 与 `DxWnd/`。
2. **核对指纹**：`npm run extract -- fingerprint`。哈希未知时工具以退出码 3 结束，确认无误后可加 `--allow-unknown` 继续。
3. **提取地图数据**：
   ```bash
   npm run extract -- all                      # map raw → map diff → exe tables → 四张图 map build（台湾、大陆、日本、美国）
   npm run extract -- pack --out rich4-data/   # 打包最近一次构建成功的图，与已有 manifest 合并
   ```
4. **提取原版皮肤素材**（可选）：
   ```bash
   npm run extract -- assets build --out rich4-assets/ --video --strict   # 不带 --video 就没有片头与飞行动画
   npm run extract -- assets verify --out rich4-assets/ --full
   ```
5. **使用**：`npm run dev`。不设 `RICH4_DATA_DIR` 时，服务器会自动找仓库根目录的 `rich4-data/`。缺少数据包时，服务器只提供 fixture 地图并告警。原版皮肤素材包只在开启访问门禁（`ACCESS_MODE=passcode` 或 `invite`）时启用。

中间产物写到 `.cache/extract/`（含预览 `preview/<key>.svg`）。工具只读访问 `original/`，任何写入其下的操作都会直接报错。详细步骤见 [docs/design/data-pipeline.md](docs/design/data-pipeline.md) 与 [docs/design/original-skin.md](docs/design/original-skin.md)。

## 部署

用 Docker Compose 部署（app + Caddy 自动 HTTPS），镜像里不含任何原版派生文件；地图数据包与素材包在部署时用 rsync 上传，并以只读方式挂载。生成密钥与口令、填写 `deploy/.env`、交叉构建、上线检查、邀请与吊销、备份升级、Cloudflare Tunnel 第二域名等，全部步骤见 [docs/deploy.md](docs/deploy.md)。

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 总体架构、实施方案与历次修复记录（上位文档，冲突时以它为准） |
| [docs/design/engine.md](docs/design/engine.md) | 规则引擎：帧栈解释器、GameState、决策、效果系统 |
| [docs/design/data-pipeline.md](docs/design/data-pipeline.md) | 原版数据提取管线、MapDef 契约、仓库卫生 |
| [docs/design/original-skin.md](docs/design/original-skin.md) | 原版皮肤：素材包、布局、演出与访问门禁 |
| [docs/design/minigames-ai.md](docs/design/minigames-ai.md) | 三个小游戏的确定性 sim 与电脑 AI |
| [docs/design/net.md](docs/design/net.md) | 服务端、Socket.IO 协议、持久化 |
| [docs/design/client.md](docs/design/client.md) | 前端渲染、交互与演出 |
| [docs/deploy.md](docs/deploy.md) | 部署与运维 |
| [docs/DEVIATIONS.md](docs/DEVIATIONS.md) | 有意偏差清单（DEV-01…DEV-36） |
| [docs/VERIFY.md](docs/VERIFY.md)、[docs/verify-checklist.md](docs/verify-checklist.md) | 需要从正版文件或实机核实的项、结论与核对步骤 |
| [docs/TODO.md](docs/TODO.md) | 待办与已知差异 |
| [docs/research/](docs/research/) | 规则调研原文与出处 |

## 法律说明

- 本仓库**不包含**任何原版游戏素材：没有图像、音频、视频、可执行文件、MKF 资源或存档。程序化皮肤的美术与音频均为自制或许可明确的素材。
- 原版文件（`original/`）与从中提取的派生数据（`.cache/`、`rich4-data/`、`rich4-assets/`）**永不入库**，也不会进入 Docker 镜像（见 `.dockerignore` 与 `deploy/scan-image.sh`）。部署时只同步本机生成的数据包与素材包。原版皮肤素材只在访问门禁之后提供，仅供私下游玩。
- 规则数值依据原版程序、说明书与公开逆向资料重新录入，并以 `@source` 标注出处。
- 「大富翁」及原作角色名等权利归原权利人所有。本项目为非官方的学习与致敬作品；角色名可通过 `VITE_NAMESET=alt` 一键替换。对外公开部署前，请自行评估素材、地图数据与商标相关的风险（见 [docs/architecture.md](docs/architecture.md) 的 remaining_risks）。
