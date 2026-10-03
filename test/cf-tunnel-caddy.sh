#!/usr/bin/env bash
# 本机验证 deploy/Caddyfile 的 Cloudflare Tunnel 入口（:8081）与公网入口（:443）的客户端 IP、跳转与安全头。
# 不需要 rich4 镜像：假 app 与探针都用 node:24-slim 跑 test/cf-tunnel-caddy-probe.mjs。用完自动清理容器与网络。
#   bash test/cf-tunnel-caddy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
NET=rich4-cftunnel-test
cleanup() {
  docker rm -f "$NET-app" "$NET-caddy" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
docker network create "$NET" >/dev/null
docker run -d --name "$NET-app" --network "$NET" --network-alias app \
  -v "$PWD/test/cf-tunnel-caddy-probe.mjs:/probe.mjs:ro" node:24-slim node /probe.mjs upstream >/dev/null
docker run -d --name "$NET-caddy" --network "$NET" --network-alias caddy \
  -e SITE_ADDRESS=localhost -e CADDY_TRUSTED_PROXIES= \
  -v "$PWD/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2 >/dev/null
# 等 Caddy 起好（内部 CA 签 localhost 证书要一点时间）
for _ in $(seq 1 30); do
  docker logs "$NET-caddy" 2>&1 | grep -q '"serving initial configuration"' && break
  sleep 0.5
done
sleep 1
docker run --rm --network "$NET" -v "$PWD/test/cf-tunnel-caddy-probe.mjs:/probe.mjs:ro" node:24-slim node /probe.mjs client
