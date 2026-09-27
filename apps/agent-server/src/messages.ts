import { SESSION_EXPIRED_MESSAGE } from '@repo/reusable';

/**
 * 错误文案常量表。
 * 只收两类：backend-design 第 3 章要求“固定”的文案（它们必须全局一字不差），
 * 以及被两个及以上调用点共用的文案。一次性的提示留在调用处，
 * 避免把顺手写下的句子也变成配置项。
 */
export const ERROR_MESSAGE = {
  /** 鉴权失败固定文案：登录中间件与换取用户信息接口共用，客户端也展示同一句话 */
  SESSION_EXPIRED: SESSION_EXPIRED_MESSAGE,
  /** 会话不存在或不属于当前用户：统一按“不存在”处理，不区分两种原因 */
  CONVERSATION_NOT_FOUND: '会话不存在',
  /** 5xx 对外兜底文案：错误兜底中间件与知识库入库失败共用 */
  INTERNAL: '服务内部错误',
} as const;
