#!/bin/sh
# w2 调试：手动起与 e2e/playwright.original.config.ts 相同的服务器（合成素材包 + 口令门禁，:3110）与 vite preview（:5184，
# 用 .cache/e2e-original/dist 里已构建的产物），便于用脚本单步排查原版皮肤 E2E。口令见该配置文件。
cd "$(dirname "$0")/.." || exit 1
HASH=$(node -e "const c=require('crypto');const s=Buffer.from('rich4-e2e-original-salt');console.log(['scrypt',16384,8,1,s.toString('base64url'),c.scryptSync('e2e-original-skin-passcode',s,32,{N:16384,r:8,p:1}).toString('base64url')].join(':'))")
RICH4_TEST_MODE=1 PORT=3110 HOST=127.0.0.1 LOG_LEVEL=${LOG_LEVEL:-info} LOG_PRETTY=0 PUBLIC_URL=http://localhost:5184 \
  DATA_DIR=$(mktemp -d) RICH4_ASSETS_DIR=.cache/synthetic-pack ACCESS_MODE=passcode ACCESS_PASSCODE_HASH="$HASH" \
  ACCESS_SECRET=rich4-e2e-original-skin-secret-0123456789abcdef npx tsx apps/server/src/main.ts &
SERVER=$!
cd apps/client && RICH4_API_TARGET=http://127.0.0.1:3110 npx vite preview --outDir ../../.cache/e2e-original/dist --port 5184 --strictPort &
CLIENT=$!
trap 'kill $SERVER $CLIENT 2>/dev/null' INT TERM EXIT
wait
