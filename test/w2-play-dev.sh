#!/bin/sh
# 整合手测（原版皮肤全流程）：本机真实素材包 + 口令门禁，服务器 :3419、vite :5419（数据写到 .cache/w3）。
# 口令、哈希与密钥事先由 scripts/access.ts 生成到 .cache/w3/{passcode,hash,secret}.txt（不入库）。
cd "$(dirname "$0")/.." || exit 1
HASH=$(tail -n 1 .cache/w3/hash.txt)
SECRET=$(tail -n 1 .cache/w3/secret.txt)
PORT=3419 HOST=127.0.0.1 PUBLIC_URL=http://localhost:5419 LOG_LEVEL=warn LOG_PRETTY=0 \
  RICH4_TEST_MODE=1 DATA_DIR=.cache/w3/data RICH4_DATA_DIR=./rich4-data \
  RICH4_ASSETS_DIR=./rich4-assets ACCESS_MODE=passcode ACCESS_PASSCODE_HASH="$HASH" ACCESS_SECRET="$SECRET" \
  npx tsx apps/server/src/main.ts &
SERVER=$!
cd apps/client && RICH4_API_TARGET=http://127.0.0.1:3419 npx vite --port 5419 --strictPort &
CLIENT=$!
trap 'kill $SERVER $CLIENT 2>/dev/null' INT TERM EXIT
wait
