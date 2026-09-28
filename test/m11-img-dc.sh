#!/usr/bin/env bash
# M11 镜像与编排本机实测：compose 项目 rich4-m11img（只绑 127.0.0.1:18080/18443）的包装。
# 用法：bash test/m11-img-dc.sh <compose 子命令…>；换 env 文件用 M11_ENV=<路径>（缺省 .cache/m11/img.env），
# 额外的覆盖文件用 M11_EXTRA_COMPOSE=<路径> 传入
set -euo pipefail
cd "$(dirname "$0")/.."
extra=()
if [[ -n "${M11_EXTRA_COMPOSE:-}" ]]; then extra=(-f "${M11_EXTRA_COMPOSE}"); fi
exec docker compose -p rich4-m11img --env-file "${M11_ENV:-.cache/m11/img.env}" \
  -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml "${extra[@]}" "$@"
