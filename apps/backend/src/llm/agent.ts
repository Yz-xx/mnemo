import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessageChunk } from '@langchain/core/messages';
import { createAgent } from 'langchain';
import type { AppConfig } from '../config.js';
import type { StoredMessage } from '../conversation/types.js';
import type { KnowledgeStore } from '../rag/store.js';
import { createChatModel } from './model.js';
import { createTools } from './tools.js';

/** 流式过程中向前端推送的事件 */
export type AgentStreamEvent =
  { type: 'token'; content: string } | { type: 'tool'; name: string; status: 'start' | 'end' };

const SYSTEM_PROMPT = `你是运行在桌面客户端中的中文智能助手。

工作要求：
1. 需要事实信息时优先调用工具，不要凭空编造。
2. 提问涉及公司制度、业务流程、产品资料、内部规定、专有知识，或带有“知识库”“文档”“资料”等字样时，必须先调用 search_knowledge_base 检索后再作答，禁止凭自身记忆直接回答；检索结果为空时才说明“知识库中未找到相关内容”。
3. 涉及“今天”“现在”等时间概念时调用 get_current_time。
4. 涉及算术运算时调用 calculator，不要自行心算。
5. 引用知识库内容时标注来源文档名称。
6. 使用简体中文回答，条理清晰，必要时使用列表。`;

/** 从消息内容中提取纯文本，兼容字符串与内容块两种形式 */
function extractText(content: BaseMessageChunk['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      return typeof block.text === 'string' ? block.text : '';
    })
    .join('');
}

/** 智能体服务：封装 ReAct Agent 的构建与流式调用 */
export class AgentService {
  private readonly agent: ReturnType<typeof createAgent>;

  constructor(config: AppConfig, knowledge: KnowledgeStore) {
    this.agent = createAgent({
      model: createChatModel(config),
      tools: createTools(knowledge),
      systemPrompt: SYSTEM_PROMPT,
      name: 'agent',
    });
  }

  /** 把持久化的历史消息还原为 LangChain 消息对象 */
  private toMessages(history: StoredMessage[]) {
    return history.map((item) =>
      item.role === 'user' ? new HumanMessage(item.content) : new AIMessage(item.content),
    );
  }

  /**
   * 流式执行一轮对话。
   * 采用 messages 流模式，可直接拿到模型输出的增量分片与工具调用信息。
   */
  async *stream(history: StoredMessage[], signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
    const stream = await this.agent.stream(
      { messages: this.toMessages(history) },
      { streamMode: 'messages', signal },
    );

    // 同一次工具调用会分散在多个分片中，用集合去重后只推送一次事件
    const startedTools = new Set<string>();

    for await (const item of stream as AsyncIterable<unknown>) {
      const [message] = item as [BaseMessageChunk, Record<string, unknown>];

      if (message instanceof ToolMessage) {
        yield { type: 'tool', name: message.name ?? 'tool', status: 'end' };
        continue;
      }

      if (message instanceof AIMessageChunk) {
        for (const call of message.tool_call_chunks ?? []) {
          if (call.name && !startedTools.has(call.name)) {
            startedTools.add(call.name);
            yield { type: 'tool', name: call.name, status: 'start' };
          }
        }
        const text = extractText(message.content);
        if (text) yield { type: 'token', content: text };
      }
    }
  }
}
