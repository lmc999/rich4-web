// 调试（M11 验证 6：备份与恢复演练）：只读打开一个 rich4.db（或备份），打印房间快照、存档、门禁邀请码的计数与摘要，
// 用来比对「备份时的库」与「恢复后的库」。镜像里没有 test/，经 stdin 喂给容器里的 node：
//   docker compose … exec -T app node --disable-warning=ExperimentalWarning - /data/backup/rich4-YYYYMMDD.db < test/m11-db-summary.mjs
// 输出一行 JSON（不含任何 token、哈希或存档内容）。
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const file = process.argv[2] ?? process.argv[1];
const db = new DatabaseSync(file, { readOnly: true });
const all = (sql) => db.prepare(sql).all();
const rooms = all('SELECT code, epoch, seq, phase FROM room_snapshots ORDER BY code');
const saves = all('SELECT kind, COUNT(*) AS n FROM saves GROUP BY kind ORDER BY kind');
const invites = all('SELECT note FROM access_invites ORDER BY created_at').map((r) => r.note);
const digest = createHash('sha256')
  .update(JSON.stringify(rooms))
  .update(JSON.stringify(all('SELECT id FROM saves ORDER BY id')))
  .digest('hex')
  .slice(0, 16);
console.log(
  JSON.stringify({
    file,
    schema: all("SELECT value FROM meta WHERE key = 'schema_version'")[0]?.value ?? null,
    rooms: rooms.length,
    roomsPlaying: rooms.filter((r) => r.phase === 'playing').length,
    roomCodes: rooms.map((r) => `${r.code}@e${r.epoch}s${r.seq}`),
    saves: Object.fromEntries(saves.map((r) => [r.kind, r.n])),
    invites,
    digest,
  }),
);
db.close();
