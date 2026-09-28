#!/usr/bin/env bash
# M11 审查第 16 条：E2E_RESTART_CMD 本身失败时 deploy-restart.spec 要立即带着命令输出失败，而不是干等断线遮罩超时。
# 起一个本机测试模式服务器（127.0.0.1:3392，数据放临时目录），分别用「立即以 3 退出」与「成功但什么都不做」的命令跑一遍。
set -uo pipefail
cd "$(dirname "$0")/.."
out=.cache/m11/fix
data=$(mktemp -d "${TMPDIR:-/tmp}/rich4-failfast.XXXXXX")
PORT=3392 HOST=127.0.0.1 RICH4_TEST_MODE=1 DATA_DIR="$data" STATIC_DIR=apps/client/dist LOG_LEVEL=warn \
  node --disable-warning=ExperimentalWarning apps/server/dist/main.mjs >"$out/failfast-server.log" 2>&1 &
srv=$!
trap 'kill $srv 2>/dev/null; wait $srv 2>/dev/null; rm -rf "$data"' EXIT
for i in $(seq 1 40); do curl -fs -o /dev/null http://127.0.0.1:3392/readyz && break; sleep 0.25; done
run() { # 名字 命令
  local t0=$SECONDS
  E2E_BASE_URL=http://localhost:3392 E2E_RESTART_CMD="$2" E2E_RESTART_TIMEOUT_MS=15000 \
    npx playwright test -c e2e/playwright.config.ts e2e/specs/deploy-restart.spec.ts --reporter=list >"$out/failfast-$1.log" 2>&1
  echo "[$1] 退出码 $?，用时 $((SECONDS - t0))s"
  grep -E 'Error:|RESTART_CMD_FAILED_MARKER|E2E_RESTART_CMD 用时|重启命令' "$out/failfast-$1.log" | head -6
}
run fail 'echo RESTART_CMD_FAILED_MARKER >&2; exit 3'
run noop 'true'
