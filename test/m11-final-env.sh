#!/usr/bin/env bash
# M11 实机验证（收尾）：在本机生成密钥、口令与 compose 用的 env 文件，全部写在 .cache/m11/（已被 .gitignore 忽略，权限 600）。
# 已存在的密钥与口令不重新生成（重复运行只重写 env 文件）；本脚本不向终端打印任何密钥或口令。
#
#   .cache/m11/passcode.txt   口令明文（只在本机；E2E_PASSCODE / 巡检 / 压测 --passcode 从这里读）
#   .cache/m11/secrets/       SAVE_HMAC_SECRET、ACCESS_SECRET、ADMIN_TOKEN（npx tsx scripts/access.ts secret）与口令哈希
#   .cache/m11/e2e.env        docker-compose.e2e.yml 缺省读取的 app 环境变量 + 端口插值变量（本机验证：测试模式由覆盖文件打开）
#   deploy/.env               （参数 prod 时）只用 docker-compose.yml 的生产形态：127.0.0.1:8080/8443、SITE_ADDRESS=localhost
#
# 用法：bash test/m11-final-env.sh [prod]
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
C=.cache/m11
S=$C/secrets
mkdir -p "$S"

gen_secret() { # 文件名
  [[ -s "$S/$1" ]] || npx tsx scripts/access.ts secret > "$S/$1"
}
gen_secret save_hmac_secret
gen_secret access_secret
gen_secret admin_token
if [[ ! -s $C/passcode.txt ]]; then
  # 32 个十六进制字符（128 位熵）；不用 tr … | head（pipefail 下 tr 收到 SIGPIPE 会让脚本中途退出）
  openssl rand -hex 16 | tr -d '\n' > $C/passcode.txt
fi
if [[ ! -s "$S/passcode_hash" || $C/passcode.txt -nt "$S/passcode_hash" ]]; then
  # stderr 上的「写入部署环境…」提示带着哈希，丢掉它（哈希只进文件）
  npx tsx scripts/access.ts hash --stdin < $C/passcode.txt 2> /dev/null | tail -n 1 > "$S/passcode_hash"
fi
# 压测脚本读 .cache/m11/admin-token（与 test/m11-loadtest-server.sh 相同的位置）
cp "$S/admin_token" $C/admin-token

app_env() {
  cat <<EOF
SAVE_HMAC_SECRET=$(cat "$S/save_hmac_secret")
ADMIN_TOKEN=$(cat "$S/admin_token")
LOG_LEVEL=info
MAX_ROOMS=500
ROOM_ABANDON_TTL_MIN=30
DEFAULT_MAP=taiwan
STORE=sqlite
BACKUP_ENABLED=1
BACKUP_KEEP=7
RICH4_ASSETS_VERIFY=quick
ACCESS_MODE=${ACCESS_MODE_OVERRIDE:-passcode}
ACCESS_PASSCODE_HASH=$(cat "$S/passcode_hash")
ACCESS_SECRET=$(cat "$S/access_secret")
ACCESS_TTL_DAYS=30
ACCESS_GRANTS=1
EOF
}

{
  echo '# 本机验证（test/m11-final-env.sh 生成；docker-compose.e2e.yml 读取）'
  app_env
  echo 'BIND_ADDR='
} > $C/e2e.env

if [[ "${1:-}" == prod ]]; then
  {
    echo '# 本机的生产形态检查（test/m11-final-env.sh prod 生成；只绑 127.0.0.1，检查完删除）'
    echo 'SITE_ADDRESS=localhost'
    echo "PUBLIC_URL=${PUBLIC_URL_OVERRIDE:-https://localhost:8443}"
    app_env
    [[ -n "${TEST_MODE_OVERRIDE:-}" ]] && echo "RICH4_TEST_MODE=${TEST_MODE_OVERRIDE}"
    echo 'HTTP_PORT=8080'
    echo 'HTTPS_PORT=8443'
    echo 'BIND_ADDR=127.0.0.1'
    echo 'LOG_MAX_SIZE=10m'
    echo 'LOG_MAX_FILE=5'
  } > deploy/.env
  chmod 600 deploy/.env
fi
echo "env 文件已写好（$C/e2e.env$([[ "${1:-}" == prod ]] && echo '、deploy/.env')）"
