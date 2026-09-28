#!/usr/bin/env bash
# M11 实机验证 2：经 Caddy（https://localhost:8443，内部 CA 自签证书）逐项检查 HTTP 面：健康检查、门禁、/api/maps、
# /pack/manifest.json、素材包音视频 Range、缓存头 / 压缩 / 安全响应头、访问 cookie 属性。
# 口令从 .cache/m11/passcode.txt 读（test/m11-final-env.sh 生成）；cookie 罐放 .cache/m11/final/（不打印 cookie 值）。
# 每项打印「OK / FAIL 说明」，有 FAIL 时退出 1。
# 用法：bash test/m11-final-http.sh [基址，缺省 https://localhost:8443]
set -uo pipefail
cd "$(dirname "$0")/.."
B=${1:-https://localhost:8443}
J=.cache/m11/final/cookies.txt
H=.cache/m11/final/hdr.txt
mkdir -p .cache/m11/final
rm -f "$J"
fails=0
ok() { echo "OK    $*"; }
bad() { echo "FAIL  $*"; fails=$((fails + 1)); }
# 状态码
code() { curl -k -s -o /dev/null -w '%{http_code}' "$@"; }
# 响应头（小写）写到 ${H}，状态行在首行
heads() { curl -k -s -D - -o /dev/null "$@" | tr -d '\r' | tr 'A-Z' 'a-z' > "$H"; }
has() { grep -q -- "$1" "$H"; }
hv() { grep -m1 "^$1:" "$H" | cut -d' ' -f2-; }

# ── 健康检查（公开） ──
for p in /healthz /readyz; do
  if curl -kfsS -o /dev/null "$B$p"; then ok "$p 200"; else bad "$p 非 200"; fi
done

# ── 门禁：未带 cookie ──
c=$(code "$B/api/maps")
[[ $c == 401 ]] && ok "/api/maps 无 cookie → 401" || bad "/api/maps 无 cookie → ${c}（应为 401）"
c=$(code "$B/pack/manifest.json")
[[ $c == 401 ]] && ok "/pack/manifest.json 无 cookie → 401" || bad "/pack/manifest.json 无 cookie → ${c}（应为 401）"
heads "$B/pack/manifest.json"
has '^x-content-type-options: nosniff' && has '^cross-origin-resource-policy: same-origin' &&
  ok "/pack 401 也带 nosniff + CORP" || bad "/pack 401 缺安全头"
body=$(curl -k -s "$B/api/access")
[[ $body == *'"mode":"passcode"'* && $body == *'"granted":false'* ]] && ok "GET /api/access：mode=passcode、未授权" || bad "GET /api/access：${body}"

# ── 错误口令 → 401；正确口令换 cookie ──
c=$(code -X POST -H 'Content-Type: application/json' -d '{"passcode":"definitely-wrong-passcode"}' "$B/api/access")
[[ $c == 401 || $c == 403 ]] && ok "错误口令 → $c" || bad "错误口令 → $c"
curl -k -s -D "$H.login" -o /dev/null -c "$J" -X POST -H 'Content-Type: application/json' \
  --data-binary @<(printf '{"passcode":"%s"}' "$(cat .cache/m11/passcode.txt)") "$B/api/access"
setc=$(tr -d '\r' < "$H.login" | grep -i '^set-cookie: r4_access=' | head -1)
st=$(head -1 "$H.login" | tr -d '\r')
[[ $st == *" 200"* && -n $setc ]] && ok "口令登录 → 200 + Set-Cookie r4_access" || bad "口令登录：$st"
# cookie 属性（去掉值再打印）
attrs=$(echo "$setc" | sed -E 's/^[Ss]et-[Cc]ookie: r4_access=[^;]*;?//' | tr 'A-Z' 'a-z')
echo "      cookie 属性：${attrs# }"
[[ $attrs == *secure* ]] && ok "cookie 带 Secure" || bad "cookie 缺 Secure"
[[ $attrs == *httponly* ]] && ok "cookie 带 HttpOnly" || bad "cookie 缺 HttpOnly"
[[ $attrs == *samesite=lax* || $attrs == *samesite=strict* ]] && ok "cookie 带 SameSite" || bad "cookie 缺 SameSite"
rm -f "$H.login"

# ── 带 cookie ──
maps=$(curl -kfsS -b "$J" "$B/api/maps")
[[ $maps == *'"taiwan"'* ]] && ok "/api/maps 带 cookie → 200，含 taiwan" || bad "/api/maps：${maps:0:200}"
heads -b "$J" -H 'Accept-Encoding: br, gzip' "$B/pack/manifest.json"
st=$(head -1 "$H")
[[ $st == *" 200"* ]] && ok "/pack/manifest.json 带 cookie → 200" || bad "/pack/manifest.json：$st"
echo "      manifest：cache-control=$(hv cache-control)；content-encoding=$(hv content-encoding)；etag=$(hv etag)；vary=$(hv vary)"
[[ $(hv cache-control) == 'private, no-cache' ]] && ok "manifest Cache-Control private, no-cache" || bad "manifest Cache-Control $(hv cache-control)"
[[ $(hv content-encoding) == br ]] && ok "manifest 按 Accept-Encoding 返回 br（服务器预压缩，Caddy 未再压）" || bad "manifest content-encoding $(hv content-encoding)"

# 素材包里的一个视频与一个音频：Range → 206，Content-Range 与 manifest 的字节数一致
read -r vpath vbytes apath abytes < <(node -e '
  const m = require("./rich4-assets/manifest.json");
  const f = Object.values(m.files);
  const v = f.find((x) => x.contentType === "video/mp4");
  const a = f.find((x) => x.contentType === "audio/mp4");
  console.log(v.path, v.bytes, a.path, a.bytes);')
for pair in "$vpath:$vbytes" "$apath:$abytes"; do
  p=${pair%%:*}
  n=${pair##*:}
  heads -b "$J" -H 'Range: bytes=100-1123' -H 'Accept-Encoding: br, gzip, zstd' "$B/pack/$p"
  st=$(head -1 "$H")
  cr=$(hv content-range)
  cl=$(hv content-length)
  if [[ $st == *" 206"* && $cr == "bytes 100-1123/$n" && $cl == 1024 && -z $(hv content-encoding) ]]; then
    ok "Range /pack/$p → 206，content-range: ${cr}，content-length: ${cl}，未压缩"
  else
    bad "Range /pack/$p → ${st}；content-range=${cr}；content-length=${cl}；content-encoding=$(hv content-encoding)"
  fi
  echo "      ${p}：content-type=$(hv content-type)；cache-control=$(hv cache-control)；accept-ranges=$(hv accept-ranges)"
done
[[ $(hv cache-control) == 'private, max-age=2592000' ]] && ok "/pack 文件 Cache-Control private, max-age=2592000" || bad "/pack 文件 Cache-Control $(hv cache-control)"
# 超出范围 → 416
c=$(code -b "$J" -H "Range: bytes=$((abytes + 10))-" "$B/pack/$apath")
[[ $c == 416 ]] && ok "越界 Range → 416" || bad "越界 Range → $c"
# 同一文件不带 cookie → 401
c=$(code "$B/pack/$vpath")
[[ $c == 401 ]] && ok "素材文件无 cookie → 401" || bad "素材文件无 cookie → $c"

# ── 前端静态资源（Caddy 压缩 + 长缓存） ──
js=$(curl -kfsS "$B/" | grep -oE '/assets/[^"]+\.js' | head -1)
heads -H 'Accept-Encoding: zstd, br, gzip' "$B$js"
echo "      ${js}：cache-control=$(hv cache-control)；content-encoding=$(hv content-encoding)；vary=$(hv vary)"
[[ $(hv cache-control) == *immutable* ]] && ok "静态 JS Cache-Control 含 immutable" || bad "静态 JS Cache-Control $(hv cache-control)"
[[ -n $(hv content-encoding) ]] && ok "静态 JS 由 Caddy 压缩（$(hv content-encoding)）" || bad "静态 JS 未压缩"
heads "$B/"
echo "      /：cache-control=$(hv cache-control)"
[[ $(hv cache-control) == *no-cache* || $(hv cache-control) == *no-store* ]] && ok "index.html 不长缓存（$(hv cache-control)）" || bad "index.html Cache-Control $(hv cache-control)"

# ── 安全响应头（首页 + /api） ──
for u in "$B/" "$B/api/maps"; do
  heads -b "$J" "$u"
  miss=()
  has '^x-content-type-options: nosniff' || miss+=(nosniff)
  has '^referrer-policy: same-origin' || miss+=(referrer-policy)
  has '^x-frame-options: deny' || miss+=(x-frame-options)
  has "^content-security-policy: .*frame-ancestors 'none'" || miss+=(csp-frame-ancestors)
  has '^server:' && miss+=(有server头)
  has '^via:' && miss+=(有via头)
  has '^strict-transport-security:' && miss+=(localhost不应有hsts)
  [[ ${#miss[@]} == 0 ]] && ok "安全响应头齐全、无 Server/Via、localhost 无 HSTS：${u#"$B"}" || bad "安全响应头 ${u#"$B"}：${miss[*]}"
done
heads -b "$J" "$B/api/maps"
echo "      /api/maps：cache-control=$(hv cache-control)"

# ── 协议 ──
v=$(curl -k -s -o /dev/null -w '%{http_version}' "$B/healthz")
ok "HTTP 版本 $v"
# /admin/stats：没有 token 401
c=$(code "$B/admin/stats")
[[ $c == 401 ]] && ok "/admin/stats 无 token → 401" || bad "/admin/stats 无 token → $c"
c=$(code -H "Authorization: Bearer $(cat .cache/m11/admin-token)" "$B/admin/stats")
[[ $c == 200 ]] && ok "/admin/stats 带 token → 200" || bad "/admin/stats 带 token → $c"

echo "失败 $fails 项"
[[ $fails == 0 ]]
