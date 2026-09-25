import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessageChunk } from '@langchain/core/messages';
import { createAgent } from 'langchain';
import { describeChatModel } from '../config.js';
import type { AppConfig } from '../config.js';
import type { StoredMessage } from '../conversation/types.js';
import type { Logger } from '../logger/types.js';
import type { KnowledgeStore } from '../rag/store.js';
import { createChatModel } from './model.js';
import { createTools } from './tools.js';
import { SYSTEM_PROMPT } from './prompt.js';

/** 流式过程中向前端推送的事件 */
export type AgentStreamEvent =
  { type: 'token'; content: string } | { type: 'tool'; name: string; status: 'start' | 'end' };

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
  /** 对话模型服务描述，用于把底层连接错误翻译成用户能看懂的提示 */
  private readonly modelTarget: string;

  constructor(config: AppConfig, knowledge: KnowledgeStore) {
    this.agent = createAgent({
      model: createChatModel(config),
      tools: createTools(knowledge),
      systemPrompt: SYSTEM_PROMPT,
      name: 'agent',
    });

    const endpoint =
      config.llm.provider === 'deepseek' ? config.deepseek.baseUrl : config.ollama.baseUrl;
    this.modelTarget = `${config.llm.provider}（${endpoint}，模型 ${describeChatModel(config)}）`;
  }

  /** 把持久化的历史消息还原为 LangChain 消息对象 */
  private toMessages(history: StoredMessage[]) {
    return history.map((item) =>
      item.role === 'user' ? new HumanMessage(item.content) : new AIMessage(item.content),
    );
  }

  /**
   * 流式执行一轮对话。
   * 采用 messages 流模式，可直接拿到模型输出的增量分片与工具调用信息；
   * 用户身份与请求级日志经 configurable 下传：前者供知识库工具做可见性过滤，
   * 后者让工具内部日志自动带上 requestId 等上下文，便于按请求检索。
   */
  async *stream(
    history: StoredMessage[],
    options: { userId: number; signal?: AbortSignal; logger?: Logger },
  ): AsyncGenerator<AgentStreamEvent> {
    // 同一次工具调用会分散在多个分片中，用集合去重后只推送一次事件
    const startedTools = new Set<string>();

    try {
      const stream = await this.agent.stream(
        { messages: this.toMessages(history) },
        {
          streamMode: 'messages',
          signal: options.signal,
          configurable: { userId: options.userId, logger: options.logger },
        },
      );

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
    } catch (error) {
      throw describeModelError(error, this.modelTarget);
    }
  }
}

/**
 * 把模型侧晦涩的网络错误翻译成可读提示。
 * Node 的 fetch 在连接失败时只给出 "fetch failed"，不含目标地址，直接抛给界面无法定位问题。
 */
function describeModelError(error: unknown, target: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(message)) {
    return new Error(`无法连接对话模型服务 ${target}，请确认该服务已启动后重试。`);
  }
  return error instanceof Error ? error : new Error(message);
}
