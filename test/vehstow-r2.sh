#!/bin/sh
# 调试脚本（收起载具 / 梦游卡取证）：对原版 exe 跑 radare2 命令，输出无颜色、无字节。
# 用法：sh test/vehstow-r2.sh <v206|v311> '<r2 命令>'
case "$1" in
  v206) exe=original/Game/rich4.exe ;;
  v311) exe=original/MultiverseJourney/rich4.exe ;;
  *) echo "usage: $0 <v206|v311> '<cmd>'" >&2; exit 2 ;;
esac
exec r2 -q -e scr.color=0 -e asm.bytes=false -e scr.utf8=false -e asm.lines=false -c "$2" "$exe" 2>/dev/null
