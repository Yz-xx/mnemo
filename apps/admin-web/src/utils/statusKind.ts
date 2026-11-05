/** 状态色调：2xx 成功、4xx 客户端错误、5xx 服务端错误 */
export type StatusKind = 'ok' | 'client' | 'server';

/** 审计与 API 日志两页共用同一套状态分档，避免两份实现漂移 */
export function statusKindOf(status: number): StatusKind {
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'ok';
}
