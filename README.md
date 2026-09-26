# rich4 · 大富翁4 网页联机复刻

在浏览器里还原《大富翁4》（大宇资讯，1998）的 4 人联机对局：服务器权威的确定性规则引擎、可断线重连与 AI 托管、存档读档、聊天与观战，电脑优先、手机横屏可玩。

- 规则基准是原版程序的实际行为（逆向资料以 v3.11 为主，用 v2.06 核实）；与说明书冲突的几项做成房间可选的 MANUAL 预设。
- 全部自研，不复用 GPL 代码；美术和音频自制，程序化 SVG/Pixi 绘制。
- 首张地图是原版台湾图，数据由构建期脚本从**用户自己的正版文件**中提取，只输出 JSON，不入库、不分发原版素材。
- 有意与原版不同的地方见 [docs/DEVIATIONS.md](docs/DEVIATIONS.md)，待核实项见 [docs/VERIFY.md](docs/VERIFY.md)。

> 当前处于 M0（脚手架与测试地图）阶段，里程碑见 [docs/architecture.md §10](docs/architecture.md)。

## 目录结构

```
rich4/
├─ packages/shared/     @rich4/shared：纯 TS、零 IO、确定性（util、geom、data、engine、view、net、minigames、ai、save）
├─ apps/server/         @rich4/server：Fastify 5 + Socket.IO 4.8，房间、编排、持久化（node:sqlite）
├─ apps/client/         @rich4/client：Vite + React 19 + Pixi v8，等角棋盘与 HUD
├─ tools/extract/       @rich4/extract：构建期原版数据提取（private，任何 app 都不得依赖）
├─ scripts/             dev.mjs、fixture 生成与三个仓库守卫（check-determinism / check-no-original / check-deps）
├─ e2e/                 Playwright 端到端测试
├─ docs/                架构、领域设计、规则调研、偏差与核实清单
├─ test/                临时调试脚本（见 test/README.md）
├─ original/            【gitignore】用户正版文件，只读
├─ .cache/              【gitignore】提取中间产物
└─ rich4-data/          【gitignore】部署用数据包（manifest.json、maps/*.map.json）
```

分层依赖规则见 [docs/architecture.md §3](docs/architecture.md)，由 `npm run check:deps` 强制执行。

## 快速开始

需要 Node.js ≥ 24.9（`.nvmrc` 为 24，建议 24.21 LTS 或更高，`node:sqlite` 不再输出实验性警告）。

```bash
npm install        # 安装全部 workspace 依赖
npm run dev        # 并行启动服务端 :3000 与前端 :5173（输出带 [server]/[client] 前缀，Ctrl+C 一并结束）
npm test           # vitest：shared、server（stubEngine）、server-real（真实引擎跑集成测试）、client-unit、client-dom、extract、scripts；本机有 Playwright Chromium 时另加 client-browser
npm run check      # typecheck + lint + test + 三个守卫，提交前请跑一遍
```

没有原版文件也能完整开发：引擎、服务器、前端与 E2E 都使用 `packages/shared/src/data/maps/fixtures/` 下的手绘测试地图。

| 命令 | 作用 |
|---|---|
| `npm run dev:server` / `npm run dev:client` | 单独启动一端 |
| `npm run typecheck` | 各 workspace 执行 `tsc --noEmit`（`scripts/` 另用 `npx tsc -p scripts/tsconfig.json`） |
| `npm run lint` / `npm run format` | Biome 检查 / 格式化 |
| `npm run test:e2e` | Playwright 端到端测试 |
| `npm run fixtures` | 重新生成 fixture 地图 JSON（应与入库版本字节一致） |
| `npm run sim` | AI 自对弈模拟 |
| `npm run check:determinism` | 扫描 shared 的 util/geom/data/engine/minigames/ai，禁止 `Math.random`、`Date`、`performance`、`Intl`、超越函数、`Math.round`、`for…in` 等 |
| `npm run check:no-original` | 检查 git 将要纳入版本控制的文件，禁止原版文件（.mkf、RICH4.EXE、SAVE*.DAT、*.avi、*.mid 等）与派生数据入库 |
| `npm run check:deps` | 按分层表检查 import，禁止 apps/packages 依赖 `@rich4/extract` |

## 原版数据提取流程

台湾图等原版数据**只在你本机**从你拥有的正版文件中提取，产物永不入库、永不上传原版文件。

1. **拷贝正版文件**（只读）到 `original/`，保留 Steam 安装目录的相对路径。在 Steam 库中右键游戏，选「管理 → 浏览本地文件」即可找到根目录；可以用 SMB 只读共享、scp 或 exFAT U 盘传输。
   ```
   original/
   ├─ Game/RICH4.EXE  Game/map.mkf  Game/MapDat.mkf     # MapDat 原名可能是 MAPDAT.MKF，存在就必须拷
   └─ MultiverseJourney/RICH4.EXE  MultiverseJourney/map.mkf  [MultiverseJourney/Data.mkf，可选]
   ```
   不要拷：`Speaking/Panel/jump/Effect/help` 等素材 mkf、`Media/`、`DxWnd/`、`*.avi`、`*.mid`、`SAVE*.DAT`。
2. **核对指纹**：`npm run extract -- fingerprint`。哈希未知时工具以退出码 3 结束，确认无误后可加 `--allow-unknown` 继续。
3. **提取并打包**：
   ```bash
   npm run extract -- all
   npm run extract -- pack --out rich4-data/
   ```
   中间产物写到 `.cache/extract/`（含预览 `preview/taiwan.svg`），部署数据包写到 `rich4-data/`。两者都已 gitignore，`npm run check:no-original` 会拦截任何误入库。
4. **使用台湾图**：`RICH4_DATA_DIR=./rich4-data npm run dev`。缺少数据包时服务器只提供 fixture 地图并告警。

工具只读访问 `original/`，任何写入其下的操作都会直接报错。详细步骤见 [docs/design/data-pipeline.md](docs/design/data-pipeline.md)。

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 总体架构与实施方案（上位文档，冲突时以它为准） |
| [docs/design/engine.md](docs/design/engine.md) | 规则引擎：帧栈解释器、GameState、决策、效果系统 |
| [docs/design/data-pipeline.md](docs/design/data-pipeline.md) | 原版数据提取管线、MapDef 契约、仓库卫生 |
| [docs/design/minigames-ai.md](docs/design/minigames-ai.md) | 三个小游戏的确定性 sim 与电脑 AI |
| [docs/design/net.md](docs/design/net.md) | 服务端、Socket.IO 协议、持久化与部署 |
| [docs/design/client.md](docs/design/client.md) | 前端渲染、交互与演出 |
| [docs/DEVIATIONS.md](docs/DEVIATIONS.md) | 有意偏差清单（DEV-01…DEV-12） |
| [docs/VERIFY.md](docs/VERIFY.md) | 需要从正版文件或实机核实的项及结论 |
| [docs/research/](docs/research/) | 规则调研原文与出处 |

## 法律说明

- 本仓库**不包含**任何原版游戏素材：没有图像、音频、视频、可执行文件、MKF 资源或存档。美术和音频均为自制或许可明确的素材。
- 原版文件（`original/`）与从中提取的派生数据（`.cache/`、`rich4-data/`）**永不入库，也永不上传**到服务器或镜像；Docker 构建上下文同样排除它们（见 `.dockerignore`）。部署时只同步本机生成的 `rich4-data/`。
- 规则数值依据说明书与公开逆向资料重新录入，并以 `@source` 标注出处。
- 「大富翁」及原作角色名等权利归原权利人所有。本项目为非官方的学习与致敬作品；角色名可通过 `VITE_NAMESET=alt` 一键替换。对外公开部署前请自行评估地图事实数据分发与商标相关的风险（见 [docs/architecture.md](docs/architecture.md) 的 remaining_risks）。
