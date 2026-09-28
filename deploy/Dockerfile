# 三阶段构建（design/net.md §10.2；architecture §9.3、M11）。构建上下文是仓库根目录（docker-compose.yml 的 build.context: ..）：
#   docker build -f deploy/Dockerfile -t rich4:local .
# 可选构建参数（只写进 OCI label）：--build-arg RICH4_VERSION=0.1.0 --build-arg VCS_REF=$(git rev-parse --short HEAD)
#
# 镜像只含代码与 fixture：原版文件、rich4-data/、原版皮肤素材包 rich4-assets/ 一律不进镜像（任何一层）——
# 根目录 .dockerignore 已排除它们，下面的构建期检查再兜一次底；素材包只在运行时以只读卷挂载（见 docker-compose.yml）。
# 构建期检查用 scripts/scan-tree.ts，规则与仓库守卫 check-no-original、deploy/scan-image.sh 是同一套（路径、内容魔数、
# 派生标记与素材包 schema、预压缩变体解压、压缩包展开、sha256 禁单）；它只用 Node 内置模块，node:24-slim 里直接运行。
# 构建完再用 deploy/scan-image.sh 逐层复查（最终文件系统、docker history、docker save 的每一层）。
#
# 不写 `# syntax=` 指令：用 Docker 自带的 Dockerfile 前端（需要 Docker 25+：默认 BuildKit，支持 RUN --mount 与
# HEALTHCHECK --start-interval），构建时不再额外拉取 docker/dockerfile 前端镜像；基础镜像只用 Docker Hub 官方的 node:24-slim。
#
# 最终镜像（runtime）只有三样东西：server/main.mjs(+.map)（esbuild 产物，@rich4/shared 已打进包里）、
# public/（vite 产物）、node_modules/（server 的生产依赖）。以 node 用户（uid 1000）运行，/data 属主 node。

# ───────────── build：全量依赖 + 构建前端与服务端 ─────────────
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
COPY tools/extract/package.json tools/extract/
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY . .
# 构建上下文里出现原版文件或派生素材时直接失败（.dockerignore 被改坏时的兜底）。用构建产物档的规则：在仓库守卫
# check-no-original 之上，音视频、素材包命名的文件、.rich4-extract.json、展不开的压缩包也一律拒绝（仓库里本来就没有这些）
RUN set -eu; \
    for d in original rich4-data rich4-assets .cache; do \
      if [ -e "$d" ]; then echo "构建上下文里不应出现 $d/（检查 .dockerignore）" >&2; exit 1; fi; \
    done; \
    node --disable-warning=ExperimentalWarning scripts/scan-tree.ts --profile artifact --skip-dir node_modules .
# 依次执行 vite build（apps/client/dist）与 esbuild（apps/server/dist/main.mjs）
RUN npm run build
# 产物复查（构建产物档）：只允许代码、样式、字体；原版文件、派生地图、带派生标记或素材包 schema 的内容（含 .br/.gz 变体）、
# 素材包命名的文件、任何音视频、展不开的压缩包一律拒绝
RUN node --disable-warning=ExperimentalWarning scripts/scan-tree.ts --profile artifact apps/client/dist apps/server/dist \
    && test -f apps/server/dist/main.mjs && test -f apps/client/dist/index.html

# ───────────── deps：只装 server 的生产依赖 ─────────────
# @rich4/shared 已由 esbuild 打进 main.mjs；npm 为 workspace 建的 node_modules/@rich4/* 链接指向本阶段并不存在的源码目录，
# 直接删掉（运行时用不到它们，容器能起服即证明）。再删掉运行时用不到的类型声明、source map 与文档，缩小镜像。
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
COPY tools/extract/package.json tools/extract/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace=@rich4/server --include-workspace-root=false \
    && rm -rf node_modules/@rich4 node_modules/.bin \
    && find node_modules -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' \
         -o -iname 'README*' -o -iname 'CHANGELOG*' -o -iname 'HISTORY*' \) -delete \
    && find node_modules -depth -type d -empty -delete

# ───────────── runtime ─────────────
FROM node:24-slim AS runtime
ARG RICH4_VERSION=0.1.0
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="rich4" \
      org.opencontainers.image.description="大富翁4 网页版 4 人联机复刻：服务端与前端（不含任何原版文件或派生数据，原版数据只能运行时只读挂载）" \
      org.opencontainers.image.version="${RICH4_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.base.name="docker.io/library/node:24-slim"
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data STATIC_DIR=/app/public
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./server
COPY --from=build /app/apps/client/dist ./public
# /data：读写卷（sqlite、备份）；命名卷首次创建时沿用这里的属主 node:node（绑定宿主目录时要自己 chown 1000:1000）。
# /data-rich4、/assets-rich4：只读挂载点（原版地图数据与原版皮肤素材包；镜像里是空目录）
RUN mkdir -p /data /data-rich4 /assets-rich4 && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
# 存活检查只看 /healthz（事件循环在跑）；docker-compose.yml 另用 /readyz 做就绪检查（caddy 等 app 就绪后再起）
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --start-interval=2s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "--disable-warning=ExperimentalWarning", "server/main.mjs"]
