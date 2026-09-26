/**
 * 每日备份（design/net.md §10.3）：node:sqlite 的 backup() 写到 DATA_DIR/backup/rich4-YYYYMMDD.db，保留最近 keep 份。
 * 同一天已有备份就跳过；先写临时文件（改为回滚日志模式的单文件）再 rename，半截文件不会被当成备份。
 * 可配置关闭（BACKUP_ENABLED=0，测试默认关）。
 */
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { dateNumOf } from '../infra/clock';
import type { Logger } from '../infra/logger';

export const BACKUP_FILE_RE = /^rich4-(\d{8})\.db$/;
export const DEFAULT_BACKUP_KEEP = 7;
/** 每小时检查一次当天是否已有备份 */
export const BACKUP_CHECK_MS = 60 * 60_000;

export function backupFileName(now: number): string {
  return `rich4-${dateNumOf(now)}.db`;
}

/** 删除超出 keep 份的旧备份（按文件名中的日期），返回删除的文件名 */
export function pruneBackups(dir: string, keep: number): string[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => BACKUP_FILE_RE.test(f));
  } catch {
    return [];
  }
  files.sort().reverse();
  const drop = files.slice(Math.max(0, keep));
  for (const f of drop) rmSync(join(dir, f), { force: true });
  return drop;
}

/** 执行一次备份；当天已有备份时返回 null。返回写出的文件路径 */
export async function runBackup(
  db: DatabaseSync,
  dir: string,
  now: number,
  keep = DEFAULT_BACKUP_KEEP,
): Promise<string | null> {
  mkdirSync(dir, { recursive: true });
  const name = backupFileName(now);
  if (readdirSync(dir).includes(name)) return null;
  const final = join(dir, name);
  const tmp = join(dir, `${name}.${process.pid}.tmp`);
  rmSync(tmp, { force: true });
  try {
    await backup(db, tmp);
    // 备份沿用了源库的 WAL 模式：改回回滚日志，得到不带 -wal/-shm 的单个文件
    const copy = new DatabaseSync(tmp);
    try {
      copy.exec('PRAGMA journal_mode=DELETE');
    } finally {
      copy.close();
    }
    renameSync(tmp, final);
  } catch (err) {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true });
    throw err;
  }
  pruneBackups(dir, keep);
  return final;
}

export interface BackupSchedulerOptions {
  db: DatabaseSync;
  dir: string;
  keep: number;
  log: Logger;
  now?: () => number;
  /** 启动后第一次检查的延迟 */
  firstDelayMs?: number;
}

/** 后台定时备份：启动后延迟一会儿检查一次，之后每小时检查当天是否已备份（定时器 unref，不阻止退出） */
export class BackupScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly o: BackupSchedulerOptions) {}

  start(): void {
    this.arm(this.o.firstDelayMs ?? 30_000);
  }

  private arm(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.tick().finally(() => {
        this.running = null;
        this.arm(BACKUP_CHECK_MS);
      });
    }, ms);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      const file = await runBackup(this.o.db, this.o.dir, (this.o.now ?? Date.now)(), this.o.keep);
      if (file) this.o.log.info({ file }, 'database backup written');
    } catch (err) {
      this.o.log.error({ err }, 'database backup failed');
    }
  }

  /** 停止定时器，并等待进行中的备份结束（关库前调用） */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }
}
