/** 接口日志实体：由请求日志中间件在响应结束时汇总 */

/** 状态档位：all 不限，client 只看 4xx，server 只看 5xx */
export type ApiLogStatusKind = 'all' | 'client' | 'server';

/** 一条请求日志：与请求日志中间件在响应结束时汇总的字段一一对应 */
export interface ApiLogEntry {
  /** 8 位请求 ID，与响应头 x-request-id 一致 */
  requestId: string;
  method: string;
  /** 不含查询串的路径 */
  path: string;
  status: number;
  durationMs: number;
  /** 登录用户 ID；未登录与运维超级令牌入口为 null */
  userId: number | null;
  queryParams: string | null;
  requestBody: string | null;
  responseBody: string | null;
  /** 错误摘要，仅 5xx 有值 */
  error: string | null;
  /** API 调用时刻（请求到达时间）：刷写是批量延迟写，落库时不能改取当前时间 */
  createdAt: Date;
}

/**
 * 列表项：多一个自增序号，前端据此做行标识，排序也复用它。
 * createdAt 在这里是落库读回的 ISO 字符串（列表展示口径），与条目里的 Date 版本
 * 同名不同型，故先把条目上的同名属性 Omit 掉再自行声明。
 */
export interface ApiLogRecord extends Omit<ApiLogEntry, 'createdAt'> {
  id: number;
  createdAt: string;
}

/** 列表查询条件：keyword 按路径包含匹配，method 为空串或状态档位为 all 表示不限 */
export interface ApiLogQuery {
  keyword: string;
  method: string;
  statusKind: ApiLogStatusKind;
  page: number;
  pageSize: number;
}

/** 分页结果：total 为满足条件的总数，供前端计算总页数 */
export interface ApiLogPage {
  items: ApiLogRecord[];
  total: number;
}
