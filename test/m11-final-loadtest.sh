#!/usr/bin/env bash
# M11 实机验证 5：经 Caddy（https://localhost:8443）对 compose 项目 rich4-m11 压测，同时每 2 秒采样 app / caddy 容器的
# docker stats（CPU、内存），结束后打印峰值。ADMIN_TOKEN 与口令从 .cache/m11/ 读、经环境变量交给压测脚本（不上命令行、不打印）。
# 输出：.cache/m11/final/loadtest-<tag>.{json,log}、docker-stats-<tag>.log
# 用法：bash test/m11-final-loadtest.sh <tag> [npm run loadtest 的额外参数…]
set -uo pipefail
cd "$(dirname "$0")/.."
tag=${1:?tag}
shift
out=.cache/m11/final
stats=$out/docker-stats-$tag.log
: > "$stats"
(
  while :; do
    docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' rich4-m11-app-1 rich4-m11-caddy-1 |
      sed "s/^/$(date +%T) /" >> "$stats"
    sleep 2
  done
) &
sampler=$!
trap 'kill $sampler 2> /dev/null' EXIT
ADMIN_TOKEN="$(cat .cache/m11/admin-token)" ACCESS_PASSCODE="$(cat .cache/m11/passcode.txt)" \
  npm run -s loadtest -- --url https://localhost:8443 --rooms 200 --json "$@" \
  > "$out/loadtest-$tag.json" 2> "$out/loadtest-$tag.log"
code=$?
kill $sampler 2> /dev/null
wait $sampler 2> /dev/null
echo "loadtest exit=$code"
tail -n 25 "$out/loadtest-$tag.log"
# 峰值：CPU 百分比、内存（MiB）
awk '{
  cpu = $3; sub(/%/, "", cpu); mem = $4
  if (mem ~ /GiB$/) { sub(/GiB/, "", mem); mem *= 1024 } else if (mem ~ /MiB$/) { sub(/MiB/, "", mem) } else if (mem ~ /KiB$/) { sub(/KiB/, "", mem); mem /= 1024 }
  n[$2]++; if (cpu > c[$2]) c[$2] = cpu; if (mem > m[$2]) m[$2] = mem; sc[$2] += cpu
} END { for (k in n) printf "%s：%d 个样本，CPU 峰值 %.1f%%（均值 %.1f%%），内存峰值 %.0f MiB\n", k, n[k], c[k], sc[k] / n[k], m[k] }' "$stats"
exit $code
