#!/bin/sh
# w2（A8 原版舞台）调试：本机真实素材包，本机开发不设门禁（RICH4_ASSETS_ALLOW_UNGATED=1，仅回环地址），
# 服务器 :3418、vite :5418（数据写到 .cache/w2-a8）
cd "$(dirname "$0")/.." || exit 1
PORT=3418 HOST=127.0.0.1 PUBLIC_URL=http://localhost:5418 LOG_LEVEL=warn LOG_PRETTY=0 TRUST_PROXY=0 \
  RICH4_TEST_MODE=1 DATA_DIR=.cache/w2-a8/data RICH4_DATA_DIR=./rich4-data \
  RICH4_ASSETS_DIR=./rich4-assets ACCESS_MODE=off RICH4_ASSETS_ALLOW_UNGATED=1 \
  npx tsx apps/server/src/main.ts &
SERVER=$!
cd apps/client && RICH4_API_TARGET=http://127.0.0.1:3418 npx vite --port 5418 --strictPort &
CLIENT=$!
trap 'kill $SERVER $CLIENT 2>/dev/null' INT TERM EXIT
wait
