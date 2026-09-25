/** 日志级别：由低到高，低于当前阈值（如 info 下的 debug）直接丢弃 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 结构化字段：值可为任意类型，格式化时按标量 / 多行文本 / 错误分别渲染 */
export type LogFields = Record<string, unknown>;

/** 一条日志记录：写入各输出目标前统一成该结构，便于替换或增加输出实现 */
export interface LogRecord {
  time: Date;
  level: LogLevel;
  message: string;
  fields: LogFields;
}

/** 输出目标（控制台 / 文件 / 测试内存），只负责把已格式化的文本落地 */
export interface LogSink {
  /** 该目标是否需要 ANSI 颜色：文件与内存实现必须为 false，避免转义码污染日志文件 */
  readonly color: boolean;
  write(line: string, level: LogLevel): void;
}

/** 日志接口：业务代码只依赖该接口，不感知具体输出实现，便于注入替身做单测 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** 派生带固定字段的子日志（如 requestId、conversationId），避免每条重复传参 */
  child(bindings: LogFields): Logger;
}
