#!/usr/bin/env bash
# 调试（M11 验证 4）：重启 app 容器，同时每秒采样容器里 :3000 上的 TCP 连接（/proc/net/tcp，按对端与状态计数），
# 看优雅停机期间是谁的连接挡住了 HTTP 服务器关闭。可直接当 E2E_RESTART_CMD 用；采样写到 .cache/m11/final/restart-probe.log。
# 状态码：01 ESTABLISHED、06 TIME_WAIT、08 CLOSE_WAIT、0A LISTEN
set -uo pipefail
cd "$(dirname "$0")/.."
out=.cache/m11/final/restart-probe.log
dc=(docker compose -p rich4-m11 -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml)
c=$("${dc[@]}" ps -q app 2> /dev/null)
{
  echo "== $(date +%T) restart"
  t0=$(date +%s)
  "${dc[@]}" restart app > /dev/null 2>&1 &
  pid=$!
  while kill -0 $pid 2> /dev/null; do
    echo "-- +$(($(date +%s) - t0))s"
    docker exec "$c" sh -c 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null' 2> /dev/null |
      awk 'NR > 1 && $2 ~ /:0BB8$/ { split($3, r, ":"); print "remote=" r[1] " st=" $4 }' | sort | uniq -c
    sleep 1
  done
  wait $pid
  echo "== $(date +%T) restart done，用时 $(($(date +%s) - t0))s"
} >> "$out" 2>&1
