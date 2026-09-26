/**
 * 轻量结构化日志（pino 兼容接口，可以作为 Fastify 的 loggerInstance）。
 * - 生产输出单行 JSON；pretty=true 时输出便于阅读的单行文本。
 * - 本文件不引入 node:*（src/game 只 import 它的类型）；输出目标默认 process.stdout/stderr。
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

const LEVEL_NUM: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
};

type LogFn = (objOrMsg?: unknown, msg?: string, ...rest: unknown[]) => void;

export interface Logger {
  level: string;
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  silent: LogFn;
  child(bindings: Record<string, unknown>, options?: { level?: string }): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  pretty?: boolean;
  /** 自定义输出（测试用）；默认写 stdout，warn 及以上写 stderr */
  sink?: (line: string, level: LogLevel) => void;
}

function errToJson(e: unknown): unknown {
  if (e instanceof Error) {
    const o: Record<string, unknown> = { type: e.name, message: e.message, stack: e.stack };
    for (const [k, v] of Object.entries(e)) o[k] = v;
    return o;
  }
  return e;
}

function defaultSink(line: string, level: LogLevel): void {
  const proc = (globalThis as { process?: { stdout: { write(s: string): void }; stderr: { write(s: string): void } } })
    .process;
  if (!proc) return;
  (LEVEL_NUM[level] >= LEVEL_NUM.warn ? proc.stderr : proc.stdout).write(`${line}\n`);
}

class SimpleLogger implements Logger {
  level: string;

  constructor(
    level: LogLevel,
    private readonly bindings: Record<string, unknown>,
    private readonly pretty: boolean,
    private readonly sink: (line: string, level: LogLevel) => void,
  ) {
    this.level = level;
  }

  private write(level: LogLevel, objOrMsg: unknown, msg: string | undefined): void {
    if (LEVEL_NUM[level] < LEVEL_NUM[(this.level as LogLevel) ?? 'info']) return;
    let obj: Record<string, unknown> = {};
    let text = msg;
    if (typeof objOrMsg === 'string') text = objOrMsg;
    else if (objOrMsg instanceof Error) obj = { err: errToJson(objOrMsg) };
    else if (objOrMsg && typeof objOrMsg === 'object') {
      obj = { ...(objOrMsg as Record<string, unknown>) };
      if ('err' in obj) obj.err = errToJson(obj.err);
    }
    const time = Date.now();
    if (this.pretty) {
      const extra = { ...this.bindings, ...obj };
      const tail = Object.keys(extra).length > 0 ? ` ${safeJson(extra)}` : '';
      const ts = new Date(time).toISOString().slice(11, 23);
      this.sink(`${ts} ${level.toUpperCase().padEnd(5)} ${text ?? ''}${tail}`, level);
    } else {
      this.sink(safeJson({ level: LEVEL_NUM[level], time, ...this.bindings, ...obj, msg: text }), level);
    }
  }

  trace: LogFn = (o, m) => this.write('trace', o, m);
  debug: LogFn = (o, m) => this.write('debug', o, m);
  info: LogFn = (o, m) => this.write('info', o, m);
  warn: LogFn = (o, m) => this.write('warn', o, m);
  error: LogFn = (o, m) => this.write('error', o, m);
  fatal: LogFn = (o, m) => this.write('fatal', o, m);
  silent: LogFn = () => {};

  child(bindings: Record<string, unknown>, options?: { level?: string }): Logger {
    const level = (options?.level as LogLevel | undefined) ?? (this.level as LogLevel);
    return new SimpleLogger(level, { ...this.bindings, ...bindings }, this.pretty, this.sink);
  }
}

function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x);
  } catch {
    return '"[unserializable]"';
  }
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  return new SimpleLogger(opts.level ?? 'info', {}, opts.pretty ?? false, opts.sink ?? defaultSink);
}

/** 什么都不输出（单测默认） */
export const silentLogger: Logger = createLogger({ level: 'silent', sink: () => {} });
