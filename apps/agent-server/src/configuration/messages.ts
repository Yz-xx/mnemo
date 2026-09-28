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
  /** 用户名冲突：注册与管理员新建用户共用（第 3 章归入“参数非法”） */
  USERNAME_TAKEN: '该用户名已被注册',
  /** 权限不足按「资源不存在」返回：管理端鉴权与知识库私有资源共用，不暴露资源是否存在 */
  NOT_FOUND: '资源不存在',
  /** 停用、降级或删除最后一名可登录管理员时的拒绝文案：services/adminUsers 的三处判定共用 */
  LAST_ADMIN: '至少保留一个可登录的管理员账号',
  /** 停用或降级当前登录账号：单条变更与批量停用共用 */
  SELF_DEACTIVATE: '不能停用或降级当前登录账号',
  /** 删除当前登录账号：单条删除与批量删除共用 */
  SELF_DELETE: '不能删除当前登录账号',
  /** 批量接口 ids 非法：用户类两处共用；文案与字符串类只差 id 类型 */
  BATCH_IDS_NUMBER: 'ids 需为非空的正整数数组',
  /** 批量接口 ids 非法：文档 / 文件 / 会话三处共用 */
  BATCH_IDS_STRING: 'ids 需为非空的字符串数组',
  /** 5xx 对外兜底文案：错误兜底中间件与知识库入库失败共用 */
  INTERNAL: '服务内部错误',
} as const;
