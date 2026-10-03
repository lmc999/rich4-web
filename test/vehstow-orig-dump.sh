#!/bin/sh
# 调试脚本（收起载具 / 梦游卡 / 工程车取证，architecture §34）：把相关代码段从两版 exe 反汇编到 .cache/vehstow/。
# 用法：sh test/vehstow-orig-dump.sh
# 玩家记录基址 v2.06 0x493910 / v3.11 0x496b68（步长 0x68）：+0x11 座驾模式（0 步行 / 1 机车 / 2 汽车 / 工程车 = 天数<<2|3）、
# +0x12 骰子数、+0x37 梦游计数、+0x64/+0x65 工程车到期要换回的座驾与骰子数、+0x66/+0x67 梦游前的座驾与骰子数。
set -e
out=.cache/vehstow
mkdir -p "$out"
r2v() { sh test/vehstow-r2.sh "$1" "$2"; }
dump() { # 版本 名字 起点 条数
  r2v "$1" "pd $4 @ $3" > "$out/$1-$2.txt"
  echo "$1 $2 $3 -> $out/$1-$2.txt"
}
# v2.06
dump v206 sleepwalk-card    0x442e15 200   # 梦游卡（卡片函数表 0x473b84 第 16 项）：存座驾 0x442fa8–0x44301f，复仇 0x44304d–0x4430d2
dump v206 hibernate-card    0x442d23 60    # 冬眠卡：梦游清 0（0x442dcc），不装回
dump v206 turn-start        0x41c058 330   # 回合开始：梦游释放装回 0x41c1aa–0x41c27b，工程车倒数 0x41c4a6–0x41c58c
dump v206 item-moto         0x4459e9 45    # 机车（道具函数表 0x473c01 第 5 项）：只比较 ==1 / ==2
dump v206 item-car          0x445aa4 45    # 汽车（第 6 项）
dump v206 item-engineer     0x446583 60    # 工程车（第 12 项）：+0x64/+0x65 存换回目标，模式写 0x1f
dump v206 item-stow         0x4467b1 30    # 收起（第 14 项）
dump v206 sell-all          0x4446de 60    # 卖光道具（魔法屋 0x431612、命运 32 0x44c09a）：工程车折回道具 12
dump v206 fate10-moto-lost  0x44b44d 70    # 命运 10 机车被偷（命运函数表 0x473d14）
dump v206 fate11-car-crash  0x44b55a 70    # 命运 11 汽车撞毁
dump v206 destroy           0x40c7cd 30    # 地雷 / 炸弹 / 飞弹毁车（+0x15 |= 0x40）
dump v206 refresh           0x40b425 260   # 刷新外观：换姿态库、换行进循环音（0x472880 = 0xb + 模式&3）
dump v206 ai-moto-car       0x420db7 40    # 电脑判据：机车 (模式&3)==0、汽车 (模式&3)<2（AI 表 0x473228）
dump v206 ai-engineer       0x421596 20
# v3.11
dump v311 sleepwalk-card    0x44435e 60
dump v311 turn-start-wake   0x41c9a7 60
dump v311 engineer-tick     0x41cca3 60
dump v311 item-moto         0x446e4a 30
dump v311 item-car          0x446f05 30
dump v311 item-engineer     0x4479d2 40
dump v311 sell-all          0x445b50 40
dump v311 ai-moto-car       0x421644 40    # AI 表 0x4753a0
dump v311 ai-engineer       0x421e20 20
