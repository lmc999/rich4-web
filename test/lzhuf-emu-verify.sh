#!/bin/bash
# 用 radare2 ESIL 仿真 v2.06 rich4.exe 自带的 MKF 解压函数（VA 0x4536a0，cdecl(dst, src)，无长度参数，靠 dist==0xFFF 结束），
# 与 test/lzhuf-proto.ts 的输出逐字节比对。只读 original/，输出写 .cache/assets-research/emu/。
#
# r2 6.2 的 ESIL 有两处 x86 语义错误，需在 io.cache 中打补丁（不改文件）：
#   1) 0x45382e `bt dword [esi], ecx`：ESIL 用 esi+ecx/32 而非 esi+(ecx/32)*4 取址 → 换成桩代码（按字节取位，等价）
#   2) 0x4537a6 `repe scasw`：ESIL 串缺少比较与 ZF 条件 → 换成等价循环桩
# 用法：test/lzhuf-emu-verify.sh Game/Panel.mkf 13
set -e
REL=$1; IDX=$2
ROOT=.
OUT=$ROOT/.cache/assets-research/emu
mkdir -p $OUT
LINE=$(node $ROOT/test/mkf-dump-stored.ts "$REL" "$IDX" "$OUT")
T=$(echo "$LINE" | awk '{print $1}'); N=$(echo "$LINE" | awk '{print $5}')
cat > "$OUT/$T.r2" <<R2
e scr.color=0
e io.cache=true
e esil.gotolimit=100000
aei
aeim 0x02000000 0x100000
o malloc://0x400000 0x10000000
o malloc://0x400000 0x10400000
o malloc://0x1000 0x10800000
wx 505189c8c1e8030fb6040683e107d3e883e001594185c0580f840238c5efe91138c5ef @ 0x10800000
wx e9cdc73a1090 @ 0x45382e
wx 663b078d7f0275054975f5eb014981efa01a4800e95637c5ef @ 0x10800040
wx e995c83a1090909090 @ 0x4537a6
wff $OUT/$T.stored.bin @ 0x10000000
ar esp=0x02080000
wv4 0xdeadbee0 @ 0x02080000
wv4 0x10400000 @ 0x02080004
wv4 0x10000000 @ 0x02080008
ar eip=0x4536a0
aesu 0xdeadbee0
?e EIP_AT_END
ar eip
wtf $OUT/$T.emu.bin $N @ 0x10400000
?e TAIL64
p8 64 @ 0x10400000+$N
R2
r2 -q -i "$OUT/$T.r2" $ROOT/original/Game/rich4.exe 2>&1 | grep -v -E "Relocs|INFO" | tr '\n' ' '
echo
if cmp -s "$OUT/$T.emu.bin" "$OUT/$T.ours.bin"; then echo "IDENTICAL $T raw=$N sha1=$(shasum "$OUT/$T.ours.bin" | cut -c1-40)"; else echo "DIFFER $T"; fi
