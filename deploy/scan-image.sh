#!/usr/bin/env bash
# 镜像泄漏扫描（M11；docs/architecture.md §9.3、docs/design/original-skin.md §3 修正 5）：原版文件与派生数据
# （*.mkf、RICH4.EXE、*.flc/*.fli 及其 .br/.gz 变体、*.avi、*.mid、原版音乐、SAVE*.DAT、派生地图、素材包的任何文件）
# 不能出现在镜像的**任何一层**里——不只是最终文件系统：先加后删（whiteout）的文件仍然躺在较早的层里，docker save 就能拿出来。
#
# 判定规则与仓库守卫 scripts/check-no-original.ts 是同一套，由 scripts/scan-tree.ts 执行（路径、内容魔数、派生标记与
# 素材包 schema、gzip/brotli 变体解压后再判、tar/zip 包展开再查、sha256 禁单，见该文件头）。服务器上不一定装了 Node：
# scan-tree 在官方 node:24-slim 容器里运行（--network none，代码与禁单来源只读挂载，不构建任何镜像）。
# 禁单：公开的原版指纹与 tools/extract 的指纹文件；本机有 rich4-assets/manifest.json（或 RICH4_ASSETS_DIR 指向的素材包）
# 时并入其中全部 sha256；本机有 original/ 时并入其中每个文件的 sha256（原版 track*.ogg、*.wav 改了名也认得出）。
#
# 三道检查，任何一道有命中就以 1 退出：
#   1. 最终文件系统：在镜像的容器里（root、无网络、不跑镜像的入口程序）用 find 列出全部路径，按路径规则判定；
#   2. docker history：COPY / ADD 指令的来源里提到原版文件或素材包；
#   3. docker save：逐层（含 .wh. 删除标记）按路径与内容判定。
#
# 用法：bash deploy/scan-image.sh [镜像，缺省 rich4:local]
# 退出码：0 干净；1 有命中；2 用法或环境错误（docker 不可用、镜像不存在、临时目录不可用、导出或扫描本身失败）——
# 任何一步没跑成都是 2，不会被当成「有命中」或「干净」。
# 依赖：docker、tar、grep、sed（宿主机不需要 Node）。临时文件放在 $TMPDIR，退出时删除。
set -Eeuo pipefail

# 环境错误一律退出码 2（1 专门留给「有命中」）。-E 让函数与 $(…) 里的失败也走这里；子 shell 里只退出不打印，
# 由外层打印一次
on_err() {
  if ((BASH_SUBSHELL == 0)); then echo "扫描没有完成（第 $1 行的命令失败，退出码 $2）：按环境错误处理" >&2; fi
  exit 2
}
trap 'on_err "${LINENO}" "$?"' ERR

IMAGE="${1:-rich4:local}"
SCANNER_IMAGE='node:24-slim'

if [[ $# -gt 1 || "${IMAGE}" == -* ]]; then
  echo "用法：bash deploy/scan-image.sh [镜像，缺省 rich4:local]" >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "找不到 docker" >&2
  exit 2
fi
if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "镜像不存在：${IMAGE}（先 docker build -f deploy/Dockerfile -t ${IMAGE} .）" >&2
  exit 2
fi
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -f "${repo}/scripts/scan-tree.ts" ]]; then
  echo "找不到 ${repo}/scripts/scan-tree.ts（在完整的仓库里运行本脚本）" >&2
  exit 2
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/rich4-scan.XXXXXX")"
cid=''
cleanup() {
  # -v：连同镜像 VOLUME 声明产生的匿名卷一起删掉，不留垃圾
  if [[ -n "${cid}" ]]; then docker rm -fv "${cid}" >/dev/null 2>&1 || true; fi
  rm -rf "${tmp}"
}
trap cleanup EXIT

# ───────────── scan-tree 容器：代码与禁单来源只读挂载 ─────────────
mounts=(-v "${repo}/scripts:/scan/scripts:ro")
scan_args=(--root /scan)
n_banned=0
add_banned_json() {
  local f="$1"
  [[ -f "${f}" ]] || return 0
  f="$(cd "$(dirname "${f}")" && pwd)/$(basename "${f}")"
  n_banned=$((n_banned + 1))
  mounts+=(-v "${f}:/banned/${n_banned}.json:ro")
  scan_args+=(--banned-json "/banned/${n_banned}.json")
}
add_banned_json "${repo}/tools/extract/known-files.json"
add_banned_json "${repo}/tools/extract/fingerprints.lock.json"
add_banned_json "${repo}/rich4-assets/manifest.json"
if [[ -n "${RICH4_ASSETS_DIR:-}" ]]; then add_banned_json "${RICH4_ASSETS_DIR}/manifest.json"; fi
# 与 check-no-original 一样，.cache/ 下（4 层以内）schema 为 rich4.assets/* 的素材包 manifest 也并入（本机自选输出目录的素材包）
if [[ -d "${repo}/.cache" ]]; then
  while IFS= read -r f; do add_banned_json "${f}"; done < <(
    find "${repo}/.cache" -maxdepth 5 -type f -name manifest.json \
      -exec grep -lE '"schema"[[:space:]]*:[[:space:]]*"rich4\.assets' {} + 2>/dev/null | sort || true
  )
fi
if [[ -d "${repo}/original" ]]; then
  mounts+=(-v "${repo}/original:/banned/original:ro")
  scan_args+=(--banned-dir /banned/original)
fi

# 在 node:24-slim 里运行 scan-tree（参数原样传给它）；返回它的退出码（0 干净、1 命中、2 出错）
scan_tree() {
  local rc=0
  docker run --rm -i --network none --user 0:0 "${mounts[@]}" "${SCANNER_IMAGE}" \
    node --disable-warning=ExperimentalWarning /scan/scripts/scan-tree.ts "${scan_args[@]}" "$@" || rc=$?
  return "${rc}"
}

hits=0
report() {
  echo "  命中：$*"
  hits=$((hits + 1))
}

echo "扫描镜像 ${IMAGE}（$(docker image inspect --format '{{.Id}}' "${IMAGE}")）"
if ! docker image inspect "${SCANNER_IMAGE}" >/dev/null 2>&1; then
  echo "拉取扫描用的官方镜像 ${SCANNER_IMAGE}"
  docker pull "${SCANNER_IMAGE}" >/dev/null
fi
if [[ -d "${repo}/original" ]]; then
  echo "禁单来源：${n_banned} 个指纹 / manifest 文件，另加 original/ 下的全部文件"
else
  echo "禁单来源：${n_banned} 个指纹 / manifest 文件"
fi

# ───────────── 1. 最终文件系统 ─────────────
# 以 root 运行才能看到所有目录；--network none；/proc、/sys、/dev 与其他挂载（-xdev）不查
echo "[1/3] 最终文件系统（容器内 find 列出全部路径，按路径规则判定）"
in_container='find / -xdev \( -path /proc -o -path /sys -o -path /dev \) -prune -o -print'
cid="$(docker create --network none --user 0:0 --entrypoint /bin/sh "${IMAGE}" -c "${in_container}")"
if ! docker start --attach "${cid}" >"${tmp}/paths.txt" 2>"${tmp}/find.err"; then
  echo "容器内扫描失败（镜像里没有 /bin/sh？）：$(head -n 5 "${tmp}/find.err")" >&2
  exit 2
fi
docker rm -fv "${cid}" >/dev/null 2>&1 || true
cid=''
# find 的报错（读不了的目录等）意味着扫描不完整：宁可失败
if [[ -s "${tmp}/find.err" ]]; then
  echo "容器内扫描不完整：$(head -n 5 "${tmp}/find.err")" >&2
  exit 2
fi
rc=0
scan_tree --profile image --paths-stdin <"${tmp}/paths.txt" >"${tmp}/fs.out" 2>&1 || rc=$?
cat "${tmp}/fs.out"
case "${rc}" in
  0) ;;
  1) hits=$((hits + $(grep -c '^  命中' "${tmp}/fs.out" || true))) ;;
  *)
    echo "最终文件系统的路径检查没有完成（scan-tree 退出码 ${rc}）" >&2
    exit 2
    ;;
esac

# ───────────── 2. docker history ─────────────
echo "[2/3] docker history（COPY / ADD 的来源）"
docker history --no-trunc --format '{{.CreatedBy}}' "${IMAGE}" >"${tmp}/history.txt"
history_hits="$(grep -iE '^(COPY|ADD) |#\(nop\) +(COPY|ADD) ' "${tmp}/history.txt" |
  grep -iE '(rich4-assets|rich4-data|(^|[ /])original(/| |$)|\.(mkf|flc|fli|avi|mid|opus|ogg|m4a|mp4|wav)( |$)|\.fl[ci]\.(br|gz)( |$)|rich4\.exe|save[^ ]*\.dat|\.map\.json|\.rich4-extract\.json)' ||
  true)"
if [[ -n "${history_hits}" ]]; then
  while IFS= read -r line; do report "history ${line}"; done <<<"${history_hits}"
fi

# ───────────── 3. docker save：逐层 ─────────────
echo "[3/3] docker save 逐层检查（路径 + 内容 + sha256 禁单，压缩包展开再查）"
mkdir "${tmp}/img"
if ! docker save "${IMAGE}" | tar -xf - -C "${tmp}/img"; then
  echo "docker save 导出或解包失败" >&2
  exit 2
fi
if [[ ! -f "${tmp}/img/manifest.json" ]]; then
  echo "docker save 的输出里没有 manifest.json" >&2
  exit 2
fi
# manifest.json 形如 [{"Config":"…","RepoTags":[…],"Layers":["blobs/sha256/…", …]}]（单行 JSON；不依赖 jq）
layers="$(tr -d '\n' <"${tmp}/img/manifest.json" | grep -oE '"Layers":\[[^]]*\]' | grep -oE '"[^"]+"' | tr -d '"' |
  grep -v '^Layers$' || true)"
if [[ -z "${layers}" ]]; then
  echo "manifest.json 里没有层列表" >&2
  exit 2
fi
layer_args=()
n=0
while IFS= read -r layer; do
  n=$((n + 1))
  if [[ ! -f "${tmp}/img/${layer}" ]]; then
    echo "层文件不存在：${layer}" >&2
    exit 2
  fi
  echo "  层 ${n}：${layer##*/}"
  layer_args+=("/img/${layer}")
done <<<"${layers}"
rc=0
mounts+=(-v "${tmp}/img:/img:ro")
scan_tree --profile image "${layer_args[@]}" </dev/null >"${tmp}/layers.out" 2>&1 || rc=$?
cat "${tmp}/layers.out"
case "${rc}" in
  0) ;;
  1) hits=$((hits + $(grep -c '^  命中' "${tmp}/layers.out" || true))) ;;
  *)
    echo "逐层检查没有完成（scan-tree 退出码 ${rc}）" >&2
    exit 2
    ;;
esac

if [[ "${hits}" -gt 0 ]]; then
  echo "失败：${IMAGE} 有 ${hits} 处原版或派生数据的痕迹（见上）。检查 .dockerignore 与 deploy/Dockerfile。" >&2
  exit 1
fi
echo "通过：${IMAGE} 的最终文件系统、history 与全部 ${n} 层都没有原版文件或派生数据"
