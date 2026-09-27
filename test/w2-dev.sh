#!/bin/sh
# w2 调试：本机真实素材包 + 口令门禁，服务器 :3417、vite :5417（产物与数据写到 .cache/w2）
cd "$(dirname "$0")/.." || exit 1
HASH=$(cat .cache/w2/hash.txt)
SECRET=$(cat .cache/w2/secret.txt)
PORT=3417 HOST=127.0.0.1 PUBLIC_URL=http://localhost:5417 LOG_LEVEL=warn LOG_PRETTY=0 \
  RICH4_TEST_MODE=1 DATA_DIR=.cache/w2/data RICH4_DATA_DIR=./rich4-data \
  RICH4_ASSETS_DIR=./rich4-assets ACCESS_MODE=passcode ACCESS_PASSCODE_HASH="$HASH" ACCESS_SECRET="$SECRET" \
  npx tsx apps/server/src/main.ts &
SERVER=$!
cd apps/client && RICH4_API_TARGET=http://127.0.0.1:3417 npx vite --port 5417 --strictPort &
CLIENT=$!
trap 'kill $SERVER $CLIENT 2>/dev/null' INT TERM EXIT
wait
