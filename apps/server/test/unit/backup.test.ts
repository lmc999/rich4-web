import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { backupFileName, pruneBackups, runBackup } from '../../src/persistence/backup';
import { openPersistence } from '../../src/persistence/index';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('每日备份', () => {
  it('写出 rich4-YYYYMMDD.db，同一天不重复；备份可以打开并包含数据', async () => {
    const d = mkdtempSync(join(tmpdir(), 'rich4-bk-'));
    dirs.push(d);
    const p = openPersistence({ kind: 'sqlite', location: join(d, 'rich4.db') });
    try {
      p.meta.setMeta('marker', 'yes');
      const now = new Date(2026, 8, 27, 12).getTime();
      const file = await runBackup(p.db!, join(d, 'backup'), now);
      expect(file).toBe(join(d, 'backup', backupFileName(now)));
      expect(backupFileName(now)).toBe('rich4-20260927.db');
      expect(await runBackup(p.db!, join(d, 'backup'), now + 3600_000)).toBeNull();
      expect(readdirSync(join(d, 'backup'))).toEqual(['rich4-20260927.db']);
      const copy = new DatabaseSync(file!, { readOnly: true });
      expect(copy.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
      expect(copy.prepare("SELECT value FROM meta WHERE key = 'marker'").get()).toEqual({ value: 'yes' });
      copy.close();
    } finally {
      p.close();
    }
  });

  it('只保留最近 keep 份（按文件名日期）', () => {
    const d = mkdtempSync(join(tmpdir(), 'rich4-bk-'));
    dirs.push(d);
    for (let day = 1; day <= 9; day++) writeFileSync(join(d, `rich4-2026090${day}.db`), '');
    writeFileSync(join(d, 'other.txt'), '');
    expect(pruneBackups(d, 7)).toEqual(['rich4-20260902.db', 'rich4-20260901.db']);
    expect(readdirSync(d).filter((f) => f.endsWith('.db'))).toHaveLength(7);
    expect(readdirSync(d)).toContain('other.txt');
  });
});
