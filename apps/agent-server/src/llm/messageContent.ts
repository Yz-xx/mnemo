import type { BaseMessageChunk } from '@langchain/core/messages';

/**
 * 模型消息分片的内容提取：正文与推理链各有一份，形态都是「内容块数组优先、字符串兼容」。
 * 与 llm/agent.ts 分离是因为二者是纯函数、不依赖 agent 的任何状态，独立成模块便于单测与复用。
 */

/** 从消息内容中提取纯文本，兼容字符串与内容块两种形式 */
export function extractText(content: BaseMessageChunk['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      return typeof block.text === 'string' ? block.text : '';
    })
    .join('');
}

/**
 * 提取模型推理链（thinking）：内容块优先、`additional_kwargs` 兜底。
 * Ollama 开启 think 后分片的 `content` 仍是正文，推理落在 `additional_kwargs.reasoning_content`；
 * 而未经 translator 规整的路径会把推理放进内容块 `{ type: 'reasoning' }`，两条来源都要兼容。
 */
export function extractReasoning(message: BaseMessageChunk): string {
  const { content } = message;
  if (Array.isArray(content)) {
    const blocks = content
      .map((block) => {
        if (typeof block === 'string' || block.type !== 'reasoning') return '';
        return typeof block.reasoning === 'string' ? block.reasoning : '';
      })
      .join('');
    if (blocks) return blocks;
  }
  const fallback = message.additional_kwargs?.reasoning_content;
  return typeof fallback === 'string' ? fallback : '';
}
