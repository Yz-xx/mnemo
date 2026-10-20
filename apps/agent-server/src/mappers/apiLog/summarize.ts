import { preview, redactValue } from '@mnemo/logger';

/** 入参出参摘要长度上限：只记录开头，避免整包报文把日志文件与库表撑大 */
const PAYLOAD_PREVIEW = 500;

/** 是否存在可记录的内容：express.json 在无请求体时会给出空对象，不该被记成「有入参」 */
export function hasContent(value: unknown): boolean {
  return value !== null && typeof value === 'object' && Object.keys(value).length > 0;
}

/**
 * 先脱敏再截断：顺序不能反，否则截断后只剩字符串，嵌套的密码就遮蔽不到了。
 * 请求日志与操作审计都要落这份摘要，共用一处以免两条链路的脱敏口径出现分歧。
 */
export function summarize(value: unknown): string {
  return preview(redactValue(value), PAYLOAD_PREVIEW);
}
