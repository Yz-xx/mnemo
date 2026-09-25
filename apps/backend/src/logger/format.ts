import type { LogLevel, LogRecord } from './types.js';

/** 级别标签统一补到 5 字符，保证多条日志的列对齐，便于竖向扫读 */
const LABEL: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

const COLOR: Record<LogLevel, string> = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};

const RESET = '\u001b[0m';

/** 单行字段长度上限：超过则折叠成缩进块，避免首行被长报文拉成一条读不下去的长龙 */
const INLINE_FIELD_MAX = 100;

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** 本地日期（YYYY-MM-DD）：用于按天命名日志文件 */
export function formatDay(time: Date): string {
  return `${time.getFullYear()}-${pad(time.getMonth() + 1, 2)}-${pad(time.getDate(), 2)}`;
}

/** 本地时间戳：精确到毫秒，排查问题时可直接与客户端现象对时 */
function formatTime(time: Date): string {
  const clock =
    `${pad(time.getHours(), 2)}:${pad(time.getMinutes(), 2)}:${pad(time.getSeconds(), 2)}` +
    `.${pad(time.getMilliseconds(), 3)}`;
  return `${formatDay(time)} ${clock}`;
}

/** 对象转字符串：循环引用等无法序列化的值退回 String，避免格式化本身抛错 */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 可内联的字段渲染成 key=value；多行文本与错误另起缩进块，避免堆栈被挤成一行 */
function formatBlock(key: string, value: unknown): string[] | null {
  if (value instanceof Error) {
    const stack = value.stack ?? `${value.name}: ${value.message}`;
    return [`    ${key}:`, ...stack.split('\n').map((line) => `        ${line.trim()}`)];
  }
  if (typeof value === 'string' && value.includes('\n')) {
    return [`    ${key}:`, ...value.split('\n').map((line) => `        ${line}`)];
  }
  return null;
}

/**
 * 把一条记录渲染成人类可读文本。
 * 标量字段与消息同处首行，保证按 requestId 之类的字段 grep 时能直接命中整条消息；
 * 文件输出不带颜色，否则 ANSI 转义码会污染日志文件。
 */
export function formatRecord(record: LogRecord, options: { color: boolean }): string {
  const { time, level, message, fields } = record;
  const label = options.color ? `${COLOR[level]}${LABEL[level]}${RESET}` : LABEL[level];
  const inline: string[] = [];
  const blocks: string[] = [];

  // 接口路径固定占第三列（时间 级别 路径 消息），请求链路可竖向按接口扫读；
  // 这里把 path 从字段中摘出，既避免行尾重复输出，也让不带 path 的日志不多出空列
  const { path, ...rest } = fields;

  for (const [key, value] of Object.entries(rest)) {
    // 未赋值的字段不输出，避免出现 userId=undefined 这类噪声
    if (value === undefined) continue;
    const block = formatBlock(key, value);
    if (block) {
      blocks.push(...block);
      continue;
    }
    const rendered = describeValue(value);
    const text = `${key}=${rendered}`;
    // 超长字段（入参出参摘要）另起缩进块：首行只留"时间 + 消息 + 短字段"，始终便于扫读
    if (text.length > INLINE_FIELD_MAX) blocks.push(`    ${key}:`, `        ${rendered}`);
    else inline.push(text);
  }

  // 第三列：时间、级别之后紧跟接口路径；无 path 的日志直接跳过该列，不留空占位
  const head = [formatTime(time), label, typeof path === 'string' ? path : undefined, message]
    .filter((part) => part !== undefined)
    .join(' ');
  const header = [head, ...inline].join(' ');
  return [header, ...blocks].join('\n');
}
