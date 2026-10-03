#!/bin/sh
# 调试脚本（事件卡片取证）：对 original/Game/rich4.exe（v2.06）跑 radare2 命令，输出无颜色、无字节。
# 用法：sh test/evcard-r2.sh 'aaa; pdf @ 0x44c4a0'
exec r2 -q -e scr.color=0 -e asm.bytes=false -e scr.utf8=false -c "$1" original/Game/rich4.exe 2>/dev/null
