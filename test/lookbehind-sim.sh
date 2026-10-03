#!/usr/bin/env bash
# 调试（AI lookbehind 按原版改动）：四张图各跑 original 500 局（--stats）与 random 200 局（--check-fold），每组两遍，
# 输出到 .cache/lookbehind/sim/<图>-<策略>-<第几遍>.txt，最后汇总每组的 rejects / invariantErrors / errors / finalHash 是否两遍一致。
# 用法（仓库根目录）：bash test/lookbehind-sim.sh [taiwan china japan usa]
set -u
cd "$(dirname "$0")/.."
out=.cache/lookbehind/sim
mkdir -p "$out"
maps=("$@")
[ ${#maps[@]} -eq 0 ] && maps=(taiwan china japan usa)
for m in "${maps[@]}"; do
  for run in 1 2; do
    npm run sim -- --engine-only --map "$m" --data-dir rich4-data --games 500 --policy original --workers 8 --stats \
      >"$out/$m-original-$run.txt" 2>&1
    echo "$m original #$run exit=$?"
    npm run sim -- --engine-only --map "$m" --data-dir rich4-data --games 200 --policy random --check-fold --workers 8 \
      >"$out/$m-random-$run.txt" 2>&1
    echo "$m random #$run exit=$?"
  done
done
for m in "${maps[@]}"; do
  for p in original random; do
    a=$(grep -o 'finished=.*' "$out/$m-$p-1.txt" | head -1 | sed 's/ stats=.*//')
    b=$(grep -o 'finished=.*' "$out/$m-$p-2.txt" | head -1 | sed 's/ stats=.*//')
    ha=$(echo "$a" | grep -o 'finalHash=[^ ]*')
    hb=$(echo "$b" | grep -o 'finalHash=[^ ]*')
    same=$([ -n "$ha" ] && [ "$ha" = "$hb" ] && echo 同 || echo 不同)
    echo "$m $p: $a | 两遍 finalHash $same"
  done
done
