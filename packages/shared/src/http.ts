/**
 * HTTP 状态码常量：前后端共用的协议契约。
 * 放在 shared 而非各端各写一份，是因为客户端也要按状态码分支
 * （如 401 触发重新登录、204 表示无响应体），同一事实存两处正是漏改的源头。
 *
 * 用 `as const` 对象而非 TS enum：仓库既有类型风格是字面量联合
 * （LogLevel、KnowledgeScope），且对象不产生运行时枚举开销，类型可由常量派生。
 * 取值只覆盖 backend-design 第 3 章约定的集合，新增状态码须先改规范。
 */
export const HTTP_STATUS = {
  /** 请求成功 */
  OK: 200,
  /** 资源创建成功 */
  CREATED: 201,
  /** 成功且无响应体 */
  NO_CONTENT: 204,
  /** 参数非法 */
  BAD_REQUEST: 400,
  /** 未登录或登录失效；客户端据此清除登录态 */
  UNAUTHORIZED: 401,
  /** 资源不存在；权限不足也按“不存在”处理，不泄漏他人资源 */
  NOT_FOUND: 404,
  /** 服务内部错误；5xx 对外只用这一个状态码，细节留给服务端日志 */
  INTERNAL_SERVER_ERROR: 500,
} as const;

/** 状态码取值：用于需要把取值范围写进签名的位置（如 ApiError.status） */
export type HttpStatusCode = (typeof HTTP_STATUS)[keyof typeof HTTP_STATUS];
