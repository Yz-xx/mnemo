import { createFileSink } from './fileSink.js';
import { formatRecord } from './format.js';
import { redactFields } from './redact.js';
import type { LogFields, LogLevel, LogRecord, LogSink, Logger } from './types.js';

// 统一出口：业务方只从 '@repo/logger' 引入
export { formatDay, formatRecord } from './format.js';
export { preview } from './preview.js';
export { redactFields, redactValue } from './redact.js';
export type { LogFields, LogLevel, LogRecord, LogSink, Logger } from './types.js';

/** 级别权重：低于当前阈值的记录直接丢弃，避免日志文件被 debug 噪声淹没 */
const WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  /** 服务名：决定日志文件名前缀与写入失败时的降级提示，如 backend-2026-09-26.log */
  name: string;
  level: LogLevel;
  /** 日志目录，留空则只输出到控制台 */
  dir?: string;
  /** 文件保留天数，仅在指定 dir 时生效 */
  retentionDays?: number;
  /** 是否输出到控制台，默认开启；单测中关闭以免污染用例输出 */
  stdio?: boolean;
  /** 额外的输出目标，供测试注入内存实现 */
  sinks?: LogSink[];
}

/** 控制台输出：warn / error 走 stderr，便于用 2> 单独重定向错误流 */
function createStdioSink(color: boolean): LogSink {
  return {
    color,
    write(line, level) {
      const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
      stream.write(`${line}\n`);
    },
  };
}

function buildRecord(
  level: LogLevel,
  message: string,
  bindings: LogFields,
  fields?: LogFields,
): LogRecord {
  // 子日志绑定的字段（如 requestId）在前，单条调用传入的字段优先
  return { time: new Date(), level, message, fields: redactFields({ ...bindings, ...fields }) };
}

/** 组装日志实例：多个输出目标共享同一份绑定字段与格式化逻辑 */
function buildLogger(level: LogLevel, bindings: LogFields, sinks: LogSink[]): Logger {
  const emit = (record: LogRecord): void => {
    if (WEIGHT[record.level] < WEIGHT[level]) return;
    for (const sink of sinks) sink.write(formatRecord(record, { color: sink.color }), record.level);
  };

  return {
    debug: (message, fields) => emit(buildRecord('debug', message, bindings, fields)),
    info: (message, fields) => emit(buildRecord('info', message, bindings, fields)),
    warn: (message, fields) => emit(buildRecord('warn', message, bindings, fields)),
    error: (message, fields) => emit(buildRecord('error', message, bindings, fields)),
    child: (extra) => buildLogger(level, { ...bindings, ...extra }, sinks),
  };
}

/**
 * 创建日志：控制台输出始终开启，文件输出由 dir 决定。
 * 颜色只在控制台且为 TTY 时启用，避免日志文件被 ANSI 转义码污染。
 */
export function createLogger(options: LoggerOptions): Logger {
  const { name, level, dir, retentionDays = 14, stdio = true, sinks = [] } = options;
  const targets: LogSink[] = [
    ...(stdio ? [createStdioSink(process.stdout.isTTY === true)] : []),
    ...(dir ? [createFileSink({ dir, name, retentionDays })] : []),
    ...sinks,
  ];
  return buildLogger(level, {}, targets);
}
