#!/usr/bin/env bash
# 调试（获释位置整体验证）：四张原版图自对弈，original 500 局与 random + --check-fold 200 局，同参数各跑两次（只读）。
# 用法（仓库根）：bash test/jail-verify-sim.sh [输出目录，默认 .cache/jail/verify/sim]
# 每次运行一个 JSON 文件 <map>-<policy>-<run>.json（--stats --json 的汇总）与退出码 .exit
set -u
OUT="${1:-.cache/jail/verify/sim}"
mkdir -p "$OUT"
for map in taiwan china japan usa; do
  for run in 1 2; do
    f="$OUT/$map-original-$run"
    nice -n 10 npm run --silent sim -- --engine-only --map "$map" --data-dir rich4-data --games 500 --policy original \
      --workers 8 --stats --json >"$f.json" 2>"$f.err"
    echo $? >"$f.exit"
    f="$OUT/$map-random-$run"
    nice -n 10 npm run --silent sim -- --engine-only --map "$map" --data-dir rich4-data --games 200 --policy random \
      --check-fold --workers 8 --stats --json >"$f.json" 2>"$f.err"
    echo $? >"$f.exit"
  done
  echo "$(date +%H:%M:%S) $map done"
done
