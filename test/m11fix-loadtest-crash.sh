#!/usr/bin/env bash
# M11 审查第 15 条：压测途中服务器崩溃（SIGKILL）时 loadtest 应判 FAIL、退出码 1（修复前是 UNKNOWN / 2）。
# ADMIN_TOKEN 在本机随机生成、只经环境变量传给两个进程，不打印、不落盘。
set -uo pipefail
cd "$(dirname "$0")/.."
out=.cache/m11/fix
data=$(mktemp -d "${TMPDIR:-/tmp}/rich4-ltcrash.XXXXXX")
ADMIN_TOKEN=$(openssl rand -hex 24)
export ADMIN_TOKEN
PORT=3391 HOST=127.0.0.1 RICH4_TEST_MODE=1 DATA_DIR="$data" LOG_LEVEL=warn \
  node --disable-warning=ExperimentalWarning --import tsx apps/server/src/main.ts >"$out/ltcrash-server.log" 2>&1 &
srv=$!
trap 'kill -9 $srv 2>/dev/null; rm -rf "$data"' EXIT
for i in $(seq 1 60); do curl -fs -o /dev/null http://127.0.0.1:3391/readyz && break; sleep 0.25; done
( sleep 8; kill -9 $srv ) &
npm run -s loadtest -- --url http://127.0.0.1:3391 --rooms 2 --duration 15 --ramp 0 --json >"$out/ltcrash.json" 2>"$out/ltcrash.err"
echo "loadtest 退出码 $?"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify({verdict:j.verdict,reasons:j.reasons,disconnects:j.disconnects,server:j.server}))' "$out/ltcrash.json"
