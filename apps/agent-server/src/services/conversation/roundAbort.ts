import type { RoundAbortReason } from './round.js';
import type { ChatErrorCode, KnowledgeCitation } from '@mnemo/reusable';
import { CHAT_ERROR_CODE } from '@mnemo/reusable';
import { toErrorMessage } from '@mnemo/shared';

/**
 * 中止原因对应的对外文案：中止一律推 error、绝不推 done（见 docs/adr/0015 决策 14）。
 * 只有自然完成才 done —— 客户端据此区分「读完了」与「被中途掐断，可重连补齐」。
 */
export const ABORT_MESSAGE: Record<RoundAbortReason, string> = {
  user: '本轮已停止生成',
  timeout: '本轮对话超时，已中断',
  shutdown: '服务正在重启，本轮已中断',
  'detached-limit': '本轮已超出后台续生成上限，已中断',
};

/**
 * 中止原因对应的机器可读分类：客户端按 code 决定提示形态与是否给重试入口。
 * 用户主动停止不是故障，也不该提示「可重新发送」；超时与停机属可重试的临时态；
 * 后台续生成超限按限流处理，客户端稍后重发即可。
 */
export const ABORT_ERROR: Record<RoundAbortReason, { code: ChatErrorCode; retryable: boolean }> = {
  user: { code: CHAT_ERROR_CODE.INTERNAL_ERROR, retryable: false },
  timeout: { code: CHAT_ERROR_CODE.MODEL_TIMEOUT, retryable: true },
  shutdown: { code: CHAT_ERROR_CODE.INTERNAL_ERROR, retryable: true },
  'detached-limit': { code: CHAT_ERROR_CODE.RATE_LIMITED, retryable: true },
};

/** 上下文超限的常见文案特征：模型侧各供应商措辞不同，收敛为关键词匹配 */
const CONTEXT_TOO_LONG = /context length|context window|maximum context|too many tokens/i;

/** 是否因上下文超限而失败：据此标 CONTEXT_TOO_LONG，客户端提示缩短对话而非重试 */
export function isContextTooLong(error: unknown): boolean {
  return CONTEXT_TOO_LONG.test(toErrorMessage(error));
}

/** 集合转数组：空集合给 undefined 而非空数组（落库写 NULL、日志不出现空串） */
export const toOptionalList = (values: Set<string>): string[] | undefined =>
  values.size > 0 ? [...values] : undefined;

/** 引用集合转数组：按文档 ID 去重后输出，空集合给 undefined 而非空数组（落库写 NULL） */
export const toOptionalCitations = (
  values: Map<string, KnowledgeCitation>,
): KnowledgeCitation[] | undefined => (values.size > 0 ? [...values.values()] : undefined);
