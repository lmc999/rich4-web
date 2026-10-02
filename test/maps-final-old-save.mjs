// 调试脚本（地图接入集成阶段的回归）：从本机早先会话留下的服务器数据库里取一份台湾存档，按服务器导出格式
// （R4S1.<b64url(blob)>.<sig>，apps/server/src/persistence/codec.ts encodeR4S1）写成 .r4save，
// 供「旧存档导入后能继续玩」的回归使用（签名密钥与集成服务器不同，导入后为「非官方存档」，这是预期）。
// 只读源数据库。用法：node test/maps-final-old-save.mjs [--db .cache/w3/tour-data/rich4.db] [--out .cache/maps/final/old-taiwan.r4save]
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const DB = arg('--db', '.cache/w3/tour-data/rich4.db');
const OUT = arg('--out', '.cache/maps/final/old-taiwan.r4save');

const db = new DatabaseSync(DB, { readOnly: true });
const row = db
  .prepare(
    "select id, name, engine_version, state_version, schema_version, map_id, game_day, created_at, blob, sig from saves where map_id = 'taiwan' order by game_day desc, created_at desc limit 1",
  )
  .get();
if (!row) throw new Error(`${DB} 里没有台湾存档`);
const b64url = (u8) => Buffer.from(u8).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
writeFileSync(OUT, `R4S1.${b64url(row.blob)}.${row.sig}`);
console.log(
  JSON.stringify({
    id: row.id,
    name: row.name,
    engine: row.engine_version,
    stateVersion: row.state_version,
    schema: row.schema_version,
    map: row.map_id,
    day: row.game_day,
    created: new Date(Number(row.created_at)).toISOString(),
    out: OUT,
  }),
);
