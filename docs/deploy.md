# 部署到云主机（自托管）

本文面向自己把《大富翁4》网页版部署到一台云主机、和朋友一起玩的场景。部署形态是 Docker Compose：一个 `app` 容器（Node 服务器，同时托管前端、Socket.IO 与 HTTP 接口）加一个 `caddy` 容器（自动申请 HTTPS 证书并反向代理）。设计依据见 `docs/architecture.md` §9.3 与 M11，`docs/design/net.md` §8.5、§10，`docs/design/original-skin.md` U4。

```
浏览器 ──https/wss──▶ caddy（80、443、443/udp，自动证书）──http──▶ app:3000（compose 内网，不对外）
                                                                  ├─ /data          读写卷 rich4-state：sqlite、每日备份
                                                                  ├─ /data-rich4    只读：../rich4-data（原版地图数据）
                                                                  └─ /assets-rich4  只读：../rich4-assets（原版皮肤素材包，可选）
可选（§11）：浏览器 ──https/wss──▶ Cloudflare 边缘 ══隧道══ cloudflared ──http──▶ caddy:8081（compose 内网）──▶ app:3000
```

**镜像里没有任何原版文件或派生数据**（`.dockerignore`、Dockerfile 的构建期检查、`deploy/scan-image.sh` 三道关；后两道与仓库守卫 `check-no-original` 用同一套规则，由 `scripts/scan-tree.ts` 执行）。原版地图数据 `rich4-data/` 与原版皮肤素材包 `rich4-assets/` 只在运行时以只读卷挂进容器。**`original/`（正版安装文件）永远不上传到服务器。**

下文命令默认在服务器上的仓库根目录（例如 `/srv/rich4`）执行；标明「本机」的在你自己的电脑上执行。**`docker compose` 命令一律不写 `-f`**：用哪些 compose 文件由仓库根目录的 `.env` 里的 `COMPOSE_FILE` 决定（§2），这样 Caddy 模式与 nginx 模式（§10）的命令完全一样，不会因为漏写某个 `-f` 把部署改坏。

---

## 1. 前置条件

- **域名与 DNS**：一个域名（例如 `rich4.example.com`），A 记录指向主机的公网 IP；主机有公网 IPv6 时再加 AAAA 记录（compose 网络默认开启 IPv6，IPv6 访客的真实地址能传到服务器，见 §7.1）。证书由 Caddy 向 Let's Encrypt 自动申请，DNS 必须先生效。
- **主机**：Linux（x86_64 或 arm64），建议至少 1 vCPU、**2 GB 内存**、2 GB 空闲磁盘（素材包约 200 MB，镜像约 400 MB，构建缓存另占约 1 GB）。在服务器上构建镜像时，`npm run build`（vite + esbuild）单独就要约 1 GB 内存（本机实测限制 768 MB 时被 OOM kill，1.2 GB 时通过、峰值 1.08 GB），升级时旧的 app 与 caddy 还在跑。只有 1 GB 内存的主机：先加 2 GB swap（`sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`，再写进 `/etc/fstab`），或者在本机构建镜像再传上去（§6 的「在本机构建」）。运行时本机实测 200 个房间同时对局时 app 容器内存峰值约 480 MB、CPU 峰值约 0.4 个核。
- **Docker**：Docker Engine 27 及以上与 Compose v2（`docker compose version`）。27 起 compose 网络开启 IPv6 时自动分配子网、ip6tables 缺省开启；Dockerfile 用到 BuildKit 的 `RUN --mount` 与 `HEALTHCHECK --start-interval`。基础镜像只有 Docker Hub 官方的 `node:24-slim` 与 `caddy:2`（`scan-image.sh` 也在 `node:24-slim` 里运行扫描程序，服务器上不用装 Node）。
- **中国大陆的主机**：域名必须先完成 ICP 备案，否则 80/443 端口的网站访问会被运营商拦截，证书也签不下来。
- **防火墙 / 安全组**：放行 TCP 80（证书校验与跳转 HTTPS）、TCP 443、UDP 443（HTTP/3，可选）。SSH 端口建议只对自己的 IP 开放。app 的 3000 端口不需要、也不应该对外开放。
- **本机**：已经 clone 本仓库并 `npm ci`，按 architecture M9 生成了 `rich4-data/`（`npm run extract -- all && npm run extract -- pack --out rich4-data/`，含台湾、大陆、日本、美国四张图）；要用原版皮肤的话还有 `rich4-assets/`（`npm run extract -- assets build --out rich4-assets/ --video --strict`：不带 `--video` 就没有片头与开局飞行动画，步骤与核对见 §9.6）。

## 2. 取代码

服务器上（以部署用户身份，不要用 root）：

```sh
sudo mkdir -p /srv/rich4 && sudo chown "$USER" /srv/rich4
git clone <你的仓库地址> /srv/rich4
cd /srv/rich4
mkdir -p rich4-data rich4-assets
echo 'COMPOSE_FILE=deploy/docker-compose.yml' > .env
```

- **仓库没有远程地址时**（只在本机提交、没推到任何 git 服务），不用 `git clone`，在**本机**仓库根目录把已提交的文件打包传过去，再到服务器上执行上面除 `git clone` 之外的几行：

  ```sh
  ssh user@rich4.example.com 'sudo mkdir -p /srv/rich4 && sudo chown "$USER" /srv/rich4'
  git archive --format=tar HEAD | ssh user@rich4.example.com 'tar -x -C /srv/rich4'
  ```

  `git archive` 只打包已提交的文件：`original/`、`rich4-data/`、`rich4-assets/`、`.cache/`、`deploy/.env` 都被 `.gitignore` 排除，不会被带上去。之后升级（§9.4）把 `git pull` 换成重跑这条 `git archive`（服务器上已删除的文件不会同步删除，一般无碍）。
- `rich4-data/`、`rich4-assets/` 要**先以部署用户身份建好**（不用原版皮肤时 `rich4-assets/` 留空）。compose 把这两个只读挂载写成了 `create_host_path: false`：目录不存在时 `up` 直接报错 `bind source path does not exist`，而不是让 dockerd 以 root 身份建一个空目录——那样之后用普通用户 rsync 素材包会因权限被拒。
- 仓库根目录的 `.env` 只有一行 `COMPOSE_FILE=…`：compose 从当前目录的 `.env` 读 `COMPOSE_FILE`，端口、域名这些插值变量仍然从 `deploy/.env` 读（§5）。它已被 `.gitignore` 与 `.dockerignore` 排除。**命令里一旦显式写了 `-f`，`COMPOSE_FILE` 就不起作用**，所以下文命令都不写 `-f`；已经在用 nginx 的主机这里换成 §10 的写法。

## 3. 上传数据包（rsync）

在**本机**仓库根目录执行，只传 `rich4-data/` 与 `rich4-assets/` 两个目录（**不要**传仓库根目录、`original/` 或 `.cache/`）：

```sh
rsync -a --delete rich4-data/   user@rich4.example.com:/srv/rich4/rich4-data/
rsync -a --delete rich4-assets/ user@rich4.example.com:/srv/rich4/rich4-assets/
```

- 末尾的 `/` 不能少：表示「把目录里的内容同步到目标目录」。`--delete` 让服务器上的副本与本机完全一致（素材包重新构建后，旧的带哈希文件会被删掉）。
- 不用原版皮肤时只传 `rich4-data/`；服务器上的 `rich4-assets/`（§2 已建好的空目录）里没有 `manifest.json`，素材包不启用，前端用程序化美术。
- **权限**：容器里以 `node` 用户（uid 1000、gid 1000）运行，这两个目录要对它可读。macOS / 多数 Linux 的默认 umask 下同步过去的是 644 / 755（所有人可读），直接可用。想收紧成只有属组 1000 能读（每次 rsync 之后要重跑，`rsync -a` 会按本机的权限覆盖）：

  ```sh
  sudo chgrp -R 1000 rich4-data rich4-assets
  sudo chmod -R g+rX,o-rwx rich4-data rich4-assets
  ```

  起服后用 `docker compose exec app ls -l /data-rich4/manifest.json /assets-rich4/manifest.json` 核对容器里能看到。

## 4. 生成密钥与口令（在本机）

密钥与口令都在**本机**生成，服务器上只放随机密钥与口令的**哈希**（口令明文只告诉朋友，不写进任何文件）：

```sh
npx tsx scripts/access.ts secret     # 运行 3 次，分别作为 SAVE_HMAC_SECRET、ACCESS_SECRET、ADMIN_TOKEN
npx tsx scripts/access.ts hash       # 交互输入两次口令（不回显），输出 ACCESS_PASSCODE_HASH
```

- `secret` 输出 48 字节随机数的 base64url（64 个字符），满足「≥32 字节」的要求。
- `hash` 输出 `scrypt:<N>:<r>:<p>:<salt>:<hash>`；口令建议 12 个字以上（登录有按 IP 的退避限流，但弱口令仍可能被猜中）。也可以 `echo '口令' | npx tsx scripts/access.ts hash --stdin`，但口令会留在 shell 历史里。
- 这几个值不含 `$`，可以原样写进 `.env`（compose 会对 `.env` 里的 `$` 做变量插值）。不要加引号：§8、§9 的管理命令直接从 `deploy/.env` 读 `ADMIN_TOKEN`。

## 5. 填写 deploy/.env

服务器上：

```sh
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
```

然后编辑 `deploy/.env`（每一项的含义见文件里的注释），至少改这些：

```sh
SITE_ADDRESS=rich4.example.com
PUBLIC_URL=https://rich4.example.com
SAVE_HMAC_SECRET=<secret 输出之一>
ADMIN_TOKEN=<secret 输出之一>
# 用原版皮肤（挂了 rich4-assets）时必须开门禁，否则服务器拒绝启动
ACCESS_MODE=passcode
ACCESS_PASSCODE_HASH=<hash 的输出>
ACCESS_SECRET=<secret 输出之一>
```

- `HTTP_PORT=80`、`HTTPS_PORT=443`、`BIND_ADDR=`（留空）保持示例里的缺省值：证书签发与 HTTP→HTTPS 跳转都假定对外就是 80/443。
- `ENABLE_IPV6=true`、`CADDY_TRUSTED_PROXIES=`（留空）保持缺省，除非属于 §7.1 说的几种情况。
- **不要**设置 `RICH4_TEST_MODE`：它开放 `debug:act`（可以任意改写对局）。生产环境里服务器只在 `PUBLIC_URL` 为 localhost 时接受它，否则拒绝启动。
- `TRUST_PROXY=1` 已写在 `docker-compose.yml` 里（只信任 compose 内网的 Caddy 转来的 X-Forwarded-For），不用在 `.env` 里再写。
- `deploy/.env` 与它的副本（`.env.bak`、`prod.env` 之类）都已被 `.gitignore` 与 `.dockerignore` 排除，不会进 git，也不会进镜像。

## 6. 构建并启动

```sh
docker compose config --services     # 核对用的 compose 文件：Caddy 模式输出 app 与 caddy，nginx 模式（§10）只有 app
docker compose up -d --build --wait
bash deploy/scan-image.sh rich4:local
```

- 第一次构建要几分钟（`npm ci` 加前端与服务端构建，内存要求见 §1）。`--wait` 等 app 通过就绪检查（`/readyz`）、caddy 起来后才返回；Caddy 在 app 就绪之后才启动，对外不会先出现 502。
- `scan-image.sh` 逐层检查镜像（最终文件系统、`docker history`、`docker save` 的每一层；路径、内容魔数、派生标记与素材包 schema、预压缩变体、tar/zip 包、按 `rich4-assets/manifest.json` 与原版指纹的 sha256 禁单），通过时退出码为 0；有命中为 1；没扫成（docker 出错、临时目录不可用等）为 2。它在官方 `node:24-slim` 容器里运行扫描程序（第一次会拉取这个镜像）。
- 数据：compose 项目名是 `rich4`，读写卷是 `rich4_rich4-state`（数据库与备份）和 `rich4_caddy-data`（证书）。**不要**对正式部署执行 `docker compose down -v`：`-v` 会连同数据库、备份与证书一起删掉。

**在本机构建**（服务器内存不够、或者不想在服务器上装构建依赖时）：在本机仓库根目录构建并扫描，再把镜像传过去，服务器上用 `--no-build` 起服：

```sh
# 本机（服务器是 x86_64 而本机是 Apple 芯片时加 --platform linux/amd64）
docker build -f deploy/Dockerfile -t rich4:local .
bash deploy/scan-image.sh rich4:local
docker save rich4:local | gzip | ssh user@rich4.example.com 'gunzip | docker load'
# 服务器
docker compose up -d --no-build --wait
```

- 跨架构构建（`--platform linux/amd64`）不需要在 Docker Desktop 里打开 amd64 模拟：Dockerfile 的 build、deps 阶段固定在构建机架构上运行（产物是纯 JS），最终镜像不执行任何 `RUN`（见 Dockerfile 文件头）。但本机没有模拟时跑不了 amd64 容器，`scan-image.sh` 的第一道检查（在容器里列文件）会以退出码 2 失败——这时把扫描放到服务器上做：镜像 `docker load` 之后，在服务器仓库目录执行 `bash deploy/scan-image.sh rich4:local`。

## 7. 上线检查清单

- [ ] `SAVE_HMAC_SECRET`：本机 `scripts/access.ts secret` 生成的随机值（≥32 字节）。更换它会让之前导出的存档文件验签失败。
- [ ] `ADMIN_TOKEN`：随机值（门禁开启时 ≥32 字节）。它能签发邀请码、吊销全部会话，只保存在服务器的 `deploy/.env` 与你的密码管理器里；管理命令从 `deploy/.env` 读它、经标准输入交给 curl（§8、§9），不要把它写在命令行上（会留在 shell 历史里，执行期间 `ps` 也看得到）。
- [ ] `ACCESS_MODE=passcode`（或 `invite`）、`ACCESS_PASSCODE_HASH`、`ACCESS_SECRET` 已填；口令明文没有写进任何文件。
- [ ] `PUBLIC_URL=https://<域名>`（https：访问 cookie 才带 `Secure`；邀请链接也用它）。
- [ ] 客户端真实 IP 能传到服务器（§7.1）：有 AAAA 记录时 `ENABLE_IPV6=true`；Caddy 前面另有反代、隧道或 CDN 时已设置 `CADDY_TRUSTED_PROXIES`；app 日志里没有 `client ip resolves to a private address`。
- [ ] `SITE_ADDRESS=<域名>`，DNS 已指向本机；80、443（以及 UDP 443）已在防火墙放行；证书签发成功（§8）。
- [ ] 没有设置 `RICH4_TEST_MODE`；app 日志里没有「RICH4_TEST_MODE=1：debug:act 已开启」。
- [ ] `bash deploy/scan-image.sh rich4:local` 退出码 0。
- [ ] 每日备份已生成（启动 30 秒后第一次检查，之后每小时检查一次）：`docker compose exec app ls -l /data/backup`；异地备份已安排（§9.5）。

### 7.1 客户端真实 IP：IPv6、前置反代与 CDN

服务器按客户端 IP 做限流：同 IP 最多 30 个连接、每分钟建房 5 次、门禁登录与管理接口鉴权失败的退避。app 取的是 Caddy 写进 `X-Forwarded-For` 的地址（Caddy 认定的客户端 IP，客户端自带的同名头会被丢弃）。下面几种部署形态里，Caddy 看到的「客户端」其实是中间那一跳，**所有经这一跳进来的玩家会被合并成同一个 IP**：一个人输错 6 次口令，这些人全部被 429 挡在门外；连接数与建房额度也变成大家共享。

| 形态 | 现象 | 处理 |
|---|---|---|
| 有 AAAA 记录，compose 网络只有 IPv4 | 宿主 IPv6 地址上的端口由 docker-proxy 转发，IPv6 访客全部显示成网关 `172.x.0.1` | 保持 `ENABLE_IPV6=true`（缺省；需要 Docker Engine 27+）。主机内核禁用了 IPv6、`up` 报 IPv6 相关错误时只能设为 `false`，这时**不要**加 AAAA 记录（或把 `BIND_ADDR` 写成主机的 IPv4 地址，只接 IPv4） |
| Caddy 前面还有本机的反代或隧道（`BIND_ADDR=127.0.0.1`） | 全部显示成网关 `172.x.0.1` | `CADDY_TRUSTED_PROXIES=private_ranges`，前置代理要设置 `X-Forwarded-For` |
| Caddy 前面有 CDN | 全部显示成少数几个 CDN 回源节点，正常用户大面积碰到 `SERVER_BUSY`、`RATE_LIMITED` | `CADDY_TRUSTED_PROXIES=<CDN 公布的回源网段，空格分隔>`（例如 Cloudflare 的 IPv4 / IPv6 列表，要随 CDN 的公布更新），并确认 CDN 转发 WebSocket |
| 另一个域名经 Cloudflare Tunnel 进来（§11） | 不处理时会全部显示成 cloudflared 容器的地址 | 不用改 `.env`：Caddyfile 的隧道入口 `:8081` 自己信任私有网段、取 `Cf-Connecting-Ip`；公网入口的 `CADDY_TRUSTED_PROXIES` 保持原样 |

- `CADDY_TRUSTED_PROXIES` 生效后，Caddy 从右往左解析这些代理转来的 `X-Forwarded-For`，取第一个不可信的地址（`trusted_proxies_strict`，最左段可被客户端伪造），再原样写给 app。改完 `deploy/.env` 后 `docker compose up -d --wait` 让 caddy 按新环境变量重建。
- 端口对公网开放（`BIND_ADDR` 为空）时**不要**写 `private_ranges`：经 docker-proxy 进来的连接也显示为私有地址，会被当成可信代理，客户端就能伪造 IP。
- 核对：app 在生产环境第一次把某个连接的客户端 IP 解析成本机或私有地址时，打一条 warn `client ip resolves to a private address behind TRUST_PROXY=1`（带 `ip` 与直连对端 `peer`），`docker compose logs app | grep 'private address'` 没有输出才对。玩家本来就在同一个内网（局域网部署）时这条告警可以忽略。
- 已有 nginx 的主机（§10）由 nginx 负责这件事：前面还有 CDN 时用 realip 模块还原真实 IP。

## 8. 验证

```sh
docker compose ps
curl -fsS https://rich4.example.com/healthz
curl -fsS https://rich4.example.com/readyz
curl -s -o /dev/null -w '%{http_code}\n' https://rich4.example.com/api/maps      # 门禁开启：401
curl -sI https://rich4.example.com/ | grep -i -E 'strict-transport-security|x-frame-options|referrer-policy'
# ADMIN_TOKEN 从 deploy/.env 读出、经标准输入交给 curl（-H @-，curl ≥ 7.55）：不出现在命令行、ps 与 shell 历史里
sed -n 's/^ADMIN_TOKEN=/Authorization: Bearer /p' deploy/.env | curl -fsS -H @- https://rich4.example.com/admin/stats
docker compose logs app | grep -E 'asset pack enabled|rich4 server listening'
```

- `/healthz`、`/readyz` 返回 200；`/api/maps` 未登录返回 401（门禁生效）。
- 用真实域名时响应带 `Strict-Transport-Security: max-age=31536000`、`X-Frame-Options: DENY`、`Referrer-Policy: same-origin`，没有 `Server` / `Via` 头。
- app 日志里有 `asset pack enabled`（带 packId、文件数）与 `rich4 server listening`（`maps` 里有 `taiwan`、`china`、`japan`、`usa`，`access` 为 `passcode`）。
- 浏览器打开 `https://rich4.example.com`：门禁页输入口令 → 片头（可跳过）→ 原版标题画面 → 單機對戰，能开局、掷骰、买地即可。之后 `docker compose logs app | grep 'private address'` 应当没有输出（§7.1）。

## 9. 日常运维

下面的管理命令都从 `deploy/.env` 读 `ADMIN_TOKEN`（`sed` 把那一行改写成请求头，`curl -H @-` 从标准输入读请求头），token 不会出现在命令行、`ps` 与 shell 历史里。

### 9.1 邀请朋友与吊销

- **房间邀请链接**（`ACCESS_GRANTS=1`，缺省开启）：已通过口令的玩家在房间大厅里复制的链接带一次性授权（24 小时内有效、最多 8 人），朋友不用知道口令。
- **邀请码**（口令之外的另一种登录方式；`ACCESS_MODE=invite` 时是唯一方式）。镜像里没有 `scripts/access.ts`，用 `ADMIN_TOKEN` 调管理接口：

  ```sh
  # 生成：可用 5 次、7 天有效；响应里的 code 就是邀请码
  sed -n 's/^ADMIN_TOKEN=/Authorization: Bearer /p' deploy/.env | curl -fsS -X POST -H @- \
    -H 'Content-Type: application/json' -d '{"uses":5,"days":7,"note":"朋友"}' \
    https://rich4.example.com/admin/access/invites
  # 列出邀请码（剩余次数、到期时间、备注）与当前 epoch
  sed -n 's/^ADMIN_TOKEN=/Authorization: Bearer /p' deploy/.env | curl -fsS -H @- \
    https://rich4.example.com/admin/access/invites
  ```

- **吊销全部会话**（口令泄露、有人不该再进来）：所有人的访问 cookie 与未兑换的房间邀请链接立即失效，需要重新输入口令。换口令时先改 `ACCESS_PASSCODE_HASH`、`docker compose up -d --wait` 让 app 用新配置重建，再吊销：

  ```sh
  sed -n 's/^ADMIN_TOKEN=/Authorization: Bearer /p' deploy/.env | curl -fsS -X POST -H @- \
    https://rich4.example.com/admin/access/revoke
  ```

- 管理接口鉴权失败会按 IP 退避（429）并记 warn 日志。

### 9.2 运行状态：/admin/stats

```sh
sed -n 's/^ADMIN_TOKEN=/Authorization: Bearer /p' deploy/.env | curl -fsS -H @- https://rich4.example.com/admin/stats
```

返回房间数（`rooms.rooms / playing / members`）、Socket.IO 连接数、会话数、进程内存、持久化计数（journal、快照、存档、写入错误）与事件循环延迟 `eventLoopDelayMs{p50,p99,max,windowMs}`。延迟按 60 秒窗口滚动，报「上一个完整窗口与当前窗口中 p99 较差的一个」。**读数包含 20 ms 的采样间隔本身**：空闲时 p50 约 21–26 ms、p99 约 31 ms（容器里），所以要减去约 20 ms 才是真正的迟到。本机实测 200 个房间同时对局时 p99 约 33 ms、max 约 45 ms；p99 长期超过 50 ms 说明主机 CPU 不够或被别的进程抢占。

### 9.3 日志

```sh
docker compose logs -f app            # 跟踪 app 日志（JSON 行）
docker compose logs --since 1h caddy  # 最近一小时的 Caddy 日志（证书、上游错误）
```

容器日志用 json-file 轮转，每个容器最多 `LOG_MAX_FILE` 个 × `LOG_MAX_SIZE`（缺省 5 × 10 MB），不会占满磁盘。请求体（口令、token）永远不写日志。

### 9.4 升级

```sh
git pull
docker compose up -d --build --wait
docker compose restart caddy          # 只在 deploy/Caddyfile 有改动时需要（见下），证书在 caddy-data 卷里不受影响
bash deploy/scan-image.sh rich4:local
```

- `up -d` 只重建镜像或服务定义变了的容器，**不看挂载文件的内容**：Caddyfile 是单文件只读绑定挂载，`git pull` 改了它之后 caddy 仍是 Running、仍用旧配置；而且 git 更新文件是换 inode，容器里的挂载还指向旧文件，在容器里 `caddy reload` 也读不到新内容。所以 `git pull` 带来了 `deploy/Caddyfile` 的改动（`git diff --stat HEAD@{1} -- deploy/Caddyfile` 有输出）时，要 `docker compose restart caddy`（重启约 1 秒；不确定就每次都执行）。
- 重建 app 时旧容器收到 SIGTERM 优雅停机：`/readyz` 转 503 → 广播「服务器即将重启」→ 挂起全部房间（写快照、自动存档）→ 关连接（在途请求与 WebSocket 关闭握手最多再等 3 秒，之后强制断开，不回应关闭帧的 WebSocket 也一样）→ 关数据库，日志依次是 `shutting down`、`shutdown: rooms suspended`（带房间数）、`shutdown complete`。新容器启动时从快照 + journal 恢复 24 小时内的房间（日志 `rooms restored`），对局 epoch 加 1，玩家的页面自动重连后接着玩。本机实测旧进程多数在 SIGTERM 后 0.3 秒内停完，偶尔有连接要等满 3 秒宽限被强制断开（日志 `shutdown: grace period over`，带剩余连接数与其中的 WebSocket 数），从 SIGTERM 到新进程开始监听共 3–7 秒；有玩家的手机被挂起、WebSocket 不回应关闭帧时也同样最多等 3 秒（修复前这种情况会卡满 25 秒被强制退出）。
- 服务器内存紧张时（§1）用 §6 的「在本机构建」：本机构建、扫描、`docker save | ssh … docker load`，服务器上 `git pull && docker compose up -d --no-build --wait`。
- 仓库没有远程地址时（§2），`git pull` 换成在本机重跑 `git archive --format=tar HEAD | ssh … 'tar -x -C /srv/rich4'`，其余命令不变。
- 只想重启：`docker compose restart app`。
- 叠加了 Cloudflare Tunnel（§11）时上面的命令照旧；`restart caddy` 期间两个域名都会断开约 1 秒。升级 cloudflared 是改 `deploy/docker-compose.tunnel.yml` 里的镜像版本号，再 `docker compose up -d --wait`。
- 数据包或素材包更新：按 §3 重新 rsync，再 `docker compose restart app`（服务器只在启动时读 manifest）。数据包有变化（新增地图、重建 MapDef）时素材包必须跟着重建，见 §9.6。
- **提取规则有改动的版本**（`tools/extract/src/assets/` 的 catalog、图像处理变了，例如 2026-09-30 把卡片插画 `card.<k>` 从 `corner-rgb0` 改为 `opaque`）：只升级镜像不够——素材包不在镜像里。先在本机 `npm run extract -- assets build` 重建、`npm run extract -- assets verify`，按 §3 带 `--delete` rsync `rich4-assets/`，`docker compose restart app`；再核对 app 日志 `asset pack enabled` 的 packId 与本机 `rich4-assets/manifest.json` 的 `packId` 相同（通过门禁后也可以看 `/pack/manifest.json`，例如 `entries["card.1"].transparency` 应为 `opaque`）。

### 9.5 备份与恢复

**自动备份**：app 每天把数据库（房间快照、journal、存档、门禁邀请码与授权都在同一个库里）备份到 `/data/backup/rich4-YYYYMMDD.db`，保留最近 `BACKUP_KEEP`（缺省 7）份。日期按容器时区（UTC）；启动 30 秒后检查一次，之后每小时检查当天是否已有备份，所以 UTC 零点后一小时内会出现当天的文件。

```sh
docker compose exec app ls -l /data/backup
```

**异地备份**（强烈建议）：把整个备份目录拷出容器，再同步到另一台机器。文件名本身带日期，重复拷贝只会覆盖同名文件，所以不用关心 cron 按什么时区执行、当天的备份是否已经生成。先 `mkdir -p /srv/rich4-backups`，然后在服务器的 crontab（`crontab -e`）里加一行：

```sh
30 * * * * cd /srv/rich4 && docker compose cp app:/data/backup/. /srv/rich4-backups/ >/dev/null
```

- 每小时拷一次（容器里最多 `BACKUP_KEEP` 个文件，很快）。`cd /srv/rich4` 不能省：`docker compose` 要从仓库根目录的 `.env` 读 `COMPOSE_FILE`。
- `/srv/rich4-backups/` 会一直累积，按需清理，例如 `find /srv/rich4-backups -name 'rich4-*.db' -mtime +60 -delete`。
- 再用 `rsync -a /srv/rich4-backups/ backup-host:rich4-backups/` 之类的方式同步走，或者从本机定期 `rsync -a user@rich4.example.com:/srv/rich4-backups/ ./rich4-backups/` 拉回来（本机的 `rich4-backups/` 不要放在仓库目录里：备份库里有门禁邀请码与授权、全部存档）。

**恢复**（停 app → 用备份替换 `rich4.db` → 起 app）：

```sh
docker compose stop app
docker compose run --rm --no-deps -T --entrypoint sh app -c \
  'cp /data/backup/rich4-20260928.db /data/rich4.db.restore && mv /data/rich4.db.restore /data/rich4.db && rm -f /data/rich4.db-wal /data/rich4.db-shm'
docker compose up -d --wait app
docker compose logs app | grep -E 'rooms restored|rich4 server listening'
```

从异地备份恢复时，先把文件从 `/srv/rich4-backups/`（异地机器上的副本先拷回这个目录）拷进数据卷（app 停着也能拷），再做同样的替换：

```sh
docker compose stop app
docker compose cp /srv/rich4-backups/rich4-20260928.db app:/data/restore-upload.db
docker compose run --rm --no-deps -T --entrypoint sh app -c \
  'cp /data/restore-upload.db /data/rich4.db.restore && mv /data/rich4.db.restore /data/rich4.db && rm -f /data/rich4.db-wal /data/rich4.db-shm /data/restore-upload.db'
docker compose up -d --wait app
```

- `run --rm` 用同一个镜像、同一个数据卷起一次性容器，以 `node` 用户操作，文件属主不会变。先拷成临时文件再 `mv`，替换是原子的；必须删掉旧库的 `-wal` / `-shm`，否则 sqlite 会把旧的预写日志套到恢复的库上。
- 恢复会让整个库回到备份时刻：之后建的房间、存档、签发的邀请码都会消失，**之后做过的吊销也会被撤销**（吊销计数 epoch 回退，旧 cookie 重新有效）。恢复后如有需要，再执行一次 §9.1 的吊销。
- 启动时只恢复 24 小时内更新过的房间快照；更早的对局可以用存档（每个房间停机或解散时写的 `auto:<房间号>` 自动存档）读档继续。

### 9.6 更新地图数据包与素材包（例如接入大陆 / 日本 / 美国）

原版皮肤的棋盘按 MapDef 绑定（素材包构建时逐图核对地图资源、几何与精灵集合），所以**数据包一变，素材包就要跟着重建**：否则新图（或 MapDef 变了的图）在原版皮肤下回退到程序化棋盘。都在**本机**仓库根目录做：

```sh
# 1. 数据包：all = map raw（gm 0–3）→ map diff 0–3 → exe tables → map build --map all --strict4 --preview（不打包）
npm run extract -- all
npm run extract -- pack --out rich4-data/          # 与已有 manifest 合并；要跳过的图已在 manifest 里时报 E_PACK_DROP、什么都不写
for gm in 0 1 2 3; do npm run extract -- verify --samples --map $gm; done
shasum -a 256 rich4-data/maps/taiwan.map.json      # 必须仍是 14ef91e8…6c10

# 2. 素材包：必须带 --video（片头与四段飞行动画）；--strict：缺任何一张图的 MapDef 就失败，不出半套包
npm run extract -- assets build --out rich4-assets/ --video --strict
npm run extract -- assets verify --out rich4-assets/ --full
```

- **台湾图必须逐字节不变**：`taiwan.map.json` 的 sha256 `14ef91e8…6c10`、mapHash `3c2f31eb…a551`。服务器上的房间快照、自动存档与玩家导出的存档都按 mapHash 引用地图，变了就会报 `MAP_UNAVAILABLE`，旧存档读不回来。
- `rich4-data/manifest.json`：四张图都在，`pending` 都是 `[]`、`validation.ok` 都是 true。`pack` 不带 `--map` 时只打最近一次 `map build` 报告 exit 0 的图，其余告警跳过，所以某张图缺席时先看它的 `map build` 报告。
- `rich4-assets/manifest.json`：`maps` 有四张图；台湾 MapDef 没变时 `maps/taiwan.skin.<hash>.json` 也不变。四张图的完整素材包约 213 MB（只有台湾时约 200 MB）。
- 上传与生效：按 §3 带 `--delete` rsync 两个目录，`docker compose restart app`；核对 app 日志 `rich4 server listening` 的 `maps` 有四张图、`asset pack enabled` 的 packId 与本机 `rich4-assets/manifest.json` 相同；通过门禁后 `/api/maps` 四张图都是 `playable: true`，台湾的 `mapHash` 仍是 `3c2f31eb…`。然后四张图各开一局冒烟（原版皮肤：开局设置点关卡换背景、开局飞行动画、棋盘与小地图）。
- 只更新了数据包、还没重建素材包时，新图照样能玩，只是棋盘用程序化美术；服务器不会因为素材包过期起不来。
- 本机起服务核对时，`RICH4_DATA_DIR` 写绝对路径或干脆不设（服务器会自动找仓库根目录的 `rich4-data/`）：`npm run dev:server` 经 `npm -w` 在 `apps/server` 下运行，写相对路径 `rich4-data` 会找不到数据包，退回只有 fixture 地图。

## 10. 已经在用 nginx 的主机

不启动 Caddy，让 app 只发布到宿主的 `127.0.0.1:3000`，由现有的 nginx 反代。§2 里仓库根目录的 `.env` 改成叠加 `docker-compose.nginx.yml`：

```sh
echo 'COMPOSE_FILE=deploy/docker-compose.yml:deploy/docker-compose.nginx.yml' > .env
docker compose config --services     # 只输出 app（caddy 在 caddy profile 里，不启动）
docker compose up -d --build --wait
curl -fsS http://127.0.0.1:3000/healthz
```

- **之后本文的每一条 `docker compose` 命令照常执行、不写 `-f`**，由 `.env` 里的 `COMPOSE_FILE` 带上 nginx 覆盖文件。命令里只要显式写了 `-f deploy/docker-compose.yml`，覆盖文件就不在了：`up` 会按基础文件重建 app，撤掉 127.0.0.1:3000 的端口发布（nginx 全站 502），还会启动 caddy 去抢 nginx 占着的 80/443。
- 换回 Caddy：先让 nginx 让出 80/443，把 `.env` 改回 `COMPOSE_FILE=deploy/docker-compose.yml`，再 `docker compose up -d --wait`。

然后把 `deploy/nginx.conf.example` 复制到 nginx 的配置目录（例如 `/etc/nginx/conf.d/rich4.conf`），替换其中的 `rich4.example.com` 与证书路径（可以用 `certbot certonly --webroot -w /var/www/certbot -d rich4.example.com` 签发，配置里的 80 端口已放行 ACME 校验路径），再：

```sh
sudo nginx -t && sudo systemctl reload nginx
```

要点（配置文件头有完整说明）：WebSocket 升级与长轮询都走 `/socket.io/`，读超时 120 秒；`X-Forwarded-For` **覆盖**为 `$remote_addr`（追加模式下客户端能伪造 IP 绕过限流）；`/pack/` 不缓冲、不再压缩、不缓存，Range 原样透传；请求体上限 3 MB。前面还有 CDN 时要用 realip 模块还原真实 IP（`set_real_ip_from` 写 CDN 的回源网段），否则所有人都显示成 CDN 节点的地址（§7.1），并确认 CDN 支持 WebSocket。

## 11. 经 Cloudflare Tunnel 增加第二个域名

公网入口（§5–§8：`SITE_ADDRESS`、80/443、Caddy 自动证书）保持不变，再让一个托管在 Cloudflare 上的域名（下文用 `rich4.example.net`）经 Cloudflare Tunnel 访问同一台服务器：两个域名同时可用，看到的是同一批房间。直连线路不好的朋友可以换这条路走，以后想只留 Cloudflare 也能平滑过渡。

工作方式：

- 隧道在 Cloudflare 上远程管理（`config_src=cloudflare`），转发规则（ingress）是 `rich4.example.net → http://caddy:8081`，其余主机名一律 `http_status:404`。
- 服务器叠加 `deploy/docker-compose.tunnel.yml` 启动 cloudflared。它主动连出到 Cloudflare 边缘（QUIC，UDP 7844；不通时退回 HTTP/2，TCP 7844），不需要放行任何入站端口。令牌只放在 `deploy/tunnel.env`（600），只交给 cloudflared，app 容器里看不到。
- TLS 在 Cloudflare 边缘终止（证书由 Cloudflare 负责）；边缘到 cloudflared 这一段由隧道加密；cloudflared 到 Caddy 是 compose 内网里的明文 HTTP。
- `deploy/Caddyfile` 的 `:8081` 入口不发布到宿主，公网连不到。它单独信任私有网段，客户端 IP 取 Cloudflare 写入的 `Cf-Connecting-Ip`（§7.1）；访客用 `http://` 打开时 308 跳转到 https；安全响应头、请求体上限、压缩和公网入口共用同一段配置。公网入口的 `CADDY_TRUSTED_PROXIES` 不用改。
- `PUBLIC_URL` 仍写公网域名：它只决定访问 cookie 是否带 `Secure`（两个域名都是 https）以及分享页的 `og:url`。房间页的邀请链接按当前页面地址生成，从隧道域名进来的人复制到的就是隧道域名的链接。

使用上的差别：

- **两个域名的浏览器数据互不相通**：访问 cookie（口令要各输一次）、断线重连用的身份令牌（`localStorage` 的 `rich4.token`）、设置都按域名分开。玩家在一局之内不要中途换域名，换了会被当成新访客，要重新认领座位。
- 延迟取决于玩家被分到哪个 Cloudflare 节点。从服务器自测（香港节点）复用连接时，每个请求往返约 16ms，隧道本身只多十几毫秒；但 Cloudflare 免费版经常把中国大陆的访客分到较远的节点，这时可能明显慢于直连。素材包在门禁下是 `private`，Cloudflare 不缓存，每个文件都要回源。
- Cloudflare 免费版的请求体上限是 100MB（存档导入上限 2MiB，不受影响），WebSocket 缺省开启。

建隧道（本机；cf CLI：`npm i -g cf`，`cf auth login`）：

```sh
cf tunnels create --name rich4 --config-src cloudflare       # 输出里的 id 就是下面的 TID
TID=<隧道 id>
cf tunnels config update "$TID" --body '{"config":{"ingress":[{"hostname":"rich4.example.net","service":"http://caddy:8081","originRequest":{"connectTimeout":10}},{"service":"http_status:404"}]}}'
cf dns records create -z example.net --body "{\"type\":\"CNAME\",\"name\":\"rich4.example.net\",\"content\":\"$TID.cfargotunnel.com\",\"proxied\":true,\"ttl\":1}"
# 令牌经管道写到服务器的 deploy/tunnel.env（600），不出现在命令行、终端输出与 shell 历史里
cf tunnels token get "$TID" | python3 -c 'import json,sys; print("TUNNEL_TOKEN=" + json.load(sys.stdin)["result"])' \
  | ssh <服务器> 'umask 077; cat > /srv/rich4/deploy/tunnel.env'
```

启动（服务器，仓库根目录；先按 §9.4 把带 `:8081` 入口的 `deploy/Caddyfile` 和 `deploy/docker-compose.tunnel.yml` 更新上去）：

```sh
echo 'COMPOSE_FILE=deploy/docker-compose.yml:deploy/docker-compose.tunnel.yml' > .env
docker compose config --services              # app、caddy、cloudflared
docker compose --dry-run up -d --no-build     # 确认 app、caddy 是 Running（不重建），只新建 cloudflared
docker compose restart caddy                  # 让 Caddy 读到带 :8081 的 Caddyfile（§9.4）
docker compose up -d --no-build --wait
docker compose logs cloudflared | grep 'Registered tunnel connection'     # 通常 4 条
```

验证（本机）：

```sh
cf tunnels list --name rich4 --is-deleted false                              # status: healthy
curl -fsS https://rich4.example.net/healthz
curl -s -o /dev/null -w '%{http_code}\n' https://rich4.example.net/api/maps   # 门禁开启：401
curl -sI 'http://rich4.example.net/r/123456' | grep -i -E '^HTTP|^location'  # 308 → https://…
curl -s 'https://rich4.example.net/socket.io/?EIO=4&transport=polling'       # 0{"sid":…}
curl -fsS https://rich4.example.com/healthz                                  # 公网入口照旧
```

- 真实 IP：`docker compose logs app | grep 'private address'` 应当没有输出。想直接看 app 认定的 IP，可以不带令牌请求一次 `https://rich4.example.net/admin/stats`（401），app 日志里 `admin: auth failed` 的 `ip` 应当是你访问 Cloudflare 用的公网地址（这会给该 IP 记一次管理接口鉴权失败，和登录退避分开计数）。
- Caddyfile 的隧道入口可以在本机单独验证：`bash test/cf-tunnel-caddy.sh`（客户端 IP、伪造头、http→https 跳转、安全头、WebSocket 升级，公网入口不受影响）。

令牌泄露时：在 Cloudflare 上轮换令牌（或者删掉隧道重建），按上面的管道重新写 `deploy/tunnel.env`，再 `docker compose up -d --force-recreate --wait cloudflared`。

撤掉隧道：仓库根目录 `.env` 改回 `COMPOSE_FILE=deploy/docker-compose.yml`，执行 `docker compose up -d --remove-orphans --wait`（停掉并删除 cloudflared），再在 Cloudflare 上删掉 DNS 记录与隧道（`cf dns records delete`、`cf tunnels delete`）。Caddyfile 的 `:8081` 入口可以留着，没有人连它。

## 12. 故障排查

| 现象 | 原因与处理 |
|---|---|
| `docker compose` 报 `no configuration file provided: not found` | 不在仓库根目录执行，或者仓库根目录没有写 `COMPOSE_FILE` 的 `.env`（§2；nginx 模式见 §10）。 |
| `up` 报 `bind source path does not exist: …/rich4-data`（或 `rich4-assets`） | 按 §2 以部署用户身份 `mkdir -p rich4-data rich4-assets`。 |
| `up` 报 IPv6 相关的网络错误 | 主机内核禁用了 IPv6：`deploy/.env` 设 `ENABLE_IPV6=false`，并且不要给域名加 AAAA 记录（§7.1）。 |
| app 日志有 `client ip resolves to a private address` | 客户端 IP 塌缩成网关或代理地址，按 IP 的限流对所有人一起生效：按 §7.1 处理（IPv6、前置反代、CDN）。 |
| 构建时 `npm run build` 被 Killed（退出码 137） | 内存不够（§1）：加 swap，或在本机构建再传上去（§6）。 |
| app 反复重启，`docker compose logs app` 里是「启用原版素材包（RICH4_ASSETS_DIR=/assets-rich4）时必须设置访问门禁：ACCESS_MODE=passcode 或 invite…」 | 挂了素材包（`rich4-assets/manifest.json` 存在）却没开门禁。按 §4、§5 填好 `ACCESS_MODE=passcode`、`ACCESS_PASSCODE_HASH`、`ACCESS_SECRET` 后 `docker compose up -d`；不打算用原版皮肤就清空 `rich4-assets/`（保留空目录）。 |
| 日志是「环境变量无效：…」 | 逐条对应：`SAVE_HMAC_SECRET 在生产环境必填`；`ACCESS_MODE=passcode 需要 ACCESS_PASSCODE_HASH`；`ACCESS_SECRET 至少 32 字节`；`生产环境开启访问门禁…必须设置 PUBLIC_URL`；`RICH4_TEST_MODE=1 只允许用于本机验证`（删掉这一行）。改完 `.env` 后 `up -d` 让 app 重建。 |
| 浏览器 502 | app 没就绪或起不来：`docker compose ps` 看 app 是否 healthy，再看 app 日志。升级 / 重启期间的几秒 502 属正常，页面会自动重连。nginx 模式下还要确认 `docker compose port app 3000` 输出 `127.0.0.1:3000`（§10）。 |
| 改了 Caddyfile 不生效 | `docker compose restart caddy`（§9.4）。 |
| 隧道域名打开是 Cloudflare 的 1033 错误页 | cloudflared 没在运行或连不上 Cloudflare（§11）：看 `docker compose ps cloudflared` 与 `docker compose logs cloudflared`。令牌不对（`deploy/tunnel.env` 内容错）时日志会报 Unauthorized；出站 UDP/TCP 7844 被防火墙挡住时连不上边缘。根目录 `.env` 的 `COMPOSE_FILE` 里没有叠加 `docker-compose.tunnel.yml` 时，cloudflared 根本不会启动。 |
| 隧道域名 502 | cloudflared 连不上 `caddy:8081`：Caddy 还是旧配置（没有 `restart caddy`，§9.4）或者没起来，cloudflared 日志里会有连 `caddy:8081` 失败的错误。 |
| 隧道域名 404（空白页） | 转发规则里没有这个主机名，命中了最后那条 `http_status:404`：`cf tunnels config get <隧道 id>` 核对 ingress（§11）。 |
| 证书签不下来，浏览器提示证书无效 | 看 `docker compose logs caddy`：DNS 还没指向本机、80/443 没放行或被占用、`SITE_ADDRESS` 写错、大陆主机未备案被拦截，或短时间内反复失败触发了 Let's Encrypt 的频率限制（等一小时再试）。证书存在 `caddy-data` 卷里，不要 `down -v`。 |
| 能进页面但连不上房间 / 一直「重新连接中」 | 先看 `/readyz` 与 app 日志。公司网络、某些代理或 CDN 会拦 WebSocket 升级：前端这时会自动改走 HTTP 长轮询（浏览器开发者工具 Network 里能看到大量 `/socket.io/?EIO=4&transport=polling` 请求），可以正常玩，只是延迟略高；如果长轮询也不通，检查中间代理是否缓冲或截断了长连接（nginx 见 §10 的 `proxy_buffering off` 与 120 秒读超时）。 |
| 很多人同时被 429 挡住 / 建房报 `RATE_LIMITED`、`SERVER_BUSY` | 多半是客户端 IP 塌缩（§7.1）。 |
| 原版皮肤没出来，前端是程序化美术 | 看 app 启动日志：`asset pack: directory not found` / `no readable manifest.json`（目录没挂上或 uid 1000 读不了，见 §3 的权限）；`manifest.json failed contract validation` 或 `files do not match manifest`（上传不完整或本机素材包本身有问题：本机先 `npm run extract -- assets verify`，再按 §3 带 `--delete` 重新 rsync；可以临时设 `RICH4_ASSETS_VERIFY=full` 让服务器启动时逐文件复算 sha256）。 |
| `/api/maps` 里没有 `taiwan`（或少了 `china` / `japan` / `usa`） | app 日志里有「RICH4_DATA_DIR 下没有 manifest.json，只提供 fixture 地图」或「地图文件 sha256 与 manifest 不符，跳过」：`rich4-data/` 没传或不完整、权限不对，按 §3 重新同步后 `docker compose restart app`。只少某张新图：本机 `rich4-data/manifest.json` 里就没有它（`pack` 只打最近一次 `map build` exit 0 的图），按 §9.6 重建数据包。 |
| 新图能开局，但原版皮肤下棋盘是程序化美术 | 素材包是在这张图的 MapDef 之前（或 MapDef 变了之后没重建）打的：原版棋盘皮肤按 MapDef 绑定，对不上就回退。按 §9.6 在本机重建素材包、`assets verify`，再 rsync 并重启 app。 |
| 原版皮肤下新局没有飞行动画（片头也没有） | 素材包构建时没带 `--video`（没有 `video.*` 条目时客户端直接跳过）：按 §9.6 带 `--video` 重建。读档继续、刷新、重连、观战本来就不播（DEVIATIONS DEV-24）。 |
| 数据目录写不进去（改成绑定宿主目录而不是命名卷时） | 宿主目录属主要是 1000:1000：`sudo chown -R 1000:1000 <目录>`。 |
| 重启后玩家没回到对局 | 页面会自动重连并拿到快照（epoch 加 1）；只恢复 24 小时内更新过的房间。所有真人都离开时房间暂停，第一个真人回来就继续。 |
| `scan-image.sh` 退出码 2 | 扫描本身没跑成（docker 出错、`$TMPDIR` 不可写或磁盘满、拉不到 `node:24-slim`）：看它最后几行输出，修好环境后重跑；退出码 1 才是镜像里有原版或派生数据。 |

## 13. 本机验证（只限本机）

`deploy/docker-compose.e2e.yml` 是本机验证镜像用的覆盖文件：只绑定 `127.0.0.1:8080/8443`、`SITE_ADDRESS=localhost`（Caddy 内部 CA 自签证书）、`PUBLIC_URL=https://localhost:8443`、开 `RICH4_TEST_MODE=1`（E2E 要用 `debug:act`），app 的环境变量只从 `.cache/m11/e2e.env` 读（`.cache/` 不入库、不进镜像）。**它开放了可以任意改写对局的调试接口，绝不能用于公网部署。** 本节的命令显式写 `-p` 与 `-f`（显式 `-f` 会盖过仓库根目录 `.env` 里的 `COMPOSE_FILE`），与正式部署的项目 `rich4` 互不相干。

`.cache/m11/e2e.env` 按 §5 的格式写（`SAVE_HMAC_SECRET`、`ADMIN_TOKEN`、`ACCESS_MODE=passcode`、`ACCESS_PASSCODE_HASH`、`ACCESS_SECRET` 等，另加一行空的 `BIND_ADDR=`），口令明文放 `.cache/m11/passcode.txt`，ADMIN_TOKEN 另存一份到 `.cache/m11/admin-token`。然后在仓库根目录：

```sh
docker build -f deploy/Dockerfile -t rich4:local .
bash deploy/scan-image.sh rich4:local
docker compose -p rich4-m11 --env-file .cache/m11/e2e.env -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml up -d --build --wait
curl -kfsS https://localhost:8443/readyz

# E2E（远程模式：不启动本机服务器，对着容器跑）
E2E_BASE_URL=https://localhost:8443 E2E_PASSCODE="$(cat .cache/m11/passcode.txt)" \
  npx playwright test -c e2e/playwright.config.ts e2e/specs/turn-cycle.spec.ts e2e/specs/reconnect.spec.ts
E2E_BASE_URL=https://localhost:8443 E2E_PASSCODE="$(cat .cache/m11/passcode.txt)" \
  E2E_RESTART_CMD="docker compose -p rich4-m11 -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml restart app" \
  npx playwright test -c e2e/playwright.config.ts e2e/specs/deploy-restart.spec.ts

# 压测：200 个房间经 Caddy，读 /admin/stats 的事件循环 p99（自签证书对 localhost 自动接受）
ADMIN_TOKEN="$(cat .cache/m11/admin-token)" ACCESS_PASSCODE="$(cat .cache/m11/passcode.txt)" \
  npm run loadtest -- --url https://localhost:8443 --rooms 200

docker compose -p rich4-m11 -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml down -v
```

- `test/m11-final-env.sh` 可以一次生成上面这些本机文件（密钥用 `scripts/access.ts secret`，口令随机），`test/m11-final-http.sh` 逐项检查门禁、Range、缓存头与安全响应头，`test/m11-final-backup.sh` 演练备份恢复，`test/m11-tour.spec.ts`（`-c test/m11-playwright.config.ts`）用真实浏览器巡检原版皮肤，`test/m11fix-scan-selftest.sh` 用合成的「泄漏」文件（不含任何原版字节）叠一层自测镜像，确认 `scan-image.sh` 逐条命中。
- 压测时所有连接来自同一个 IP，生产额度（同 IP 30 个连接、每分钟建房 5 次）容不下，只有测试模式下放宽；所以压测只能对着 e2e 覆盖文件起的实例跑。压测判定：事件循环 p99 超阈值或有任何功能性错误（建房或再来一局失败、断线、seq 缺口、ack 超时、`app:error`、非预期的错误码）为 FAIL（退出码 1，压测中服务器崩溃也算）；只缺 p99 读数时为无法判定（退出码 2）。
- Docker Desktop（macOS）经端口转发进来的连接在容器里都显示为网关地址，app 会打一条 `client ip resolves to a private address` 告警：本机验证时属正常，Linux 主机上按 §7.1 核对。
- 验证生产形态（不开测试模式）：不带 `docker-compose.e2e.yml`，`deploy/.env` 按 §5 填好密钥，另外写 `SITE_ADDRESS=localhost`、`PUBLIC_URL=https://localhost:8443`、`HTTP_PORT=8080`、`HTTPS_PORT=8443`、`BIND_ADDR=127.0.0.1`（`test/m11-final-env.sh prod` 会生成这样一份），然后 `docker compose -p rich4-m11 -f deploy/docker-compose.yml up -d --build --wait`。检查完记得删掉这个本机用的 `deploy/.env`。
