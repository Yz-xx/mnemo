import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { BaseMessage, BaseMessageChunk } from '@langchain/core/messages';
import { createAgent } from 'langchain';
import { toErrorMessage } from '@repo/shared';
import { describeChatEndpoint, describeChatModel } from '../configuration/config.js';
import { describeConnectionError } from '../configuration/errors.js';
import { createChatModel } from './model.js';
import { createTools, readAttachmentText } from './tools.js';
import type { FileSource, GeneratedFileRef } from './tools.js';
import { createVisionReader } from './vision.js';
import type { VisionReader } from './vision.js';
import { SYSTEM_PROMPT } from './prompt.js';
import type { AppConfig } from '../configuration/config.js';
import type { AgentStreamEvent } from '@repo/reusable';
import type { StoredMessage } from '../conversation/types.js';
import type { Logger } from '@repo/logger';
import type { KnowledgeStore } from '../rag/store.js';

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
  /** 附件存储：预读本轮附件时需要按 ID 取回元数据与字节 */
  private readonly files: FileSource;
  /** 视觉读取器：图片附件由它转述成文字；经构造参数注入，便于测试用替身隔离模型服务 */
  private readonly vision: VisionReader;
  /** 对话模型服务描述，用于把底层连接错误翻译成用户能看懂的提示 */
  private readonly modelTarget: string;

  constructor(
    config: AppConfig,
    knowledge: KnowledgeStore,
    files: FileSource,
    vision: VisionReader = createVisionReader(config),
  ) {
    this.files = files;
    this.vision = vision;
    this.agent = createAgent({
      model: createChatModel(config),
      tools: createTools(knowledge, files, vision),
      systemPrompt: SYSTEM_PROMPT,
      name: 'agent',
    });

    this.modelTarget = `${config.llm.provider}（${describeChatEndpoint(config)}，模型 ${describeChatModel(config)}）`;
  }

  /** 把持久化的历史消息还原为 LangChain 消息对象；返回基类数组，因为随后还会追加附件预读结果 */
  private toMessages(history: StoredMessage[]): BaseMessage[] {
    return history.map((item) =>
      item.role === 'user' ? new HumanMessage(item.content) : new AIMessage(item.content),
    );
  }

  /**
   * 本轮附件在模型作答前预读成文本并注入对话。
   * 不依赖模型自行调用 read_file：实测同一张图在「我上传了一张图片…」这类强措辞下能触发读取，
   * 换成「图片里是什么」则 6 轮一次都不读、直接编造答案——小模型对工具调用指令的遵循率撑不起主链路。
   * 预读把「附件有没有被读到」从模型决策变成确定行为，内容直接摆在提问旁边。
   * 单个附件读不到（文件失效、视觉模型不可用）只如实注明，不因此中断整轮对话。
   */
  private async appendAttachments(
    messages: BaseMessage[],
    userId: number,
    fileIds: string[],
    logger?: Logger,
  ) {
    if (fileIds.length === 0) return;
    const attachments = await this.files.list(userId, fileIds);
    if (attachments.length === 0) return;

    // 逐个读取而非并发：本机视觉模型同时处理多张图会明显拖慢，且并发日志难以归因
    const sections: string[] = [];
    for (const file of attachments) {
      try {
        const text = await readAttachmentText(this.files, this.vision, userId, file.id, logger);
        sections.push(
          text === null
            ? `【${file.name}｜${file.id}】读取失败：文件不存在或已失效，请如实告知用户。`
            : `【${file.name}｜${file.id}】\n${text}`,
        );
      } catch (error) {
        sections.push(`【${file.name}｜${file.id}】读取失败：${toErrorMessage(error)}`);
      }
    }

    messages.push(
      new SystemMessage(
        [
          '本轮用户附带了以下附件，其内容已由系统预先读取，请直接据此回答，不要编造内容：',
          ...sections,
        ].join('\n\n'),
      ),
    );
  }

  /**
   * 流式执行一轮对话。
   * 采用 messages 流模式，可直接拿到模型输出的增量分片与工具调用信息；
   * 用户身份与请求级日志经 configurable 下传：前者供知识库工具做可见性过滤，
   * 后者让工具内部日志自动带上 requestId 等上下文，便于按请求检索；
   * 本轮附件 ID 同样经它下传，供文件工具限定可读范围。
   */
  async *stream(
    history: StoredMessage[],
    options: { userId: number; fileIds: string[]; signal?: AbortSignal; logger?: Logger },
  ): AsyncGenerator<AgentStreamEvent> {
    // 同一次工具调用会分散在多个分片中，用集合去重后只推送一次事件
    const startedTools = new Set<string>();
    // 本轮生成的导出文件：工具负责产出，推给客户端要等流读完再统一做
    const exported: GeneratedFileRef[] = [];
    // 本轮检索命中的文档名：工具负责追加，每次工具结束就推增量
    const sources: string[] = [];
    // 已推给客户端的来源：同一文档被多次检索命中时只出一个标签
    const pushedSources = new Set<string>();

    try {
      const messages = this.toMessages(history);
      await this.appendAttachments(messages, options.userId, options.fileIds, options.logger);

      const stream = await this.agent.stream(
        { messages },
        {
          streamMode: 'messages',
          signal: options.signal,
          configurable: {
            userId: options.userId,
            fileIds: options.fileIds,
            logger: options.logger,
            exported,
            sources,
          },
        },
      );

      for await (const item of stream as AsyncIterable<unknown>) {
        const [message] = item as [BaseMessageChunk, Record<string, unknown>];

        if (message instanceof ToolMessage) {
          yield { type: 'tool', name: message.name ?? 'tool', status: 'end' };
          // 工具刚结束就推出新增来源，与工具标签前后脚出现；
          // 本轮随后被停止也不会丢掉已经检索到的出处
          for (const name of sources) {
            if (pushedSources.has(name)) continue;
            pushedSources.add(name);
            yield { type: 'source', name };
          }
          continue;
        }

        if (message instanceof AIMessageChunk) {
          for (const call of message.tool_call_chunks ?? []) {
            // 一次调用的分片只有首个带 name，其余只带参数；按调用 ID 去重才能让
            // 同一轮里的同名工具各自推一次开始事件（按工具名去重会漏掉后来的调用）
            const key = call.id ?? `${call.name ?? 'tool'}#${call.index ?? 0}`;
            if (call.name && !startedTools.has(key)) {
              startedTools.add(key);
              yield { type: 'tool', name: call.name, status: 'start' };
            }
          }
          const text = extractText(message.content);
          if (text) yield { type: 'token', content: text };
        }
      }

      // 导出文件在流末尾统一推送：正文的增量渲染不受影响，客户端收到即可给出下载入口
      for (const file of exported) {
        yield { type: 'file', fileId: file.fileId, name: file.name, size: file.size };
      }
    } catch (error) {
      throw describeConnectionError(error, this.modelTarget, '对话模型服务');
    }
  }
}
