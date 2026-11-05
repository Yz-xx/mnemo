/** 接口日志状态档位：all 不限、client 只看 4xx、server 只看 5xx */
export type ApiLogStatusKind = 'all' | 'client' | 'server';

/** 接口请求日志：由服务端在响应结束时自动落库，管理端只读 */
export interface ApiLogItem {
  id: number;
  /** 8 位请求 ID，与服务端日志文件中的 requestId 一致 */
  requestId: string;
  method: string;
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
  createdAt: string;
}
