// 整体验证（获释位置，0.4.0 → 0.5.0 进行中房间恢复）：把早先会话留下的服务器数据库复制一份（源库只读），只留一个房间快照，
// updated_at 改成现在（RoomManager.restore 只恢复 24 小时内的快照），真人座位与房主的令牌哈希换成测试令牌的 sha256
// （服务端只存 sha256(token)，见 apps/server/src/net/io.ts），供 test/jail-verify-compat.mjs restore 回到房间继续玩。
// 用法：node test/jail-verify-restore-db.mjs --src <源 rich4.db> --code <房间号> --out <目标目录>
// 输出：<目标目录>/rich4.db 与 tokens.json（座位 → 测试令牌）
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  if (i < 0) throw new Error(`missing ${name}`);
  return process.argv[i + 1];
};
const SRC = arg('--src');
const CODE = arg('--code');
const OUT = arg('--out');
mkdirSync(OUT, { recursive: true });
const dst = join(OUT, 'rich4.db');
for (const ext of ['', '-wal', '-shm']) if (existsSync(dst + ext)) rmSync(dst + ext);
// 先让源库的 WAL 落盘到一份临时副本里（只读打开源库，用 VACUUM INTO 生成一致的拷贝）
const src = new DatabaseSync(SRC, { readOnly: true });
src.exec(`VACUUM INTO '${dst.replaceAll("'", "''")}'`);
src.close();
if (!existsSync(dst)) copyFileSync(SRC, dst);

const db = new DatabaseSync(dst);
const row = db.prepare('select code, meta_json, engine_version, phase, seq from room_snapshots where code = ?').get(CODE);
if (!row) throw new Error(`room ${CODE} not found`);
db.prepare('delete from room_snapshots where code <> ?').run(CODE);
db.prepare('delete from room_journal where code <> ?').run(CODE);
const meta = JSON.parse(row.meta_json);
const tokens = {};
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const oldHost = meta.hostToken;
for (const s of meta.seats) {
  if (s.occupant?.kind !== 'human') continue;
  const t = randomBytes(16).toString('base64url');
  tokens[s.index] = t;
  if (s.occupant.tokenHash === oldHost) meta.hostToken = sha(t);
  s.occupant.tokenHash = sha(t);
}
db.prepare('update room_snapshots set meta_json = ?, updated_at = ? where code = ?').run(JSON.stringify(meta), Date.now(), CODE);
const journal = db.prepare('select count(*) as n from room_journal where code = ?').get(CODE).n;
db.close();
writeFileSync(join(OUT, 'tokens.json'), JSON.stringify(tokens, null, 2));
console.log(
  JSON.stringify({ room: CODE, engine: row.engine_version, phase: row.phase, seq: row.seq, journal, humanSeats: Object.keys(tokens), out: dst }),
);
