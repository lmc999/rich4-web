#!/usr/bin/env bash
# M11 审查第 2、13 条：经 Caddy（https://localhost:8443）带不同的 X-Forwarded-For 请求，看 app 认定的客户端 IP 与口令退避是否按 IP 分开。
# 用法：bash test/m11fix-ip-probe.sh <app 容器名>；口令从 .cache/m11/passcode.txt 读（不打印）。
set -uo pipefail
cd "$(dirname "$0")/.."
B=https://localhost:8443
APP=$1
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sleep 1
echo -n "错误 token + 不同 XFF 的 /admin/stats："
for x in 203.0.113.9 198.51.100.50; do
  curl -ks -o /dev/null -w '%{http_code} ' -H 'Authorization: Bearer wrong-token-for-probe' -H "X-Forwarded-For: $x" "$B/admin/stats"
done
echo
echo -n "XFF 192.0.2.77 连续 8 次错误口令："
for i in 1 2 3 4 5 6 7 8; do
  curl -ks -o /dev/null -w '%{http_code} ' -X POST -H 'Content-Type: application/json' -H 'X-Forwarded-For: 192.0.2.77' \
    -d '{"passcode":"definitely-wrong-passcode"}' "$B/api/access"
done
echo
echo -n "换一个 XFF（192.0.2.88）用正确口令："
curl -ks -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -H 'X-Forwarded-For: 192.0.2.88' \
  --data-binary @<(printf '{"passcode":"%s"}' "$(cat .cache/m11/passcode.txt)") "$B/api/access"
sleep 1
echo "app 日志里的 ip："
docker logs --since "$since" "$APP" 2>&1 | grep -oE '"ip":"[^"]+"[^}]*"msg":"[^"]+"' | sed -E 's/"ip":"([^"]+)".*"msg":"([^"]+)"/  ip=\1 \2/' | sort | uniq -c
