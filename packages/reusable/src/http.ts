/**
 * HTTP 状态码常量：前后端共用的协议契约。
 * 放在本包而非各端各写一份，是因为客户端也要按状态码分支
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
  /** 服务内部错误；除过载拒绝外，5xx 对外只用这一个状态码，细节留给服务端日志 */
  INTERNAL_SERVER_ERROR: 500,
  /**
   * 过载拒绝：并发闸门处于硬水位时立即失败，服务本身并没有出错。
   * 单开一项而不并入 500，是因为它是**可重试的临时态**——客户端与网关据此退避重试，
   * 而 500 只应提示失败；响应固定附 `Retry-After`。取舍见 docs/adr/0010。
   */
  SERVICE_UNAVAILABLE: 503,
} as const;

/** 状态码取值：用于需要把取值范围写进签名的位置（如按状态码分档的映射表） */
export type HttpStatusCode = (typeof HTTP_STATUS)[keyof typeof HTTP_STATUS];

/**
 * 边界收窄：把响应上拿到的任意状态码收敛到契约取值。
 * 调用方（如 `isUnauthorized`）要按状态码分支，就必须先落在契约集合上：
 * 网关、代理或异常环境可能注入契约外的码（403/502/0），
 * 直接断言会给出不属于契约的类型，静默放行又会让分支判断面对未知输入。
 * 统一按 §3「5xx 对外只用 500」的口径回落，契约外的码不泄漏给调用方。
 */
export function toHttpStatusCode(status: number): HttpStatusCode {
  const contractCodes: readonly number[] = Object.values(HTTP_STATUS);
  // 此处的 as 落在系统边界上（响应状态码来自外部、不可信），且紧跟契约成员判定，符合 §2 的边界豁免
  return contractCodes.includes(status)
    ? (status as HttpStatusCode)
    : HTTP_STATUS.INTERNAL_SERVER_ERROR;
}
