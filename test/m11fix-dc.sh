#!/usr/bin/env bash
# 本轮复核用的 compose 项目 rich4-m11fix（127.0.0.1:8080/8443，e2e 覆盖文件，env 读 .cache/m11/e2e.env）
# 额外的覆盖文件放在 M11FIX_EXTRA（仓库根目录相对路径，可为空）
cd "$(dirname "$0")/.."
extra=()
if [[ -n "${M11FIX_EXTRA:-}" ]]; then extra=(-f "$M11FIX_EXTRA"); fi
exec docker compose -p rich4-m11fix --env-file .cache/m11/e2e.env -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml "${extra[@]}" "$@"
