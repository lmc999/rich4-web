#!/usr/bin/env bash
# M11 实机验证 7（生产形态的启动守卫）：只用 deploy/docker-compose.yml（compose 项目 rich4-m11），依次换两份「错误配置」起 app，
# 确认它拒绝启动并打印清楚的中文原因；最后换回正常配置、等 app 恢复健康。deploy/.env 由 test/m11-final-env.sh prod 生成。
#   a) ACCESS_MODE=off 而素材包仍挂着 → 素材包门禁守卫拒绝启动
#   b) RICH4_TEST_MODE=1 且 PUBLIC_URL=https://rich4.example.com → 测试模式守卫拒绝启动
set -uo pipefail
cd "$(dirname "$0")/.."
dc() { docker compose -p rich4-m11 -f deploy/docker-compose.yml "$@"; }

attempt() { # 说明
  echo "== $1"
  local t0
  t0=$(date -u +%FT%TZ)
  # caddy 依赖 app 健康：app 起不来时 up 会报依赖失败，这正是预期
  dc up -d > /dev/null 2>&1
  local st=''
  for _ in $(seq 1 30); do
    st=$(docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}}' rich4-m11-app-1 2> /dev/null)
    [[ $st == *restarts=[1-9]* ]] && break
    sleep 1
  done
  echo "   容器状态：$st"
  dc logs app --since "$t0" 2> /dev/null | grep -m1 -o '"msg":"[^"]*"\|ConfigError[^"]*' | head -3
  dc logs app --since "$t0" 2> /dev/null | grep -m1 -oE '(启用原版素材包|环境变量无效)[^"\\]*' || echo '   （没有找到中文报错）'
  local c
  c=$(curl -k -s -o /dev/null -w '%{http_code}' https://localhost:8443/readyz)
  echo "   经 Caddy 访问 /readyz：$c"
}

ACCESS_MODE_OVERRIDE=off bash test/m11-final-env.sh prod > /dev/null
attempt 'a) ACCESS_MODE=off + 挂载素材包'

PUBLIC_URL_OVERRIDE=https://rich4.example.com TEST_MODE_OVERRIDE=1 bash test/m11-final-env.sh prod > /dev/null
attempt 'b) RICH4_TEST_MODE=1 + PUBLIC_URL=https://rich4.example.com'

echo '== 换回正常配置'
bash test/m11-final-env.sh prod > /dev/null
dc up -d --wait > /dev/null 2>&1
echo "   up --wait 退出码 $?"
docker inspect -f '   容器状态：{{.State.Status}} health={{.State.Health.Status}}' rich4-m11-app-1
curl -kfsS -o /dev/null -w '   /readyz %{http_code}\n' https://localhost:8443/readyz
