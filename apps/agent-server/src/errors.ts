/**
 * 错误处理公共能力：把依赖服务的连接错误翻译成可定位的提示。
 * 对话模型与向量化服务都是本地依赖，Node 的 fetch 在连接失败时只给出
 * "fetch failed" 而不含目标地址，直接抛给界面无法定位问题，故统一在此翻译。
 * 提取错误消息的 toErrorMessage 两端用法一致，已收敛到 @repo/shared。
 */
import { toErrorMessage } from '@repo/shared';

/** 连接类错误的识别：覆盖 fetch 失败与常见 socket 错误码 */
const CONNECTION_ERROR = /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up/i;

/**
 * 把依赖服务的连接错误翻译成含目标地址的可读提示，其余错误原样保留。
 * @param error 原始异常
 * @param target 服务地址与模型等描述，让用户知道该启动哪个服务
 * @param serviceName 服务中文名，如「对话模型服务」「向量化服务」
 */
export function describeConnectionError(
  error: unknown,
  target: string,
  serviceName: string,
): Error {
  if (CONNECTION_ERROR.test(toErrorMessage(error))) {
    return new Error(`无法连接${serviceName} ${target}，请确认该服务已启动后重试。`);
  }
  return error instanceof Error ? error : new Error(toErrorMessage(error));
}
