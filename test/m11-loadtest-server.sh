#!/usr/bin/env bash
# M11 压测用：以生产构建（apps/server/dist/main.mjs）在 127.0.0.1:${PORT:-3301} 起服务器（测试模式，放宽同 IP 额度）。
# ADMIN_TOKEN 在 .cache/m11/admin-token（首次运行时随机生成，权限 600，不进 git）；DATA_DIR 用 mktemp 临时目录。
# 用法：test/m11-loadtest-server.sh start|stop   （PROF=1 时加 --cpu-prof，.cpuprofile 写到 .cache/m11/prof/；
#       NODE_FLAGS 追加 node 参数，例如 NODE_FLAGS="--trace-gc --max-semi-space-size=64"）
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=.cache/m11
mkdir -p "$DIR"
PORT=${PORT:-3301}

case "${1:-start}" in
start)
  if [ ! -s "$DIR/admin-token" ]; then
    (umask 077 && node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))" >"$DIR/admin-token")
  fi
  DATA=$(mktemp -d "${TMPDIR:-/tmp}/rich4-loadtest.XXXXXX")
  echo "$DATA" >"$DIR/server.datadir"
  PROF_ARGS=()
  if [ "${PROF:-0}" = 1 ]; then
    mkdir -p "$DIR/prof"
    PROF_ARGS=(--cpu-prof --cpu-prof-dir="$DIR/prof")
  fi
  PORT=$PORT HOST=127.0.0.1 DATA_DIR="$DATA" RICH4_DATA_DIR=./rich4-data RICH4_TEST_MODE=1 \
    LOG_LEVEL=${LOG_LEVEL:-info} ADMIN_TOKEN="$(cat "$DIR/admin-token")" \
    nohup node --disable-warning=ExperimentalWarning ${PROF_ARGS[@]+"${PROF_ARGS[@]}"} ${NODE_FLAGS:-} apps/server/dist/main.mjs \
    >"$DIR/server.log" 2>&1 &
  echo $! >"$DIR/server.pid"
  for _ in $(seq 1 50); do
    if curl -fsS "http://127.0.0.1:$PORT/readyz" >/dev/null 2>&1; then
      echo "server pid $(cat "$DIR/server.pid") ready on :$PORT, DATA_DIR=$DATA"
      exit 0
    fi
    sleep 0.2
  done
  echo "server not ready; see $DIR/server.log" >&2
  exit 1
  ;;
stop)
  if [ -s "$DIR/server.pid" ]; then
    PID=$(cat "$DIR/server.pid")
    kill -TERM "$PID" 2>/dev/null || true
    for _ in $(seq 1 100); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done
    kill -0 "$PID" 2>/dev/null && kill -KILL "$PID" 2>/dev/null || true
    rm -f "$DIR/server.pid"
  fi
  if [ -s "$DIR/server.datadir" ]; then
    rm -rf "$(cat "$DIR/server.datadir")"
    rm -f "$DIR/server.datadir"
  fi
  echo stopped
  ;;
esac
