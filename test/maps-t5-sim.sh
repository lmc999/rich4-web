#!/usr/bin/env bash
# T5 自对弈：四张原版图 × 三种配置 × 两次（同参数，核对 finalHash 一致）。输出在 .cache/maps/t5/sim/。
# 用法（仓库根）：bash test/maps-t5-sim.sh [maps...]；环境变量 ORIG_GAMES（默认 1000）可在机器忙时降低（不少于 300）。
set -u
cd "$(dirname "$0")/.."
OUT=.cache/maps/t5/sim
mkdir -p "$OUT"
if [ $# -gt 0 ]; then MAPS=("$@"); else MAPS=(taiwan china japan usa); fi
ORIG_GAMES=${ORIG_GAMES:-1000}
run() {
  local name=$1; shift
  for r in 1 2; do
    local f="$OUT/$name.run$r.txt"
    echo "[$(date +%H:%M:%S)] $name run$r: $*" | tee -a "$OUT/progress.log"
    npx tsx apps/server/scripts/simulate.ts "$@" --stats >"$f" 2>"$OUT/$name.run$r.err"
    echo "  exit=$? $(head -1 "$f" | cut -c1-220)" | tee -a "$OUT/progress.log"
  done
}
for m in "${MAPS[@]}"; do
  run "$m.original" --engine-only --map "$m" --data-dir rich4-data --games "$ORIG_GAMES" --policy original --workers 8 --time-limit 730
  run "$m.random" --engine-only --map "$m" --data-dir rich4-data --games 300 --policy random --check-fold --workers 8 --time-limit 730
  run "$m.basic3" --engine-only --map "$m" --data-dir rich4-data --games 100 --policy basic --players 3 --workers 8 --time-limit 730
done
echo "[$(date +%H:%M:%S)] done" | tee -a "$OUT/progress.log"
