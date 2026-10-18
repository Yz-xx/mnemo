import type { StoredMessage } from '../../../entities/conversation.js';
import { estimateTextTokens, truncateToTokens } from './tokens.js';

/** 摘要单段上限（token）：提示词要求模型压到约定字数内，这里再兜一道硬截断，防止误差随轮次累积 */
export const SUMMARY_MAX_TOKENS = 600;

/** 摘要输出的目标字数：提示词据此约束模型，比硬上限略紧以留出截断余量 */
const SUMMARY_TARGET_CHARS = 500;

/**
 * 摘要生成任务：纯逻辑只描述「该压缩哪一段、推进到哪个截断点」，
 * 模型调用与落库由 services 层执行（见 services/conversation/contextGovernance.ts）。
 */
export interface SummaryTask {
  /** 需要压缩的未摘要消息：保留窗口起点之前那一段，按原顺序 */
  messages: StoredMessage[];
  /** 本次推进到的截断点：该段末条的 seq，紧贴保留窗口起点，无 gap 无重叠 */
  uptoSeq: number;
  /** 旧摘要：增量合并的起点；首次摘要为 null */
  previous: string | null;
}

/**
 * 摘要生成器接缝：实现复用对话模型（见 services/llm/agent.ts 的 AgentService.summarize），
 * 不走 agent、不带工具；测试用替身隔离模型服务。
 */
export interface Summarizer {
  summarize(prompt: string): Promise<string>;
}

/** 拼摘要提示词：被挤出的对话按角色序列出，有旧摘要时要求合并进同一段 */
export function buildSummaryPrompt(task: SummaryTask): string {
  /** 把角色枚举转成提示词里的中文称谓，非 user/assistant 一律按「系统」处理 */
  const speaker = (role: StoredMessage['role']): string =>
    role === 'user' ? '用户' : role === 'assistant' ? '助手' : '系统';
  const transcript = task.messages
    .map((message) => `${speaker(message.role)}：${message.content}`)
    .join('\n');
  const previous = task.previous
    ? `已有摘要（请在其基础上合并，不要丢失它已覆盖的要点）：\n${task.previous}\n\n`
    : '';
  return (
    '请把下面的对话压缩成一段中文摘要，保留关键事实、结论与用户诉求，省略寒暄与重复内容。\n' +
    `要求：只输出摘要正文，控制在 ${SUMMARY_TARGET_CHARS} 字以内，不要任何前缀、标题或解释。\n\n` +
    `${previous}对话内容：\n${transcript}`
  );
}

/** 规整模型产出的摘要：去首尾空白；超出上限时按同一套 token 口径硬截断 */
export function normalizeSummary(raw: string): string {
  const trimmed = raw.trim();
  return estimateTextTokens(trimmed) <= SUMMARY_MAX_TOKENS
    ? trimmed
    : truncateToTokens(trimmed, SUMMARY_MAX_TOKENS);
}
