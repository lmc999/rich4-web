#!/usr/bin/env bash
# M11 实机验证 6：每日备份与恢复演练（compose 项目 rich4-m11，docker-compose.e2e.yml 覆盖）。
# 1) 列出 /data/backup；2) 把当天已有的备份挪开、重启 app，等 30 秒后的首次备份检查写出新备份（这样备份里有当前的房间与存档）；
# 2') 备份之前先签发一个 note=before-backup 的邀请码；3) 备份之后再做一处改动（签发一个 note=after-backup 的邀请码），证明恢复确实回到了备份时刻；
# 4) 恢复：停 app → 用一次性容器（同一镜像、同一数据卷）把备份拷成 rich4.db 并删掉 -wal/-shm → 起 app；
# 5) 比对恢复后的库与备份（房间快照、存档、邀请码），并看启动日志里恢复的房间。
# 库的摘要用 test/m11-db-summary.mjs（经 stdin 交给容器里的 node）。ADMIN_TOKEN 从 .cache/m11/admin-token 读，不打印。
set -euo pipefail
cd "$(dirname "$0")/.."
dc() { docker compose -p rich4-m11 -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml "$@" 2> /dev/null; }
summary() { dc exec -T app node --disable-warning=ExperimentalWarning - "$1" < test/m11-db-summary.mjs; }
admin() { curl -ksS -H "Authorization: Bearer $(cat .cache/m11/admin-token)" "$@"; }
day=$(dc exec -T app date -u +%Y%m%d)
bk=/data/backup/rich4-$day.db

echo "== 1. 现有备份"
dc exec -T app ls -l /data/backup

echo "== 2. 签发邀请码 note=before-backup；挪开当天备份、重启 app，等首次备份检查（启动后 30 秒）"
admin -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' \
  -d '{"uses":1,"days":1,"note":"before-backup"}' https://localhost:8443/admin/access/invites
dc exec -T app mv "$bk" "$bk.first"
t0=$(date -u +%FT%TZ)
dc restart app > /dev/null
for _ in $(seq 1 60); do
  if dc logs app --since "$t0" | grep -q 'database backup written'; then break; fi
  sleep 2
done
dc logs app --since "$t0" | grep -E 'database backup written|rooms restored' | cut -c1-240
dc exec -T app ls -l /data/backup
echo "-- 备份内容"
summary "$bk" | tee .cache/m11/final/backup-summary.json

echo "== 3. 备份之后的改动：签发邀请码 note=after-backup"
admin -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' \
  -d '{"uses":1,"days":1,"note":"after-backup"}' https://localhost:8443/admin/access/invites
summary /data/rich4.db | tee .cache/m11/final/live-before-restore.json

echo "== 4. 恢复：停 app → 备份覆盖 rich4.db（删 -wal/-shm）→ 起 app"
dc stop app
dc run --rm --no-deps -T --entrypoint sh app -c \
  "cp -p '$bk' /data/rich4.db.restore && mv /data/rich4.db.restore /data/rich4.db && rm -f /data/rich4.db-wal /data/rich4.db-shm && ls -l /data"
t1=$(date -u +%FT%TZ)
dc up -d --wait app > /dev/null
dc logs app --since "$t1" | grep -E 'rooms restored|rich4 server listening' | cut -c1-300

echo "== 5. 恢复后的库"
summary /data/rich4.db | tee .cache/m11/final/restored-summary.json
node -e '
  const [b, r] = ["backup-summary", "restored-summary"].map((n) => require(`./.cache/m11/final/${n}.json`));
  // 启动恢复会给每个房间 epoch+1 并写新快照，房间只比对房间号集合；存档与邀请码逐项比对
  const codes = (s) => s.roomCodes.map((c) => c.split("@")[0]).join(",");
  const same = codes(b) === codes(r) && JSON.stringify(b.saves) === JSON.stringify(r.saves) &&
    JSON.stringify(b.invites) === JSON.stringify(r.invites);
  console.log(same ? "OK 恢复后的房间、存档、邀请码与备份一致（after-backup 邀请码已不在）" : "FAIL 恢复后与备份不一致");
  process.exit(same ? 0 : 1);'
curl -kfsS -o /dev/null -w 'readyz %{http_code}\n' https://localhost:8443/readyz
