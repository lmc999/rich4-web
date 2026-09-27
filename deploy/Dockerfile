# syntax=docker/dockerfile:1.7
# 三阶段构建（design/net.md §10.2；architecture §9.3）。构建上下文是仓库根目录（docker-compose.yml 的 build.context: ..）：
#   docker build -f deploy/Dockerfile -t rich4:local .
# 镜像只含代码与 fixture：原版文件、rich4-data/、原版皮肤素材包 rich4-assets/ 一律不进镜像——
# 根目录 .dockerignore 已排除它们，下面的构建期检查再兜一次底；素材包只在运行时以只读卷挂载（见 docker-compose.yml）。

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
COPY tools/extract/package.json tools/extract/
RUN npm ci
COPY . .
# 构建上下文里出现原版文件或派生素材时直接失败（.dockerignore 被改坏时的兜底）
RUN set -eu; \
    for d in original rich4-data rich4-assets .cache; do \
      if [ -e "$d" ]; then echo "构建上下文里不应出现 $d/（检查 .dockerignore）" >&2; exit 1; fi; \
    done; \
    bad="$(find . -path ./node_modules -prune -o -type f \( -iname '*.mkf' -o -iname '*.flc' -o -iname '*.fli' -o -iname 'rich4.exe' -o -iname '*.avi' \) -print | head -n 5)"; \
    if [ -n "$bad" ]; then echo "构建上下文里有原版或派生文件：$bad" >&2; exit 1; fi
# 依次执行 vite build（apps/client/dist）与 esbuild（apps/server/dist/main.mjs）
RUN npm run build

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
COPY tools/extract/package.json tools/extract/
RUN npm ci --omit=dev --workspace=@rich4/server --include-workspace-root=false

FROM node:24-slim AS runtime
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data STATIC_DIR=/app/public
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./server
COPY --from=build /app/apps/client/dist ./public
# 只读挂载点：原版地图数据与原版皮肤素材包（镜像里是空目录）
RUN mkdir -p /data /data-rich4 /assets-rich4 && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "--disable-warning=ExperimentalWarning", "server/main.mjs"]
