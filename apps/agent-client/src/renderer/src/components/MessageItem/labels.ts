import type { ChatMessage, ChatStep } from '../../types';

/** 工具标签文案：有 detail 时用后端给的人话，缺省（历史回看）时退回工具名 */
export function stepLabel(step: ChatStep): string {
  if (!step.detail) return step.running ? `调用工具 ${step.name}` : `完成 ${step.name}`;
  return step.running ? `正在${step.detail}` : `已完成 ${step.detail}`;
}

/** 上下文治理提示：只在服务端真的裁掉历史时存在；摘要版与丢弃版分开说 */
export function contextHint(context: ChatMessage['context']): string {
  if (!context) return '';
  const count = `${context.trimmedMessages} 条更早的对话`;
  return context.summarized ? `已将 ${count}压缩为摘要` : `已丢弃 ${count}`;
}
